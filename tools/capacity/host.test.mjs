import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setImmediate as nextTurn,
  setTimeout as sleep,
} from "node:timers/promises";

import { test } from "vitest";

import {
  cleanupSelection,
  collectHost,
  evaluateGuard,
  guardStop,
  parseHostSample,
  preflight,
  readHostPreflight,
  recordOwnership,
  sampleHost,
  volumeIdentity,
} from "./host.mjs";

const utc = "2026-09-30T10:00:00.000Z";
const labels = {
  "com.reltide.capacity.project": "reltide-capacity",
  "com.reltide.capacity.run": "test-1",
};
const resource = (kind, id, extra = {}) => {
  const value = { id, identity: `${kind}-${id}-generation-1`, kind, labels };
  if (kind === "volume") {
    Object.assign(value, {
      docker_root_dir: "/var/lib/docker",
      driver: "local",
      generation: {
        birth_time_ns: "1760000000123456789",
        device: "1",
        inode: "42",
        is_directory: true,
      },
      mountpoint: `/var/lib/docker/volumes/${id}/_data`,
      options: null,
      scope: "local",
    });
  }
  return { ...value, ...extra };
};
const observed = {
  resources: [
    resource("container", "c1"),
    resource("volume", "v1"),
    resource("network", "n1"),
  ],
  server_id: 167_541_435,
};
const ownership = recordOwnership(
  "test-1",
  { resources: [], server_id: 167_541_435 },
  observed
);
const sample = (monotonic_ms = 0, extra = {}) => ({
  containers: [
    {
      cpu_busy_ratio: 0.1,
      id: "c1",
      memory_bytes: 1024,
      oom: false,
      restart_count: 0,
      running: true,
    },
  ],
  cpu_busy_ratio: 0.1,
  mem_available_bytes: 1024 ** 3,
  monotonic_ms,
  oom_count: 0,
  root_free_bytes: 20 * 1024 ** 3,
  root_used_ratio: 0.3,
  swap_in_bytes: 0,
  swap_out_bytes: 0,
  utc: new Date(Date.parse(utc) + monotonic_ms).toISOString(),
  ...extra,
});
const inventory = {
  firewall: {
    applied_to: [{ server: { id: 167_541_435 }, type: "server" }],
    id: 11_686_133,
  },
  network: {
    id: 12_689_126,
    protection: { delete: true },
    servers: [167_541_435],
  },
  server: {
    id: 167_541_435,
    image: { name: "ubuntu-26.04" },
    location: { name: "hel1" },
    name: "reltide-staging",
    private_net: [{ ip: "172.30.0.3", network: 12_689_126 }],
    protection: { delete: true, rebuild: true },
    public_net: {
      firewalls: [{ id: 11_686_133, status: "applied" }],
      ipv4: { ip: "2.29.40.210" },
    },
    server_type: {
      architecture: "x86",
      locations: [{ available: false, name: "hel1" }],
      name: "cx23",
    },
    status: "running",
  },
  utc,
};
const baseline = Object.fromEntries(
  ["proxy", "sentinel", "smoke"].map((id) => [
    id,
    { id, image: `sha256:${id}` },
  ])
);
const guest = {
  architecture: "x86_64",
  clock_offset_ms: 0,
  hostname: "reltide-staging",
  kernel_release: "7.0.0-generic",
  kernel_signature: "Ubuntu 7.0.0-generic 7.0.14",
  kernel_version: "Linux version 7.0.0-generic",
  mongo_health: "absent",
  os_id: "ubuntu",
  os_version: "26.04",
  private_addresses: ["172.30.0.3"],
  resources: [],
  sample: sample(),
  server_id: 167_541_435,
  services: Object.values(baseline).map((value) => ({
    ...value,
    running: true,
  })),
  utc,
};
const manifest = {
  host_services: baseline,
  platform: "linux/amd64",
  resource_limits: { total_memory_mib: 3072 },
};

