import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// Nx 23.2.1 directly pins yaml 2.9.0 in the frozen workspace lockfile.
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("nx/package.json"))("yaml");
export const parseCollectorConfig = (source) => parse(source);

const requiredServices = [
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
  "helper",
];
const requiredMemoryMiB = {
  api: 64,
  app: 128,
  "application-pg": 192,
  clickhouse: 640,
  collector: 128,
  docs: 128,
  helper: 128,
  hyperdx: 384,
  mongo: 384,
  probe: 96,
  temporal: 448,
  "temporal-pg": 192,
  "temporal-ui": 64,
  web: 96,
};
const permittedPorts = {
  api: [["13002", 3002]],
  app: [["13000", 3000]],
  docs: [["13004", 3004]],
  hyperdx: [
    ["18081", 8080],
    ["18000", 8000],
  ],
  "temporal-ui": [["18080", 8080]],
  web: [["13001", 3001]],
};
// Enabled by the pinned ClickHouse 26.9.4.3 server config unless removed.
const disabledClickHouseLogs = [
  "trace_log",
  "query_thread_log",
  "query_views_log",
  "part_log",
  "background_schedule_pool_log",
  "text_log",
  "metric_log",
  "error_log",
  "instrumentation_trace_log",
  "query_metric_log",
  "asynchronous_metric_log",
  "iceberg_metadata_log",
  "delta_lake_metadata_log",
  "opentelemetry_span_log",
  "crash_log",
  "processors_profile_log",
  "backup_log",
  "s3queue_log",
  "blob_storage_log",
  "aggregated_zookeeper_log",
  "zookeeper_connection_log",
];
export const validateClickHouseLogConfig = (xml) => {
  const errors = [];
  for (const name of disabledClickHouseLogs) {
    const disabled = new RegExp(`<${name}\\s+remove="remove"\\s*/>`, "gu");
    if ([...xml.matchAll(disabled)].length !== 1) {
      errors.push(`inherited ClickHouse system log must be disabled: ${name}`);
    }
  }
  for (const name of ["query_log", "asynchronous_insert_log"]) {
    const block = xml.match(
      new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u")
    )?.[1];
    if (!block?.includes("<ttl>event_date + INTERVAL 3 DAY</ttl>")) {
      errors.push(`enabled ClickHouse system log needs three-day TTL: ${name}`);
    }
  }
  if (
    !xml.includes('<log remove="remove"/>') ||
    !xml.includes('<errorlog remove="remove"/>')
  ) {
    errors.push("ClickHouse file logs must be disabled");
  }
  return errors;
};
const pinnedImage = /@sha256:[a-f0-9]{64}$/u;
const sourceCommit = /^[a-f0-9]{40}$/u;
const configHash = /^[a-f0-9]{64}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const reject = (condition, reason, errors) => {
  if (!condition) {
    errors.push(reason);
  }
};
const validateImages = (name, image, expected, errors) => {
  reject(
    pinnedImage.test(image ?? "") &&
      pinnedImage.test(expected ?? "") &&
      image === expected,
    `unpinned or mismatched image: ${name}`,
    errors
  );
};
const validateResources = (name, service, ceiling, errors) => {
  reject(Boolean(ceiling), `missing memory ceiling: ${name}`, errors);
  if (!ceiling) {
    return;
  }
  reject(
    service.mem_limit === `${ceiling.memory_mib}m` &&
      service.memswap_limit === service.mem_limit,
    `memory or swap ceiling mismatch: ${name}`,
    errors
  );
  const pids = ["temporal", "clickhouse", "hyperdx"].includes(name) ? 256 : 128;
  reject(
    service.pids_limit === ceiling.pids && ceiling.pids === pids,
    `PID ceiling mismatch: ${name}`,
    errors
  );
};
const validateNetwork = (name, service, errors) => {
  reject(
    !service.network_mode && isDeepStrictEqual(service.networks, ["private"]),
    `service must use private network: ${name}`,
    errors
  );
  const actualPorts = (service.ports ?? []).map((port) => [
    port.host_ip,
    String(port.published),
    port.target,
    port.protocol ?? "tcp",
  ]);
  const expectedPorts = (permittedPorts[name] ?? []).map(
    ([published, target]) => ["127.0.0.1", published, target, "tcp"]
  );
  reject(
    isDeepStrictEqual(actualPorts, expectedPorts),
    `published ports differ from the loopback-only allowlist: ${name}`,
    errors
  );
};
const validateExtension = (extensions, image, errors) => {
  const application = extensions?.application ?? [];
  const [pin] = application;
  const fields = {
    library_version: "0.10.0",
    name: "pg_clickhouse",
    source_commit: "6ee116efa554c3e39705e2abff776069fef412eb",
    sql_version: "0.10",
  };
  reject(
    application.length === 1 &&
      Object.entries(fields).every(([key, value]) => pin?.[key] === value) &&
      digest.test(pin?.image_digest ?? "") &&
      image?.endsWith(`@${pin?.image_digest}`),
    "missing or mismatched application pg_clickhouse pin",
    errors
  );
  reject(
    Array.isArray(extensions?.temporal) && extensions.temporal.length === 0,
    "Temporal must have no extensions",
    errors
  );
};
const validateHeader = (manifest, errors) => {
  reject(
    sourceCommit.test(manifest?.source_commit ?? ""),
    "missing source commit",
    errors
  );
  reject(
    manifest?.platform === "linux/amd64",
    "platform must be linux/amd64",
    errors
  );
  reject(
    configHash.test(manifest?.config_sha256 ?? ""),
    "missing configuration checksum",
    errors
  );
  reject(
    manifest?.build_identity?.source_commit === manifest?.source_commit &&
      configHash.test(manifest?.build_identity?.build_input_sha256 ?? "") &&
      manifest?.build_identity?.purpose === "local_correctness_only" &&
      [true, false].includes(manifest?.build_identity?.source_dirty),
    "missing or mismatched local build input identity",
    errors
  );
};
const validateBudget = (compose, limits, services, errors) => {
  const total = Object.values(limits?.services ?? {}).reduce(
    (sum, value) => sum + Number(value?.memory_mib),
    0
  );
  reject(
    Number.isFinite(total) &&
      total <= 3072 &&
      limits?.total_memory_mib === 3072,
    "memory sum exceeds 3072 MiB",
    errors
  );
  reject(
    Object.entries(requiredMemoryMiB).every(
      ([name, memoryMiB]) => limits?.services?.[name]?.memory_mib === memoryMiB
    ),
    "service memory allocation differs from validated test ceilings",
    errors
  );
  reject(
    limits?.max_transient_helpers === 1 &&
      services.helper?.profiles?.includes("helper"),
    "only one transient helper is allowed",
    errors
  );
  reject(
    compose?.networks?.private?.driver === "bridge",
    "network must use the owned private bridge",
    errors
  );
};
const matches = (actual, expected) =>
  Object.entries(expected).every(([key, value]) =>
    isDeepStrictEqual(actual?.[key], value)
  );
