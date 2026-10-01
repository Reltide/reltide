import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  discardReports,
  readEvidence,
  serializeReport,
  writeReport,
} from "./report-io.mjs";

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
const components = [
  "capacity",
  "analytics",
  "retention",
  "backup",
  "restart",
  "recovery",
];
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public evaluator boundary validates untrusted JSON fields before classification.
const string = (v) => typeof v === "string";
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-object records at the public evidence boundary.
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const mib = 1024 ** 2;
const finite = (n) => Number.isFinite(n) && n >= 0;
const integer = (n) => finite(n) && Number.isSafeInteger(n);
const utc = (s) =>
  string(s) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(s) &&
  Number.isFinite(Date.parse(s));
const hash = (s) => string(s) && /^(?:sha256:)?[a-f0-9]{64}$/u.test(s);
const timestamp = (value) => (utc(value) ? Date.parse(value) : undefined);
const runId = (s) => string(s) && /^[a-z0-9-]{1,64}$/u.test(s);
const list = (v) => (Array.isArray(v) ? v : []);
const records = (s, values, reason) => {
  s.need(Array.isArray(values) && values.every(record), reason);
  return list(values).filter(record);
};
const combine = (values) => {
  if (values.includes("FAIL")) {
    return "FAIL";
  }
  return values.includes("BLOCKED") ? "BLOCKED" : "PASS";
};
const duration = (start, end) =>
  utc(start) && utc(end) && Date.parse(end) >= Date.parse(start)
    ? Date.parse(end) - Date.parse(start)
    : undefined;
const summary = (values) => {
  const sorted = values.filter(finite).toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p95_ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
};
const state = () => {
  const reasons = [];
  return {
    fail: (bad, reason) => {
      if (
        bad &&
        !reasons.some((v) => v.status === "FAIL" && v.reason === reason)
      ) {
        reasons.push({ reason, status: "FAIL" });
      }
    },
    need: (ok, reason) => {
      if (
        !ok &&
        !reasons.some((v) => v.status === "BLOCKED" && v.reason === reason)
      ) {
        reasons.push({ reason, status: "BLOCKED" });
      }
    },
    reasons,
    verdict: () => combine(reasons.map((r) => r.status)),
  };
};
const required = (s, e, names) => {
  for (const name of names) {
    const c = e.manifest?.checks?.[name];
    s.fail(c?.passed === false, `required check failed: ${name}`);
    s.need(
      c?.passed === true && c.run_id === e.run_id && hash(c.sha256),
      `required check missing: ${name}`
    );
    s.fail(
      c?.run_id !== undefined && c.run_id !== e.run_id,
      "required check run mismatch"
    );
  }
};
const windows = (e) => list(e.manifest?.induced_windows);
const validWindow = (w, e) =>
  ["restart", "restore", "wal-fault"].includes(w?.kind) &&
  w.run_id === e.run_id &&
  w.ownership_verified === true &&
  hash(w.ownership_sha256) &&
  utc(w.declared_at) &&
  utc(w.started_at) &&
  utc(w.completed_at) &&
  Date.parse(w.declared_at) < Date.parse(w.started_at) &&
  duration(w.started_at, w.completed_at) > 0 &&
  w.recovery_check?.passed === true &&
  hash(w.recovery_check.sha256) &&
  w.recovery_check.run_id === e.run_id;
const induced = (e, service, time) =>
  utc(time) &&
  services.includes(service) &&
  windows(e).some(
    (w) =>
      validWindow(w, e) &&
      w.service === service &&
      Date.parse(time) >= Date.parse(w.started_at) &&
      Date.parse(time) <= Date.parse(w.completed_at)
  );
const sequenceGap = (current, previous) =>
  integer(current) && integer(previous) && current !== previous + 1;
const sequenceOutside = (sequence, count) =>
  Number.isFinite(sequence) && (sequence < 1 || sequence > count);
const continuity = (s, rows, id, { logical = false } = {}) => {
  const partial = logical && rows.some((v) => !integer(v?.sequence));
  if (partial) {
    const known = rows.map((v) => v?.sequence).filter(integer);
    // Unknown sequence values may fill gaps, but cannot repair duplicates.
    s.fail(
      new Set(known).size !== known.length,
      "evidence sequence gap or reset"
    );
  }
  s.fail(
    !partial &&
      rows.length > 0 &&
      integer(rows[0]?.sequence) &&
      rows[0].sequence !== 1,
    "evidence sequence does not start at one"
  );
  for (const [i, row] of rows.entries()) {
    s.need(runId(row?.run_id), "evidence run identity missing");
    s.fail(
      row?.run_id !== undefined && row.run_id !== id,
      "mixed run identities"
    );
    s.need(integer(row?.sequence), "missing evidence sequence");
    s.fail(
      sequenceOutside(row?.sequence, rows.length),
      "evidence sequence outside observed range"
    );
    if (i && !partial) {
      s.fail(
        sequenceGap(row?.sequence, rows[i - 1]?.sequence),
        "evidence sequence gap or reset"
      );
    }
  }
};
const exactHost = (h) =>
  h?.id === 167_541_435 &&
  h.name === "reltide-staging" &&
  h.type === "cx23" &&
  h.architecture === "x86" &&
  h.location === "hel1" &&
  h.private_ip === "172.30.0.3" &&
  h.os === "Ubuntu 26.04";
const native = (e) =>
  e.manifest?.kind === "native-staging" &&
  [e.load_manifest, e.integration, e.integration?.load, e.load].every(
    (v) =>
      !v ||
      (v.capacity_pass !== false &&
        !/local|pruning|shortened/u.test(v.kind ?? ""))
  );

