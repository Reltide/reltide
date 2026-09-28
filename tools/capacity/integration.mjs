import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { command, verifyArtifactArchives } from "./build.mjs";
import { readStackManifest, validateStack } from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const verifyRuntimeIdentity = (artifact, runtimeIdentity) => {
  if (artifact.config_digest !== runtimeIdentity) {
    throw new Error("local runtime image identity mismatch");
  }
};
export const verifyDeploymentIdentity = (artifact, runtimeIdentity) => {
  if (artifact.oci_manifest_digest !== runtimeIdentity) {
    throw new Error(
      "deployment image must resolve imported OCI manifest identity"
    );
  }
};
const secret = () => randomBytes(24).toString("hex");
export const verifyOwnership = (resource, runId) => {
  const labels = resource.Labels ?? resource.Config?.Labels ?? {};
  if (
    labels["com.reltide.capacity.project"] !== "reltide-capacity" ||
    labels["com.reltide.capacity.run"] !== runId
  ) {
    throw new Error("Docker resource ownership mismatch");
  }
};

export const verifyServiceState = (container) => {
  if (
    container.State.OOMKilled ||
    container.RestartCount > 0 ||
    container.State.Status === "exited"
  ) {
    throw new Error(
      `owned service ${container.Name} OOM, restart or exit stops integration`
    );
  }
  if (container.State.Health?.Status === "unhealthy") {
    throw new Error(
      `owned service ${container.Name} endpoint health stops integration`
    );
  }
};

export const verifyTcpListener = async (host, port) => {
  const socket = connect({ host, port });
  try {
    await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
  } finally {
    socket.destroy();
  }
};