const fixturePreflight = (value, host, stack) =>
  preflight(value, host, stack, { now: Date.parse(utc) });

test("preflight verifies protected purchased staging even when replacement stock is unavailable", () => {
  assert.deepEqual(fixturePreflight(inventory, guest, manifest), []);
});

test.each([
  [
    "wrong cloud host",
    (i) => {
      i.server.id = 1;
    },
  ],
  [
    "stale inventory",
    (i) => {
      i.utc = "2026-09-29T10:00:00Z";
    },
  ],
  [
    "unknown stock",
    (i) => {
      i.server.server_type.locations = [];
    },
  ],
  [
    "lost protection",
    (i) => {
      i.server.protection.delete = false;
    },
  ],
  [
    "wrong network",
    (i) => {
      i.server.private_net[0].network = 1;
    },
  ],
])("preflight rejects %s", (_name, mutate) => {
  const value = structuredClone(inventory);
  mutate(value);
  assert.ok(fixturePreflight(value, guest, manifest).length);
});

test.each([
  [
    "wrong guest host",
    (g) => {
      g.server_id = 1;
    },
  ],
  [
    "absent kernel evidence",
    (g) => {
      delete g.kernel_version;
    },
  ],
  [
    "clock drift",
    (g) => {
      g.clock_offset_ms = 1001;
    },
  ],
  [
    "missing service",
    (g) => {
      g.services.pop();
    },
  ],
  [
    "replaced service",
    (g) => {
      g.services[0].id = "replacement";
    },
  ],
  [
    "unhealthy MongoDB",
    (g) => {
      g.mongo_health = "unhealthy";
    },
  ],
  [
    "mixed run",
    (g) => {
      g.resources = [resource("container", "old")];
    },
  ],
])("preflight rejects %s", (_name, mutate) => {
  const value = structuredClone(guest);
  mutate(value);
  assert.ok(fixturePreflight(inventory, value, manifest).length);
});

test("cleanup preserves unrelated, preexisting, replaced and source resources", () => {
  assert.deepEqual(
    cleanupSelection(ownership, {
      resources: [resource("volume", "unrelated")],
      server_id: 167_541_435,
    }),
    []
  );
  const replaced = structuredClone(observed);
  replaced.resources[1].generation.birth_time_ns = "1760000000987654321";
  assert.deepEqual(
    cleanupSelection(ownership, replaced).map((r) => r.id),
    ["c1", "n1"]
  );
  const source = { ...ownership, source_volume_ids: ["v1"] };
  assert.deepEqual(
    cleanupSelection(source, observed).map((r) => r.id),
    ["c1", "n1"]
  );
  const own = recordOwnership(
    "test-1",
    { resources: [observed.resources[1]], server_id: 167_541_435 },
    observed
  );
  assert.deepEqual(own.volume_ids, []);
});

test("mixed labels, wrong server and unsafe run IDs cannot select destructive operations", () => {
  assert.deepEqual(
    cleanupSelection(ownership, { ...observed, server_id: 1 }),
    []
  );
  const mixed = structuredClone(observed);
  mixed.resources[0].labels["com.reltide.capacity.run"] = "other";
  assert.ok(!cleanupSelection(ownership, mixed).some((r) => r.id === "c1"));
  assert.throws(() => recordOwnership("../bad", observed, observed));
});

test.each([
  ["memory", { mem_available_bytes: 511 * 1024 ** 2 }],
  ["disk used", { root_used_ratio: 0.701 }],
  ["disk free", { root_free_bytes: 10 * 1024 ** 3 - 1 }],
  ["OOM", { oom_count: 1 }],
  ["container OOM", { containers: [{ ...sample().containers[0], oom: true }] }],
  [
    "restart",
    { containers: [{ ...sample().containers[0], restart_count: 1 }] },
  ],
])("guard stops load on %s", (_name, extra) => {
  assert.equal(evaluateGuard([sample(), sample(1000, extra)]).stop, true);
});

