# MAX-11 — staging capacity and recovery design

**Original written spec approved on 27 September 2026. Revised the same day for the owner's explicit self-hosted `pg_clickhouse` clarification; review this revision with the implementation plan before execution-method selection and implementation.**

## Purpose and decision

Determine whether the selected trusted production stack can operate within one existing Hetzner CX23 in `hel1`: 2 shared vCPU, 4 GB RAM and 40 GB included disk. Use the existing staging CX23 with synthetic data to measure the combined stack, resource controls, encrypted off-server backup, restart and restore behavior. A failed result is useful evidence for a revised placement or resize forecast; it must not be converted into a pass by omitting services or weakening checks.

The owner approved this staging experiment and clarified that the application target is self-hosted PostgreSQL with the open-source `pg_clickhouse` extension on the production CX23, replacing Neon. ClickHouse Managed Postgres is not selected. Management remains the dedicated Coolify host. The [pilot forecast](../../decisions/pilot-budget.md) includes the three hosts, R2, free Resend, the existing $10/month OpenCode Go subscription and a provisional $10/year domain. The extension adds no managed-service subscription. The unchanged €54.40 monthly planning allocation does not prove capacity or establish a final invoice.

This spec defines one capacity experiment. Production deployment, customer repository execution, model requests, paid API fallback, new compute and automatic resizing remain separate work. [MAX-11](https://linear.app/maximebrmd/issue/MAX-11/validate-the-pilot-bill-and-define-resource-limits) remains In Progress until its remaining billing, capacity, recovery and admission evidence is complete. The written implementation plan and execution method require review before deployment.

## Baseline and limits of the evidence

The authenticated staging inventory is server `167541435`, `reltide-staging`, CX23, x86, Ubuntu 26.04, private address `172.30.0.3`. It has deletion/rebuild protection, an attached Cloud Firewall and the purchased trusted private network. Production and management are different protected servers. Reinspect identities, prices, network and guest state before any deployment; an inventory mismatch stops the experiment.

The 27 September staging sample had 3.18 GiB available of 3.73 GiB memory and 2.86 GiB used of 37.21 GiB root filesystem. Its proxy, Sentinel and smoke service were running. These samples describe idle overhead, not capacity. Preserve those services and include their overhead in host measurements.

Graft source context shows `apps/worker/src/main.rs:1` is `fn main() {}` and `apps/api/src/lib.rs:33` builds the health/OpenAPI router. The Next.js applications are initial shells. Therefore the experiment can validate these shells plus a real synthetic database/workflow workload; it cannot certify future authentication, webhook traffic, business queries or migration orchestration. Those additions require repeating the relevant capacity checks.

## Components and boundaries

Run all components simultaneously on staging. Use one isolated deployment project, `reltide-capacity`, with explicit labels on every test container, volume and network. Do not share its database credentials, volumes or Temporal namespace with production or Coolify.

| Component | Required exercise |
| --- | --- |
| `apps/app`, `apps/web`, `apps/docs` | Real production builds; HTTP page and static-asset requests |
| Rust API | Existing health/OpenAPI endpoints, startup and health under combined load |
| Trusted Rust capacity probe | A real Temporal workflow/activity plus synthetic application PostgreSQL writes and reads |
| Application PostgreSQL with `pg_clickhouse` | Dedicated instance, role and volume; indexed synthetic ledger, bounded foreign-table analytics, backup and WAL replay with extension compatibility |
| Temporal and its PostgreSQL | Separate persistence instance/role/volume, schema initialization, workflow history and restart replay |
| Temporal UI | Private administrative interface and workflow inspection |
| ClickStack | ClickHouse, OpenTelemetry collector, HyperDX and MongoDB; ingest, search, retention and restart |
| Existing staging services and OS | Proxy, Sentinel, smoke service, kernel, Docker and all host overhead |

The [extension](https://clickhouse.com/docs/products/managed-postgres/extensions/pg_clickhouse/introduction) provides a query path from PostgreSQL to a separate ClickHouse server. PostgreSQL remains authoritative for application transactions. This experiment adds no automatic replication, ClickPipes, PeerDB, managed database or additional ClickHouse process. Install `pg_clickhouse` only in application PostgreSQL, using version `0.10.0` with SQL extension version `0.10`; Temporal keeps its separate unmodified persistence instance. Record the build inputs and loaded versions rather than treating a PostgreSQL-major Docker tag as an extension pin.

Create a separate synthetic `capacity_analytics.ledger_sample` table in the test ClickHouse instance. Seed exactly 10,000 `(run_id, sequence)` rows, sequence 1–10,000, in one explicit batch; the fixture is independent of the transactional ledger and ClickStack telemetry tables. Map only that table into PostgreSQL schema `capacity_ch`. A dedicated PostgreSQL reader maps to a ClickHouse user with SELECT on that table only. Keep schema creation/seeding credentials separate from runtime readers; do not map PUBLIC or use the default/admin ClickHouse user. Encrypted PostgreSQL backups contain mapping credentials and must remain private.

Verify a parameterized count/min/max query returns `(10000, 1, 10000)` through PostgreSQL and matches a direct bounded ClickHouse check. Capture `EXPLAIN (VERBOSE)` to prove filter and aggregate pushdown for this query, plus a ten-row ordered sample to verify type mapping. Other query shapes are not certified by this test. Keep the extension's semantic session defaults when adding resource limits. A stopped ClickHouse service must cause a bounded foreign-query failure while an independent local PostgreSQL ledger transaction still commits; after restart the query must succeed again. No distributed atomicity or automatic synchronization is claimed.

Keep backend and persistence work in Rust. The synthetic probe is a test harness with a dedicated Temporal task queue and namespace; it does not add a Next.js database route or a second application backend. Its bounded activity writes a sequence number and checksum to the synthetic ledger, then reads them back. Repeated delivery of the same run/sequence key is idempotent. The workflow waits across a worker restart so replay is exercised, rather than measuring only a short completed RPC.

The plan must identify a supported Rust Temporal integration, its exact version, API and replay checks. A mock worker, a TypeScript replacement or a Temporal CLI command alone does not satisfy the Rust-worker requirement. If a supported integration cannot be demonstrated, report BLOCKED and keep that portion of the experiment separate from a capacity pass. Do not implement the migration engine to fill this gap.

Build images outside the CX23. Transfer verified OCI archives over operator SSH so no new paid registry is required and no repository token is placed on staging. Record the source commit, build commands, image digests, archive checksums and architecture. Run actual pinned service images and configuration, not floating quickstart tags. The reviewed plan must resolve current stable releases, compatible PostgreSQL/schema versions, supported Temporal initialization/upgrade order and ClickStack configuration before deployment. Previously discussed Temporal 1.31.3 is not an approved image pin.

## Access, data and credentials

Preserve cloud firewall rules, protected-host settings, management configuration and the existing smoke deployment. Bind test HTTP/admin interfaces to loopback and reach them with operator SSH forwarding. Database, Temporal, MongoDB and OTLP listeners remain inside the test container network; they are not bound to public or shared trusted-network addresses. Do not expose an unauthenticated collector endpoint.

Use synthetic data, local test identities and scoped test credentials only. No customer source, GitHub installation token, production database secret, model key or email sending is needed. R2 uses the Reltide account `08b3e06cb2d437fff43076acee66e082`, immutable `eu` jurisdiction and private Standard storage. The reviewed plan may provision a dedicated `reltide-staging-capacity-backups` bucket within the recorded shared allowance; writing this spec does not provision it. Application and Temporal backups use distinct prefixes and scoped credentials. Controller backups and their bucket remain untouched.

Encrypt backups before upload, with a recovery recipient whose private key stays outside the source host. Keep short-lived local plaintext backup files owner-readable only and remove them after upload verification. Secret values, connection strings, recovery keys and authenticated request headers must be excluded from logs and reports.

## Resource controls

These are proposed pilot test limits, not existing deployed controls. The implementation plan must provide the exact per-container memory/PID limits and configurations within the following envelope, including any sidecar. If supported service minimums cannot fit, stop and report FAIL rather than lowering a supported minimum.

| Resource | Required bound |
| --- | --- |
| Test memory | Sum of test-container memory ceilings ≤3,072 MiB; existing services and OS remain measured separately |
| Swap | No added swap; record existing swap and swap-in/out. A steady-state pass requires no sustained swap activity |
| Database pools | Application probe ≤4 connections combined, including the analytics reader; Temporal combined persistence pools ≤16 connections, including visibility; each PostgreSQL instance ≤32 total connections |
| Worker | One executing activity and one active workflow; ≤1 start per 10 seconds, ≤1 pending submission, no unbounded retry or task queue |
| ClickHouse | One foreground search at a time, shared by HyperDX and foreign-table probes; query memory ≤128 MiB and query execution ≤5 seconds; background merges/mutations bounded to one each |
| Foreign-table analytics | One probe per 10 seconds, serialized with HyperDX; PostgreSQL statement timeout 5 seconds and client deadline 10 seconds. Fixture reader scans ≤20,000 rows / 2 MiB, returns ≤10 rows; overflow raises an error, not a partial success |
| Collector | Batch ≤256 events, queue ≤1,024 events and memory limit ≤96 MiB inside its container ceiling; bounded retry and explicit dropped/rejected counters |
| Telemetry | Three-day TTL for every trace/log/event data table; retain only synthetic data; no infinite application log files |
| Backup spool | ≤1 GiB combined local encrypted/plaintext/WAL staging files; application and Temporal base archives each ≤256 MiB for this fixture |
| Test R2 use | ≤1 decimal GB stored, ≤5,000 Class A and ≤20,000 Class B operations across the entire experiment and restore attempts |
| Host guard | Stop load for any OOM, unexpected repeated restart, memory available <512 MiB, root disk >70% used or <10 GiB free, or CPU >80% averaged over five minutes |

The database bounds include health checks and backup clients; leave explicit connection headroom for administration. Resolve configuration keys against the pinned services in the plan. Account for logging, image archives, Docker layers, database WAL, ClickHouse merges and restore volumes in disk measurements. Do not use Docker's container working-set total as a substitute for host memory available.

Apply the host guard before image transfer, seeding, every phase and continuously during load. Use one-second host/resource samples, aggregated into one-minute and five-minute windows. Record short CPU bursts separately; the sustained guard applies to a five-minute mean. Resource-limit rejections, telemetry drops and suppressed retries remain failures, even if the host survives.

## Workload and sequence

Use one run identifier and deterministic fixture seed. An operator machine drives load over SSH forwarding; load generation must not consume the CX23's test budget. Keep a sequential workload schedule so phase boundaries can be matched to resource samples.

1. **Preflight and idle:** verify the immutable build/manifest, labels, available disk, service health and network bindings. Capture 15 minutes with the complete stack idle. Confirm the synthetic probe can complete and no real integration is reachable through its configuration.
2. **Representative stored data:** seed application PostgreSQL with 100,000 indexed ledger rows, each containing a 1 KiB synthetic payload, and separately seed the 10,000-row ClickHouse analytics fixture. Seed ClickHouse with 2,592,000 current telemetry events, representing 10 events/second for 72 hours, each ≤1 KiB before encoding, plus 25,920 separately marked events older than 72 hours. Split telemetry events equally between logs and traces, using bounded batches of ≤256 and ≤200 events/second through the real ingestion path. Record accepted counts, compression, disk use and any drops. Stop immediately if a host guard trips. The aged-event fixture tests TTL configuration, not a claim that a multi-day soak was run.
3. **Ramp:** run 10-minute stages at 1, 3 and 5 HTTP requests/second total. Split traffic equally between the three Next.js shells and the Rust health endpoint, using a fixed published request list that includes static assets. At each stage ingest 10 telemetry events/second, perform one saved HyperDX search and one PostgreSQL foreign-table aggregate every 10 seconds, serialized through the same foreground-query permit. Start at most one synthetic workflow per 10 seconds, and only after its predecessor completes.
4. **Steady and soak:** continue the 5-request/second mix, ingestion/search and workflows for two hours. Each activity also writes/reads its bounded ledger row. Take encrypted backups of both PostgreSQL instances during this phase, with WAL archiving active. Record all HTTP outcomes, accepted/generated telemetry IDs and workflow/activity outcomes; do not silently discard warm-up failures or failed samples.
5. **Restart and replay:** under the same load, restart the test Rust worker, then Temporal, then each PostgreSQL instance, then ClickHouse/collector, one component at a time. During the labeled ClickHouse outage, prove foreign-query failure returns within 10 seconds, no backend/query is left running, and the local ledger still commits. A client timeout alone without backend cleanup is a failed check. Record induced outages separately. Wait for recovery and a healthy five-minute window between disruptions. A separately labeled workflow with a durable timer crosses the worker restart and must resume without duplicate ledger effects; its intentional timer is excluded from normal completion latency. MongoDB/HyperDX and each Next.js service also receive a controlled restart and health check.
6. **Restore:** stop submission, finish or account for every accepted workflow, then perform the two independent R2-only restore drills described below. Do not report recovery timing as normal request latency.
7. **Final steady window and teardown:** after successful restore, run a further 15-minute combined-load window and verify fixture checksums and telemetry/search counts. Export evidence before stopping test containers. Remove only confirmed test-owned resources after the report has been inspected; retain encrypted off-server recovery evidence within the test cap.

Telemetry event IDs distinguish accepted, queued, stored and expired events. Search must return known fixture IDs and representative recent time ranges. Verify the seeded cohort with bounded aggregate counts/checksums and deterministic sampled IDs; verify steady-state arrivals with per-batch counts and sequence watermarks. Account for normal expiry during the test and measure the stack's own telemetry separately from generated traffic. The expired marked cohort must disappear after a documented TTL/merge cycle within 60 minutes; actual table TTLs remain three days. A manual DELETE does not prove retention. During the soak, data growth is measured and extrapolated to 72 hours using observed stored bytes/event plus recorded index/WAL/merge overhead; the seeded dataset provides a measured retained-data baseline. Report extrapolation separately from observation.

## Service-level acceptance

The following thresholds define this synthetic pilot envelope. They do not promise production business-request performance.

| Metric | Pass requirement |
| --- | --- |
| HTTP, excluding labeled induced outages | No unexpected 5xx/timeouts; each endpoint's p95 ≤500 ms at every ramp/steady stage |
| Workflow | Task-queue delay p95 ≤5 seconds, completion p95 ≤10 seconds for the bounded activity, zero failed or unaccounted accepted workflows |
| Telemetry | Zero unaccounted drops/rejections; accepted steady-state batches searchable within 30 seconds; seed counts/checksums correct after expiry accounting; search p95 ≤2 seconds |
| Foreign-table analytics | Exact fixture results, verified type mapping and filter/aggregate pushdown; p95 ≤2 seconds outside labeled outages, no unexpected errors; least-privilege and outage-isolation checks pass |
| Host and containers | No OOM or unexpected restart; all resource guards respected; no sustained swap; all mandatory services present |
| Backup | Both encrypted archives uploaded, hash-verified after download, decryptable externally, and WAL archive freshness ≤5 minutes |
| Controlled restart | Each disrupted service becomes healthy within 120 seconds; workflow replay and ledger idempotency verified; full stack returns to the normal targets |
| Recovery | Each database independently restored from R2 into a clean volume, measured recoverable-point loss ≤5 minutes and restore-to-healthy time ≤30 minutes |

Report percentile sample counts and the measurement method. A component omitted, an unsupported configuration, an unavailable metric or an unfinished recovery drill is BLOCKED, not PASS. A breached target is FAIL. Even a passing experiment keeps production admission closed until the remaining MAX-11 and isolation/verification gates are satisfied.

## Database recovery drills

Application and Temporal PostgreSQL have separate full backups, WAL archives, encryption, restore commands and recovery evidence. Configure daily full backup intent and continuous bounded WAL archiving; during the experiment trigger actual full backups and wait for archived segments. Daily backup alone only supports up to 24-hour loss, so it cannot meet the five-minute target.

Write sequenced application watermarks and record Temporal workflow/history watermarks with timestamps while archiving. Simulate a source outage after recorded commits. Stop the relevant source services and restore into fresh test-owned volumes from downloaded/decrypted R2 objects and WAL only. The restore process must not read the source volumes, local archive spool or a container-layer copy. Keep the source volumes unmounted and intact until evidence is approved.

For application PostgreSQL, validate row counts, sequence/checksum watermarks, expected constraints and idempotent activity keys. For Temporal, validate recovered histories through the same pinned schema and Rust worker, then resume a known interrupted workflow. Record the newest recoverable committed watermark, lost commits, last verified WAL segment and elapsed time from restore start to healthy verification. Report database restore time separately from simulated service outage duration.

The application restore uses the same extension-capable image and verifies both `pg_clickhouse` library `0.10.0` and SQL extension `0.10`, restored foreign-server/table definitions and restricted mappings, then repeats the bounded foreign query. Missing libraries or a mismatched build fail recovery validation. PostgreSQL backup/WAL does not include remote ClickHouse rows: check those against the separately seeded fixture and label this as extension connectivity after restore, not ClickHouse disaster recovery. Retain the deterministic fixture recipe; future production analytics requires an explicit rebuild or backup policy before becoming relied-upon data.

Inject one test WAL-upload failure, confirm alerting and load/admission closure, and recover without deleting the last known good backup. Bound local spool growth; do not deliberately fill the root disk to test the alert. Validate cleanup and retention using only test objects. R2 caps are shared with controller backups and future jobs, so reserve remaining account storage/operations before every drill; an unknown balance blocks upload until reconciled.

These are clean-volume restores using off-server copies on the existing staging hardware. They do not establish recovery time after complete host loss, replacement stock, OS installation or network/key recovery. The report must keep those limitations explicit. Production database cutover in MAX-14 requires its own off-production recovery evidence with representative production data volume; the synthetic drill is a prerequisite, not a substitute.

## Failure, cleanup and spending

The first host guard or unexpected service failure stops new HTTP, workflow and telemetry submission. Preserve timestamps and accepted-work IDs; stop test services in dependency order if the host remains under pressure. Emit one labeled alert to a local test sink and record delivery; repeated failures must not create an unbounded notification loop. External notifications and customer email are outside this experiment.

Cleanup selects resources by the explicit project/run ownership manifest, not a broad container prune or server-name prefix. It cannot delete or rebuild staging, production, management, their Primary IPs, the trusted network, controller backups or preexisting volumes/containers. Cancellation preserves recoverable database backups and the evidence needed to explain the failure.

Existing hosts are already allocated. This experiment buys no VM, snapshot, volume, paid registry, model usage or domain. R2 operations/storage stay inside a reserved portion of the existing €2 monthly allowance. Include its consumed storage and operations in the budget ledger; no automatic paid fallback or quota overrun is permitted. If the stack fails to fit, report the limiting resource and a revised price/stock/outage proposal. Do not resize automatically or treat unavailable stock as a recovery strategy.

## Evidence and completion

Produce a reviewable report in `docs/evidence/` with a small machine-readable manifest and CSV summaries. Record source commit, all image digests/configuration hashes, host/type/OS identity, UTC phase boundaries, workload seed/rates/counts, resource samples, latency and queue distributions, restart/OOM events, drop accounting, retention results, R2 usage receipts, backup checksums and independent restore watermarks/timings. Do not commit raw secrets, full database archives or noisy unbounded telemetry.

Give capacity, analytics, retention, backup, restart and recovery each a PASS/FAIL/BLOCKED result, followed by the combined result. Include extension source/library/image pins, redacted pushdown plans, fixture results and outage-isolation checks. The report must distinguish observed values, projections, induced outages and untested production behavior. A repeatable command set must reproduce the fixture and report without relying on an operator's terminal history.

Before execution, verify the trusted baseline and the reviewed version/configuration manifest. Implementation checks include applicable Rust formatting, clippy and tests; generated API-contract checks if the API changes; Docker configuration/image validation; and the repository's required release/affected checks under the pinned toolchains. Preserve every required CI/security check. Human review and merge remain required.

This experiment supplies evidence to MAX-11, MAX-13 and MAX-14. It does not implement MAX-12's untrusted VM isolation, MAX-15's disposable-job lifecycle, MAX-20's model adapter or production deployment. OpenCode Go remains a candidate for MAX-20; its quota, disabled paid fallback, current data-handling terms and patch quality require separate verification before customer source is submitted.
