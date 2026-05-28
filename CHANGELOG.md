# Changelog

## [0.9.0](https://github.com/chrischall/compass-mcp/compare/v0.8.0...v0.9.0) (2026-05-28)


### Features

* **resolve:** add search-fallback rung (closes [#71](https://github.com/chrischall/compass-mcp/issues/71)) ([#74](https://github.com/chrischall/compass-mcp/issues/74)) ([3658ac2](https://github.com/chrischall/compass-mcp/commit/3658ac2232cab3de3b359a37565d01dd3086b3cf))


### Bug Fixes

* **resolve:** bulk should run same rungs as single (closes [#67](https://github.com/chrischall/compass-mcp/issues/67)) ([#68](https://github.com/chrischall/compass-mcp/issues/68)) ([f5c3f12](https://github.com/chrischall/compass-mcp/commit/f5c3f124768fe77c04e750fa70cac14bb72cb2cc))

## [0.8.0](https://github.com/chrischall/compass-mcp/compare/v0.7.0...v0.8.0) (2026-05-27)


### Features

* **batching:** compass_bulk_get + compass_resolve_addresses ([#59](https://github.com/chrischall/compass-mcp/issues/59)) ([ec9d13e](https://github.com/chrischall/compass-mcp/commit/ec9d13efdd53ebe1b13ee93eb5c746ef69df371c))
* comparable rentals tool + surface listing_agent on every property ([#62](https://github.com/chrischall/compass-mcp/issues/62)) ([83054b9](https://github.com/chrischall/compass-mcp/commit/83054b9f99187221c11a07ade6c1aced024e1ecb))
* **history:** events_normalized + document search MAX_PAGES cap ([#61](https://github.com/chrischall/compass-mcp/issues/61)) ([ee90f66](https://github.com/chrischall/compass-mcp/commit/ee90f6642bc727cd3c466135077a481d1ee477d3))
* lazy-revive bridge + raise compare cap 8-&gt;25 ([#63](https://github.com/chrischall/compass-mcp/issues/63)) ([465608e](https://github.com/chrischall/compass-mcp/commit/465608e501e6e86df4ac159a7f8cf07cfc77414f))
* **p0:** default include_description=false + server-side extracted_features ([#56](https://github.com/chrischall/compass-mcp/issues/56)) ([d2e066f](https://github.com/chrischall/compass-mcp/commit/d2e066f00fd98e89f28ed59e4ba03190f10ffc5f))
* **p1:** derived schema fields + tax cleanup + compare summary opt-in ([#58](https://github.com/chrischall/compass-mcp/issues/58)) ([be75674](https://github.com/chrischall/compass-mcp/commit/be75674a5c16ad15c6efd5d995f87d69ca38a383))
* **session:** multi-session scaffolding + compass_get_session_context ([#60](https://github.com/chrischall/compass-mcp/issues/60)) ([05da709](https://github.com/chrischall/compass-mcp/commit/05da70930b9040163a48bd895b1fcdfe77872cc7))
* **transport-fetchproxy,healthcheck:** adopt @fetchproxy/server 0.8.0 + surface bridge hints ([#66](https://github.com/chrischall/compass-mcp/issues/66)) ([d3c271d](https://github.com/chrischall/compass-mcp/commit/d3c271dfbdfee9e7d88bf3e9e7d59e395039e14a))


### Bug Fixes

* **by-address:** verify candidate address matches query before resolving ([#55](https://github.com/chrischall/compass-mcp/issues/55)) ([a253389](https://github.com/chrischall/compass-mcp/commit/a253389ca98f86c918c88023a0c1bab1f32366a6))
* **p0:** drop bare "with exceptions" from FURNISHED_PARTIAL_RE ([#64](https://github.com/chrischall/compass-mcp/issues/64)) ([1d7e606](https://github.com/chrischall/compass-mcp/commit/1d7e606d825af131c718c71ef7bb65e2e3a05fb0))

## [0.7.0](https://github.com/chrischall/compass-mcp/compare/v0.6.2...v0.7.0) (2026-05-26)


### Features

* **by-address:** add compass_get_by_address resolver ([#31](https://github.com/chrischall/compass-mcp/issues/31)) ([35a16e3](https://github.com/chrischall/compass-mcp/commit/35a16e3d45a3aa3f11c4a495b6bf63c103734c60)), closes [#27](https://github.com/chrischall/compass-mcp/issues/27)
* **properties:** resolve listing_id_sha internally via site search ([#30](https://github.com/chrischall/compass-mcp/issues/30)) ([0c41dba](https://github.com/chrischall/compass-mcp/commit/0c41dbaafe4c8ae6559d53121972fefd5e2d5116))
* **search:** add offset/limit pagination across Compass page batches ([#29](https://github.com/chrischall/compass-mcp/issues/29)) ([84bf1e7](https://github.com/chrischall/compass-mcp/commit/84bf1e79a35a09fb9736126efa00a2fdd19e2379))

## [0.6.2](https://github.com/chrischall/compass-mcp/compare/v0.6.1...v0.6.2) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#23](https://github.com/chrischall/compass-mcp/issues/23)) ([0780983](https://github.com/chrischall/compass-mcp/commit/07809831828153fe037ff5cb92d9b6049662857b))

## [0.6.1](https://github.com/chrischall/compass-mcp/compare/v0.6.0...v0.6.1) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#20](https://github.com/chrischall/compass-mcp/issues/20)) ([c3e7c04](https://github.com/chrischall/compass-mcp/commit/c3e7c0406902d2e39dd58c5c0503dc60b8b0ef06))

## [0.6.0](https://github.com/chrischall/compass-mcp/compare/v0.5.0...v0.6.0) (2026-05-25)


### Features

* **transport:** typed FetchproxyBridgeDownError + bridge freshness diagnostics ([#14](https://github.com/chrischall/compass-mcp/issues/14)) ([793c41c](https://github.com/chrischall/compass-mcp/commit/793c41ce70bd50ad2b61bb655c240bf9c7f86567))


### Bug Fixes

* **properties:** reject listing_id_sha-only calls with an actionable error ([#13](https://github.com/chrischall/compass-mcp/issues/13)) ([9dfc01a](https://github.com/chrischall/compass-mcp/commit/9dfc01a12f043c3bea2f019bc0f2d3f2e0f0c166))

## [0.5.0](https://github.com/chrischall/compass-mcp/compare/v0.4.3...v0.5.0) (2026-05-25)


### Features

* **diagnostics:** bridge role + richer timeout + compass_healthcheck tool ([#9](https://github.com/chrischall/compass-mcp/issues/9)) ([42b4b5f](https://github.com/chrischall/compass-mcp/commit/42b4b5f4a0aff289269cf17df256025797151db7))

## [0.4.3](https://github.com/chrischall/compass-mcp/compare/v0.4.2...v0.4.3) (2026-05-25)


### Bug Fixes

* **transport:** 30s per-request timeout on fetchproxy bridge ([#7](https://github.com/chrischall/compass-mcp/issues/7)) ([c94b39c](https://github.com/chrischall/compass-mcp/commit/c94b39c90800fc1adc7785fd5e5709ccf7a2af6d))

## [0.4.2](https://github.com/chrischall/compass-mcp/compare/v0.4.1...v0.4.2) (2026-05-24)


### Bug Fixes

* **ci:** replace redfin leftovers in release-please publish steps ([#5](https://github.com/chrischall/compass-mcp/issues/5)) ([90e8f09](https://github.com/chrischall/compass-mcp/commit/90e8f09cf5522a8bab0f1afe4ca9519e20b1f44e))

## 0.4.1 (2026-05-24)


### Features

* initial compass-mcp scaffold ([e97dcd5](https://github.com/chrischall/compass-mcp/commit/e97dcd596b87788700642e5140c3d78e74122663))


### Documentation

* canonical auto-merge guidance + softer fetchproxy framing ([#4](https://github.com/chrischall/compass-mcp/issues/4)) ([d851b31](https://github.com/chrischall/compass-mcp/commit/d851b3150f8620d6e8ed78c23f10892644ae7826))


### Chores

* align manifest with npm-published 0.4.0 ([#3](https://github.com/chrischall/compass-mcp/issues/3)) ([23274b1](https://github.com/chrischall/compass-mcp/commit/23274b16418234dade9a74ca5b827fd33e5f893a))
