// The main suite, over the ESM entry point.
//
// Every test here is OFFLINE: the client's `fetch` is the fixture transport
// from helpers.mjs, which serves `fixtures/` off disk and throws on any
// URL it has no fixture for. Both SDKs read those same bytes, which is what
// makes JS<->Python parity assertable.
//
// Counts are READ OUT OF THE FIXTURE rather than typed in, so a regenerated
// fixture updates the expectations instead of reddening the suite for no
// reason. Where a literal is asserted it is because the VALUE is the contract
// (a canonical id, a `matchedOn` rung, an ordering).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VehiclesDB,
  VehiclesDBError,
  VehiclesDBApiError,
  VehiclesDBConfigError,
  VehiclesDBAuthError,
  VehiclesDBPaymentRequiredError,
  VehiclesDBRateLimitError,
  VehiclesDBNotFoundError,
  VehiclesDBTimeoutError,
  normalize
} from '../index.mjs'
import { fixtureFetch, apiFetch, readFixture, fixtureClient, FIXTURE_VERSION } from './helpers.mjs'

const dist = await readFixture('dist/vehicles.json')

// ---------------------------------------------------------------------------
// laziness
// ---------------------------------------------------------------------------

test('constructing a client performs zero transport calls', () => {
  const fetchImpl = fixtureFetch()
  const db = new VehiclesDB({ fetch: fetchImpl })
  assert.deepEqual(fetchImpl.calls, [])
  // Even reading configuration must not reach for the network.
  assert.equal(db.datasetBaseUrl, 'https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@latest')
  assert.equal(db.attribution.license, 'CC-BY-4.0')
  assert.deepEqual(fetchImpl.calls, [])
})

test('the dataset is fetched once, no matter how many questions', async () => {
  const { client, fetchImpl } = await fixtureClient()
  await client.makes()
  await client.makes({ kind: 'car' })
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0], /\/dist\/vehicles\.json$/)

  // Concurrency too: result caching alone would let these race into two
  // requests, so the client dedupes in-flight promises.
  const fresh = await fixtureClient()
  await Promise.all([fresh.client.makes(), fresh.client.search('golf'), fresh.client.resolve('vw golf')])
  assert.equal(fresh.fetchImpl.calls.length, 1)
})

test('a pinned version changes the URL, not the answers', async () => {
  const { client, fetchImpl } = await fixtureClient({ version: FIXTURE_VERSION })
  assert.equal(await client.datasetVersion(), FIXTURE_VERSION)
  assert.equal(
    fetchImpl.calls[0],
    `https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@${FIXTURE_VERSION}/dist/vehicles.json`
  )
})

test('the fixture transport refuses unknown URLs instead of hitting the network', async () => {
  // The transport matches on the published CDN LAYOUT, not on the host, so a
  // mirror resolves the same way...
  const mirrored = new VehiclesDB({ datasetBaseUrl: 'https://mirror.example/vehiclesdb', fetch: fixtureFetch() })
  assert.equal((await mirrored.makes()).length, dist.makes.length)

  // ...but anything that is not a dataset path throws LOUDLY rather than
  // returning a 404 or, far worse, falling through to the real network. This
  // is the guard that keeps the suite honest.
  const api = new VehiclesDB({ apiKey: 'k', fetch: fixtureFetch() })
  await assert.rejects(() => api.images('car/renault/clio'), /not a published dataset path/)
})

// ---------------------------------------------------------------------------
// makes
// ---------------------------------------------------------------------------

test('makes() unions across kinds and counts match the fixture exactly', async () => {
  const { client } = await fixtureClient()
  const makes = await client.makes()
  assert.equal(makes.length, dist.makes.length)
  assert.deepEqual(
    [...makes].map(m => m.slug).sort(),
    dist.makes.map(m => m.slug).sort()
  )
  // Name-alphabetical and diacritic-insensitive, like the gem: "Citroën"
  // sorts as "citroen", between BMW and Dacia.
  assert.deepEqual(
    makes.map(m => m.name),
    ['Aixam', 'Alfa Romeo', 'BMW', 'Citroën', 'Dacia', 'Ford', 'Mercedes-Benz',
     'Renault', 'SEAT', 'Tesla', 'Toyota', 'Volkswagen']
  )
})

