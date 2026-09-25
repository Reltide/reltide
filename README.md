# Reltide

![Reltide logo](assets/reltide-logo.png)

Reltide is an early-stage developer tool for teams that depend on external APIs. It aims to identify breaking changes and prepare tested draft pull requests for engineers to review.

## Local foundation

Use Node `26.9.0`, pnpm `12.6.0`, and the Rust toolchain pinned in `rust-toolchain.toml`. From a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm nx show projects --json
pnpm build
pnpm typecheck
pnpm check
pnpm rust:check
```

Start one shell with `pnpm nx run app:dev`, `pnpm nx run web:dev`, or `pnpm nx run docs:dev`. They listen on ports 3000, 3001, and 3004. The frontend shells build without credentials or hosted services. They do not yet connect to repositories or run migrations.

`pnpm check` runs a read-only workspace check with Ultracite's Oxlint and Oxfmt configuration. `pnpm nx run-many -t check` runs the same checks as cacheable Nx targets for each frontend project; `pnpm nx run app:check` checks one project. `pnpm typecheck` runs TypeScript separately, and `pnpm fix` applies available lint and formatting fixes. The JSON-only TypeScript config package uses Oxfmt for its Nx check target.

Installation prepares Husky's `pre-commit` and `commit-msg` hooks. The pre-commit hook invokes the project-installed lint-staged and Ultracite binaries on supported staged files. lint-staged hides and restores unstaged edits in partially staged files, so the hook does not add unrelated working-tree edits to a commit. The commit-msg hook uses the project-installed commitlint binary to require Conventional Commits messages, such as `feat: add repository onboarding`.

The layout keeps next-forge's `apps/` and `packages/` split. It was adapted from [next-forge commit `f189de7`](https://github.com/haydenbleasel/next-forge/tree/f189de79ceef7c1ef69f61f12e272f99b4cdb699) under its [MIT license](LICENSE.next-forge.md). The three Next.js app shells were generated with `@nx/next` 23.2.1; Nx replaces Turborepo. The upstream Mintlify docs were replaced with a Fumadocs shell, and the Next.js backend integrations were removed for the planned Rust backend.

## Rust workspace

`apps/api`, `apps/worker`, and `crates/domain` are Cargo workspace members and Nx projects. The worker is still a compile-only skeleton. The API exposes `GET /api/v1/health` and `GET /openapi.json` from the same Rust router and OpenAPI registration. Health returns `{ "status": "ok" }`; it confirms process availability, not database or provider readiness.

For a local dashboard connection, start the API in one shell and the app in another:

```bash
cargo run -p reltide-api --locked
RELTIDE_API_BASE_URL=http://127.0.0.1:3002 pnpm nx run app:dev
```

The API listens on `127.0.0.1:3002` by default; set `RELTIDE_API_BIND` to another socket address if needed. `RELTIDE_API_BASE_URL` is server-only. With no value, the dashboard shows “Not configured”; an invalid URL, failed request, non-success response, or unexpected health body shows “Unavailable”. The app build does not require an API process. Export the Rust contract without starting a server with `cargo run -q -p reltide-api --locked -- --print-openapi`.

The Rust contract generates `packages/api-client/openapi.json` and the committed Hey API Fetch SDK. After changing a Rust API operation or schema, run `pnpm nx run @repo/api-client:generate` and commit both outputs. `pnpm nx run @repo/api-client:check-contract` regenerates into a temporary directory and fails on any committed drift without editing the checkout. The client build target runs this check and TypeScript type checking; `pnpm build` reaches it through the dashboard dependency. `pnpm test:api-contract` runs the local contract, dashboard response, and Nx graph tests.

`pnpm build` builds the three Next.js shells and both Rust binaries through Nx. For focused work, use `pnpm nx run reltide-api:build`, `pnpm nx run reltide-worker:clippy`, or the `fmt`, `clippy`, and `test` targets on any Rust project. `pnpm rust:check` runs the full workspace rustfmt, Clippy, and test commands, then checks the Nx dependency and affected-project graph. The underlying Rust checks are:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Nx records both Rust binaries' dependencies on `reltide-domain`, the generated client's dependency on `reltide-api`, and the dashboard's dependency on `@repo/api-client`. Root Cargo manifests, lockfile, toolchain, and shared Rust configuration are affected-project inputs, while source changes flow through the project graph. Rust build, format, Clippy, and test targets run fresh because Cargo uses a shared `target/` directory and future checks may read environment-specific settings. The API client generation and drift targets also run fresh. Cargo still reuses local compilation artifacts. Resource provisioning and live-service operations have no reusable Nx targets.

## Design system

The MVP follows [Vercel's Geist Design System](https://vercel.com/geist/introduction) for typography, color roles, spacing, and component behavior. All three shells load Geist Sans and Geist Mono from the pinned public `geist` package. The shared `@repo/design-system` package owns the UI tokens and components; its Button is for actions and ButtonLink is for navigation. The colors and components are local implementations informed by Geist's public guidelines, not imports from a Vercel component package. This choice does not change the Verda hosting target.

All product backend and worker code belongs in Rust. Platform compute targets Verda in Finland, with Neon EU for application PostgreSQL and Cloudflare R2 EU jurisdiction for private artifacts. `AGENTS.md` records the boundaries and development commands.

TypeScript 5.9.3 is the current compatibility pin: the Nx 23.2.1 generator fails against TypeScript 7.0.2. Upgrade it when the generator and checks support the newer stable release.

## Brand assets

- `assets/reltide-logo.png` — full wordmark
- `assets/reltide-icon.png` — standalone symbol
