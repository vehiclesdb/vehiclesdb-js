'use strict'

// @vehiclesdb/client — the JavaScript SDK for VehiclesDB.
//
// This file is the SINGLE source of truth for the package. `index.mjs` is a
// three-line ESM wrapper over it. Why CommonJS-first rather than the other way
// round: the package promises zero runtime dependencies AND no build step, and
// a CJS core is the only shape that works unbuilt in Node's `require`, Node's
// `import`, bundlers, and browsers at the same time.
//
// Two modes, per the parity contract (CONTRACT.md):
//
//   dataset mode  — reads the published CC-BY dataset off jsDelivr and answers
//                   locally. Works today, no key.
//   API mode      — used only by `images()`, the one `/v1` endpoint that is
//                   live (documented at https://vehiclesdb.com/api).
//
// Methods for endpoints that have NOT shipped (stats, markets, plates, vin,
// resolve/batch) are deliberately absent. A method that throws "not
// implemented" invites integrations onto semantics we have not shipped — the
// same reason the images endpoint 422s its reserved `year`/`trim` filters
// rather than guessing.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The exact CDN base the published Ruby gem uses for its dataset refresh
// (vehicles/lib/vehicles/configuration.rb:72 — `.../vehiclesdb@latest/dist/vehicles.json`).
// Same bytes, same release tags, so JS and Ruby can never disagree about what
// "the dataset" is. `@latest` follows the newest git tag; pin it for
// reproducibility (see `version` in the constructor options).
const DEFAULT_DATASET_BASE = 'https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb'

// The API host. `/v1` lives under it.
const DEFAULT_API_BASE_URL = 'https://vehiclesdb.com'

const DEFAULT_TIMEOUT_MS = 10000

// CC-BY 4.0 §3(a): visible credit is a LICENCE CONDITION, not a courtesy.
// Exposed programmatically so an integrator renders it without copying prose
// out of a README (and so it stays correct when the wording changes upstream).
// The three rendered forms are verbatim from the data repo's README.md
// "License & attribution (required)" section (lines 149-156).
const ATTRIBUTION = Object.freeze({
  // The single string that satisfies the licence on its own.
  notice:
    'Vehicle data by VehiclesDB (https://vehiclesdb.com), licensed CC BY 4.0 ' +
    '(https://creativecommons.org/licenses/by/4.0/). Upstream register notices: ' +
    'https://github.com/vehiclesdb/vehiclesdb/blob/main/ATTRIBUTION.md',
  // "App or anything without a website" form.
  text: 'Vehicle data by VehiclesDB (vehiclesdb.com)',
  // "Website" form — a followable link, e.g. in your footer.
  html: '<a href="https://vehiclesdb.com">Vehicle data by VehiclesDB</a>',
  // The form the contract quotes (CONTRACT.md, "Attribution").
  markdown: 'Vehicle data by [VehiclesDB](https://vehiclesdb.com)',
  license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  // Upstream register terms (KBA's dl-de/by-2-0, RDW, Traficom, ...) apply
  // under EVERY licence including the commercial one — they are the registers'
  // terms, not VehiclesDB's to waive. Never paraphrase them; point here.
  upstreamNoticesUrl: 'https://github.com/vehiclesdb/vehiclesdb/blob/main/ATTRIBUTION.md',
  // Credit is required, so say so in the object rather than in a comment only.
  required: true,
  // `${db.attribution}` and String(db.attribution) both give a usable notice.
  toString() {
    return this.notice
  }
})

const KIND_SEGMENTS = 3 // a canonical id is exactly `kind/make_slug/model_slug`

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for everything this package throws, so `catch` can be narrow. */
class VehiclesDBError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'VehiclesDBError'
  }
}

/**
 * A required option is missing or unusable. Always names the option, because
 * "unauthorized" with no hint about WHICH knob to turn is the worst error an
 * SDK can throw.
 */