test('makes({ kind }) filters on the make\'s published kinds[]', async () => {
  const { client } = await fixtureClient()
  for (const kind of dist.kinds) {
    const expected = dist.makes.filter(m => m.kinds.includes(kind)).map(m => m.slug)
    const actual = (await client.makes({ kind })).map(m => m.slug)
    assert.deepEqual(actual.slice().sort(), expected.slice().sort(), `kind=${kind}`)
  }
  // The multi-kind makes the fixture exists to cover.
  const aixam = (await client.makes()).find(m => m.slug === 'aixam')
  assert.deepEqual([...aixam.kinds], ['car', 'moped', 'van'])
  const ford = (await client.makes()).find(m => m.slug === 'ford')
  assert.deepEqual([...ford.kinds], ['car', 'van', 'truck', 'bus'])
})

test('a Make carries its published aliases, and id mirrors slug', async () => {
  const { client } = await fixtureClient()
  const vw = (await client.makes()).find(m => m.slug === 'volkswagen')
  assert.equal(vw.id, vw.slug)
  assert.deepEqual([...vw.aliases], ['VW', 'Vdub'])
  // Absent optional => [], never undefined (the schema's absence rule).
  const tesla = (await client.makes()).find(m => m.slug === 'tesla')
  assert.deepEqual([...tesla.aliases], [])
})

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

test('models() is alias-aware and case/slug forgiving', async () => {
  const { client } = await fixtureClient()
  const bySlug = await client.models('volkswagen')
  const byName = await client.models('Volkswagen')
  const byAlias = await client.models('VW')
  const byLowerAlias = await client.models('vw')

  const expected = dist.makes.find(m => m.slug === 'volkswagen').models.length
  assert.equal(bySlug.length, expected)
  assert.deepEqual(byName.map(m => m.id), bySlug.map(m => m.id))
  assert.deepEqual(byAlias.map(m => m.id), bySlug.map(m => m.id))
  assert.deepEqual(byLowerAlias.map(m => m.id), bySlug.map(m => m.id))

  // A hyphenated slug and a diacritic display name both land.
  assert.ok((await client.models('alfa-romeo')).length > 0)
  assert.ok((await client.models('Alfa')).length > 0)
  assert.deepEqual(
    (await client.models('Citroën')).map(m => m.id),
    (await client.models('citroen')).map(m => m.id)
  )
})

test('models() of an unknown make is [] and never throws', async () => {
  const { client } = await fixtureClient()
  assert.deepEqual(await client.models('DeLorean'), [])
  assert.deepEqual(await client.models(''), [])
  assert.deepEqual(await client.models(null), [])
  assert.deepEqual(await client.models('   '), [])
})

test('an explicitly null options bag behaves like no options bag', async () => {
  // `{ kind } = {}` only defaults on `undefined`, and callers really do pass
  // `null` when the options come out of a variable.
  const { client } = await fixtureClient()
  assert.equal((await client.makes(null)).length, dist.makes.length)
  assert.ok((await client.models('VW', null)).length > 0)
  assert.equal((await client.resolve('vw golf', null)).id, 'car/volkswagen/golf')
  assert.ok((await client.search('golf', null)).length > 0)
})

test('models() filters by kind and bodyType', async () => {
  const { client } = await fixtureClient()
  const vwCars = await client.models('VW', { kind: 'car' })
  const expected = dist.makes
    .find(m => m.slug === 'volkswagen')
    .models.filter(m => m.kind === 'car').length
  assert.equal(vwCars.length, expected)
  assert.ok(vwCars.every(m => m.kind === 'car'))

  const suvs = await client.models('Toyota', { kind: 'car', bodyType: 'suv' })
  assert.deepEqual(suvs.map(m => m.name), ['C-HR', 'RAV4'])

  // A make can declare a kind the release holds no kept models for (BMW builds
  // mopeds; this fixture caps at 30 models per make and none survived). An
  // empty list is the honest answer, not a bug.
  assert.deepEqual(await client.models('bmw', { kind: 'moped' }), [])
})

test('a light Model carries the canonical id and the published fields', async () => {
  const { client } = await fixtureClient()
  const golf = (await client.models('VW')).find(m => m.slug === 'golf')
  assert.equal(golf.id, 'car/volkswagen/golf')
  assert.equal(golf.makeId, 'volkswagen')
  assert.equal(golf.makeName, 'Volkswagen')
  assert.equal(golf.kind, 'car')
  assert.equal(golf.bodyType, 'hatchback')
  assert.equal(typeof golf.globalDecile, 'number')
  assert.deepEqual([...golf.aliases], ['Rabbit'])
  assert.ok(golf.formerIds.includes('car/volkswagen/vw-golf'))
  assert.ok(golf.availability.includes('nl'))

  // Kinds with no body-type vocabulary yet report null, not undefined.
  const transporter = (await client.models('VW', { kind: 'van' })).find(m => m.slug === 'transporter')
  assert.equal(transporter.bodyType, null)
})

