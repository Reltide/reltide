import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { test } from "vitest";

import { getApiStatus } from "./api-status";

const startServer = async (status: number, body: { status: string }) => {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: A listening TCP server bound to IPv4 has an AddressInfo address.
  const { port } = server.address() as AddressInfo;
  return {
    close: () => server[Symbol.asyncDispose](),
    url: `http://127.0.0.1:${port}`,
  };
};

test("an unset API URL is explicitly unconfigured", async () => {
  assert.deepEqual(await getApiStatus(), { kind: "unconfigured" });
});

test("the generated operation reports a healthy local API", async () => {
  const server = await startServer(200, { status: "ok" });
  try {
    assert.deepEqual(await getApiStatus(server.url), { kind: "available" });
  } finally {
    await server.close();
  }
});

test("HTTP errors and unexpected success bodies are unavailable", async () => {
  const errorServer = await startServer(503, { status: "ok" });
  try {
    assert.deepEqual(await getApiStatus(errorServer.url), {
      kind: "unavailable",
    });
  } finally {
    await errorServer.close();
  }
  const malformedServer = await startServer(200, { status: "degraded" });
  try {
    assert.deepEqual(await getApiStatus(malformedServer.url), {
      kind: "unavailable",
    });
  } finally {
    await malformedServer.close();
  }
});

test("invalid and unreachable API URLs are unavailable", async () => {
  await Promise.all(
    [":::bad", "file:///etc/passwd", "http://127.0.0.1:1"].map(async (url) => {
      assert.deepEqual(await getApiStatus(url), { kind: "unavailable" });
    })
  );
});