const validateCollector = (settings, config, errors) => {
  const expected = {
    batch_max_events: 256,
    consumers_total: 3,
    inflight_batch_capacity_events: 768,
    memory_limiter_mib: 96,
    num_consumers_per_signal: 1,
    processor_batch_capacity_events: 768,
    queue_capacity_events: 1023,
    queue_size_per_signal: 341,
    retry_elapsed_seconds: 10,
    signals: ["logs", "metrics", "traces"],
    sizer: "items",
  };
  reject(
    matches(settings, expected),
    "collector aggregate queue or separate buffer accounting mismatch",
    errors
  );
  reject(
    matches(config?.exporters?.clickhouse?.sending_queue, {
      block_on_overflow: false,
      enabled: true,
      num_consumers: 1,
      queue_size: 341,
      sizer: "items",
    }),
    "collector applied queue must hold 1023 items across three signals",
    errors
  );
  const pipelines = Object.fromEntries(
    expected.signals.map((signal) => [
      signal,
      {
        exporters: ["clickhouse"],
        processors: ["memory_limiter", "batch"],
        receivers: ["otlp"],
      },
    ])
  );
  reject(
    matches(config?.service?.pipelines, pipelines) &&
      Object.keys(config?.service?.pipelines ?? {}).length === 3,
    "collector must preserve all three bounded signal pipelines",
    errors
  );
  reject(
    matches(config?.processors?.batch, {
      send_batch_max_size: 256,
      send_batch_size: 256,
      timeout: "1s",
    }),
    "collector applied batch mismatch",
    errors
  );
  reject(
    matches(config?.processors?.memory_limiter, { limit_mib: 96 }),
    "collector applied memory limiter mismatch",
    errors
  );
  reject(
    matches(config?.exporters?.clickhouse?.retry_on_failure, {
      max_elapsed_time: "10s",
    }),
    "collector applied retry mismatch",
    errors
  );
};
/** Reject an incomplete or unsafe private stack before Docker can create it. */
export const validateStack = (manifest, compose, limits) => {
  const errors = [];
  validateHeader(manifest, errors);
  const services = compose?.services ?? {};
  for (const name of requiredServices) {
    const service = services[name];
    reject(
      manifest?.services?.includes(name) && service,
      `missing service: ${name}`,
      errors
    );
    if (!service) {
      continue;
    }
    validateImages(name, service.image, manifest?.images?.[name], errors);
    validateResources(name, service, limits?.services?.[name], errors);
    validateNetwork(name, service, errors);
  }
  reject(
    Object.keys(services).every((name) => requiredServices.includes(name)),
    "unexpected service outside memory budget",
    errors
  );
  validateBudget(compose, limits, services, errors);
  validateCollector(limits?.collector, manifest?.collector_config, errors);
  validateExtension(
    manifest?.extensions,
    manifest?.images?.["application-pg"],
    errors
  );
  return errors;
};