test("guard keeps boundaries and short CPU bursts separate from five-minute mean", () => {
  assert.equal(
    evaluateGuard([
      sample(0, {
        mem_available_bytes: 512 * 1024 ** 2,
        root_free_bytes: 10 * 1024 ** 3,
        root_used_ratio: 0.7,
      }),
    ]).stop,
    false
  );
  const sustained = Array.from({ length: 301 }, (_, index) =>
    sample(index * 1000, { cpu_busy_ratio: 0.81 })
  );
  assert.equal(evaluateGuard(sustained).stop, true);
  for (const [index, value] of sustained.entries()) {
    value.cpu_busy_ratio = index > 290 ? 1 : 0.1;
  }
  assert.equal(evaluateGuard(sustained).stop, false);
  assert.equal(
    evaluateGuard(sustained.slice(0, 60)).windows.one_minute.count,
    60
  );
});

test("partial metrics, stalled sampling, counter reset and clock jumps are BLOCKED", () => {
  const partial = sample();
  delete partial.mem_available_bytes;
  for (const values of [
    [partial],
    [sample(), sample(4001)],
    [sample(), sample(1000, { utc: "2026-09-30T10:00:03Z" })],
    [sample(0, { swap_in_bytes: 1 }), sample(1000)],
  ]) {
    const result = evaluateGuard(values);
    assert.equal(result.stop, true);
    assert.equal(result.status, "BLOCKED");
  }
  assert.equal(
    evaluateGuard([sample()], { now_monotonic_ms: 3001 }).status,
    "BLOCKED"
  );
});

test("sustained swap prevents steady-state acceptance", () => {
  const values = Array.from({ length: 61 }, (_, index) =>
    sample(index * 1000, { swap_in_bytes: index * 4096 })
  );
  assert.equal(evaluateGuard(values).stop, true);
});

test("guard stop closes admission and saves evidence before reinspecting each owned container", async () => {
  const effects = [];
  await guardStop({
    inspect: () => observed,
    ownership,
    persist: () => {
      effects.push("persist");
    },
    stopContainer: (id) => {
      effects.push(id);
    },
    stopLoad: () => {
      effects.push("load");
    },
  });
  assert.deepEqual(effects, ["load", "persist", "c1"]);
  effects.length = 0;
  await guardStop({
    inspect: () => ({ ...observed, server_id: 1 }),
    ownership,
    persist: () => {},
    stopContainer: () => {
      effects.push("mutation");
    },
    stopLoad: () => {},
  });
  assert.deepEqual(effects, []);
});