class VehiclesDBConfigError extends VehiclesDBError {
  constructor(message, option) {
    super(message)
    this.name = 'VehiclesDBConfigError'
    this.option = option
  }
}

/**
 * Any non-2xx HTTP response, from the CDN or from `/v1`. Carries the raw
 * `status` and the parsed `body` so the API's documented error shapes
 * (`{"error":"unauthorized"}`, `{"error":"no_image","id":...}`,
 * `{"error":"unknown_color","palette":[...]}`) reach the caller intact
 * instead of being flattened into a string.
 */
class VehiclesDBApiError extends VehiclesDBError {
  constructor(message, { status, body, url, method }) {
    super(message)
    this.name = 'VehiclesDBApiError'
    this.status = status
    this.body = body
    this.url = url
    this.method = method
  }
}

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

// NFKD splits "ë" into "e" + a combining diaeresis; we strip the combining
// marks (\p{Mn}) BEFORE collapsing separators, or "Citroën" would fold to
// "citro en" instead of "citroen".
//
// NFKD (not NFD) on purpose: it is what the reference Ruby implementation uses
// (vehicles/lib/vehicles.rb:290 `unicode_normalize(:nfkd)`), and cross-language
// parity of the fold is the whole point of having one contract. NFKD is a
// superset of NFD for our purposes — it additionally folds compatibility forms
// (ﬁ → fi, ① → 1), which only ever makes a match more likely.
const COMBINING_MARKS = /\p{Mn}/gu

function foldDiacritics(value) {
  return String(value == null ? '' : value).normalize('NFKD').replace(COMBINING_MARKS, '')
}

/**
 * Match-normalize: fold diacritics, lowercase, collapse every run of
 * non-alphanumerics to a single space. "Mercedes-Benz" => "mercedes benz",
 * "Citroën C3" => "citroen c3", "1.9 TDI" => "1 9 tdi".
 *
 * MUST NEVER THROW: the whole SDK's contract is "garbage in => empty/null out,
 * not an exception", and every lookup path runs through here.
 *
 * Note the deliberate blind spot: a purely non-Latin string ("カローラ") folds
 * to "" here. That is why every alias index also keeps an exact-lowercase
 * key — same trick as the gem's `@exact` index (vehicles/lib/vehicles/dataset.rb:59).
 */
function normalize(value) {
  return foldDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Lowercased+trimmed, no folding — the fallback key for non-Latin strings. */
function exactKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase()
}

/** Codepoint compare. Deliberately NOT localeCompare: ICU differs across Node
 *  builds and browsers, and the contract promises deterministic orderings. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Deciles: 1 = most popular … 10; null = unranked. Unranked sorts LAST —
 *  "unknown" must never outrank "known" (same rule as the gem's top_models). */
function decileKey(decile) {
  return decile == null ? Number.POSITIVE_INFINITY : decile
}

// ---------------------------------------------------------------------------
// Record shaping
// ---------------------------------------------------------------------------

// Field names are camelCased (`bodyType`, `formerIds`) because the contract
// asks for language-idiomatic casing; NO field is renamed, dropped, or
// invented beyond that. Two coercions, both matching the Ruby gem so the two
// SDKs answer alike:
//   * absent array-valued optionals become `[]` (the gem's `Array(...)`),
//   * absent scalar optionals become `null` (the gem's `nil = unranked`).
// Per SCHEMA.md's binding "absence rule", absent means "not catalogued yet" —
// never "no". Code against presence of a value, not against a release version.

function frozenList(value) {
  return Object.freeze(Array.isArray(value) ? value.slice() : [])
}

/**
 * A Make as published in `dist/vehicles.json`: `{name, slug, kinds, aliases?}`.
 *
 * `id` is mirrored from `slug`. That is not an invention: `catalog/{kind}/makes.json`
 * publishes both and they are the same string for all 1111 make records in the
 * repo as of release 2026.07.6 (SCHEMA.md "Make": `id` "stable, e.g. \"bmw\"",
 * `slug` "lowercase ASCII"). `dist/` ships only `slug`, so we mirror it.
 *
 * `countries` is NOT here: it lives only in `catalog/{kind}/makes.json`, and
 * `makes()` is contractually a single fetch of `dist/`. See the README.
 */
