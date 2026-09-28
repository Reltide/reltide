import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";

import { test } from "vitest";

import {
  createReaderProbe,
  finalizeIntegration,
  seedExpiredTelemetryLog,
  validatePersistedClickHouseLogs,
  verifyDeploymentIdentity,
  verifyRuntimeIdentity,
  verifyOwnership,
  verifyServiceState,
  verifyTcpListener,
} from "./integration.mjs";

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
