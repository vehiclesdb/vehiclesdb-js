// Hand-written types for @vehiclesdb/client.
//
// Hand-written on purpose: the package ships no build step, so there is no
// `tsc` pass to generate these, and a hand-written file can carry the WHY that
// a generated one cannot. Keep it in lockstep with index.cjs.
//
// Field names are camelCased per the parity contract (CONTRACT.md: "language
// idiomatic casing is expected"). Nothing is renamed or invented beyond that —
// every field below exists in the published dataset (SCHEMA.md).

/** The six vehicle kinds the dataset ships. */
export type Kind = 'car' | 'motorcycle' | 'moped' | 'van' | 'truck' | 'bus'

/** RESOLUTION.md vocabulary. */
export type ResolutionMethod = 'exact' | 'former_id' | 'fold' | 'alias' | 'form' | 'cleaned' | 'fuzzy'
/** @deprecated Use ResolutionMethod. */
export type MatchedOn = ResolutionMethod

/** Which brain answered. A caller must always be able to tell. */
export type ResolutionSource = 'dataset' | 'api'

/**
 * A make, as published in `dist/vehicles.json`.
 *
 * No `countries`: that field lives only in `catalog/{kind}/makes.json`, and
 * `makes()` is contractually one fetch of the light dataset.
 */
export interface Make {
  /** Same string as `slug` — `catalog/{kind}/makes.json` publishes both, identical. */
  readonly id: string
  readonly slug: string
  readonly name: string
  /** Kinds this make builds, e.g. `["car","moped","van"]` for Aixam. */
  readonly kinds: readonly Kind[]
  /** Published nicknames/initialisms/native scripts. `[]` = none curated. */
  readonly aliases: readonly string[]
  /** Slugs of makes merged into this one (dataset 2026.11.3+). `[]` = none. */
  readonly formerSlugs: readonly string[]
}

/**
 * Everything a model carries regardless of which published file it came from.
 * Split out (rather than reached for with `Omit`) because `Model` and
 * `ModelDetail` genuinely disagree about one field — see `ModelDetail`.
 */
export interface ModelIdentity {
  /** The canonical id: `kind/make_slug/model_slug`. This is the product. */
  readonly id: string
  readonly makeId: string
  readonly makeName: string
  readonly slug: string
  readonly name: string
  readonly kind: Kind
  /** Cars always carry one; vans/trucks/buses do not yet. `null` = not catalogued. */
  readonly bodyType: string | null
  /** 1 = top 10% worldwide … 10. `null` = unranked, and unranked sorts last. */
  readonly globalDecile: number | null
  /** Per-kind decile of summed registrations (1 = most). Drives the kind tie-break. */
  readonly massDecile: number | null
  /**
   * First and last first-registration year seen in the registers — a HINT for a
   * year picker, not production years, never a validation bound. `null` until
   * the release publishes it.
   */
  readonly registrationYears: { readonly first: number | null; readonly last: number | null } | null
  /** Continent rollup of `availability`: `eu` `na` `sa` `as` `oc` `af`. */
  readonly regions: readonly string[]
  /** Published alternate names ("Rabbit", "Käfer", "カローラ"). */
  readonly aliases: readonly string[]
  /** Curated spellings, scoped to this make. */
  readonly forms: readonly string[]
  /** Canonical ids this record used to have. Old ids keep working. */
  readonly formerIds: readonly string[]
}

/**
 * A model, as published in `dist/vehicles.json` — what `models()` and
 * `search()` give you.
 */
export interface Model extends ModelIdentity {
  /** ISO-3166 alpha-2 codes with official evidence of presence. */
  readonly availability: readonly string[]
}

/** One country's evidence row, from `catalog/{kind}/models.json`. */
export interface Availability {
  readonly country: string
  /** `registration` · `approval` · `sales` (SCHEMA.md "Availability"). */
  readonly evidence: string
  /** Source id, e.g. `nl_rdw` (see the data repo's SOURCES.md). */
  readonly source: string
}

