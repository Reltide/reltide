import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { evaluateGuard } from "./host.mjs";
import { integrate } from "./integration.mjs";
import {
  accountTelemetry,
  createForegroundPermit,
  createSavedSearch,
  createTelemetrySender,
  createSteadyTelemetry,
  discoverRequests,
  discoverTelemetry,
  runLoad,
  seedAnalyticsFixture,
  seedTelemetry,
  telemetryEvent,
  verifyTelemetryBatch,
  waitNormalExpiry,
  verifyUnchangedRetention,
  workload,
} from "./load.mjs";

/** Only the current host binary executes new analytics code. Evidence is streamed. */
export const runProcess = async ({
  program,
  args,
  env,
  input = "",
  onLine = () => null,
  signal,
  timeout_ms = 30_000,
}) => {
  signal?.throwIfAborted();
  const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  let forced = false;
  child.stderr.on("data", (data) => {
    errors = (errors + data).slice(-8192);
  });
  const consume = (async () => {
    try {
      /* eslint-disable no-await-in-loop -- Backpressure keeps streamed workflow evidence ordered and bounded. */
      for await (const line of createInterface({ input: child.stdout })) {
        output += `${line}\n`;
        if (output.length > 1_048_576) {
          forced = true;
          child.kill("SIGTERM");
          throw new Error("subprocess output bound exceeded");
        }
        if (line) {
          await onLine(line);
        }
      }
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  })();
  const cancel = () => child.kill("SIGINT");
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    forced = true;
    child.kill("SIGTERM");
  }, timeout_ms);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), timeout_ms + 2000);
  child.stdin.end(input);
  try {
    const [[code]] = await Promise.all([closed, consume]);
    assert.ok(
      !forced,
      "subprocess deadline/stream bound exceeded; cleanup is unverified"
    );
    assert.equal(code, 0, `capacity subprocess failed: ${errors}`);
    return output;
  } finally {
    try {
      await closed;
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
    }
  }
};

const rustInput = (run_id, sequence = 1) => ({
  hold_seconds: 0,
  payload: "x".repeat(1024),
  run_id,
  sequence,
});
const probe = async (command, input, env, emit, signal) => {
  const output = await runProcess({
    args: [command],
    env,
    input: JSON.stringify(input),
    onLine: async (line) => {
      await emit(JSON.parse(line));
    },
    program: path.resolve("target/debug/reltide-capacity-probe"),
    signal,
  });
  return JSON.parse(output.trim().split("\n").at(-1));
};

