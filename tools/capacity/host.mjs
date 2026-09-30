import { execFile } from "node:child_process";
import { once } from "node:events";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { readStackManifest, validateStack } from "./config.mjs";

const execute = promisify(execFile);
const serverId = 167_541_435;
const project = "reltide-capacity";
const networkId = 12_689_126;
const firewallId = 11_686_133;
const runPattern = /^[a-z0-9-]{1,64}$/u;
const mib = 1024 ** 2;
const gib = 1024 ** 3;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;

// No environment/configuration arrays are emitted: Docker inspect includes secrets.
// This fixed, read-only program is also the sampler's collector. No user text is
// substituted into the remote program, and no remote mutation command is exposed.
const guestScript = String.raw`
import datetime, json, os, platform, subprocess, time, urllib.request
def command(args):
    return subprocess.check_output(args, text=True, timeout=5).strip()
def docker(args):
    return command(['docker'] + args)
def inspect(kind, ids):
    return json.loads(docker([kind, 'inspect'] + ids)) if ids else []
def labels(value):
    return {k:v for k,v in (value or {}).items() if k.startswith('com.reltide.capacity.')}
ids = docker(['ps', '-aq']).split()
containers = json.loads(docker(['inspect'] + ids)) if ids else []
resources, services, metrics = [], [], []
stats = [json.loads(line) for line in docker(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}']).splitlines()]
for c in containers:
    identity = c['Id']
    resources.append(dict(kind='container', id=identity, identity=identity, labels=labels(c['Config'].get('Labels'))))
    services.append(dict(id=identity, name=c['Name'].lstrip('/'), image=c['Image'], running=c['State']['Running']))
    stat = next((s for s in stats if s['ID'] == identity), None)
    # Read the exact cgroup memory counter, avoiding rounded Docker display units.
    memory = None
    pid = c['State']['Pid']
    if pid:
        path = next(line.split(':',2)[2] for line in open('/proc/%s/cgroup' % pid) if line.startswith('0:')).strip()
        memory = int(open('/sys/fs/cgroup' + path + '/memory.current').read())
    metrics.append(dict(id=identity, memory_bytes=memory, cpu_busy_ratio=float(stat['CPUPerc'].rstrip('%'))/100 if stat else None,
        oom=c['State']['OOMKilled'], restart_count=c['RestartCount'], running=c['State']['Running']))
for kind in ['volume','network']:
    for r in inspect(kind, docker([kind, 'ls', '-q']).split()):
        identity = r['Id'] if kind == 'network' else '|'.join([r['CreatedAt'], r['Driver'], r['Scope'], r['Mountpoint']])
        resources.append(dict(kind=kind, id=r.get('Id',r['Name']), identity=identity, labels=labels(r.get('Labels'))))
mem = dict(line.split(':',1) for line in open('/proc/meminfo'))
vm = dict(line.split() for line in open('/proc/vmstat'))
cpu = list(map(int, open('/proc/stat').readline().split()[1:9]))
disk = command(['df','-B1','--output=size,used,avail','/']).splitlines()[-1].split()
utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
raw = dict(utc=utc, monotonic_ms=time.monotonic()*1000, mem_available_kib=int(mem['MemAvailable'].split()[0]),
    cpu=cpu, root_size=int(disk[0]), root_used=int(disk[1]), root_available=int(disk[2]),
    swap_in_pages=int(vm['pswpin']), swap_out_pages=int(vm['pswpout']), page_size=os.sysconf('SC_PAGE_SIZE'),
    oom_count=int(vm['oom_kill']), containers=metrics)
os_release = dict(line.rstrip().split('=',1) for line in open('/etc/os-release') if '=' in line)
with urllib.request.urlopen('http://169.254.169.254/hetzner/v1/metadata/instance-id', timeout=2) as response:
    instance_id = int(response.read().decode())
addresses = [a['local'] for i in json.loads(command(['ip','-j','-4','addr'])) for a in i['addr_info']]
mongo = [c for c in containers if (c['Config'].get('Labels') or {}).get('com.docker.compose.service') == 'mongo']
health = 'absent' if not mongo else ('healthy' if all(c['State'].get('Health',{}).get('Status') == 'healthy' for c in mongo) else 'unhealthy')
print(json.dumps(dict(utc=utc, server_id=instance_id, hostname=platform.node(), architecture=platform.machine(),
    os_id=os_release['ID'].strip('"'), os_version=os_release['VERSION_ID'].strip('"'),
    kernel_release=platform.release(), kernel_signature=open('/proc/version_signature').read().strip(), kernel_version=open('/proc/version').read().strip(),
    private_addresses=addresses, resources=resources, services=services, mongo_health=health, raw=raw)))
`;

