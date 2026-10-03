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

CI runs on all PRs, main pushes, `v*` tags, and manual dispatch, without path filters. PRs use affected frontend/docs tasks; other events run the full suite. Rust and updater validation always run. Manually run the workflow on an upgrade branch requiring human review for full pre-merge checks and on the exact release SHA before deployment.

Main requires `Quality gates` and `Conventional PR title`, with GitHub Actions (app ID `15368`) as their expected source. Protection also applies to administrators, requires up-to-date branches and resolved review conversations, and prevents force pushes and deletion. Pull requests are required; the GitHub approval count is zero because Reltide currently has one organization member who authors and merges changes. Human review remains required for application changes and for major or pre-1.0 dependency version changes; eligible nonbreaking Renovate updates may automerge under the policy below. The aggregate `Quality gates` job runs after upstream failures and rejects failed, cancelled, or skipped frontend, Rust matrix, or validator jobs. A skipped workflow is not release evidence.

**Public development, verified 30 September 2026:** The owner chose to build Reltide in public after GitHub reported 1,810 of 2,000 included Actions minutes used. The repository is public and readable without authentication. Standard GitHub-hosted runners are free for public repositories; larger runners and storage retain separate billing rules. This also makes branch protection available on GitHub Free: main's protection API now returns the enforced settings above. The private-repository plan restriction recorded on 27 September no longer applies. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [GitHub protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Before publication, Gitleaks 8.30.1 scanned the remote branches and PR refs, main's tracked files, GitHub PR discussions and reviews, and 204 completed workflow logs without finding exposed secrets. Three workflows were still running during the initial log sweep. GitHub secret scanning and push protection are enabled. Fork PR workflows that execute contributor code require maintainer approval for all external contributors. Local `.env` files and age recovery identities are ignored; examples may be committed. [Changing repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

[MAX-27](https://linear.app/maximebrmd/issue/MAX-27/verify-required-ci-status-enforcement-for-public-reltide) now records enforcement evidence rather than a paid-plan requirement. [PR #39](https://github.com/Reltide/reltide/pull/39) returned `BLOCKED` while CI was pending, then `CLEAN` after both required checks passed. [PR #18](https://github.com/Reltide/reltide/pull/18), with failed quality gates and an outdated base, returns `BEHIND`. [Full CI on current main](https://github.com/Reltide/reltide/actions/runs/36708441532) passed on `6b53de99e79c843eb571118f30937f327d745f7b`. Passing checks permit review and merge; eligible nonbreaking Renovate updates may automerge under the policy below.

Untrusted code runs on ephemeral GitHub-hosted Ubuntu runners with `contents: read`, no deployment credentials/environment, and no production-host access. Checkout credentials are not persisted. No privileged job consumes PR artifacts/caches. Actions are SHA-pinned; the validator uses a version and digest. The title workflow's `pull_request_target` job checks out only the immutable base SHA and passes title text through an environment variable, never executing PR-head code.

Platform deployment targets Hetzner Cloud in Finland (`hel1`). Inspect the already purchased servers before choosing service placement or adding resources. Future trusted deployment jobs and disposable execution environments must preserve the separation from untrusted CI jobs and production hosts. The [Coolify runbook](operations/coolify.md) covers the dedicated management host; builds remain in CI.

## Dependency upgrades

Renovate covers npm (including pnpm), Cargo, `.node-version`, Rust toolchain/workspace version, Dockerfiles/Compose, and GitHub Actions. It retains exact versions and image/action digests. Stable minor/patch updates, pin/digest updates, and lockfile maintenance may automerge after all reported CI checks pass. Major and pre-1.0 version changes remain eligible but require human review. Nx packages update together; Rust updates include the workspace `rust-version`. Cargo/pnpm lockfile maintenance is enabled. [Renovate managers](https://docs.renovatebot.com/modules/manager/), [Rust toolchain updates](https://docs.renovatebot.com/modules/manager/rust-toolchain/), [Automerge non-major updates](https://docs.renovatebot.com/key-concepts/automerge/#automerge-non-major-updates)

Automerge uses PRs with `platformAutomerge: false` and `ignoreTests: false`, so Renovate itself waits for reported CI checks and does not merge while any reported check is pending or failing. Main's required `Quality gates` and `Conventional PR title` checks also remain enforced; GitHub-native automerge is disabled. [Renovate automerge checks](https://docs.renovatebot.com/key-concepts/automerge/#absence-of-tests), [Platform automerge requirements](https://docs.renovatebot.com/configuration-options/#platformautomerge)

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

[Full CI on main](https://github.com/Reltide/reltide/actions/runs/36314349319) also passed on merged commit `ec1b06f20826955c2f1fe79cced3e0261bb31f8c`, including 59 JavaScript tests. MAX-10's CI implementation and updater activation are complete; required-status enforcement is configured, with the remaining acceptance evidence tracked in MAX-27.

For subsequent upgrades and completion of MAX-27:

1. Read main's protection or active ruleset and confirm both required status names, with GitHub Actions as their expected source.
2. Confirm Renovate's repository access, dependency dashboard, and first upgrade PR. Check that the PR preserves exact versions and lockfiles and applies the automerge policy above.
3. Verify the upgrade PR's checks. For major or pre-1.0 version changes, run the full CI workflow on its current commit and obtain human review before merging. Keep MAX-27 open until required-status enforcement is verified.

Use these read-only commands to recheck the external blockers:

```sh
gh api orgs/Reltide --jq '.plan.name'
gh api repos/Reltide/reltide/branches/main/protection
gh api repos/Reltide/reltide/rulesets
gh api orgs/Reltide/installations --jq '.installations[] | {app_slug, repository_selection, suspended_at}'
gh issue list --repo Reltide/reltide --state all --search '"Dependency Dashboard" in:title'
gh pr list --repo Reltide/reltide --state all --author 'app/renovate'
```

Upgrades must pass PR checks and preserve lockfiles. Major and pre-1.0 version changes also require a manual full workflow on the current commit and human review; eligible nonbreaking updates may automerge. Toolchain updates also update contributor docs and `AGENTS.md`. New container/service definitions use supported stable versions/digests. Upgrade suggestions do not authorize provisioning/deployment. Temporal upgrades need its supported schema sequence and worker replay checks once introduced.

Node upgrades must keep `package.json#engines.node`, `.node-version`, and the contributor setup instructions aligned. CI installs Node from `.node-version`; the quality-gate regression checks both committed pins and the running Node version, so an engine-only upgrade cannot pass verification.

Record failing upgrade PRs in the dashboard and blockers below with versions, failure, owner, and retry condition. Reassess when either side releases a new stable version; never permanently ignore upgrades.

| Blocker | Evidence and retry condition | Owner |
| --- | --- | --- |
| TypeScript 5.9.3 pin | Nx 23.2.1 generation with TypeScript 7.0.2 fails with `ts.readConfigFile is not a function`. [PR #18 CI](https://github.com/Reltide/reltide/actions/runs/36320307965) also reproduces this failure while constructing the Nx project graph. Recheck disposable Nx/Next.js generation and project-graph construction on Nx/TypeScript upgrades, alongside full checks. TypeScript PRs remain enabled with this note. | Maintainers |
| Fumadocs release-age and peer alignment ([#19](https://github.com/Reltide/reltide/pull/19), [#20](https://github.com/Reltide/reltide/pull/20), [#22](https://github.com/Reltide/reltide/pull/22)) | Frozen installs rejected `fumadocs-core@16.15.15`, `fumadocs-openapi@12.0.4`, and `fumadocs-ui@16.15.15`, released on 27 September 2026. Retry after 28 September 2026, 15:50 UTC, allowing a margin beyond their publication timestamps; check all reported entries. Replace the separate core/UI upgrades with an aligned grouped update: #22 requires core 16.15.15 but its lockfile still resolves 16.15.14. Require fresh PR and full CI before human review/merge. [Core failure](https://github.com/Reltide/reltide/actions/runs/36337359018), [OpenAPI failure](https://github.com/Reltide/reltide/actions/runs/36337364965), [UI failure](https://github.com/Reltide/reltide/actions/runs/36343992302). | Maintainers |
| Required-status documentation ([MAX-27](https://linear.app/maximebrmd/issue/MAX-27/verify-required-ci-status-enforcement-for-public-reltide)) | Public visibility removed the plan restriction. Both named checks are enforced with GitHub Actions as their source. PR #39 changed from `BLOCKED` to `CLEAN` after CI passed; PR #18 remains `BEHIND` with failed gates and an outdated base. Review and merge this documentation evidence before closing the issue. | Organization owner |

## Tooling fallbacks

- **Nx documentation search:** the audit recorded HTTP 500 from its MCP. Use installed `nx-workspace`/`nx-run-tasks` skills, CLI output, `pnpm nx <command> --help`, `node_modules/nx/schemas`, and [official docs](https://nx.dev/docs). Do not block checks on it or assume it is healthy now.
- **Graft:** use map/ask/skeleton/callers before opening source. If unavailable, browse `graft/INDEX.md`; use `rg` and exact spans for unindexed files. Refresh with `graft build` after substantial edits.
- **Docker unavailable:** diagnose with `pnpm --package=renovate@44.115.10 dlx renovate-config-validator --strict --no-global renovate.json`. Native RE2 may be unavailable, with a warning about less accurate regex validation. Repeat in the digest-pinned container before release. Run remaining release commands separately or use the full GitHub workflow. [Validator docs](https://docs.renovatebot.com/config-validation/)
- **Workflow validation:** run `actionlint .github/workflows/ci.yml .github/workflows/pr-title.yml` on workflow edits (validated with 1.7.12). Install from the [official project](https://github.com/rhysd/actionlint) if absent. GitHub check execution supplies evidence beyond syntax/formatting.
- **Missing toolchains:** install exact pins from official distributions. Newer system Node or floating `stable` Rust does not replace committed versions. Record installation/compatibility failures as blockers.

## Private capacity experiment preflight

`capacity-experiment:check-config`, `:build-images`, and `:integration` are uncached
Nx targets. Builds require Docker/Buildx, Node 26.10.0 and pnpm 12.6.0, and export
secret-free linux/amd64 OCI archives plus a separate Docker archive for the local
legacy image store into ignored `.capacity/<CAPACITY_RUN_ID>/`. Build inputs,
source/submodule pins, dirty-source flag and actual build-input checksum, OCI
manifest, config and archive identities are recorded in
`infra/capacity/images.lock.json`. The local override uses verified config IDs;
deployment references use the OCI manifest digest. Before any later OCI import is
used, `verifyDeploymentIdentity` must verify the imported manifest identity.
A successful local Docker-format import does not prove staging OCI import support.
These artifacts are marked local correctness only; Task 8 must rebuild from
committed reviewed sources before deployment. `source_commit` identifies the base
when dirty inputs were present; it does not claim that commit contains the
uncommitted build configuration.

Integration uses synthetic credentials, owned resources with exact run labels,
two separate PostgreSQL volumes/versions, and a standard private bridge. Only the
listed HTTP/admin ports publish on 127.0.0.1. PostgreSQL, Temporal and OTLP stay
unpublished; macOS fixtures reach verified Docker VM container IPs. No live host,
provider or R2 operations occur. Later WAL archiving needs an explicit approved
PostgreSQL-to-R2 EU egress/credential boundary; the current local spool is not a
remote backup implementation.

The aggregate memory ceiling remains 3072 MiB with memory+swap equal to memory.
The initial HyperDX256/ClickHouse768 allocation failed local startup with a real
HyperDX OOM. R7 authorizes the new HyperDX384/ClickHouse640 candidate, keeping all
other allocations unchanged. This remains a constrained hypothesis: the official
ClickHouse OSS sizing guide recommends substantially more memory for production.
Local amd64 emulation and short readiness checks do not establish CX23 capacity.
Every OOM or unexpected exit stops integration and retains separate attempt
failure evidence before owned cleanup.

The versioned HyperDX launcher follows pinned 2.39.1 initialization, required-auth,
API, UI and OpAMP startup, with child termination/failure propagation. It omits
only the separate alert-check/dashboard provisioner tasks under R5 because this
experiment disables external notifications. R6 replaces the image's extra Node
healthcheck with the same pinned image's native wget, checking API `/health` and
UI `/`; the integration also requires API `/ready`. This custom launcher is not
an officially supported API/UI distribution. Compare it with the exact upstream
entrypoint whenever upgrading; retain prior failed attempts instead of treating
startup corrections as proof those attempts passed.

R8 keeps logs, metrics and traces with `sizer: items` and one 341-event queue per
signal (1023 queued events combined). Each signal has one consumer, for three
consumers in total. The pinned [exporterhelper 0.155.0 semantics](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.155.0/exporter/exporterhelper/README.md)
define items as spans, metric data points or log records; the default request
sizer would count batches instead. Integration verifies all three effective queue
capacity metrics and the applied config units. The validator parses `collector.yaml` with the YAML parser directly pinned
by the exact Nx dependency in the frozen lockfile. Limits separately account for up to 768 batch items in three active
exporter requests and 768 in three processor batches; these are separate from the
waiting queue and do not bound incoming request decoding or total RSS. The memory
limiter remains 96 MiB and the container ceiling remains 128 MiB. Overflow/loss
experiments and continuous memory sampling belong to later tasks.

## Capacity evidence reports

Run the offline evaluator with `node tools/capacity/report.mjs --verdict .capacity/<run-id>`.
It writes `report.json`, `report.csv` and `report.md` in that directory and exits
0 for PASS, 1 for FAIL, or 2 for BLOCKED (including missing/unreadable evidence).
It performs no host, Docker, cloud or R2 operations. A proven failure takes
precedence over absent evidence, both within components and in the combined
verdict. Unit fixtures exercise classification; they are not staging measurements.

The report consumes the existing `load-events.ndjson`, `load-manifest.json`, and
`integration-result.json` producer files. Host samples use `host-samples.ndjson`.
An additive `evidence.json` has `schema_version: 1`, the outer `run_id`, `manifest`,
and future `backups`, `restarts` and `restores` arrays. Programmatic evaluation
accepts these same objects with `events`, `host_samples`, `load_manifest` and
`integration` fields. The integration result stores the local callback under
`load`. Producer files are authoritative: the envelope cannot replace their
measurements, outer identity, shortened-run labels or `capacity_pass: false`.
All top-level records must identify the same run. Record sequences must be
continuous from one; logical load-event order is reconstructed from unique sequences when concurrent writes reorder physical lines. The report records that reordering; duplicate/gapped sequences still fail. Host sample and counter order stays strict; host/container/collector counters must not reset. A malformed or
truncated stream retains valid observations and cannot erase a failure.

Native `manifest` evidence declares `kind: "native-staging"`, the exact approved
host identity, image SHA-256 digests by steady-service name, `config_sha256`,
`fixture_run_id`, frozen endpoint URLs grouped by app/web/docs/api, prescribed
seed counts, and UTC `phases` (`name`, `started_at`, `completed_at`, `duration_ms`,
`http_rps`). Phase declarations require realized HTTP and telemetry admissions/completions inside
the measured UTC interval, with the declared duration matching that interval.
Every minute must contain the prescribed workload; rolling one-second admission
counts must not exceed the phase HTTP rate or ten steady telemetry events. A
minute-sized burst cannot substitute for sustained load. Stored row totals must
agree with proof rows and admissions; missing proof counts remain incomplete.
Seed admissions require the prescribed current and aged totals. Seed admission
events use the existing `telemetry_accepted` record with `phase: "seed"` and its
`cohort`. Native stored events also carry `cohort` (current, aged, boundary or
steady), so proof totals and observed expiry can reconcile the final accounting.
Positive storage, ordinary cohort counts and zero-after-expiry observations must
agree; declaring rows expired cannot replace those measurements. Current local
records without cohort relationships remain incomplete. Thirteen steady services are sampled; the transient initializer needs
a successful check, rather than a continuously running container. Native host
records retain `parseHostSample` fields, add outer `run_id`/`sequence`, and map
each container ID to its declared `service`.

Native checks use `{ run_id, passed, sha256 }`: the hash identifies the retained
check evidence, never an error/log string. Required check names are `baseline`,
`limits`, `load_counts`, `seed_counts`, `initializer`, `least_privilege`,
`outage_isolation`, `extension_after_restore`, `retention`, `wal_freshness`,
`encrypted_download`, `backup_limits`, `restart_coverage`, `restart_replay`,
`lost_ack_once`, `recovery_common_cut`, `recovery_volumes`, and `recovery_checks`.
A check is a reference to independently retained evidence, not permission to
replace contradictory measurements or missing required numeric observations.
The limits check covers the approved connection/concurrency/memory ceilings,
query/collector bounds, log rotation, no-added-swap and resource ownership.
The backup-limits check includes all-attempt spool, R2 usage/reservations and
account allowances; receipt totals alone cannot establish those controls.

The existing `AnalyticsProbeOutput` remains authoritative for exact fixture
count/range, ordered text/integer sample, remote aggregate/filter pushdown and
library/SQL pins. A different fixture ID must be explicitly related through
`manifest.fixture_run_id`; unrelated runs cannot be combined. The native runner
must add measured `search.elapsed_ms` to the existing foreground search output
and `scheduling_delay_ms` to workflow completion records. HyperDX results require
positive integer `rows`, a nonempty `saved_search_id`, and `first_id` equal to the
SHA-256 of `${outer_run_id}:current:1`; this telemetry fixture is separate from
`manifest.fixture_run_id`, which identifies the analytics fixture. Current local producers
do not supply these separate timings: combined foreground time does not establish
HyperDX p95, and workflow completion time does not establish scheduling delay.
HTTP distributions remain separate per frozen endpoint and required phase, with
counts; a fast soak cannot dilute a slow ramp. Each phase requires the measured
equal service mix and round-robin endpoint mix. Foreground search/analytics pairs
must recur in every ten-second admission slot and finish inside the measured
phase; separate query admission times are not inferred from the combined record.
Workflow starts and completions match on workflow ID, Temporal run ID, sequence,
phase and admission UTC, with one matched completion in every ten-second slot.
Missing recurring observations remain incomplete, even with passing check hashes.
CPU windows clip the leading sample interval at the exact one/five-minute boundary,
matching the live guard; clock offsets must be finite signed numeric measurements. Thresholds
are HTTP p95 ≤500 ms, workflow delay/completion p95 ≤5/10 seconds, steady telemetry
searchable within 30 seconds, and separate foreign/HyperDX p95 ≤2 seconds.

Only predeclared `manifest.induced_windows` of kind `restart`, `restore`, or
`wal-fault` may exempt a matching service/time failure. Windows carry the outer
run ID, service, declaration/start/completion UTC, verified ownership and its
SHA-256, and a run-bound recovery check. Their durations remain in the report.
No window exempts OOM, guard breaches, telemetry drops/rejections, or failed
required checks. Restart results retain service/outage/healthy/replay fields and
a measured healthy five-minute interval; readiness must return within 120 seconds. Windows use `declared_at`, `started_at`, `completed_at`, `ownership_verified`, `ownership_sha256` and `recovery_check`.

Native `retention.tables` records the complete data-table inventory with `name`, `ttl_days: 3` and `ddl_sha256`. Ordinary expiry needs the existing baseline/verified events, unchanged three-day DDL/mutation snapshots, and positive-before/zero-after boundary observations; the temporary prepared fixture alone is insufficient. Native `collector` records carry `run_id`, `sequence`, and cumulative `accepted`, `dropped`, `rejected` counters. Existing Prometheus collector event strings are separately inspected for refused/dropped/failed counts and resets, without serializing their labels.

Future backup/restore producers retain the [approved receipt/result contracts](superpowers/plans/2026-09-27-staging-capacity.md).
Receipts add outer run identity and independent encrypted-download verification;
application receipts pin the extension image/library/SQL, Temporal receipts have
no extension. Restores reference same-kind encrypted receipt hashes, preserve
unmounted source volumes, identify distinct owned fresh targets, share a UTC cut,
and carry commit watermarks and RPO/RTO. Their checks cover download/decrypt/verify
inclusion, clean volumes and extension compatibility. Restores additionally retain `started_at`, `healthy_at`, `extensions` matching their receipts, `ownership_verified`, `ownership_sha256`, and `checks.sha256`; numeric RTO must agree with the recorded interval. RPO ≤300 seconds and RTO
≤1,800 seconds are required for each database. PostgreSQL restore does not prove
recovery of remote ClickHouse data.

Reports serialize validated numeric values, fixed reason text, hashes and UTC
fields. They omit raw logs, SQL/EXPLAIN, URLs/DSNs, metric labels and arbitrary
errors. Keep raw evidence, encryption keys, archives and secret-bearing files
outside Git. Reports label synthetic-shell coverage, growth projections and
clean-volume recovery; they do not claim future business-request performance or
cold-host RTO. Shortened local runs and pruning clones remain incomplete for
native capacity. Tasks 5, 6 and 8 must supply the missing producer evidence;
absence is BLOCKED and cannot be replaced with a unit-fixture PASS.
