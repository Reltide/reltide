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

Start one shell with `pnpm nx run app:dev`, `pnpm nx run web:dev`, or `pnpm nx run docs:dev`. They listen on ports 3000, 3001, and 3004. These initial frontend shells build without credentials or hosted services. They do not yet connect to repositories or run migrations.

The layout keeps next-forge's `apps/` and `packages/` split. It was adapted from [next-forge commit `f189de7`](https://github.com/haydenbleasel/next-forge/tree/f189de79ceef7c1ef69f61f12e272f99b4cdb699) under its [MIT license](LICENSE.next-forge.md). The three Next.js app shells were generated with `@nx/next` 23.2.1; Nx replaces Turborepo. The upstream Mintlify docs were replaced with a Fumadocs shell, and the Next.js backend integrations were removed for the planned Rust backend.

## Rust workspace

`apps/api`, `apps/worker`, and `crates/domain` are Cargo workspace members and Nx projects. The API and worker binaries are compile-only skeletons. The Rust API contract and generated client arrive in [MAX-8](https://linear.app/maximebrmd/issue/MAX-8/generate-the-typescript-client-from-a-rust-api-contract).

`pnpm build` builds the three Next.js shells and both Rust binaries through Nx. For focused work, use `pnpm nx run reltide-api:build`, `pnpm nx run reltide-worker:clippy`, or the `fmt`, `clippy`, and `test` targets on any Rust project. `pnpm rust:check` runs the full workspace rustfmt, Clippy, and test commands, then checks the Nx dependency and affected-project graph. The underlying Rust checks are:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Nx records both Rust binaries' dependencies on `reltide-domain`. `packages/api-client/project.json` reserves the generated client's dependency on `reltide-api`; MAX-8 will add its package and generation target. Root Cargo manifests, lockfile, toolchain, and shared Rust configuration are affected-project inputs, while source changes flow through the project graph. Rust build, format, Clippy, and test targets run fresh because Cargo uses a shared `target/` directory and future checks may read environment-specific settings. Cargo still reuses local compilation artifacts. Resource provisioning and live-service operations have no reusable Nx targets.

## Design system

The MVP follows [Vercel's Geist Design System](https://vercel.com/geist/introduction) for typography, color roles, spacing, and component behavior. All three shells load Geist Sans and Geist Mono from the pinned public `geist` package. The shared `@repo/design-system` package owns the UI tokens and components; its Button is for actions and ButtonLink is for navigation. The colors and components are local implementations informed by Geist's public guidelines, not imports from a Vercel component package. This choice does not change the Verda hosting target.

All product backend and worker code belongs in Rust. Platform compute targets Verda in Finland, with Neon EU for application PostgreSQL and Cloudflare R2 EU jurisdiction for private artifacts. `AGENTS.md` records the boundaries and development commands.

TypeScript 5.9.3 is the current compatibility pin: the Nx 23.2.1 generator fails against TypeScript 7.0.2. Upgrade it when the generator and checks support the newer stable release.

## Brand assets

- `assets/reltide-logo.png` — full wordmark
- `assets/reltide-icon.png` — standalone symbol