const runCommand = async (program, args, { signal } = {}) => {
  const { stdout } = await execute(program, args, {
    maxBuffer: 4 * 1024 ** 2,
    signal,
    timeout: 15_000,
  });
  return stdout;
};

const validSample = (sample) =>
  Boolean(
    sample &&
    Number.isFinite(Date.parse(sample.utc)) &&
    [
      "monotonic_ms",
      "mem_available_bytes",
      "root_free_bytes",
      "swap_in_bytes",
      "swap_out_bytes",
      "oom_count",
    ].every((key) => nonnegative(sample[key])) &&
    ["root_used_ratio", "cpu_busy_ratio"].every(
      (key) => nonnegative(sample[key]) && sample[key] <= 1
    ) &&
    Array.isArray(sample.containers) &&
    sample.containers.every(
      (container) =>
        container.id &&
        nonnegative(container.cpu_busy_ratio) &&
        nonnegative(container.memory_bytes) &&
        nonnegative(container.restart_count) &&
        [true, false].includes(container.oom) &&
        [true, false].includes(container.running)
    )
  );

export const parseHostSample = (raw, previous) => {
  if (
    !Array.isArray(raw?.cpu) ||
    raw.cpu.length !== 8 ||
    !Array.isArray(previous?.cpu) ||
    previous.cpu.length !== 8 ||
    !raw.cpu.every(nonnegative) ||
    !previous.cpu.every(nonnegative)
  ) {
    throw new Error("partial CPU counters");
  }
  const deltas = raw.cpu.map((value, index) => value - previous.cpu[index]);
  const total = deltas.reduce((sum, value) => sum + value, 0);
  if (deltas.some((value) => value < 0) || total <= 0) {
    throw new Error("invalid CPU counter delta");
  }
  const sample = {
    containers: raw.containers,
    cpu_busy_ratio: (total - deltas[3] - deltas[4]) / total,
    mem_available_bytes: raw.mem_available_kib * 1024,
    monotonic_ms: raw.monotonic_ms,
    oom_count: raw.oom_count,
    root_free_bytes: raw.root_available,
    root_used_ratio: raw.root_used / raw.root_size,
    swap_in_bytes: raw.swap_in_pages * raw.page_size,
    swap_out_bytes: raw.swap_out_pages * raw.page_size,
    utc: raw.utc,
  };
  if (raw.clock_offset_ms !== undefined) {
    sample.clock_offset_ms = raw.clock_offset_ms;
  }
  if (!validSample(sample)) {
    throw new Error("partial host metrics");
  }
  return sample;
};

