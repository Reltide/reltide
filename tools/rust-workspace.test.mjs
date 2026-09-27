import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { test } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const nx = path.resolve(workspaceRoot, "node_modules/.bin/nx");

const nxJson = (...args) =>
  JSON.parse(
    execFileSync(nx, args, {
      cwd: workspaceRoot,
      encoding: "utf-8",
    })
  );

const affectedBy = (file) =>
  new Set(
    nxJson("show", "projects", "--affected", `--files=${file}`, "--json")
  );

test("Nx tracks the Cargo crate and generated client dependencies", () => {
  const { nodes, dependencies } = nxJson("graph", "--print").graph;

  for (const project of [
    "reltide-domain",
    "reltide-api",
    "reltide-worker",
    "@repo/api-client",
  ]) {
    assert.ok(nodes[project], `${project} is missing from the Nx graph`);
  }

  for (const [source, target] of [
    ["reltide-api", "reltide-domain"],
    ["reltide-worker", "reltide-domain"],
    ["@repo/api-client", "reltide-api"],
    ["app", "@repo/api-client"],
  ]) {
    assert.ok(
      dependencies[source].some((dependency) => dependency.target === target),
      `${source} should depend on ${target}`
    );
  }
});

test("a domain change affects both Rust services and the generated client", () => {
  const affected = affectedBy("crates/domain/src/lib.rs");

  for (const project of [
    "reltide-domain",
    "reltide-api",
    "reltide-worker",
    "@repo/api-client",
  ]) {
    assert.ok(affected.has(project), `${project} should be affected`);
  }
});

test("an API source change affects the client and dashboard", () => {
  const affected = affectedBy("apps/api/src/lib.rs");
  for (const project of ["reltide-api", "@repo/api-client", "app"]) {
    assert.ok(affected.has(project), `${project} should be affected`);
  }
});

test.each([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "clippy.toml",
  ".clippy.toml",
])("%s changes affect the Rust graph", (file) => {
  const affected = affectedBy(file);

  for (const project of [
    "reltide-domain",
    "reltide-api",
    "reltide-worker",
    "@repo/api-client",
  ]) {
    assert.ok(affected.has(project), `${file} should affect ${project}`);
  }
});