export const configurationChecksum = async () => {
  const directory = path.resolve(import.meta.dirname, "../../infra/capacity");
  const [configFiles, sqlFiles] = await Promise.all([
    readdir(path.join(directory, "config")),
    readdir(path.join(directory, "sql")),
  ]);
  const files = [
    "compose.json",
    "limits.json",
    ...configFiles.map((name) => `config/${name}`),
    ...sqlFiles.map((name) => `sql/${name}`),
  ].toSorted();
  const bytes = await Promise.all(
    files.map(async (name) =>
      Buffer.concat([
        Buffer.from(`${name}\0`),
        await readFile(path.join(directory, name)),
      ])
    )
  );
  const hash = createHash("sha256");
  for (const value of bytes) {
    hash.update(value);
  }
  return hash.digest("hex");
};

export const readStackManifest = async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const read = async (file) =>
    JSON.parse(await readFile(path.join(root, file), "utf-8"));
  const [compose, limits, lock] = await Promise.all([
    read("infra/capacity/compose.json"),
    read("infra/capacity/limits.json"),
    read("infra/capacity/images.lock.json"),
  ]);
  const clickhouseLogErrors = validateClickHouseLogConfig(
    await readFile(
      path.join(root, "infra/capacity/config/clickhouse.xml"),
      "utf-8"
    )
  );
  if (clickhouseLogErrors.length) {
    throw new Error(clickhouseLogErrors.join("; "));
  }
  const manifest = {
    build_identity: lock.build_identity,
    collector_config: parseCollectorConfig(
      await readFile(
        path.join(root, "infra/capacity/config/collector.yaml"),
        "utf-8"
      )
    ),
    config_sha256: await configurationChecksum(),
    extensions: {
      application: [
        {
          ...lock.extension,
          image_digest: lock.derived["application-pg"].oci_manifest_digest,
          name: "pg_clickhouse",
        },
      ],
      temporal: [],
    },
    images: Object.fromEntries(
      Object.entries(compose.services).map(([name]) => [
        name,
        lock.derived[name]?.deployment_ref ??
          lock.inputs[name === "helper" ? "admin" : name],
      ])
    ),
    platform: lock.platform,
    resource_limits: limits,
    services: Object.keys(compose.services),
    source_commit: lock.source_commit,
  };
  if (manifest.config_sha256 !== lock.config_sha256) {
    throw new Error("configuration checksum mismatch");
  }
  return { compose, limits, lock, manifest };
};
if (process.argv[1] === import.meta.filename) {
  const { compose, limits, manifest } = await readStackManifest();
  const errors = validateStack(manifest, compose, limits);
  if (errors.length) {
    throw new Error(`stack rejected: ${errors.join("; ")}`);
  }
  process.stdout.write("Pinned private stack configuration accepted.\n");
}