const sampleBreaches = (sample, reject) => {
  if (
    sample.clock_offset_ms !== undefined &&
    (!Number.isFinite(sample.clock_offset_ms) ||
      Math.abs(sample.clock_offset_ms) > 1000)
  ) {
    reject("UTC clock offset above one second", true);
  }
  if (sample.mem_available_bytes < 512 * mib) {
    reject("available memory below 512 MiB");
  }
  if (sample.root_used_ratio > 0.7 || sample.root_free_bytes < 10 * gib) {
    reject("root disk guard exceeded");
  }
  if (
    sample.oom_count > 0 ||
    sample.containers.some((container) => container.oom)
  ) {
    reject("OOM detected");
  }
  if (
    sample.containers.some(
      (container) => container.restart_count > 0 || !container.running
    )
  ) {
    reject("unexpected container restart or exit");
  }
};
const sampleContinuity = (previous, sample, reject) => {
  const elapsed = sample.monotonic_ms - previous.monotonic_ms;
  if (elapsed <= 0 || elapsed > 3000) {
    reject("missing/gapped or nonmonotonic samples", true);
  }
  if (
    Math.abs(Date.parse(sample.utc) - Date.parse(previous.utc) - elapsed) > 1000
  ) {
    reject("UTC clock offset above one second", true);
  }
  if (
    ["swap_in_bytes", "swap_out_bytes", "oom_count"].some(
      (key) => sample[key] < previous[key]
    )
  ) {
    reject("host counter reset", true);
  }
  if (
    previous.containers.some(
      (container) =>
        !sample.containers.some((current) => current.id === container.id)
    )
  ) {
    reject("container sample disappeared", true);
  }
};
const sampleWindow = (samples, duration) => {
  const latest = samples.at(-1);
  const values = samples.filter(
    (sample) =>
      validSample(sample) &&
      latest.monotonic_ms - sample.monotonic_ms <= duration
  );
  let weighted = 0;
  let elapsed = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index].monotonic_ms - values[index - 1].monotonic_ms;
    weighted += values[index].cpu_busy_ratio * delta;
    elapsed += delta;
  }
  return {
    count: values.length,
    cpu_busy_ratio: elapsed ? weighted / elapsed : null,
    duration_ms: elapsed,
    swap_active:
      values.length > 1 &&
      ["swap_in_bytes", "swap_out_bytes"].some(
        (key) => values.at(-1)[key] > values[0][key]
      ),
  };
};
export const evaluateGuard = (
  samples,
  { now_monotonic_ms = samples.at(-1)?.monotonic_ms } = {}
) => {
  const reasons = [];
  let blocked = false;
  const reject = (reason, missing = false) => {
    reasons.push(reason);
    blocked ||= missing;
  };
  if (!samples.length || !samples.every(validSample)) {
    reject("missing or partial host/container metrics", true);
  }
  const latest = samples.at(-1);
  if (
    latest &&
    (!nonnegative(now_monotonic_ms) ||
      now_monotonic_ms < latest.monotonic_ms ||
      now_monotonic_ms - latest.monotonic_ms > 3000)
  ) {
    reject("sampling stalled more than three seconds", true);
  }
  for (const [index, sample] of samples.entries()) {
    if (!validSample(sample)) {
      continue;
    }
    sampleBreaches(sample, reject);
    const previous = samples[index - 1];
    if (validSample(previous)) {
      sampleContinuity(previous, sample, reject);
    }
  }
  const windows = {
    five_minute: sampleWindow(samples, 300_000),
    one_minute: sampleWindow(samples, 60_000),
  };
  if (
    windows.five_minute.duration_ms >= 300_000 &&
    windows.five_minute.cpu_busy_ratio > 0.8
  ) {
    reject("five-minute CPU mean above 80%");
  }
  if (
    windows.one_minute.duration_ms >= 60_000 &&
    windows.one_minute.swap_active
  ) {
    reject("sustained swap activity");
  }
  let status = reasons.length ? "FAIL" : "CLEAR";
  if (blocked) {
    status = "BLOCKED";
  }
  return {
    reasons: [...new Set(reasons)],
    status,
    stop: reasons.length > 0,
    windows,
  };
};

const cloudType = (server) =>
  server?.status === "running" &&
  server?.server_type?.name === "cx23" &&
  server?.server_type?.architecture === "x86" &&
  server?.location?.name === "hel1";
const cloudIdentity = (server) => [
  [
    server?.id === serverId && server?.name === "reltide-staging",
    "cloud server identity mismatch",
  ],
  [cloudType(server), "cloud type/region/architecture mismatch"],
  [server?.image?.name === "ubuntu-26.04", "cloud OS identity mismatch"],
  [
    server?.protection?.delete === true && server?.protection?.rebuild === true,
    "host protection missing",
  ],
];
const cloudNetwork = (inventory) =>
  inventory?.server?.private_net?.some(
    (net) => net.network === networkId && net.ip === "172.30.0.3"
  ) &&
  inventory?.network?.id === networkId &&
  inventory?.network?.protection?.delete === true &&
  inventory?.network?.servers?.includes(serverId);
const cloudFirewall = (inventory) =>
  inventory?.server?.public_net?.firewalls?.some(
    (fw) => fw.id === firewallId && fw.status === "applied"
  ) &&
  inventory?.firewall?.id === firewallId &&
  inventory?.firewall?.applied_to?.some(
    (fw) => fw.type === "server" && fw.server?.id === serverId
  );
