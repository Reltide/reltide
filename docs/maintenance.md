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

**Enforcement blocker, verified 27 September 2026:** Reltide is an organization on GitHub Free, and this repository is private. GitHub returns HTTP 403 for main protection and repository rulesets. The browser's branch-protection form also explicitly says rules will not be enforced until the organization upgrades to Team or Enterprise. An organization owner must upgrade Reltide, then require `Quality gates` and `Conventional PR title` on main. A personal GitHub Pro student benefit does not change the organization's plan. The owner approved moving this remaining requirement from MAX-10 into [MAX-27](https://linear.app/maximebrmd/issue/MAX-27/enable-required-ci-status-enforcement-for-the-private-repository), which blocks MAX-23 until enforcement is verified. [GitHub protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Untrusted code runs on ephemeral GitHub-hosted Ubuntu runners with `contents: read`, no deployment credentials/environment, and no production-host access. Checkout credentials are not persisted. No privileged job consumes PR artifacts/caches. Actions are SHA-pinned; the validator uses a version and digest. The title workflow's `pull_request_target` job checks out only the immutable base SHA and passes title text through an environment variable, never executing PR-head code.

Platform deployment targets Hetzner Cloud in Finland (`hel1`). Inspect the already purchased servers before choosing service placement or adding resources. Future trusted deployment jobs and disposable execution environments must preserve the separation from untrusted CI jobs and production hosts. The [Coolify runbook](operations/coolify.md) covers the dedicated management host; builds remain in CI.

## Dependency upgrades

Renovate covers npm (including pnpm), Cargo, `.node-version`, Rust toolchain/workspace version, Dockerfiles/Compose, and GitHub Actions. It retains exact versions and image/action digests. Stable majors are eligible; all automerge is disabled. Nx packages update together; Rust updates include the workspace `rust-version`. Cargo/pnpm lockfile maintenance is enabled. [Renovate managers](https://docs.renovatebot.com/modules/manager/), [Rust toolchain updates](https://docs.renovatebot.com/modules/manager/rust-toolchain/)

The Compose manager also scans `infra/coolify/*.compose.yml`, retaining its default filename patterns. This includes the management, production, and staging proxies and the staging smoke service, so their pinned images receive update PRs. [Compose file matching](https://docs.renovatebot.com/modules/manager/docker-compose/), [Additional manager file patterns](https://docs.renovatebot.com/configuration-options/#managerfilepatterns)

Renovate waits at least one day for npm releases and filters pending versions with `internalChecksFilter: strict`, matching pnpm 12's default 1,440-minute release-age policy. Pending updates remain visible in the dependency dashboard. pnpm still verifies every lockfile entry, including transitive dependencies; if an upgrade fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, wait until every reported publication timestamp is at least 24 hours old and rerun CI on the current commit. Keep the release-age policy and exclusions intact. [Renovate release-age filtering](https://docs.renovatebot.com/configuration-options/#internalchecksfilter), [pnpm release-age policy](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)

Fumadocs core and UI update in one group, waiting for both updates to be eligible. UI declares an exact core peer version, so regenerate their lockfile together and verify the resolved core satisfies that peer before running PR and full CI. OpenAPI and MDX use separate version lines and remain independent updates. If only one core/UI update appears, inspect the upstream peer metadata and publication timestamps before revising the grouping rule. [Renovate grouping](https://docs.renovatebot.com/configuration-options/#groupname), [Minimum group size](https://docs.renovatebot.com/configuration-options/#minimumgroupsize)

**Updater activation, verified 27 September 2026:** The owner installed the [Renovate GitHub App](https://github.com/apps/renovate) with access to all Reltide repositories. In the [Mend repository settings](https://developer.mend.io/github/Reltide/reltide/-/settings), Dependency Updates, Automated PRs, Require config file, and Create onboarding PRs are enabled. Silent mode was initially enabled; disabling it changed the repository to Interactive mode and triggered a new scan. That scan created [Dependency Dashboard #13](https://github.com/Reltide/reltide/issues/13), [Node engine pin PR #11](https://github.com/Reltide/reltide/pull/11), and [lint-staged upgrade PR #12](https://github.com/Reltide/reltide/pull/12). Both PRs have automerge disabled and started CI automatically. No updater token belongs in PR jobs.

The dashboard confirms detection of npm, Cargo, Node and Rust toolchains, the digest-pinned container, and GitHub Actions. Major TypeScript, Vitest, and Ubuntu updates remain eligible; they are queued by the normal PR rate limit, not permanently suppressed. If scans finish without a GitHub dashboard or PRs, check Silent mode before assuming a scheduling or repository-access failure.

Updater verification passed on 27 September 2026. PR #11 aligned the manifest, CI runtime pin, and contributor instructions on Node 26.10.0 and added a regression that checks both committed pins and the running Node version. PR #12 was updated with that change before verification. Both PRs received human review and passed `Conventional PR title` before merging.

| Upgrade PR | Verified commit | PR CI | Full CI |
| --- | --- | --- | --- |
| Node runtime alignment #11 | `ecba306b729a94fbacb3cda733a61b57f0f8e706` | [Passed](https://github.com/Reltide/reltide/actions/runs/36313740468) | [Passed](https://github.com/Reltide/reltide/actions/runs/36313765814) |
| lint-staged 17.6.0 #12 | `77ebe445eacfae002a0c6e0bd3445fcb187309bf` | [Passed](https://github.com/Reltide/reltide/actions/runs/36314070378) | [Passed](https://github.com/Reltide/reltide/actions/runs/36314086842) |

[Full CI on main](https://github.com/Reltide/reltide/actions/runs/36314349319) also passed on merged commit `ec1b06f20826955c2f1fe79cced3e0261bb31f8c`, including 59 JavaScript tests. MAX-10's CI implementation and updater activation are complete; required-status enforcement remains tracked in MAX-27.

For subsequent upgrades and completion of MAX-27:

1. Read main's protection or active ruleset and confirm both required status names, with GitHub Actions as their expected source.
2. Confirm Renovate's repository access, dependency dashboard, and first upgrade PR. Check that the PR preserves exact versions and lockfiles and requires human review.
3. Verify the upgrade PR's checks, then run the full CI workflow on its current commit before merging. Keep MAX-27 open until required-status enforcement is verified.

Use these read-only commands to recheck the external blockers:

```sh
gh api orgs/Reltide --jq '.plan.name'
gh api repos/Reltide/reltide/branches/main/protection
gh api repos/Reltide/reltide/rulesets
gh api orgs/Reltide/installations --jq '.installations[] | {app_slug, repository_selection, suspended_at}'
gh issue list --repo Reltide/reltide --state all --search '"Dependency Dashboard" in:title'
gh pr list --repo Reltide/reltide --state all --author 'app/renovate'
```

Upgrades must pass PR checks and a manual full workflow on the current commit, receive human review, and preserve lockfiles. Toolchain updates also update contributor docs and `AGENTS.md`. New container/service definitions use supported stable versions/digests. Upgrade suggestions do not authorize provisioning/deployment. Temporal upgrades need its supported schema sequence and worker replay checks once introduced.

Node upgrades must keep `package.json#engines.node`, `.node-version`, and the contributor setup instructions aligned. CI installs Node from `.node-version`; the quality-gate regression checks both committed pins and the running Node version, so an engine-only upgrade cannot pass verification.

Record failing upgrade PRs in the dashboard and blockers below with versions, failure, owner, and retry condition. Reassess when either side releases a new stable version; never permanently ignore upgrades.

| Blocker | Evidence and retry condition | Owner |
| --- | --- | --- |
| TypeScript 5.9.3 pin | Nx 23.2.1 generation with TypeScript 7.0.2 fails with `ts.readConfigFile is not a function`. [PR #18 CI](https://github.com/Reltide/reltide/actions/runs/36320307965) also reproduces this failure while constructing the Nx project graph. Recheck disposable Nx/Next.js generation and project-graph construction on Nx/TypeScript upgrades, alongside full checks. TypeScript PRs remain enabled with this note. | Maintainers |
| Fumadocs release-age and peer alignment ([#19](https://github.com/Reltide/reltide/pull/19), [#20](https://github.com/Reltide/reltide/pull/20), [#22](https://github.com/Reltide/reltide/pull/22)) | Frozen installs rejected `fumadocs-core@16.15.15`, `fumadocs-openapi@12.0.4`, and `fumadocs-ui@16.15.15`, released on 27 September 2026. Retry after 28 September 2026, 15:50 UTC, allowing a margin beyond their publication timestamps; check all reported entries. Replace the separate core/UI upgrades with an aligned grouped update: #22 requires core 16.15.15 but its lockfile still resolves 16.15.14. Require fresh PR and full CI before human review/merge. [Core failure](https://github.com/Reltide/reltide/actions/runs/36337359018), [OpenAPI failure](https://github.com/Reltide/reltide/actions/runs/36337364965), [UI failure](https://github.com/Reltide/reltide/actions/runs/36343992302). | Maintainers |
| Required-status enforcement ([MAX-27](https://linear.app/maximebrmd/issue/MAX-27/enable-required-ci-status-enforcement-for-the-private-repository)) | Reltide uses GitHub Free; protection/ruleset APIs return 403 for this private repo. Upgrade the organization plan and require both named checks. | Organization owner |

## Tooling fallbacks

- **Nx documentation search:** the audit recorded HTTP 500 from its MCP. Use installed `nx-workspace`/`nx-run-tasks` skills, CLI output, `pnpm nx <command> --help`, `node_modules/nx/schemas`, and [official docs](https://nx.dev/docs). Do not block checks on it or assume it is healthy now.
- **Graft:** use map/ask/skeleton/callers before opening source. If unavailable, browse `graft/INDEX.md`; use `rg` and exact spans for unindexed files. Refresh with `graft build` after substantial edits.
- **Docker unavailable:** diagnose with `pnpm --package=renovate@44.115.10 dlx renovate-config-validator --strict --no-global renovate.json`. Native RE2 may be unavailable, with a warning about less accurate regex validation. Repeat in the digest-pinned container before release. Run remaining release commands separately or use the full GitHub workflow. [Validator docs](https://docs.renovatebot.com/config-validation/)
- **Workflow validation:** run `actionlint .github/workflows/ci.yml .github/workflows/pr-title.yml` on workflow edits (validated with 1.7.12). Install from the [official project](https://github.com/rhysd/actionlint) if absent. GitHub check execution supplies evidence beyond syntax/formatting.
- **Missing toolchains:** install exact pins from official distributions. Newer system Node or floating `stable` Rust does not replace committed versions. Record installation/compatibility failures as blockers.
