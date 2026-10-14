import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { MigrationReport } from "@repo/api-client";
import { test } from "vitest";

import { getMigrationReport } from "./migration-report";

const report: MigrationReport = {
  blockers: [
    {
      kind: "independent_review_missing",
      reason: "Independent review pending",
    },
  ],
  checks: [],
  created_at_unix_ms: 1_791_989_248_655,
  fixture: "fixtures/stripe-migration",
  generated_diff: "",
  plan: {
    blockers: [
      {
        kind: "independent_review_missing",
        reason: "Independent review pending",
      },
    ],
    edits: [{ original: "old", path: "before/src/client.ts", updated: "new" }],
    evidence: [
      {
        immutable: false,
        title: "Provider change",
        url: "https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent",
      },
    ],
    findings: [
      {
        disposition: "migrate",
        file: "before/src/client.ts",
        line: 5,
        reason: "Explicit target",
      },
    ],
    scope: "explicit_target_only",
    source_api_version: "2022-08-01",
    source_sdk_version: "10.17.0",
    target_api_version: "2022-11-15",
    target_sdk_version: "12.0.0",
  },
  pr_preview: "Publication held",
  schema_version: 1,
  source_fingerprints: [
    { path: "before/src/client.ts", sha256: "a".repeat(64) },
  ],
  verification_status: "not_run",
};

const startServer = async (status: number, body: string, delay = false) => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/migrations/latest") {
      response.writeHead(404).end();
      return;
    }
    if (!delay) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: The listening IPv4 server exposes a TCP AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    url: `http://127.0.0.1:${port}`,
  };
};

test("absent configuration is unconfigured", async () => {
  assert.deepEqual(await getMigrationReport(), { kind: "unconfigured" });
});

test("a 404 report is empty", async () => {
  const server = await startServer(
    404,
    '{"error":"migration_report_not_found"}'
  );
  try {
    assert.deepEqual(await getMigrationReport(server.url), { kind: "empty" });
  } finally {
    await server.close();
  }
});

test("valid 200 data is retained without promoting its local or publication status", async () => {
  const server = await startServer(200, JSON.stringify(report));
  try {
    assert.deepEqual(await getMigrationReport(`${server.url}/`), {
      kind: "available",
      report,
    });
  } finally {
    await server.close();
  }
});

test("a refused request is unavailable", async () => {
  const server = await startServer(200, JSON.stringify(report));
  await server.close();
  assert.deepEqual(await getMigrationReport(server.url), {
    kind: "unavailable",
  });
});

test("malformed, missing, and incomplete bodies are unavailable", async () => {
  await Promise.all(
    [
      "{",
      "",
      "null",
      "{}",
      JSON.stringify({ ...report, plan: null }),
      JSON.stringify({ ...report, checks: [{}] }),
    ].map(async (body) => {
      const server = await startServer(200, body);
      try {
        assert.deepEqual(await getMigrationReport(server.url), {
          kind: "unavailable",
        });
      } finally {
        await server.close();
      }
    })
  );
});

test("a 503 report is unavailable", async () => {
  const server = await startServer(
    503,
    '{"error":"migration_report_unavailable"}'
  );
  try {
    assert.deepEqual(await getMigrationReport(server.url), {
      kind: "unavailable",
    });
  } finally {
    await server.close();
  }
});

test("invalid and non-HTTP base URLs are unavailable", async () => {
  await Promise.all(
    [":::bad", "file:///etc/passwd"].map(async (baseUrl) => {
      assert.deepEqual(await getMigrationReport(baseUrl), {
        kind: "unavailable",
      });
    })
  );
});

test("a request with no response times out as unavailable", async () => {
  const server = await startServer(200, "", true);
  try {
    assert.deepEqual(await getMigrationReport(server.url), {
      kind: "unavailable",
    });
  } finally {
    await server.close();
  }
});
