import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClient } from "@hey-api/openapi-ts";

import { compareArtifactTrees } from "./artifacts.mjs";

const mode = process.argv.at(2);
if (!["--generate", "--check"].includes(mode) || process.argv.length !== 3) {
  throw new Error("usage: node contract.mjs --generate|--check");
}

const packageRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "reltide-api-client-")
);

try {
  const expectedRoot = path.join(temporaryRoot, "expected");
  const currentRoot = path.join(temporaryRoot, "current");
  const expectedContract = path.join(expectedRoot, "openapi.json");
  const expectedGenerated = path.join(expectedRoot, "src/generated");
  await mkdir(expectedRoot, { recursive: true });
  await mkdir(currentRoot, { recursive: true });

  const contract = execFileSync(
    "cargo",
    ["run", "-q", "-p", "reltide-api", "--locked", "--", "--print-openapi"],
    { cwd: workspaceRoot, encoding: "utf-8" }
  );
  JSON.parse(contract);
  await writeFile(expectedContract, contract);
  await createClient({ input: expectedContract, output: expectedGenerated });

  if (mode === "--generate") {
    await copyFile(expectedContract, path.join(packageRoot, "openapi.json"));
    const generated = path.join(packageRoot, "src/generated");
    await rm(generated, { force: true, recursive: true });
    await mkdir(path.dirname(generated), { recursive: true });
    await cp(expectedGenerated, generated, { recursive: true });
    process.stdout.write("Updated API contract and generated client.\n");
  } else {
    await Promise.all(
      ["openapi.json", "src/generated"].map(async (relative) => {
        try {
          await cp(
            path.join(packageRoot, relative),
            path.join(currentRoot, relative),
            {
              recursive: true,
            }
          );
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      })
    );
    const changed = await compareArtifactTrees(expectedRoot, currentRoot);
    if (changed.length) {
      throw new Error(`API client drift: ${changed.join(", ")}`);
    }
    process.stdout.write("API contract and generated client are current.\n");
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