const cloudReasons = (inventory, now) => {
  const age = now - Date.parse(inventory?.utc);
  return [
    ...cloudIdentity(inventory?.server),
    [
      Number.isFinite(age) && age >= 0 && age <= 30_000,
      "stale or missing inventory timestamp",
    ],
    [cloudNetwork(inventory), "private network identity/protection mismatch"],
    [cloudFirewall(inventory), "firewall identity/application mismatch"],
    [
      [true, false].includes(
        inventory?.server?.server_type?.locations?.find(
          (location) => location.name === "hel1"
        )?.available
      ),
      "replacement stock unknown",
    ],
  ]
    .filter(([valid]) => !valid)
    .map(([, reason]) => reason);
};
const guestIdentity = (guest) => [
  [
    guest?.server_id === serverId && guest?.hostname === "reltide-staging",
    "guest host identity mismatch",
  ],
  [
    guest?.architecture === "x86_64" &&
      guest?.os_id === "ubuntu" &&
      guest?.os_version === "26.04",
    "guest architecture/OS mismatch",
  ],
  [
    guest?.private_addresses?.includes("172.30.0.3"),
    "guest private address mismatch",
  ],
  [
    Boolean(
      guest?.kernel_release && guest?.kernel_signature && guest?.kernel_version
    ),
    "missing kernel release/version evidence",
  ],
];
const existingService = (guest, expected) =>
  Boolean(
    expected?.id &&
    expected?.image &&
    guest?.services?.some(
      (service) =>
        service.id === expected.id &&
        service.image === expected.image &&
        service.running
    )
  );
/** A reviewed baseline supplies exact proxy, Sentinel and smoke IDs/images.
 * Absent MongoDB is recorded before deployment; unhealthy MongoDB blocks. */
export const preflight = (
  inventory,
  guest,
  manifest,
  { now = Date.parse(guest?.utc) } = {}
) => {
  const checks = [
    ...guestIdentity(guest),
    [
      Number.isFinite(guest?.clock_offset_ms) &&
        Math.abs(guest.clock_offset_ms) + (guest.clock_uncertainty_ms ?? 0) <=
          1000,
      "missing or excessive clock offset",
    ],
    [
      ["healthy", "absent"].includes(guest?.mongo_health),
      "MongoDB health unavailable or unhealthy",
    ],
    [
      Array.isArray(guest?.resources) &&
        guest.resources.every(
          (resource) =>
            resource.labels?.["com.reltide.capacity.project"] !== project
        ),
      "preexisting capacity resources require explicit owned handling",
    ],
    [
      manifest?.platform === "linux/amd64" &&
        manifest?.resource_limits?.total_memory_mib <= 3072,
      "invalid stack platform/budget",
    ],
  ];
  for (const role of ["proxy", "sentinel", "smoke"]) {
    checks.push([
      existingService(guest, manifest?.host_services?.[role]),
      `missing or replaced existing ${role} identity`,
    ]);
  }
  return [
    ...cloudReasons(inventory, now),
    ...checks.filter(([valid]) => !valid).map(([, reason]) => reason),
    ...evaluateGuard(guest?.sample ? [guest.sample] : []).reasons,
  ];
};

const readGuest = async ({ inventory, run, jump, signal }) => {
  const address = inventory.server.public_net?.ipv4?.ip;
  if (!isIP(address ?? "") || (jump && !/^root@[a-z0-9.-]+$/u.test(jump))) {
    throw new Error("invalid SSH endpoint");
  }
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
  ];
  if (jump) {
    args.push("-J", jump);
  }
  args.push(`root@${address}`);
  const remote = async (script) =>
    JSON.parse(
      await run(
        "ssh",
        [...args, `python3 -c '${script.replaceAll("'", "'\\''")}'`],
        { signal }
      )
    );
  const guest = await remote(guestScript);
  const identityErrors = guestIdentity(guest).filter(([valid]) => !valid);
  if (identityErrors.length) {
    throw new Error("guest identity unavailable or mismatched");
  }
  // Probe UTC separately: Docker stats latency must not masquerade as drift.
  const before = Date.now();
  const clock = await remote(
    "import datetime,json;print(json.dumps(dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat())))"
  );
  const after = Date.now();
  guest.clock_offset_ms = Date.parse(clock.utc) - (before + after) / 2;
  guest.clock_uncertainty_ms = (after - before) / 2;
  guest.raw.clock_offset_ms = guest.clock_offset_ms;
  return guest;
};
/** Read-only sampling may reuse an authenticated initial cloud snapshot; every
 * capture checks fresh guest metadata. Mutation requires a new preflight. */
