# Quality gates and dependency maintenance

Use exact Node from `.node-version`, pnpm from `package.json#packageManager`, and Rust from `rust-toolchain.toml`. From a clean checkout, run `pnpm install --frozen-lockfile`. Docker is needed for the pinned validator; other checks need no hosted credentials.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm nx show projects --json` | Discover projects |
| `pnpm nx show project <name> --json` | Discover resolved targets and inputs |
| `pnpm check` | Read-only Ultracite: Oxlint and Oxfmt |
| `pnpm test` | All client, dashboard, docs, and affected-coverage Vitest tests |
| `pnpm build` | Three Next.js apps and two Rust executables, including client drift and docs links |
| `pnpm typecheck` | Frontend TypeScript and shared dependencies |
| `pnpm nx run @repo/api-client:check-contract` | Regenerate into temporary files and reject committed drift |
| `pnpm nx run docs:check-links` | Validate routes and headings |
| `pnpm nx run docs:smoke` | Build and exercise an isolated standalone docs bundle and search |
| `pnpm rust:check` | Workspace rustfmt, Clippy, Rust tests, and Rust graph tests |
| `pnpm ci:config` | Strict repository-config validation in a digest-pinned Renovate container |
| `pnpm ci:affected` | Workspace Ultracite and Vitest, then affected build/typecheck/client/docs tasks |
| `pnpm ci:frontend` | The same suite for every platform project, bypassing Nx cache |
| `pnpm rust:ci:default` | rustfmt, Clippy, tests, and optimized all-targets workspace build |
| `pnpm rust:ci:no-default-features` | Clippy, tests, and optimized build without default workspace features |
| `pnpm rust:ci:all-features` | Clippy, tests, and optimized build with every workspace feature |
| `pnpm ci:release` | Config validation, full frontend/docs suite, and all Rust configurations |

Reproduce affected checks with `NX_BASE=<base-sha> NX_HEAD=<merge-sha> pnpm ci:affected`. CI tests the PR merge commit against its base with full history. Root checks always run, even for an empty affected set. Shared npm manifests/lockfiles, Node, TypeScript/Oxc configuration, root tools, workflows, updater config, and infrastructure select all platform projects. Cargo manifests/lockfiles, Rust configuration, and API inputs flow through Rust → client → dashboard/docs. Tests check affected projects and scheduled tasks.

Historical `fixtures/stripe-migration` packages are excluded from platform tasks and updates. Their old SDKs and separate lockfiles are evidence fixtures, not shipped apps. Nx infers placeholder typecheck targets for them; placeholders are not counted as successful verification. Use their [README](../fixtures/stripe-migration/README.md) for isolated checks.

No optional Cargo features exist yet. Default, no-default-features, and all-features are valid but equivalent for workspace features; each runs real API integration tests. Add supported combinations with any new feature. Replace all-features if features become mutually exclusive. Worker/domain zero-test outputs do not establish application behavior; add integration/replay tests when those behaviors exist.

## Required checks and isolation

CI runs on all PRs, main pushes, `v*` tags, and manual dispatch, without path filters. PRs use affected frontend/docs tasks; other events run the full suite. Rust and updater validation always run. Manually run the workflow on an upgrade branch for full pre-merge checks and on the exact release SHA before deployment.

Require `Quality gates` and `Conventional PR title` on main once the repository plan supports protection. The aggregate `Quality gates` job runs after upstream failures and rejects failed, cancelled, or skipped frontend, Rust matrix, or validator jobs. A skipped workflow is not release evidence.

**Enforcement blocker, verified 26 September 2026:** GitHub returns HTTP 403 for main protection and repository rulesets on the private plan. Checks cannot block merges until an owner upgrades the applicable plan and requires both statuses. Keep MAX-10 open until enforcement and updater activation are verified. This change does not alter visibility or purchase a plan. [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

Untrusted code runs on ephemeral GitHub-hosted Ubuntu runners with `contents: read`, no deployment credentials/environment, and no production-host access. Checkout credentials are not persisted. No privileged job consumes PR artifacts/caches. Actions are SHA-pinned; the validator uses a version and digest. The title workflow's `pull_request_target` job checks out only the immutable base SHA and passes title text through an environment variable, never executing PR-head code.

Platform deployment remains on Verda in Finland. Future trusted deployment jobs and ephemeral Verda CI runners must preserve the separation from untrusted jobs.

## Dependency upgrades

Renovate covers npm (including pnpm), Cargo, `.node-version`, Rust toolchain/workspace version, Dockerfiles/Compose, and GitHub Actions. It retains exact versions and image/action digests. Stable majors are eligible; all automerge is disabled. Nx packages update together; Rust updates include the workspace `rust-version`. Cargo/pnpm lockfile maintenance is enabled. [Renovate managers](https://docs.renovatebot.com/modules/manager/), [Rust toolchain updates](https://docs.renovatebot.com/modules/manager/rust-toolchain/)

An owner must enable the [Renovate GitHub App](https://github.com/apps/renovate) for this repo, then verify its dashboard and first upgrade PR after the config reaches main. A config alone does not schedule a bot. Activation is not yet verified; no updater token belongs in PR jobs.

Upgrades must pass PR checks and a manual full workflow on the current commit, receive human review, and preserve lockfiles. Toolchain updates also update contributor docs and `AGENTS.md`. New container/service definitions use supported stable versions/digests. Upgrade suggestions do not authorize provisioning/deployment. Temporal upgrades need its supported schema sequence and worker replay checks once introduced.

Record failing upgrade PRs in the dashboard and blockers below with versions, failure, owner, and retry condition. Reassess when either side releases a new stable version; never permanently ignore upgrades.

| Blocker | Evidence and retry condition | Owner |
| --- | --- | --- |
| TypeScript 5.9.3 pin | Nx 23.2.1 generation with TypeScript 7.0.2 fails with `ts.readConfigFile is not a function`. Recheck disposable Nx/Next.js generation on Nx/TypeScript upgrades, alongside full checks. TypeScript PRs remain enabled with this note. | Maintainers |
| Required-status enforcement | Protection/ruleset APIs return 403. Require both named checks when the private plan supports them. | Repository owner |
| Updater activation | Bot activation/first upgrade PR are unverified. Enable access and inspect the dashboard/first PR after merge. | Repository owner |

## Tooling fallbacks

- **Nx documentation search:** the audit recorded HTTP 500 from its MCP. Use installed `nx-workspace`/`nx-run-tasks` skills, CLI output, `pnpm nx <command> --help`, `node_modules/nx/schemas`, and [official docs](https://nx.dev/docs). Do not block checks on it or assume it is healthy now.
- **Graft:** use map/ask/skeleton/callers before opening source. If unavailable, browse `graft/INDEX.md`; use `rg` and exact spans for unindexed files. Refresh with `graft build` after substantial edits.
- **Docker unavailable:** diagnose with `pnpm --package=renovate@44.115.10 dlx renovate-config-validator --strict --no-global renovate.json`. Native RE2 may be unavailable, with a warning about less accurate regex validation. Repeat in the digest-pinned container before release. Run remaining release commands separately or use the full GitHub workflow. [Validator docs](https://docs.renovatebot.com/config-validation/)
- **Workflow validation:** run `actionlint .github/workflows/ci.yml .github/workflows/pr-title.yml` on workflow edits (validated with 1.7.12). Install from the [official project](https://github.com/rhysd/actionlint) if absent. GitHub check execution supplies evidence beyond syntax/formatting.
- **Missing toolchains:** install exact pins from official distributions. Newer system Node or floating `stable` Rust does not replace committed versions. Record installation/compatibility failures as blockers.