// ---------------------------------------------------------------------------
// model (full record)
// ---------------------------------------------------------------------------

test('model() takes a full id or the 3-arg form and agrees with itself', async () => {
  const { client, fetchImpl } = await fixtureClient()
  const byId = await client.model('car/volkswagen/golf')
  const byParts = await client.model('car', 'volkswagen', 'golf')
  assert.deepEqual(byId, byParts)
  assert.equal(byId.id, 'car/volkswagen/golf')

  // dist + exactly one catalog slice, and the slice is memoized.
  assert.deepEqual(fetchImpl.calls, [
    `https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@${FIXTURE_VERSION}/dist/vehicles.json`,
    `https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@${FIXTURE_VERSION}/catalog/car/models.json`
  ])
})

test('model() upgrades the light record with catalog-only depth', async () => {
  const { client } = await fixtureClient()
  const golf = await client.model('car/volkswagen/golf')
  assert.deepEqual([...golf.bodyTypes], ['hatchback', 'wagon'])
  assert.ok(golf.sources.includes('nl_rdw'))
  assert.equal(golf.popularity.globalDecile, golf.globalDecile)
  assert.equal(golf.popularity.byCountry.nl.confidence, 'measured')
  assert.ok(Array.isArray(golf.xrefs.tan))

  // The one field that changes shape between the two published files — and
  // the invariant that makes the upgrade lossless.
  const light = (await client.models('VW')).find(m => m.slug === 'golf')
  assert.deepEqual(golf.availability.map(a => a.country), [...light.availability])
  assert.equal(golf.availability[0].evidence, 'approval')

  // Absent object-valued optionals stay null (58 car records have no xrefs).
  const noXrefs = await client.model('car/aixam/500')
  assert.equal(noXrefs.xrefs, null)
  // Absent array-valued optionals become [].
  assert.deepEqual([...noXrefs.aliases], [])
})

test('model() honours former_ids — old ids keep working', async () => {
  const { client } = await fixtureClient()
  // The Alfa Romeo 1750 GTV rename chain, straight out of the fixture.
  const renamed = await client.model('car/alfa-romeo/1750gtv')
  assert.equal(renamed.id, 'car/alfa-romeo/1750-gtv')
  assert.equal(renamed.name, '1750 GTV')
  assert.ok(renamed.formerIds.includes('car/alfa-romeo/1750gtv'))

  // Every other former id in that chain redirects to the same record.
  for (const formerId of renamed.formerIds) {
    assert.equal((await client.model(formerId)).id, renamed.id, formerId)
  }
  // A rename in a different make, to prove it is the mechanism and not a fluke.
  assert.equal((await client.model('car/tesla/y')).id, 'car/tesla/model-y')
})

test('model() of an unknown id is null', async () => {
  const { client } = await fixtureClient()
  assert.equal(await client.model('car/nope/nope'), null)
  assert.equal(await client.model('car', 'volkswagen', 'not-a-golf'), null)
  assert.equal(await client.model('nonsense'), null)
  assert.equal(await client.model(''), null)
})

// ---------------------------------------------------------------------------
// resolve — one case per ladder rung
// ---------------------------------------------------------------------------

test('resolve() rung 1: the canonical id itself => exact', async () => {
  const { client } = await fixtureClient()
  const r = await client.resolve('car/volkswagen/golf')
  assert.deepEqual(Object.fromEntries(['id', 'kind', 'make', 'model', 'matchedOn', 'confidence', 'source'].map(k => [k, r[k]])), {
    id: 'car/volkswagen/golf',
    kind: 'car',
    make: 'Volkswagen',
    model: 'Golf',
    matchedOn: 'exact',
    confidence: 1,
    source: 'dataset'
  })
  // The catalog's kind-scoped `make/model` id form, when the kind is supplied.
  assert.equal((await client.resolve('volkswagen/golf', { kind: 'car' })).method, 'fold')
})

