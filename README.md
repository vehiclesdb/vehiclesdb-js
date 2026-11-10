# `@vehiclesdb/client` — vehicle makes, models and canonical ids for JavaScript

[![npm](https://img.shields.io/npm/v/@vehiclesdb/client.svg)](https://www.npmjs.com/package/@vehiclesdb/client)
[![CI](https://github.com/vehiclesdb/vehiclesdb-js/actions/workflows/ci.yml/badge.svg)](https://github.com/vehiclesdb/vehiclesdb-js/actions/workflows/ci.yml)

`@vehiclesdb/client` gives your app the [VehiclesDB](https://vehiclesdb.com)
dataset: makes, models, body types, popularity deciles and per-country
availability, reconciled from official vehicle registers — and, above all, a
**canonical id for every vehicle nameplate**:

```
kind/make_slug/model_slug     e.g.  car/volkswagen/golf
```

That id is the point. It is stable across releases (renamed ids keep working
through `former_ids`), it is what the hosted API is addressed by, and it is
what you should store instead of a free-text `"VW Golf"`.

- **Zero runtime dependencies.** ESM + CJS, typed, no build step.
- **Node >= 18** (global `fetch`) and browsers.
- Reads the published **CC-BY dataset** off jsDelivr — no API key needed for
  anything except imagery.

## Install

```bash
npm i @vehiclesdb/client
```

Also works with `pnpm add`, `yarn add` and `bun add`. There are no runtime
dependencies.

## Sixty seconds

```js
const { VehiclesDB } = require('@vehiclesdb/client')
// or: import { VehiclesDB } from '@vehiclesdb/client'

const db = new VehiclesDB()

await db.makes({ kind: 'car' })
// => [{ id: 'alfa-romeo', slug: 'alfa-romeo', name: 'Alfa Romeo', kinds: ['car'], aliases: ['Alfa'] }, ...]

await db.models('VW', { kind: 'car' })        // alias-aware: "VW" just works
// => [{ id: 'car/volkswagen/golf', name: 'Golf', bodyType: 'hatchback', globalDecile: 2, ... }, ...]

await db.resolve('VW Golf')                   // free text in, one id out
// => { id: 'car/volkswagen/golf', kind: 'car', make: 'Volkswagen', model: 'Golf',
//      method: 'fold', confidence: 0.97, source: 'dataset',
//      via: ['make_alias:vw→volkswagen'], ... }

await db.model('car/volkswagen/golf')         // the full record
// => { ..., bodyTypes: ['hatchback','wagon'], sources: ['de_kba_fz10', ...],
//      availability: [{ country: 'nl', evidence: 'registration', source: 'nl_rdw' }, ...],
//      popularity: { globalDecile: 2, byCountry: { nl: { rank: 1, decile: 1, ... } } } }

await db.search('golf', { limit: 10 })        // ranked — an autocomplete endpoint

db.attribution.markdown                       // sync — 'Vehicle data by [VehiclesDB](https://vehiclesdb.com)'
```

Nothing is fetched when you construct the client. The dataset is pulled once,
lazily, on the first question you ask, and memoized on the instance.

## Two modes

| | dataset mode | API mode |
|---|---|---|
| **Needs a key** | no | yes (`apiKey`) |
| **Where the answer comes from** | the published CC-BY dataset on jsDelivr | `https://vehiclesdb.com/api/v1` |
| **Methods** | `makes` `models` `model` `byId` `successor` `catalog` `resolve` `modelMatch` `search`, labels | `images` |
| **Works offline-ish** | yes — one file, then everything is in memory | no |
| **Freshness** | the release you pinned (or `latest`) | live |

Every method except `images()` answers from the dataset today. `images()` is
API-only — there is no imagery in the open dataset, so it throws a
`VehiclesDBConfigError` naming `apiKey` rather than returning a placeholder.

Methods for API endpoints that have **not shipped** (`stats`, `markets`,
`plates`, `vin`, `resolve/batch`) are deliberately absent. A method that throws
"not implemented yet" is worse than no method: it invites integrations onto
semantics that do not exist.

## The API surface

```js
new VehiclesDB({
  version: 'latest',          // release tag, e.g. '2026.11.1'
  datasetBaseUrl: undefined,  // override the CDN base entirely
  apiBaseUrl: 'https://vehiclesdb.com',
  apiKey: undefined,          // required by images() only
  fetch: globalThis.fetch,    // injectable — this is how you test offline
  timeout: 10000,             // ms; 0 disables
  cache: new Map()            // url -> parsed JSON; share one to share the download
})
```

| method | returns | notes |
|---|---|---|
| `makes({ kind })` | `Make[]` | name-alphabetical; `kind` filters on the make's own `kinds[]` |
| `models(make, { kind, bodyType })` | `Model[]` | alias-aware make lookup; **unknown make ⇒ `[]`, never throws** |
| `model(id)` / `model(kind, make, slug)` | `ModelDetail \| null` | honours `former_ids`; pulls the per-kind catalog |
| `resolve(query, { kind, kinds, country })` | `Resolution \| null` | free text; the resolution ladder below |
| `modelMatch(make, model, { kind, kinds, country })` | `Resolution \| null` | a make/model pair, e.g. two columns of a spreadsheet |
| `search(query, { kind, limit })` | `Model[]` | ranked; deterministic |
| `byId(id, { follow, kinds })` | `Model \| null` | one dataset fetch; follows former ids unless `follow: false` |
| `successor(id)` | `string \| null` | the live id for a stored id (itself, its successor, or `null`) |
| `catalog({ kind, kinds, country })` | `{ make, models }[]` | picker data, name-ordered; `country` keeps models with register evidence there |
| `colors({ locale })` / `colorOptions({ locale })` | palette | 14 canonical colours; `en` or `es` names |
| `color(query, { locale })` | `Color \| null` | slug or English/Spanish name: `'gris'`, `'Marrón'`, `'navy'` |
| `kindLabel(kind, { locale })` / `bodyTypeLabel(type, { locale })` | `string \| null` | `'Furgoneta'`, `'Familiar'` |
| `images(id, { color, format })` | the endpoint's JSON | API only |
| `attribution` | `Attribution` | the CC-BY notice, programmatically |
| `datasetVersion()` | `string` | e.g. `'2026.11.1'` — cite it |

### Resolving free text to an id

`resolve()` and `modelMatch()` implement the published
[resolution contract](https://github.com/vehiclesdb/vehiclesdb/blob/main/RESOLUTION.md)
and pass its conformance suite. They use only published data: names, aliases,
former ids and curated spellings. Each answer says which rung matched
(`method`), a rung label (`confidence`) and how it got there (`via`).

```js
await db.resolve('car/volkswagen/golf')    // method 'exact',  confidence 1
await db.resolve('mercedes c class')       // 'car/mercedes-benz/c-class', 'fold', 0.97
                                           //   via ['make_alias:mercedes→mercedes-benz']
await db.resolve('Peugeot 2008 Allure')    // 'car/peugeot/2008', 'form', 0.92
                                           //   via ['form:2008 allure→2008']
await db.resolve('Volkswagon Golf')        // 'car/volkswagen/golf', 'fuzzy', 0.8
                                           //   via ['make_typo:volkswagon→volkswagen']
await db.modelMatch('BMW', 'Serie 3')      // 'car/bmw/3-series', 'fold', 0.97
await db.resolve('golf')                   // null: no make, and the name alone is not unique
```

The ladder is `exact` (1.00) → `former_id` (0.98) → `fold` (0.97) → `alias`
(0.93) → `form` (0.92) → `alias` (0.90) → `cleaned` (0.90) → `fuzzy` (0.80).
Confidences label rungs. They are not probabilities. When two records fit
equally well, the answer is not guessed: the result has `ambiguous: true`, a
null `id` and the competing records in `alternates`. When nothing matches, the
answer is `null`. The full rules are in [`CONTRACT.md`](./CONTRACT.md#resolution).

`confident` is `true` when the answer is neither ambiguous nor a typo guess —
the recommended bar for rewriting stored data without a human.

**Kinds.** Some nameplates are published in several kinds (the Iveco Daily is a
bus, a truck and a van). Without a kind, every VehiclesDB surface picks the
same one: lowest `mass_decile`, then van, car, bus, truck, moped, motorcycle
([RESOLUTION.md §3a](https://github.com/vehiclesdb/vehiclesdb/blob/main/RESOLUTION.md)).
Say what you mean when you know it:

```js
await db.resolve('Iveco Daily')                       // 'van/iveco/daily'
await db.resolve('Iveco Daily', { kind: 'truck' })    // 'truck/iveco/daily'
await db.resolve('bus/iveco/daily', { kinds: ['car'] }) // null: kinds is a hard filter, ids included
```

**Stored ids.** Store `id`. When a release renames a record, its old id
becomes a `former_id` of the new one; `successor(oldId)` gives you the id to
store now, and `byId(oldId)` the record.

```js
await db.successor('car/alfa-romeo/1750gtv')   // 'car/alfa-romeo/1750-gtv'
```

### `search()` ranking

A model is scored by the first tier that matches, then ties break on
`globalDecile` ascending (1 = most popular, `null` last), then name, then id.
Fully deterministic and locale-independent (no `localeCompare`).

1. the model's name **equals** the query
2. the name **starts with** the query
3. the name **contains** the query
4. `"Make Name"` contains the query — so `search('volkswagen golf')` works

## Record shapes

Field names are camelCased (`bodyType`, `formerIds`, `globalDecile`); nothing is
renamed, dropped or invented beyond that. Every field is documented in the data
repo's [`SCHEMA.md`](https://github.com/vehiclesdb/vehiclesdb/blob/main/SCHEMA.md).

Two coercions, both matching the Ruby gem so the SDKs answer alike: absent
array-valued optionals become `[]`, absent scalars become `null`. Per the
schema's binding **absence rule**, absent means *"not catalogued yet"* — never
*"no"*. Code against the value, not against a release.

### `models()`/`search()` vs `model()`

They read two different published files, so they carry different depth:

| | `models()`, `search()` (`dist/vehicles.json`) | `model()` (`catalog/{kind}/models.json`) |
|---|---|---|
| `bodyType` | `'hatchback'` | `'hatchback'` |
| `bodyTypes` | — | `['hatchback', 'wagon']` |
| `globalDecile` | `2` | `2` |
| `popularity` | — | `{ globalDecile, byCountry: { nl: { rank, decile, confidence } } }` |
| `sources`, `xrefs` | — | present |
| ⚠️ `availability` | `['nl', 'gb']` | `[{ country: 'nl', evidence: 'registration', source: 'nl_rdw' }]` |

`availability` is the one field whose **shape** differs, and it is deliberate:
those are the two files' own published shapes, and giving either a new name
would put a vocabulary in the world that the dataset does not use. They agree by
construction — `model(id).availability.map(a => a.country)` is exactly the light
form.

`Make` has no `countries` in dataset mode: that field lives only in
`catalog/{kind}/makes.json`, and `makes()` is contractually a **single** fetch of
the light dataset.

## Pinning a release

```js
new VehiclesDB()                            // https://cdn.jsdelivr.net/gh/vehiclesdb/vehiclesdb@latest
new VehiclesDB({ version: '2026.11.1' })    // ...@2026.11.1
```

`latest` follows the newest release tag, which is what you want for a picker
that should quietly gain new makes. **Pin** when an answer has to be
reproducible: a test suite asserting exact orderings, a cached export, a
research dataset you are citing, or anything where a model appearing overnight
would be a regression rather than an improvement. `datasetVersion()` tells you
which release actually answered.

The default base is the same one the published Ruby gem refreshes from
(`vehicles/lib/vehicles/configuration.rb`), so Ruby and JavaScript can never
disagree about what "the dataset" is.

## Errors

```js
const { VehiclesDBError, VehiclesDBApiError, VehiclesDBAuthError, VehiclesDBPaymentRequiredError,
  VehiclesDBRateLimitError, VehiclesDBNotFoundError, VehiclesDBTimeoutError,
  VehiclesDBConfigError } = require('@vehiclesdb/client')
```

- `VehiclesDBConfigError` — a required option is missing; `.option` names it
  (`'apiKey'`, `'fetch'`).
- `VehiclesDBApiError` — any non-2xx, from the CDN or from the API. Carries
  `.status`, the server's own parsed `.body`, and `.code` (the body's `error`
  string, e.g. `'no_render'`, `'unknown_color'`). Subclasses for the statuses
  you handle differently:
  - `VehiclesDBAuthError` — 401/403: missing, invalid or revoked key, or a
    publishable key used from a site it is not allowed on.
  - `VehiclesDBPaymentRequiredError` — 402 `insufficient_credits`: the wallet
    is empty; `.body.billing_url` says where to top up.
  - `VehiclesDBRateLimitError` — 429 `rate_limited`; `.retryAfter` in seconds.
  - `VehiclesDBNotFoundError` — 404 (`not_found`; for images `unknown_model`
    when the id is not in the API's dataset, `no_render` when the vehicle has
    no render yet, `color_not_rendered` with `fallback=none`; read `.code`).
- `VehiclesDBTimeoutError` — no response within `timeout` ms (`.timeout`, `.url`).
- `VehiclesDBError` — the base class, and what any other network failure
  becomes (with the original error as `.cause`).

```js
try {
  await db.images('car/volkswagen/passat')
} catch (error) {
  if (error instanceof VehiclesDBNotFoundError) {
    // no render for this model yet — show your placeholder
  } else if (error instanceof VehiclesDBAuthError || error instanceof VehiclesDBPaymentRequiredError) {
    // alert someone: every image call will fail until the key or wallet is fixed
  } else throw error
}
```

## Imagery (`images()`)

`GET /api/v1/vehicles/{kind}/{make}/{model}/images`. Mint a key at
<https://vehiclesdb.com/settings/api-keys>. (0.1.0 called `/v1/...`, which is
not the API's path; upgrade.)

```js
const db = new VehiclesDB({ apiKey: process.env.VEHICLESDB_API_KEY })
const payload = await db.images('car/renault/clio', { color: 'blue' })
payload.variants.lg.url        // signed, key-free — safe in <img src>
payload.color                  // what was actually SERVED
payload.requested_color        // what you asked for; compare to detect a fallback
```

The response is returned **verbatim**, snake_case and all. Everything else in
this package is camelCased, but this one payload is a shipped wire contract
documented at <https://vehiclesdb.com/api>, and a second vocabulary for it would
just make the SDK and the OpenAPI spec disagree.

`year` and `trim` are not accepted: the endpoint 422s them today so that no
integration builds on unimplemented semantics, and forwarding them would defeat
that.

## Testing your own code

`fetch` is injectable, which is how this package's own suite stays offline —
no test may touch the network.

```js
const db = new VehiclesDB({
  fetch: async (url) => new Response(await readFile(fixturePathFor(url)), { status: 200 })
})
```

Make your stub **throw** on a URL it has no fixture for. A stub that falls
through to the network gives you a suite that passes on a laptop and fails in
CI — or worse, one that passes against a release that has since changed.

## Development

This package's own suite runs with `npm test` (Node's built-in runner, no test
dependency), offline, against `fixtures/`: a verbatim subset of a real release
cut by `tools/make_fixtures.py`. Two opt-in layers point the same seam at a
full release of the [dataset](https://github.com/vehiclesdb/vehiclesdb) on
disk. They skip, naming the path they wanted, when it is absent:

```bash
git clone https://github.com/vehiclesdb/vehiclesdb ../vehiclesdb
npm test                                    # + full release and conformance from ../vehiclesdb

VDB_DATA_REPO=/path/to/vehiclesdb \
VDB_DATA=/path/to/vehiclesdb/dist/vehicles.json \
VDB_CONFORMANCE=/path/to/vehiclesdb/conformance/resolve.json npm test
```

Cross-language parity with the Python SDK is checked by
`tools/parity_check.sh`, with
[vehiclesdb-python](https://github.com/vehiclesdb/vehiclesdb-python) checked
out next to this repo. See [`CONTRACT.md`](./CONTRACT.md).

## License & attribution (required)

**Code:** MIT — see [`LICENSE`](./LICENSE). The data notice is in [`NOTICE`](./NOTICE).

**Data:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), free for any
use including commercial. **Visible credit with a link is a condition of the
licence** (§3(a)), not a courtesy:

> Vehicle data by [VehiclesDB](https://vehiclesdb.com)

- **Website** → a followable link, e.g. in your footer:
  `<a href="https://vehiclesdb.com">Vehicle data by VehiclesDB</a>`
- **App or anything without a website** → name it visibly in the app description
  or an about/credits screen: *"Vehicle data by VehiclesDB (vehiclesdb.com)"*
- **Research / datasets** → cite the repo and the dataset version
  (`await db.datasetVersion()`).

The notice is exposed programmatically so you can render it without copying
prose:

```js
db.attribution.markdown           // 'Vehicle data by [VehiclesDB](https://vehiclesdb.com)'
db.attribution.html               // '<a href="https://vehiclesdb.com">Vehicle data by VehiclesDB</a>'
db.attribution.text               // 'Vehicle data by VehiclesDB (vehiclesdb.com)'
String(db.attribution)            // credit + licence + upstream-notices pointer
db.attribution.licenseUrl         // 'https://creativecommons.org/licenses/by/4.0/'
```

Upstream **register notices** (KBA's `dl-de/by-2-0`, RDW's terms, Traficom's
CC-BY, …) apply under **every** licence, the commercial one included — they are
the registers' own terms, not VehiclesDB's to waive. See
[`ATTRIBUTION.md`](https://github.com/vehiclesdb/vehiclesdb/blob/main/ATTRIBUTION.md)
(`db.attribution.upstreamNoticesUrl`). Never paraphrase a licence statement;
point at it.

Prefer not to credit VehiclesDB? That is the commercial licence →
[vehiclesdb.com](https://vehiclesdb.com).

## Related

- [`vehicles`](https://github.com/vehiclesdb/vehicles) — the Ruby gem, the
  reference implementation, published and bundled-offline.
- [`vehiclesdb`](https://pypi.org/project/vehiclesdb/) — the Python SDK
  ([repo](https://github.com/vehiclesdb/vehiclesdb-python)), same contract.
- [`vehiclesdb/vehiclesdb`](https://github.com/vehiclesdb/vehiclesdb) — the
  open dataset itself (`SCHEMA.md`, `RESOLUTION.md`, `ATTRIBUTION.md`).
- [`make-model-dropdown`](https://github.com/vehiclesdb/make-model-dropdown) —
  the browser make → model picker; same resolution contract, offline dataset
  mode, a hidden id field, and an ES module for importmaps.
- [`CONTRACT.md`](./CONTRACT.md) — what every VehiclesDB SDK promises.
- [`CHANGELOG.md`](./CHANGELOG.md)
