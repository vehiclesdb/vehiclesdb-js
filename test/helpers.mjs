// The offline fixture transport.
//
// Every test in this package is offline BY CONSTRUCTION (CONTRACT.md:
// "no test may touch the network"). The client takes a `fetch`-shaped function,
// so the suite hands it this one, which maps a CDN URL onto a file under
// `fixtures/` and returns a real `Response`.
//
// The important property is the LOUD FAILURE: a URL with no fixture behind it
// throws instead of returning 404 or (worse) falling through to the network. A
// test that silently hits jsDelivr is the exact bug this file exists to
// prevent — it would pass on a laptop, then fail in CI, or pass in CI against
// a release that has since changed.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// test/helpers.mjs -> fixtures/ at the repo root. The Python SDK
// (vehiclesdb/vehiclesdb-python) carries byte-identical fixtures; that shared
// input is what makes JS<->Python parity assertions meaningful.
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** The release the fixtures were cut from. Read, never hardcoded elsewhere. */
export const FIXTURE_VERSION = '2026.07.6'

/**
 * A fetch-shaped function serving `fixtures/`.
 *
 * @returns {Function & {calls: string[]}} the transport; `calls` records every
 *          URL requested, in order, so laziness is assertable.
 */
export function fixtureFetch() {
  const calls = []

  const transport = async (url, init = {}) => {
    calls.push(String(url))

    // Honour an abort signal that is ALREADY aborted, so the client's timeout
    // plumbing is exercised rather than bypassed by the stub.
    if (init.signal && init.signal.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }

    const relative = fixturePathFor(String(url))
    let body
    try {
      body = await readFile(new URL(relative, `file://${FIXTURES_DIR}`), 'utf8')
    } catch (error) {
      throw new Error(
        `fixture transport: ${url} maps to ${relative}, which does not exist under ${FIXTURES_DIR}. ` +
          `Regenerate with tools/make_fixtures.py, or fix the test. (${error.code})`
      )
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }

  transport.calls = calls
  return transport
}

/**
 * Map a dataset URL onto a path under the fixtures root.
 *
 * Matching is on the CDN LAYOUT, not on the host: the fixtures are laid out in
 * exactly the published shape (`manifest.json`, `dist/vehicles.json`,
 * `catalog/{kind}/{makes,models}.json`), so any `datasetBaseUrl` — jsDelivr,
 * a pinned tag, a mirror — resolves the same way.
 */
function fixturePathFor(url) {
  const { pathname } = new URL(url)
  const match = pathname.match(/\/(manifest\.json|dist\/[^/]+|catalog\/[^/]+\/[^/]+)$/)
  if (!match) {
    throw new Error(
      `fixture transport: refusing to serve ${url} — it is not a published dataset path. ` +
        'If a test needs this URL, add a stub for it; do NOT let the suite reach the network.'
    )
  }
  return match[1]
}

/**
 * A transport for the ONE live `/v1` endpoint. Dataset paths still come off
 * disk, so a single client can do both; anything else throws.
 *
 * @param {(url: URL, init: object) => {status:number, body:unknown}} handler
 */
export function apiFetch(handler) {
  const datasetTransport = fixtureFetch()
  const calls = []

  const transport = async (url, init = {}) => {
    const parsed = new URL(String(url))
    if (!parsed.pathname.startsWith('/v1/')) return datasetTransport(url, init)

    calls.push({ url: parsed, init, headers: (init && init.headers) || {} })
    const { status, body } = handler(parsed, init)
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }

  transport.calls = calls
  transport.datasetCalls = datasetTransport.calls
  return transport
}

/** Read a fixture file straight off disk — for asserting against real counts
 *  instead of numbers copied into a test and left to rot. */
export async function readFixture(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, `file://${FIXTURES_DIR}`), 'utf8'))
}

/** A client wired to the fixture transport. Pinning `version` proves the
 *  pinned-release URL shape resolves too. */
export async function fixtureClient(overrides = {}) {
  const { VehiclesDB } = await import('../index.mjs')
  const fetchImpl = overrides.fetch || fixtureFetch()
  const client = new VehiclesDB({ version: FIXTURE_VERSION, ...overrides, fetch: fetchImpl })
  return { client, fetchImpl }
}
