'use strict'

// The dual-package suite: prove the `require` doorway and the `import` doorway
// expose the SAME surface and give the SAME answers.
//
// This is not ceremony. A dual package is the classic place for a "dual package
// hazard" — two copies of the implementation, two `instanceof` identities, two
// subtly different `resolve()`s. `index.mjs` is a thin re-export of
// `index.cjs` precisely so that cannot happen, and these tests are what keeps
// it that way.
//
// The helpers are ESM (they use `import.meta.url` to find the fixtures), so
// they are pulled in with a dynamic `import()` — which is exactly the mixed
// world a real CJS consumer lives in.

const test = require('node:test')
const assert = require('node:assert/strict')

const cjs = require('../index.cjs')

const helpers = import('./helpers.mjs')
const esm = import('../index.mjs')

test('the CJS entry point exports the documented surface', () => {
  assert.deepEqual(
    Object.keys(cjs).sort(),
    ['ATTRIBUTION', 'VehiclesDB', 'VehiclesDBApiError', 'VehiclesDBConfigError', 'VehiclesDBError', 'normalize']
  )
  assert.equal(typeof cjs.VehiclesDB, 'function')
  for (const method of ['makes', 'models', 'model', 'resolve', 'search', 'images', 'datasetVersion']) {
    assert.equal(typeof cjs.VehiclesDB.prototype[method], 'function', method)
  }
  // Endpoints that have not shipped must NOT be here — a method that throws
  // "not implemented yet" invites integrations onto semantics we do not have.
  for (const absent of ['stats', 'markets', 'plates', 'vin', 'resolveBatch']) {
    assert.equal(cjs.VehiclesDB.prototype[absent], undefined, absent)
  }
})

test('require() and import() are the same objects, not two copies', async () => {
  const mjs = await esm
  assert.equal(mjs.VehiclesDB, cjs.VehiclesDB)
  assert.equal(mjs.VehiclesDBApiError, cjs.VehiclesDBApiError)
  assert.equal(mjs.VehiclesDBConfigError, cjs.VehiclesDBConfigError)
  assert.equal(mjs.VehiclesDBError, cjs.VehiclesDBError)
  assert.equal(mjs.ATTRIBUTION, cjs.ATTRIBUTION)
  assert.equal(mjs.normalize, cjs.normalize)
  assert.equal(mjs.default, cjs)

  // Same class identity => `instanceof` works across the boundary, which is the
  // thing that silently breaks when a dual package ships two implementations.
  const { fixtureFetch } = await helpers
  const db = new mjs.VehiclesDB({ fetch: fixtureFetch() })
  assert.ok(db instanceof cjs.VehiclesDB)
})

test('both entry points agree on a sample of real answers', async () => {
  const { fixtureFetch, FIXTURE_VERSION } = await helpers
  const mjs = await esm

  const fromCjs = new cjs.VehiclesDB({ version: FIXTURE_VERSION, fetch: fixtureFetch() })
  const fromEsm = new mjs.VehiclesDB({ version: FIXTURE_VERSION, fetch: fixtureFetch() })

  const ask = async db => ({
    version: await db.datasetVersion(),
    makes: (await db.makes({ kind: 'car' })).map(m => m.id),
    models: (await db.models('VW', { kind: 'car' })).map(m => m.id),
    model: await db.model('car/alfa-romeo/1750gtv'),
    resolve: await db.resolve('VW Golf'),
    resolveFormer: await db.resolve('car/tesla/y'),
    search: (await db.search('c3')).map(m => m.id),
    attribution: db.attribution.markdown
  })

  const a = await ask(fromCjs)
  const b = await ask(fromEsm)
  assert.deepEqual(a, b)

  // Spot-check the values themselves, so this test fails loudly if BOTH
  // doorways regress together.
  assert.equal(a.version, FIXTURE_VERSION)
  assert.equal(a.model.id, 'car/alfa-romeo/1750-gtv')
  assert.equal(a.resolve.id, 'car/volkswagen/golf')
  assert.equal(a.resolve.matchedOn, 'fold')
  assert.equal(a.resolveFormer.matchedOn, 'former_id')
  assert.deepEqual(a.search, ['car/citroen/c3', 'moped/aixam/c3', 'car/citroen/c3-aircross'])
  assert.equal(a.attribution, 'Vehicle data by [VehiclesDB](https://vehiclesdb.com)')
})

test('the CJS default dataset base is the one the Ruby gem refreshes from', () => {
  const db = new cjs.VehiclesDB()
  // vehicles/lib/vehicles/configuration.rb:72 —
  // "https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@latest/dist/vehicles.json"
  assert.equal(db.datasetBaseUrl, 'https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@latest')
  assert.equal(db.apiBaseUrl, 'https://vehiclesdb.com')
  assert.equal(db.version, 'latest')
  assert.equal(db.apiKey, null)
  assert.equal(db.timeout, 10000)
})