function buildMake(raw) {
  return Object.freeze({
    id: raw.slug,
    slug: raw.slug,
    name: raw.name,
    kinds: frozenList(raw.kinds),
    aliases: frozenList(raw.aliases)
  })
}

/**
 * A Model as published in `dist/vehicles.json` — the light record returned by
 * `models()`, `search()` and pointed at by `resolve()`.
 *
 * `id` is rebuilt as `kind/make_slug/model_slug`. THIS IS THE PRODUCT: it is
 * the id we want a stranger's database to store, and the same id
 * `GET /v1/vehicles/{kind}/{make}/{model}/images` is addressed by.
 */
function buildModel(raw, make) {
  return Object.freeze({
    id: `${raw.kind}/${make.slug}/${raw.slug}`,
    makeId: make.slug,
    makeName: make.name,
    slug: raw.slug,
    name: raw.name,
    kind: raw.kind,
    // Cars always carry a body type; vans/trucks/buses do not (no honest
    // vocabulary derivable from registers yet — SCHEMA.md "Body types").
    bodyType: raw.body_type == null ? null : raw.body_type,
    globalDecile: raw.global_decile == null ? null : raw.global_decile,
    // dist/ publishes bare country codes here; the per-kind catalog publishes
    // the evidence behind each one. See buildModelDetail.
    availability: frozenList(raw.availability),
    regions: frozenList(raw.regions),
    aliases: frozenList(raw.aliases),
    forms: frozenList(raw.forms),
    formerIds: frozenList(raw.former_ids)
  })
}

/**
 * The FULL record: the light record above, upgraded with everything that only
 * `catalog/{kind}/models.json` publishes. Returned by `model()`.
 *
 * ONE FIELD CHANGES SHAPE and it is deliberate: `availability` is
 * `["nl", "gb"]` on a light record and
 * `[{country:"nl", evidence:"registration", source:"nl_rdw"}]` here. Those are
 * the two files' own published shapes (SCHEMA.md "Availability") and renaming
 * either would put a vocabulary in the world that the dataset does not use.
 * They agree by construction — verified across all 289 fixture records at
 * release 2026.07.6: `catalog.availability.map(a => a.country)` is exactly
 * `dist.availability`, and `catalog.body_types[0]` is exactly `dist.body_type`.
 * So `model(...).availability.map(a => a.country)` gives you the light form.
 */
function buildModelDetail(light, cat) {
  const popularity = cat.popularity
    ? Object.freeze({
        globalDecile: cat.popularity.global_decile == null ? null : cat.popularity.global_decile,
        byCountry: Object.freeze(
          Object.fromEntries(
            Object.entries(cat.popularity.by_country || {}).map(([country, stats]) => [
              country,
              Object.freeze({
                rank: stats.rank == null ? null : stats.rank,
                decile: stats.decile == null ? null : stats.decile,
                confidence: stats.confidence == null ? null : stats.confidence
              })
            ])
          )
        )
      })
    : null

  return Object.freeze({
    ...light,
    bodyTypes: frozenList(cat.body_types),
    availability: Object.freeze(
      (Array.isArray(cat.availability) ? cat.availability : []).map(row =>
        Object.freeze({ country: row.country, evidence: row.evidence, source: row.source })
      )
    ),
    sources: frozenList(cat.sources),
    // Object-valued optionals stay `null` when absent (they carry meaning:
    // "no counts yet", "no crosswalks measured"), array-valued ones become [].
    xrefs: cat.xrefs ? Object.freeze({ ...cat.xrefs }) : null,
    popularity
  })
}

// ---------------------------------------------------------------------------
// The in-memory index
// ---------------------------------------------------------------------------

