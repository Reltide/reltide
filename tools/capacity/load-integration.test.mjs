import assert from "node:assert/strict";

import { test } from "vitest";

import { runProcess } from "./load-integration.mjs";

test("subprocess failure retains already accepted workflow evidence", async () => {
  const lines = [];
  await assert.rejects(
    runProcess({
      args: [
        "-e",
        'process.stdout.write(JSON.stringify({event:"started",workflow_id:"owned-workflow",temporal_run_id:"owned-run"})+"\\n");process.exitCode=1',
      ],
      env: process.env,
      onLine: (line) => lines.push(JSON.parse(line)),
      program: process.execPath,
    })
  );
  assert.deepEqual(lines, [
    {
      event: "started",
      temporal_run_id: "owned-run",
      workflow_id: "owned-workflow",
    },
  ]);
});
test("subprocess output persistence fails closed", async () => {
  await assert.rejects(
    runProcess({
      args: [
        "-e",
        'process.stdout.write("accepted\\n");setTimeout(()=>{},1000)',
      ],
      env: process.env,
      onLine: () => {
        throw new Error("evidence unavailable");
      },
      program: process.execPath,
    }),
    /evidence unavailable/u
  );
});

test("failed persistence waits for owned subprocess cleanup even when SIGTERM is ignored", async () => {
  let pid;
  try {
    await assert.rejects(
      runProcess({
        args: [
          "-e",
          'process.on("SIGTERM",()=>{});process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000)',
        ],
        env: process.env,
        onLine: (line) => {
          pid = Number(line);
          throw new Error("persistence failed");
        },
        program: process.execPath,
        timeout_ms: 1000,
      })
    );
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* The owned process has already exited. */
      }
    }
  }
});