export const collectHost = async ({
  inventory,
  jump,
  run = runCommand,
  signal,
}) => {
  if (cloudReasons(inventory, Date.parse(inventory?.utc)).length) {
    throw new Error("cloud snapshot identity unavailable");
  }
  const guest = await readGuest({ inventory, jump, run, signal });
  if (Math.abs(guest.clock_offset_ms) + guest.clock_uncertainty_ms > 1000) {
    throw new Error("clock verification unavailable");
  }
  return guest.raw;
};

export const readHostPreflight = async ({
  manifest,
  run = runCommand,
  jump,
} = {}) => {
  let inventory;
  try {
    const read = async (kind, id) =>
      JSON.parse(
        await run("hcloud", [
          "--context",
          "reltide",
          kind,
          "describe",
          String(id),
          "--output",
          "json",
        ])
      );
    const server = await read("server", serverId);
    if (server.id !== serverId) {
      return { reasons: ["cloud server identity mismatch"], status: "BLOCKED" };
    }
    const [network, firewall] = await Promise.all([
      read("network", networkId),
      read("firewall", firewallId),
    ]);
    inventory = { firewall, network, server, utc: new Date().toISOString() };
    const reasons = cloudReasons(inventory, Date.now());
    if (reasons.length) {
      return { inventory, reasons, status: "BLOCKED" };
    }
    const guest = await readGuest({ inventory, jump, run });
    // A second capture supplies CPU deltas. No partial first sample can pass.
    await delay(1000);
    const next = await readGuest({ inventory, jump, run });
    next.sample = parseHostSample(next.raw, guest.raw);
    const rejection = preflight(inventory, next, manifest, { now: Date.now() });
    return {
      guest: next,
      inventory,
      reasons: rejection,
      status: rejection.length ? "BLOCKED" : "VERIFIED",
    };
  } catch {
    // Subprocess stderr/inspect data may contain sensitive host configuration.
    return {
      inventory,
      reasons: [
        "authenticated guest preflight unavailable; identity, kernel, metrics and MongoDB evidence BLOCKED",
      ],
      status: "BLOCKED",
    };
  }
};

const owned = (resource, ownership) =>
  resource?.labels?.["com.reltide.capacity.project"] === ownership.project &&
  resource?.labels?.["com.reltide.capacity.run"] === ownership.run_id;
const fingerprintKey = (resource) => `${resource.kind}/${resource.id}`;

export const recordOwnership = (runId, before, after) => {
  if (
    !runPattern.test(runId) ||
    before?.server_id !== serverId ||
    after?.server_id !== serverId ||
    !Array.isArray(before.resources) ||
    !Array.isArray(after.resources)
  ) {
    throw new Error("invalid ownership identity");
  }
  const result = {
    container_ids: [],
    network_ids: [],
    preexisting_ids: before.resources.map(fingerprintKey),
    project,
    resource_fingerprints: {},
    run_id: runId,
    server_id: serverId,
    source_volume_ids: [],
    volume_ids: [],
  };
  for (const resource of after.resources) {
    const key = fingerprintKey(resource);
    if (result.preexisting_ids.includes(key) || !owned(resource, result)) {
      continue;
    }
    if (
      !["container", "volume", "network"].includes(resource.kind) ||
      !resource.id ||
      !resource.identity
    ) {
      throw new Error("missing resource identity");
    }
    result[`${resource.kind}_ids`].push(resource.id);
    result.resource_fingerprints[key] = resource.identity;
  }
  return result;
};