export interface CountryPopularity {
  /** Position among all models of that kind in that country. */
  readonly rank: number | null
  readonly decile: number | null
  /** `measured` = from official counts we hold. */
  readonly confidence: string | null
}

export interface Popularity {
  readonly globalDecile: number | null
  readonly byCountry: Readonly<Record<string, CountryPopularity>>
}

/**
 * The full record, from `catalog/{kind}/models.json` — what `model()` returns.
 *
 * ⚠️ `availability` is the ONE field whose shape differs from `Model`: here it
 * is the catalog's evidence rows, there it is bare country codes. Both are the
 * published shapes of their own file and they agree by construction
 * (`detail.availability.map(a => a.country)` equals the light `availability`).
 */
export interface ModelDetail extends ModelIdentity {
  /** A nameplate can span bodies: `volkswagen/golf` → `["hatchback","wagon"]`. */
  readonly bodyTypes: readonly string[]
  readonly availability: readonly Availability[]
  /** Ids of the sources evidencing this record. */
  readonly sources: readonly string[]
  /** Crosswalks; today `{ tan: [...] }` EU type-approval numbers. `null` = none. */
  readonly xrefs: Readonly<Record<string, readonly string[]>> | null
  /** `null` = no counts yet for this model. */
  readonly popularity: Popularity | null
}

export interface ResolutionMatch {
  readonly id: string
  readonly name: string
  readonly make: { readonly id: string; readonly name: string }
  readonly kind: Kind
  readonly method: ResolutionMethod
  readonly confidence: number
}

/** No match is null; ambiguity has match/id null and competing alternates. */
export interface Resolution {
  readonly id: string | null
  readonly kind: Kind | null
  readonly make: string | null
  readonly model: string | null
  readonly method: ResolutionMethod
  /** @deprecated Use method. */
  readonly matchedOn: ResolutionMethod
  readonly confidence: number
  /** Safe to auto-apply to stored data: not ambiguous and not a typo guess (`method !== 'fuzzy'`). */
  readonly confident: boolean
  readonly source: ResolutionSource
  readonly match: ResolutionMatch | null
  readonly ambiguous: boolean
  readonly candidates: readonly Model[]
  readonly alternates: readonly Model[]
  readonly via: readonly string[]
  readonly resolvedVia: readonly string[]
}

/** One rendered variant of a vehicle image. */
export interface ImageVariant {
  /** Signed and key-free — safe to put straight into `<img src>`. */
  readonly url: string
  readonly width: number
  readonly height: number
}

/**
 * The verbatim 200 body of `GET /api/v1/vehicles/{kind}/{make}/{model}/images`.
 * snake_case on purpose: this is a shipped wire contract documented at
 * https://vehiclesdb.com/api, not a shape this package gets to rename.
 */
export interface VehicleImages {
  readonly id: string
  /** The color actually SERVED (un-rendered colors fall back honestly). */
  readonly color: string
  /** The color you asked for. Compare with `color` to detect a fallback. */
  readonly requested_color: string
  /** Colors actually rendered for this model. */
  readonly palette: readonly string[]
  readonly variants: {
    readonly sm: ImageVariant
    readonly md: ImageVariant
    readonly lg: ImageVariant
  }
  readonly format: string
  readonly provenance: {
    readonly generated: boolean
    readonly license_note: string
  }
}

/** The CC-BY notice, programmatically. Visible credit is a licence condition. */
export interface Attribution {
  /** One string carrying credit, licence and the upstream-notices pointer. */
  readonly notice: string
  /** Plain-text form, for an app's about/credits screen. */
  readonly text: string
  /** A followable link, e.g. for a footer. */
  readonly html: string
  /** `Vehicle data by [VehiclesDB](https://vehiclesdb.com)` */
  readonly markdown: string
  readonly license: 'CC-BY-4.0'
  readonly licenseUrl: string
  /** Upstream register notices — they apply under EVERY licence. */
  readonly upstreamNoticesUrl: string
  readonly required: true
  toString(): string
}