test('resolve() rung 2: make + an exact model name or slug => slug', async () => {
  const { client } = await fixtureClient()
  for (const query of ['Volkswagen Golf', 'volkswagen golf', 'VW Golf', 'vw golf']) {
    const r = await client.resolve(query)
    assert.equal(r.method, 'fold', query)
    assert.equal(r.id, 'car/volkswagen/golf', query)
    assert.equal(r.confidence, .97)
  }
  // Multi-word make names are tried longest-first.
  assert.equal((await client.resolve('Mercedes-Benz C-Class')).id, 'car/mercedes-benz/c-class')
  // Published make alias, not a hand-written one.
  assert.equal((await client.resolve('merc c class')).id, 'car/mercedes-benz/c-class')
})

test('resolve() rung 3: a published model alias => alias', async () => {
  const { client } = await fixtureClient()
  // A cross-make alias no make+model split could ever find: Dacia's Duster is
  // sold as a Renault in some markets.
  const duster = await client.resolve('Renault Duster')
  assert.equal(duster.matchedOn, 'alias')
  assert.equal(duster.id, 'car/dacia/duster')
  assert.equal(duster.confidence, 0.9)

  // A globally unique alias on its own.
  assert.equal((await client.resolve('Rabbit')).id, 'car/volkswagen/golf')
  // Diacritics fold on the alias rung too.
  assert.equal((await client.resolve('vw Käfer')).id, 'car/volkswagen/beetle')
  assert.equal((await client.resolve('vw kafer')).id, 'car/volkswagen/beetle')
  // TextMatcher normalizes before splitting; pair matching retains raw aliases.
  assert.equal(await client.resolve('カローラ'), null)
  assert.equal(await client.resolve('toyota カローラ'), null)
  assert.equal(await client.resolve('トヨタ カローラ'), null)

  // Kind variants of the same model are one alias target.
  assert.equal((await client.resolve('Landcruiser')).ambiguous, false)
  assert.equal((await client.resolve('Landcruiser', { kind: 'car' })).id, 'car/toyota/land-cruiser')

  // A self-folding alias remains a valid whole-text alias.
  assert.equal((await client.resolve('León')).id, 'car/seat/leon')
})

test('resolve() rung 3 refuses when a string names two different records', async () => {
  // THE GUARD, and why it looks like a bug from either side.
  //
  // "Rabbit" is a published alias of car/volkswagen/golf. In the FULL release
  // it is also the name of a separate car/volkswagen/rabbit record — two
  // records, one string, nothing in the data to choose between them — so
  // resolve('Rabbit') is null there (asserted in full-release.test.mjs).
  //
  // On `fixtures/` the 30-model-per-make cap drops volkswagen/rabbit, so
  // only the alias survives and the SAME string correctly resolves. Both
  // answers are right; the answer is CORPUS-DEPENDENT. Do not "fix" either of
  // these two assertions to agree with the other — what must never differ is
  // JS vs Python on the same corpus.
  const { client } = await fixtureClient()
  const onFixture = await client.resolve('Rabbit')
  assert.equal(onFixture.id, 'car/volkswagen/golf')
  assert.equal(onFixture.matchedOn, 'alias')

  // Reproduce the real collision by putting the record the cap removed back:
  // this is the actual `car/volkswagen/rabbit` from release 2026.07.6, not an
  // invention. (The collision itself is a dataset defect — one nameplate whose
  // alias points at a different id — logged in benchmark-carquery.md §5.)
  const base = 'https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@2026.07.6'
  const doctored = structuredClone(dist)
  doctored.makes
    .find(m => m.slug === 'volkswagen')
    .models.push({
      name: 'Rabbit',
      slug: 'rabbit',
      kind: 'car',
      body_type: 'hatchback',
      global_decile: 7,
      availability: ['us'],
      regions: ['na']
    })
  const collided = new VehiclesDB({
    version: '2026.07.6',
    fetch: async url => {
      assert.equal(url, `${base}/dist/vehicles.json`, 'this test needs no other file')
      return new Response(JSON.stringify(doctored), { status: 200 })
    }
  })

  assert.equal(await collided.resolve('Rabbit'), null)
  // The alias rung refuses; the rungs above it are untouched, so naming the
  // make still works and lands on the record that actually carries the name.
  assert.equal((await collided.resolve('vw rabbit')).id, 'car/volkswagen/rabbit')
  assert.equal((await collided.resolve('vw golf')).id, 'car/volkswagen/golf')
  // And a name/slug hit is a DISQUALIFIER, never an answer: a bare model name
  // still resolves to null rather than being promoted by this rung.
  assert.equal(await collided.resolve('rabbit'), null)
  assert.equal(await collided.resolve('golf'), null)
})

