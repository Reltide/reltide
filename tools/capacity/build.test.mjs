import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import {
  createBuildContext,
  sha256,
  verifyArchive,
  verifyArtifactArchives,
  writeFormattedJson,
} from "./build.mjs";

test("rewritten Compose JSON remains accepted by the repository formatter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capacity-format-test-"));
  const file = path.join(root, "compose.json");
  try {
    await writeFormattedJson(file, {
      services: { app: { networks: ["private"] } },
    });
    execFileSync("pnpm", ["exec", "oxfmt", "--check", file]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rebuild context excludes runtime secrets and host artifacts even if tracked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capacity-build-test-"));
  const files = [
    "package.json",
    "apps/app/app/page.tsx",
    "apps/docs/app/docs/[[...slug]]/page.tsx",
    "apps/docs/../private.tsx",
    "apps/app/.env.local",
    "apps/app/credentials.json",
    "apps/app/.next/server.js",
    ".capacity/probe.env",
    ".superpowers/private.md",
    ".git/config",
    "target/release/probe",
  ];
  try {
    await Promise.all(
      files.map(async (file) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "sentinel");
      })
    );
    const copied = await createBuildContext(
      root,
      path.join(root, "output"),
      files
    );
    assert.deepEqual(copied.toSorted(), [
      "apps/app/app/page.tsx",
      "apps/docs/app/docs/[[...slug]]/page.tsx",
      "package.json",
    ]);
    assert.equal(
      await readFile(path.join(root, "output/package.json"), "utf-8"),
      "sentinel"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
test("rejects a changed release archive before extraction", () => {
  assert.throws(
    () => verifyArchive(Buffer.from("wrong"), "a".repeat(64)),
    /checksum/u
  );
});
test("requires both emitted image archives to match recorded checksums", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capacity-artifacts-test-"));
  const artifact = {
    docker_archive: ".capacity/build/image.docker.tar",
    docker_archive_sha256: sha256(Buffer.from("docker")),
    oci_archive: ".capacity/build/image.oci.tar",
    oci_archive_sha256: sha256(Buffer.from("oci")),
  };
  try {
    await mkdir(path.join(root, ".capacity/build"), { recursive: true });
    await writeFile(path.join(root, artifact.docker_archive), "docker");
    await assert.rejects(() => verifyArtifactArchives(root, artifact));
    await writeFile(path.join(root, artifact.oci_archive), "wrong");
    await assert.rejects(() => verifyArtifactArchives(root, artifact));
    await writeFile(path.join(root, artifact.oci_archive), "oci");
    await verifyArtifactArchives(root, artifact);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
test("Next dependency install layer is shared across app build arguments", async () => {
  const dockerfile = await readFile(
    new URL("../../infra/capacity/Dockerfile.next", import.meta.url),
    "utf-8"
  );
  const install = dockerfile.indexOf("RUN npm install --global pnpm@12.6.0");
  const appArgument = dockerfile.indexOf("ARG APP");
  assert.notEqual(install, -1);
  assert.ok(appArgument > install);
});