const containerChanges = (c, before) => {
  const counted = integer(c.restart_count) && integer(before?.restart_count);
  const identified = string(c.id) && string(before?.id);
  return {
    identity: identified && c.id !== before.id,
    reset: counted && c.restart_count < before.restart_count,
    restart: before
      ? counted && c.restart_count > before.restart_count
      : integer(c.restart_count) && c.restart_count > 0,
  };
};
const containerSample = (s, e, x, prev, c) => {
  s.need(
    string(c.id) &&
      services.includes(c.service) &&
      finite(c.cpu_busy_ratio) &&
      finite(c.memory_bytes) &&
      integer(c.restart_count) &&
      [true, false].includes(c.running) &&
      [true, false].includes(c.oom),
    "partial container metrics"
  );
  const before = list(prev?.containers).find((v) => v?.service === c.service);
  const changes = containerChanges(c, before);
  const disruption =
    (c.running === false ||
      changes.restart ||
      changes.reset ||
      changes.identity) &&
    induced(e, c.service, x.utc);
  s.fail(
    (c.running === false || changes.restart) && !disruption,
    "unexpected restart or exit"
  );
  s.fail(
    (changes.reset || changes.identity) && !disruption,
    "container identity or counter reset"
  );
};
const hostSample = (s, e, x, prev, cs) => {
  s.need(
    [
      "monotonic_ms",
      "mem_available_bytes",
      "root_free_bytes",
      "root_used_ratio",
      "cpu_busy_ratio",
      "oom_count",
      "swap_in_bytes",
      "swap_out_bytes",
    ].every((k) => finite(x[k])) && utc(x.utc),
    "partial host metrics"
  );
  s.need(
    Number.isFinite(x.clock_offset_ms) && Math.abs(x.clock_offset_ms) <= 1000,
    "clock synchronization missing"
  );
  s.fail(
    finite(x.mem_available_bytes) && x.mem_available_bytes < 512 * mib,
    "available memory below 512 MiB"
  );
  s.fail(
    (finite(x.root_used_ratio) && x.root_used_ratio > 0.7) ||
      (finite(x.root_free_bytes) && x.root_free_bytes < 10 * 1024 * mib),
    "root disk guard exceeded"
  );
  s.fail(
    (finite(x.oom_count) && x.oom_count > 0) || cs.some((c) => c.oom === true),
    "OOM detected"
  );
  s.fail(
    (finite(x.cpu_busy_ratio) && x.cpu_busy_ratio > 1) ||
      (finite(x.root_used_ratio) && x.root_used_ratio > 1),
    "invalid host ratios"
  );
  s.need(
    services.every((service) => cs.some((c) => c.service === service)),
    "steady service missing"
  );
  s.fail(
    new Set(cs.map((c) => c.id)).size !== cs.length,
    "duplicate container identity"
  );

  for (const c of cs) {
    containerSample(s, e, x, prev, c);
  }
};
const sampleInterval = (s, x, prev) => {
  const delta =
    finite(x.monotonic_ms) && finite(prev.monotonic_ms)
      ? x.monotonic_ms - prev.monotonic_ms
      : undefined;
  s.need(
    finite(delta) && delta > 0 && delta <= 1500,
    "one-second sample cadence incomplete"
  );
  s.fail(
    (finite(delta) && delta === 0) || delta < 0,
    "nonmonotonic host samples"
  );
  s.need(
    utc(x.utc) &&
      utc(prev.utc) &&
      Math.abs(Date.parse(x.utc) - Date.parse(prev.utc) - delta) <= 1000,
    "UTC sample continuity missing"
  );
  s.fail(
    ["oom_count", "swap_in_bytes", "swap_out_bytes"].some(
      (k) => finite(x[k]) && finite(prev[k]) && x[k] < prev[k]
    ),
    "host counter reset"
  );

  return delta;
};
const resourceWindow = (s, x, prev, delta, queues, totals, peaks) => {
  for (const [key, limit] of [
    ["one_minute", 60_000],
    ["five_minute", 300_000],
  ]) {
    const q = queues[key];
    q.push({
      cpu: x.cpu_busy_ratio,
      delta,
      end: x.monotonic_ms,
      swap:
        (finite(x.swap_in_bytes) &&
          finite(prev.swap_in_bytes) &&
          x.swap_in_bytes > prev.swap_in_bytes) ||
        (finite(x.swap_out_bytes) &&
          finite(prev.swap_out_bytes) &&
          x.swap_out_bytes > prev.swap_out_bytes),
    });
    totals[key] += delta;
    while (q.length && x.monotonic_ms - q[0].end >= limit) {
      totals[key] -= q.shift().delta;
    }
    if (totals[key] >= limit) {
      // Match host.mjs sampleWindow: clip the leading interval at the exact boundary.
      const boundary = x.monotonic_ms - limit;
      const weighted = q.reduce(
        (sum, v) => sum + v.cpu * Math.min(v.delta, v.end - boundary),
        0
      );
      const elapsed = q.reduce(
        (sum, v) => sum + Math.min(v.delta, v.end - boundary),
        0
      );
      const cpu = weighted / elapsed;
      const swap = q.some((v) => v.swap);
      peaks[key].duration_ms = Math.max(peaks[key].duration_ms, elapsed);
      peaks[key].cpu_busy_ratio = Math.max(peaks[key].cpu_busy_ratio, cpu);
      peaks[key].swap_active ||= swap;
      s.fail(key === "five_minute" && cpu > 0.8, "five-minute CPU above 80%");
      s.fail(key === "one_minute" && swap, "sustained swap activity");
    }
  }
};
const hostEvidence = (s, e, metrics) => {
  const samples = list(e.host_samples);
  s.need(samples.length > 0, "host samples missing");
  continuity(s, samples, e.run_id);
  const queues = { five_minute: [], one_minute: [] };
  const totals = { five_minute: 0, one_minute: 0 };
  const peaks = {
    five_minute: { cpu_busy_ratio: 0, duration_ms: 0, swap_active: false },
    one_minute: { cpu_busy_ratio: 0, duration_ms: 0, swap_active: false },
  };
  for (const [i, x] of samples.entries()) {
    const prev = samples[i - 1];
    const cs = records(s, x.containers, "malformed container observations");
    hostSample(s, e, x, prev, cs);
    if (!prev) {
      continue;
    }
    const delta = sampleInterval(s, x, prev);
    if (!(delta > 0 && delta <= 1500 && finite(x.cpu_busy_ratio))) {
      continue;
    }
    resourceWindow(s, x, prev, delta, queues, totals, peaks);
  }
  const phases = list(e.manifest?.phases);
  const start = phases[0]?.started_at;
  const end = phases.at(-1)?.completed_at;
  s.need(
    samples.length > 0 &&
      utc(start) &&
      utc(end) &&
      utc(samples[0].utc) &&
      utc(samples.at(-1).utc) &&
      Date.parse(samples[0].utc) <= Date.parse(start) &&
      Date.parse(samples.at(-1).utc) >= Date.parse(end),
    "host samples truncated"
  );
  metrics.resource_windows = peaks;
  for (const c of records(
    s,
    e.integration?.containers ?? [],
    "malformed integration containers"
  )) {
    s.fail(c.oom === true, "OOM detected");
    s.fail(
      integer(c.restart_count) && c.restart_count > 0,
      "unexpected integration restart"
    );
  }
};
const phaseDuration = (s, p) => {
  s.fail(
    integer(p?.duration_ms) &&
      finite(duration(p?.started_at, p?.completed_at)) &&
      p.duration_ms !== duration(p.started_at, p.completed_at),
    "phase duration contradicts UTC interval"
  );
};
const phaseEvidence = (s, e) => {
  const phases = records(s, e.manifest?.phases, "malformed phase observations");
  const expected = [
    ["idle", 900_000, 0],
    ["ramp-1", 600_000, 1],
    ["ramp-3", 600_000, 3],
    ["ramp-5", 600_000, 5],
    ["soak", 7_200_000, 5],
    ["final", 900_000, 5],
  ];
  s.need(phases.length === 6, "required phases missing");
  for (const [i, [name, ms, rate]] of expected.entries()) {
    const p = phases[i];
    s.need(
      p?.name === name &&
        integer(p.duration_ms) &&
        p.http_rps === rate &&
        p.duration_ms >= ms &&
        duration(p.started_at, p.completed_at) >= ms,
      "phase duration/rate incomplete"
    );
    phaseDuration(s, p);
    if (i && p) {
      s.need(
        phases[i - 1]?.completed_at === p.started_at,
        "phase continuity incomplete"
      );
    }
  }
  s.need(exactHost(e.manifest?.host), "native staging host identity missing");
  s.fail(
    e.manifest?.host !== undefined && !exactHost(e.manifest.host),
    "wrong target host identity"
  );
  s.need(
    hash(e.manifest?.config_sha256) &&
      services.every((k) => hash(e.manifest?.images?.[k])),
    "image/config hashes missing"
  );
  s.need(native(e), "native staging measurements missing");
  for (const [key, want] of Object.entries({
    aged_events: 25_920,
    analytics_rows: 10_000,
    current_events: 2_592_000,
    ledger_rows: 100_000,
  })) {
    const value = e.manifest?.seed?.[key];
    s.need(value !== undefined, "seed declaration missing");
    s.fail(
      value !== undefined && value !== want,
      "seed declaration contradicts prescribed fixture"
    );
  }
  required(s, e, [
    "baseline",
    "limits",
    "load_counts",
    "seed_counts",
    "initializer",
  ]);
};
const httpFailure = (v) =>
  (integer(v.status) && v.status >= 500) ||
  v.outcome === "failed" ||
  v.outcome === "timeout" ||
  v.timeout === true;