test('resolve() rung 4: a published former id => former_id', async () => {
  const { client } = await fixtureClient()
  const r = await client.resolve('car/alfa-romeo/1750gtv')
  assert.equal(r.matchedOn, 'former_id')
  assert.equal(r.id, 'car/alfa-romeo/1750-gtv')
  assert.equal(r.model, '1750 GTV')
  assert.equal(r.confidence, .98)
  // The whole rename chain, and one from another make.
  assert.equal((await client.resolve('car/alfa-romeo/gtv1750')).id, 'car/alfa-romeo/1750-gtv')
  assert.equal((await client.resolve('car/alfa-romeo/gtv-1750')).id, 'car/alfa-romeo/1750-gtv')
  assert.equal((await client.resolve('car/volkswagen/vw-golf')).id, 'car/volkswagen/golf')
})

test('resolve() does not infer former ids from free text or ignore trim', async () => {
  const { client } = await fixtureClient()
  assert.equal((await client.resolve('alfa romeo 1750gtv')).method, 'fold') // spacing-blind name
  for (const q of ['VW Golf 1.9 TDI', 'citroen c3 aircross 1.2', 'ford mustang mach-e gt', 'toyota land cruiser prado 150 series']) {
    assert.equal(await client.resolve(q), null, q)
  }
})

test('resolve() folds diacritics, case and punctuation', async () => {
  const { client } = await fixtureClient()
  const expected = 'car/citroen/c3'
  for (const query of ['citroen c3', 'Citroën C3', 'CITROËN   c3']) {
    const r = await client.resolve(query)
    assert.ok(r, `${query} should resolve`)
    assert.equal(r.id, expected, query)
  }
  // The fold is exported so downstream indexes can agree with ours.
  assert.equal(normalize('Citroën C3'), 'citroen c3')
  assert.equal(normalize('Mercedes-Benz'), 'mercedes benz')
  assert.equal(normalize('1.9 TDI'), '1 9 tdi')
  assert.equal(normalize(null), '')
})

test('resolve() returns null rather than guessing', async () => {
  const { client } = await fixtureClient()
  assert.equal(await client.resolve('nope nope'), null)
  assert.equal(await client.resolve(''), null)
  assert.equal(await client.resolve(null), null)
  // A make with no model.
  assert.equal(await client.resolve('vw'), null)
  // A bare model name with no make: matching it across every make is a guess.
  assert.equal(await client.resolve('golf'), null)
  // The gem's hand-written alias table is NOT here — only published aliases.
  assert.equal(await client.resolve('mercedes c class'), null)
})

test('resolve() honours kind and country filters', async () => {
  const { client } = await fixtureClient()
  assert.equal((await client.resolve('vw golf', { country: 'nl' })).id, 'car/volkswagen/golf')
  // No official evidence of a Golf in Japan in this release: no answer, not a
  // hedge.
  assert.equal(await client.resolve('vw golf', { country: 'jp' }), null)
  assert.equal(await client.resolve('car/volkswagen/golf', { country: 'jp' }), null)

  // One name, several kinds: deterministic without a kind, exact with one.
  assert.equal((await client.resolve('toyota hilux')).kind, 'van')
  assert.equal((await client.resolve('toyota hilux', { kind: 'car' })).id, 'car/toyota/hilux')
})

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search() ranking is exact, deterministic and tie-broken by popularity', async () => {
  const { client } = await fixtureClient()
  // "C3" is an exact name (Citroën C3 and the Aixam C3 moped) and a prefix
  // (C3 Aircross). Exact beats prefix; within exact, decile 2 beats decile 7.
  assert.deepEqual(
    (await client.search('c3')).map(m => m.id),
    ['car/citroen/c3', 'moped/aixam/c3', 'car/citroen/c3-aircross']
  )

  // Tier 1 (name starts with "3") comes before tier 2 (name contains "3"),
  // and within a tier the lowest decile wins — note Tesla's Model 3 (decile 1)
  // still sorts behind every tier-1 hit.
  assert.deepEqual(
    (await client.search('3', { limit: 9 })).map(m => m.id),
    [
      'car/bmw/3-series',
      'car/mercedes-benz/300-d',
      'car/mercedes-benz/300-e',
      'car/mercedes-benz/300-se',
      'van/mercedes-benz/311',
      'van/mercedes-benz/313',
      'car/bmw/3-0cs',
      'car/tesla/model-3',
      'car/citroen/c3'
    ]
  )

  // Same name across kinds: decile, then breadth is not used here — name and
  // id break the tie, so the order is stable forever.
  assert.deepEqual(
    (await client.search('land cruiser')).map(m => m.id),
    [
      'car/toyota/land-cruiser',
      'van/toyota/land-cruiser',
      'bus/toyota/land-cruiser',
      'truck/toyota/land-cruiser',
      'car/toyota/land-cruiser-prado'
    ]
  )
})

