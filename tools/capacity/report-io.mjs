import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Redacted serialization accepts only validated string fields from untrusted JSON.
const string = (v) => typeof v === "string";
const finite = (n) => Number.isFinite(n) && n >= 0;
const integer = (n) => finite(n) && Number.isSafeInteger(n);
const utc = (s) =>
  string(s) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(s) &&
  Number.isFinite(Date.parse(s));
const imageHash = (v) =>
  string(v) ? (v.match(/(?:sha256:)?[a-f0-9]{64}$/u)?.[0] ?? null) : null;
const hash = (s) => string(s) && /^(?:sha256:)?[a-f0-9]{64}$/u.test(s);
const runId = (s) => string(s) && /^[a-z0-9-]{1,64}$/u.test(s);
const list = (v) => (Array.isArray(v) ? v : []);
const duration = (start, end) =>
  utc(start) && utc(end) && Date.parse(end) >= Date.parse(start)
    ? Date.parse(end) - Date.parse(start)
    : undefined;
const windows = (e) => list(e.manifest?.induced_windows);
const coverage = (evidence, m, native) => ({
  native_staging: native,
  producer_capacity_pass: [true, false].includes(
    evidence.integration?.capacity_pass ?? evidence.load_manifest?.capacity_pass
  )
    ? (evidence.integration?.capacity_pass ??
      evidence.load_manifest?.capacity_pass)
    : null,
  producer_kind: [
    "shortened-local-correctness-only",
    "focused-producer-pruning-correctness",
    "local-amd64-emulation-correctness",
    "native-staging",
  ].includes(
    evidence.integration?.kind ?? evidence.load_manifest?.kind ?? m.kind
  )
    ? (evidence.integration?.kind ?? evidence.load_manifest?.kind ?? m.kind)
    : null,
  recovery: "clean-volume recovery; not cold-host RTO",
  workload: "synthetic-shell coverage; not future business-request performance",
});
export const serializeReport = (evidence, result, validation) => {
  const m = evidence.manifest ?? evidence.integration?.manifest ?? {};
  return {
    ...result,
    coverage: coverage(evidence, m, validation.native),
    provenance: {
      build_input_sha256: hash(m.build_identity?.build_input_sha256)
        ? m.build_identity.build_input_sha256
        : null,
      config_sha256: hash(m.config_sha256) ? m.config_sha256 : null,
      host: validation.host
        ? {
            architecture: "x86",
            id: 167_541_435,
            location: "hel1",
            name: "reltide-staging",
            os: "Ubuntu 26.04",
            private_ip: "172.30.0.3",
            type: "cx23",
          }
        : null,
      image_source_commit: /^[a-f0-9]{40}$/u.test(m.source_commit ?? "")
        ? m.source_commit
        : null,
      images: Object.fromEntries(
        services.map((k) => [k, imageHash(m.images?.[k])])
      ),
      induced_windows: windows(evidence).map((value, index) => {
        const w = value ?? {};
        return {
          completed_at: utc(w.completed_at) ? w.completed_at : null,
          duration_ms: duration(w.started_at, w.completed_at) ?? null,
          kind: ["restart", "restore", "wal-fault"].includes(w.kind)
            ? w.kind
            : null,
          service: services.includes(w.service) ? w.service : null,
          started_at: utc(w.started_at) ? w.started_at : null,
          verified: validation.windows[index],
        };
      }),
      phases: list(m.phases)
        .filter((p) =>
          ["idle", "ramp-1", "ramp-3", "ramp-5", "soak", "final"].includes(
            p?.name
          )
        )
        .map((p) => ({
          completed_at: utc(p.completed_at) ? p.completed_at : null,
          duration_ms: finite(p.duration_ms) ? p.duration_ms : null,
          http_rps: finite(p.http_rps) ? p.http_rps : null,
          name: p.name,
          started_at: utc(p.started_at) ? p.started_at : null,
        })),
      seed: Object.fromEntries(
        ["current_events", "aged_events", "ledger_rows", "analytics_rows"].map(
          (k) => [k, integer(m.seed?.[k]) ? m.seed[k] : null]
        )
      ),
    },
    run_id: runId(evidence.run_id) ? evidence.run_id : null,
    schema_version: 1,
  };
};
const parseArtifact = async (directory, name, ndjson = false) => {
  try {
    const raw = await readFile(path.join(directory, name), "utf-8");
    if (ndjson) {
      const lines = raw.split("\n").filter(Boolean);
      const rows = [];
      let invalid = !raw.endsWith("\n");
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          invalid = true;
        }
      }
      return { invalid, value: rows };
    }
    const value = JSON.parse(raw);
    return {
      invalid:
        value === null || Array.isArray(value) || Object(value) !== value,
      value,
    };
  } catch (error) {
    return { invalid: error.code !== "ENOENT" };
  }
};
const artifactAgrees = (envelope, source) => {
  if (Array.isArray(envelope) && Array.isArray(source)) {
    return (
      source.length >= envelope.length &&
      source.every(
        (v, i) => envelope[i] === undefined || isDeepStrictEqual(v, envelope[i])
      )
    );
  }
  return isDeepStrictEqual(envelope, source);
};
export const readEvidence = async (directory) => {
  const [envelope, manifest, integration, events, host] = await Promise.all([
    parseArtifact(directory, "evidence.json"),
    parseArtifact(directory, "load-manifest.json"),
    parseArtifact(directory, "integration-result.json"),
    parseArtifact(directory, "load-events.ndjson", true),
    parseArtifact(directory, "host-samples.ndjson", true),
  ]);
  const e =
    envelope.value && !Array.isArray(envelope.value)
      ? { ...envelope.value }
      : {};
  e.artifact_conflict = false;
  for (const [key, artifact] of [
    ["load_manifest", manifest],
    ["integration", integration],
    ["events", events],
    ["host_samples", host],
  ]) {
    if (
      e[key] !== undefined &&
      artifact.value !== undefined &&
      !artifactAgrees(e[key], artifact.value)
    ) {
      e.artifact_conflict = true;
    }
  }
  e.incomplete ||= [envelope, manifest, integration, events, host].some(
    (v) => v.invalid
  );
  if (manifest.value) {
    e.load_manifest = manifest.value;
  }
  if (integration.value) {
    e.integration = integration.value;
  }
  if (events.value) {
    e.events = events.value;
  }
  if (host.value) {
    e.host_samples = host.value;
  }
  e.run_id ??= manifest.value?.run_id ?? integration.value?.run_id;
  e.load ??= integration.value?.load;
  return e;
};
const flatten = (value, prefix = "") => {
  if (value !== null && Object(value) === value) {
    return Object.entries(value).flatMap(([key, item]) =>
      flatten(item, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [[prefix, String(value ?? "")]];
};
const csvCell = (value) => `"${value.replaceAll('"', '""')}"`;
export const discardReports = async (directory) => {
  await Promise.allSettled(
    ["json", "csv", "md"].map((extension) =>
      rm(path.join(directory, `report.${extension}`), { force: true })
    )
  );
};
export const writeReport = async (directory, report) => {
  const rows = Object.entries(report.verdicts);
  const fields = flatten(report);
  const csv = `${["metric,value", ...fields.map((row) => row.map(csvCell).join(","))].join("\n")}\n`;
  const markdown = [
    "# Capacity evidence report",
    "",
    `Combined: **${report.verdicts.combined}**`,
    "",
    "Synthetic-shell coverage only. Recovery measures clean volumes, not cold-host RTO. Growth projections are estimates.",
    "",
    "| Component | Verdict |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "| Measurement | Value |",
    "| --- | --- |",
    ...fields
      .filter(([key]) => !key.startsWith("reasons."))
      .map(([key, value]) => `| ${key} | ${value} |`),
    "",
    ...components.flatMap((key) => [
      `${key}:`,
      ...report.reasons[key].map((r) => `- ${r.status}: ${r.reason}`),
      "",
    ]),
  ].join("\n");
  const writes = await Promise.allSettled([
    writeFile(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    ),
    writeFile(path.join(directory, "report.csv"), csv, { mode: 0o600 }),
    writeFile(path.join(directory, "report.md"), markdown, { mode: 0o600 }),
  ]);
  const failed = writes.find((result) => result.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
  return report;
};
