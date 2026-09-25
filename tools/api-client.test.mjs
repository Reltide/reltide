import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";

import { compareArtifactTrees } from "../packages/api-client/scripts/artifacts.mjs";

test("contract drift reports a changed generated source", async () => {
  const left = await mkdtemp(path.join(os.tmpdir(), "reltide-artifact-left-"));
  const right = await mkdtemp(
    path.join(os.tmpdir(), "reltide-artifact-right-")
  );
  try {
    await writeFile(path.join(left, "client.ts"), "old");
    await writeFile(path.join(right, "client.ts"), "new");
    assert.deepEqual(await compareArtifactTrees(left, right), ["client.ts"]);

    await writeFile(path.join(right, "client.ts"), "old");
    assert.deepEqual(await compareArtifactTrees(left, right), []);
  } finally {
    await Promise.all([
      rm(left, { recursive: true }),
      rm(right, { recursive: true }),
    ]);
  }
});

test("contract drift reports missing files", async () => {
  const left = await mkdtemp(path.join(os.tmpdir(), "reltide-artifact-left-"));
  const right = await mkdtemp(
    path.join(os.tmpdir(), "reltide-artifact-right-")
  );
  try {
    await writeFile(path.join(left, "old.ts"), "old");
    await writeFile(path.join(right, "new.ts"), "new");
    assert.deepEqual(await compareArtifactTrees(left, right), [
      "new.ts",
      "old.ts",
    ]);
  } finally {
    await Promise.all([
      rm(left, { recursive: true }),
      rm(right, { recursive: true }),
    ]);
  }
});

test("committed Rust contract contains the health operation", async () => {
  const contract = JSON.parse(
    await readFile(
      new URL("../packages/api-client/openapi.json", import.meta.url),
      "utf-8"
    )
  );
  assert.equal(contract.paths["/api/v1/health"].get.operationId, "getHealth");
});