test('search() honours limit and kind, and matches the make name too', async () => {
  const { client } = await fixtureClient()
  // "1" matches far more than 25 records in this fixture, so the default cap
  // is what is being observed here, not the corpus running out.
  const uncapped = await client.search('1', { limit: Infinity })
  assert.ok(uncapped.length > 25, `expected >25 raw hits, got ${uncapped.length}`)
  assert.equal((await client.search('1')).length, 25) // the default limit
  assert.deepEqual((await client.search('1', { limit: 4 })).map(m => m.id), uncapped.slice(0, 4).map(m => m.id))
  assert.deepEqual(await client.search('1', { limit: 0 }), [])

  const cars = await client.search('land cruiser', { kind: 'car' })
  assert.deepEqual(cars.map(m => m.id), ['car/toyota/land-cruiser', 'car/toyota/land-cruiser-prado'])

  // Tier 4: "Make Name" contains the query.
  assert.deepEqual((await client.search('volkswagen golf')).map(m => m.id), ['car/volkswagen/golf'])
  assert.deepEqual(await client.search(''), [])
  assert.deepEqual(await client.search('zzzz'), [])
})

// ---------------------------------------------------------------------------
// images (API mode)
// ---------------------------------------------------------------------------

test('images() without an apiKey throws a named config error', async () => {
  const db = new VehiclesDB({ fetch: fixtureFetch() })
  await assert.rejects(
    () => db.images('car/renault/clio'),
    error => {
      assert.ok(error instanceof VehiclesDBConfigError)
      assert.equal(error.option, 'apiKey')
      assert.match(error.message, /apiKey/)
      return true
    }
  )
})

test('images() sends a bearer token to the documented path and parses the 200 body', async () => {
  const body = {
    id: 'car/renault/clio',
    color: 'blue',
    requested_color: 'blue',
    palette: ['black', 'blue', 'grey', 'red', 'white'],
    variants: {
      sm: { url: 'https://vehiclesdb.com/…/sm.webp', width: 320, height: 180 },
      md: { url: 'https://vehiclesdb.com/…/md.webp', width: 640, height: 360 },
      lg: { url: 'https://vehiclesdb.com/…/lg.webp', width: 1280, height: 720 }
    },
    format: 'webp',
    provenance: { generated: true, license_note: 'Generated imagery for product use.' }
  }
  const fetchImpl = apiFetch(() => ({ status: 200, body }))
  const db = new VehiclesDB({ apiKey: 'vdb_live_test', fetch: fetchImpl })

  const payload = await db.images('car/renault/clio', { color: 'blue', format: 'webp' })
  // Returned VERBATIM — snake_case and all. It is a shipped wire contract.
  assert.deepEqual(payload, body)

  assert.equal(fetchImpl.calls.length, 1)
  const { url, headers } = fetchImpl.calls[0]
  assert.equal(url.pathname, '/api/v1/vehicles/car/renault/clio/images')
  assert.equal(url.searchParams.get('color'), 'blue')
  assert.equal(url.searchParams.get('format'), 'webp')
  assert.equal(headers.Authorization, 'Bearer vdb_live_test')
  // Imagery is API-only: no dataset download is triggered.
  assert.deepEqual(fetchImpl.datasetCalls, [])
})

