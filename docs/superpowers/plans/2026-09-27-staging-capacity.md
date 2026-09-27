# Staging Capacity and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce repeatable evidence of capacity, retention, restart and independent PostgreSQL/WAL recovery for the complete trusted stack on the existing staging CX23.

**Architecture:** A standalone Rust test crate runs the real Temporal workflow/activity and database probe. Repository tooling builds the pinned images off-host, validates ownership and resource guards, drives synthetic load from the operator machine, and produces a structured report. An isolated Compose project on staging includes every required service; production and management are outside the operation manifest.

**Tech Stack:** Rust 1.98.1, Temporal Rust SDK 1.0.0, Node 26.10.0, pnpm 12.6.0, existing Nx/Vitest, Docker Compose, PostgreSQL, Temporal, ClickStack, age and rclone with private R2 EU storage.

**Spec:** [Approved staging capacity and recovery design](../specs/2026-09-27-staging-capacity-design.md).

**Status:** Ready for plan review; execution method has not been selected. No product code, image build, deployment or backup bucket creation is performed by this planning change.

## Global Constraints

- Target only server `167541435`, `reltide-staging`, CX23, x86, Ubuntu 26.04, private address `172.30.0.3`, in `hel1`; reinspect before mutation.
- Use one isolated deployment project, `reltide-capacity`, with explicit labels on every test container, volume and network.
- Build images outside the CX23; transfer verified OCI archives over operator SSH. Preserve existing proxy, Sentinel, smoke service, firewall and host protections.
- Sum of test-container memory ceilings ≤3,072 MiB; memory available <512 MiB, root disk >70% used or <10 GiB free, any OOM/unexpected repeated restart, or CPU >80% averaged over five minutes stops load.
- No added swap; a steady-state pass requires no sustained swap activity. Sample host/resources every second and retain one-minute/five-minute windows.
- Application probe ≤4 connections; Temporal combined persistence pools ≤16 including visibility; each PostgreSQL instance ≤32 total connections.
- One executing activity and one active workflow; ≤1 start per 10 seconds, ≤1 pending submission, bounded retry.
- One foreground ClickHouse search; query memory ≤128 MiB, execution ≤5 seconds, background merges/mutations bounded to one each.
- Collector batch ≤256 events, queue ≤1,024 events, memory limit ≤96 MiB inside its container ceiling; bounded retry and explicit dropped/rejected counters.
- Three-day TTL for every trace/log/event data table; no infinite application log files.
- Backup spool ≤1 GiB; each synthetic base archive ≤256 MiB. Test R2 use ≤1 decimal GB, ≤5,000 Class A and ≤20,000 Class B operations across all attempts, inside reserved account allowances.
- R2 account `08b3e06cb2d437fff43076acee66e082`, private Standard bucket `reltide-staging-capacity-backups`, immutable `eu` jurisdiction; distinct application/Temporal prefixes and scoped credentials.
- No customer source, real integration/model/email requests, paid fallback, new compute, automatic resizing or external notifications. Encrypt before upload; recovery private keys stay outside the source host.
- Do not weaken required checks or publish a migration PR. MAX-11 remains open until all its acceptance evidence, including billing and admission controls, is complete.

## Review Focus

1. A wrong/replaced host or an existing resource with a similar name must cause rejection before mutation; ownership requires verified IDs and labels, not a name prefix. Task 3 tests this.
2. A lost acknowledgement after a committed activity must preserve exactly one ledger effect, including after restart and replay. Tasks 1 and 6 test this.
3. A missing sample, drifting clock or truncated evidence must never produce a capacity or recovery PASS. Tasks 3 and 7 test this.
4. Upload timeouts, exhausted shared quotas and missing WAL must stop new load and preserve the last recoverable backup. Tasks 5 and 6 test this.
5. Small collector batches, expired seed events and service-generated telemetry must be counted separately so buffering, TTL or dropping cannot disguise ingestion loss. Task 4 tests this.

## Decisions and source snapshot