/** A url -> parsed-JSON store. `get`/`set` may be sync or async. */
export interface Cache {
  get(key: string): unknown | Promise<unknown>
  set(key: string, value: unknown): unknown | Promise<unknown>
}

/**
 * The part of `fetch` this package actually uses, spelled out rather than
 * written as `typeof globalThis.fetch`: that alias only exists if the consumer
 * has DOM or @types/node in their `lib`, and this package must type-check in a
 * bare `lib: ["es2020"]` project too. The real global `fetch` is assignable.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    // `any`, not `unknown`: naming the real `AbortSignal` would drag in the DOM
    // lib, and `unknown` is not assignable to the global fetch's own
    // `AbortSignal | null | undefined`, which would reject `fetch` itself.
    signal?: any
  }
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface VehiclesDBOptions {
  /** Release tag to read, e.g. `'2026.07.6'`. Default `'latest'`. */
  version?: string
  /** Override the CDN base entirely (a mirror, or a local copy). */
  datasetBaseUrl?: string
  /** Default `'https://vehiclesdb.com'`. */
  apiBaseUrl?: string
  /** Required by `images()` only. */
  apiKey?: string
  /** A fetch-shaped function. Defaults to global `fetch` (Node >= 18). */
  fetch?: FetchLike
  /** Per-request timeout in ms. Default 10000; `0` disables. */
  timeout?: number
  /** Share one across clients to share the downloaded dataset. */
  cache?: Cache
}

export interface MakesOptions {
  kind?: Kind
}

export interface ModelsOptions {
  kind?: Kind
  bodyType?: string
}

export interface ResolveOptions {
  /** Scopes the name rungs to one kind; an explicit id still answers (RESOLUTION.md §3a). */
  kind?: Kind
  /** Hard constraint on every rung, ids included. `[]` matches nothing. */
  kinds?: readonly Kind[]
  /** ISO-3166 alpha-2. Restricts candidates to that market's evidence. */
  country?: string
}

export interface ByIdOptions {
  /** Follow `former_ids` to the record that replaced the id. Default `true`. */
  follow?: boolean
  kinds?: readonly Kind[]
}

export interface CatalogOptions {
  kind?: Kind
  kinds?: readonly Kind[]
  /** ISO-3166 alpha-2: only models with register evidence there. */
  country?: string
}

export interface CatalogEntry {
  readonly make: Make
  readonly models: readonly Model[]
}

export type Locale = 'en' | 'es' | string

export interface LabelOptions {
  /** `en` (default) or `es`; region suffixes (`es-ES`) are ignored; others fall back to `en`. */
  locale?: Locale
}

export interface Color {
  readonly slug: string
  readonly name: string
  readonly hex: string
}

export interface SearchOptions {
  kind?: Kind
  /** Default 25. */
  limit?: number
}

export interface ImagesOptions {
  /** A slug from the canonical 14-color palette. Default `grey` server-side. */
  color?: string
  format?: 'webp' | 'png'
}

/** Base class for everything this package throws. */
export class VehiclesDBError extends Error {
  // Deliberately `string`, not the literal: a subclass narrowing it to its own
  // literal would then not be assignable to this base declaration.
  readonly name: string
}

/** A required option is missing or unusable; `option` names which one. */
export class VehiclesDBConfigError extends VehiclesDBError {
  readonly name: 'VehiclesDBConfigError'
  /** e.g. `'apiKey'`, `'fetch'`. */
  readonly option: string
}

/** Any non-2xx HTTP response, from the CDN or from the API. */
export class VehiclesDBApiError extends VehiclesDBError {
  readonly name: string
  readonly status: number
  /** The server's own body, parsed — e.g. `{ error: 'no_image', id: '…' }`. */
  readonly body: unknown
  readonly url: string
  readonly method: string
  /** `body.error` when the API sent one (`invalid_token`, `insufficient_credits`, `rate_limited`, …). */
  readonly code: string | null
}