export const cleanupSelection = (ownership, observed) => {
  if (
    ownership?.server_id !== serverId ||
    observed?.server_id !== serverId ||
    ownership?.project !== project ||
    !runPattern.test(ownership?.run_id ?? "")
  ) {
    return [];
  }
  return (observed?.resources ?? [])
    .filter((resource) => {
      const key = fingerprintKey(resource);
      return (
        ["container", "volume", "network"].includes(resource.kind) &&
        ownership[`${resource.kind}_ids`]?.includes(resource.id) &&
        owned(resource, ownership) &&
        Boolean(resource.identity) &&
        ownership.resource_fingerprints?.[key] === resource.identity &&
        !ownership.preexisting_ids?.includes(key) &&
        !(
          resource.kind === "volume" &&
          ownership.source_volume_ids?.includes(resource.id)
        )
      );
    })
    .map(({ id, kind }) => ({ id, kind }));
};

/** Called by an operator-reviewed actuator: close admission synchronously,
 * persist evidence, then freshly inspect before each bounded container stop.
 * No volumes, backups or evidence are removed during pressure/cancellation. */
export const guardStop = async ({
  ownership,
  stopLoad,
  persist,
  inspect,
  stopContainer,
}) => {
  await stopLoad();
  await persist();
  /* eslint-disable no-await-in-loop -- Stop and reinspect each resource sequentially to preserve safety and dependency order. */
  for (const id of ownership.container_ids) {
    const fresh = await inspect();
    if (
      cleanupSelection(ownership, fresh).some(
        (resource) => resource.kind === "container" && resource.id === id
      )
    ) {
      await stopContainer(id);
    }
  }
  /* eslint-enable no-await-in-loop */
};

/** The caller supplies remote collection and evidence persistence. One-second
 * cadence, bounded five-minute memory, and an AbortSignal for Task 4 admission.
 * Collection failure closes load immediately rather than waiting for a gap. */
export const sampleHost = async ({
  collect,
  persist,
  stopLoad,
  signal,
  controller = new AbortController(),
  interval = delay,
}) => {
  const samples = [];
  let previous;
  let closed = false;
  let result = {
    reasons: ["sampling cancelled"],
    status: "BLOCKED",
    stop: true,
  };
  const close = async () => {
    if (!closed) {
      closed = true;
      controller.abort(result);
      await stopLoad(result, controller.signal);
    }
  };
  try {
    /* eslint-disable no-await-in-loop -- Sampling, admission closure and persistence must occur in observation order. */
    while (true) {
      if (signal?.aborted || controller.signal.aborted) {
        break;
      }
      const start = performance.now();
      const deadline = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(3000),
        ...(signal ? [signal] : []),
      ]);
      const cancel = async () => {
        await once(deadline, "abort");
        throw new Error("sampling deadline/cancellation");
      };
      const cancelled = cancel();
      const collection = async () => await collect({ signal: deadline });
      const before = Date.now();
      const raw = await Promise.race([collection(), cancelled]);
      if (raw.clock_offset_ms === undefined) {
        raw.clock_offset_ms = Date.parse(raw.utc) - (before + Date.now()) / 2;
      }
      if (previous) {
        const sample = parseHostSample(raw, previous);
        samples.push(sample);
        result = evaluateGuard(samples);
        if (result.stop) {
          await close();
        }
        await persist({ guard: result, sample });
        if (result.stop) {
          break;
        }
        while (
          samples.length > 1 &&
          sample.monotonic_ms - samples[0].monotonic_ms > 300_000
        ) {
          samples.shift();
        }
      }
      previous = raw;
      await interval(
        Math.max(0, 1000 - (performance.now() - start)),
        undefined,
        {
          signal: AbortSignal.any([
            controller.signal,
            ...(signal ? [signal] : []),
          ]),
        }
      );
    }
    /* eslint-enable no-await-in-loop */
  } catch {
    result = {
      reasons: ["host sampling unavailable or cancelled"],
      status: "BLOCKED",
      stop: true,
    };
  }
  await close();
  await persist({ guard: result });
  return result;
};

if (process.argv[1] === import.meta.filename) {
  if (process.argv[2] === "preflight") {
    const { compose, limits, manifest } = await readStackManifest();
    const errors = validateStack(manifest, compose, limits);
    const result = errors.length
      ? { reasons: errors, status: "BLOCKED" }
      : await readHostPreflight({
          jump: process.env.CAPACITY_SSH_JUMP,
          manifest,
        });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "VERIFIED" ? 0 : 2;
  } else {
    process.stderr.write("expected read-only preflight subcommand\n");
    process.exitCode = 2;
  }
}