const httpMetrics = (s, e, metrics) => {
  metrics.http = {};
  metrics.http_phases = {};
  const phases = list(e.manifest?.phases).filter((p) =>
    ["ramp-1", "ramp-3", "ramp-5", "soak", "final"].includes(p?.name)
  );
  const requests = e.load_manifest?.requests ?? e.manifest?.requests;
  for (const group of ["app", "web", "docs", "api"]) {
    const urls = list(requests?.[group]);
    s.need(urls.length > 0, "HTTP endpoint manifest missing");
    const exclusions = windows(e)
      .filter((w) => validWindow(w, e) && w.service === group)
      .map((w) => [Date.parse(w.started_at), Date.parse(w.completed_at)]);
    for (const [index, url] of urls.entries()) {
      const events = list(e.events).filter(
        (v) =>
          v.kind === "http" &&
          v.url === url &&
          v.outcome === "completed" &&
          !exclusions.some(
            ([start, end]) =>
              utc(v.completed_at) &&
              Date.parse(v.completed_at) >= start &&
              Date.parse(v.completed_at) <= end
          )
      );
      const values = events.map((v) => duration(v.accepted_at, v.completed_at));
      const m = summary(values);
      const key = index === 0 ? group : `${group}_${index}`;
      metrics.http[key] = m;
      s.need(m.count > 0 && m.count === events.length, "HTTP timings missing");
      s.fail(m.p95_ms > 500, "HTTP p95 above 500 ms");
      for (const phase of phases) {
        const phaseValues = events
          .filter((v) => v.phase === phase.name)
          .map((v) => duration(v.accepted_at, v.completed_at));
        const measured = summary(phaseValues);
        (metrics.http_phases[phase.name] ??= {})[key] = measured;
        s.need(
          measured.count > 0 && measured.count === phaseValues.length,
          "phase endpoint HTTP timings missing"
        );
        s.fail(measured.p95_ms > 500, "phase endpoint HTTP p95 above 500 ms");
      }
    }
  }
  for (const v of list(e.events)) {
    if (v.kind !== "http") {
      continue;
    }
    s.fail(
      httpFailure(v) && !induced(e, v.service, v.completed_at),
      "unexpected HTTP failure"
    );
    s.need(
      v.outcome !== "completed" || integer(v.status),
      "HTTP status missing"
    );
  }
};
const collectorEvidence = (s, e) => {
  const rows = list(e.collector);
  continuity(s, rows, e.run_id);
  s.need(rows.length >= 2, "collector counters missing");
  for (const [i, c] of rows.entries()) {
    s.need(
      ["accepted", "dropped", "rejected"].every((k) => integer(c[k])),
      "partial collector counters"
    );
    s.fail(
      (integer(c.dropped) && c.dropped > 0) ||
        (integer(c.rejected) && c.rejected > 0),
      "collector dropped or rejected"
    );
    if (i) {
      s.fail(
        ["accepted", "dropped", "rejected"].some(
          (k) =>
            integer(c[k]) && integer(rows[i - 1][k]) && c[k] < rows[i - 1][k]
        ),
        "collector counter reset"
      );
    }
  }
};
const workloadMetrics = (s, e, metrics) => {
  const completed = list(e.events).filter(
    (v) => v.kind === "workflow_completed"
  );
  const delays = completed.map((v) => v.scheduling_delay_ms);
  const times = completed.map((v) => duration(v.accepted_at, v.completed_at));
  metrics.workflow_delay = summary(delays);
  metrics.workflow_completion = summary(times);
  s.need(
    completed.length > 0 && delays.every(finite) && times.every(finite),
    "workflow timing evidence missing"
  );
  s.fail(
    metrics.workflow_delay.p95_ms > 5000,
    "workflow delay p95 above 5 seconds"
  );
  s.fail(
    metrics.workflow_completion.p95_ms > 10_000,
    "workflow completion p95 above 10 seconds"
  );
  const telemetry = list(e.events).filter(
    (v) =>
      v.kind === "telemetry_stored" &&
      list(e.manifest?.phases).some(
        (p) => p?.name === v.phase && finite(p.http_rps) && p.http_rps > 0
      )
  );
  const lags = [];
  for (const v of telemetry) {
    for (const proof of records(
      s,
      v.proofs,
      "telemetry storage proof malformed"
    )) {
      const eventTime = proof.event_time_ms?.[0];
      const lag =
        utc(proof.stored_at) && integer(eventTime)
          ? Date.parse(proof.stored_at) - eventTime
          : undefined;
      s.need(finite(lag), "telemetry search timing missing");
      s.fail(
        (integer(proof.checksum_errors) && proof.checksum_errors > 0) ||
          (finite(lag) && lag > 30_000),
        "telemetry verification/search delay failed"
      );
      if (finite(lag)) {
        lags.push(lag);
      }
    }
  }
  metrics.telemetry_searchable = summary(lags);
  s.need(lags.length > 0, "steady telemetry search evidence missing");
  for (const v of list(e.events)) {
    s.fail(
      (v.outcome === "failed" || v.outcome === "timeout") &&
        !induced(e, v.service, v.completed_at),
      "unexpected operation failure"
    );
    s.need(
      ["rejected", "dropped"].every((k) => v[k] === undefined || integer(v[k])),
      "partial telemetry failure counters"
    );
    s.fail(
      (integer(v.rejected) && v.rejected > 0) ||
        (integer(v.dropped) && v.dropped > 0),
      "telemetry dropped or rejected"
    );
    s.fail(
      v.kind === "guard_trigger" && v.guard?.stop === true,
      "load guard stopped run"
    );
  }
  collectorEvidence(s, e);
};
const producerCounters = (s, e) => {
  let previous;
  for (const event of list(e.events)) {
    s.need(string(event.kind), "event kind missing or malformed");
    if (!string(event.kind) || !event.kind.startsWith("collector_")) {
      continue;
    }
    if (!string(event.metrics)) {
      continue;
    }
    const current = new Map();
    for (const line of event.metrics.split("\n")) {
      const counter = /^\s*(?<name>otelcol_[a-zA-Z0-9_]+)/u.exec(line)?.groups
        .name;
      if (!counter || !/accepted|refused|dropped|failed|sent/u.test(counter)) {
        continue;
      }
      const match =
        /^\s*(?<name>otelcol_[a-zA-Z0-9_]+)(?<labels>\{[^}]*\})?[ \t]+(?<raw>\S+)(?:[ \t]+[+-]?\d+)?[ \t]*$/u.exec(
          line
        );
      s.need(Boolean(match), "collector counter malformed");
      if (!match) {
        continue;
      }
      const { name, labels = "", raw } = match.groups;
      const value = Number(raw);
      const valid =
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw) &&
        finite(value) &&
        value >= 0;
      s.need(valid, "collector counter malformed or nonfinite");
      if (!valid) {
        continue;
      }
      if (/refused|dropped|failed/u.test(name)) {
        s.fail(value > 0, "collector dropped, refused or failed");
      }
      if (/accepted|refused|dropped|failed|sent/u.test(name)) {
        current.set(name + labels, value);
      }
    }
    if (previous) {
      for (const [key, value] of previous) {
        s.need(current.has(key), "collector counter disappeared");
        s.fail(
          current.has(key) && current.get(key) < value,
          "collector counter reset"
        );
      }
    }
    previous = current;
  }
};
const phaseCoverage = (s, p, rows, count, rate) => {
  const start = timestamp(p.started_at);
  const end = timestamp(p.completed_at);
  const bins = new Map();
  let total = 0;
  const admissions = [];
  for (const v of rows) {
    const admitted = timestamp(v.accepted_at);
    const completed = timestamp(v.completed_at);
    const timed = utc(v.accepted_at) && utc(v.completed_at);
    s.need(timed, "phase observation UTC missing");
    const inside =
      timed &&
      admitted >= start &&
      admitted < end &&
      completed >= admitted &&
      completed <= end;
    s.fail(
      timed && finite(end - start) && !inside,
      "observation contradicts declared phase interval"
    );
    s.need(integer(count(v)), "phase observation count missing");
    if (!inside || !integer(count(v))) {
      continue;
    }
    const bin = Math.floor((admitted - start) / 60_000);
    bins.set(bin, (bins.get(bin) ?? 0) + count(v));
    total += count(v);
    admissions.push({ at: admitted, count: count(v) });
  }
  admissions.sort((a, b) => a.at - b.at);
  let left = 0;
  let active = 0;
  for (const [i, v] of admissions.entries()) {
    active += v.count;
    while (left < i && admissions[left].at <= v.at - 1000) {
      active -= admissions[left].count;
      left += 1;
    }
    s.fail(active > rate, "phase admission rate exceeds prescribed bound");
  }
  let sustained = finite(end - start) && end > start;
  for (let offset = 0; sustained && offset < end - start; offset += 60_000) {
    sustained =
      (bins.get(offset / 60_000) ?? 0) >=
      (Math.min(60_000, end - start - offset) * rate) / 1000;
  }
  s.need(sustained, "sustained phase admissions incomplete");
  return total;
};
const phaseStorage = (s, p, events) => {
  for (const v of events.filter((event) => event.kind === "telemetry_stored")) {
    s.need(utc(v.completed_at), "phase storage completion UTC missing");
    const start = Date.parse(p.started_at);
    const end = Date.parse(p.completed_at);
    for (const proof of records(
      s,
      v.proofs,
      "telemetry storage proof malformed"
    )) {
      s.fail(
        finite(end - start) &&
          ((utc(v.completed_at) &&
            (Date.parse(v.completed_at) < start ||
              Date.parse(v.completed_at) > end)) ||
            (integer(proof.event_time_ms?.[0]) &&
              proof.event_time_ms[0] < start) ||
            (integer(proof.event_time_ms?.[1]) &&
              proof.event_time_ms[1] >= end) ||
            (utc(proof.stored_at) &&
              utc(v.completed_at) &&
              Date.parse(proof.stored_at) > Date.parse(v.completed_at))),
        "storage observation contradicts declared phase interval"
      );
    }
  }
};
const httpMix = (s, e, p, rows) => {
  const requests = e.load_manifest?.requests ?? e.manifest?.requests;
  const expected = (p.duration_ms * p.http_rps) / 1000;
  for (const group of ["app", "web", "docs", "api"]) {
    const urls = list(requests?.[group]);
    const counts = urls.map((url) => rows.filter((v) => v.url === url).length);
    const total = counts.reduce((sum, n) => sum + n, 0);
    s.need(
      total >= Math.floor(expected / 4),
      "phase HTTP service mix incomplete"
    );
    s.fail(
      total > Math.ceil(expected / 4),
      "phase HTTP service mix contradicts prescribed workload"
    );
    for (const count of counts) {
      s.need(
        count >= Math.floor(expected / 4 / urls.length),
        "phase HTTP endpoint mix incomplete"
      );
      s.fail(
        count > Math.ceil(expected / 4 / urls.length),
        "phase HTTP endpoint mix contradicts prescribed workload"
      );
    }
  }
};
const recurringPhase = (s, p, rows) => {
  const start = Date.parse(p.started_at);
  const end = Date.parse(p.completed_at);
  const slots = new Set();
  const ordered = rows.toSorted(
    (a, b) => Date.parse(a.accepted_at) - Date.parse(b.accepted_at)
  );
  let previous;
  for (const v of ordered) {
    const at = Date.parse(v.accepted_at);
    const done = Date.parse(v.completed_at);
    const measured = utc(v.accepted_at) && utc(v.completed_at);
    s.need(measured, "recurring probe timing missing");
    const inside =
      measured && at >= start && at < end && done >= at && done <= end;
    s.fail(
      measured && finite(end - start) && !inside,
      "recurring probe contradicts declared phase interval"
    );
    if (!inside) {
      continue;
    }
    if (previous) {
      s.fail(
        at - Date.parse(previous.accepted_at) < 10_000 ||
          at < Date.parse(previous.completed_at),
        "recurring probe admission overlaps or exceeds cadence"
      );
    }
    slots.add(Math.floor((at - start) / 10_000));
    previous = v;
  }
  s.need(
    slots.size >= Math.ceil((end - start) / 10_000),
    "recurring phase probe coverage incomplete"
  );
  return slots.size;
};
const foregroundCoverage = (s, e, metrics) => {
  metrics.foreground_phases = [];
  for (const p of list(e.manifest?.phases).filter(
    (phase) => phase?.http_rps > 0
  )) {
    const rows = list(e.events).filter(
      (v) =>
        v.phase === p.name &&
        v.kind === "foreground" &&
        v.outcome === "completed" &&
        record(v.search) &&
        record(v.analytics)
    );
    const count = recurringPhase(s, p, rows);
    for (const row of rows) {
      const paired = [row.search.elapsed_ms, row.analytics.elapsed_ms];
      const elapsed = duration(row.accepted_at, row.completed_at);
      s.need(
        paired.every(finite) && finite(elapsed),
        "paired foreground timing missing or nonfinite"
      );
      s.fail(
        paired.some((value) => Number.isFinite(value) && value < 0),
        "negative foreground timing"
      );
      // ISO timestamps have millisecond precision; the enclosing interval can
      // understate monotonic durations by less than one millisecond.
      s.fail(
        paired.every((value) => finite(value) && value >= 0) &&
          finite(elapsed) &&
          paired[0] + paired[1] > elapsed + 1,
        "serial foreground timings exceed enclosing interval"
      );
    }
    const search = summary(rows.map((v) => v.search.elapsed_ms));
    const foreign = summary(rows.map((v) => v.analytics.elapsed_ms));
    s.fail(
      search.p95_ms > 2000 || foreign.p95_ms > 2000,
      "phase analytics p95 above 2 seconds"
    );
    metrics.foreground_phases.push({
      count,
      foreign,
      phase: ["ramp-1", "ramp-3", "ramp-5", "soak", "final"].includes(p.name)
        ? p.name
        : null,
      search,
    });
  }
};
const workflowIdentity = (v) =>
  string(v.workflow_id) &&
  v.workflow_id.length > 0 &&
  string(v.temporal_run_id) &&
  v.temporal_run_id.length > 0 &&
  integer(v.workflow_sequence);
