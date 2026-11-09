# Changelog

All notable changes to `@vehiclesdb/client` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [Semantic Versioning](https://semver.org/). While the version is
0.x, a minor release may change the API.

## [0.1.0] - 2026-11-09

First public release.

### Added

- `VehiclesDB` client, with zero runtime dependencies, ESM + CJS entry points,
  hand-written TypeScript types and Node >= 18 support.
- **Dataset mode** (default, no key): `makes()`, `models()`, `model()`,
  `resolve()`, `modelMatch()`, `search()` and `datasetVersion()`, answered from
  the published CC-BY dataset on jsDelivr. Releases can be pinned with
  `version`. The dataset is fetched lazily and memoized.
- **API mode**: `images()` for `GET /v1/vehicles/{kind}/{make}/{model}/images`,
  authenticated with `apiKey`.
- Resolution implements the dataset's `RESOLUTION.md` (exact, former_id, fold,
  alias, form, cleaned and fuzzy rungs, with ambiguity, alternates and an audit
  trail), and passes `conformance/resolve.json` from release 2026.11.1.
- `attribution`: the CC-BY 4.0 notice as text, HTML and Markdown.
- Typed errors: `VehiclesDBError`, `VehiclesDBApiError` and
  `VehiclesDBConfigError`.
- `CONTRACT.md`: the cross-language SDK contract shared with the Python SDK
  and the Ruby gem `vehicles`.

[0.1.0]: https://github.com/vehiclesdb/vehiclesdb-js/releases/tag/v0.1.0