test('images() surfaces the documented error bodies as VehiclesDBApiError', async () => {
  const missing = apiFetch(() => ({
    status: 404,
    body: { error: 'no_render', id: 'car/volkswagen/passat' }
  }))
  await assert.rejects(
    () => new VehiclesDB({ apiKey: 'k', fetch: missing }).images('car/volkswagen/passat'),
    error => {
      assert.ok(error instanceof VehiclesDBApiError)
      assert.ok(error instanceof VehiclesDBError)
      assert.equal(error.status, 404)
      assert.deepEqual(error.body, { error: 'no_render', id: 'car/volkswagen/passat' })
      assert.match(error.message, /no_render/)
      return true
    }
  )

  const unauthorized = apiFetch(() => ({ status: 401, body: { error: 'unauthorized' } }))
  await assert.rejects(
    () => new VehiclesDB({ apiKey: 'bad', fetch: unauthorized }).images('car/renault/clio'),
    error => error.status === 401 && error.body.error === 'unauthorized'
  )

  const badColor = apiFetch(() => ({
    status: 422,
    body: { error: 'unknown_color', palette: ['white', 'black', 'grey'] }
  }))
  await assert.rejects(
    () => new VehiclesDB({ apiKey: 'k', fetch: badColor }).images('car/renault/clio', { color: 'chartreuse' }),
    error => error.status === 422 && error.body.palette.includes('grey')
  )
})

test('API errors are typed by status and carry the machine-readable code', async () => {
  const cases = [
    [401, { error: 'invalid_token' }, VehiclesDBAuthError, undefined],
    [402, { error: 'insufficient_credits', billing_url: 'https://vehiclesdb.com/billing' }, VehiclesDBPaymentRequiredError, undefined],
    [404, { error: 'no_render', id: 'car/renault/clio' }, VehiclesDBNotFoundError, undefined],
    [429, { error: 'rate_limited', retry_after: 60 }, VehiclesDBRateLimitError, { 'retry-after': '30' }],
    [422, { error: 'unknown_color' }, VehiclesDBApiError, undefined]
  ]
  for (const [status, body, ErrorClass, headers] of cases) {
    const db = new VehiclesDB({ apiKey: 'k', fetch: apiFetch(() => ({ status, body, headers })) })
    await assert.rejects(() => db.images('car/renault/clio'), error => {
      assert.ok(error instanceof ErrorClass, `${status} -> ${error.name}`)
      assert.ok(error instanceof VehiclesDBApiError)
      assert.equal(error.status, status)
      assert.equal(error.code, body.error)
      if (status === 429) assert.equal(error.retryAfter, 30)
      return true
    })
  }
  // No Retry-After header: the body's retry_after is used.
  const db = new VehiclesDB({ apiKey: 'k', fetch: apiFetch(() => ({ status: 429, body: { error: 'rate_limited', retry_after: 60 } })) })
  await assert.rejects(() => db.images('car/renault/clio'), error => error.retryAfter === 60)
})

test('a request that outlives the timeout is a VehiclesDBTimeoutError', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const db = new VehiclesDB({ apiKey: 'k', fetch: hang, timeout: 20 })
  await assert.rejects(() => db.images('car/renault/clio'), error => {
    assert.ok(error instanceof VehiclesDBTimeoutError)
    assert.equal(error.timeout, 20)
    return true
  })
})

test('catalog() filters by kind and country; labels are localized; color() reads Spanish', async () => {
  const { client } = await fixtureClient()
  const all = await client.catalog({ kind: 'car' })
  assert.ok(all.length > 0)
  for (const { make, models } of all) {
    assert.ok(models.length > 0, make.slug)
    for (const m of models) assert.equal(m.kind, 'car')
  }
  const country = all.flatMap(e => e.models).find(m => m.availability.length)?.availability[0]
  const scoped = await client.catalog({ kind: 'car', country: country.toUpperCase() })
  assert.ok(scoped.length > 0)
  for (const { models } of scoped) for (const m of models) assert.ok(m.availability.includes(country))
  assert.deepEqual(await client.catalog({ kinds: [] }), [])

  assert.equal(client.kindLabel('van', { locale: 'es' }), 'Furgoneta')
  assert.equal(client.kindLabel('van'), 'Van')
  assert.equal(client.kindLabel('hovercraft'), null)
  assert.equal(client.bodyTypeLabel('wagon', { locale: 'es-ES' }), 'Familiar')
  assert.deepEqual(client.colorOptions({ locale: 'es' })[0], ['Blanco', 'white'])
  assert.equal(client.colors().length, 14)
  for (const [input, slug] of [['Marrón', 'brown'], ['marron', 'brown'], ['gris', 'grey'], ['GRAY', 'grey'], ['plateado', 'silver'], ['red', 'red']]) {
    assert.equal(client.color(input)?.slug, slug, input)
  }
  assert.equal(client.color('rojo', { locale: 'es' }).name, 'Rojo')
  assert.equal(client.color('chartreuse'), null)
  assert.equal(client.color('constructor'), null)
  assert.equal(client.kindLabel('constructor'), null)
  assert.equal(client.bodyTypeLabel('toString'), null)
  assert.equal((await client.byId('/car/volkswagen/golf/')).id, 'car/volkswagen/golf')
})