const workflowCoverage = (s, e, metrics) => {
  const groups = new Map();
  for (const v of list(e.events).filter((event) =>
    ["workflow_started", "workflow_completed"].includes(event.kind)
  )) {
    const known = workflowIdentity(v);
    s.need(known, "workflow admission identity missing");
    if (!known) {
      continue;
    }
    const group = groups.get(v.workflow_id) ?? [];
    group.push(v);
    groups.set(v.workflow_id, group);
  }
  const matched = [];
  for (const rows of groups.values()) {
    const starts = rows.filter((v) => v.kind === "workflow_started");
    const ends = rows.filter((v) => v.kind === "workflow_completed");
    s.need(
      starts.length > 0 && ends.length > 0,
      "matched workflow admission/completion missing"
    );
    s.fail(
      starts.length > 1 || ends.length > 1,
      "duplicate workflow admission or completion"
    );
    if (starts.length !== 1 || ends.length !== 1) {
      continue;
    }
    const [a] = starts;
    const [b] = ends;
    s.fail(
      a.temporal_run_id !== b.temporal_run_id ||
        a.workflow_sequence !== b.workflow_sequence ||
        a.phase !== b.phase ||
        a.sequence >= b.sequence,
      "workflow completion contradicts admission identity"
    );
    s.need(
      utc(a.accepted_at) && utc(b.accepted_at),
      "workflow admission UTC missing"
    );
    s.fail(
      utc(a.accepted_at) &&
        utc(b.accepted_at) &&
        a.accepted_at !== b.accepted_at,
      "workflow completion contradicts admission UTC"
    );
    matched.push(b);
  }
  metrics.workflow_phases = [];
  for (const p of list(e.manifest?.phases).filter(
    (phase) => phase?.http_rps > 0
  )) {
    const count = recurringPhase(
      s,
      p,
      matched.filter((v) => v.phase === p.name)
    );
    metrics.workflow_phases.push({
      count,
      phase: ["ramp-1", "ramp-3", "ramp-5", "soak", "final"].includes(p.name)
        ? p.name
        : null,
    });
  }
};
const measuredCoverage = (s, e, metrics) => {
  metrics.phase_counts = [];
  for (const p of records(
    s,
    e.manifest?.phases,
    "malformed phase observations"
  )) {
    const events = list(e.events).filter((v) => v.phase === p.name);
    httpMix(
      s,
      e,
      p,
      events.filter((v) => v.kind === "http" && v.outcome === "completed")
    );
    const http = phaseCoverage(
      s,
      p,
      events.filter((v) => v.kind === "http" && v.outcome === "completed"),
      () => 1,
      p.http_rps
    );
    const telemetry = phaseCoverage(
      s,
      p,
      events.filter((v) => v.kind === "telemetry_accepted"),
      (v) => v.accepted,
      p.http_rps > 0 ? 10 : 0
    );
    const stored = events
      .filter((v) => v.kind === "telemetry_stored")
      .reduce((sum, v) => sum + (integer(v.stored) ? v.stored : 0), 0);
    s.need(
      http >= (p.duration_ms * p.http_rps) / 1000,
      "realized phase HTTP coverage incomplete"
    );
    s.need(
      p.http_rps === 0 || telemetry >= p.duration_ms / 100,
      "realized phase telemetry coverage incomplete"
    );
    s.need(
      p.http_rps === 0 || stored === telemetry,
      "phase telemetry storage coverage incomplete"
    );
    const admitted = events.filter((v) => v.kind === "telemetry_accepted");
    s.fail(
      admitted.length > 0 &&
        admitted.every((v) => integer(v.accepted)) &&
        stored > admitted.reduce((sum, v) => sum + v.accepted, 0),
      "phase storage exceeds measured admissions"
    );
    phaseStorage(s, p, events);
    metrics.phase_counts.push({
      http,
      phase: ["idle", "ramp-1", "ramp-3", "ramp-5", "soak", "final"].includes(
        p.name
      )
        ? p.name
        : null,
      telemetry,
    });
  }
  for (const [cohort, count] of [
    ["current", 2_592_000],
    ["aged", 25_920],
  ]) {
    const accepted = list(e.events)
      .filter(
        (v) =>
          v.kind === "telemetry_accepted" &&
          v.phase === "seed" &&
          v.cohort === cohort
      )
      .reduce((sum, v) => sum + (integer(v.accepted) ? v.accepted : 0), 0);
    s.need(accepted === count, "prescribed seed coverage incomplete");
  }
};
const proofMeasurements = (s, proofs, cohort) => {
  for (const proof of proofs) {
    const times = list(proof.event_time_ms);
    s.need(
      times.length === 2 &&
        times.every(integer) &&
        utc(proof.stored_at) &&
        integer(proof.checksum_errors),
      "storage proof measurement missing"
    );
    s.fail(
      (integer(proof.checksum_errors) && proof.checksum_errors > 0) ||
        (times.every(integer) &&
          times.length === 2 &&
          (times[1] < times[0] ||
            (utc(proof.stored_at) && Date.parse(proof.stored_at) < times[1]))),
      "storage proof measurement contradicts event time"
    );
    if (integer(times[1])) {
      cohort.event_time = Math.max(cohort.event_time, times[1]);
    }
    if (utc(proof.stored_at)) {
      cohort.stored_at = Math.max(
        cohort.stored_at,
        Date.parse(proof.stored_at)
      );
    }
  }
};
const telemetryCounts = (s, e) => {
  const cohorts = new Map();
  let stored = 0;
  let complete = list(e.events).some((v) => v.kind === "telemetry_stored");
  s.need(complete, "telemetry storage observations missing");
  for (const v of list(e.events).filter((event) =>
    ["telemetry_accepted", "telemetry_stored"].includes(event.kind)
  )) {
    const key = ["current", "aged", "boundary", "steady"].includes(v.cohort)
      ? v.cohort
      : undefined;
    s.need(key, "telemetry cohort relationship missing");
    const cohort = cohorts.get(key) ?? {
      accepted: 0,
      admission_complete: true,
      admissions: 0,
      complete: true,
      event_time: 0,
      stored: 0,
      stored_at: 0,
    };
    if (v.kind === "telemetry_accepted") {
      s.need(integer(v.accepted), "telemetry admission count missing");
      cohort.admission_complete &&= integer(v.accepted);
      if (integer(v.accepted)) {
        cohort.accepted += v.accepted;
        cohort.admissions += 1;
      }
    } else {
      const proofs = records(s, v.proofs, "telemetry storage proof malformed");
      const measured =
        proofs.length > 0 &&
        proofs.length === list(v.proofs).length &&
        proofs.every((p) => integer(p.rows));
      const counted = measured && integer(v.stored);
      s.need(counted, "telemetry storage row count missing");
      complete &&= counted;
      cohort.complete &&= counted;
      const rows = proofs.reduce(
        (sum, p) => sum + (integer(p.rows) ? p.rows : 0),
        0
      );
      s.fail(
        measured && integer(v.stored) && rows !== v.stored,
        "storage proof contradicts stored event total"
      );
      proofMeasurements(s, proofs, cohort);
      if (measured) {
        stored += rows;
        cohort.stored += rows;
      }
    }
    cohorts.set(key, cohort);
  }
  for (const [key, c] of cohorts) {
    if (key) {
      s.need(c.admissions > 0, "cohort admission evidence missing");
      s.fail(
        c.admission_complete && c.admissions > 0 && c.stored > c.accepted,
        "cohort storage exceeds admitted rows"
      );
    }
  }
  return { cohorts, complete, stored };
};
const realPushdown = (plan, fixture) => {
  if (Array.isArray(plan)) {
    return plan.some((v) => realPushdown(v, fixture));
  }
  if (!record(plan)) {
    return false;
  }
  if (plan["Node Type"] === "Aggregate") {
    return false;
  }
  const sql = plan["Remote SQL"];
  if (string(sql)) {
    const normalized = sql.toLowerCase().replaceAll(/[\s"()]/gu, "");
    const prefix =
      "selectcount*,minsequence,maxsequencefromcapacity_analytics.ledger_samplewhere";
    const predicates = normalized
      .slice(prefix.length, -6)
      .replace(`run_id='${fixture}'`, "run_id=fixture")
      .split("and")
      .toSorted();
    return (
      normalized.startsWith(prefix) &&
      normalized.endsWith("limit1") &&
      isDeepStrictEqual(predicates, [
        "run_id=fixture",
        "sequence<=10000",
        "sequence>=1",
      ])
    );
  }
  return Object.values(plan).some((v) => realPushdown(v, fixture));
};
const fixtureRows = (s, v) => {
  for (const [key, want] of [
    ["rows", 10_000],
    ["min_sequence", 1],
    ["max_sequence", 10_000],
  ]) {
    s.need(integer(v[key]), "analytics fixture measurement missing");
    s.fail(
      v[key] !== undefined && v[key] !== want,
      "analytics fixture mismatch"
    );
  }
};
const analyticsOutput = (s, v, fixture) => {
  fixtureRows(s, v);
  s.need(
    [true, false].includes(v.pushdown) && v.explain !== undefined,
    "pushdown proof missing"
  );
  s.fail(
    v.pushdown === false ||
      (v.explain !== undefined &&
        runId(fixture) &&
        !realPushdown(v.explain, fixture)),
    "false or failed pushdown claim"
  );
  records(s, v.sample, "analytics type mapping missing");
  s.fail(
    Array.isArray(v.sample) &&
      (v.sample.length !== 10 ||
        v.sample.some(
          (row, i) =>
            record(row) &&
            ((runId(fixture) && row.run_id !== fixture) ||
              row.sequence !== i + 1)
        )),
    "analytics type mapping or run mismatch"
  );
  s.need(
    v.library_version !== undefined && v.sql_version !== undefined,
    "extension versions missing"
  );
  s.fail(
    (v.library_version !== undefined && v.library_version !== "0.10.0") ||
      (v.sql_version !== undefined && v.sql_version !== "0.10"),
    "extension version mismatch"
  );
};
const searchResult = (s, e, search) => {
  s.need(
    integer(search.rows) &&
      string(search.saved_search_id) &&
      search.saved_search_id.length > 0 &&
      hash(search.first_id),
    "HyperDX result evidence missing"
  );
  const expected = createHash("sha256")
    .update(`${e.run_id}:current:1`)
    .digest("hex");
  s.fail(
    (integer(search.rows) && search.rows === 0) ||
      (hash(search.first_id) && search.first_id !== expected),
    "HyperDX result contradicts telemetry fixture"
  );
};
const analyticsEvidence = (s, e, metrics) => {
  const direct = e.integration?.load?.direct ?? e.load?.direct;
  if (direct) {
    fixtureRows(s, direct);
  }
  const outputs = [];
  const searches = [];
  const fixture = e.manifest?.fixture_run_id;
  s.need(runId(fixture), "analytics fixture relationship missing");
  for (const v of list(e.events)) {
    if (v.kind === "probe_output" && v.rows !== undefined) {
      outputs.push(v);
    }
    if (v.analytics) {
      s.fail(
        runId(fixture) && v.analytics.run_id !== fixture,
        "nested analytics run mismatch"
      );
      outputs.push(v.analytics);
    }
    if (v.search) {
      searches.push(v.search);
      searchResult(s, e, v.search);
    }
  }
  s.need(outputs.length > 0, "analytics output missing");
  for (const v of outputs) {
    analyticsOutput(s, v, fixture);
  }
  metrics.foreign_query = summary(outputs.map((v) => v.elapsed_ms));
  metrics.hyperdx = summary(searches.map((v) => v.elapsed_ms));
  s.need(
    outputs.every((v) => finite(v.elapsed_ms)),
    "foreign query timing missing"
  );
  s.need(
    searches.length > 0 && searches.every((v) => finite(v.elapsed_ms)),
    "separate HyperDX timing missing"
  );
  s.fail(
    metrics.foreign_query.p95_ms > 2000 || metrics.hyperdx.p95_ms > 2000,
    "analytics p95 above 2 seconds"
  );
  required(s, e, [
    "least_privilege",
    "outage_isolation",
    "extension_after_restore",
  ]);
};
const ordinaryRetention = (s, e, metrics) => {
  const before = list(e.events).find(
    (v) => v.kind === "ordinary_expiry_baseline"
  );
  const after = list(e.events).find(
    (v) => v.kind === "ordinary_expiry_verified"
  );
  s.need(before && after, "ordinary expiry evidence incomplete");
  const inventory = records(s, e.retention?.tables, "malformed TTL inventory");
  const names = [
    "otel_logs",
    "otel_traces",
    "otel_traces_trace_id_ts",
    "otel_metrics_exponential_histogram",
    "otel_metrics_gauge",
    "otel_metrics_histogram",
    "otel_metrics_sum",
    "otel_metrics_summary",
  ];
  s.need(
    names.every((name) =>
      inventory.some(
        (v) => v.name === name && v.ttl_days === 3 && hash(v.ddl_sha256)
      )
    ),
    "complete data-table TTL inventory missing"
  );
  s.fail(
    inventory.some((v) => finite(v.ttl_days) && v.ttl_days !== 3),
    "data-table TTL is not three days"
  );
  metrics.retention = {
    ordinary_expiry_verified: false,
    prepared_fixture_present: Boolean(
      e.integration?.aged_fixture_retention || e.load?.prepared_expiry
    ),
    tables: inventory
      .filter((v) => names.includes(v.name))
      .map((v) => ({
        ddl_sha256: hash(v.ddl_sha256) ? v.ddl_sha256 : null,
        name: v.name,
        ttl_days: finite(v.ttl_days) ? v.ttl_days : null,
      })),
  };
  if (!before || !after) {
    return;
  }
  const baseline = before.retention;
  s.need(
    list(baseline?.ttls).length === 2 &&
      records(s, baseline?.mutations, "malformed retention mutations").every(
        (v) => Number(v.is_done) === 1
      ),
    "ordinary TTL baseline incomplete"
  );
  s.fail(
    records(s, baseline?.ttls, "malformed retention DDL").some(
      (v) => !/TTL .*toIntervalDay\(3\)/u.test(v.ddl)
    ),
    "ordinary baseline TTL is not three days"
  );
  s.fail(
    JSON.stringify(baseline) !== JSON.stringify(after.retention),
    "ordinary TTL changed"
  );
  s.fail(after.elapsed_ms > 3_600_000, "ordinary expiry exceeded one hour");
  const boundary = Date.parse(before.last_event_expired_after);
  const observations = list(e.events).filter(
    (v) => v.kind === "normal_expiry_observation" && v.cohort === "boundary"
  );
  const stored = observations.some(
    (v) => v.remaining > 0 && Date.parse(v.observed_at) < boundary
  );
  const expired = observations.some(
    (v) =>
      v.remaining === 0 &&
      Date.parse(v.observed_at) >= boundary &&
      Date.parse(v.observed_at) - boundary <= 3_600_000
  );
  s.need(
    stored && expired && after.expired > 0,
    "ordinary expiry storage/boundary proof missing"
  );
  metrics.retention.ordinary_expiry_verified = stored && expired;
};
const restoreCompatibility = (s, r, receipts) => {
  s.need(Array.isArray(r.extensions), "restored extension identity missing");
  if (Array.isArray(r.extensions)) {
    s.fail(
      receipts.some((v) => !isDeepStrictEqual(v.extensions, r.extensions)),
      "restored extension receipt mismatch"
    );
  }
  s.need(hash(r.checks?.sha256), "restore check evidence hash missing");
  s.need(
    r.ownership_verified === true && hash(r.ownership_sha256),
    "fresh restore volume ownership missing"
  );
  s.fail(r.ownership_verified === false, "restore target not owned");
  const elapsed = duration(r.started_at, r.healthy_at);
  s.need(finite(elapsed), "restore wall-clock timing missing");
  s.fail(
    finite(elapsed) && elapsed > 1_800_000,
    "restore wall-clock RTO exceeded"
  );
  s.fail(
    finite(elapsed) &&
      finite(r.rto_seconds) &&
      Math.abs(elapsed / 1000 - r.rto_seconds) > 1,
    "restore RTO contradicts measured interval"
  );
};
const expiryObservations = (s, counts, observations) => {
  let complete = true;
  let previousCount;
  let previousTime;
  let zero;
  for (const v of observations) {
    s.need(
      integer(v.remaining) && utc(v.observed_at),
      "cohort expiry observation missing"
    );
    complete &&= integer(v.remaining) && utc(v.observed_at);
    s.fail(
      counts.complete && integer(v.remaining) && v.remaining > counts.stored,
      "expiry count exceeds measured cohort storage"
    );
    s.fail(
      (utc(v.observed_at) &&
        utc(previousTime) &&
        Date.parse(v.observed_at) < Date.parse(previousTime)) ||
        (integer(v.remaining) &&
          integer(previousCount) &&
          v.remaining > previousCount),
      "cohort expiry observations contradict continuity"
    );
    if (v.remaining === 0 && utc(v.observed_at)) {
      zero = v;
    }
    if (integer(v.remaining)) {
      previousCount = v.remaining;
    }
    if (utc(v.observed_at)) {
      previousTime = v.observed_at;
    }
  }
  return { complete, zero };
};
const expiryCounts = (s, e, cohorts) => {
  let total = 0;
  let complete = cohorts.size > 0 && !cohorts.has(undefined);
  for (const [cohort, counts] of cohorts) {
    complete &&= counts.complete;
    const observations = list(e.events).filter(
      (v) => v.kind === "normal_expiry_observation" && v.cohort === cohort
    );
    const observed = expiryObservations(s, counts, observations);
    complete &&= observed.complete;
    const { zero } = observed;
    if (!zero) {
      if (["aged", "boundary"].includes(cohort)) {
        complete = false;
      }
      continue;
    }
    if (!counts.complete) {
      continue;
    }
    const expiredAt = counts.event_time + 3 * 86_400_000;
    s.fail(
      Date.parse(zero.observed_at) < expiredAt ||
        Date.parse(zero.observed_at) < counts.stored_at,
      "cohort expiry precedes measured retention boundary"
    );
    total += counts.stored;
    if (cohort === "boundary") {
      const verified = list(e.events).find(
        (v) => v.kind === "ordinary_expiry_verified"
      );
      s.need(integer(verified?.expired), "ordinary expiry count missing");
      s.fail(
        integer(verified?.expired) && verified.expired !== counts.stored,
        "ordinary expiry contradicts measured cohort storage"
      );
      s.need(
        observations.some(
          (v) =>
            v.remaining === counts.stored &&
            Date.parse(v.observed_at) < expiredAt
        ),
        "ordinary expiry initial cohort count missing"
      );
    }
  }
  return complete ? total : undefined;
};
const accountingRows = (s, e, a, counts, expired) => {
  const admissions = list(e.events).filter(
    (v) => v.kind === "telemetry_accepted"
  );
  const accepted = admissions.reduce(
    (sum, v) => sum + (integer(v.accepted) ? v.accepted : 0),
    0
  );
  s.fail(
    admissions.length > 0 &&
      admissions.every((v) => integer(v.accepted)) &&
      integer(a.accepted) &&
      a.accepted !== accepted,
    "accounting contradicts accepted event totals"
  );
  s.fail(a.dropped > 0, "accounted drops");
  s.fail(
    counts.complete &&
      integer(a.stored) &&
      integer(a.expired) &&
      a.stored + a.expired !== counts.stored,
    "accounting contradicts measured storage totals"
  );
  s.need(expired !== undefined, "cohort expiry accounting incomplete");
  s.fail(
    expired !== undefined && integer(a.expired) && a.expired !== expired,
    "accounting contradicts observed cohort expiry"
  );
  s.fail(
    integer(a.accepted) &&
      integer(a.stored) &&
      integer(a.expired) &&
      integer(a.pending) &&
      a.accepted !== a.stored + a.expired + a.pending + a.dropped,
    "telemetry accounting mismatch"
  );
  s.need(a.pending === 0, "telemetry still pending");
};
const retentionEvidence = (s, e, metrics) => {
  const load = e.integration?.load ?? e.load;
  const a = load?.accounting;
  const counts = telemetryCounts(s, e);
  const expired = expiryCounts(s, e, counts.cohorts);
  s.need(
    a &&
      [
        "accepted",
        "stored",
        "expired",
        "pending",
        "dropped",
        "service_generated",
      ].every((k) => integer(a[k])),
    "telemetry accounting missing"
  );
  if (a) {
    accountingRows(s, e, a, counts, expired);
    metrics.accounting = Object.fromEntries(
      [
        "accepted",
        "stored",
        "expired",
        "pending",
        "dropped",
        "service_generated",
      ].map((k) => [k, integer(a[k]) ? a[k] : null])
    );
  }
  const p = load?.projection;
  s.need(
    !p || p.label === "growth projection, not measured three-day capacity",
    "unlabelled growth projection"
  );
  if (p) {
    metrics.projection = {
      label: "growth projection, not measured three-day capacity",
      observed_stored_bytes: finite(p.observed_stored_bytes)
        ? p.observed_stored_bytes
        : null,
      projected_three_day_bytes: finite(p.projected_three_day_bytes)
        ? p.projected_three_day_bytes
        : null,
    };
  }
  ordinaryRetention(s, e, metrics);
  required(s, e, ["retention"]);
};
const lsn = (value) => {
  if (!string(value) || !/^[\dA-Fa-f]{1,8}\/[\dA-Fa-f]{1,8}$/u.test(value)) {
    return;
  }
  const [high, low] = value.split("/").map((part) => BigInt(`0x${part}`));
  return high * 4_294_967_296n + low;
};
const validReceipt = (r) =>
  string(r.server_version) &&
  /^\d+(?:\.\d+)*$/u.test(r.server_version) &&
  string(r.system_identifier) &&
  /^\d+$/u.test(r.system_identifier) &&
  integer(r.timeline) &&
  r.timeline > 0 &&
  runId(r.base_id) &&
  list(r.wal_range).length === 2 &&
  r.wal_range.every((v) => lsn(v) !== undefined) &&
  hash(r.encrypted_sha256) &&
  integer(r.bytes) &&
  r.bytes > 0 &&
  utc(r.uploaded_at) &&
  integer(r.operations_reserved?.class_a) &&
  integer(r.operations_reserved?.class_b);
const backupReceipt = (s, e, r, kind, metrics) => {
  s.need(runId(r.run_id), "backup run identity missing or malformed");
  s.fail(runId(r.run_id) && r.run_id !== e.run_id, "backup run mismatch");
  s.need(validReceipt(r), "backup receipt incomplete");
  const [start, end] = list(r.wal_range).map(lsn);
  s.fail(
    start !== undefined && end !== undefined && start > end,
    "backup WAL bounds reversed"
  );
  s.fail(finite(r.bytes) && r.bytes > 256 * mib, "base archive above 256 MiB");
  s.fail(r.download_verified === false, "backup download verification failed");
  s.need(
    r.download_verified === true,
    "external encrypted download verification missing"
  );
  if (hash(r.encrypted_sha256)) {
    metrics.receipt_hashes.push(r.encrypted_sha256);
  }
  const supported = kind === "application" || kind === "temporal";
  s.need(supported, "backup kind missing or unsupported");
  if (!supported) {
    return;
  }
  s.need(Array.isArray(r.extensions), "backup extension manifest missing");
  if (Array.isArray(r.extensions)) {
    s.fail(
      kind === "temporal" && r.extensions.length > 0,
      "Temporal extension must be absent"
    );
    s.fail(
      kind === "application" &&
        (r.extensions.length !== 1 ||
          r.extensions[0]?.name !== "pg_clickhouse" ||
          r.extensions[0]?.library_version !== "0.10.0" ||
          r.extensions[0]?.sql_version !== "0.10"),
      "application backup extension mismatch"
    );
    s.need(
      kind !== "application" || hash(r.extensions[0]?.image_digest),
      "backup extension image hash missing"
    );
  }
};
const backupEvidence = (s, e, metrics) => {
  const receipts = list(e.backups);
  metrics.receipt_hashes = [];
  const hashes = receipts.map((r) => r.encrypted_sha256).filter(hash);
  s.fail(
    new Set(hashes).size !== hashes.length,
    "backup ciphertext identities overlap"
  );
  for (const r of receipts) {
    backupReceipt(s, e, r, r.kind, metrics);
  }
  for (const kind of ["application", "temporal"]) {
    const matches = receipts.filter((r) => r.kind === kind);
    s.need(matches.length > 0, `${kind} backup missing`);
  }
  s.fail(
    receipts.reduce((sum, r) => sum + (finite(r.bytes) ? r.bytes : 0), 0) > 1e9,
    "backup storage above 1 GB"
  );
  for (const [key, max] of [
    ["class_a", 5000],
    ["class_b", 20_000],
  ]) {
    s.fail(
      receipts.reduce(
        (sum, r) =>
          sum +
          (finite(r.operations_reserved?.[key])
            ? r.operations_reserved[key]
            : 0),
        0
      ) > max,
      "backup operation budget exceeded"
    );
  }
  required(s, e, ["wal_freshness", "encrypted_download", "backup_limits"]);
};
const restartEvidence = (s, e, metrics) => {
  const rows = list(e.restarts).toSorted(
    (a, b) => Date.parse(a.outage_start) - Date.parse(b.outage_start)
  );
  s.need(
    services.every((service) => rows.some((r) => r.service === service)),
    "service restart coverage missing"
  );
  metrics.restart_seconds = [];
  for (const [index, r] of rows.entries()) {
    const ms = duration(r.outage_start, r.healthy_at);
    s.need(
      induced(e, r.service, r.outage_start),
      "restart declaration/ownership missing"
    );
    if (index) {
      s.fail(
        Date.parse(r.outage_start) - Date.parse(rows[index - 1].healthy_at) <
          300_000,
        "restart healthy interval below five minutes"
      );
    }
    s.fail(r.run_id !== e.run_id, "restart run mismatch");
    s.need(
      services.includes(r.service) && finite(ms),
      "restart timing missing"
    );
    s.fail(
      ms > 120_000 || r.replay_result === false,
      "restart readiness/replay failed"
    );
    s.need(
      r.replay_result === true && r.healthy_window_seconds >= 300,
      "restart replay/healthy window missing"
    );
    if (finite(ms)) {
      metrics.restart_seconds.push(ms / 1000);
    }
  }
  for (const w of windows(e)) {
    s.need(validWindow(w, e), "induced window ownership/recovery missing");
    s.fail(w.recovery_check?.passed === false, "induced recovery check failed");
  }
  required(s, e, ["restart_coverage", "restart_replay", "lost_ack_once"]);
};
const restoreSummary = (r, kind) => ({
  coverage: "clean-volume recovery; not cold-host RTO",
  kind,
  lost_commits: integer(r.lost_commits) ? r.lost_commits : null,
  recovery_cut: utc(r.recovery_cut) ? r.recovery_cut : null,
  rpo_seconds: finite(r.rpo_seconds) ? r.rpo_seconds : null,
  rto_seconds: finite(r.rto_seconds) ? r.rto_seconds : null,
  watermark: {
    committed_at: utc(r.watermark?.committed_at)
      ? r.watermark.committed_at
      : null,
    sequence: integer(r.watermark?.sequence) ? r.watermark.sequence : null,
    sha256: hash(r.watermark?.sha256) ? r.watermark.sha256 : null,
  },
});
const validRestore = (r) =>
  r.source_volume_unmounted === true &&
  string(r.target_volume) &&
  r.target_volume.startsWith("reltide-capacity-") &&
  utc(r.recovery_cut) &&
  integer(r.lost_commits) &&
  finite(r.rpo_seconds) &&
  finite(r.rto_seconds);
const recoveryEvidence = (s, e, metrics) => {
  const rows = list(e.restores);
  metrics.restores = [];
  for (const kind of ["application", "temporal"]) {
    const matches = rows.filter((r) => r.kind === kind);
    s.need(matches.length === 1, `${kind} restore missing`);
    for (const r of matches) {
      s.fail(r.run_id !== e.run_id, "restore run mismatch");
      s.need(validRestore(r), "restore fields incomplete");
      s.fail(
        r.source_volume_unmounted === false ||
          (finite(r.rpo_seconds) && r.rpo_seconds > 300) ||
          (finite(r.rto_seconds) && r.rto_seconds > 1800),
        "restore protection/RPO/RTO failed"
      );
      const receipts = list(e.backups).filter((v) => v.kind === kind);
      restoreCompatibility(s, r, receipts);
      s.need(list(r.input_receipts).length > 0, "restore receipts missing");
      s.fail(
        list(r.input_receipts).some(
          (h) => !hash(h) || !receipts.some((v) => v.encrypted_sha256 === h)
        ),
        "restore receipt mismatch"
      );
      for (const key of [
        "passed",
        "download_decrypt_verify_included",
        "clean_volume",
        "extension_compatible",
      ]) {
        s.need(r.checks?.[key] === true, "restore verification missing");
        s.fail(r.checks?.[key] === false, "restore verification failed");
      }
      s.need(
        integer(r.watermark?.sequence) &&
          hash(r.watermark?.sha256) &&
          utc(r.watermark?.committed_at),
        "restore watermark missing"
      );
      if (utc(r.recovery_cut) && utc(r.watermark?.committed_at)) {
        const loss =
          (Date.parse(r.recovery_cut) - Date.parse(r.watermark.committed_at)) /
          1000;
        s.fail(loss > 300, "restore watermark loss above 300 seconds");
        s.fail(
          finite(r.rpo_seconds) && Math.abs(loss - r.rpo_seconds) > 1,
          "restore RPO contradicts commit watermark"
        );
      }
      metrics.restores.push(restoreSummary(r, kind));
    }
  }
  s.fail(
    new Set(rows.map((r) => r.recovery_cut)).size > 1,
    "restore recovery cuts differ"
  );
  s.fail(
    rows.length > 1 &&
      new Set(rows.map((r) => r.target_volume)).size < rows.length,
    "restore target volumes overlap"
  );
  required(s, e, [
    "recovery_common_cut",
    "recovery_volumes",
    "recovery_checks",
  ]);
};
const operationContinuity = (s, e) => {
  const lanes = new Map();
  for (const v of list(e.events)) {
    s.fail(
      v.probe_event?.run_id !== undefined && v.probe_event.run_id !== e.run_id,
      "nested workflow run mismatch"
    );
    s.fail(
      utc(v.accepted_at) &&
        utc(v.completed_at) &&
        Date.parse(v.completed_at) < Date.parse(v.accepted_at),
      "operation completion precedes admission"
    );
    const key = `${v.phase}:${v.kind}`;
    const count = lanes.get(key) ?? { submitted: 0, terminal: 0 };
    if (v.outcome === "submitted") {
      count.submitted += 1;
    }
    if (["completed", "failed", "cancelled", "timeout"].includes(v.outcome)) {
      count.terminal += 1;
    }
    lanes.set(key, count);
  }
  s.need(
    [...lanes.values()].every((v) => v.submitted <= v.terminal),
    "submitted operation completion missing"
  );
};
const artifactConsistency = (s, e) => {
  for (const field of ["config_sha256", "requests"]) {
    const actual = e.integration?.manifest?.[field] ?? e.load_manifest?.[field];
    s.fail(
      e.manifest?.[field] !== undefined &&
        actual !== undefined &&
        !isDeepStrictEqual(e.manifest[field], actual),
      "native manifest contradicts producer artifact"
    );
  }
  for (const name of services) {
    const expected = e.manifest?.images?.[name];
    const actual = e.integration?.manifest?.images?.[name];
    s.fail(
      hash(expected) &&
        string(actual) &&
        !actual.endsWith(expected.replace("sha256:", "")),
      "native image contradicts producer artifact"
    );
  }
};
const artifactIdentities = (s, e) => {
  for (const [name, v] of [
    ["manifest", e.manifest],
    ["load_manifest", e.load_manifest],
    ["integration", e.integration],
  ]) {
    if (name !== "manifest" && v === undefined) {
      continue;
    }
    s.need(runId(v?.run_id), "artifact run identity missing or malformed");
    s.fail(
      runId(v?.run_id) && v.run_id !== e.run_id,
      "mixed artifact run identities"
    );
  }
};
const evaluate = (input = {}) => {
  const e = record(input) ? { ...input } : {};
  const arrays = [
    "events",
    "host_samples",
    "backups",
    "restarts",
    "restores",
    "collector",
  ];
  const malformed = arrays.some(
    (k) =>
      e[k] !== undefined &&
      (!Array.isArray(e[k]) || e[k].some((v) => !v || !record(v)))
  );
  for (const k of arrays) {
    e[k] = list(e[k]).filter((v) => v && record(v));
  }
  const states = Object.fromEntries(components.map((k) => [k, state()]));
  const metrics = {};
  const integrity = state();
  integrity.need(
    e.schema_version === 1 && runId(e.run_id),
    "versioned run envelope missing"
  );
  integrity.fail(
    e.artifact_conflict === true,
    "authoritative artifact contradicts envelope"
  );
  integrity.need(
    !e.incomplete && !malformed,
    "input artifact missing or malformed"
  );
  artifactIdentities(integrity, e);
  const ordered = list(e.events).toSorted((a, b) => {
    if (!integer(a.sequence)) {
      return integer(b.sequence) ? 1 : 0;
    }
    return integer(b.sequence) ? a.sequence - b.sequence : -1;
  });
  metrics.event_order = {
    count: ordered.length,
    physical_reordering: ordered.some((v, i) => v !== e.events[i]),
  };
  e.events = ordered;
  continuity(integrity, ordered, e.run_id, { logical: true });
  artifactConsistency(integrity, e);
  for (const c of Object.values(e.manifest?.checks ?? {})) {
    integrity.fail(c?.passed === false, "required check failed");
  }
  integrity.fail(
    e.integration?.result === "FAIL" || e.integration?.result === "FAILED",
    "integration failed"
  );
  const checks = {
    analytics: [analyticsEvidence, foregroundCoverage],
    backup: [backupEvidence],
    capacity: [
      phaseEvidence,
      hostEvidence,
      httpMetrics,
      workloadMetrics,
      telemetryCounts,
      measuredCoverage,
      producerCounters,
      operationContinuity,
      workflowCoverage,
    ],
    recovery: [recoveryEvidence],
    restart: [restartEvidence],
    retention: [retentionEvidence],
  };
  for (const [name, functions] of Object.entries(checks)) {
    for (const run of functions) {
      try {
        run(states[name], e, metrics);
      } catch {
        states[name].need(false, "malformed component evidence");
      }
    }
  }
  const verdicts = {};
  const reasons = {};
  for (const name of components) {
    reasons[name] = [...integrity.reasons, ...states[name].reasons];
    verdicts[name] = combine(reasons[name].map((v) => v.status));
  }
  verdicts.combined = combine(Object.values(verdicts));
  return { metrics, reasons, verdicts };
};
export const evaluateRun = (evidence) => evaluate(evidence).verdicts;
export const createReport = (evidence = {}) => {
  const data = record(evidence) ? evidence : {};
  return serializeReport(data, evaluate(data), {
    host: exactHost(data.manifest?.host),
    native: native(data),
    windows: windows(data).map((w) => validWindow(w, data)),
  });
};
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4 || process.argv[2] !== "--verdict") {
    process.stderr.write(
      "Usage: node tools/capacity/report.mjs --verdict <run-directory>\n"
    );
    process.exitCode = 2;
  } else {
    try {
      const report = await writeReport(
        process.argv[3],
        createReport(await readEvidence(process.argv[3]))
      );
      process.stdout.write(`${report.verdicts.combined}\n`);
      process.exitCode = { BLOCKED: 2, FAIL: 1, PASS: 0 }[
        report.verdicts.combined
      ];
    } catch {
      await discardReports(process.argv[3]);
      process.stderr.write(
        "BLOCKED: evidence could not be evaluated or report could not be written\n"
      );
      process.exitCode = 2;
    }
  }
}