const remoteDiagnostic = (evidence) => {
  const backendGone =
    evidence?.backend_gone === true &&
    Number.isSafeInteger(evidence?.backend_pid) &&
    evidence.backend_pid > 0;
  const queryOutcome = ["cancelled", "completed", "failed"].includes(
    evidence?.query_outcome
  )
    ? evidence.query_outcome
    : "unavailable";
  const cancelled =
    evidence?.cancelled === true && queryOutcome === "cancelled";
  return {
    backend_gone: backendGone,
    backend_pid: Number.isSafeInteger(evidence?.backend_pid)
      ? evidence.backend_pid
      : null,
    cancelled,
    query_outcome: queryOutcome,
  };
};
/* eslint-disable no-await-in-loop -- Witness remote execution and cleanup serially before releasing the one foreground permit. */
export const verifyRemoteCleanup = async ({
  evidence,
  failure,
  fixture,
  observed,
  persist,
}) => {
  const diagnostic = remoteDiagnostic(evidence);
  let cleanupFailure;
  let cleanupFailureKind = "reader_cleanup_unverified";
  let remaining;
  try {
    assert.ok(
      diagnostic.backend_gone,
      "reader cleanup must be independently witnessed before remote observation"
    );
    cleanupFailureKind = "diagnostic_invalid";
    assert.ok(
      [
        diagnostic.query_outcome !== "unavailable",
        [true, false].includes(evidence.cancelled),
        evidence.cancelled === diagnostic.cancelled,
      ].every(Boolean)
    );
    assert.equal(observed.length, 1);
    assert.match(observed[0]?.query_id, /^.+$/u);
    const cleanupDeadline = Date.now() + 10_000;
    cleanupFailureKind = "remote_observation_failed";
    do {
      const sample = await fixture.observe();
      assert.ok(Array.isArray(sample?.data));
      for (const row of sample.data) {
        assert.match(row?.query_id, /^.+$/u);
      }
      remaining = sample.data.filter(
        (row) => row.query_id === observed[0].query_id
      );
      if (!remaining.length) {
        break;
      }
      await delay(20);
    } while (Date.now() < cleanupDeadline);
    cleanupFailureKind = "remote_query_remains";
    assert.equal(
      remaining.length,
      0,
      "remote query remains; foreground permit must not release successfully"
    );
  } catch (error) {
    cleanupFailure = error;
  }
  const result = {
    ...diagnostic,
    cleanup_failure: cleanupFailure ? cleanupFailureKind : null,
    permit_released_after_cleanup:
      !failure && !cleanupFailure && diagnostic.cancelled,
    remote_cleanup_verified: !cleanupFailure && remaining?.length === 0,
    remote_observed: observed,
    remote_remaining: remaining?.length ?? null,
  };
  try {
    await persist({ kind: "guard_cleanup", ...result });
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (failure) {
    throw failure;
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  assert.ok(result.cancelled && result.backend_gone);
  return result;
};
const remoteGuardCheck = async (context, env, foreground, persist, clients) => {
  await runProcess({
    args: [
      "test",
      "-p",
      "reltide-capacity-probe",
      "--lib",
      "--locked",
      "--no-run",
    ],
    env,
    onLine: (line) => persist({ kind: "rust_compile", line }),
    program: "cargo",
    timeout_ms: 120_000,
  });
  const fixture = await context.prepareRemoteCancellation();
  const gate = path.join(context.directory, "remote-cancel-gate");
  const evidencePath = path.join(context.directory, "remote-cancel.json");
  const controller = new AbortController();
  let guardLoad;
  const accepted = { telemetry: false, workflow: false };
  const cleanup = await foreground(async () => {
    guardLoad = runLoad(
      { duration_ms: 10_000, http_rps: 1, name: "guard-cancellation" },
      {
        ...clients,
        emit: async (event) => {
          await clients.emit(event);
          if (event.kind === "telemetry" && event.outcome === "completed") {
            accepted.telemetry = true;
          }
          if (event.kind === "workflow_started") {
            accepted.workflow = true;
          }
        },
      },
      controller.signal
    );
    // Preserve the preceding phase's cadence before starting the short remote fixture.
    const admissionDeadline = Date.now() + 10_000;
    while (
      (!accepted.telemetry || !accepted.workflow) &&
      Date.now() < admissionDeadline
    ) {
      await delay(20);
    }
    if (!accepted.telemetry || !accepted.workflow) {
      controller.abort();
      throw new Error(
        "guard phase did not retain admitted telemetry and workflow"
      );
    }
    const state = { failure: undefined };
    const execution = (async () => {
      try {
        await runProcess({
          args: [
            "test",
            "-p",
            "reltide-capacity-probe",
            "--lib",
            "--locked",
            "analytics::live_tests::remote_cancellation_waits_for_reader_cleanup",
            "--",
            "--ignored",
            "--exact",
          ],
          env: {
            ...env,
            CAPACITY_ANALYTICS_CANCEL_EVIDENCE: evidencePath,
            CAPACITY_ANALYTICS_CANCEL_GATE: gate,
            CAPACITY_ANALYTICS_SLOW_TABLE: fixture.table,
          },
          onLine: (line) => persist({ kind: "remote_cancel_test", line }),
          program: "cargo",
          timeout_ms: 30_000,
        });
      } catch (error) {
        state.failure = error;
      }
    })();
    try {
      let observed = [];
      const deadline = Date.now() + 20_000;
      while (
        (!observed.length || !accepted.telemetry || !accepted.workflow) &&
        !state.failure &&
        Date.now() < deadline
      ) {
        const sample = await fixture.observe();
        observed = sample.data;
        if (!observed.length || !accepted.telemetry || !accepted.workflow) {
          await delay(20);
        }
      }
      assert.equal(
        observed.length,
        1,
        "remote reader query must be observed executing before guard"
      );
      assert.ok(
        accepted.telemetry && accepted.workflow,
        "guard must retain actual accepted workload evidence"
      );
      const guard = evaluateGuard([
        {
          containers: [],
          cpu_busy_ratio: 0,
          mem_available_bytes: 511 * 1_048_576,
          monotonic_ms: 0,
          oom_count: 0,
          root_free_bytes: 20 * 1_073_741_824,
          root_used_ratio: 0.1,
          swap_in_bytes: 0,
          swap_out_bytes: 0,
          utc: new Date().toISOString(),
        },
      ]);
      assert.ok(guard.stop);
      controller.abort();
      await persist({
        guard,
        kind: "guard_trigger",
        remote_query: observed,
        source:
          "injected local low-memory observation; not staging host pressure",
      });
      assert.ok(controller.signal.aborted);
      await writeFile(gate, "guard stopped admission\n");
      await execution;
      let evidence;
      try {
        evidence = JSON.parse(await readFile(evidencePath, "utf-8"));
      } catch (error) {
        state.failure ??= error;
      }
      return await verifyRemoteCleanup({
        evidence,
        failure: state.failure,
        fixture,
        observed,
        persist,
      });
    } finally {
      controller.abort();
      await execution;
    }
  }, new AbortController().signal).finally(async () => {
    controller.abort();
    await guardLoad;
  });
  const load = await guardLoad;
  assert.equal(load.analytics, 0);
  assert.equal(load.search, 0);
  await persist({ kind: "guard_load_stopped", ...load });
  return { ...cleanup, load };
};

/* eslint-enable no-await-in-loop */
export const localLoadCheck = async (context) => {
  const { runId, directory, telemetry, manifest } = context;
  await runProcess({
    args: [
      "build",
      "-p",
      "reltide-capacity-probe",
      "--bin",
      "reltide-capacity-probe",
      "--locked",
    ],
    env: process.env,
    program: "cargo",
    timeout_ms: 120_000,
  });
  const { signal } = new AbortController();
  const fixtureRun = `${runId}-load`;
  const evidenceFile = path.join(directory, "load-events.ndjson");
  let eventSequence = 0;
  const persist = (event) => {
    eventSequence += 1;
    return appendFile(
      evidenceFile,
      `${context.redact(JSON.stringify({ accepted_at: null, completed_at: new Date().toISOString(), kind: "probe_output", outcome: "observed", phase: "local-correctness", ...event, run_id: runId, sequence: eventSequence }))}\n`
    );
  };
  const requests = await discoverRequests(
    {
      api: "http://127.0.0.1:13002/api/v1/health",
      app: "http://127.0.0.1:13000/",
      docs: "http://127.0.0.1:13004/docs",
      web: "http://127.0.0.1:13001/",
    },
    fetch,
    persist
  );
  const frozen = {
    blocked: [
      "independent staging baseline",
      "staging pressure/cadence",
      "backup",
      "recovery",
    ],
    capacity_pass: false,
    kind: "shortened-local-correctness-only",
    overrides: {
      aged_events: 20,
      boundary_events: 20,
      current_events: 400,
      phase_duration_ms: 21_000,
    },
    requests,
    run_id: runId,
    workload,
  };
  await writeFile(
    path.join(directory, "load-manifest.json"),
    `${JSON.stringify(frozen, null, 2)}\n`
  );
  await persist({
    kind: "collector_before_seed",
    metrics: await context.collectorMetrics(),
  });
  const schemas = await discoverTelemetry(telemetry.query, signal);
  await persist({ kind: "telemetry_schema", schemas });
  const seed = {
    cohort: "current",
    epoch_ms: Date.now(),
    rate: 200,
    run_id: runId,
  };
  let accepted = 0;
  let stored = 0;
  const countEvidence = async (event) => {
    if (event.kind === "telemetry_accepted") {
      accepted += event.accepted;
    }
    if (event.kind === "telemetry_stored") {
      stored += event.stored;
    }
    await persist(event);
  };
  const sender = createTelemetrySender({
    schemas,
    seed,
    ...telemetry,
    persist: countEvidence,
  });
  const current = await seedTelemetry(seed, 400, sender, signal);
  assert.equal(current.accepted, 400);
  const agedSeed = {
    ...seed,
    cohort: "aged",
    epoch_ms: Date.now() - 3 * 86_400_000 - 60_000,
  };
  const aged = await context.prepareAgedTelemetry(() =>
    seedTelemetry(
      agedSeed,
      20,
      createTelemetrySender({
        schemas,
        seed: agedSeed,
        ...telemetry,
        persist: countEvidence,
      }),
      signal
    )
  );
  assert.equal(aged.accepted, 20);
  const retentionBefore = await context.retentionSnapshot();
  verifyUnchangedRetention(retentionBefore, retentionBefore);
  const boundarySeed = {
    ...seed,
    cohort: "boundary",
    epoch_ms: Date.now() - 3 * 86_400_000 + 120_000,
  };
  const boundaryExpiresAt = boundarySeed.epoch_ms + 3 * 86_400_000 + 1000;
  await persist({
    kind: "ordinary_expiry_baseline",
    last_event_expired_after: new Date(boundaryExpiresAt).toISOString(),
    retention: retentionBefore,
  });
  await seedTelemetry(
    boundarySeed,
    20,
    createTelemetrySender({
      schemas,
      seed: boundarySeed,
      ...telemetry,
      persist: countEvidence,
    }),
    signal
  );

  const fixture = await seedAnalyticsFixture(
    fixtureRun,
    context.fixtureInsert,
    signal
  );
  const directResult = await context.fixtureQuery(
    `SELECT count() AS rows,min(sequence) AS min_sequence,max(sequence) AS max_sequence FROM capacity_analytics.ledger_sample WHERE run_id='${fixtureRun}' AND sequence BETWEEN 1 AND 10000 LIMIT 1 SETTINGS max_execution_time=5,max_rows_to_read=20000,max_bytes_to_read=2097152 FORMAT JSON`,
    signal
  );
  const [direct] = directResult.data;
  assert.deepEqual(
    [
      Number(direct.rows),
      Number(direct.min_sequence),
      Number(direct.max_sequence),
    ],
    [10_000, 1, 10_000]
  );
  const analyticsEnv = {
    ...process.env,
    CAPACITY_ANALYTICS_DATABASE_URL: context.analyticsDatabaseUrl,
    CAPACITY_ANALYTICS_RUN_ID: fixtureRun,
  };
  await runProcess({
    args: [
      "test",
      "-p",
      "reltide-capacity-probe",
      "--test",
      "analytics",
      "--locked",
      "--",
      "--ignored",
      "--test-threads=1",
    ],
    env: analyticsEnv,
    onLine: (line) => persist({ kind: "rust_test_output", line }),
    program: "cargo",
    timeout_ms: 120_000,
  });
  await runProcess({
    args: [
      "test",
      "-p",
      "reltide-capacity-probe",
      "--lib",
      "--locked",
      "verifies_reader_backend_cleanup",
      "--",
      "--ignored",
      "--test-threads=1",
    ],
    env: analyticsEnv,
    onLine: (line) => persist({ kind: "rust_cleanup_test_output", line }),
    program: "cargo",
    timeout_ms: 120_000,
  });
  const saved = await createSavedSearch(
    { ...telemetry, epoch_ms: seed.epoch_ms, runId },
    signal
  );
  await persist({
    id: saved.id,
    kind: "saved_search",
    source_id: saved.source_id,
  });
  const ledgerEnv = {
    ...process.env,
    RELTIDE_CAPACITY_ENV_FILE: context.ledgerFile,
  };
  // Task1's prepared ledger schema belongs to setup; the runtime role only inserts/selects.

  // Fresh fixture through the Rust client with setup-owned seed capability, never admin credentials in workers.
  assert.ok(
    context.seedLedger,
    "local harness must supply the Rust ledger setup capability"
  );
  const ledgerSeed = await context.seedLedger(
    rustInput(runId, 100_000),
    persist
  );
  const foreground = createForegroundPermit();
  let workflowSequence = 100_001;
  const steady = createSteadyTelemetry({
    schemas,
    seed,
    ...telemetry,
    foreground,
    persist: countEvidence,
  });
  const clients = {
    analytics: async (stop) => {
      const result = await probe(
        "probe-analytics",
        rustInput(fixtureRun),
        analyticsEnv,
        persist,
        stop
      );
      assert.equal(
        result.library_version,
        manifest.extensions.application[0].library_version
      );
      assert.equal(
        result.sql_version,
        manifest.extensions.application[0].sql_version
      );
      assert.deepEqual(
        [result.rows, result.min_sequence, result.max_sequence],
        [
          Number(direct.rows),
          Number(direct.min_sequence),
          Number(direct.max_sequence),
        ]
      );
      return result;
    },
    emit: persist,
    foreground,
    http: async (url, stop) => {
      const response = await fetch(url, {
        signal: AbortSignal.any([stop, AbortSignal.timeout(10_000)]),
      });
      await response.arrayBuffer();
      assert.ok(response.ok);
      return { status: response.status, url };
    },
    requests,
    schedule: {},
    search: saved.execute,
    telemetry: (_request, stop) => steady.submit(stop),
    verifyTelemetry: steady.verify,
    workflow: async ({ emit }, stop) => {
      stop.throwIfAborted();
      let started;
      let output;
      try {
        output = await probe(
          "start",
          rustInput(runId, (workflowSequence += 1)),
          ledgerEnv,
          async (event) => {
            if (event.event === "started") {
              started = event;
            }
            await emit({
              accepted_at: new Date(
                started?.timestamp_utc_ms ?? event.timestamp_utc_ms
              ).toISOString(),
              completed_at:
                event.event === "completed"
                  ? new Date(event.timestamp_utc_ms).toISOString()
                  : null,
              kind: `workflow_${event.event}`,
              outcome: event.event === "completed" ? "completed" : "accepted",
              probe_event: event,
              temporal_run_id:
                event.temporal_run_id ?? started?.temporal_run_id,
              workflow_id: event.workflow_id ?? started?.workflow_id,
              workflow_sequence: event.sequence,
            });
          }
        );
      } catch (error) {
        await persist({
          history: await context.workflowHistory(workflowSequence),
          kind: "workflow_failure_history",
        });
        throw error;
      }
      return { outcome: "completed", output };
    },
  };
  const phase = await runLoad(
    { duration_ms: 21_000, http_rps: 1, name: "shortened" },
    clients,
    signal
  );
  await steady.flush(signal);
  assert.equal(
    phase.telemetry_accepted,
    210,
    "steady telemetry must sustain10 events per second"
  );
  const beforeExpiryStorage = await context.storageSnapshot();
  await persist({
    kind: "storage_before_expiry",
    storage: beforeExpiryStorage,
  });
  const cancellation = await remoteGuardCheck(
    context,
    analyticsEnv,
    foreground,
    persist,
    clients
  );
  await steady.flush(signal);
  const preparedExpiry = await waitNormalExpiry({
    count: 20,
    persist,
    query: telemetry.query,
    schemas,
    seed: agedSeed,
    signal,
  });
  preparedExpiry.mechanism =
    "local prepared fixture: restored TTL triggered automatic materialization";
  const expiry = await waitNormalExpiry({
    count: 20,
    persist,
    query: telemetry.query,
    schemas,
    seed: boundarySeed,
    signal,
  });
  assert.ok(
    Date.now() >= boundaryExpiresAt,
    "ordinary expiry must cross the72hour boundary"
  );
  const retentionAfter = await context.retentionSnapshot();
  verifyUnchangedRetention(retentionBefore, retentionAfter);
  await persist({
    kind: "ordinary_expiry_verified",
    retention: retentionAfter,
    ...expiry,
  });
  stored -= expiry.expired + preparedExpiry.expired;
  const storage = await context.storageSnapshot();
  await persist({ kind: "storage_after_expiry", storage });
  const servicesResult = await telemetry.query(
    `SELECT * FROM (SELECT 'logs' AS signal,ServiceName,count() AS rows FROM otel.otel_logs WHERE Timestamp>=fromUnixTimestamp64Milli(${seed.epoch_ms}) AND Timestamp<=now64(3) AND ServiceName!='capacity-synthetic' GROUP BY ServiceName UNION ALL SELECT 'traces' AS signal,ServiceName,count() AS rows FROM otel.otel_traces WHERE Timestamp>=fromUnixTimestamp64Milli(${seed.epoch_ms}) AND Timestamp<=now64(3) AND ServiceName!='capacity-synthetic' GROUP BY ServiceName) LIMIT 100 SETTINGS max_execution_time=5,max_rows_to_read=50000,max_bytes_to_read=67108864 FORMAT JSON`,
    signal
  );
  const { data: services } = servicesResult;
  const serviceGenerated = services.reduce(
    (sum, item) => sum + Number(item.rows),
    0
  );
  const collectorMetrics = await context.collectorMetrics();
  await persist({ kind: "collector_after_expiry", metrics: collectorMetrics });
  const accounting = accountTelemetry({
    accepted,
    expired: expiry.expired + preparedExpiry.expired,
    service_generated: serviceGenerated,
    stored,
  });
  assert.equal(accounting.pending, 0);
  const bytes = storage.data.reduce(
    (sum, item) => sum + Number(item.stored_bytes),
    0
  );
  return {
    accounting,
    cancellation,
    capacity_pass: false,
    collector_metrics: collectorMetrics,
    direct,
    expiry,
    fixture,
    kind: "shortened-local-correctness-only",
    ledger: ledgerSeed,
    phase,
    prepared_expiry: preparedExpiry,
    projection: {
      label: "growth projection, not measured three-day capacity",
      observed_stored_bytes: bytes,
      projected_three_day_bytes: Math.ceil(
        (bytes / Math.max(1, accepted)) * workload.seed.current_events
      ),
    },
    service_generated: services,
    storage,
  };
};

/* eslint-disable no-await-in-loop -- The fixture and its six readback queries are bounded serial checks. */
/** Focused producer/access-path correctness; prior Rust/guard/TTL evidence stays separate. */
export const localPruningCheck = async (context) => {
  const { telemetry, runId, directory } = context;
  const { signal } = new AbortController();
  let verifiedStored = 0;
  const persist = async (event) => {
    if (event.kind === "telemetry_stored") {
      verifiedStored += event.stored;
    }
    await appendFile(
      path.join(directory, "pruning-events.ndjson"),
      `${context.redact(JSON.stringify(event))}\n`
    );
  };
  const schemas = await discoverTelemetry(telemetry.query, signal);
  await persist({ kind: "source_schema", schemas });
  const seed = {
    cohort: "current",
    epoch_ms: Date.now() - 3000,
    rate: 200,
    run_id: runId,
  };
  const sender = createTelemetrySender({
    ...telemetry,
    persist,
    schemas,
    seed,
  });
  const producer = await seedTelemetry(seed, 520, sender, signal);
  assert.equal(producer.accepted, 520);
  assert.equal(verifiedStored, 520);
  // The direct clone tests sparse-index access; it is not full OTLP ingestion.
  const cloneSeed = { ...seed, epoch_ms: Date.now() - 13_000_000 };
  const fixture = await context.prepareTracePruning(cloneSeed.epoch_ms);
  await persist({
    clone: fixture.clone,
    kind: "trace_clone",
    parts: fixture.parts(),
    source: fixture.source,
  });
  let querySequence = 0;
  const proofs = [];
  const query = async (sql, stop) => {
    querySequence += 1;
    const label = `${runId}-pruning-${querySequence}`;
    const tagged = sql.replace(
      " FORMAT JSON",
      `,log_comment='${label}' FORMAT JSON`
    );
    const explain = await telemetry.query(`EXPLAIN indexes=1 ${sql}`, stop);
    const plan = explain.data.map((row) => row.explain).join("\n");
    const primary =
      /PrimaryKey[\s\S]*?Granules: (?<selected>\d+)\/(?<total>\d+)/u.exec(plan);
    assert.ok(
      primary && Number(primary.groups.selected) < Number(primary.groups.total),
      "primary key must prune trace granules"
    );
    const result = await telemetry.query(tagged, stop);
    assert.ok(
      Number(result.statistics.rows_read) > 0 &&
        Number(result.statistics.rows_read) <= 50_000
    );
    await persist({
      explain,
      kind: "pruning_query",
      label,
      sql: tagged,
      statistics: result.statistics,
    });
    return result;
  };
  for (const offset of [0, 1_296_000, 2_591_800]) {
    const batch = {
      events: Array.from({ length: 100 }, (_, index) =>
        telemetryEvent(cloneSeed, offset + (index + 1) * 2)
      ),
    };

    proofs.push(
      await verifyTelemetryBatch(
        cloneSeed,
        batch,
        { ...schemas, traces: { ...schemas.traces, table: fixture.table } },
        query,
        signal
      )
    );
  }
  let witnesses;
  const deadline = Date.now() + 30_000;
  do {
    witnesses = fixture.witnesses();
    if (witnesses.data.length === querySequence) {
      break;
    }
    await delay(500);
  } while (Date.now() < deadline);
  assert.equal(witnesses.data.length, 6);
  assert.ok(
    witnesses.data.every(
      (row) =>
        Number(row.read_rows) > 0 &&
        Number(row.read_rows) <= 50_000 &&
        Number(row.exception_code) === 0
    )
  );
  const parts = fixture.parts();
  await persist({ kind: "pruning_witnesses", parts, witnesses });
  return {
    capacity_pass: false,
    kind: "focused-producer-pruning-correctness",
    parts,
    producer: { ...producer, verified_stored: verifiedStored },
    proofs,
    witnesses,
  };
};

/* eslint-enable no-await-in-loop */

if (process.argv[1] === import.meta.filename) {
  const [runId, mode] = process.argv.slice(2);
  assert.ok(mode === undefined || mode === "pruning");
  await integrate(runId, {
    diagnoseBootstrap: process.env.CAPACITY_DIAGNOSE_BOOTSTRAP === "1",
    localCheck: mode === "pruning" ? localPruningCheck : localLoadCheck,
  });
}