test("host metrics derive CPU/swap deltas and retain Docker health without secrets", () => {
  const raw = {
    containers: sample().containers,
    cpu: [10, 0, 10, 80, 0, 0, 0, 0],
    mem_available_kib: 1_048_576,
    monotonic_ms: 1000,
    oom_count: 0,
    page_size: 4096,
    root_available: 20,
    root_size: 100,
    root_used: 30,
    swap_in_pages: 2,
    swap_out_pages: 3,
    utc,
  };
  const value = parseHostSample(raw, { cpu: [0, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(value.cpu_busy_ratio, 0.2);
  assert.equal(value.swap_in_bytes, 8192);
  assert.equal(value.mem_available_bytes, 1024 ** 3);
  assert.equal(value.root_used_ratio, 0.3);
  assert.throws(() => parseHostSample({ ...raw, cpu: [] }, raw));
});

test("sampling stops admission when remote collection disappears", async () => {
  const evidence = [];
  let stopped = false;
  const result = await sampleHost({
    collect: () => {
      throw new Error("unavailable");
    },
    persist: (value) => {
      evidence.push(value);
    },
    stopLoad: () => {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  assert.equal(result.status, "BLOCKED");
  assert.equal(evidence.length, 1);
});

test("wrong authenticated host prevents SSH and all mutations", async () => {
  const calls = [];
  const result = await readHostPreflight({
    manifest,
    run: (program, args) => {
      calls.push([program, args]);
      if (args.includes("server")) {
        return JSON.stringify({ ...inventory.server, id: 1 });
      }
      return "{}";
    },
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(
    calls.every(
      ([program, args]) => program === "hcloud" && args.includes("describe")
    )
  );
});

test("sampling aborts shared submission before persisting a guard breach", async () => {
  const controller = new AbortController();
  const effects = [];
  let count = 0;
  const result = await sampleHost({
    collect: () => ({
      containers: [],
      cpu: [(count += 1), 0, 0, count * 9, 0, 0, 0, 0],
      mem_available_kib: 1,
      monotonic_ms: count * 1000,
      oom_count: 0,
      page_size: 4096,
      root_available: 20 * 1024 ** 3,
      root_size: 100,
      root_used: 30,
      swap_in_pages: 0,
      swap_out_pages: 0,
      utc: new Date().toISOString(),
    }),
    controller,
    interval: () => {},
    persist: () => {
      effects.push(
        controller.signal.aborted ? "closed evidence" : "open evidence"
      );
    },
    stopLoad: () => {
      effects.push("load closed");
    },
  });
  assert.equal(result.stop, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(effects[0], "load closed");
  assert.ok(effects.every((value) => value !== "open evidence"));
});

test("a collector ignoring cancellation cannot keep admission open past three seconds", async () => {
  const controller = new AbortController();
  const result = await sampleHost({
    collect: () => Promise.withResolvers().promise,
    controller,
    persist: () => {},
    stopLoad: () => {},
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(controller.signal.aborted, true);
}, 5000);

test("absolute sample clock offset blocks load before a relative jump occurs", () => {
  assert.equal(
    evaluateGuard([sample(0, { clock_offset_ms: 1001 })]).status,
    "BLOCKED"
  );
});

test("live collector verifies guest identity and uses a separate clock probe", async () => {
  const raw = { ...sample(), cpu: [1, 0, 0, 9, 0, 0, 0, 0] };
  const result = await collectHost({
    inventory,
    run: (_program, args) => {
      const script = args.at(-1);
      return JSON.stringify(
        script.includes("docker")
          ? { ...guest, raw }
          : { utc: new Date().toISOString() }
      );
    },
  });
  assert.equal(result.monotonic_ms, 0);
  assert.ok(Math.abs(result.clock_offset_ms) <= 1000);
  await assert.rejects(() =>
    collectHost({
      inventory,
      run: () => JSON.stringify({ ...guest, server_id: 1 }),
    })
  );
});

test("missing upstream kernel signature and uncertain clock evidence block preflight", () => {
  const value = structuredClone(guest);
  delete value.kernel_signature;
  assert.ok(fixturePreflight(inventory, value, manifest).length);
  assert.ok(
    fixturePreflight(
      inventory,
      { ...guest, clock_uncertainty_ms: 1001 },
      manifest
    ).length
  );
});

test("synchronous failure and aborted collection settle without unhandled rejections", async () => {
  const rejections = [];
  const onRejection = (error) => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onRejection);
  try {
    /* eslint-disable no-await-in-loop -- Observe unhandled rejections for each failure before exercising the next branch. */
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const result = await sampleHost({
        collect: () => {
          if (abort) {
            controller.abort();
            return Promise.withResolvers().promise;
          }
          throw new Error("synchronous collector failure");
        },
        controller,
        persist: () => {},
        stopLoad: () => {},
      });
      assert.equal(result.status, "BLOCKED");
      assert.equal(controller.signal.aborted, true);
      await nextTurn();
    }
    /* eslint-enable no-await-in-loop */
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("jittered cadence covers clipped CPU and swap windows", () => {
  const values = Array.from({ length: 601 }, (_, index) =>
    sample(index * 1001, {
      cpu_busy_ratio: 0.9,
      swap_in_bytes: index * 4096,
    })
  );
  const result = evaluateGuard(values);
  assert.equal(result.windows.five_minute.duration_ms, 300_000);
  assert.equal(result.windows.one_minute.duration_ms, 60_000);
  assert.ok(result.reasons.includes("five-minute CPU mean above 80%"));
  assert.ok(result.reasons.includes("sustained swap activity"));
});

test("pruned jittered history retains the sample bracketing the five-minute boundary", async () => {
  const controller = new AbortController();
  let count = 0;
  let busy = 0;
  let idle = 0;
  const result = await sampleHost({
    collect: () => {
      count += 1;
      const high = count > 350;
      busy += high ? 9 : 1;
      idle += high ? 1 : 9;
      if (count > 750) {
        controller.abort();
      }
      return {
        clock_offset_ms: 0,
        containers: [],
        cpu: [busy, 0, 0, idle, 0, 0, 0, 0],
        mem_available_kib: 1_048_576,
        monotonic_ms: count * 1001,
        oom_count: 0,
        page_size: 4096,
        root_available: 20 * 1024 ** 3,
        root_size: 100,
        root_used: 30,
        swap_in_pages: 0,
        swap_out_pages: 0,
        utc: new Date(Date.parse(utc) + count * 1001).toISOString(),
      };
    },
    controller,
    interval: () => {},
    persist: () => {},
    stopLoad: () => {},
  });
  assert.ok(result.reasons.includes("five-minute CPU mean above 80%"));
  assert.ok(count < 750);
});

test.each(["stale", "external cancellation"])(
  "hung persistence closes shared admission on %s",
  async (cause) => {
    const controller = new AbortController();
    const external = new AbortController();
    const entered = Promise.withResolvers();
    const pending = Promise.withResolvers();
    const closed = Promise.withResolvers();
    let count = 0;
    let stops = 0;
    const work = sampleHost({
      collect: () => {
        count += 1;
        return {
          clock_offset_ms: 0,
          containers: [],
          cpu: [count, 0, 0, count * 9, 0, 0, 0, 0],
          mem_available_kib: 1_048_576,
          monotonic_ms: count * 1000,
          oom_count: 0,
          page_size: 4096,
          root_available: 20 * 1024 ** 3,
          root_size: 100,
          root_used: 30,
          swap_in_pages: 0,
          swap_out_pages: 0,
          utc: new Date(Date.parse(utc) + count * 1000).toISOString(),
        };
      },
      controller,
      interval: () => {},
      persist: (value) => {
        if (value.sample) {
          entered.resolve();
          return pending.promise;
        }
      },
      signal: external.signal,
      stopLoad: () => {
        stops += 1;
        closed.resolve();
      },
    });
    await entered.promise;
    if (cause === "external cancellation") {
      external.abort();
    }
    const probe = Promise.withResolvers();
    const timer = setTimeout(
      () => {
        probe.resolve(false);
      },
      cause === "stale" ? 3300 : 100
    );
    const stopping = async () => {
      await closed.promise;
      return true;
    };
    try {
      const stopped = await Promise.race([stopping(), probe.promise]);
      assert.equal(stopped, true);
      assert.equal(controller.signal.aborted, true);
      assert.equal(stops, 1);
    } finally {
      clearTimeout(timer);
      external.abort();
      pending.resolve();
      await work;
    }
  },
  5000
);

test("default preflight clock rejects equally stale inventory and guest evidence", () => {
  const stale = "2020-01-01T00:00:00Z";
  assert.ok(
    preflight({ ...inventory, utc: stale }, { ...guest, utc: stale }, manifest)
      .length
  );
});

test("same-second volume replacement cannot retain its filesystem creation identity", async () => {
  const dockerRoot = await mkdtemp(path.join(tmpdir(), "capacity-volume-"));
  const mountpoint = path.join(dockerRoot, "volumes/v1/_data");
  const make = async () => {
    await mkdir(mountpoint, { recursive: true });
    const value = await stat(mountpoint, { bigint: true });
    return resource("volume", "v1", {
      created_at: `${new Date(Number(value.birthtimeNs / 1_000_000n)).toISOString().slice(0, 19)}Z`,
      docker_root_dir: dockerRoot,
      driver: "local",
      generation: {
        birth_time_ns: String(value.birthtimeNs),
        device: String(value.dev),
        inode: String(value.ino),
        is_directory: true,
      },
      mountpoint,
      options: null,
      scope: "local",
    });
  };
  try {
    // Keep both real creations clear of the next Docker timestamp boundary.
    if (Date.now() % 1000 > 800) {
      await sleep(1000 - (Date.now() % 1000));
    }
    const first = await make();
    const manifestBefore = recordOwnership(
      "test-1",
      { resources: [], server_id: 167_541_435 },
      { resources: [first], server_id: 167_541_435 }
    );
    await rm(mountpoint, { recursive: true });
    const replacement = await make();
    // These are the exact fields in the old Docker-derived fingerprint.
    assert.equal(first.created_at, replacement.created_at);
    assert.equal(first.identity, replacement.identity);
    assert.deepEqual(
      cleanupSelection(manifestBefore, {
        resources: [replacement],
        server_id: 167_541_435,
      }),
      []
    );
    assert.notEqual(volumeIdentity(first), volumeIdentity(replacement));
  } finally {
    await rm(dockerRoot, { recursive: true });
  }
});

test("guest volume collector preserves nanosecond generation after container stats", async () => {
  let script;
  await collectHost({
    inventory,
    run: (_program, args) => {
      const remote = args.at(-1);
      if (remote.includes("docker")) {
        script = remote;
        return JSON.stringify({
          ...guest,
          raw: { ...sample(), cpu: [1, 0, 0, 9, 0, 0, 0, 0] },
        });
      }
      return JSON.stringify({ utc: new Date().toISOString() });
    },
  });
  // Execute the actual volume block offline, with Docker and host observations
  // replaced at their boundaries. A preceding container sets the existing stat.
  const harness = String.raw`
import shlex, sys, types
script = shlex.split(sys.argv[1])[2]
exec(script.strip().splitlines()[0])
stat = {'CPUPerc': '1.0%'}
resources = []
docker = lambda args: '/var/lib/docker' if args[0] == 'info' else 'v1' if args[0] == 'volume' else ''
inspect = lambda kind, ids: [dict(Name='v1', Driver='local', Scope='local', Options=None, Mountpoint='/var/lib/docker/volumes/v1/_data', Labels={})] if ids else []
labels = lambda value: value
os.lstat = lambda name: types.SimpleNamespace(st_mode=0o40755)
command = lambda args: '2049|12345|2026-09-30 10:00:00.123456789 +0000'
exec(script[script.index('docker_root ='):script.index('mem = dict')])
print(json.dumps(resources))
`;
  const [volume] = JSON.parse(
    execFileSync("python3", ["-c", harness, script], { encoding: "utf-8" })
  );
  assert.deepEqual(volume.generation, {
    birth_time_ns: "1790762400123456789",
    device: "2049",
    inode: "12345",
    is_directory: true,
  });
});

test("volume generation must be available independently of Docker labels and timestamps", () => {
  const unknown = resource("volume", "v1", { generation: null });
  assert.deepEqual(
    cleanupSelection(ownership, {
      resources: [unknown],
      server_id: 167_541_435,
    }),
    []
  );
  assert.throws(() =>
    recordOwnership(
      "test-1",
      { resources: [], server_id: 167_541_435 },
      { resources: [unknown], server_id: 167_541_435 }
    )
  );
});
