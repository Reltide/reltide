import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    accepted_at: at(3_000_000 + i * 200),
    completed_at: at(3_000_500 + i * 200),
    kind: "http",
    outcome: "completed",
    phase: "soak",
    run_id: id,
    sequence: i + 1,
    status: 200,
    url: `http://${service}/bulk`,
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
        first_id: createHash("sha256").update(`${id}:current:1`).digest("hex"),
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
      cohort: "steady",
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
  Object.assign(events[5], {
    temporal_run_id: "unit-temporal-100002",
    workflow_id: `reltide-capacity-${id}-100002`,
    workflow_sequence: 100_002,
  });
  events.splice(5, 0, {
    ...events[5],
    completed_at: null,
    kind: "workflow_started",
    outcome: "accepted",
  });
  let workflowSequence = 100_002;
  for (const phase of phaseRecords.filter((p) => p.http_rps > 0)) {
    const start = Date.parse(phase.started_at);
    for (let i = 0; i < (phase.duration_ms * phase.http_rps) / 1000; i += 1) {
      const ms = start + (i * 1000) / phase.http_rps;
      if (
        phase.name === "soak" &&
        ms >= Date.parse(at(3_000_000)) &&
        ms < Date.parse(at(3_000_800))
      ) {
        continue;
      }
      const service = services[i % 4];
      events.push({
        accepted_at: new Date(ms).toISOString(),
        completed_at: new Date(ms + 100).toISOString(),
        kind: "http",
        outcome: "completed",
        phase: phase.name,
        run_id: id,
        status: 200,
        url: `http://${service}/${Math.floor(i / 4) % 2 ? "bulk" : ""}`,
      });
    }
    for (let offset = 0; offset < phase.duration_ms; offset += 10_000) {
      const ms = start + offset;
      if (ms === Date.parse(at(3_000_000))) {
        continue;
      }
      events.push({
        ...structuredClone(events[4]),
        accepted_at: new Date(ms).toISOString(),
        completed_at: new Date(ms + 4000).toISOString(),
        phase: phase.name,
      });
      workflowSequence += 1;
      const workflow = {
        ...events[6],
        accepted_at: new Date(ms).toISOString(),
        completed_at: new Date(ms + 10_000).toISOString(),
        phase: phase.name,
        temporal_run_id: `unit-temporal-${workflowSequence}`,
        workflow_id: `reltide-capacity-${id}-${workflowSequence}`,
        workflow_sequence: workflowSequence,
      };
      events.push(
        {
          ...workflow,
          completed_at: null,
          kind: "workflow_started",
          outcome: "accepted",
        },
        workflow
      );
    }
    for (let offset = 0; offset < phase.duration_ms; offset += 1000) {
      const ms = start + offset;
      events.push({
        accepted: 10,
        accepted_at: new Date(ms).toISOString(),
        cohort: "steady",
        completed_at: new Date(ms + 1).toISOString(),
        kind: "telemetry_accepted",
        phase: phase.name,
        rejected: 0,
        run_id: id,
      });
      if (ms === Date.parse(at(3_000_000))) {
        continue;
      }
      events.push({
        cohort: "steady",
        completed_at: new Date(ms + 100).toISOString(),
        kind: "telemetry_stored",
        phase: phase.name,
        proofs: [
          {
            checksum_errors: 0,
            event_time_ms: [ms, ms + 45],
            rows: 10,
            stored_at: new Date(ms + 100).toISOString(),
          },
        ],
        run_id: id,
        stored: 10,
      });
    }
  }
  for (const [cohort, count] of [
    ["current", 2_592_000],
    ["aged", 25_920],
    ["boundary", 20],
  ]) {
    const eventTime = Date.parse(
      at(
        cohort === "current"
          ? -60_000
          : -3 * 86_400_000 + (cohort === "boundary" ? 2000 : -60_000)
      )
    );
    for (let offset = 0; offset < count; offset += 256) {
      const rows = Math.min(256, count - offset);
      events.push(
        {
          accepted: rows,
          accepted_at: at(-30_000),
          cohort,
          completed_at: at(-29_999),
          kind: "telemetry_accepted",
          phase: "seed",
          rejected: 0,
          run_id: id,
        },
        {
          cohort,
          completed_at: at(-20_000),
          kind: "telemetry_stored",
          phase: "seed",
          proofs: [
            {
              checksum_errors: 0,
              event_time_ms: [eventTime, eventTime],
              rows,
              stored_at: at(-20_000),
            },
          ],
          run_id: id,
          stored: rows,
        }
      );
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
      cohort: "aged",
      kind: "normal_expiry_observation",
      observed_at: at(0),
      remaining: 0,
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
        accepted: 2_716_940,
        dropped: 0,
        expired: 25_940,
        pending: 0,
        service_generated: 0,
        stored: 2_691_000,
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
// These cases catch silently skipped counter evidence and preserve proven failures.
test.each([
  ["decimal", "1000000", "FAIL"],
  ["exponent", "1e6", "FAIL"],
  ["signed exponent with whitespace", "\t+1.0E+6\t", "FAIL"],
  ["positive infinity", "+Inf", "BLOCKED"],
  ["negative infinity", "-Inf", "BLOCKED"],
  ["not a number", "NaN", "BLOCKED"],
  ["malformed", "1e", "BLOCKED"],
  ["negative counter", "-1", "BLOCKED"],
  ["zero exponent", "0e0", "PASS"],
  ["zero decimal", ".0", "PASS"],
])("review counter %s", (_name, value, expected) => {
  const e = fixture();
  e.events.push({
    kind: "collector_after",
    metrics: `otelcol_exporter_send_failed_spans_total ${value}`,
    run_id: id,
    sequence: e.events.length + 1,
  });
  assert.equal(evaluateRun(e).combined, expected);
});
test("review counter reset across exponent notation fails", () => {
  const e = fixture();
  for (const value of ["1e6", "999999"]) {
    e.events.push({
      kind: "collector_after",
      metrics: `otelcol_receiver_accepted_spans_total ${value}`,
      run_id: id,
      sequence: e.events.length + 1,
    });
  }
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test.each([
  ["alone", false, "BLOCKED"],
  ["before proven failure", true, "FAIL"],
])("review malformed event kind %s", (_name, failed, expected) => {
  const e = fixture();
  e.events.push({ kind: 123, run_id: id, sequence: e.events.length + 1 });
  if (failed) {
    e.events.push({
      kind: "collector_after",
      metrics: "otelcol_exporter_send_failed_spans_total 1000000",
      run_id: id,
      sequence: e.events.length + 1,
    });
  }
  const result = createReport(e);
  assert.equal(result.verdicts.combined, expected);
  assert.ok(
    result.reasons.capacity.some((reason) => reason.status === "BLOCKED")
  );
});
test.each([
  ["manifest", undefined, "BLOCKED"],
  ["manifest", 123, "BLOCKED"],
  ["manifest", "INVALID", "BLOCKED"],
  ["manifest", "other-run", "FAIL"],
  ["integration", undefined, "BLOCKED"],
  ["integration", 123, "BLOCKED"],
  ["integration", "INVALID", "BLOCKED"],
  ["integration", "other-run", "FAIL"],
  ["load_manifest", undefined, "BLOCKED"],
  ["load_manifest", "other-run", "FAIL"],
  ["integration", id, "PASS"],
])("review artifact %s identity %s", (artifact, run_id, expected) => {
  const e = fixture();
  e[artifact] ??= {};
  e[artifact].run_id = run_id;
  assert.equal(evaluateRun(e).combined, expected);
});
test.each([
  ["serial contradiction", 2000, 2000, 100, "FAIL"],
  ["missing search", undefined, 2000, 4000, "BLOCKED"],
  ["missing analytics", 2000, undefined, 4000, "BLOCKED"],
  ["negative search", -1, 2000, 4000, "FAIL"],
  ["nonfinite analytics", 2000, Infinity, 4000, "BLOCKED"],
  ["paired durations", 2000, 2000, 4000, "PASS"],
  ["millisecond rounding", 2000.4, 1999.4, 3999, "PASS"],
  ["beyond rounding", 2000, 2000, 3998, "FAIL"],
])(
  "review foreground timing %s",
  (_name, search, analyticsMs, elapsed, expected) => {
    const e = fixture();
    const row = e.events.find((event) => event.kind === "foreground");
    row.search.elapsed_ms = search;
    row.analytics.elapsed_ms = analyticsMs;
    row.completed_at = new Date(
      Date.parse(row.accepted_at) + elapsed
    ).toISOString();
    assert.equal(evaluateRun(e).combined, expected);
  }
);
test.each([
  ["reversed", ["0/200", "0/100"], "FAIL"],
  ["cross-word reversed", ["1/0", "0/FFFFFFFF"], "FAIL"],
  ["cross-word ordered", ["0/FFFFFFFF", "1/0"], "PASS"],
  ["equal", ["1/0", "1/0"], "PASS"],
  ["overflow high", ["100000000/0", "100000001/0"], "BLOCKED"],
  ["overflow low", ["0/0", "0/100000000"], "BLOCKED"],
  ["malformed", ["0/G", "1/0"], "BLOCKED"],
  ["missing", undefined, "BLOCKED"],
])("review WAL range %s", (_name, range, expected) => {
  const e = fixture();
  e.backups[0].wal_range = range;
  assert.equal(evaluateRun(e).combined, expected);
});
test.each([
  ["complete unit evidence passes", "complete", "PASS"],
  ["missing future restore evidence remains blocked", "restores", "BLOCKED"],
  ["missing foreground evidence remains blocked", "foreground", "BLOCKED"],
])("%s", (_name, missing, expected) => {
  const e = fixture();
  if (missing === "restores") {
    delete e.restores;
  }
  if (missing === "foreground") {
    e.events = e.events
      .filter((x) => x.kind !== "foreground")
      .map((x, i) => ({ ...x, sequence: i + 1 }));
  }
  assert.equal(evaluateRun(e).combined, expected);
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
      for (const v of e.events.filter((event) => event.analytics)) {
        v.analytics.elapsed_ms = 2001;
      }
    },
    "FAIL",
  ],
  [
    "HTTP p95 501",
    (e) => {
      for (const v of e.events.filter(
        (event) =>
          event.kind === "http" &&
          event.url === "http://app/" &&
          event.phase === "ramp-1"
      )) {
        v.completed_at = new Date(
          Date.parse(v.accepted_at) + 501
        ).toISOString();
      }
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
      delete e.events.find((v) => v.kind === "workflow_completed")
        .scheduling_delay_ms;
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
  assert.equal(
    report.metrics.http.app.count,
    e.events.filter((v) => v.kind === "http" && v.url === "http://app/").length
  );
  assert.equal(report.metrics.http.app.p95_ms, 100);
});
test.each([
  ["absent evidence", 2],
  ["complete evidence", 0],
  ["measured HTTP failure", 1],
  ["missing restores with JSON/CSV/Markdown reports", 2],
  ["malformed events with redacted output", 2],
])("CLI writes reports: %s", async (scenario, expected) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capacity-report-"));
  const stale = "STALE_REPORT_FROM_PREVIOUS_INVOCATION";
  try {
    const cli = () =>
      spawnSync(
        process.execPath,
        ["tools/capacity/report.mjs", "--verdict", dir],
        { encoding: "utf-8" }
      );
    if (scenario !== "absent evidence") {
      await Promise.all(
        ["json", "csv", "md"].map((ext) =>
          writeFile(path.join(dir, `report.${ext}`), stale)
        )
      );
      const e = fixture();
      if (scenario === "measured HTTP failure") {
        e.events[0].status = 503;
      }
      if (
        scenario === "missing restores with JSON/CSV/Markdown reports" ||
        scenario === "malformed events with redacted output"
      ) {
        delete e.restores;
        e.events[0].status = 200;
      }
      await writeFile(path.join(dir, "evidence.json"), JSON.stringify(e));
    }
    if (scenario === "malformed events with redacted output") {
      await writeFile(
        path.join(dir, "load-events.ndjson"),
        '{"secret":"SECRET"'
      );
    }
    assert.equal(cli().status, expected);
    if (scenario !== "absent evidence") {
      const reports = await Promise.all(
        ["json", "csv", "md"].map((ext) =>
          readFile(path.join(dir, `report.${ext}`), "utf-8")
        )
      );
      for (const report of reports) {
        assert.ok(!report.includes(stale));
      }
    }
    if (scenario === "missing restores with JSON/CSV/Markdown reports") {
      const reports = await Promise.all(
        ["json", "csv", "md"].map((ext) =>
          readFile(path.join(dir, `report.${ext}`), "utf-8")
        )
      );
      for (const report of reports) {
        assert.ok(report.includes("BLOCKED"));
        assert.ok(report.includes("p95_ms"));
      }
    }
    if (scenario === "malformed events with redacted output") {
      const redacted = await readFile(path.join(dir, "report.json"), "utf-8");
      assert.ok(!redacted.includes("SECRET"));
    }
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
    e.manifest.requests[service] = [`http://${service}/bulk`];
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
  for (const v of e.events.filter(
    (event) =>
      event.kind === "http" &&
      event.url === "http://app/" &&
      event.phase === "ramp-1"
  )) {
    v.completed_at = new Date(Date.parse(v.accepted_at) + 501).toISOString();
  }
  const report = createReport(e);
  assert.equal(report.verdicts.capacity, "FAIL");
  assert.equal(
    report.metrics.http.app.count,
    e.events.filter((v) => v.kind === "http" && v.url === "http://app/").length
  );
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
  e.events.find((v) => v.kind === "workflow_completed").probe_event = {
    event: "completed",
    run_id: "other",
  };
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

test("round 1 malformed containers cannot hide a later OOM", () => {
  const e = fixture();
  e.host_samples[0].containers.unshift(null);
  e.host_samples[100].oom_count = 1;
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("round 1 malformed analytics sample cannot hide latency failure", () => {
  const e = fixture();
  const output = e.events.find((v) => v.analytics).analytics;
  output.sample[0] = null;
  for (const v of e.events.filter((event) => event.analytics)) {
    v.analytics.elapsed_ms = 2001;
  }
  assert.equal(evaluateRun(e).analytics, "FAIL");
});
test("round 1 missing nested observations block while later guards survive", () => {
  const e = fixture();
  e.events.find((v) => v.proofs).proofs.unshift(null);
  e.events.push({
    guard: { stop: true },
    kind: "guard_trigger",
    run_id: id,
    sequence: e.events.length + 1,
  });
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 HTTP phase labels cannot cover observations outside the experiment", () => {
  const e = fixture();
  for (const v of e.events.filter((event) => event.kind === "http")) {
    v.accepted_at = "2026-10-02T00:00:00.000Z";
    v.completed_at = "2026-10-02T00:00:00.100Z";
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 one burst exceeds prescribed admission rate", () => {
  const e = fixture();
  for (const v of e.events.filter((event) => event.kind === "http")) {
    const p = e.manifest.phases.find((phase) => phase.name === v.phase);
    v.accepted_at = p.started_at;
    v.completed_at = new Date(Date.parse(p.started_at) + 100).toISOString();
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 declared duration must agree with measured UTC interval", () => {
  const e = fixture();
  e.manifest.phases[0].duration_ms += 1000;
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 zero measured storage rows contradict positive stored totals", () => {
  const e = fixture();
  for (const v of e.events.filter(
    (event) => event.kind === "telemetry_stored"
  )) {
    for (const p of v.proofs) {
      p.rows = 0;
    }
  }
  assert.equal(evaluateRun(e).combined, "FAIL");
});
test("round 1 absent storage proof count stays incomplete", () => {
  const e = fixture();
  delete e.events.find((v) => v.proofs).proofs[0].rows;
  assert.equal(evaluateRun(e).combined, "BLOCKED");
});
test("round 1 accounting cannot relabel retained telemetry as expired", () => {
  const e = fixture();
  e.load.accounting.expired = e.load.accounting.accepted;
  e.load.accounting.stored = 0;
  assert.equal(evaluateRun(e).retention, "FAIL");
});
test("round 1 expiry claim must match its observed cohort decrease", () => {
  const e = fixture();
  e.events.find((v) => v.kind === "ordinary_expiry_verified").expired += 1;
  assert.equal(evaluateRun(e).retention, "FAIL");
});
test("round 1 HyperDX zero rows and wrong fixture identity fail", () => {
  for (const update of [{ rows: 0 }, { first_id: "f".repeat(64) }]) {
    const e = fixture();
    Object.assign(e.events.find((v) => v.search).search, update);
    assert.equal(evaluateRun(e).analytics, "FAIL");
  }
});
test("round 1 HyperDX missing result identifiers remains incomplete", () => {
  for (const field of ["first_id", "saved_search_id", "rows"]) {
    const e = fixture();
    e.events.find((v) => v.search).search[field] = undefined;
    assert.equal(evaluateRun(e).analytics, "BLOCKED");
  }
});
test("round 1 malformed nested samples alone remain incomplete", () => {
  const e = fixture();
  e.host_samples[0].containers.unshift(null);
  e.events.find((v) => v.analytics).analytics.sample[0] = null;
  assert.equal(evaluateRun(e).combined, "BLOCKED");
});
test("round 1 storage completion and event times must belong to their phase", () => {
  for (const change of [
    (v) => {
      v.completed_at = at(0);
    },
    (v) => {
      v.proofs[0].event_time_ms = [Date.parse(at(0)), Date.parse(at(1))];
    },
  ]) {
    const e = fixture();
    change(e.events.find((v) => v.kind === "telemetry_stored"));
    assert.equal(evaluateRun(e).capacity, "FAIL");
  }
});
test("round 1 missing cohort expiry observations remain incomplete", () => {
  const e = fixture();
  e.events = e.events.filter((v) => v.kind !== "normal_expiry_observation");
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).retention, "BLOCKED");
});
test("round 1 minute totals cannot hide a one-second admission burst", () => {
  const e = fixture();
  for (const v of e.events.filter((event) => event.kind === "http")) {
    const start = Date.parse(
      e.manifest.phases.find((p) => p.name === v.phase).started_at
    );
    const burst =
      start + Math.floor((Date.parse(v.accepted_at) - start) / 60_000) * 60_000;
    v.accepted_at = new Date(burst).toISOString();
    v.completed_at = new Date(burst + 100).toISOString();
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 a missing measured minute is incomplete without an invented failure", () => {
  const e = fixture();
  e.events = e.events.filter(
    (v) =>
      v.kind !== "http" ||
      Date.parse(v.accepted_at) < Date.parse(at(3_060_000)) ||
      Date.parse(v.accepted_at) >= Date.parse(at(3_120_000))
  );
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("round 1 missing cohort storage counts do not fabricate expiry contradictions", () => {
  const e = fixture();
  delete e.events.find(
    (v) => v.kind === "telemetry_stored" && v.cohort === "boundary"
  ).proofs[0].rows;
  assert.equal(evaluateRun(e).combined, "BLOCKED");
});
test("round 1 missing phase admission timestamp is incomplete", () => {
  const e = fixture();
  delete e.events.find(
    (v) => v.kind === "telemetry_accepted" && v.phase === "soak"
  ).accepted_at;
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("round 1 missing admission counts remain incomplete without contradicting totals", () => {
  const e = fixture();
  delete e.events.find(
    (v) => v.kind === "telemetry_accepted" && v.cohort === "boundary"
  ).accepted;
  assert.equal(evaluateRun(e).combined, "BLOCKED");
});
test("round 1 telemetry minute totals cannot hide oversized admissions", () => {
  const e = fixture();
  for (const v of e.events.filter(
    (event) => event.kind === "telemetry_accepted" && event.cohort === "steady"
  )) {
    const start = Date.parse(
      e.manifest.phases.find((p) => p.name === v.phase).started_at
    );
    const burst =
      start + Math.floor((Date.parse(v.accepted_at) - start) / 60_000) * 60_000;
    v.accepted_at = new Date(burst).toISOString();
    v.completed_at = new Date(burst + 1).toISOString();
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("round 1 HyperDX uses the outer telemetry run separately from analytics", () => {
  const e = fixture();
  e.manifest.fixture_run_id = `${id}-analytics`;
  for (const event of e.events.filter((v) => v.analytics)) {
    const output = event.analytics;
    output.run_id = e.manifest.fixture_run_id;
    for (const row of output.sample) {
      row.run_id = output.run_id;
    }
    output.explain[0].Plan["Remote SQL"] = output.explain[0].Plan[
      "Remote SQL"
    ].replace(`'${id}'`, `'${output.run_id}'`);
  }
  assert.equal(evaluateRun(e).analytics, "PASS");
  e.events.find((v) => v.search).search.first_id = createHash("sha256")
    .update(`${e.manifest.fixture_run_id}:current:1`)
    .digest("hex");
  assert.equal(evaluateRun(e).analytics, "FAIL");
});

test("round 2 unavailable HyperDX identifiers stay incomplete", () => {
  for (const value of [null, undefined, "", 0, {}]) {
    const e = fixture();
    e.events.find((v) => v.search).search.first_id = value;
    assert.equal(evaluateRun(e).analytics, "BLOCKED");
  }
});
test("round 2 unavailable HyperDX identifiers preserve measured failures", () => {
  for (const update of [{ rows: 0 }, { elapsed_ms: 2001 }]) {
    const e = fixture();
    for (const v of e.events.filter((event) => event.search)) {
      Object.assign(v.search, { first_id: null, ...update });
    }
    assert.equal(evaluateRun(e).analytics, "FAIL");
  }
});
test.each([
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["numeric string", "0"],
  ["false", false],
  ["object", {}],
])(
  "round 2 unavailable expiry counts do not fabricate increases: %s",
  (_name, value) => {
    const e = fixture();
    const index = e.events.findIndex(
      (v) => v.kind === "normal_expiry_observation" && v.cohort === "boundary"
    );
    e.events.splice(index, 0, {
      ...e.events[index],
      observed_at: at(500),
      remaining: value,
    });
    for (const [i, v] of e.events.entries()) {
      v.sequence = i + 1;
    }
    assert.equal(evaluateRun(e).retention, "BLOCKED");
  }
);
test("round 2 unavailable expiry time does not fabricate reversal", () => {
  const e = fixture();
  const index = e.events.findIndex(
    (v) => v.kind === "normal_expiry_observation" && v.cohort === "boundary"
  );
  e.events.splice(index + 1, 0, { ...e.events[index], observed_at: "0" });
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).retention, "BLOCKED");
});
test("round 2 missing expiry count cannot hide a measured increase across the gap", () => {
  const e = fixture();
  const index = e.events.findIndex(
    (v) => v.kind === "normal_expiry_observation" && v.cohort === "boundary"
  );
  e.events.splice(
    index,
    0,
    { ...e.events[index], observed_at: at(250), remaining: 10 },
    { ...e.events[index], observed_at: at(500), remaining: null }
  );
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).retention, "FAIL");
});
test("round 2 missing expiry count cannot hide a measured time reversal", () => {
  const e = fixture();
  const index = e.events.findIndex(
    (v) => v.kind === "normal_expiry_observation" && v.cohort === "boundary"
  );
  e.events.splice(index, 0, {
    ...e.events[index],
    observed_at: at(1500),
    remaining: null,
  });
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).retention, "FAIL");
});

test("final review slow ramp HTTP cannot be diluted by a fast soak", () => {
  const e = fixture();
  for (const v of e.events.filter(
    (event) => event.kind === "http" && event.phase === "ramp-1"
  )) {
    v.completed_at = new Date(Date.parse(v.accepted_at) + 501).toISOString();
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("final review measured HTTP mix cannot concentrate on one service", () => {
  const e = fixture();
  for (const v of e.events.filter(
    (event) => event.kind === "http" && event.phase === "ramp-1"
  )) {
    v.url = "http://app/bulk";
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("final review sparse foreground and workflow evidence is incomplete", () => {
  const e = fixture();
  let foreground = false;
  let workflow = false;
  e.events = e.events.filter((v) => {
    if (v.kind === "foreground") {
      if (foreground) {
        return false;
      }
      foreground = true;
    }
    if (v.kind === "workflow_completed") {
      if (workflow) {
        return false;
      }
      workflow = true;
    }
    return true;
  });
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("final review clipped CPU windows agree with the live guard under jitter", async () => {
  const { evaluateGuard } = await import("./host.mjs");
  const e = fixture();
  e.host_samples = e.host_samples.slice(0, 301).map((v, i) => ({
    ...v,
    cpu_busy_ratio: i < 2 ? 0 : 0.802,
    monotonic_ms: i * 1001,
    utc: at(i * 1001),
  }));
  const guard = evaluateGuard(e.host_samples);
  assert.equal(guard.status, "FAIL");
  const report = createReport(e);
  assert.equal(
    report.metrics.resource_windows.five_minute.cpu_busy_ratio,
    guard.windows.five_minute.cpu_busy_ratio
  );
  assert.equal(
    report.metrics.resource_windows.five_minute.duration_ms,
    300_000
  );
  assert.equal(report.verdicts.capacity, "FAIL");
});
test("final review unavailable clock offsets stay incomplete", () => {
  const e = fixture();
  for (const v of e.host_samples) {
    v.clock_offset_ms = null;
  }
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
  e.host_samples[100].oom_count = 1;
  assert.equal(evaluateRun(e).capacity, "FAIL");
});

test("final review endpoint mix is measured inside each phase", () => {
  const e = fixture();
  for (const v of e.events.filter(
    (event) =>
      event.kind === "http" &&
      event.phase === "ramp-3" &&
      event.url === "http://app/"
  )) {
    v.url = "http://app/bulk";
  }
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
test("final review foreground needs completed pairs in each phase slot", () => {
  for (const change of [
    (v) => {
      delete v.search;
    },
    (v) => {
      v.accepted_at = at(0);
    },
    (v) => {
      v.completed_at = at(20_000_000);
    },
  ]) {
    const e = fixture();
    const v = e.events.find(
      (event) => event.kind === "foreground" && event.phase === "ramp-1"
    );
    change(v);
    assert.equal(evaluateRun(e).analytics, v.search ? "FAIL" : "BLOCKED");
  }
});
test("final review missing recurring workflow admission blocks and conflicting identity fails", () => {
  const e = fixture();
  const start = e.events.find((v) => v.kind === "workflow_started");
  const complete = e.events.find(
    (v) =>
      v.kind === "workflow_completed" && v.workflow_id === start.workflow_id
  );
  complete.temporal_run_id = "other-temporal-run";
  assert.equal(evaluateRun(e).capacity, "FAIL");
  complete.temporal_run_id = start.temporal_run_id;
  e.events = e.events.filter((v) => v !== start);
  for (const [i, v] of e.events.entries()) {
    v.sequence = i + 1;
  }
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("final review clock type validation accepts signed numbers only", () => {
  const e = fixture();
  for (const v of e.host_samples) {
    v.clock_offset_ms = -1000;
  }
  assert.equal(evaluateRun(e).capacity, "PASS");
  e.host_samples[100].clock_offset_ms = "0";
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
});
test("final review guard window agreement includes clear CPU and clipped swap activity", async () => {
  const { evaluateGuard } = await import("./host.mjs");
  const e = fixture();
  e.host_samples = e.host_samples.slice(0, 301).map((v, i) => ({
    ...v,
    cpu_busy_ratio: 0.799,
    monotonic_ms: i * 1001,
    utc: at(i * 1001),
  }));
  const guard = evaluateGuard(e.host_samples);
  assert.equal(guard.status, "CLEAR");
  const report = createReport(e);
  assert.ok(
    Math.abs(
      report.metrics.resource_windows.five_minute.cpu_busy_ratio -
        guard.windows.five_minute.cpu_busy_ratio
    ) < 1e-12
  );
  assert.equal(
    report.metrics.resource_windows.five_minute.duration_ms,
    guard.windows.five_minute.duration_ms
  );
  e.host_samples = e.host_samples.slice(0, 61);
  for (const [i, v] of e.host_samples.entries()) {
    v.swap_in_bytes = i > 0 ? 1 : 0;
  }
  const swapped = evaluateGuard(e.host_samples);
  assert.equal(
    createReport(e).metrics.resource_windows.one_minute.swap_active,
    swapped.windows.one_minute.swap_active
  );
});
test("final review phase HTTP latency excludes only verified induced windows", () => {
  const e = fixture();
  const phase = e.manifest.phases.find((p) => p.name === "ramp-1");
  for (const v of e.events.filter(
    (event) =>
      event.kind === "http" &&
      event.phase === phase.name &&
      event.url === "http://app/"
  )) {
    v.completed_at = new Date(Date.parse(v.accepted_at) + 501).toISOString();
  }
  const window = {
    completed_at: phase.completed_at,
    declared_at: at(0),
    kind: "restart",
    ownership_sha256: sha,
    ownership_verified: true,
    recovery_check: check(),
    run_id: id,
    service: "app",
    started_at: phase.started_at,
  };
  e.manifest.induced_windows.push(window);
  assert.equal(evaluateRun(e).capacity, "BLOCKED");
  window.ownership_verified = false;
  assert.equal(evaluateRun(e).capacity, "FAIL");
});
