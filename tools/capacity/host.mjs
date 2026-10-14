import { execFile } from "node:child_process";
import { once } from "node:events";
import { isIP } from "node:net";
import path from "node:path";
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
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const decimal = /^(?:0|[1-9][0-9]*)$/u;

const defaultLocalVolume = (resource) =>
  resource.driver === "local" &&
  resource.scope === "local" &&
  (resource.options === null ||
    (resource.options &&
      Object.getPrototypeOf(resource.options) === Object.prototype &&
      Object.keys(resource.options).length === 0));

/** Default local Docker volumes only. Birth time must carry sub-second precision;
 * labels and Docker's second-resolution CreatedAt cannot prove a generation. */
export const volumeIdentity = (resource) => {
  if (!defaultLocalVolume(resource) || !volumeName.test(resource.id ?? "")) {
    return null;
  }
  const { generation } = resource;
  if (generation?.is_directory !== true) {
    return null;
  }
  const integers = [
    generation.device,
    generation.inode,
    generation.birth_time_ns,
  ];
  if (
    !integers.every(
      (value) => decimal.test(value) && BigInt(value).toString() === value
    )
  ) {
    return null;
  }
  if (
    generation.inode === "0" ||
    BigInt(generation.birth_time_ns) % 1_000_000_000n === 0n
  ) {
    return null;
  }
  try {
    const root = resource.docker_root_dir;
    if (!path.posix.isAbsolute(root) || path.posix.normalize(root) !== root) {
      return null;
    }
    if (
      resource.mountpoint !==
      path.posix.join(root, "volumes", resource.id, "_data")
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return `local-volume:${resource.mountpoint}:${integers.join(":")}`;
};

const resourceIdentity = (resource) =>
  resource.kind === "volume" ? volumeIdentity(resource) : resource.identity;

// No environment/configuration arrays are emitted: Docker inspect includes secrets.
// This fixed, read-only program is also the sampler's collector. No user text is
// substituted into the remote program, and no remote mutation command is exposed.
const guestScript = String.raw`
import datetime, json, os, platform, re, stat as filesystem_stat, subprocess, time, urllib.request
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
docker_root = docker(['info','--format','{{.DockerRootDir}}'])
for kind in ['volume','network']:
    for r in inspect(kind, docker([kind, 'ls', '-q']).split()):
        resource = dict(kind=kind, id=r.get('Id',r['Name']), identity=r.get('Id'), labels=labels(r.get('Labels')))
        if kind == 'volume':
            resource.update(driver=r['Driver'], scope=r['Scope'], options=r.get('Options'), mountpoint=r['Mountpoint'], docker_root_dir=docker_root, generation=None)
            expected = os.path.join(docker_root, 'volumes', r['Name'], '_data')
            if r['Driver'] == 'local' and r['Scope'] == 'local' and not r.get('Options') and r['Mountpoint'] == expected:
                try:
                    info = os.lstat(expected)
                    device, inode, birth = command(['env', 'TZ=UTC', 'stat', '--format=%d|%i|%w', '--', expected]).split('|')
                    parts = re.fullmatch(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d{9}) ([+-]\d{4})', birth)
                    if parts and filesystem_stat.S_ISDIR(info.st_mode) and not filesystem_stat.S_ISLNK(info.st_mode):
                        seconds = int(datetime.datetime.strptime(parts[1] + ' ' + parts[3], '%Y-%m-%d %H:%M:%S %z').timestamp())
                        resource['generation'] = dict(device=device, inode=inode, birth_time_ns=str(seconds * 1000000000 + int(parts[2])), is_directory=True)
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass  # Unknown generation is preserved, never selected for cleanup.
        resources.append(resource)
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
  const values = samples.filter(validSample);
  const boundary = latest?.monotonic_ms - duration;
  let weighted = 0;
  let elapsed = 0;
  let swapActive = false;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    const delta =
      current.monotonic_ms - Math.max(previous.monotonic_ms, boundary);
    if (delta <= 0) {
      continue;
    }
    weighted += current.cpu_busy_ratio * delta;
    elapsed += delta;
    swapActive ||= ["swap_in_bytes", "swap_out_bytes"].some(
      (key) => current[key] > previous[key]
    );
  }
  return {
    count: values.filter((sample) => sample.monotonic_ms >= boundary).length,
    cpu_busy_ratio: elapsed ? weighted / elapsed : null,
    duration_ms: elapsed,
    swap_active: swapActive,
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
const preflightClock = (guest, now) => {
  const uncertainty = guest?.clock_uncertainty_ms ?? 0;
  const clockValid =
    Number.isFinite(guest?.clock_offset_ms) &&
    nonnegative(uncertainty) &&
    Math.abs(guest.clock_offset_ms) + uncertainty <= 1000;
  const fresh = (time) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate timestamp evidence at the public preflight boundary before date coercion.
    if (typeof time !== "string") {
      return false;
    }
    const age = now - (Date.parse(time) - guest?.clock_offset_ms);
    return (
      clockValid &&
      Number.isFinite(age) &&
      age - uncertainty >= 0 &&
      age + uncertainty <= 3000
    );
  };
  return [
    [clockValid, "missing or excessive clock offset"],
    [fresh(guest?.utc), "stale, future or missing guest timestamp"],
    [fresh(guest?.sample?.utc), "stale, future or missing sample timestamp"],
  ];
};
/** A reviewed baseline supplies exact proxy, Sentinel and smoke IDs/images.
 * Absent MongoDB is recorded before deployment; unhealthy MongoDB blocks. */
export const preflight = (
  inventory,
  guest,
  manifest,
  { now = Date.now() } = {}
) => {
  const checks = [
    ...guestIdentity(guest),
    ...preflightClock(guest, now),
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
  for (const resource of guest.resources ?? []) {
    if (resource.kind === "volume") {
      resource.identity = volumeIdentity(resource);
    }
  }
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
      !resourceIdentity(resource)
    ) {
      throw new Error("missing resource identity");
    }
    result[`${resource.kind}_ids`].push(resource.id);
    result.resource_fingerprints[key] = resourceIdentity(resource);
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
        Boolean(resourceIdentity(resource)) &&
        ownership.resource_fingerprints?.[key] === resourceIdentity(resource) &&
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

// The watchdog races the entire step, so stalled persistence and cancellation
// close shared admission even after collection has completed.
const samplingWatchdog = async (operation, { signal, onExpired }) => {
  const timeout = new AbortController();
  const completed = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, 3000);
  const deadline = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  const interrupted = async () => {
    if (!deadline.aborted) {
      await once(deadline, "abort", { signal: completed.signal });
    }
    await onExpired();
    throw new Error("sampling cycle deadline/cancellation");
  };
  const invoke = async () => await operation(deadline);
  try {
    return await Promise.race([invoke(), interrupted()]);
  } finally {
    clearTimeout(timer);
    completed.abort();
  }
};

/** The watchdog covers collection, persistence and the one-second cadence wait.
 * Observation freshness remains bounded across cycles, including slow evidence.
 * An external cancellation also closes the caller's shared admission signal.
 * Pressure-triggered admission closure still allows bounded evidence saving. */
export const sampleHost = async ({
  collect,
  persist,
  stopLoad,
  signal,
  controller = new AbortController(),
  interval = delay,
}) => {
  const samples = [];
  const cancellation = new AbortController();
  const freshness = new AbortController();
  const expireFreshness = () => {
    freshness.abort();
  };
  let freshnessTimer = setTimeout(expireFreshness, 3000);
  const samplingSignal = AbortSignal.any([
    cancellation.signal,
    freshness.signal,
  ]);
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
  const externalAbort = () => {
    cancellation.abort();
  };
  const sharedAbort = () => {
    if (!closed) {
      cancellation.abort();
    }
  };
  signal?.addEventListener("abort", externalAbort, { once: true });
  controller.signal.addEventListener("abort", sharedAbort, { once: true });
  if (signal?.aborted || controller.signal.aborted) {
    cancellation.abort();
  }
  const blocked = async (reason) => {
    result = {
      reasons: [...new Set([...result.reasons, reason])],
      status: "BLOCKED",
      stop: true,
    };
    await close();
  };
  const sampleCycle = async (deadline) => {
    const start = performance.now();
    const before = Date.now();
    const raw = await collect({ signal: deadline });
    const observedAt = performance.now();
    if (deadline.aborted) {
      throw new Error("collection cancelled");
    }
    if (raw.clock_offset_ms === undefined) {
      raw.clock_offset_ms = Date.parse(raw.utc) - (before + Date.now()) / 2;
    }
    if (previous) {
      const sample = parseHostSample(raw, previous);
      samples.push(sample);
      result = evaluateGuard(samples);
      if (result.stop) {
        await close();
      } else {
        // Only a validated observation renews freshness; persistence, cadence
        // waits and the start of another collection cannot buy a new deadline.
        clearTimeout(freshnessTimer);
        freshnessTimer = setTimeout(
          expireFreshness,
          Math.max(0, 3000 - (performance.now() - observedAt))
        );
      }
      await persist({ guard: result, sample }, { signal: deadline });
      if (deadline.aborted) {
        throw new Error("persistence cancelled");
      }
      if (result.stop) {
        return false;
      }
      // Keep the last observation at or before the five-minute boundary;
      // its following interval is clipped when calculating window means.
      while (
        samples.length > 2 &&
        samples[1].monotonic_ms <= sample.monotonic_ms - 300_000
      ) {
        samples.shift();
      }
    }
    previous = raw;
    await interval(Math.max(0, 1000 - (performance.now() - start)), undefined, {
      signal: deadline,
    });
    return true;
  };
  try {
    /* eslint-disable no-await-in-loop -- Every cycle must finish before the next observation; the independent watchdog bounds its waits. */
    while (!samplingSignal.aborted) {
      const proceed = await samplingWatchdog(sampleCycle, {
        onExpired: async () => {
          await blocked("sampling cycle stalled or cancelled");
        },
        signal: samplingSignal,
      });
      if (!proceed) {
        break;
      }
    }
    /* eslint-enable no-await-in-loop */
  } catch {
    await blocked("host sampling unavailable or cancelled");
  } finally {
    clearTimeout(freshnessTimer);
    signal?.removeEventListener("abort", externalAbort);
    controller.signal.removeEventListener("abort", sharedAbort);
  }
  await close();
  try {
    await samplingWatchdog(
      async (deadline) =>
        await persist({ guard: result }, { signal: deadline }),
      {
        onExpired: async () => {
          await blocked("terminal evidence persistence unavailable");
        },
      }
    );
  } catch {
    await blocked("terminal evidence persistence unavailable");
  }
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