test('the timeout also covers a stalled response body', async () => {
  const stall = (url, init) => Promise.resolve({ ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  const db = new VehiclesDB({ apiKey: 'k', fetch: stall, timeout: 20 })
  await assert.rejects(() => db.images('car/renault/clio'), VehiclesDBTimeoutError)
})

test('images() rejects anything that is not a canonical id', async () => {
  const db = new VehiclesDB({ apiKey: 'k', fetch: apiFetch(() => ({ status: 200, body: {} })) })
  for (const bad of ['renault/clio', 'car//clio', 'clio', 'car/renault/clio/extra']) {
    await assert.rejects(() => db.images(bad), VehiclesDBError, bad)
  }
})

// ---------------------------------------------------------------------------
// transport plumbing
// ---------------------------------------------------------------------------

test('a missing fetch fails at call time, not at construction, and names the option', async () => {
  // Simulate a runtime with no global fetch (Node < 18). Tests inside one file
  // run sequentially, so borrowing the global for the length of this one is
  // safe; other test files are separate processes.
  const savedFetch = globalThis.fetch
  try {
    delete globalThis.fetch
    // Constructing must still work — no I/O, and `attribution` has to be
    // readable anywhere.
    const stranded = new VehiclesDB()
    assert.equal(stranded.attribution.license, 'CC-BY-4.0')

    await assert.rejects(() => stranded.makes(), error => {
      assert.ok(error instanceof VehiclesDBConfigError)
      assert.equal(error.option, 'fetch')
      assert.match(error.message, /Node >= 18/)
      return true
    })
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('a shared cache is shared; the default cache is not', async () => {
  const shared = new Map()
  const first = fixtureFetch()
  const second = fixtureFetch()
  await new VehiclesDB({ fetch: first, cache: shared }).makes()
  await new VehiclesDB({ fetch: second, cache: shared }).makes()
  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 0, 'the second client reused the shared download')
})

test('a non-2xx from the CDN carries its status', async () => {
  const fetchImpl = async () => new Response('not found', { status: 404 })
  const db = new VehiclesDB({ fetch: fetchImpl })
  await assert.rejects(() => db.makes(), error => {
    assert.ok(error instanceof VehiclesDBApiError)
    assert.equal(error.status, 404)
    return true
  })
})

test('returned records are frozen, so a caller cannot corrupt the shared index', async () => {
  const { client } = await fixtureClient()
  const golf = (await client.models('VW')).find(m => m.slug === 'golf')
  assert.throws(() => { golf.name = 'Not Golf' }, TypeError)
  assert.equal((await client.models('VW')).find(m => m.slug === 'golf').name, 'Golf')
})

// ---------------------------------------------------------------------------
// attribution
// ---------------------------------------------------------------------------

test('the attribution notice is present, credits VehiclesDB and links CC-BY', async () => {
  const db = new VehiclesDB({ fetch: fixtureFetch() })
  const attribution = db.attribution

  assert.match(String(attribution), /VehiclesDB/)
  assert.match(String(attribution), /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//)
  assert.equal(attribution.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/')
  assert.equal(attribution.license, 'CC-BY-4.0')
  assert.equal(attribution.required, true)

  // The exact snippet the contract and the data repo's README ask for.
  assert.equal(attribution.markdown, 'Vehicle data by [VehiclesDB](https://vehiclesdb.com)')
  assert.equal(attribution.html, '<a href="https://vehiclesdb.com">Vehicle data by VehiclesDB</a>')
  assert.equal(attribution.text, 'Vehicle data by VehiclesDB (vehiclesdb.com)')

  // Upstream register notices are pointed at, never paraphrased.
  assert.match(attribution.upstreamNoticesUrl, /ATTRIBUTION\.md$/)
  assert.match(String(attribution), /ATTRIBUTION\.md/)
})