const verifyTelemetry = async ({ address, env, ch, wait, runId, evidence }) => {
  const origin = "http://127.0.0.1:18000";
  const request = (pathname, options = {}) =>
    fetch(`${origin}${pathname}`, {
      signal: AbortSignal.timeout(10_000),
      ...options,
    });
  const anonymous = await request("/connections");
  assert.equal(anonymous.status, 401);
  const password = `Synthetic-${secret()}!`;
  const registration = await request("/register/password", {
    body: JSON.stringify({
      confirmPassword: password,
      email: `${runId}@example.invalid`,
      password,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(
    registration.status,
    200,
    "real HyperDX registration must succeed"
  );
  const cookies = registration.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookies, "authenticated session required");
  const connection = await request("/connections", {
    body: JSON.stringify({
      host: "http://clickhouse:8123",
      name: "capacity",
      password: env.CAPACITY_CH_UI_PASSWORD,
      username: "capacity_ui",
    }),
    headers: { "content-type": "application/json", cookie: cookies },
    method: "POST",
  });
  assert.equal(connection.status, 200);
  const { id: connectionId } = await connection.json();
  const listed = await request("/connections", {
    headers: { cookie: cookies },
  });
  const listing = await listed.text();
  assert.equal(listed.status, 200);
  assert.ok(
    !listing.includes(env.CAPACITY_CH_UI_PASSWORD),
    "connection list must redact secrets"
  );
  const otlp = `http://${address("collector")}:4318/v1/logs`;
  const unauthenticated = await fetch(otlp, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(unauthenticated.status, 401);
  const now = BigInt(Date.now()) * 1_000_000n;
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "capacity-synthetic" },
            },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: runId },
                severityNumber: 9,
                timeUnixNano: String(now),
              },
              {
                body: { stringValue: `expired-${runId}` },
                severityNumber: 9,
                timeUnixNano: String(now - 4n * 86_400_000_000_000n),
              },
            ],
            scope: { name: "capacity" },
          },
        ],
      },
    ],
  });
  const ingestion = await fetch(otlp, {
    body,
    headers: {
      authorization: `Bearer ${env.CAPACITY_OTLP_TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(ingestion.status, 200);
  const ingestionResult = await ingestion.json();
  assert.equal(
    Number(ingestionResult.partialSuccess?.rejectedLogRecords ?? 0),
    0
  );
  await wait(
    "buffered real log ingestion",
    () =>
      ch(`SELECT count() FROM otel.otel_logs WHERE Body='${runId}'`).trim() ===
      "1",
    30
  );
  const tables = ch(
    "SELECT name,engine FROM system.tables WHERE database='otel' FORMAT JSONEachRow"
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(tables.length > 0);
  for (const table of tables.filter((value) =>
    value.engine.endsWith("MergeTree")
  )) {
    assert.match(table.name, /^[A-Za-z0-9_]+$/u);
    const column = ch(
      `SELECT name FROM system.columns WHERE database='otel' AND table='${table.name}' AND type LIKE 'DateTime%' ORDER BY position LIMIT 1`
    ).trim();
    assert.match(column, /^[A-Za-z0-9_]+$/u);
    ch(
      `ALTER TABLE otel.${table.name} MODIFY TTL toDateTime(${column}) + INTERVAL 3 DAY; ALTER TABLE otel.${table.name} MODIFY SETTING merge_with_ttl_timeout=300;`
    );
    const create = ch(`SHOW CREATE TABLE otel.${table.name}`);
    assert.match(create, /TTL .*toIntervalDay\(3\)/u);
    assert.match(create, /merge_with_ttl_timeout = 300/u);
  }
  const search = await request(
    `/clickhouse-proxy/?query=${encodeURIComponent(`SELECT count() FROM otel.otel_logs WHERE Body='${runId}' FORMAT JSON`)}`,
    {
      body: "",
      headers: {
        "content-type": "text/plain",
        cookie: cookies,
        "x-hyperdx-connection-id": connectionId,
      },
      method: "POST",
    }
  );
  assert.equal(search.status, 200);
  const found = await search.json();
  assert.equal(Number(found.data[0]["count()"]), 1);
  await wait(
    "three-day telemetry TTL removes expired seed without OPTIMIZE FINAL",
    () =>
      ch(
        `SELECT count() FROM otel.otel_logs WHERE Body='expired-${runId}'`
      ).trim() === "0",
    340
  );
  const collector = await fetch(`http://${address("collector")}:8888/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(collector.status, 200);
  const metrics = await collector.text();
  assert.match(metrics, /otelcol_receiver_accepted_log_records/u);
  const { manifest: appliedManifest, limits } = await readStackManifest();
  const queueLines = metrics
    .split("\n")
    .filter((line) => line.startsWith("otelcol_exporter_queue_capacity{"));
  assert.equal(queueLines.length, 3);
  for (const signal of limits.collector.signals) {
    const line = queueLines.find((value) =>
      value.includes(`data_type="${signal}"`)
    );
    assert.ok(line, `missing ${signal} queue capacity metric`);
    assert.equal(Number(line.split(" ").at(-1)), 341);
  }
  assert.equal(
    queueLines.reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0),
    1023
  );
  assert.equal(
    appliedManifest.collector_config.exporters.clickhouse.sending_queue.sizer,
    "items"
  );
  const boundedCollector = JSON.parse(
    command("docker", [
      "inspect",
      command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.reltide.capacity.run=${runId}`,
        "--filter",
        "label=com.docker.compose.service=collector",
      ]).trim(),
    ])
  );
  assert.deepEqual(boundedCollector[0].Config.Entrypoint, ["/otelcontribcol"]);
  assert.deepEqual(boundedCollector[0].Config.Cmd, [
    "--config=/etc/capacity/collector.yaml",
  ]);
  evidence.telemetry = {
    authenticated_hyperdx_search: true,
    authenticated_ingestion: true,
    collector_metrics: metrics,
    collector_queue: {
      ...limits.collector,
      applied_config_sizer:
        appliedManifest.collector_config.exporters.clickhouse.sending_queue
          .sizer,
      buffer_note:
        "Queue capacity excludes active exporter requests and processor buffers; listed batch capacities do not bound incoming OTLP request decoding or all process RSS.",
      effective_capacities: queueLines,
      units_source:
        "https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.155.0/exporter/exporterhelper/README.md",
    },
    expired_seed_removed: true,
    secret_redaction: true,
    ttl_tables: tables,
  };
};

export const integrate = async (runId) => {
  if (!/^[a-z0-9-]{1,64}$/u.test(runId)) {
    throw new Error("invalid integration run ID");
  }
  command("docker", ["info"]);
  const composePath = path.join(root, "infra/capacity/compose.json");
  const { compose, limits, lock, manifest } = await readStackManifest();
  const errors = validateStack(manifest, compose, limits);
  if (errors.length) {
    throw new Error(`stack rejected: ${errors.join("; ")}`);
  }
  const existing = command("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=com.docker.compose.project=reltide-capacity",
  ]).trim();
  if (existing) {
    throw new Error(
      "existing capacity containers require explicit owned cleanup before integration"
    );
  }
  const occupiedResources = [
    command("docker", ["network", "ls", "--format", "{{.Name}}"]),
    command("docker", ["volume", "ls", "--format", "{{.Name}}"]),
  ]
    .flatMap((value) => value.trim().split("\n"))
    .filter((name) => name.startsWith("reltide-capacity_"));
  if (occupiedResources.length) {
    throw new Error(
      "existing capacity network/volumes require explicit owned cleanup"
    );
  }
  const snapshots = [];
  const directory = path.join(root, ".capacity", runId);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const env = {
    ...process.env,
    CAPACITY_CH_ADMIN_PASSWORD: secret(),
    CAPACITY_CH_FIXTURE_PASSWORD: secret(),
    CAPACITY_CH_INGEST_PASSWORD: secret(),
    CAPACITY_CH_UI_PASSWORD: secret(),
    CAPACITY_MONGO_PASSWORD: secret(),
    CAPACITY_OTLP_TOKEN: secret(),
    CAPACITY_PG_PASSWORD: secret(),
    CAPACITY_RUNTIME_DIR: directory,
    CAPACITY_RUN_ID: runId,
    CAPACITY_SESSION_SECRET: secret(),
    CAPACITY_TEMPORAL_PG_PASSWORD: "synthetic-temporal",
  };
  const local = { services: {} };
  await Promise.all(
    Object.entries(lock.derived)
      .filter(([name]) => compose.services[name])
      .map(([, artifact]) => verifyArtifactArchives(root, artifact))
  );
  for (const [name, artifact] of Object.entries(lock.derived)) {
    if (!compose.services[name]) {
      continue;
    }
    const actual = command("docker", [
      "image",
      "inspect",
      artifact.config_digest,
      "--format",
      "{{.Id}}",
    ]).trim();
    verifyRuntimeIdentity(artifact, actual);
    local.services[name] = { image: actual, pull_policy: "never" };
  }
  local.services.probe.user = `${process.getuid()}:${process.getgid()}`;
  const override = path.join(directory, "local-compose.json");
  await writeFile(override, `${JSON.stringify(local, null, 2)}\n`);
  const args = [
    "compose",
    "--project-directory",
    path.dirname(composePath),
    "-f",
    composePath,
    "-f",
    override,
  ];
  const dc = (...extra) => command("docker", [...args, ...extra], { env });
  const helper = (...extra) =>
    dc("--profile", "helper", "run", "--rm", "--no-deps", ...extra);
  const id = (service) => dc("ps", "-aq", service).trim();
  const inspect = (service) => {
    const [container] = JSON.parse(command("docker", ["inspect", id(service)]));
    return container;
  };
  const address = (service) => {
    const container = inspect(service);
    verifyOwnership(container, runId);
    const [network] = Object.values(container.NetworkSettings.Networks);
    const [actual] = JSON.parse(
      command("docker", ["network", "inspect", network.NetworkID])
    );
    verifyOwnership(actual, runId);
    return network.IPAddress;
  };
  const check = () => {
    const ids = dc("ps", "-aq").trim().split("\n").filter(Boolean);
    if (ids.length) {
      snapshots.push({
        stats: command("docker", [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...ids,
        ])
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        time: new Date().toISOString(),
      });
    }
    for (const container of JSON.parse(
      command("docker", [
        "inspect",
        ...dc("ps", "-aq").trim().split("\n").filter(Boolean),
      ])
    )) {
      verifyOwnership(container, runId);
      verifyServiceState(container);
    }
  };
  const pg = (
    service,
    sql,
    database = service === "application-pg" ? "capacity" : "temporal"
  ) =>
    dc(
      "exec",
      "-T",
      service,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      service === "application-pg" ? "postgres" : "temporal",
      "-d",
      database,
      "-At",
      "-c",
      sql
    );
  const ch = (sql) =>
    dc(
      "exec",
      "-T",
      "clickhouse",
      "clickhouse-client",
      "--multiquery",
      "--query",
      sql
    );
  const wait = (description, attempt, seconds = 90) => {
    const deadline = Date.now() + seconds * 1000;
    const poll = async () => {
      check();
      let ready = false;
      try {
        ready = await attempt();
      } catch {
        /* Bounded startup probe. */
      }
      if (ready) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`${description} readiness deadline exceeded`);
      }
      await delay(1000);
      return poll();
    };
    return poll();
  };
  const evidence = {
    capacity_pass: false,
    kind: "local-amd64-emulation-correctness",
    manifest,
    resource_snapshots: snapshots,
    run_id: runId,
  };
  let started = false;
  try {
    const resolved = JSON.parse(dc("config", "--format", "json"));
    for (const [name, service] of Object.entries(resolved.services)) {
      assert.equal(
        Number(service.mem_limit),
        limits.services[name].memory_mib * 1_048_576
      );
    }
    started = true;
    dc("up", "-d", "application-pg", "temporal-pg", "clickhouse", "mongo");
    await wait(
      "application PostgreSQL",
      () => pg("application-pg", "SELECT 1").trim() === "1"
    );
    await wait(
      "Temporal PostgreSQL",
      () => pg("temporal-pg", "SELECT 1").trim() === "1"
    );
    await wait("ClickHouse", () => ch("SELECT 1").trim() === "1");
    check();
    const postgresSettings = [
      "max_connections",
      "shared_buffers",
      "work_mem",
      "max_parallel_workers",
      "track_commit_timestamp",
      "wal_level",
      "archive_mode",
      "archive_timeout",
      "max_wal_size",
    ];
    const expectedPostgresSettings = {
      archive_mode: "on",
      archive_timeout: "120",
      max_connections: "32",
      max_parallel_workers: "0",
      max_wal_size: "256",
      shared_buffers: "4096",
      track_commit_timestamp: "on",
      wal_level: "replica",
      work_mem: "1024",
    };
    const effectivePostgres = (service) =>
      JSON.parse(
        pg(
          service,
          `SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN (${postgresSettings.map((name) => `'${name}'`).join(",")})`
        ).trim()
      );
    evidence.postgres_settings = {
      application: effectivePostgres("application-pg"),
      temporal: effectivePostgres("temporal-pg"),
    };
    assert.deepEqual(
      evidence.postgres_settings.application,
      expectedPostgresSettings
    );
    assert.deepEqual(
      evidence.postgres_settings.temporal,
      expectedPostgresSettings
    );
    const serverSettings = ch(
      "SELECT name,value FROM system.server_settings WHERE name IN ('background_pool_size','background_merges_mutations_concurrency_ratio','background_schedule_pool_size','max_server_memory_usage') FORMAT JSONEachRow"
    )
      .trim()
      .split("\n")
      .map((value) => JSON.parse(value));
    evidence.clickhouse_server_settings = Object.fromEntries(
      serverSettings.map(({ name, value }) => [name, value])
    );
    assert.equal(
      Number(evidence.clickhouse_server_settings.background_pool_size),
      1
    );
    assert.equal(
      Number(
        evidence.clickhouse_server_settings
          .background_merges_mutations_concurrency_ratio
      ),
      1
    );
    assert.equal(
      Number(evidence.clickhouse_server_settings.background_schedule_pool_size),
      2
    );
    assert.equal(
      Number(evidence.clickhouse_server_settings.max_server_memory_usage),
      536_870_912
    );
    pg("temporal-pg", "CREATE DATABASE temporal_visibility");
    for (const [database, schema] of [
      ["temporal", "temporal"],
      ["temporal_visibility", "visibility"],
    ]) {
      helper(
        "--entrypoint",
        "temporal-sql-tool",
        "helper",
        "--ep",
        "temporal-pg",
        "--port",
        "5432",
        "--user",
        "temporal",
        "--pl",
        "postgres12",
        "--db",
        database,
        "setup-schema",
        "-v",
        "0.0"
      );
      helper(
        "--entrypoint",
        "temporal-sql-tool",
        "helper",
        "--ep",
        "temporal-pg",
        "--port",
        "5432",
        "--user",
        "temporal",
        "--pl",
        "postgres12",
        "--db",
        database,
        "update-schema",
        "-d",
        `/etc/temporal/schema/postgresql/v12/${schema}/versioned`
      );
    }
    evidence.schema_versions = [
      pg("temporal-pg", "SELECT curr_version FROM schema_version"),
      pg(
        "temporal-pg",
        "SELECT curr_version FROM schema_version",
        "temporal_visibility"
      ),
    ];
    pg(
      "application-pg",
      await readFile(path.join(root, "infra/capacity/sql/ledger.sql"), "utf-8")
    );
    ch(
      await readFile(
        path.join(root, "infra/capacity/sql/clickhouse-analytics.sql"),
        "utf-8"
      )
    );
    ch(
      `INSERT INTO capacity_analytics.ledger_sample SELECT '${runId}', toUInt16(number + 1) FROM numbers(10000)`
    );
    pg(
      "application-pg",
      await readFile(
        path.join(root, "infra/capacity/sql/pg-clickhouse.sql"),
        "utf-8"
      )
    );
    pg(
      "application-pg",
      `ALTER ROLE capacity_analytics_reader PASSWORD '${env.CAPACITY_CH_FIXTURE_PASSWORD}'; CREATE USER MAPPING FOR capacity_analytics_reader SERVER capacity_ch_server OPTIONS (user 'capacity_fixture', password '${env.CAPACITY_CH_FIXTURE_PASSWORD}'); GRANT CREATE ON SCHEMA capacity_ch TO capacity_analytics_reader; SET ROLE capacity_analytics_reader; IMPORT FOREIGN SCHEMA capacity_analytics LIMIT TO (ledger_sample) FROM SERVER capacity_ch_server INTO capacity_ch; RESET ROLE; REVOKE CREATE ON SCHEMA capacity_ch FROM capacity_analytics_reader; ALTER FOREIGN TABLE capacity_ch.ledger_sample OWNER TO postgres; GRANT SELECT ON capacity_ch.ledger_sample TO capacity_analytics_reader;`
    );
    evidence.extension = pg(
      "application-pg",
      "SELECT ch_extension.pgch_version(), extversion FROM pg_extension WHERE extname='pg_clickhouse'"
    ).trim();
    assert.equal(evidence.extension, "0.10.0|0.10");
    assert.equal(
      pg(
        "temporal-pg",
        "SELECT count(*) FROM pg_available_extensions WHERE name='pg_clickhouse'"
      ).trim(),
      "0"
    );
    assert.equal(
      pg(
        "application-pg",
        "SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='capacity_ch'"
      ).trim(),
      "run_id:text,sequence:integer"
    );
    assert.equal(
      pg(
        "application-pg",
        `SET ROLE capacity_analytics_reader; SELECT count(*),min(sequence),max(sequence) FROM capacity_ch.ledger_sample WHERE run_id='${runId}' AND sequence BETWEEN 1 AND 10000`
      )
        .trim()
        .split("\n")
        .at(-1),
      "10000|1|10000"
    );
    for (const sql of [
      "INSERT INTO capacity_ch.ledger_sample VALUES ('denied', 1)",
      "SELECT ch_extension.clickhouse_raw_query('SELECT 1')",
      "CALL ch_extension.clickhouse_perform('capacity_ch_server','DROP TABLE ledger_sample')",
      "SELECT * FROM ch_extension.clickhouse_query('capacity_ch_server','SELECT 1') AS (x int)",
    ]) {
      assert.throws(() =>
        pg("application-pg", `SET ROLE capacity_analytics_reader; ${sql}`)
      );
    }
    assert.equal(
      pg(
        "application-pg",
        "SELECT count(*) FROM pg_user_mappings WHERE srvname='capacity_ch_server' AND usename='public'"
      ).trim(),
      "0"
    );
    assert.equal(
      pg(
        "application-pg",
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ch_extension' AND p.proname IN ('clickhouse_raw_query','clickhouse_perform','clickhouse_query') AND has_function_privilege('capacity_analytics_reader',p.oid,'EXECUTE')"
      ).trim(),
      "0"
    );
    const fixtureRequest = (sql, settings = "") =>
      fetch(`http://${address("clickhouse")}:8123/?${settings}`, {
        body: sql,
        headers: {
          "X-ClickHouse-Key": env.CAPACITY_CH_FIXTURE_PASSWORD,
          "X-ClickHouse-User": "capacity_fixture",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    const denials = [
      ["INSERT INTO capacity_analytics.ledger_sample VALUES ('denied',1)", ""],
      ["SELECT count() FROM otel.otel_logs", ""],
      ["SELECT 1", "max_rows_to_read=20001"],
      ["SELECT 1", "max_memory_usage=0"],
      ["SELECT 1", "join_use_nulls=0"],
    ];
    const deny = async ([sql, settings]) => {
      const response = await fixtureRequest(sql, settings);
      assert.ok(
        !response.ok,
        "fixture privilege/limit/semantic setting change must fail"
      );
      const detail = await response.text();
      assert.ok(
        !detail.includes(env.CAPACITY_CH_FIXTURE_PASSWORD),
        "denial must redact credential"
      );
    };
    await deny(denials[0]);
    await deny(denials[1]);
    await deny(denials[2]);
    await deny(denials[3]);
    await deny(denials[4]);
    evidence.reader_denials = denials.map(([sql, settings]) => ({
      settings,
      sql,
    }));
    dc(
      "up",
      "-d",
      "temporal",
      "temporal-ui",
      "api",
      "app",
      "web",
      "docs",
      "collector",
      "hyperdx"
    );
    await wait(
      "Temporal",
      () => {
        helper(
          "--entrypoint",
          "temporal",
          "helper",
          "--address",
          "temporal:7233",
          "operator",
          "cluster",
          "health"
        );
        return true;
      },
      120
    );
    helper(
      "--entrypoint",
      "temporal",
      "helper",
      "--address",
      "temporal:7233",
      "operator",
      "namespace",
      "create",
      "--namespace",
      `reltide-capacity-${runId}`,
      "--retention",
      "3d"
    );
    pg(
      "application-pg",
      `CREATE ROLE capacity_runtime LOGIN CONNECTION LIMIT 3 PASSWORD '${env.CAPACITY_PG_PASSWORD}'; GRANT USAGE ON SCHEMA capacity TO capacity_runtime; GRANT SELECT, INSERT ON capacity.ledger TO capacity_runtime;`
    );
    const restricted = path.join(directory, "probe.env");
    await writeFile(
      restricted,
      `TEMPORAL_ADDRESS=http://temporal:7233\nTEMPORAL_NAMESPACE=reltide-capacity-${runId}\nTEMPORAL_TASK_QUEUE=reltide-capacity-${runId}\nAPPLICATION_DATABASE_URL=postgresql://capacity_runtime:${env.CAPACITY_PG_PASSWORD}@application-pg:5432/capacity\n`,
      { mode: 0o600 }
    );
    dc("up", "-d", "probe");
    const origin = "http://127.0.0.1";
    const endpoints = [
      ["app", 13_000, "/"],
      ["web", 13_001, "/"],
      ["docs", 13_004, "/docs"],
      ["api", 13_002, "/api/v1/health"],
      ["temporal-ui", 18_080, "/"],
      ["hyperdx-api", 18_000, "/ready"],
      ["hyperdx-ui", 18_081, "/"],
    ];
    await Promise.all(
      endpoints.map(([name, port, pathname]) =>
        wait(
          name,
          async () => {
            const response = await fetch(`${origin}:${port}${pathname}`, {
              signal: AbortSignal.timeout(5000),
            });
            return response.ok;
          },
          120
        )
      )
    );
    await wait(
      "HyperDX OpAMP listener",
      async () => {
        await verifyTcpListener(address("hyperdx"), 4320);
        return true;
      },
      120
    );
    evidence.opamp_listener = true;
    check();
    await verifyTelemetry({ address, ch, env, evidence, runId, wait });
    // Exactly the Task 1 targets execute. Stop the container worker while the
    // replay test owns its one worker; preserve the four-connection combined cap.
    dc("stop", "probe");
    const hostFile = path.join(directory, "host-probe.env");
    const databaseUrl = `postgresql://postgres:${env.CAPACITY_PG_PASSWORD}@${address("application-pg")}:5432/capacity`;
    await writeFile(
      hostFile,
      `TEMPORAL_ADDRESS=http://${address("temporal")}:7233\nTEMPORAL_NAMESPACE=reltide-capacity-${runId}\nTEMPORAL_TASK_QUEUE=reltide-capacity-${runId}\nAPPLICATION_DATABASE_URL=${databaseUrl.replace("postgres:", "capacity_runtime:")}\n`,
      { mode: 0o600 }
    );
    await chmod(hostFile, 0o600);
    command(
      "cargo",
      [
        "test",
        "-p",
        "reltide-capacity-probe",
        "--test",
        "ledger",
        "--test",
        "replay",
        "--locked",
        "--",
        "--ignored",
      ],
      {
        env: {
          ...env,
          CAPACITY_TEST_DATABASE_URL: databaseUrl,
          CAPACITY_TEST_ENV_FILE: hostFile,
        },
        stdio: "inherit",
      }
    );
    dc("start", "probe");
    evidence.connections = {
      application: Number(
        pg("application-pg", "SELECT count(*) FROM pg_stat_activity").trim()
      ),
      application_clients: Number(
        pg(
          "application-pg",
          "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('capacity_runtime','capacity_analytics_reader') AND backend_type='client backend'"
        ).trim()
      ),
      temporal: Number(
        pg("temporal-pg", "SELECT count(*) FROM pg_stat_activity").trim()
      ),
      temporal_persistence: Number(
        pg(
          "temporal-pg",
          "SELECT count(*) FROM pg_stat_activity WHERE usename='temporal' AND backend_type='client backend' AND pid <> pg_backend_pid()"
        ).trim()
      ),
    };
    assert.ok(evidence.connections.application <= 32);
    assert.ok(evidence.connections.application_clients <= 4);
    assert.ok(evidence.connections.temporal <= 32);
    assert.ok(evidence.connections.temporal_persistence <= 16);
    check();
    evidence.result = "PASS_CORRECTNESS_ONLY";
  } catch (error) {
    evidence.result = "FAIL";
    evidence.error = error.message;
    throw error;
  } finally {
    if (started) {
      const rawLogs = dc("logs", "--no-color");
      let safeLogs = rawLogs;
      for (const [name, value] of Object.entries(env)) {
        if (
          name.startsWith("CAPACITY_") &&
          /PASSWORD|SECRET|TOKEN/u.test(name)
        ) {
          safeLogs = safeLogs.replaceAll(value, "[REDACTED]");
        }
      }
      await writeFile(path.join(directory, "service-logs.txt"), safeLogs);
      const cleanupIds = dc("ps", "-aq").trim().split("\n").filter(Boolean);
      const cleanupContainers = cleanupIds.length
        ? JSON.parse(command("docker", ["inspect", ...cleanupIds]))
        : [];
      for (const container of cleanupContainers) {
        verifyOwnership(container, runId);
      }
      evidence.containers = cleanupContainers.map((container) => ({
        exit_code: container.State.ExitCode,
        id: container.Id,
        image: container.Image,
        name: container.Name,
        oom: container.State.OOMKilled,
        restart_count: container.RestartCount,
        state: container.State.Status,
      }));
      for (const name of [
        "reltide-capacity_private",
        ...Object.keys(compose.volumes).map(
          (volume) => `reltide-capacity_${volume}`
        ),
      ]) {
        const type = name.endsWith("_private") ? "network" : "volume";
        const exists = command("docker", [type, "ls", "--format", "{{.Name}}"])
          .trim()
          .split("\n")
          .includes(name);
        if (exists) {
          const [resource] = JSON.parse(
            command("docker", [type, "inspect", name])
          );
          verifyOwnership(resource, runId);
        }
      }
      dc("down", "--volumes", "--remove-orphans");
    }
    await writeFile(
      path.join(directory, "integration-result.json"),
      `${JSON.stringify(evidence, null, 2)}\n`
    );
  }
  return evidence;
};

if (process.argv[1] === import.meta.filename) {
  await integrate(process.env.CAPACITY_RUN_ID ?? `local-${Date.now()}`);
}
