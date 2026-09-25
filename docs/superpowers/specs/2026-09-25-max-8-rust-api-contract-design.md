# MAX-8: Rust API contract and generated TypeScript client

Status: Approved for implementation · 25 September 2026

Issue: [MAX-8](https://linear.app/maximebrmd/issue/MAX-8/generate-the-typescript-client-from-a-rust-api-contract)

## Purpose and scope

Prove the frontend/backend boundary before domain features are added. A Rust
handler owns one typed response, its OpenAPI description, and the HTTP route.
The dashboard consumes a generated TypeScript client. A clean checkout can
generate and check the client without a running API or hosted credentials.

This slice adds a process health example. It does not assess database or
provider readiness. Authentication and tenant data arrive in later issues.

## Chosen approach

1. Add an Axum API in `apps/api`. Register `GET /api/v1/health` through
   `utoipa-axum`, which collects the route and its OpenAPI operation together.
   The JSON response is `{ "status": "ok" }`. Serve the same contract at
   `GET /openapi.json` and expose a `--print-openapi` mode that writes only the
   deterministic JSON contract to stdout. The print mode does not bind a port
   or contact a service.
2. Add the `@repo/api-client` workspace package. A pinned
   `@hey-api/openapi-ts` generator reads the Rust-produced contract and emits
   TypeScript models and a Fetch client. Commit `openapi.json` and the
   generated source so consumers and the later docs task use the same exact
   snapshot. Keep generated files separate from a small hand-written package
   entry point.
3. Give the client package two Nx tasks: `generate` updates the checked-in
   contract and client; `check-contract` regenerates into a temporary directory
   and compares the results without changing the checkout. Its `build` target
   checks the contract and types. The existing `@repo/api-client → reltide-api`
   dependency and a new `app → @repo/api-client` workspace dependency make
   Rust contract changes affect the client and dashboard. Keep the Rust build
   and live-service checks uncached where existing workspace policy requires.
4. Call the generated health operation from an `apps/app` server component.
   Read the API base URL from a server-only environment variable. When it is
   absent or the request fails, render an explicit local API status without
   failing a credential-free frontend build. Fetch per request so the status
   reflects the current process. Keep the Rust response as the only source of
   API data and business behavior.

The alternative of maintaining an OpenAPI file by hand would create a second
contract to synchronize with Rust. Generating TypeScript types alone would
still require a hand-maintained request call, so this design generates the
client operation as well.

### Generator choice: Hey API and Kubb

Kubb 5 is a valid alternative. `@kubb/plugin-ts` plus
`@kubb/plugin-fetch` generate operation types and standalone functions that
use native Fetch. Kubb also supports a per-call base URL, which fits the
dashboard's server-side configuration. The current Kubb TypeScript plugin
depends on TypeScript `^6.0.3`, while this repository pins TypeScript `5.9.3`
for Nx compatibility. That separate transitive compiler is not itself a
blocker, but its generated output needs a compatibility check with the pinned
project compiler.

Hey API is the narrower starting choice for one health operation: one pinned
generator package emits both types and an SDK with the Fetch client bundled
in its generated output, and its current peer range accepts TypeScript
`5.9.3`. No separate `@hey-api/client-fetch` package is required. If the team
prefers Kubb's plugin structure later, it can replace Hey API without changing
the Rust contract, Nx drift check, or dashboard boundary.

## Files and boundaries

- `apps/api/src/`: router, response type, OpenAPI export, executable startup,
  and endpoint tests.
- `packages/api-client/`: package manifest, pinned generator configuration,
  generation and drift-check scripts, contract snapshot, generated client, and
  Nx targets.
- `apps/app/`: a server-side API call and a small connection-state view; no
  Next.js route handler, SQL access, authentication logic, or proxy backend.
- `tools/rust-workspace.test.mjs`: extend graph assertions to cover the app's
  client dependency and affected-project propagation.
- `README.md`: local API startup, server-only base URL, generation/check
  commands, and the unavailable/error states.

The API uses port `3002` for local development, leaving the existing frontend
ports `3000`, `3001`, and `3004` intact. The base URL is configured explicitly
for the dashboard; it is never embedded as a public browser variable.

## Errors and verification

- Rust binds with a validated local address and reports startup errors. The
  health handler returns a stable JSON shape with HTTP 200. Its contract
  documents that shape and media type.
- The dashboard distinguishes an unset API URL from a failed request. It
  renders a non-sensitive status message and does not claim the whole platform
  is ready based on process health alone.
- A Rust endpoint test checks the actual router response and content type.
  A contract test checks the health path and schema in the generated OpenAPI.
- The drift check fails when the Rust contract changes but the checked-in
  OpenAPI or TypeScript client has not been regenerated. A graph test verifies
  that API source changes affect the client and app.
- Run focused Nx tasks, `pnpm build`, `pnpm typecheck`, `pnpm check`,
  `pnpm rust:check`, and a local HTTP smoke test. The frontend build must pass
  with no API process and no credentials.

## Dependency decision

At design time, the registries report Axum `0.8.9`, Utoipa `6.0.0`,
`utoipa-axum` `0.3.0`, and `@hey-api/openapi-ts` `0.99.0`. These are candidate
exact pins; validate their integration before committing lockfiles. The
current generator supports the repository's Node `26.9.0` and TypeScript
`5.9.3` pins.

References: [Axum serving](https://docs.rs/axum/latest/axum/fn.serve.html),
[Utoipa Axum routing](https://docs.rs/utoipa-axum/latest/utoipa_axum/),
[Hey API generation](https://heyapi.dev/docs/openapi/typescript/get-started),
[Hey API Fetch client](https://heyapi.dev/docs/openapi/typescript/clients/fetch),
[Kubb Fetch plugin](https://kubb.dev/plugins/plugin-fetch),
[Kubb base URL configuration](https://kubb.dev/plugins/plugin-fetch/guide/base-url),
and [Nx project configuration](https://nx.dev/docs/reference/project-configuration).
