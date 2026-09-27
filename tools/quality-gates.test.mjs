import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const nx = path.join(workspaceRoot, "node_modules/.bin/nx");
const nxJson = (...args) =>
  JSON.parse(execFileSync(nx, args, { cwd: workspaceRoot, encoding: "utf-8" }));

test("the Node runtime agrees with both committed version pins", () => {
  const pinnedVersion = readFileSync(
    path.join(workspaceRoot, ".node-version"),
    "utf-8"
  ).trim();
  const { engines } = JSON.parse(
    readFileSync(path.join(workspaceRoot, "package.json"), "utf-8")
  );

  assert.equal(
    engines.node.replace(/^v/u, ""),
    pinnedVersion,
    "package.json engines.node and .node-version must select the same Node release"
  );
  assert.equal(
    process.versions.node,
    pinnedVersion,
    "Run checks with the Node release pinned in .node-version"
  );
});

test.each([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "nx.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "oxlint.config.ts",
  "oxfmt.config.ts",
  "vitest.config.mjs",
  "tools/rust-workspace.test.mjs",
  "tools/api-client.test.mjs",
  "tools/docs.test.mjs",
  "tools/docs-standalone.mjs",
  ".github/workflows/ci.yml",
  "renovate.json",
  "infra/containers/api/Dockerfile",
])("%s invalidates every platform application and crate", (file) => {
  const affected = new Set(
    nxJson("show", "projects", "--affected", `--files=${file}`, "--json")
  );
  for (const project of [
    "app",
    "web",
    "docs",
    "@repo/api-client",
    "reltide-api",
    "reltide-worker",
    "reltide-domain",
  ]) {
    assert.ok(affected.has(project), `${file} should affect ${project}`);
  }
});

test.each([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  "apps/api/Cargo.toml",
  "apps/api/src/lib.rs",
  "packages/api-client/scripts/contract.mjs",
  "packages/api-client/openapi.json",
  "packages/api-client/src/generated/sdk.gen.ts",
])("%s invalidates the client, dashboard, and documentation", (file) => {
  const affected = new Set(
    nxJson("show", "projects", "--affected", `--files=${file}`, "--json")
  );
  for (const project of ["@repo/api-client", "app", "docs"]) {
    assert.ok(affected.has(project), `${file} should affect ${project}`);
  }
});

test("an API change schedules client drift, docs links, smoke, and frontend checks", () => {
  const { tasks: taskGraph } = nxJson(
    "affected",
    "-t",
    "build,typecheck,check-contract,check-links,smoke",
    "--files=apps/api/src/lib.rs",
    "--exclude=stripe-payment-intent-before,stripe-payment-intent-after",
    "--graph=stdout"
  );
  for (const id of [
    "reltide-api:build",
    "@repo/api-client:check-contract",
    "@repo/api-client:typecheck",
    "app:build",
    "app:typecheck",
    "docs:build",
    "docs:typecheck",
    "docs:check-links",
    "docs:smoke",
  ]) {
    assert.ok(taskGraph.tasks[id], `${id} is missing from affected checks`);
  }
});
