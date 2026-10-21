import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import {
  createCapacityRedactor,
  prepareTracePruningFixture,
  createReaderProbe,
  executePostgresSql,
  finalizeIntegration,
  runSanitizedSubprocess,
  sanitizeCapacityError,
  seedExpiredTelemetryLog,
  validatePersistedClickHouseLogs,
  verifyDeploymentIdentity,
  verifyRuntimeIdentity,
  verifyOwnership,
  verifyServiceState,
  verifyTcpListener,
} from "./integration.mjs";

test("failed secret-bearing setup keeps its marker out of argv, evidence and errors", async () => {
  const marker = "SYNTHETIC_CAPACITY_SECRET_MARKER_4729";
  const redact = createCapacityRedactor(new Set([marker]));
  const sql = `ALTER ROLE capacity_runtime PASSWORD '${marker}'`;
  let commandArgs;
  let commandOptions;
  let setupError;
  try {
    executePostgresSql({
      composeArgs: ["compose", "-f", "capacity.json"],
      database: "capacity",
      env: { CAPACITY_PG_PASSWORD: marker },
      redact,
      run: (_program, args, options) => {
        commandArgs = args;
        commandOptions = options;
        return execFileSync(
          process.execPath,
          [
            "-e",
            "process.stderr.write(require('node:fs').readFileSync(0, 'utf8')); process.exit(7)",
          ],
          { encoding: "utf-8", input: options.input, stdio: "pipe" }
        );
      },
      service: "application-pg",
      sql,
    });
  } catch (error) {
    setupError = error;
  }
  assert.ok(setupError instanceof Error);
  assert.doesNotMatch(
    JSON.stringify(commandArgs),
    /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u
  );
  assert.deepEqual(commandArgs.slice(-2), ["-f", "-"]);
  assert.equal(commandOptions.input, sql);
  assert.equal(commandOptions.stdio, "pipe");
  assert.doesNotMatch(
    setupError.stack,
    /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u
  );
  assert.doesNotMatch(
    setupError.message,
    /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u
  );

  const evidence = { result: "FAIL" };
  const directory = await mkdtemp(path.join(tmpdir(), "capacity-secret-test-"));
  try {
    const file = path.join(directory, "integration-result.json");
    const finalError = await finalizeIntegration({
      cleanup: () => {
        throw new Error(`cleanup ${marker}`);
      },
      collectDiagnostics: () => {
        throw new Error(`diagnostics ${marker}`);
      },
      evidence,
      originalError: setupError,
      persist: () => writeFile(file, JSON.stringify(evidence)),
      sanitizeError: (error) => sanitizeCapacityError(error, redact),
    });
    const persisted = await readFile(file, "utf-8");
    assert.doesNotMatch(persisted, /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u);
    assert.doesNotMatch(
      finalError.stack,
      /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u
    );
    assert.equal(evidence.result, "FAIL");
    assert.match(evidence.error, /REDACTED/u);
    assert.match(evidence.diagnostic_error, /REDACTED/u);
    assert.match(evidence.cleanup_error, /REDACTED/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("uncaught failed setup emits no secret in terminal diagnostics", () => {
  const marker = "SYNTHETIC_CAPACITY_SECRET_MARKER_4729";
  const integrationUrl = new URL("integration.mjs", import.meta.url).href;
  const code = `
    import { execFileSync } from "node:child_process";
    import { createCapacityRedactor, executePostgresSql } from ${JSON.stringify(integrationUrl)};
    const marker = process.env.CAPACITY_TEST_SECRET;
    executePostgresSql({
      composeArgs: ["compose"],
      database: "capacity",
      env: process.env,
      redact: createCapacityRedactor(new Set([marker])),
      run: (_program, _args, options) => execFileSync(process.execPath,
        ["-e", "process.stderr.write(require('node:fs').readFileSync(0, 'utf8')); process.exit(7)"],
        { encoding: "utf-8", input: options.input, stdio: "pipe" }),
      service: "application-pg",
      sql: "ALTER ROLE capacity_runtime PASSWORD '" + marker + "'",
    });
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      encoding: "utf-8",
      env: { ...process.env, CAPACITY_TEST_SECRET: marker },
    }
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u);
  assert.match(result.stderr, /REDACTED/u);
});

test("credential-bearing subprocess output is redacted before terminal emission", () => {
  const marker = "SYNTHETIC_CAPACITY_SECRET_MARKER_4729";
  const emitted = [];
  const redact = createCapacityRedactor(new Set([marker]));
  let failure;
  try {
    runSanitizedSubprocess({
      args: [
        "-e",
        "process.stdout.write(process.env.CAPACITY_TEST_SECRET); process.stderr.write(process.env.CAPACITY_TEST_SECRET); process.exit(7)",
      ],
      env: { ...process.env, CAPACITY_TEST_SECRET: marker },
      program: process.execPath,
      redact,
      stderr: { write: (value) => emitted.push(value) },
      stdout: { write: (value) => emitted.push(value) },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.doesNotMatch(failure.stack, /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u);
  assert.equal(emitted.length, 2);
  assert.doesNotMatch(
    emitted.join(""),
    /SYNTHETIC_CAPACITY_SECRET_MARKER_4729/u
  );
  assert.equal(emitted.join(""), "[REDACTED][REDACTED]");
});

test("reader probe logs in as the scoped role with its effective timeout and a client deadline", () => {
  const calls = [];
  const reader = createReaderProbe((...args) => {
    calls.push(args);
    return "capacity_analytics_reader|capacity_analytics_reader|5s|join_use_nulls 1, group_by_use_nulls 1, final 1, transform_null_in 0";
  });
  reader("SELECT count(*) FROM capacity_ch.ledger_sample");
  assert.equal(calls.length, 2);
  for (const [service, sql, database, options] of calls) {
    assert.equal(service, "application-pg");
    assert.equal(database, "capacity");
    assert.equal(options.user, "capacity_analytics_reader");
    assert.equal(options.timeout, 10_000);
    assert.doesNotMatch(sql, /SET ROLE/u);
  }
  assert.throws(
    () => createReaderProbe(() => "postgres|capacity_analytics_reader|0|"),
    /reader login settings/u
  );
});

test("expired telemetry seed must be observed in storage before TTL removal is credited", () => {
  const queries = [];
  let ttlDays = 3;
  const ch = (sql) => {
    queries.push(sql);
    if (sql.startsWith("SHOW CREATE")) {
      return `CREATE TABLE otel.otel_logs TTL Timestamp + toIntervalDay(${ttlDays})`;
    }
    if (sql.includes("MODIFY TTL")) {
      ttlDays = 5;
    }
    if (sql.startsWith("SELECT count()")) {
      return "1";
    }
    return "";
  };
  seedExpiredTelemetryLog(ch, "run-1");
  assert.ok(queries.some((sql) => sql.includes("MODIFY TTL")));
  assert.ok(queries.some((sql) => sql.includes("INSERT INTO otel.otel_logs")));
  assert.ok(queries.some((sql) => sql.includes("Body='expired-run-1'")));
  assert.throws(
    () =>
      seedExpiredTelemetryLog((sql) => {
        if (sql.startsWith("SHOW CREATE")) {
          return "CREATE TABLE otel.otel_logs TTL Timestamp + toIntervalDay(5)";
        }
        return sql.startsWith("SELECT count()") ? "0" : "";
      }, "run-2"),
    /expired seed was not stored/u
  );
});

test("every persisted ClickHouse system log has a three-day TTL", () => {
  validatePersistedClickHouseLogs([
    {
      create_table_query:
        "CREATE TABLE system.query_log TTL event_date + toIntervalDay(3)",
      engine: "MergeTree",
      name: "query_log",
    },
    {
      create_table_query:
        "CREATE TABLE system.user_query_log ENGINE = SystemUserQueryLog",
      engine: "SystemUserQueryLog",
      name: "user_query_log",
    },
  ]);
  assert.throws(
    () =>
      validatePersistedClickHouseLogs([
        {
          create_table_query:
            "CREATE TABLE system.query_log TTL event_date + toIntervalDay(3)",
          engine: "MergeTree",
          name: "query_log",
        },
        {
          create_table_query: "CREATE TABLE system.error_log",
          engine: "MergeTree",
          name: "error_log",
        },
      ]),
    /unbounded system log/u
  );
});

test("diagnostic failure still cleans owned resources and persists the original failure", async () => {
  const original = new Error("original service failure");
  const evidence = { error: original.message, result: "FAIL" };
  const calls = [];
  const returned = await finalizeIntegration({
    cleanup: () => {
      calls.push("cleanup");
    },
    collectDiagnostics: () => {
      throw new Error("log buffer exceeded");
    },
    evidence,
    originalError: original,
    persist: () => {
      calls.push("persist");
    },
    sanitizeError: (error) => error,
  });
  assert.equal(returned, original);
  assert.deepEqual(calls, ["cleanup", "persist"]);
  assert.equal(evidence.error, original.message);
  assert.match(evidence.diagnostic_error, /log buffer exceeded/u);

  const cleanupEvidence = { result: "PASS_CORRECTNESS_ONLY" };
  const cleanupError = await finalizeIntegration({
    cleanup: () => {
      throw new Error("owned cleanup failed");
    },
    collectDiagnostics: () => null,
    evidence: cleanupEvidence,
    persist: () => {
      calls.push("persist after cleanup failure");
    },
    sanitizeError: (error) => error,
  });
  assert.match(cleanupError.message, /owned cleanup failed/u);
  assert.equal(cleanupEvidence.result, "FAIL");
  assert.ok(calls.includes("persist after cleanup failure"));
});

test("local runtime must match the config in both exported archives", () => {
  assert.throws(
    () =>
      verifyRuntimeIdentity(
        { config_digest: `sha256:${"a".repeat(64)}` },
        `sha256:${"b".repeat(64)}`
      ),
    /identity/u
  );
});
test("a similarly named Docker resource without exact labels is rejected", () => {
  assert.throws(
    () => verifyOwnership({ Labels: {}, Name: "reltide-capacity" }, "test-1"),
    /ownership/u
  );
  assert.throws(
    () =>
      verifyOwnership(
        {
          Labels: { "com.reltide.capacity.run": "other" },
          Name: "reltide-capacity",
        },
        "test-1"
      ),
    /ownership/u
  );
});

test("deployment requires manifest identity after OCI import, not a local config ID", () => {
  const artifact = {
    config_digest: `sha256:${"b".repeat(64)}`,
    oci_manifest_digest: `sha256:${"a".repeat(64)}`,
  };
  assert.throws(
    () => verifyDeploymentIdentity(artifact, artifact.config_digest),
    /deployment/u
  );
  verifyDeploymentIdentity(artifact, artifact.oci_manifest_digest);
});

test("unhealthy real service endpoints stop integration even without OOM or exit", () => {
  assert.throws(
    () =>
      verifyServiceState({
        Name: "hyperdx",
        RestartCount: 0,
        State: { Health: { Status: "unhealthy" }, Status: "running" },
      }),
    /health/u
  );
});
test("OpAMP listener probe requires an accepting TCP socket", async () => {
  const server = createServer((socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await verifyTcpListener("127.0.0.1", address.port);
  } finally {
    server.close();
    await once(server, "close");
  }
  await assert.rejects(() => verifyTcpListener("127.0.0.1", address.port));
});

test("network cause codes survive sanitization without secret-bearing cause detail", () => {
  const secret = "NETWORK_TEST_SECRET";
  const error = new Error("fetch failed", {
    cause: Object.assign(new Error(secret), { code: "ECONNRESET" }),
  });
  const safe = sanitizeCapacityError(
    error,
    createCapacityRedactor(new Set([secret]))
  );
  assert.match(safe.message, /ECONNRESET/u);
  assert.ok(!JSON.stringify(safe).includes(secret));
});

test("worker readiness excludes stale and unrelated pollers", async () => {
  const { freshWorkerPollers } = await import("./integration.mjs");
  const pollers = [
    { identity: "1@owned", lastAccessTime: "2026-09-30T13:00:01Z" },
    { identity: "2@host", lastAccessTime: "2026-09-30T13:00:02Z" },
    { identity: "1@owned", lastAccessTime: "2026-09-30T12:59:00Z" },
  ];
  assert.deepEqual(
    freshWorkerPollers(
      { pollers },
      "owned",
      Date.parse("2026-09-30T13:00:00Z")
    ),
    [pollers[0]]
  );
});

test("pinned CLI poller timestamps use seconds and nanos", async () => {
  const { freshWorkerPollers } = await import("./integration.mjs");
  const poller = {
    identity: "1@owned",
    last_access_time: { nanos: 463_713_901, seconds: 1_790_776_550 },
  };
  assert.deepEqual(
    freshWorkerPollers({ pollers: [poller] }, "owned", 1_790_776_550_000),
    [poller]
  );
  assert.deepEqual(
    freshWorkerPollers({ pollers: [poller] }, "owned", 1_790_776_551_000),
    []
  );
});

test("trace pruning setup preserves schema and bounds every acknowledged insert", () => {
  const statements = [];
  const source =
    "CREATE TABLE otel.otel_traces (Timestamp DateTime64(9)) ENGINE=MergeTree ORDER BY (ServiceName, SpanName, toDateTime(Timestamp)) TTL toDateTime(Timestamp) + toIntervalDay(3)";
  const runId = "pruning-test";
  const table = "capacity_trace_pruning_pruning_test";
  const fixture = prepareTracePruningFixture({
    ch: (sql) => {
      statements.push(sql);
      if (sql === "SHOW CREATE TABLE otel.otel_traces") {
        return source;
      }
      if (sql.startsWith("SHOW CREATE TABLE")) {
        return source.replace("otel.otel_traces", `otel.${table}`);
      }
      return JSON.stringify({ data: [{ rows: 1_296_000 }] });
    },
    epochMs: 1_800_000_000_000,
    runId,
  });
  assert.equal(fixture.table, table);
  const inserts = statements.filter((sql) => sql.startsWith("INSERT"));
  assert.equal(inserts.length, 130);
  assert.ok(
    inserts.every(
      (sql) =>
        /numbers\((?:10000|6000)\)/u.test(sql) &&
        sql.includes("async_insert=0") &&
        sql.includes("max_rows_to_read=50000") &&
        sql.includes("max_memory_usage=134217728") &&
        sql.includes("max_execution_time=5")
    )
  );
  assert.match(inserts.at(-1), /numbers\(6000\)/u);
  assert.ok(statements.every((sql) => !/ALTER|OPTIMIZE|DELETE/u.test(sql)));
  assert.throws(() =>
    prepareTracePruningFixture({
      ch: () => {
        throw new Error("must not execute");
      },
      epochMs: 1,
      runId: "unsafe'",
    })
  );
});
