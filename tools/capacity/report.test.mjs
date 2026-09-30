import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";

import { readEvidence } from "./report-io.mjs";
import { evaluateRun, createReport } from "./report.mjs";

// These are evaluator unit inputs, never measurements or staging acceptance.
const id = "unit-run";
const sha = "a".repeat(64);
const at = (ms) => new Date(Date.UTC(2026, 8, 30) + ms).toISOString();
const services = [
  "app",
  "web",
  "docs",
  "api",
  "probe",
  "application-pg",
  "temporal-pg",
  "temporal",
  "temporal-ui",
  "clickhouse",
  "collector",
  "hyperdx",
  "mongo",
];
const check = () => ({ passed: true, run_id: id, sha256: sha });
const checks = (names) =>
  Object.fromEntries(names.map((name) => [name, check()]));
const analytics = () => ({
  elapsed_ms: 2000,
  explain: [
    {
      Plan: {
        "Node Type": "Foreign Scan",
        "Remote SQL": `SELECT count(*), min(sequence), max(sequence) FROM capacity_analytics.ledger_sample WHERE run_id = '${id}' AND sequence >= 1 AND sequence <= 10000 LIMIT 1`,
      },
    },
  ],
  library_version: "0.10.0",
  max_sequence: 10_000,
  min_sequence: 1,
  pushdown: true,
  rows: 10_000,
  run_id: id,
  sample: Array.from({ length: 10 }, (_, i) => ({
    run_id: id,
    sequence: i + 1,
  })),
  sql_version: "0.10",
});
const fixture = () => {
  const phases = [
    ["idle", 900_000, 0],
    ["ramp-1", 600_000, 1],
    ["ramp-3", 600_000, 3],
    ["ramp-5", 600_000, 5],
    ["soak", 7_200_000, 5],
    ["final", 900_000, 5],
  ];
  let end = 0;
  const phaseRecords = phases.map(([name, duration_ms, http_rps]) => {
    const start = end;
    end += duration_ms;
    return {
      completed_at: at(end),
      duration_ms,
      http_rps,
      name,
      started_at: at(start),
    };
  });
  const host_samples = Array.from({ length: end / 1000 + 1 }, (_, i) => ({
    clock_offset_ms: 0,
    containers: services.map((service, index) => ({
      cpu_busy_ratio: 0.01,
      id: String(index + 1).padStart(64, "0"),
      memory_bytes: 1024,
      oom: false,
      restart_count: 0,
      running: true,
      service,
    })),
    cpu_busy_ratio: 0.2,
    mem_available_bytes: 1024 ** 3,
    monotonic_ms: i * 1000,
    oom_count: 0,
    root_free_bytes: 20 * 1024 ** 3,
    root_used_ratio: 0.4,
    run_id: id,
    sequence: i + 1,
    swap_in_bytes: 0,
    swap_out_bytes: 0,
    utc: at(i * 1000),
  }));
  const events = services.slice(0, 4).map((service, i) => ({
    accepted_at: at(3_000_000),
    completed_at: at(3_000_500),
    kind: "http",
    outcome: "completed",
    phase: "soak",
    run_id: id,
    sequence: i + 1,
    status: 200,
    url: `http://${service}/`,
  }));
  events.push(
    {
      accepted_at: at(3_000_000),
      analytics: analytics(),
      completed_at: at(3_004_000),
      kind: "foreground",
      outcome: "completed",
      phase: "soak",
      run_id: id,
      search: {
        elapsed_ms: 2000,
        first_id: sha,
        rows: 1,
        saved_search_id: "unit",
      },
      sequence: 5,
    },
    {
      accepted_at: at(3_000_000),
      completed_at: at(3_010_000),
      kind: "workflow_completed",
      outcome: "completed",
      phase: "soak",
      run_id: id,
      scheduling_delay_ms: 5000,
      sequence: 6,
    },
    {
      accepted_at: at(3_000_000),
      completed_at: at(3_030_000),
      kind: "telemetry_stored",
      phase: "soak",
      proofs: [
        {
          checksum_errors: 0,
          event_time_ms: [Date.parse(at(3_000_000)), Date.parse(at(3_000_900))],
          rows: 10,
          stored_at: at(3_030_000),
        },
      ],
      run_id: id,
      sequence: 7,
      stored: 10,
    }
  );
  for (const phase of phaseRecords.filter((p) => p.http_rps > 0)) {
    for (let i = 0; i < (phase.duration_ms * phase.http_rps) / 1000; i += 1) {
      const service = services[i % 4];
      events.push({
        accepted_at: phase.started_at,
        completed_at: new Date(
          Date.parse(phase.started_at) + 100
        ).toISOString(),
        kind: "http",
        outcome: "completed",
        phase: phase.name,
        run_id: id,
        status: 200,
        url: `http://${service}/bulk`,
      });
    }
    events.push({
      kind: "telemetry_stored",
      phase: phase.name,
      proofs: [
        {
          checksum_errors: 0,
          event_time_ms: [
            Date.parse(phase.completed_at) - 1000,
            Date.parse(phase.completed_at) - 1,
          ],
          rows: phase.duration_ms / 100,
          stored_at: phase.completed_at,
        },
      ],
      run_id: id,
      stored: phase.duration_ms / 100,
    });
  }
  for (const [cohort, count] of [
    ["current", 2_592_000],
    ["aged", 25_920],
  ]) {
    for (let offset = 0; offset < count; offset += 256) {
      events.push({
        accepted: Math.min(256, count - offset),
        cohort,
        kind: "telemetry_accepted",
        phase: "seed",
        rejected: 0,
        run_id: id,
      });
    }
  }
  const retention = {
    mutations: [],
    ttls: ["otel_logs", "otel_traces"].map((table) => ({
      ddl: "TTL toDateTime(Timestamp) + toIntervalDay(3)",
      table,
    })),
  };
  events.push(
    {
      kind: "ordinary_expiry_baseline",
      last_event_expired_after: at(2000),
      retention,
      run_id: id,
    },
    {
      cohort: "boundary",
      kind: "normal_expiry_observation",
      observed_at: at(1000),
      remaining: 20,
      run_id: id,
    },
    {
      cohort: "boundary",
      kind: "normal_expiry_observation",
      observed_at: at(3000),
      remaining: 0,
      run_id: id,
    },
    {
      completed_at: at(3000),
      elapsed_ms: 2000,
      expired: 20,
      kind: "ordinary_expiry_verified",
      retention,
      run_id: id,
    }
  );
  for (const [i, v] of events.entries()) {
    v.sequence = i + 1;
  }
  const required = checks([
    "baseline",
    "limits",
    "load_counts",
    "seed_counts",
    "initializer",
    "least_privilege",
    "outage_isolation",
    "extension_after_restore",
    "retention",
    "wal_freshness",
    "encrypted_download",
    "backup_limits",
    "restart_coverage",
    "restart_replay",
    "lost_ack_once",
    "recovery_common_cut",
    "recovery_volumes",
    "recovery_checks",
  ]);
  return {
    backups: ["application", "temporal"].map((kind) => ({
      base_id: "unit-base",
      bytes: 1024,
      download_verified: true,
      encrypted_sha256: kind === "application" ? sha : "b".repeat(64),
      extensions:
        kind === "application"
          ? [
              {
                image_digest: sha,
                library_version: "0.10.0",
                name: "pg_clickhouse",
                sql_version: "0.10",
              },
            ]
          : [],
      kind,
      operations_reserved: { class_a: 1, class_b: 1 },
      run_id: id,
      server_version: "18.0",
      system_identifier: "123",
      timeline: 1,
      uploaded_at: at(end),
      wal_range: ["0/100", "0/200"],
    })),
    collector: [
      { accepted: 10, dropped: 0, rejected: 0, run_id: id, sequence: 1 },
      { accepted: 10, dropped: 0, rejected: 0, run_id: id, sequence: 2 },
    ],
    events,
    host_samples,
    load: {
      accounting: {
        accepted: 2_617_920,
        dropped: 0,
        expired: 0,
        pending: 0,
        service_generated: 0,
        stored: 2_617_920,
      },
      projection: {
        label: "growth projection, not measured three-day capacity",
        observed_stored_bytes: 100,
        projected_three_day_bytes: 1000,
      },
    },
    manifest: {
      checks: required,
      config_sha256: sha,
      fixture_run_id: id,
      host: {
        architecture: "x86",
        id: 167_541_435,
        location: "hel1",
        name: "reltide-staging",
        os: "Ubuntu 26.04",
        private_ip: "172.30.0.3",
        type: "cx23",
      },
      images: Object.fromEntries(services.map((s) => [s, sha])),
      induced_windows: services.map((service, i) => ({
        completed_at: at(end + 301_000 + i * 301_000),
        declared_at: at(0),
        kind: "restart",
        ownership_sha256: sha,
        ownership_verified: true,
        recovery_check: check(),
        run_id: id,
        service,
        started_at: at(end + 300_000 + i * 301_000),
      })),
      kind: "native-staging",
      phases: phaseRecords,
      requests: Object.fromEntries(
        services
          .slice(0, 4)
          .map((s) => [s, [`http://${s}/`, `http://${s}/bulk`]])
      ),
      run_id: id,
      seed: {
        aged_events: 25_920,
        analytics_rows: 10_000,
        current_events: 2_592_000,
        ledger_rows: 100_000,
      },
    },
    restarts: services.map((service, index) => ({
      healthy_at: at(end + 301_000 + index * 301_000),
      healthy_window_seconds: 300,
      outage_start: at(end + 300_000 + index * 301_000),
      replay_result: true,
      run_id: id,
      service,
    })),
    restores: ["application", "temporal"].map((kind) => ({
      checks: {
        clean_volume: true,
        download_decrypt_verify_included: true,
        extension_compatible: true,
        passed: true,
        sha256: sha,
      },
      extensions:
        kind === "application"
          ? [
              {
                image_digest: sha,
                library_version: "0.10.0",
                name: "pg_clickhouse",
                sql_version: "0.10",
              },
            ]
          : [],
      healthy_at: at(end + 1_800_000),
      input_receipts: [kind === "application" ? sha : "b".repeat(64)],
      kind,
      lost_commits: 0,
      ownership_sha256: sha,
      ownership_verified: true,
      recovery_cut: at(end),
      rpo_seconds: 300,
      rto_seconds: 1800,
      run_id: id,
      source_volume_unmounted: true,
      started_at: at(end),
      target_volume: `reltide-capacity-${kind}-restore`,
      watermark: {
        committed_at: at(end - 300_000),
        sequence: 100,
        sha256: sha,
      },
    })),
    retention: {
      tables: [
        "otel_logs",
        "otel_traces",
        "otel_traces_trace_id_ts",
        "otel_metrics_exponential_histogram",
        "otel_metrics_gauge",
        "otel_metrics_histogram",
        "otel_metrics_sum",
        "otel_metrics_summary",
      ].map((name) => ({ ddl_sha256: sha, name, ttl_days: 3 })),
    },
    run_id: id,
    schema_version: 1,
  };
};
test("complete unit evidence passes; future missing evidence remains blocked", () => {
  const e = fixture();
  assert.equal(evaluateRun(e).combined, "PASS");
  delete e.restores;
  assert.equal(evaluateRun(e).combined, "BLOCKED");
  const a = fixture();
  a.events = a.events
    .filter((x) => x.kind !== "foreground")
    .map((x, i) => ({ ...x, sequence: i + 1 }));
  assert.equal(evaluateRun(a).combined, "BLOCKED");
});
for (const [name, mutate, want] of [
  [
    "one service missing",
    (e) => {
      for (const s of e.host_samples) {
        s.containers.pop();
      }
    },
    "BLOCKED",
  ],
  ["truncated samples", (e) => e.host_samples.pop(), "BLOCKED"],
  [
    "mixed event run",
    (e) => {
      e.events[0].run_id = "other";
    },
    "FAIL",
  ],
  [
    "counter reset",
    (e) => {
      e.collector[0].accepted = 11;
    },
    "FAIL",
  ],
  [
    "unlabelled projection",
    (e) => {
      delete e.load.projection.label;
    },
    "BLOCKED",
  ],
  [
    "false pushdown claim",
    (e) => {
      e.events[4].analytics.explain = [{ Plan: { "Node Type": "Aggregate" } }];
    },
    "FAIL",
  ],
  [
    "wrong fixture count",
    (e) => {
      e.events[4].analytics.rows = 9999;
    },
    "FAIL",
  ],
  [
    "analytics p95 2001",
    (e) => {
      e.events[4].analytics.elapsed_ms = 2001;
    },
    "FAIL",
  ],
  [
    "HTTP p95 501",
    (e) => {
      e.events[0].completed_at = at(3_000_501);
    },
    "FAIL",
  ],
  [
    "restore RPO 301",
    (e) => {
      e.restores[0].rpo_seconds = 301;
    },
    "FAIL",
  ],
  [
    "OOM plus missing restore",
    (e) => {
      delete e.restores;
      e.host_samples[0].oom_count = 1;
    },
    "FAIL",
  ],
  [
    "partial sample with guard breach",
    (e) => {
      delete e.host_samples[0].cpu_busy_ratio;
      e.host_samples[0].mem_available_bytes = 1;
    },
    "FAIL",
  ],
  [
    "shortened provenance",
    (e) => {
      e.load_manifest = {
        capacity_pass: false,
        kind: "shortened-local-correctness-only",
        run_id: id,
      };
    },
    "BLOCKED",
  ],
  [
    "failed required check with absent native evidence",
    (e) => {
      e.manifest.checks.baseline.passed = false;
      delete e.restores;
    },
    "FAIL",
  ],
  [
    "unexpected 5xx",
    (e) => {
      e.events[0].status = 503;
    },
    "FAIL",
  ],
  [
    "unowned induced outage",
    (e) => {
      e.events[0].outcome = "failed";
      e.events[0].induced = true;
    },
    "FAIL",
  ],
  [
    "missing scheduling latency",
    (e) => {
      delete e.events[5].scheduling_delay_ms;
    },
    "BLOCKED",
  ],
  [
    "drop",
    (e) => {
      e.collector[1].dropped = 1;
    },
    "FAIL",
  ],
]) {
  test(name, () => {
    const e = fixture();
    mutate(e);
    assert.equal(evaluateRun(e).combined, want);
  });
}
test("reports whitelist data and keep endpoint-specific sample counts", () => {
  const e = fixture();
  e.raw = "postgres://u:SECRET@host";
  e.manifest.images.app = "https://u:SECRET@host";
  e.events[0].error = "Bearer SECRET";
  const report = createReport(e);
  const json = JSON.stringify(report);
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes("postgres://"));
  assert.equal(report.metrics.http.app.count, 1);
  assert.equal(report.metrics.http.app.p95_ms, 500);
});
test("CLI writes reports and returns 0/1/2, malformed or absent evidence stays blocked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capacity-report-"));
  try {
    const cli = () =>
      spawnSync(
        process.execPath,
        ["tools/capacity/report.mjs", "--verdict", dir],
        { encoding: "utf-8" }
      );
    assert.equal(cli().status, 2);
    const e = fixture();
    await writeFile(path.join(dir, "evidence.json"), JSON.stringify(e));
    assert.equal(cli().status, 0);
    e.events[0].status = 503;
    await writeFile(path.join(dir, "evidence.json"), JSON.stringify(e));
    assert.equal(cli().status, 1);
    delete e.restores;
    e.events[0].status = 200;
    await writeFile(path.join(dir, "evidence.json"), JSON.stringify(e));
    assert.equal(cli().status, 2);
    const reports = await Promise.all(
      ["json", "csv", "md"].map((ext) =>
        readFile(path.join(dir, `report.${ext}`), "utf-8")
      )
    );
    for (const report of reports) {
      assert.ok(report.includes("BLOCKED"));
      assert.ok(report.includes("p95_ms"));
    }
    await writeFile(path.join(dir, "load-events.ndjson"), '{"secret":"SECRET"');
    assert.equal(cli().status, 2);
    const redacted = await readFile(path.join(dir, "report.json"), "utf-8");
    assert.ok(!redacted.includes("SECRET"));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("declared phases and passing checks cannot replace measured load", () => {
  const e = fixture();
  e.events = e.events.slice(0, 7);
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("induced outages need declared ownership and recovery; OOM always fails", () => {
  const e = fixture();
  const w = {
    completed_at: at(3_001_000),
    declared_at: at(0),
    kind: "restart",
    ownership_sha256: sha,
    ownership_verified: true,
    recovery_check: check(),
    run_id: id,
    service: "app",
    started_at: at(3_000_000),
  };
  e.manifest.induced_windows = [w];
  e.events[0].service = "app";
  e.events[0].status = 503;
  assert.notEqual(evaluateRun(e).capacity, "FAIL");
  e.host_samples[3000].containers[0].oom = true;
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("malformed evidence does not conceal a proven failure", () => {
  const e = fixture();
  e.host_samples.push(null);
  e.events[0].status = 503;
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("raw producer collector counters retain rejection and reset failures", () => {
  const e = fixture();
  e.events.push({
    kind: "collector_after_expiry",
    metrics: 'otelcol_receiver_refused_log_records{receiver="otlp"} 1',
    run_id: id,
    sequence: e.events.length + 1,
  });
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("prepared retention alone cannot establish ordinary expiry", () => {
  const e = fixture();
  delete e.manifest.checks.retention;
  e.load.prepared_expiry = { elapsed_ms: 1, expired: 20 };
  assert.equal(evaluateRun(e).retention, "BLOCKED");
});
test("a retention attestation without unchanged TTL snapshots is incomplete", () => {
  const e = fixture();
  e.events = e.events
    .filter((v) => !v.kind.startsWith("ordinary_"))
    .map((v, i) => ({ ...v, sequence: i + 1 }));
  assert.equal(evaluateRun(e).retention, "BLOCKED");
});
test("restart attestations without owned predeclared windows are incomplete", () => {
  const e = fixture();
  delete e.manifest.induced_windows;
  assert.equal(evaluateRun(e).restart, "BLOCKED");
});
test("restore actual extension must match the receipt", () => {
  const e = fixture();
  e.restores[0].extensions = [
    {
      image_digest: sha,
      library_version: "0.9.0",
      name: "pg_clickhouse",
      sql_version: "0.10",
    },
  ];
  assert.equal(evaluateRun(e).recovery, "FAIL");
});
test("seed and load declarations cannot hide absent native coverage", () => {
  const e = fixture();
  e.events = e.events.slice(0, 7);
  for (const service of services.slice(0, 4)) {
    e.manifest.requests[service] = [`http://${service}/`];
  }
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("wrong fixture run is rejected even alongside absent recovery", () => {
  const e = fixture();
  e.events[4].analytics.sample[0].run_id = "other";
  delete e.restores;
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("missing fixture details are incomplete, not a claimed measurement failure", () => {
  const e = fixture();
  delete e.events[4].analytics.min_sequence;
  assert.equal(evaluateRun(e).analytics, "BLOCKED");
});
test("malformed nested evidence retains failures in other components", () => {
  const e = fixture();
  e.events[4].analytics.sample = Array.from({ length: 10 }, () => null);
  e.events[0].status = 503;
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("retention DDL changes and overlapping restarts fail", () => {
  const e = fixture();
  e.events.find((v) => v.kind === "ordinary_expiry_verified").retention = {
    mutations: [],
    ttls: [],
  };
  assert.equal(evaluateRun(e).retention, "FAIL");
  const r = fixture();
  r.restarts[1].outage_start = r.restarts[0].outage_start;
  assert.equal(evaluateRun(r).restart, "FAIL");
});
test("endpoint distributions do not pool a slow endpoint into fast bulk requests", () => {
  const e = fixture();
  e.events[0].completed_at = at(3_000_501);
  const report = createReport(e);
  assert.equal(report.verdicts.capacity, "FAIL");
  assert.equal(report.metrics.http.app.count, 1);
  assert.equal(report.metrics.http.app_1.p95_ms, 100);
});

test("producer files cannot silently override conflicting envelope evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capacity-conflict-"));
  try {
    await writeFile(
      path.join(dir, "evidence.json"),
      JSON.stringify({
        events: [{ kind: "http", outcome: "failed", run_id: id, sequence: 1 }],
        run_id: id,
        schema_version: 1,
      })
    );
    await writeFile(
      path.join(dir, "load-events.ndjson"),
      `${JSON.stringify({ kind: "http", outcome: "completed", run_id: id, sequence: 1 })}\n`
    );
    assert.equal(evaluateRun(await readEvidence(dir)).combined, "FAIL");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
test("accounting cannot contradict the actual accepted producer events", () => {
  const e = fixture();
  e.load.accounting = {
    accepted: 0,
    dropped: 0,
    expired: 0,
    pending: 0,
    service_generated: 0,
    stored: 0,
  };
  assert.equal(evaluateRun(e).retention, "FAIL");
});
test("early CPU pressure remains failed after the final sample cools", () => {
  const e = fixture();
  for (const s of e.host_samples.slice(0, 301)) {
    s.cpu_busy_ratio = 0.81;
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("sustained swap remains failed even with complete recovery", () => {
  const e = fixture();
  for (const [i, s] of e.host_samples.entries()) {
    s.swap_in_bytes = Math.min(i, 61) * 4096;
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("native declarations cannot contradict authoritative config hashes", () => {
  const e = fixture();
  e.integration = { manifest: { config_sha256: "b".repeat(64) }, run_id: id };
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("the same ciphertext cannot serve two independently backed up databases", () => {
  const e = fixture();
  e.backups[1].encrypted_sha256 = e.backups[0].encrypted_sha256;
  assert.equal(evaluateRun(e).backup, "FAIL");
});
test("concurrent append reordering retains logical sequence continuity and provenance", () => {
  const e = fixture();
  [e.events[1], e.events[2]] = [e.events[2], e.events[1]];
  const report = createReport(e);
  assert.equal(report.verdicts.combined, "PASS");
  assert.equal(report.metrics.event_order.physical_reordering, true);
});
for (const [name, change] of [
  [
    "duplicate",
    (e) => {
      e.events[1].sequence = 1;
    },
  ],
  [
    "missing first",
    (e) => {
      e.events.shift();
    },
  ],
]) {
  test(`logical event sequence rejects ${name}`, () => {
    const e = fixture();
    change(e);
    assert.equal(evaluateRun(e).combined, "FAIL");
  });
}
test("a submitted operation with no terminal evidence stays incomplete", () => {
  const e = fixture();
  e.events.push({
    accepted_at: at(10_000_000),
    kind: "workflow",
    outcome: "submitted",
    phase: "final",
    run_id: id,
    sequence: e.events.length + 1,
  });
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("nested workflow run contradictions cannot be hidden by an outer envelope", () => {
  const e = fixture();
  e.events[5].probe_event = { event: "completed", run_id: "other" };
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("a present nonobject producer artifact prevents a native PASS", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capacity-shape-"));
  try {
    await writeFile(path.join(dir, "evidence.json"), JSON.stringify(fixture()));
    await writeFile(path.join(dir, "integration-result.json"), "null");
    assert.equal(evaluateRun(await readEvidence(dir)).combined, "BLOCKED");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
test("pushdown proof rejects exponent bounds disguised as the exact fixture range", () => {
  const e = fixture();
  e.events[4].analytics.explain[0].Plan["Remote SQL"] =
    `SELECT count(*), min(sequence), max(sequence) FROM capacity_analytics.ledger_sample WHERE run_id = '${id}' AND sequence >= 1e3 AND sequence <= 10000 LIMIT 1`;
  assert.equal(evaluateRun(e).analytics, "FAIL");
});
test("malformed phase and outage records cannot erase a report failure", () => {
  const e = fixture();
  e.manifest.phases.push(null);
  e.manifest.induced_windows = [null];
  e.events[0].status = 503;
  assert.equal(createReport(e).verdicts.combined, "FAIL");
});
test("serialized provenance preserves nested local-only producer labels", () => {
  const e = fixture();
  e.integration = { load: { capacity_pass: false }, run_id: id };
  assert.equal(createReport(e).coverage.native_staging, false);
});
test("phase duration must be measured numeric data", () => {
  const e = fixture();
  e.manifest.phases[0].duration_ms = "900000";
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("seed declarations cannot contradict the prescribed measured fixture", () => {
  const e = fixture();
  e.manifest.seed.current_events = 0;
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("the direct fixture measurement cannot contradict the Rust analytics output", () => {
  const e = fixture();
  e.load.direct = { max_sequence: 10_000, min_sequence: 1, rows: 9999 };
  assert.equal(evaluateRun(e).analytics, "FAIL");
});
test("reported RPO cannot understate the retained commit watermark loss", () => {
  const e = fixture();
  e.restores[0].rpo_seconds = 0;
  assert.equal(evaluateRun(e).recovery, "FAIL");
});
