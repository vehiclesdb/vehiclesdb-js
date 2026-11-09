// Opt-in: run the client against a FULL published release, not the fixture.
//
//     VDB_DATA_REPO=../vehiclesdb node --test test/
//
// Why this exists on top of the fixture suite: `fixtures/` is 12 makes and
// 289 models, capped by `tools/make_fixtures.py`. Passing against it proves
// the logic; it does not prove the client survives the real thing — 1,111 makes,
// 15,677 models, six kinds, models whose names collide across makes, and a
// `dist/vehicles.json` two orders of magnitude larger. This file points the same
// injected-transport seam at a real data-repo checkout on disk.
//
// Still offline: it reads local files, never the CDN, and throws on any URL
// outside the base it was given.
//
// It SKIPS (loudly, naming the path it wanted) when no checkout is present,
// which is the correct behaviour for a repo that does not vendor a 4.9 MB
// dataset — a test that silently passes because it found nothing to test is
// worse than one that is not there.
//
// The Python SDK carries the mirror of this file
// (vehiclesdb/vehiclesdb-python, `tests/test_full_release.py`); the assertions are deliberately
// the same ones, because "the SDKs must agree" is only checkable if both are
// checked against the same release.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { VehiclesDB } from '../index.mjs'

// Defaults to a checkout of github.com/vehiclesdb/vehiclesdb next to this
// repo; override with VDB_DATA_REPO when your checkout lives elsewhere.
const DATA_REPO = expandHome(process.env.VDB_DATA_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vehiclesdb'))
const DIST_PATH = path.join(DATA_REPO, 'dist', 'vehicles.json')
const MANIFEST_PATH = path.join(DATA_REPO, 'manifest.json')

const BASE = 'https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@latest'

const SKIP_REASON =
  `no published release at ${DIST_PATH} — set VDB_DATA_REPO to a data-repo checkout ` +
  'to run the full-release checks (SKIPPED, not silently passed)'

const available = existsSync(DIST_PATH) && existsSync(MANIFEST_PATH)

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/**
 * Serve the CDN layout out of a data-repo checkout.
 *
 * The client builds `<base>/dist/vehicles.json` and
 * `<base>/catalog/{kind}/models.json`; a data-repo checkout has exactly those
 * paths at its root, so the mapping is a prefix strip and nothing else. Any
 * other URL is a bug in the client or in this file — throw, never fall through
 * to the network.
 */
async function localTransport(url) {
  const asString = String(url)
  if (!asString.startsWith(BASE + '/')) {
    throw new Error(`unexpected URL ${asString} — this test must never leave the disk`)
  }
  const file = path.join(DATA_REPO, asString.slice(BASE.length + 1))
  return new Response(await readFile(file), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const client = () => new VehiclesDB({ fetch: localTransport })
const manifest = async () => JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))

test('full release: make counts match manifest.json', { skip: available ? false : SKIP_REASON }, async () => {
  // manifest.json is emitted by the release build; if the client's own view of the
  // release disagrees with it, one of the two is reading it wrong. This is the
  // single check most likely to catch a real drift.
  const db = client()
  for (const [kind, counts] of Object.entries((await manifest()).kinds)) {
    assert.equal(
      (await db.makes({ kind })).length,
      counts.makes,
      `make count for kind ${kind} disagrees with manifest.json`
    )
  }
})

test('full release: model counts match manifest.json', { skip: available ? false : SKIP_REASON }, async () => {
  const db = client()
  for (const [kind, counts] of Object.entries((await manifest()).kinds)) {
    let total = 0
    for (const make of await db.makes({ kind })) {
      total += (await db.models(make.slug, { kind })).length
    }
    assert.equal(total, counts.models, `model count for kind ${kind} disagrees with manifest.json`)
  }
})

test('full release: the resolve ladder, one case per rung', { skip: available ? false : SKIP_REASON }, async () => {
  // The interesting risk at 15,677 records is not "does a rung fire" — the
  // fixture suite settles that — it is "does a rung fire on the WRONG record"
  // once there are thousands of near-neighbours to collide with.
  const db = client()
  const cases = [
    ['car/volkswagen/golf', 'car/volkswagen/golf', 'exact'],
    ['Citroën C3', 'car/citroen/c3', 'fold'],
    ['car/alfa-romeo/1750gtv', 'car/alfa-romeo/1750-gtv', 'former_id'],
    // The human shape of the same promise (rung 4b).
  ]
  for (const [query, expectedId, expectedRung] of cases) {
    const hit = await db.resolve(query)
    assert.ok(hit, `resolve(${JSON.stringify(query)}) found nothing in the full release`)
    assert.equal(hit.id, expectedId, `resolve(${JSON.stringify(query)})`)
    assert.equal(hit.matchedOn, expectedRung, `resolve(${JSON.stringify(query)}) rung`)
  }
})

test('full release: misses are still null', { skip: available ? false : SKIP_REASON }, async () => {
  // A bigger corpus means more chances to match something by accident.
  const db = client()
  assert.equal(await db.resolve('delorean dmc-12'), null)
  for (const query of ['nope nope', 'qqqqq zzzzz']) {
    assert.equal(await db.resolve(query), null, `resolve(${JSON.stringify(query)}) invented a match`)
  }
})

test('full release: rung 3 refuses the Rabbit collision', { skip: available ? false : SKIP_REASON }, async () => {
  // The real half of the corpus-dependence documented in client.test.mjs:
  // here `car/volkswagen/rabbit` exists alongside the "Rabbit" alias on
  // `car/volkswagen/golf`, so the string names two records and rung 3 must
  // refuse. On the capped fixture only the alias survives and it resolves —
  // both are correct, and this pair is what proves the guard is doing the
  // deciding rather than the corpus doing it by accident.
  const db = client()
  assert.equal(await db.resolve('Rabbit'), null)
  // Naming the make disambiguates it, above this rung.
  assert.equal((await db.resolve('vw rabbit')).id, 'car/volkswagen/rabbit')
  assert.equal((await db.resolve('vw golf')).id, 'car/volkswagen/golf')
})

test('full release: model() round-trips from dist to catalog', { skip: available ? false : SKIP_REASON }, async () => {
  // dist/ gives the compact record; catalog/ gives sources + per-country
  // popularity. The id must survive the hop between the two files.
  const db = client()
  const model = await db.model('car/ford/mustang-mach-e')
  assert.ok(model)
  assert.equal(model.name, 'Mustang Mach-E')
  // KBA FZ 10 evidences it in Germany. `availability` is the catalog's
  // evidence rows on a full record, so compare on `.country`.
  assert.ok(model.availability.some(row => row.country === 'de'))
})