The native [Rust SDK 1.0.0 release](https://github.com/temporalio/sdk-rust/releases/tag/v1.0.0) is generally available; the installed Temporal skill's Public Preview text is stale. Use the [1.0 worker API](https://docs.temporal.io/develop/rust/workers/worker-process), `Runtime::from_current_tokio`, fallible workflow registration, SDK timers and the SDK workflow replayer. Do not disable nondeterminism detection or enable experimental/Wasmtime features.

Pin direct Rust dependencies exactly: `temporalio-sdk`, `temporalio-client`, `temporalio-common`, `temporalio-macros`, `temporalio-workflow` each `=1.0.0`; `futures =0.3.34`, `tokio =1.53.1`, `tokio-postgres =0.7.18`, `deadpool-postgres =0.14.2`, `serde =1.0.229`, `serde_json =1.0.151`, `sha2 =0.11.0`, `thiserror =2.0.21`. SDK runtime features are `envconfig` and `prometheus` with defaults disabled; `testing` is a dev-dependency feature. Use the client's `vendored-protox` feature rather than assuming a host protobuf compiler. Keep the repository's existing default/no-default/all-features verification matrix.

The following linux/amd64 manifests were inspected read-only on 27 September. Task 2 records them in `images.lock.json`, verifies downloads and records build-input digests. A release tag is not sufficient when its artifact is absent.

| Image | Version | Verified amd64 manifest digest |
| --- | --- | --- |
| `temporalio/server` | `1.32.0` | `sha256:ca47d4de249b9cc28137628dba77ae5e75e8b313ebb5c801c64615c1c99cbb09` |
| `temporalio/admin-tools` | `1.32.0` | `sha256:8bb84e24db4336de48031a66dbda25a7477d300736fe825893e467042135da1f` |
| `temporalio/ui` | `2.54.1` | `sha256:1f950ff598c810f371c60f1bf16de742caa6b8f60e0cdba05526a434e09b6d43` |
| `postgres` (application) | `18.6-bookworm` | `sha256:9e73daeb439141c2b11eea2463f5f1a3b269fd90d897b41cddb7cb440f21aa5d` |
| `postgres` (Temporal) | `16.15-bookworm` | `sha256:efdf07c2f9d4df592783dcc8ea5f6db02efbf5f6452b527225ff5e58364570e9` |
| `docker.hyperdx.io/hyperdx/hyperdx` | `2.39.1` | `sha256:0f88ad527e43f8352f7decc44381c8741c4d5e0122429e95986e14340b98f3dc` |
| `docker.clickhouse.com/clickhouse/clickstack-otel-collector` | `2.39.1` | `sha256:03c4a2066e2e4de3d93c27733742a535924746dd55a7e117ceaff3d1d34e7d19` |
| `mongo` | `8.0.32` | `sha256:a70d9916fd916ddfdf6fd8552784c599eb26f88c59951c7bcdc50abd158e8be7` |
| `clickhouse/clickhouse-server` | Required release `26.9.4.3` | Artifact unavailable at inspection; Task 2 must resolve and verify it before deployment |

Application PostgreSQL uses the current stable major; Temporal keeps separate PostgreSQL 16 persistence with the matching `postgres12` schema plugin and real compatibility tests. PostgreSQL 16.15 and 18.6 are [supported current patches](https://www.postgresql.org/support/versioning/). Follow [Temporal's server/schema sequence](https://docs.temporal.io/self-hosted-guide/deployment), not the auto-setup image or dev server, for capacity evidence.

Use rclone `1.75.1` and age `1.3.2`, with release-asset checksums recorded before including their binaries in PostgreSQL/backup images. MongoDB `8.0.32` is the current supported 8.0 patch; [its kernel advisory](https://www.mongodb.com/docs/v8.0/release-notes/8.0/) requires checking the effective upstream kernel and actual startup. Staging reports `uname -r` = `7.0.0-34-generic` and `/proc/version_signature` = `Ubuntu 7.0.0-34.34-generic 7.0.14`. Do not infer compatibility from the Ubuntu ABI string alone; a failed MongoDB startup blocks the experiment and does not authorize an OS change.

## File structure

| Unit | Files and responsibility |
| --- | --- |
| Real Rust probe | `crates/capacity-probe/{Cargo.toml,project.json,src/{lib,protocol,ledger,workflow,worker,client}.rs,src/bin/reltide-capacity-probe.rs,tests/{protocol,ledger,replay}.rs}`; typed input/results, SQL activity, SDK worker/client/replay |
| Combined stack | `infra/capacity/{project.json,compose.json,limits.json,images.lock.json,Dockerfile.next,Dockerfile.rust,Dockerfile.postgres,config/{app-postgres.conf,temporal-postgres.conf,temporal.yaml,clickhouse.xml,clickhouse-users.xml,collector.yaml},sql/ledger.sql}`; pinned images, private access and applied bounds |
| Safety and load tooling | `tools/capacity/{config,host,load,run}.mjs` and matching `.test.mjs`; validation, inventory/ownership, host guards, streaming load and phases |
| Recovery tooling | `infra/capacity/backup/{archive-wal,full-backup}.sh`, `tools/capacity/recovery.mjs` and `.test.mjs`; bounded encrypted R2 copies and clean-volume restore |
| Evidence | `tools/capacity/report.mjs` and `.test.mjs`, `docs/evidence/2026-09-27-capacity/{README.md,manifest.json,summary.csv}`; evaluator and observed/projection results |
| Existing integration | Root `Cargo.toml`, `Cargo.lock`, `.gitignore`, `tools/rust-workspace.test.mjs`, `docs/maintenance.md`, `docs/decisions/pilot-budget.md`; workspace/affected graph, private scratch exclusion and operator instructions |

Keep `apps/api`, `apps/worker`, Next.js product logic and the generated API contract unchanged. The new probe is the real test worker; it does not certify the empty product worker or future business traffic. New code starts only after this plan is reviewed and an execution method is selected.

### Task 1: Implement the real Rust workflow and idempotent ledger probe

**Files:** Create the Rust probe files and `infra/capacity/sql/ledger.sql` above; modify root `Cargo.toml`, `Cargo.lock`, and the graph assertions in `tools/rust-workspace.test.mjs:23` and `:77`.

**Interfaces:** Consumes the approved spec and exact dependency pins. Produces JSON protocol version `1`: `ProbeInput { run_id: String, sequence: u64, payload: String, hold_seconds: u32 }`, `ProbeOutput { run_id: String, sequence: u64, sha256: String }`, `ProbeConfig { temporal_address: String, namespace: String, task_queue: String, application_database_url: String }`, `ProbeError` variants `Validation`, `Database`, `Temporal`, `Io`, and tagged events `started`, `completed`, `watermark`, `history`. Every event includes `protocol_version`, `run_id` and UTC timestamp; watermarks include sequence, checksum and post-commit time. `ProbeConfig` has a redacted Debug implementation. CLI subcommands are `worker`, `start`, `seed-ledger`, `verify-ledger`, `history`, `replay`; request data arrives on stdin, secrets through a restricted environment file.

- [ ] **Step 1:** Add failing protocol tests named `rejects_unsafe_run_id`, `rejects_sequence_above_pg_bigint`, `rejects_payload_above_1024_bytes`, and `rejects_hold_above_60_seconds`. Assertions include `validate(input_with_sequence(u64::MAX)).is_err()` and `validate(input_with_payload_bytes(1025)).is_err()`. Run IDs accept only `[a-z0-9-]{1,64}`; namespace/task queue are `reltide-capacity-<run_id>`.
- [ ] **Step 2:** Run `cargo test -p reltide-capacity-probe --test protocol --locked`. Expect failure because the crate/interfaces do not yet exist.
- [ ] **Step 3:** Implement `validate(input: &ProbeInput) -> Result<(), ProbeError>` in `protocol.rs`, the CLI decoder and JSON event encoder. Add the crate/Nx project and exact dependencies; enable only needed Tokio features. Errors must not print secret-bearing DSNs.
- [ ] **Step 4:** Add `committed_retry_keeps_one_effect` and `conflicting_retry_is_rejected` integration tests for `record(self: Arc<Self>, ctx: ActivityContext, input: ProbeInput) -> Result<ProbeOutput, ActivityError>`. Schema primary key is `(run_id, sequence)`; parameterized INSERT uses `ON CONFLICT DO NOTHING`, then validates the stored checksum. A mismatching repeated payload is an error, not an UPDATE. Enable commit timestamps for the test database and emit verified post-commit watermarks.
- [ ] **Step 5:** Implement `CapacityWorkflow::run(ctx: &mut WorkflowContext<Self>) -> WorkflowResult<ProbeOutput>` in `workflow.rs` using SDK `execute_activity` and `ctx.timer` only. Activity start-to-close is 5 seconds, schedule-to-close 10 seconds, max attempts 2. The durable `hold_seconds` timer is only for labeled replay/recovery probes. Configure fixed one-workflow/one-activity slots, cache 1, bounded pollers and graceful shutdown; leave nondeterminism detection enabled.
- [ ] **Step 6:** Implement `start_probe(input: &ProbeInput, config: &ProbeConfig) -> Result<ProbeOutput, ProbeError>` and `replay_history(path: &Path) -> Result<(), ProbeError>` in `client.rs`. Use SDK 1.0 `WorkflowReplayer`; the client runs on the operator machine through SSH forwarding. Add graph tests that the new crate exists and Cargo/toolchain changes affect it and `capacity-experiment`.
- [ ] **Step 7:** Run protocol/unit tests, `cargo clippy -p reltide-capacity-probe --all-targets --locked -- -D warnings`, and `pnpm test:rust-graph`. Expect passing unit/graph checks. Real database/replay tests run against Task 2's local stack and must pass before staging.
- [ ] **Step 8:** Commit as `feat: add synthetic Rust capacity probe`.

### Task 2: Build and validate the complete private stack off-host

**Files:** Create the combined stack/configuration/Dockerfiles listed above and `tools/capacity/config.mjs`, `config.test.mjs`; modify `.gitignore` to exclude `.capacity/` scratch files.

**Interfaces:** Consumes Task 1's release binary and protocol. Produces `StackManifest { source_commit, platform, images, config_sha256, services, resource_limits }`; `validateStack(manifest, compose, limits) -> string[]` returns rejection reasons. `capacity-experiment:check-config`, `:build-images`, `:integration` and all future live targets have `cache: false`, with explicit Nx dependencies on the three shells, API and probe. `:integration` runs local Docker correctness checks with synthetic credentials and never uses hcloud, SSH or R2; its results are not host capacity evidence.

- [ ] **Step 1:** Add failing config tests named `rejects_missing_required_service`, `rejects_unpinned_image`, `rejects_public_or_trusted_network_bind`, and `rejects_memory_sum_over_3072`. Assertions include `validateStack(fixtureWithout("mongo"), compose, limits).length > 0` and rejection of a `0.0.0.0` or `172.30.0.3` published binding. Run `pnpm exec vitest run tools/capacity/config.test.mjs`; expect import/config failure.
- [ ] **Step 2:** Implement `validateStack` and `limits.json`. Initial memory ceilings in MiB are app 128, web 96, docs 128, API 64, probe 96, application PG 192, Temporal PG 192, Temporal 448, Temporal UI 64, ClickHouse 768, collector 128, HyperDX 256, MongoDB 384 and one transient admin/backup helper 128: total 3,072. MongoDB's WiredTiger cache is 0.25 GiB. Set per-container PID ceilings to 128, except Temporal/ClickHouse/HyperDX at 256, and container memory+swap ceilings equal memory ceilings. Only one transient helper may run at a time. A service's documented unsupported configuration/minimum or any OOM is a failure; these allocations are test ceilings, not a capacity claim.
- [ ] **Step 3:** Resolve the required ClickHouse release artifact and build-input manifests for Node `26.10.0-bookworm-slim`, Rust `1.98.1-bookworm`, Debian bookworm-slim, age and rclone. Write exact digests/checksums into `images.lock.json`; missing artifacts return BLOCKED, with no silent downgrade or floating tag. Build linux/amd64 Next/API/probe and modified PostgreSQL images locally, recording checksums and secret-free OCI archives in ignored `.capacity/<run_id>/`. No image build runs on staging.
- [ ] **Step 4:** Implement Compose JSON with two separate PostgreSQL instances/volumes, Temporal, UI, all ClickStack components and actual shell/API/probe images. Publish only HTTP/admin ports on `127.0.0.1`: app 13000, web 13001, docs 13004, API 13002, Temporal UI 18080, HyperDX UI/API 18081/18000. Shell container ports stay 3000/3001/3004 with `HOSTNAME=0.0.0.0`; API uses `RELTIDE_API_BIND=0.0.0.0:3002` inside its container only, and app uses `RELTIDE_API_BASE_URL=http://api:3002`. Other listeners remain on the owned container network; operator forwards to verified container IPs for Temporal, database probes and authenticated OTLP. Disable usage analytics and external notification integrations.
- [ ] **Step 5:** Apply PostgreSQL `max_connections=32`, `shared_buffers=32MB`, `work_mem=1MB`, `max_parallel_workers=0`, `track_commit_timestamp=on`, `wal_level=replica`, `archive_mode=on`, `archive_timeout=120s`, and `max_wal_size=256MB`. Worker/seeder pools share the four-connection application limit. Temporal default/visibility stores each use `maxConns=2`, `maxIdleConns=1`; measure aggregate connections across all server services rather than assuming config values equal the total. Application PG18 mounts its versioned data root; PG16 uses its own explicit PGDATA. Never mount a source volume into the other version.
- [ ] **Step 6:** Initialize Temporal using matching 1.32.0 SQL tooling: setup empty schema version 0.0, then update temporal and visibility schemas from the same image's `postgresql/v12` directories before starting the server. Register the three-day test namespace; record schema versions. Do not add Elasticsearch or use a CLI dev server for capacity evidence.
- [ ] **Step 7:** Apply ClickHouse `max_threads=1`, `max_memory_usage=134217728`, `max_execution_time=5`, `background_pool_size=1`, `background_merges_mutations_concurrency_ratio=1`, `background_schedule_pool_size=2`; set `number_of_free_entries_in_pool_to_execute_mutation`, `number_of_free_entries_in_pool_to_lower_max_size_of_merge`, and `number_of_free_entries_in_pool_to_execute_optimize_entire_partition` to zero. Use distinct ingest/read-only UI users and `async_insert=1`, `wait_for_async_insert=1`, 1 MiB async buffer, 1-second flush. Per `insert-async-small-batches`/`insert-batch-size`, ≤256-event OTLP batches require buffering rather than thousands of synchronous tiny parts. Per `insert-optimize-avoid-final`, do not use `OPTIMIZE FINAL` to manufacture retention results. Bound audit logs and configure three-day TTL plus `merge_with_ttl_timeout=300` on every generated telemetry table after discovering actual schema.
- [ ] **Step 8:** Apply collector memory limiter 96 MiB, batch 256, exporter queue 1,024, one consumer, retry elapsed limit 10 seconds, authenticated ingestion and a scoped database user. Verify effective collector/OpAMP configuration cannot silently widen these bounds. Run `pnpm nx run capacity-experiment:integration` to start the complete local stack, supply ephemeral connection settings, execute `cargo test -p reltide-capacity-probe --test ledger --test replay --locked -- --ignored`, and check real ingestion/search/TTL. Run `docker compose -f infra/capacity/compose.json config --format json` and config unit tests. Expect all services/config tests healthy without external integration requests. This is correctness preflight, not CX23 capacity evidence.
- [ ] **Step 9:** Commit as `feat: configure pinned staging capacity stack`.

### Task 3: Enforce host identity, sampling, guards and ownership

**Files:** Create `tools/capacity/host.mjs`, `host.test.mjs`; add offline/preflight targets to `infra/capacity/project.json`.

**Interfaces:** Consumes `StackManifest`. Produces `HostSample { utc, monotonic_ms, mem_available_bytes, root_used_ratio, root_free_bytes, cpu_busy_ratio, swap_in_bytes, swap_out_bytes, oom_count, containers }`, `OwnershipManifest { run_id, server_id, project, container_ids, volume_ids, network_ids }`; `evaluateGuard(samples) -> { stop, reasons }`, `cleanupSelection(ownership, observed) -> resource IDs`, and `preflight(inventory, guest, manifest) -> rejection reasons`.

- [ ] **Step 1:** Add failing tests for wrong server ID, replaced volume, mixed-run labels, absent kernel evidence and partial metrics. Include `assert.deepEqual(cleanupSelection(manifest, unrelatedResources), [])`; wrong host must produce zero mutation commands. Run `pnpm exec vitest run tools/capacity/host.test.mjs`; expect missing interfaces.
- [ ] **Step 2:** Implement authenticated `hcloud --context reltide` inventory reads and SSH identity checks, with argument arrays and fixed remote scripts. Check server/type/region/architecture, protection, network and existing service identities. Record both kernel strings and MongoDB health; reject stale inventory or unknown stock/identity. Mutations may only target recorded test containers/volumes/networks; expose no cloud-server deletion or resize command.
- [ ] **Step 3:** Implement one-second host/container sampling using `/proc`, `df`, Docker inspection/stats and OOM events. Use monotonic time for windows, UTC for phase correlation. Missing samples for >3 seconds or clock offset >1 second yields BLOCKED and stops load. Tests assert stop at 511 MiB available, >70% used, <10 GiB free, an OOM, or >80% five-minute mean; CPU bursts alone must not satisfy the sustained condition.
- [ ] **Step 4:** Implement safe guard-stop and explicit cleanup selection. Stop new load first; preserve evidence and source volumes. Require a matching server ID plus project/run labels before every destructive container/volume operation. Preserve all preexisting resources; no prune command.
- [ ] **Step 5:** Run host/config unit tests and a read-only staging preflight. Expect either verified identity with no mutations or an explicit BLOCKED reason. Commit as `feat: guard capacity host operations`.

### Task 4: Generate bounded HTTP, database and telemetry workloads

**Files:** Create `tools/capacity/load.mjs`, `load.test.mjs`; extend Rust seeding/verification CLI and add `infra/capacity/workload.json`.

**Interfaces:** Consumes Task 1 client and Task 3 guard signal. Produces streaming events `LoadEvent { phase, kind, sequence, accepted_at, completed_at, outcome }`; `seedTelemetry(seed, count, send, stop) -> counts`, `runLoad(phase, clients, stop) -> phase result`. Never accumulate the full seeded dataset in memory.

- [ ] **Step 1:** Add failing tests `seed_is_repeatable_and_bounded`, `splits_logs_and_traces_equally`, `expired_rows_are_not_drops`, `cancellation_stops_new_submissions`, and `accepted_queue_rows_are_not_stored_rows`. Check `maxBatch <= 256`, `seedRate <= 200`, `queuePending <= 1` for workflows, and separate service-generated traffic. Run `pnpm exec vitest run tools/capacity/load.test.mjs`; expect missing interfaces.
- [ ] **Step 2:** Implement fixed request discovery for each root page and its current production static assets; freeze the request list in the run manifest. Stream synthetic OTLP JSON logs/traces with deterministic IDs and payload ≤1 KiB before encoding, using scoped ingestion credentials. Produce 2,592,000 current events and 25,920 marked aged events, split equally; seed the 100,000-row 1 KiB PostgreSQL ledger using the Rust client. Record insertion time versus event time and compression/part counts.
- [ ] **Step 3:** Implement 15-minute idle, 10-minute 1/3/5-request-per-second ramps, two-hour soak, and final 15-minute load window. Split HTTP requests equally across app/web/docs/API; steady telemetry is 10 events/second and one real saved HyperDX search per 10 seconds. Start a workflow at most every 10 seconds, after its predecessor finishes; request warm-up results remain accounted for.
- [ ] **Step 4:** Verify ingestion with bounded per-batch sequence/count queries and seed aggregates/checksums plus deterministic sampled IDs. Discover columns/sort keys before queries; include time ranges, limits and server timeouts. Verify marked aged rows expire through normal TTL/merge within 60 minutes, without manual deletion or forced final merge. Record expected normal expiry and the stack's own events separately. At three-day retention, report observed stored bytes and a labeled growth projection.
- [ ] **Step 5:** Run offline load tests and a shortened local correctness run through actual collector/HyperDX/SQL. Expect exact accepted-versus-stored accounting and successful guard cancellation. Commit as `feat: drive bounded synthetic capacity load`.

### Task 5: Create bounded encrypted database and WAL backups

**Files:** Create backup scripts, `tools/capacity/recovery.mjs`, `recovery.test.mjs`; extend PostgreSQL images/config from Task 2.

**Interfaces:** Consumes validated ownership, quota reservation and image/database versions. Produces `BackupReceipt { kind, server_version, system_identifier, timeline, base_id, wal_range, encrypted_sha256, bytes, uploaded_at, operations_reserved }`; `reserveR2(ledger, plannedOperations) -> reservation or rejection`, `verifyReceipt(receipt, downloadedBytes) -> rejection reasons`.

- [ ] **Step 1:** Add failing tests for unknown/shared exhausted quota, size >256 MiB base archive, spool >1 GiB, upload timeout, corrupt downloaded ciphertext and wrong database system identifier. Assert last-good receipt remains present after failure and no additional submission is admitted. Run `pnpm exec vitest run tools/capacity/recovery.test.mjs`; expect missing helpers.
- [ ] **Step 2:** Implement scoped private EU bucket setup/verification only after quota reconciliation. Credentials use restricted files/environment, never command arguments or logs; R2 tokens are bucket-scoped, not falsely represented as prefix IAM. Prefix selection is validated by trusted tooling. Use the EU-specific S3 endpoint. Controller objects/bucket are excluded.
- [ ] **Step 3:** Implement synchronous WAL archiving: compress, age-encrypt using public recipient, atomically stage, upload and verify success before returning zero. Reuse staged ciphertext on retries. Use rclone single transfer/checker, no traversal, one high-level/low-level attempt, 4 MiB buffer and 512 MiB multipart cutoff; test the actual request bound with the local S3 fixture and reserve it before each action. Record attempted/uncertain operations. A failed upload sets a persistent archive-pause latch: PostgreSQL's retries return failure without more R2 requests until the coordinator explicitly resumes after reconciliation. Never use verbose authenticated header dumps. Missing quota accounting blocks new requests. Alert to the local test sink only.
- [ ] **Step 4:** Implement same-major `pg_basebackup` plus streamed WAL and backup manifest, sequential application/Temporal backups, externally verified downloads/checksums and source-host spool cleanup. Record server identity/version and continuous WAL freshness. Configure daily full backup intent, trigger real backups during soak, preserve last good copies on any error. Keep one 128 MiB helper at a time; source archiver processes remain inside PostgreSQL's measured ceiling.
- [ ] **Step 5:** Exercise actual encrypted round trips against a temporary local S3 fixture for request/error tests, then private R2 only during reviewed execution. Inject one WAL-upload failure and verify load closure, retry bound, spool guard and subsequent recovery. The fake S3 test proves error handling; it is not off-server recovery evidence. Commit as `feat: bound encrypted capacity backups`.

### Task 6: Prove controlled restarts and independent R2-only recovery

**Files:** Extend `recovery.mjs`, Rust `tests/replay.rs`, and create `tools/capacity/run.mjs`, `run.test.mjs`.

**Interfaces:** Consumes every earlier interface. Produces `RestartResult { service, outage_start, healthy_at, replay_result }`, `RestoreResult { kind, source_volume_unmounted, input_receipts, target_volume, recovery_cut, lost_commits, rpo_seconds, rto_seconds, checks }`; `restoreDatabase(kind, receipts, ownership, recoveryCut) -> RestoreResult` and `runExperiment(config, stop) -> run directory`.

- [ ] **Step 1:** Add failing tests for prohibited source-volume mount, wrong PostgreSQL major/timeline, a missing required WAL segment, ciphertext corruption, cancelled coordinator, and duplicate activity effect after a lost acknowledgement. Assert `RestoreResult` cannot claim PASS without `source_volume_unmounted` and valid receipts. Run local replay tests and `pnpm exec vitest run tools/capacity/run.test.mjs tools/capacity/recovery.test.mjs`; expect new cases to fail.
- [ ] **Step 2:** Implement the reviewed phase state machine and bounded restart schedule: worker, Temporal, each PostgreSQL, ClickHouse/collector, MongoDB/HyperDX and each shell, individually. Mark induced outages, verify readiness within 120 seconds, then require a healthy five-minute window before another disruption. Keep one durable-timer workflow across worker restart and replay its saved history with the same SDK/build.
- [ ] **Step 3:** Choose a common recoverable UTC cut from independently verified application/Temporal backup and WAL watermarks; require loss ≤300 seconds for each. Stop source services, leave their volumes unmounted/intact, and restore each database into a fresh owned volume from downloaded R2 ciphertext/WAL only. Decryption runs on the operator machine; the private key is never installed on staging. Include download/decryption/restore/verification in measured restore-to-healthy time.
- [ ] **Step 4:** Verify application count/checksum/constraints/idempotent keys and Temporal histories/interrupted workflow resumption; detect mismatched recovery points or missing ledger effects rather than reporting success. Each restore must complete within 1,800 seconds. Test rollback of a failed restore by preserving source volumes and rejecting the new target; do not rewrite or delete source data.
- [ ] **Step 5:** Run local restart/recovery correctness checks and all offline tests. Expect saved-history replay, exactly one effect after lost acknowledgement, and explicit failure for source-assisted or incomplete restores. Commit as `feat: verify capacity restarts and database recovery`.

### Task 7: Evaluate evidence without converting uncertainty into PASS

**Files:** Create `tools/capacity/report.mjs`, `report.test.mjs`; modify `docs/maintenance.md` and `docs/decisions/pilot-budget.md` to link commands and the evidence contract.

**Interfaces:** Consumes run events, host samples, backup receipts and restore results. Produces `evaluateRun(evidence) -> { capacity, retention, backup, restart, recovery, combined }`, each `PASS | FAIL | BLOCKED`, and a redacted JSON/CSV/Markdown report under the evidence directory. Combined result is FAIL if any component fails, otherwise BLOCKED if any is incomplete, otherwise PASS. `node tools/capacity/report.mjs --verdict <run-directory>` exits 0/1/2 for PASS/FAIL/BLOCKED; missing reports exit 2.

- [ ] **Step 1:** Add failing report tests for one missing service, missing/truncated samples, missing restore, induced outages, mixed run IDs, counter reset and unlabelled projections. Assertions include `evaluateRun(completeExceptRestore).combined === "BLOCKED"`, failure when HTTP p95 is 501 ms, and failure when restore loss is 301 seconds. Run `pnpm exec vitest run tools/capacity/report.test.mjs`; expect missing evaluator.
- [ ] **Step 2:** Implement endpoint-specific p95 with sample counts, workflow delay/completion p95 ≤5/10 seconds, HTTP p95 ≤500 ms with zero unexpected 5xx/timeouts, steady telemetry searchable ≤30 seconds and search p95 ≤2 seconds. Any OOM, unexpected restart, guard breach, drop/rejection or failed required check yields FAIL; absent evidence yields BLOCKED. Only predeclared restart/restore/WAL-fault windows with verified ownership may be treated as induced; preserve their durations and require their expected recovery checks. An OOM is never excluded as an induced outage.
- [ ] **Step 3:** Serialize image/config hashes, host identity, UTC phases, seed/rates/counts, resource windows, retention/accounting, receipt hashes, restore watermarks and timings. Keep full archives/raw secret-bearing logs outside Git. Label synthetic-shell coverage, projections and clean-volume recovery; do not claim cold-host RTO or future business-request performance.
- [ ] **Step 4:** Run report tests, the complete offline test set, `pnpm check` and `git diff --check`. Expect correct classifications and no secret values in fixtures/reports. Commit as `feat: report measured capacity and recovery outcomes`.

### Task 8: Run the reviewed experiment and hand off measured results

**Files:** Populate `docs/evidence/2026-09-27-capacity/{README.md,manifest.json,summary.csv}` with observations; update pilot-budget remaining acceptance and Linear MAX-11 with the result.

**Interfaces:** Consumes a reviewed branch, verified images, available R2 reservation and all prior test results. Produces real PASS/FAIL/BLOCKED evidence, resource/cost consumption and a resize proposal only if measurements require it.

- [ ] **Step 1:** Refresh repository context with `graft build`, then run `pnpm ci:release`, `pnpm nx run capacity-experiment:check-config`, local full-stack integration checks, and `NX_BASE=<reviewed-base-sha> NX_HEAD=<branch-head-sha> pnpm ci:affected`. Preserve all Rust feature matrices and required statuses; expect passing code/config checks, not a predicted live capacity pass. Reinspect current stable versions and reject unreviewed image/config changes.
- [ ] **Step 2:** Obtain the independent review required by the selected execution workflow and resolve findings. Reconcile existing Coolify PR #16's shared budget changes against this branch before presenting a PR; do not merge it, edit its protected settings, or overwrite another checkout's work.
- [ ] **Step 3:** Run authenticated staging/R2 preflight; reserve remaining account storage/operations. Verify baseline service identities, kernel/startup compatibility, encrypted recovery key availability and all image digests. An unavailable ClickHouse image, unknown quota, failing baseline or unsupported configuration produces BLOCKED before deployment.
- [ ] **Step 4:** Deploy only owned test resources and run `pnpm nx run capacity-experiment:run`. Drive the full approved sequence; stop at the first guard. Monitor progress without retrying a failed experiment into a false pass. The run command exits zero only when a complete classified report is written. Run `pnpm nx run capacity-experiment:verdict --run-directory=<path>` using Task 7's 0/1/2 result codes so measurement completion cannot be confused with admission.
- [ ] **Step 5:** Review/export the report, verify test-owned cleanup and retained encrypted recovery copies, reconcile R2 consumption and any unsettled costs, and rerun changed-file checks. A failed capacity result records the actual limiting resource and a current price/stock/outage proposal; it does not resize or close MAX-11. Billing receipts, cold-host recovery and customer-job admission controls remain explicitly separate acceptance gaps.
- [ ] **Step 6:** Commit the measured report as `docs: record staging capacity and recovery evidence`. Prepare a draft infrastructure PR only after baseline/version/evidence and independent checks are complete; attach the PR to this chat and update MAX-11 without claiming production readiness. Human review/merge remains required.

## Plan self-review and handoff

Coverage: Tasks 1–2 provide the real Rust/trusted stack and applied bounds; Task 3 enforces identity/ownership/host guards; Task 4 covers seeded retention and combined load; Tasks 5–6 cover backup failure, restarts and independent recovery; Tasks 7–8 provide classifications, actual evidence, cleanup and budget reconciliation. All five review-focus conditions have owning tests. The plan introduces a capacity harness, not production deployment or the migration engine.

Execution dependencies are sequential: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Offline implementation/local verification precede live operations. Recommend subagent-driven execution because changes cross SDK replay, resource controls and recovery/cleanup interfaces, and each independently tested task benefits from a fresh review before the next uses it. The owner must review this plan and select an execution method before implementation.
