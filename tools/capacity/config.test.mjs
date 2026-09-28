import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { test } from "vitest";

import { parseCollectorConfig, validateStack } from "./config.mjs";

const names = [
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
const memory = [
  128, 96, 128, 64, 96, 192, 192, 448, 64, 640, 128, 384, 384, 128,
];
const digest = `sha256:${"a".repeat(64)}`;
const collector = {
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
const limits = {
  collector,
  max_transient_helpers: 1,
  services: Object.fromEntries(
    names.map((name, i) => [
      name,
      {
        memory_mib: memory[i],
        pids: ["temporal", "clickhouse", "hyperdx"].includes(name) ? 256 : 128,
      },
    ])
  ),
  total_memory_mib: 3072,
};
const compose = {
  networks: { private: { driver: "bridge" } },
  services: Object.fromEntries(
    names.map((name, i) => [
      name,
      {
        image: `fixture@${digest}`,
        mem_limit: `${memory[i]}m`,
        memswap_limit: `${memory[i]}m`,
        networks: ["private"],
        pids_limit: limits.services[name].pids,
        ports:
          {
            api: [{ host_ip: "127.0.0.1", published: "13002", target: 3002 }],
            app: [{ host_ip: "127.0.0.1", published: "13000", target: 3000 }],
            docs: [{ host_ip: "127.0.0.1", published: "13004", target: 3004 }],
            hyperdx: [
              { host_ip: "127.0.0.1", published: "18081", target: 8080 },
              { host_ip: "127.0.0.1", published: "18000", target: 8000 },
            ],
            "temporal-ui": [
              { host_ip: "127.0.0.1", published: "18080", target: 8080 },
            ],
            web: [{ host_ip: "127.0.0.1", published: "13001", target: 3001 }],
          }[name] ?? [],
        profiles: name === "helper" ? ["helper"] : [],
      },
    ])
  ),
};
const manifest = {
  build_identity: {
    build_input_sha256: "a".repeat(64),
    purpose: "local_correctness_only",
    source_commit: "a".repeat(40),
    source_dirty: true,
  },
  collector_config: parseCollectorConfig(
    readFileSync(
      new URL("../../infra/capacity/config/collector.yaml", import.meta.url),
      "utf-8"
    )
  ),
  config_sha256: "a".repeat(64),
  extensions: {
    application: [
      {
        image_digest: digest,
        library_version: "0.10.0",
        name: "pg_clickhouse",
        source_commit: "6ee116efa554c3e39705e2abff776069fef412eb",
        sql_version: "0.10",
      },
    ],
    temporal: [],
  },
  images: Object.fromEntries(names.map((name) => [name, `fixture@${digest}`])),
  platform: "linux/amd64",
  resource_limits: limits,
  services: names,
  source_commit: "a".repeat(40),
};
const fixtureWithout = (name) => ({
  ...manifest,
  services: names.filter((value) => value !== name),
});
test("rejects an extra local port on a private database", () => {
  const value = structuredClone(compose);
  value.services.mongo.ports = [
    { host_ip: "127.0.0.1", published: "27017", target: 27_017 },
  ];
  assert.ok(validateStack(manifest, value, limits).length > 0);
});
test("rejects a service attached to another network", () => {
  const value = structuredClone(compose);
  value.services.api.networks.push("trusted");
  assert.ok(validateStack(manifest, value, limits).length > 0);
});

test("rejects_missing_required_service", () => {
  assert.ok(validateStack(fixtureWithout("mongo"), compose, limits).length > 0);
});
test("rejects_unpinned_image", () => {
  const value = structuredClone(compose);
  value.services.mongo.image = "mongo:8.0.32";
  assert.ok(validateStack(manifest, value, limits).length > 0);
});
test.each(["0.0.0.0", "172.30.0.3"])(
  "rejects_public_or_trusted_network_bind %s",
  (host) => {
    const value = structuredClone(compose);
    value.services.app.ports = [`${host}:13000:3000`];
    assert.ok(validateStack(manifest, value, limits).length > 0);
  }
);
test("rejects_memory_sum_over_3072", () => {
  const value = structuredClone(limits);
  value.services.mongo.memory_mib += 1;
  assert.ok(validateStack(manifest, compose, value).length > 0);
});
test("rejects reallocated memory even when the total stays 3072 MiB", () => {
  const changedLimits = structuredClone(limits);
  const changedCompose = structuredClone(compose);
  changedLimits.services.clickhouse.memory_mib += 64;
  changedLimits.services.hyperdx.memory_mib -= 64;
  changedCompose.services.clickhouse.mem_limit = "704m";
  changedCompose.services.clickhouse.memswap_limit = "704m";
  changedCompose.services.hyperdx.mem_limit = "320m";
  changedCompose.services.hyperdx.memswap_limit = "320m";
  assert.ok(validateStack(manifest, changedCompose, changedLimits).length > 0);
});
test("accepts_complete_pinned_private_fixture", () => {
  assert.deepEqual(validateStack(manifest, compose, limits), []);
});

test("rejects an extension image identity unrelated to application PostgreSQL", () => {
  const value = structuredClone(manifest);
  value.extensions.application[0].image_digest = `sha256:${"b".repeat(64)}`;
  assert.ok(validateStack(value, compose, limits).length > 0);
});
test("rejects a build identity unrelated to the declared source commit", () => {
  const value = structuredClone(manifest);
  value.build_identity.source_commit = "b".repeat(40);
  assert.ok(validateStack(value, compose, limits).length > 0);
});

test("rejects aggregate queue overflow or request units across all signals", () => {
  const overflow = structuredClone(limits);
  overflow.collector.queue_size_per_signal = 342;
  overflow.collector.queue_capacity_events = 1026;
  assert.ok(validateStack(manifest, compose, overflow).length > 0);
  const requests = structuredClone(limits);
  requests.collector.sizer = "requests";
  assert.ok(validateStack(manifest, compose, requests).length > 0);
});

test("rejects applied collector settings that disagree with event limits", () => {
  const value = structuredClone(manifest);
  value.collector_config.exporters.clickhouse.sending_queue.queue_size = 1024;
  assert.ok(validateStack(value, compose, limits).length > 0);
});
