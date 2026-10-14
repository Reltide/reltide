# Stripe Migration MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Run the controlled Stripe migration locally and expose its generated patch, real checks, evidence, and publication blockers in the dashboard.

**Architecture:** Rust domain code defines the controlled transformation and report policy. The Rust worker verifies a disposable candidate and writes local artifacts; the Axum API serves the report through a generated TypeScript client. Next.js renders the workbench.

**Tech Stack:** Existing Cargo workspace, Axum/utoipa, serde, pinned npm fixture packages, Next.js, Geist, Nx, Ultracite, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-stripe-mvp-design.md`

## Global Constraints

- Scope is the trusted synthetic `fixtures/stripe-migration`, not arbitrary customer repositories.
- Historical source SDK/API: `10.17.0` / `2022-08-01`; target: `12.0.0` / `2022-11-15`.
- Unknown account defaults and missing independent review block publication. Generate a local PR preview only.
- Business logic and filesystem/command execution belong in Rust; Next.js consumes the Rust contract.
- Generate target code from supported old inputs; do not copy `after/src/latest-charge.ts` as the candidate.
- Record source fingerprints, actual command results, bounded logs, and explicit target-only scope.
- Preserve original fixtures, protected checks, exact dependencies, and historical fixture lockfiles.
- No hosted credentials, production deployment, GitHub writes, or live Stripe calls are needed.
- Tool-version mismatch resolved: the user explicitly approved current manifest Node `26.11.1`/pnpm `12.11.2` over the older supplied pins. No manifest downgrade or runtime-validation bypass.
- Migration execution targets are uncached. Refresh Graft after substantial edits.

## Review Focus

1. Changed or unsupported source must fail analysis rather than yield a guessed patch.
2. A missing tool, installation failure, timeout, or unexpected regression failure must never count as the expected old-code failure.
3. An unknown-default client remains a repository-wide SDK-upgrade blocker even when target-only tests pass.
4. Interrupted or failed reruns must not leave an earlier successful report presented as the latest attempt.
5. Missing, malformed, oversized, or semantically inconsistent reports must yield honest API/dashboard states without exposing local filesystem details.

---

### Task 1: Controlled migration and report policy

**Files:** Create `crates/domain/src/migration.rs`, `crates/domain/src/stripe.rs`, and `crates/domain/tests/stripe.rs`; modify `crates/domain/src/lib.rs` and `crates/domain/Cargo.toml`.

**Interfaces:**
- Produce `StripeInputs` with the explicit client/helper and pinned/unknown control source strings.
- Produce `plan_stripe_migration(inputs: &StripeInputs) -> Result<MigrationPlan, MigrationError>`.
- `MigrationPlan` contains source/target SDK/API versions, evidence links, findings with file/line/disposition/reason, proposed file edits, and publication blockers.
- Produce serializable/OpenAPI `MigrationReport` with schema version `1`, fixture identity, source fingerprints, creation time, local verification status, checks, generated diff, PR preview, and blockers.
- Each `CheckResult` contains command, exit code when available, status, bounded output, and duration. Distinguish `passed`, `expected_failure`, `failed`, and `not_run`.
- Produce `MigrationReport::validate(&self) -> Result<(), MigrationError>`; a locally verified report requires every mandatory check, an evidenced expected old regression, and retained publication blockers.

- [x] Write `explicit_target_generates_latest_charge_patch`, `old_pin_retains_legacy_access`, `unknown_default_blocks_package_upgrade`, `unsupported_source_is_rejected`, and `missing_or_failed_checks_cannot_validate_success`. Assert string, expanded-object, and null handling in the generated helper, preserved control dispositions, and held publication.
- [x] Run `cargo test -p reltide-domain --locked`; confirm the new interfaces are missing before implementation.
- [x] Implement exact supported-pattern guards and the pure transformation. Unsupported or multiply matched patterns return errors. Add serde/utoipa using existing pinned versions and update the Cargo lockfile without unrelated upgrades.
- [x] Rerun domain tests and Clippy; commit `feat(domain): model controlled Stripe migration evidence`.

### Task 2: Runnable local worker and artifacts

**Files:** Modify `apps/worker/src/main.rs`, `apps/worker/Cargo.toml`, `.gitignore`, and worker Nx target configuration after resolved-target discovery. Create `apps/worker/src/lib.rs`, `apps/worker/src/fixture.rs`, `apps/worker/src/checks.rs`, `apps/worker/src/artifacts.rs`, `apps/worker/tests/demo.rs`, and fixed trusted verification scripts under `fixtures/stripe-migration/tests/` if needed.

**Interfaces:**
- Consume Task 1's plan/report/check types.
- Produce `run_stripe_demo(workspace: &Path) -> Result<MigrationReport, DemoError>` for CLI use and isolated integration tests.
- CLI: `cargo run -p reltide-worker --locked -- stripe-demo` with a fixed workspace fixture and `.reltide/demo/` output. No public arbitrary repository or command arguments.
- Artifacts: `report.json`, `migration.patch`, and `pull-request.md`; report embeds the displayed diff/preview so the API needs only one atomic input.
- Nx: `reltide-worker:stripe-demo`, `cache: false`, running the same CLI.

- [x] Write integration tests `demo_generates_candidate_instead_of_copying_expected_source`, `command_failure_is_reported`, `unexpected_regression_error_is_not_expected_failure`, and `failed_rerun_replaces_previous_success`. Assert original inputs are unchanged and candidate output has the new helper.
- [x] Run worker tests and confirm failure before implementing the runner.
- [x] Prepare disposable old and target-only candidate packages. Install with fixed lockfiles and `npm ci --ignore-scripts`. Use the historical target lockfile as dependency evidence; generate target client/helper code from the old source, not the expected implementation.
- [x] Run old typecheck and baseline, old new-shape regression, candidate typecheck and new-shape regression, and separate pinned/unknown control verification. An expected failure requires the specific assertion mismatch, not merely any nonzero exit. Fixed scripts never call Stripe resource methods.
- [x] Record SHA-256 for every analysis/verification input, bounded subprocess output, exit codes, duration, and timeout errors. Use already locked sha2/tempfile versions if needed. Execute commands as program-plus-arguments, never a shell string.
- [x] Mark a new attempt before executing checks; atomically publish the finished report. Errors and interrupted attempts must supersede stale success. Protect concurrent runs with exclusive creation of a run marker and clear recovery guidance.
- [x] Render the actual unified patch and PR preview with evidence, exact tested scope, checks, and unresolved version/review blockers. Keep candidate/work directories and artifacts ignored; do not cache migration work.
- [x] Run the real CLI, inspect all artifacts, rerun worker tests/Clippy, and commit `feat(worker): run verified Stripe fixture migration`.

### Task 3: Read-only report API and generated contract

**Files:** Modify `apps/api/src/lib.rs:33`, `apps/api/src/main.rs:6`, and `apps/api/Cargo.toml`; create `apps/api/src/migrations.rs` and `apps/api/tests/migrations.rs`; regenerate `packages/api-client/openapi.json` and `packages/api-client/src/generated/*`; extend relevant contract assertions in `tools/api-client.test.mjs`.

**Interfaces:**
- Produce `api_with_report(report_path: Option<PathBuf>) -> (Router, OpenApi)` while retaining `api()` for existing health/offline contract consumers.
- `GET /api/v1/migrations/latest`, operation ID `getLatestMigration`, returns `MigrationReport` on 200; documented JSON error responses on 404 (no report) and 503 (unreadable/invalid report).
- `RELTIDE_MIGRATION_REPORT` optionally selects the trusted local report; otherwise use the CLI's default local output. No request parameter controls filesystem paths.
- Generated Fetch SDK exposes `getLatestMigration` and `MigrationReport`.

- [x] Write router tests for valid reports, missing reports, malformed JSON, oversized input, invalid schema/check policy, and unchanged health/offline export. Confirm new operation is absent before implementation.
- [x] Implement bounded report reads off the async executor, `MigrationReport::validate`, generic public errors, and `no-store` response semantics. Set a documented 1 MiB report-size ceiling.
- [x] Register routes/types through utoipa, preserve pure offline OpenAPI export, and regenerate via `pnpm nx run @repo/api-client:generate`.
- [x] Run API integration tests, `pnpm nx run @repo/api-client:check-contract`, and contract tests; commit `feat(api): expose migration evidence contract`.

### Task 4: Migration workbench

**Files:** Modify `apps/app/app/page.tsx:13`; create `apps/app/lib/migration-report.ts`, `apps/app/lib/migration-report.test.ts`, and focused presentation components in `apps/app/components/` as needed. Use existing `@repo/design-system` components/tokens.

**Interfaces:**
- Produce `getMigrationReport(baseUrl?: string): Promise<MigrationReportState>`, where state distinguishes `unconfigured`, `empty`, `unavailable`, and `available` with a generated-client report.
- Consume Task 3's generated SDK; server-side Fetch only, with no database or command execution in Next.js.

- [x] Write HTTP response tests for absent configuration, 404, valid 200, failed request, malformed/missing body, and 503. Run them before implementation and confirm failure.
- [x] Load modern-web guidance and current official Next.js/Geist guidance. Implement the Fetch adapter with a finite timeout and `no-store` caching.
- [x] Replace the foundation shell with provider/version context, real source findings, evidence links, local check outcomes, generated diff, PR preview, and publication blockers. Explicitly identify synthetic fixture scope and pending independent review.
- [x] Provide meaningful empty/unavailable states and a reload action. Use semantic headings, accessible links/status labels, readable code previews, and responsive layout. Do not fabricate connected repositories, metrics, polling, GitHub URLs, or Greptile scores.
- [x] Run response tests, app typecheck/build/check, and a browser inspection against the actual API/report; commit `feat(app): show Stripe migration workbench`.

### Task 5: Delivery verification and quickstart

**Files:** Modify `README.md` and relevant `docs/maintenance.md` instructions; add a concise local-demo guide if needed. Update plan checkboxes with actual outcomes.

- [x] Document frozen platform install, isolated historical fixture checks, CLI, local API/report configuration, and dashboard startup. Resolve the tool-version mismatch with the user before runtime checks requiring newer manifest pins.
- [x] Document local-only scope, unresolved version/review blockers, and Greptile's future independent-review role without claiming integration is active.
- [x] Run `pnpm check`, `pnpm test`, `pnpm typecheck`, `pnpm build`, contract drift checks, and workspace Rust format/Clippy/tests. Run `pnpm ci:release` with Docker; if unavailable, record the limitation and run remaining release checks separately.
- [ ] Obtain an independent whole-change review using the selected execution method; address findings and rerun affected checks. Do not publish a migration PR with incomplete evidence or verification.
- [x] Run `graft build`, inspect final diff/status, and commit `docs: document verified Stripe MVP workflow`. Report startup commands, verification evidence, and remaining external-integration limits.

## Recorded outcomes

Tasks 1–4 are implemented in `02cb295`, `2ddbc7f`, `0503eaa`, and `7962b85`; each passed its independent task review. The worker materializes fixed verification programs from embedded Rust bytes in its disposable workspace; it does not add fixture scripts or alter protected quality configuration. Candidate verification preserves original scripts/config and explicitly uses a sparse target package. Task 4 also exports the generated operation/types through the public client barrel. Production desktop/mobile, keyboard, disclosure, reload, and console checks were completed by the coordinator against the actual API/report. Final whole-change review remains pending.

Task 5 delivery verification: `pnpm ci:release` exited 0 with Docker; 123 Vitest tests, 17 uncached Nx tasks, and 63 Rust tests per required configuration passed (four existing capacity tests ignored). The actual uncached demo passed seven checks and retained both blockers. Graft refreshed; exact commands, evidence, limits, and rulings are recorded in `docs/superpowers/reviews/2026-10-14-stripe-mvp-verification.md`. Task 5 and whole-change independent reviews remain coordinator-owned and pending.
