import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "apps/docs");
const temporary = await mkdtemp(
  path.join(tmpdir(), "reltide-docs-standalone-")
);
let child;
let output = "";

try {
  await cp(path.join(source, ".next/standalone"), temporary, {
    recursive: true,
  });
  const docs = path.join(temporary, "apps/docs");
  await cp(path.join(source, ".next/static"), path.join(docs, ".next/static"), {
    recursive: true,
  });
  if (await stat(path.join(source, "public")).catch(() => null)) {
    await cp(path.join(source, "public"), path.join(docs, "public"), {
      recursive: true,
    });
  }

  const reservation = createServer();
  const listening = once(reservation, "listening");
  reservation.listen(0, "127.0.0.1");
  await listening;
  const { port } = reservation.address();
  const closed = once(reservation, "close");
  reservation.close();
  await closed;
  child = spawn(process.execPath, [path.join(docs, "server.js")], {
    cwd: temporary,
    env: {
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PATH: path.dirname(process.execPath),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    output = (output + chunk).slice(-10_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const origin = `http://127.0.0.1:${port}`;
  const request = (pathname) =>
    fetch(`${origin}${pathname}`, { signal: AbortSignal.timeout(5000) });
  const deadline = Date.now() + 20_000;
  const waitForServer = async () => {
    assert.equal(child.exitCode, null, output);
    try {
      const response = await request("/docs");
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting; the deadline bounds connection retries.
    }
    assert.ok(
      Date.now() < deadline,
      `Standalone startup timed out:\n${output}`
    );
    await delay(100);
    return waitForServer();
  };
  await waitForServer();

  await Promise.all(
    [
      "product-scope",
      "local-setup",
      "repository-permissions",
      "verification",
      "review-limits",
      "reference",
    ].map(async (slug) => {
      const response = await request(`/docs/${slug}`);
      assert.equal(response.status, 200, slug);
    })
  );
  const health = await request("/docs/reference/generated/getHealth");
  assert.equal(health.status, 200, output);
  const html = await health.text();
  assert.match(html, /api\/v1\/health/u);
  assert.match(html, /Process is healthy/u);
  const missing = await request("/docs/does-not-exist");
  assert.equal(missing.status, 404);
  const search = await request("/api/search?query=health");
  assert.equal(search.status, 200, output);
  assert.ok(
    JSON.stringify(await search.json()).includes(
      "/docs/reference/generated/getHealth"
    )
  );

  const assets = new Set(
    [
      ...html.matchAll(
        /(?:src|href)="(?<url>[^" ]*\/_next\/static\/[^" ]*)"/gu
      ),
    ].map((match) => match[1])
  );
  assert.ok(assets.size > 0, "Expected standalone CSS/JS assets");
  await Promise.all(
    [...assets].map(async (asset) => {
      const response = await request(asset);
      assert.equal(response.status, 200, asset);
    })
  );
  process.stdout.write(
    "Standalone docs: guides, health reference, search, 404, and static assets passed.\n"
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  await rm(temporary, { force: true, recursive: true });
}