/**
 * Build every lookup table the query methods need from one parsed
 * `dist/vehicles.json`. Done once per client and memoized: after this, every
 * public method is Map lookups and array scans over ~17k in-memory records.
 */
function buildIndex(dist) {
  const rawMakes = Array.isArray(dist && dist.makes) ? dist.makes : []

  const entries = rawMakes.map(raw => {
    const make = buildMake(raw)
    const models = (Array.isArray(raw.models) ? raw.models : []).map(m => buildModel(m, make))
    return { make, models }
  })

  // Name-alphabetical and diacritic-insensitive, matching the gem
  // (vehicles/lib/vehicles/dataset.rb:50). The published file arrives
  // slug-sorted, which differs subtly ("Austin-Healey" vs "Austin Morris").
  entries.sort(
    (a, b) =>
      compareStrings(normalize(a.make.name), normalize(b.make.name)) ||
      compareStrings(a.make.slug, b.make.slug)
  )

  const makeBySlug = new Map()
  const makeByNormalized = new Map()
  const makeByExact = new Map()
  const modelsByMakeSlug = new Map()
  // Every model paired with its FOLDED forms. Folding is NFKD + two regexes,
  // and a real release holds ~17k models — recomputing it inside every
  // `search()` and every `resolve()` would put tens of milliseconds on an
  // autocomplete keystroke. Fold once here, at index time, instead.
  const folded = []
  const foldedByMakeSlug = new Map()
  const models = []
  const modelById = new Map()
  const modelsByFormerId = new Map()
  // TWO PASSES on purpose. Real names and slugs are registered before any
  // alias, so one make's nickname can never shadow another make's actual name.
  // This is a live hazard, not a theoretical one: the gem carries a comment
  // about exactly it (dataset.rb:24 — no "vauxhall" alias, because Vauxhall is
  // a real separate make since 2026.07).
  for (const { make, models: list } of entries) {
    makeBySlug.set(make.slug, make)
    modelsByMakeSlug.set(make.slug, list)
    for (const key of [normalize(make.name), normalize(make.slug)]) {
      if (key && !makeByNormalized.has(key)) makeByNormalized.set(key, make)
    }
    makeByExact.set(exactKey(make.name), make)
  }
  for (const { make } of entries) {
    for (const alias of make.aliases) {
      const key = normalize(alias)
      if (key && !makeByNormalized.has(key)) makeByNormalized.set(key, make)
      // Non-Latin aliases ("丰田", "トヨタ") fold to "" above, so they only
      // ever land through the exact index.
      const exact = exactKey(alias)
      if (exact && !makeByExact.has(exact)) makeByExact.set(exact, make)
    }
  }

  for (const { make, models: list } of entries) {
    const foldedForMake = []
    foldedByMakeSlug.set(make.slug, foldedForMake)
    for (const model of list) {
      models.push(model)
      modelById.set(model.id, model)

      const entry = {
        model,
        name: normalize(model.name),
        slug: normalize(model.slug),
        // "Make Name" — search's widest tier, so `search('volkswagen golf')`
        // finds the Golf.
        full: normalize(`${make.name} ${model.name}`)
      }
      folded.push(entry)
      foldedForMake.push(entry)

      for (const formerId of model.formerIds) {
        // A former id may never name a live id (the release build asserts
        // it), so this can only ever be a 1:1 redirect.
        push(modelsByFormerId, exactKey(formerId), model)
      }
    }
  }

  return {
    version: dist && dist.version,
    // The kinds the release itself declares, in its own order. Used as the
    // last deterministic tie-break so we never invent a kind hierarchy.
    kinds: frozenList(dist && dist.kinds),
    makes: entries.map(e => e.make),
    makeBySlug,
    makeByNormalized,
    makeByExact,
    modelsByMakeSlug,
    folded,
    foldedByMakeSlug,
    models,
    modelById,
    modelsByFormerId,
  }
}

