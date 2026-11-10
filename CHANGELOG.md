# Changelog

All notable changes to `@vehiclesdb/client` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [Semantic Versioning](https://semver.org/). While the version is
0.x, a minor release may change the API.

## [0.2.0] - unreleased

Dogfooding fixes (VehiclesDB inside CarHey, 2026-11-10). The API changed, hence
the minor bump.

### Fixed

- `images()` now calls `GET /api/v1/vehicles/{kind}/{make}/{model}/images`.
  0.1.0 called `/v1/...`, which the API does not serve, so every image call
  failed.

### Changed

- **Kind collisions** follow RESOLUTION.md §3a, the rule every VehiclesDB
  surface now shares: when one nameplate answers in several kinds, pick the
  lowest `mass_decile`, then van, car, bus, truck, moped, motorcycle, then id.
  Unhinted "Iveco Daily" is now `van/iveco/daily` (was `truck/iveco/daily`).
- Non-2xx API responses throw typed subclasses of `VehiclesDBApiError`:
  `VehiclesDBAuthError` (401/403), `VehiclesDBPaymentRequiredError` (402),
  `VehiclesDBNotFoundError` (404) and `VehiclesDBRateLimitError` (429, with
  `retryAfter`). Every API error carries `code` (the body's `error`). A timeout
  throws `VehiclesDBTimeoutError`. All remain `VehiclesDBApiError` /
  `VehiclesDBError`, so existing `catch` blocks keep working.

### Added

- `byId(id, { follow, kinds })` and `successor(id)` for stored ids.
- `Resolution.confident`: not ambiguous and not a typo guess.
- `kinds` option on `resolve()`/`modelMatch()`/`byId()`/`catalog()`: a hard
  kind filter on every rung, ids included.
- `catalog({ kind, kinds, country })`: picker data for one market.
- `colors()`, `colorOptions()`, `color()`, `kindLabel()`, `bodyTypeLabel()`
  with English and Spanish labels (`color('gris')` → grey).
- Model fields `massDecile` and `registrationYears` (a hint: first and last
  first-registration year; `null` until the release publishes it). Make field
  `formerSlugs`, and make resolution follows it (`former_make_slug:` in `via`).
- `KIND_PRECEDENCE` export.

## [0.1.0] - 2026-11-09

First public release.

### Added

- `VehiclesDB` client, with zero runtime dependencies, ESM + CJS entry points,
  hand-written TypeScript types and Node >= 18 support.
- **Dataset mode** (default, no key): `makes()`, `models()`, `model()`,
  `resolve()`, `modelMatch()`, `search()` and `datasetVersion()`, answered from
  the published CC-BY dataset on jsDelivr. Releases can be pinned with
  `version`. The dataset is fetched lazily and memoized.
- **API mode**: `images()` (0.1.0 called the wrong path; fixed in 0.2.0),
  authenticated with `apiKey`.
- Resolution implements the dataset's `RESOLUTION.md` (exact, former_id, fold,
  alias, form, cleaned and fuzzy rungs, with ambiguity, alternates and an audit
  trail), and passes `conformance/resolve.json` from release 2026.11.1.
- `attribution`: the CC-BY 4.0 notice as text, HTML and Markdown.
- Typed errors: `VehiclesDBError`, `VehiclesDBApiError` and
  `VehiclesDBConfigError`.
- `CONTRACT.md`: the cross-language SDK contract shared with the Python SDK
  and the Ruby gem `vehicles`.

[0.2.0]: https://github.com/vehiclesdb/vehiclesdb-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vehiclesdb/vehiclesdb-js/releases/tag/v0.1.0
