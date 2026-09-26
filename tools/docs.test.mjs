import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, test } from "vitest";

const { dirname, join } = path;
const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "reltide-docs-"));
  fixtures.push(directory);
  const docs = join(directory, "apps/docs");
  mkdirSync(join(docs, "content/docs"), { recursive: true });
  for (const folder of ["lib", "scripts", "app"]) {
    if (existsSync(join(root, "apps/docs", folder))) {
      cpSync(join(root, "apps/docs", folder), join(docs, folder), {
        recursive: true,
      });
    }
  }
  writeFileSync(join(docs, "package.json"), '{"type":"module"}');
  symlinkSync(join(root, "apps/docs/node_modules"), join(docs, "node_modules"));
  const schema = join(directory, "packages/api-client/openapi.json");
  mkdirSync(dirname(schema), { recursive: true });
  cpSync(join(root, "packages/api-client/openapi.json"), schema);
  writeFileSync(
    join(docs, "content/docs/index.mdx"),
    "---\ntitle: Fixture\n---\n\n## Real heading\n\n[Valid](/docs#real-heading)\n"
  );
  return { docs, schema };
};

const run = (docs, script) =>
  spawnSync(process.execPath, [join(docs, "scripts", script)], {
    cwd: docs,
    encoding: "utf-8",
    timeout: 30_000,
  });

const assertSuccess = (result) =>
  assert.equal(
    result.status,
    0,
    result.error?.message ?? result.stderr + result.stdout
  );

test("generates health and removes stale operations", () => {
  const { docs, schema } = fixture();
  assertSuccess(run(docs, "prepare-content.mjs"));
  const output = join(docs, "content/docs/reference/generated");
  assert.match(
    readFileSync(join(output, "getHealth.mdx"), "utf-8"),
    /\/api\/v1\/health/u
  );
  const document = JSON.parse(readFileSync(schema, "utf-8"));
  document.paths["/api/v1/other"] = {
    get: { ...document.paths["/api/v1/health"].get, operationId: "getOther" },
  };
  writeFileSync(schema, JSON.stringify(document));
  assertSuccess(run(docs, "prepare-content.mjs"));
  assert.ok(existsSync(join(output, "getOther.mdx")));
  delete document.paths["/api/v1/other"];
  writeFileSync(schema, JSON.stringify(document));
  assertSuccess(run(docs, "prepare-content.mjs"));
  assert.ok(!existsSync(join(output, "getOther.mdx")));
});

test("rejects missing and malformed schemas", () => {
  const { docs, schema } = fixture();
  rmSync(schema);
  const missing = run(docs, "prepare-content.mjs");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /openapi\.json/u);
  writeFileSync(schema, "{ invalid JSON");
  const malformed = run(docs, "prepare-content.mjs");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /JSON|SyntaxError/u);
  writeFileSync(schema, JSON.stringify({ arbitrary: "not OpenAPI" }));
  const invalid = run(docs, "prepare-content.mjs");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /OpenAPI/u);
});

test("validates routes and heading fragments", () => {
  const { docs } = fixture();
  assertSuccess(run(docs, "prepare-content.mjs"));
  const index = join(docs, "content/docs/index.mdx");
  const valid = readFileSync(index, "utf-8");
  writeFileSync(
    index,
    `${valid}\n[Health](/docs/reference/generated/getHealth)\n`
  );
  assertSuccess(run(docs, "check-links.mjs"));
  writeFileSync(index, `${valid}\n[Missing route](/docs/missing)\n`);
  const route = run(docs, "check-links.mjs");
  assert.notEqual(route.status, 0);
  assert.match(route.stdout + route.stderr, /\/docs\/missing/u);
  writeFileSync(index, `${valid}\n[Missing heading](/docs#missing-heading)\n`);
  const anchor = run(docs, "check-links.mjs");
  assert.notEqual(anchor.status, 0);
  assert.match(anchor.stdout + anchor.stderr, /missing-heading/u);
  writeFileSync(index, `${valid}\n[Same-page missing](#missing-heading)\n`);
  const samePage = run(docs, "check-links.mjs");
  assert.notEqual(samePage.status, 0);
  assert.match(samePage.stdout + samePage.stderr, /missing-heading/u);
});