/** 401/403: missing, invalid or revoked key, or a key not allowed from here. */
export class VehiclesDBAuthError extends VehiclesDBApiError {}
/** 402: the organization is out of API credits. */
export class VehiclesDBPaymentRequiredError extends VehiclesDBApiError {}
/** 404: unknown resource or no image (`code` says which). */
export class VehiclesDBNotFoundError extends VehiclesDBApiError {}
/** 429: an abuse ceiling; retry after `retryAfter` seconds. */
export class VehiclesDBRateLimitError extends VehiclesDBApiError {
  readonly retryAfter: number | null
}
/** The request did not finish within `timeout` ms. */
export class VehiclesDBTimeoutError extends VehiclesDBError {
  readonly url: string
  readonly timeout: number
}

/** The kind precedence of the kind-collision tie-break (RESOLUTION.md §3a). */
export const KIND_PRECEDENCE: readonly Kind[]

export class VehiclesDB {
  constructor(options?: VehiclesDBOptions)

  readonly version: string
  readonly datasetBaseUrl: string
  readonly apiBaseUrl: string
  readonly apiKey: string | null
  readonly timeout: number

  /** The CC-BY notice. Rendering it is a condition of the licence. */
  readonly attribution: Attribution

  /** The release the answers came from, e.g. `'2026.07.6'`. */
  datasetVersion(): Promise<string>

  makes(options?: MakesOptions): Promise<Make[]>
  /** Alias-aware make lookup. Unknown make => `[]`, never throws. */
  models(make: string, options?: ModelsOptions): Promise<Model[]>
  /** Honours `former_ids`. Unknown => `null`. */
  model(id: string): Promise<ModelDetail | null>
  model(kind: string, make: string, slug: string): Promise<ModelDetail | null>
  /** A light record by id (one dataset fetch); follows former ids by default. Unknown => `null`. */
  byId(id: string, options?: ByIdOptions): Promise<Model | null>
  /** The live id for a stored id: itself, its successor, or `null`. */
  successor(id: string): Promise<string | null>
  /** Makes with their models, filtered by kind(s) and country, name-ordered. */
  catalog(options?: CatalogOptions): Promise<CatalogEntry[]>
  /** The canonical 14-colour palette with localized names. */
  colors(options?: LabelOptions): Color[]
  /** `[[label, slug], ...]` for a select. */
  colorOptions(options?: LabelOptions): [string, string][]
  /** A palette colour from a slug or an English/Spanish name or synonym. */
  color(query: string, options?: LabelOptions): Color | null
  kindLabel(kind: string, options?: LabelOptions): string | null
  bodyTypeLabel(bodyType: string, options?: LabelOptions): string | null
  /** RESOLUTION.md ladder, preserving ambiguity. */
  resolve(query: string, options?: ResolveOptions): Promise<Resolution | null>
  modelMatch(make: string, model: string, options?: ResolveOptions): Promise<Resolution | null>
  search(query: string, options?: SearchOptions): Promise<Model[]>
  /** API only — throws `VehiclesDBConfigError` without an `apiKey`. */
  images(id: string, options?: ImagesOptions): Promise<VehicleImages>
}

export const ATTRIBUTION: Attribution

/** The exact fold every name/id comparison in this package uses. */
export function normalize(value: unknown): string

declare const _default: {
  VehiclesDB: typeof VehiclesDB
  VehiclesDBError: typeof VehiclesDBError
  VehiclesDBApiError: typeof VehiclesDBApiError
  VehiclesDBAuthError: typeof VehiclesDBAuthError
  VehiclesDBPaymentRequiredError: typeof VehiclesDBPaymentRequiredError
  VehiclesDBNotFoundError: typeof VehiclesDBNotFoundError
  VehiclesDBRateLimitError: typeof VehiclesDBRateLimitError
  VehiclesDBTimeoutError: typeof VehiclesDBTimeoutError
  VehiclesDBConfigError: typeof VehiclesDBConfigError
  KIND_PRECEDENCE: readonly Kind[]
  ATTRIBUTION: Attribution
  normalize: typeof normalize
}
export default _default
