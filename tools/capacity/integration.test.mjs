import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";

import { test } from "vitest";

import {
  verifyDeploymentIdentity,
  verifyRuntimeIdentity,
  verifyOwnership,
  verifyServiceState,
  verifyTcpListener,
} from "./integration.mjs";

test("local runtime must match the config in both exported archives", () => {
  assert.throws(
    () =>
      verifyRuntimeIdentity(
        { config_digest: `sha256:${"a".repeat(64)}` },
        `sha256:${"b".repeat(64)}`
      ),
    /identity/u
  );
});
test("a similarly named Docker resource without exact labels is rejected", () => {
  assert.throws(
    () => verifyOwnership({ Labels: {}, Name: "reltide-capacity" }, "test-1"),
    /ownership/u
  );
  assert.throws(
    () =>
      verifyOwnership(
        {
          Labels: { "com.reltide.capacity.run": "other" },
          Name: "reltide-capacity",
        },
        "test-1"
      ),
    /ownership/u
  );
});

test("deployment requires manifest identity after OCI import, not a local config ID", () => {
  const artifact = {
    config_digest: `sha256:${"b".repeat(64)}`,
    oci_manifest_digest: `sha256:${"a".repeat(64)}`,
  };
  assert.throws(
    () => verifyDeploymentIdentity(artifact, artifact.config_digest),
    /deployment/u
  );
  verifyDeploymentIdentity(artifact, artifact.oci_manifest_digest);
});

test("unhealthy real service endpoints stop integration even without OOM or exit", () => {
  assert.throws(
    () =>
      verifyServiceState({
        Name: "hyperdx",
        RestartCount: 0,
        State: { Health: { Status: "unhealthy" }, Status: "running" },
      }),
    /health/u
  );
});
test("OpAMP listener probe requires an accepting TCP socket", async () => {
  const server = createServer((socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await verifyTcpListener("127.0.0.1", address.port);
  } finally {
    server.close();
    await once(server, "close");
  }
  await assert.rejects(() => verifyTcpListener("127.0.0.1", address.port));
});
