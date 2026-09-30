import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { configurationChecksum } from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const allowedRootFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "nx.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".node-version",
  ".dockerignore",
]);
const denied =
  /(?:^|\/)(?:\.git|\.superpowers|\.capacity|node_modules|\.next|\.source|\.nx|target|dist|credentials[^/]*)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:env|pem|key)$/u;
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const sha256File = async (file) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

export const verifyArtifactArchives = async (workspace, artifact) => {
  await Promise.all(
    ["docker", "oci"].map(async (format) => {
      const relative = artifact?.[`${format}_archive`];
      const expected = artifact?.[`${format}_archive_sha256`];
      if (
        !/^\.capacity\/[a-z0-9-]+\/[a-z0-9-]+\.(?:docker|oci)\.tar$/u.test(
          relative
        ) ||
        !/^[a-f0-9]{64}$/u.test(expected ?? "")
      ) {
        throw new Error(`invalid ${format} archive record`);
      }
      const file = path.join(workspace, relative);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${format} archive is not a regular file`);
      }
      if ((await sha256File(file)) !== expected) {
        throw new Error(`${format} archive checksum mismatch`);
      }
    })
  );
};

export const verifyArchive = (bytes, expected) => {
  if (sha256(bytes) !== expected) {
    throw new Error("release archive checksum mismatch");
  }
};

/** Only repository source is sent to BuildKit, including on credential-bearing rebuilds. */
export const createBuildContext = async (source, destination, trackedFiles) => {
  const copied = trackedFiles.filter(
    (file) =>
      !file.split("/").includes("..") &&
      !denied.test(file) &&
      (allowedRootFiles.has(file) ||
        /^(?:apps|packages|crates|fixtures)\//u.test(file) ||
        file === "infra/capacity/sql/ledger.sql")
  );
  await Promise.all(
    copied.map(async (file) => {
      const info = await lstat(path.join(source, file));
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("build context contains a non-regular source file");
      }
      await mkdir(path.dirname(path.join(destination, file)), {
        recursive: true,
      });
      await copyFile(path.join(source, file), path.join(destination, file));
    })
  );
  return copied;
};

export const command = (program, args, options = {}) =>
  execFileSync(program, args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

export const writeFormattedJson = async (file, value) => {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  command("pnpm", ["exec", "oxfmt", "--write", file]);
};

export const artifactIdentity = async (directory, name) => {
  const oci = path.join(directory, `${name}.oci.tar`);
  const docker = path.join(directory, `${name}.docker.tar`);
  const index = JSON.parse(command("tar", ["-xOf", oci, "index.json"]));
  const descriptor = index.manifests.find(
    (value) =>
      value.platform?.architecture === "amd64" && value.platform?.os === "linux"
  );
  if (!descriptor || index.manifests.length !== 1) {
    throw new Error("expected one amd64 OCI manifest");
  }
  const manifestBytes = Buffer.from(
    command("tar", ["-xOf", oci, `blobs/sha256/${descriptor.digest.slice(7)}`])
  );
  if (`sha256:${sha256(manifestBytes)}` !== descriptor.digest) {
    throw new Error("OCI manifest checksum mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  const configBytes = Buffer.from(
    command("tar", [
      "-xOf",
      oci,
      `blobs/sha256/${manifest.config.digest.slice(7)}`,
    ])
  );
  if (`sha256:${sha256(configBytes)}` !== manifest.config.digest) {
    throw new Error("OCI config checksum mismatch");
  }
  const config = JSON.parse(configBytes);
  if (config.architecture !== "amd64" || config.os !== "linux") {
    throw new Error("OCI config platform mismatch");
  }
  const dockerManifest = JSON.parse(
    command("tar", ["-xOf", docker, "manifest.json"])
  );
  const dockerConfig = Buffer.from(
    command("tar", ["-xOf", docker, dockerManifest[0].Config])
  );
  if (`sha256:${sha256(dockerConfig)}` !== manifest.config.digest) {
    throw new Error("Docker and OCI config identities differ");
  }
  const tag = `reltide-capacity/${name}:local`;
  command("docker", ["load", "-i", docker]);
  // Docker exporter archives without tags still load by their verified config ID.
  const actual = command("docker", [
    "image",
    "inspect",
    manifest.config.digest,
    "--format",
    "{{.Id}}",
  ]).trim();
  if (actual !== manifest.config.digest) {
    throw new Error("loaded Docker identity mismatch");
  }
  command("docker", ["tag", actual, tag]);
  return {
    config_digest: manifest.config.digest,
    deployment_ref: `reltide-capacity/${name}@${descriptor.digest}`,
    docker_archive: path.relative(root, docker),
    docker_archive_sha256: await sha256File(docker),
    local_runtime_identity: actual,
    oci_archive: path.relative(root, oci),
    oci_archive_sha256: await sha256File(oci),
    oci_manifest_digest: descriptor.digest,
  };
};

export const contextChecksum = async (contexts, pins) => {
  const collect = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const collected = await Promise.all(
      entries.map(async (entry) => {
        const name = path.join(prefix, entry.name);
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return collect(file, name);
        }
        if (!entry.isFile()) {
          throw new Error("build identity contains non-regular input");
        }
        return [{ path: name, sha256: sha256(await readFile(file)) }];
      })
    );
    return collected.flat();
  };
  const [contextsFiles, dockerfiles] = await Promise.all([
    Promise.all(
      Object.entries(contexts).map(([prefix, directory]) =>
        collect(directory, prefix)
      )
    ),
    Promise.all(
      [
        "Dockerfile.next",
        "Dockerfile.rust",
        "Dockerfile.postgres",
        "Dockerfile.pg-clickhouse",
      ].map(async (file) => ({
        path: file,
        sha256: sha256(await readFile(path.join(root, "infra/capacity", file))),
      }))
    ),
  ]);
  const files = [...contextsFiles.flat(), ...dockerfiles].toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
  return sha256(JSON.stringify({ files, pins }));
};

const releaseBinary = async (directory, name, pin) => {
  const archive = path.join(
    directory,
    name === "age" ? "age.tar.gz" : "rclone.zip"
  );
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    const response = await fetch(pin.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`required ${name} release unavailable`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, pin.sha256);
    await writeFile(archive, bytes);
  }
  verifyArchive(bytes, pin.sha256);
  const binary =
    name === "age"
      ? execFileSync("tar", ["-xOf", archive, "age/age"], {
          maxBuffer: 128 * 1024 * 1024,
        })
      : execFileSync(
          "unzip",
          ["-p", archive, `rclone-v${pin.version}-linux-amd64/rclone`],
          { maxBuffer: 128 * 1024 * 1024 }
        );
  await writeFile(path.join(directory, name), binary, { mode: 0o755 });
};

export const buildImages = async (runId) => {
  if (!/^[a-z0-9-]{1,64}$/u.test(runId)) {
    throw new Error("invalid build run ID");
  }
  if (process.version !== "v26.10.0") {
    throw new Error("Node 26.10.0 required");
  }
  const architecture = command("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]).trim();
  const lockPath = path.join(root, "infra/capacity/images.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf-8"));
  const directory = path.join(root, ".capacity", runId);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const source = path.join(directory, "source");
  await mkdir(source, { recursive: true });
  command("pnpm", ["nx", "run", "docs:prepare-content"], { stdio: "inherit" });
  const files = command("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  const copied = await createBuildContext(root, source, files);
  await cp(
    path.join(root, "apps/docs/content/docs/reference/generated"),
    path.join(source, "apps/docs/content/docs/reference/generated"),
    { recursive: true }
  );
  await writeFile(
    path.join(directory, "context-files.json"),
    JSON.stringify(copied, null, 2)
  );
  const pg = path.join(directory, "pgbuild");
  await mkdir(pg, { recursive: true });
  await Promise.all(
    Object.entries(lock.archives).map(([name, pin]) =>
      releaseBinary(pg, name, pin)
    )
  );
  const extension = path.join(directory, "pg_clickhouse");
  try {
    await lstat(extension);
  } catch {
    command("git", [
      "clone",
      "--no-checkout",
      "https://github.com/ClickHouse/pg_clickhouse.git",
      extension,
    ]);
  }
  command("git", [
    "-C",
    extension,
    "checkout",
    "--detach",
    lock.extension.source_commit,
  ]);
  command("git", [
    "-C",
    extension,
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  for (const [submodule, commit] of Object.entries(lock.extension.submodules)) {
    if (
      command("git", [
        "-C",
        path.join(extension, submodule),
        "rev-parse",
        "HEAD",
      ]).trim() !== commit
    ) {
      throw new Error("extension submodule pin mismatch");
    }
  }
  await cp(extension, path.join(pg, "pg_clickhouse"), {
    filter: (file) => path.basename(file) !== ".git",
    recursive: true,
  });
  // OCI input uses an explicit local tag plus its immutable digest: installed
  // Buildx rejects the documented digest-only form with an empty-tag parse error.
  const buildIdentity = {
    build_input_sha256: await contextChecksum(
      { postgres: pg, source },
      {
        archives: lock.archives,
        extension: lock.extension,
        inputs: lock.inputs,
      }
    ),
    purpose: "local_correctness_only",
    source_commit: command("git", ["rev-parse", "HEAD"]).trim(),
    source_dirty: Boolean(command("git", ["status", "--porcelain"]).trim()),
  };
  const builder = `reltide-capacity-${runId}`;
  const buildkit =
    architecture === "aarch64"
      ? lock.inputs.buildkit
      : lock.inputs["buildkit-amd64"];
  if (!buildkit) {
    throw new Error("no pinned BuildKit image for this architecture");
  }
  command(
    "docker",
    [
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${buildkit}`,
      "--bootstrap",
    ],
    { stdio: "inherit" }
  );
  try {
    const build = async (name, dockerfile, context, args = []) => {
      command(
        "docker",
        [
          "buildx",
          "build",
          "--builder",
          builder,
          "--platform",
          "linux/amd64",
          "--provenance=false",
          "-f",
          path.join(root, "infra/capacity", dockerfile),
          "--output",
          `type=oci,dest=${directory}/${name}.oci.tar`,
          "--output",
          `type=docker,dest=${directory}/${name}.docker.tar`,
          ...args,
          context,
        ],
        { stdio: "inherit" }
      );
      lock.derived[name] = await artifactIdentity(directory, name);
    };
    await build("postgres18", "Dockerfile.postgres", pg);
    const layout = path.join(directory, "postgres18-layout");
    await mkdir(layout, { recursive: true });
    command("tar", [
      "-xf",
      path.join(directory, "postgres18.oci.tar"),
      "-C",
      layout,
    ]);
    await build("application-pg", "Dockerfile.pg-clickhouse", pg, [
      "--build-context",
      `backup=oci-layout://${layout}:capacity@${lock.derived.postgres18.oci_manifest_digest}`,
    ]);
    await build("temporal-pg", "Dockerfile.postgres", pg, [
      "--build-arg",
      `POSTGRES_IMAGE=${lock.inputs["temporal-postgres"]}`,
    ]);
    await build("app", "Dockerfile.next", source, ["--build-arg", "APP=app"]);
    await build("web", "Dockerfile.next", source, ["--build-arg", "APP=web"]);
    await build("docs", "Dockerfile.next", source, ["--build-arg", "APP=docs"]);
    await build("api", "Dockerfile.rust", source, [
      "--build-arg",
      "BINARY=reltide-api",
    ]);
    await build("probe", "Dockerfile.rust", source, [
      "--build-arg",
      "BINARY=reltide-capacity-probe",
    ]);
    const composePath = path.join(root, "infra/capacity/compose.json");
    const compose = JSON.parse(await readFile(composePath, "utf-8"));
    for (const [name, artifact] of Object.entries(lock.derived)) {
      if (compose.services[name]) {
        compose.services[name].image = artifact.deployment_ref;
      }
    }
    await writeFormattedJson(composePath, compose);
    lock.config_sha256 = await configurationChecksum();
    lock.source_commit = buildIdentity.source_commit;
    lock.build_identity = buildIdentity;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(
      path.join(directory, "artifacts.json"),
      `${JSON.stringify({ build_identity: buildIdentity, derived: lock.derived }, null, 2)}\n`
    );
    return lock;
  } finally {
    command("docker", ["buildx", "rm", builder], { stdio: "inherit" });
  }
};

if (process.argv[1] === import.meta.filename) {
  await buildImages(process.env.CAPACITY_RUN_ID ?? `local-${Date.now()}`);
}
