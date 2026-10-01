import assert from "node:assert/strict";

import { test, vi } from "vitest";

import { runProcess, verifyRemoteCleanup } from "./load-integration.mjs";
import { runLoad } from "./load.mjs";

test("remote cleanup evidence survives failed acknowledgement without claiming cancellation", async () => {
  const failure = new Error("required acknowledgement failed");
  const events = [];
  await assert.rejects(
    verifyRemoteCleanup({
      evidence: {
        backend_gone: true,
        backend_pid: 42,
        cancelled: false,
        query_outcome: "failed",
      },
      failure,
      fixture: { observe: () => ({ data: [{ query_id: "unrelated-query" }] }) },
      observed: [{ elapsed: 0.5, query_id: "owned-query" }],
      persist: (event) => events.push(event),
    }),
    (error) => error === failure
  );
  assert.deepEqual(events, [
    {
      backend_gone: true,
      backend_pid: 42,
      cancelled: false,
      cleanup_failure: null,
      kind: "guard_cleanup",
      permit_released_after_cleanup: false,
      query_outcome: "failed",
      remote_cleanup_verified: true,
      remote_observed: [{ elapsed: 0.5, query_id: "owned-query" }],
      remote_remaining: 0,
    },
  ]);
});

test("failed remote observation records cleanup failure and preserves acknowledgement failure", async () => {
  const failure = new Error("required acknowledgement failed");
  const events = [];
  await assert.rejects(
    verifyRemoteCleanup({
      evidence: {
        backend_gone: true,
        backend_pid: 42,
        cancelled: false,
        query_outcome: "failed",
      },
      failure,
      fixture: {
        observe: () => {
          throw new Error("secret remote connection details");
        },
      },
      observed: [{ query_id: "owned-query" }],
      persist: (event) => events.push(event),
    }),
    (error) => error === failure
  );
  assert.equal(events[0].cleanup_failure, "remote_observation_failed");
  assert.equal(events[0].remote_cleanup_verified, false);
  assert.equal(events[0].permit_released_after_cleanup, false);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("remote absence is not observed before verified reader cleanup", async () => {
  const failure = new Error("required acknowledgement failed");
  const events = [];
  let observations = 0;
  await assert.rejects(
    verifyRemoteCleanup({
      evidence: {
        backend_gone: false,
        backend_pid: 42,
        cancelled: false,
        query_outcome: "failed",
      },
      failure,
      fixture: {
        observe: () => {
          observations += 1;
          return { data: [] };
        },
      },
      observed: [{ query_id: "owned-query" }],
      persist: (event) => events.push(event),
    }),
    (error) => error === failure
  );
  assert.equal(observations, 0);
  assert.equal(events[0].cleanup_failure, "reader_cleanup_unverified");
  assert.equal(events[0].backend_gone, false);
  assert.equal(events[0].remote_cleanup_verified, false);
});

test("invalid diagnostics preserve acknowledgement failure and only record sanitized outcomes", async () => {
  const failure = new Error("required acknowledgement failed");
  const events = [];
  await assert.rejects(
    verifyRemoteCleanup({
      evidence: {
        backend_gone: true,
        backend_pid: 42,
        cancelled: false,
        query_outcome: "secret unexpected diagnostic",
      },
      failure,
      fixture: { observe: () => ({ data: [] }) },
      observed: [{ query_id: "owned-query" }],
      persist: (event) => events.push(event),
    }),
    (error) => error === failure
  );
  assert.equal(events[0].query_outcome, "unavailable");
  assert.equal(events[0].cleanup_failure, "diagnostic_invalid");
  assert.equal(events[0].backend_gone, true);
  assert.equal(events[0].remote_cleanup_verified, false);
  assert.equal(events[0].permit_released_after_cleanup, false);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("remaining same-query work records failed cleanup without hiding acknowledgement failure", async () => {
  const failure = new Error("required acknowledgement failed");
  const events = [];
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(10_000);
  try {
    await assert.rejects(
      verifyRemoteCleanup({
        evidence: {
          backend_gone: true,
          backend_pid: 42,
          cancelled: false,
          query_outcome: "failed",
        },
        failure,
        fixture: { observe: () => ({ data: [{ query_id: "owned-query" }] }) },
        observed: [{ query_id: "owned-query" }],
        persist: (event) => events.push(event),
      }),
      (error) => error === failure
    );
  } finally {
    now.mockRestore();
  }
  assert.equal(events[0].cleanup_failure, "remote_query_remains");
  assert.equal(events[0].remote_remaining, 1);
  assert.equal(events[0].remote_cleanup_verified, false);
  assert.equal(events[0].permit_released_after_cleanup, false);
});

test("acknowledged cancellation still requires remote absence before successful permit release", async () => {
  const events = [];
  const result = await verifyRemoteCleanup({
    evidence: {
      backend_gone: true,
      backend_pid: 42,
      cancelled: true,
      query_outcome: "cancelled",
    },
    fixture: { observe: () => ({ data: [] }) },
    observed: [{ query_id: "owned-query" }],
    persist: (event) => events.push(event),
  });
  assert.equal(result.remote_cleanup_verified, true);
  assert.equal(result.permit_released_after_cleanup, true);
  assert.equal(events[0].remote_remaining, 0);
});

test("admitted workflow subprocess drains started and completed evidence after lane failure", async () => {
  const http = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const events = [];
  const clients = {
    analytics: () => {},
    emit: (event) => {
      events.push(event);
      if (event.kind === "http" && event.outcome === "failed") {
        failed.resolve();
      }
    },
    http: () => http.promise,
    requests: { api: ["p"], app: ["a"], docs: ["d"], web: ["w"] },
    search: () => {},
    telemetry: () => ({ accepted: 10 }),
    workflow: async ({ emit }, signal) => {
      signal.throwIfAborted();
      // Match the real workflow adapter: only admission checks the signal.
      // Accepted workflow children must finish and persist their result.
      const output = await runProcess({
        args: [
          "-e",
          'const emit=(event)=>console.log(JSON.stringify({event,workflow_id:"owned-workflow",temporal_run_id:"owned-run",pid:process.pid}));process.on("SIGUSR1",()=>{emit("completed");process.exit(0)});emit("started");setInterval(()=>{},1000)',
        ],
        env: process.env,
        onLine: async (line) => {
          const event = JSON.parse(line);
          await emit({ ...event, kind: `workflow_${event.event}` });
          if (event.event === "started") {
            http.reject(new Error("HTTP failed"));
            await failed.promise;
            assert.equal(signal.aborted, true);
            process.kill(event.pid, "SIGUSR1");
          }
        },
        program: process.execPath,
        timeout_ms: 1000,
      });
      return { output };
    },
  };
  await assert.rejects(
    runLoad(
      { duration_ms: 1000, http_rps: 1, name: "workflow-drain" },
      clients,
      new AbortController().signal
    ),
    /HTTP failed/u
  );
  assert.deepEqual(
    events
      .filter((event) => event.kind.startsWith("workflow_"))
      .map((event) => [event.event, event.workflow_id, event.temporal_run_id]),
    [
      ["started", "owned-workflow", "owned-run"],
      ["completed", "owned-workflow", "owned-run"],
    ]
  );
  assert.equal(
    events
      .find(
        (event) => event.kind === "workflow" && event.outcome === "completed"
      )
      ?.output.includes('"event":"completed"'),
    true
  );
});

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