function push(map, key, value) {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

// ---------------------------------------------------------------------------
// Matching helpers (shared by resolve/models/search)
// ---------------------------------------------------------------------------

/** Alias-aware make lookup: slug, display name, or a published make alias,
 *  all diacritic/case/punctuation-insensitive. Unknown => null, never throws.
 *  This is what makes `models("VW")` and `models("alfa-romeo")` both land. */
function findMake(index, query) {
  const normalized = normalize(query)
  if (normalized) {
    return index.makeBySlug.get(normalized) || index.makeByNormalized.get(normalized) || null
  }
  // Purely non-Latin input folded to "" — try the unfolded index.
  return index.makeByExact.get(exactKey(query)) || null
}

/**
 * Pick one model when a single query string exactly names several records that
 * differ ONLY by kind (Toyota's Land Cruiser is a car, a van, a truck AND a
 * bus). This is not fuzzy matching — every candidate matched exactly — it is a
 * documented, deterministic tie-break over published fields:
 *
 *   1. lowest global decile (most popular), unranked last
 *   2. widest availability (most countries with official evidence) — the same
 *      tie-break the gem uses for `top_models` (dataset.rb:151)
 *   3. the release's own `kinds` order, so we never invent a kind hierarchy
 *   4. canonical id, so the answer is stable forever
 *
 * Pass `kind` if you care which one you get.
 */
function pickBest(index, candidates) {
  if (candidates.length <= 1) return candidates[0] || null
  const kindOrder = new Map(index.kinds.map((k, i) => [k, i]))
  const rank = kind => (kindOrder.has(kind) ? kindOrder.get(kind) : Number.POSITIVE_INFINITY)
  return candidates.slice().sort(
    (a, b) =>
      decileKey(a.globalDecile) - decileKey(b.globalDecile) ||
      b.availability.length - a.availability.length ||
      rank(a.kind) - rank(b.kind) ||
      compareStrings(a.id, b.id)
  )[0]
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

class VehiclesDB {
  #fetchImpl
  #cache
  #pending = new Map()
  #indexPromise = null
  #resolverPromise = null

  /**
   * @param {object} [options]
   * @param {string} [options.version='latest'] release tag to read, e.g. '2026.07.6'
   * @param {string} [options.datasetBaseUrl] override the CDN base entirely
   * @param {string} [options.apiBaseUrl='https://vehiclesdb.com']
   * @param {string} [options.apiKey] required by `images()` only
   * @param {Function} [options.fetch] a fetch-shaped function (tests inject here)
   * @param {number} [options.timeout=10000] per-request timeout in ms; 0 disables
   * @param {{get:Function,set:Function}} [options.cache] url -> parsed JSON store
   */
  constructor(options) {
    options = options || {}
    this.version = options.version || 'latest'
    // jsDelivr resolves `@latest` to the newest git tag and `@2026.07.6` to
    // that exact release. Pinning is what makes an answer reproducible; see
    // the README's "Pinning a release".
    this.datasetBaseUrl = stripTrailingSlash(
      options.datasetBaseUrl || `${DEFAULT_DATASET_BASE}@${this.version}`
    )
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl || DEFAULT_API_BASE_URL)
    this.apiKey = options.apiKey || null
    this.timeout = options.timeout == null ? DEFAULT_TIMEOUT_MS : options.timeout

    // `globalThis.fetch` MUST be bound. An unbound reference throws
    // "Illegal invocation" in browsers because the spec requires `this` to be
    // the global object. Resolved here but never CALLED here — constructing a
    // client performs zero I/O.
    const injected = typeof options.fetch === 'function' ? options.fetch : null
    this.#fetchImpl =
      injected || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

    // Default cache is per-instance, so two clients don't share state by
    // surprise. Pass one Map to several clients (or a localStorage-backed
    // {get,set}) to share the downloaded dataset.
    this.#cache = options.cache || new Map()
  }

  /** The CC-BY notice, programmatically. Credit is a licence condition. */
  get attribution() {
    return ATTRIBUTION
  }

  /**
   * The release the answers came from, e.g. "2026.07.6". The Ruby gem's
   * `Vehicles.data_version`. You need it for the research/dataset form of the
   * attribution ("cite this repo and the dataset version"), and it is the only
   * honest way to report coverage numbers — read them, never hardcode them.
   */
  async datasetVersion() {
    return (await this.#index()).version
  }

  // --- dataset mode --------------------------------------------------------

  /**
   * Every make, name-alphabetical. With `kind`, only makes that build that
   * kind (filtered on the make's own published `kinds[]`).
   *
   * Exactly one network call, ever (`dist/vehicles.json`, memoized).
   */
  async makes(options) {
    // `options || {}` rather than a default parameter: a default only fires on
    // `undefined`, and callers really do pass an explicit `null` when the
    // options come out of a variable. Same everywhere below.
    const { kind } = options || {}
    const index = await this.#index()
    if (!kind) return index.makes.slice()
    return index.makes.filter(make => make.kinds.includes(kind))
  }

  /**
   * A make's models. Make lookup is alias-aware ("VW", "vw", "Volkswagen",
   * "volkswagen" all land). An unknown make returns `[]` and NEVER throws —
   * that is the gem's contract (`Vehicles.models("DeLorean") # => []`) and
   * user input is exactly what lands here.
   *
   * Order is the release's own order for that make; it is not re-sorted.
   */
  async models(make, options) {
    const { kind, bodyType } = options || {}
    const index = await this.#index()
    const found = findMake(index, make)
    if (!found) return []
    let list = index.modelsByMakeSlug.get(found.slug) || []
    if (kind) list = list.filter(m => m.kind === kind)
    if (bodyType) list = list.filter(m => m.bodyType === bodyType)
    return list.slice()
  }

  /**
   * One model's FULL record, or null.
   *
   *   model('car/volkswagen/golf')
   *   model('car', 'volkswagen', 'golf')
   *
   * Honours `former_ids`: an id that was renamed in a past release still
   * resolves to the record that replaced it. That is the "old ids keep
   * working" promise — the reason storing our id is safe.
   *
   * Costs a second network call: the light dataset does not carry sources,
   * crosswalks or per-country popularity, so this lazily pulls
   * `catalog/{kind}/models.json` for the model's kind (memoized per kind).
   */
  async model(idOrKind, makeSlug, modelSlug) {
    const index = await this.#index()
    const id =
      makeSlug === undefined && modelSlug === undefined
        ? exactKey(idOrKind)
        : `${exactKey(idOrKind)}/${exactKey(makeSlug)}/${exactKey(modelSlug)}`

    const light =
      index.modelById.get(id) ||
      // A single-element bucket by construction (a former id can never name a
      // live id), but pickBest keeps the code honest if the data ever slips.
      pickBest(index, index.modelsByFormerId.get(id) || [])
    if (!light) return null

    const catalog = await this.#catalogModels(light.kind)
    const record = catalog.find(m => m.make_id === light.makeId && m.slug === light.slug)
    if (!record) {
      // dist/ and catalog/ disagreeing about what exists is a broken release,
      // not a user error. Say so loudly rather than silently downgrading the
      // return shape — a caller reading `.sources` would get `undefined` and
      // never learn why.
      throw new VehiclesDBError(
        `VehiclesDB dataset inconsistency: ${light.id} is in dist/vehicles.json but not in ` +
          `catalog/${light.kind}/models.json for release ${index.version}. ` +
          `Report it at https://github.com/vehiclesdb/vehiclesdb/issues`
      )
    }
    return buildModelDetail(light, record)
  }

  /** Best effort text resolution under RESOLUTION.md. */
  async resolve(query, options = {}) {
    return (await this.#resolver()).text(query, options || {})
  }

  /** Resolve separate make/model fields, preserving ambiguity and provenance. */
  async modelMatch(make, model, options = {}) {
    return (await this.#resolver()).pair(make, model, options || {})
  }

  async #resolver() {
    if (!this.#resolverPromise) {
      this.#resolverPromise = this.#index().then(index => {
        const { Resolver } = require('./resolution.cjs')
        return new Resolver(index, normalize, pickBest)
      }).catch(error => { this.#resolverPromise = null; throw error })
    }
    return this.#resolverPromise
  }

  /**
   * Ranked substring search over model names — an autocomplete endpoint's
   * worth of behaviour, offline.
   *
   * Tiers (a model is scored by the FIRST that matches):
   *   0. the model's name equals the query
   *   1. the name starts with the query
   *   2. the name contains the query
   *   3. "Make Name" contains the query — so "volkswagen golf" finds the Golf.
   *      (Tier 3 mirrors the gem, vehicles/lib/vehicles/dataset.rb:132.)
   *
   * Ties break on global decile ascending (1 = most popular, unranked last),
   * then name, then canonical id. Fully deterministic and locale-independent.
   * NOTE: the gem tie-breaks on name LENGTH instead; we rank by measured
   * popularity because that is what an autocomplete wants at the top.
   */
  async search(query, options) {
    const { kind, limit = 25 } = options || {}
    const index = await this.#index()
    const q = normalize(query)
    if (!q) return []

    const scored = []
    for (const entry of index.folded) {
      const model = entry.model
      if (kind && model.kind !== kind) continue
      const name = entry.name
      let tier
      if (name === q) tier = 0
      else if (name.startsWith(q)) tier = 1
      else if (name.includes(q)) tier = 2
      else if (entry.full.includes(q)) tier = 3
      else continue
      scored.push({ tier, model })
    }

    scored.sort(
      (a, b) =>
        a.tier - b.tier ||
        decileKey(a.model.globalDecile) - decileKey(b.model.globalDecile) ||
        compareStrings(a.model.name, b.model.name) ||
        compareStrings(a.model.id, b.model.id)
    )

    const max = Number.isFinite(limit) && limit >= 0 ? limit : scored.length
    return scored.slice(0, max).map(entry => entry.model)
  }

  // --- API mode ------------------------------------------------------------

  /**
   * Rendered imagery for one model — the ONE `/v1` endpoint live today
   * (`GET /v1/vehicles/{kind}/{make}/{model}/images`). API only: there is no
   * imagery in the open dataset, so this throws without an `apiKey` rather
   * than returning a fake.
   *
   * Returns the endpoint's response VERBATIM — snake_case `requested_color`,
   * `license_note` and all. Everything else in this package is camelCased, but
   * this one payload is a shipped wire contract documented at
   * https://vehiclesdb.com/api, and giving it a second vocabulary would make
   * the SDK and the OpenAPI spec disagree.
   *
   * `year` and `trim` are NOT accepted: the endpoint 422s them today
   * ("unsupported_filter") precisely so no integration builds on semantics
   * that have not shipped, and an SDK that forwarded them would defeat that.
   *
   * @param {string} id canonical `kind/make_slug/model_slug`
   * @param {{color?:string, format?:'webp'|'png'}} [options]
   */
  async images(id, options) {
    const { color, format } = options || {}
    if (!this.apiKey) {
      throw new VehiclesDBConfigError(
        'images() needs a VehiclesDB API key: new VehiclesDB({ apiKey: process.env.VEHICLESDB_API_KEY }). ' +
          'Imagery is not part of the open dataset. Mint a key at https://vehiclesdb.com/settings/api-keys',
        'apiKey'
      )
    }
    const parts = exactKey(id).split('/')
    if (parts.length !== KIND_SEGMENTS || parts.some(part => !part)) {
      throw new VehiclesDBError(
        `images() wants a canonical VehiclesDB id — kind/make_slug/model_slug, e.g. "car/renault/clio" — got ${JSON.stringify(id)}`
      )
    }
    const url = new URL(`${this.apiBaseUrl}/v1/vehicles/${parts[0]}/${parts[1]}/${parts[2]}/images`)
    if (color) url.searchParams.set('color', color)
    if (format) url.searchParams.set('format', format)

    return this.#getJson(url.toString(), {
      // `/v1` authenticates with a bearer token (401 -> {"error":"unauthorized"}).
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      // Image URLs in the response are signed and key-free, so they can be put
      // straight into <img src> — never cache the payload past the caller.
      cache: false
    })
  }

  // --- transport -----------------------------------------------------------

  /** The parsed dataset + every derived index, built at most once per client. */
  #index() {
    if (!this.#indexPromise) {
      this.#indexPromise = this.#getJson(`${this.datasetBaseUrl}/dist/vehicles.json`)
        .then(buildIndex)
        .catch(error => {
          // Clear on failure so a transient CDN blip does not poison the
          // client forever; a retry gets a fresh attempt.
          this.#indexPromise = null
          throw error
        })
    }
    return this.#indexPromise
  }

  /** One kind's full catalog slice. Only ever fetched by `model()`. */
  async #catalogModels(kind) {
    const list = await this.#getJson(`${this.datasetBaseUrl}/catalog/${kind}/models.json`)
    return Array.isArray(list) ? list : []
  }

  async #getJson(url, { headers, cache = true } = {}) {
    if (cache) {
      // `await` even though the default Map is synchronous: a caller-supplied
      // cache (localStorage, Redis, ...) is allowed to be async.
      const hit = await this.#cache.get(url)
      if (hit !== undefined) return hit
    }

    // Dedupe concurrent callers so `Promise.all([db.makes(), db.makes()])` is
    // still one request. Result caching alone would not cover this.
    let inflight = this.#pending.get(url)
    if (!inflight) {
      inflight = this.#request(url, headers).finally(() => this.#pending.delete(url))
      this.#pending.set(url, inflight)
    }
    const value = await inflight
    if (cache) await this.#cache.set(url, value)
    return value
  }

  async #request(url, headers) {
    const fetchImpl = this.#fetchImpl
    if (!fetchImpl) {
      // Checked here, not in the constructor: constructing a client must never
      // do or require I/O, and `db.attribution` has to work anywhere.
      throw new VehiclesDBConfigError(
        'no fetch implementation available. VehiclesDB needs global fetch (Node >= 18) — ' +
          "on older runtimes pass one: new VehiclesDB({ fetch: require('node-fetch') })",
        'fetch'
      )
    }

    // AbortController rather than AbortSignal.timeout(): the latter is missing
    // on Node 16 and older Safari, and this package has no polyfill budget.
    const controller = this.timeout > 0 ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null

    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: controller ? controller.signal : undefined
      })
    } catch (error) {
      throw new VehiclesDBError(
        `VehiclesDB request to ${url} failed${controller ? ` (timeout ${this.timeout}ms)` : ''}: ${error && error.message}`,
        { cause: error }
      )
    } finally {
      if (timer) clearTimeout(timer)
    }

    const body = await readBody(response)
    if (!response.ok) {
      // Keep the server's own error shape intact — `{"error":"no_image","id":…}`
      // tells a caller far more than any message we could synthesize.
      const detail = body && typeof body === 'object' && body.error ? ` ${body.error}` : ''
      throw new VehiclesDBApiError(
        `VehiclesDB GET ${url} -> ${response.status}${detail}`,
        { status: response.status, body, url, method: 'GET' }
      )
    }
    return body
  }
}

/** Parse a response as JSON, falling back to text (a CDN 404 is HTML). */
async function readBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '')
}

module.exports = {
  VehiclesDB,
  VehiclesDBError,
  VehiclesDBApiError,
  VehiclesDBConfigError,
  ATTRIBUTION,
  // Exported because it is the exact fold every id/name comparison in the
  // dataset uses; downstream code that builds its own index should use the
  // same one or it will disagree with us about "Citroën".
  normalize
}
