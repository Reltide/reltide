import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";

import { test, vi } from "vitest";

import {
  accountTelemetry,
  createTelemetryIngestor,
  createSteadyTelemetry,
  encodeOtlp,
  telemetryEvent,
  createForegroundPermit,
  discoverRequests,
  runLoad,
  seedAnalyticsFixture,
  seedTelemetry,
  workload,
} from "./load.mjs";

const seed = {
  batch: 256,
  epoch_ms: 1_800_000_000_000,
  rate: 200,
  run_id: "load-test",
};
const clock = () => {
  let value = 0;
  return {
    now: () => value,
    sleep: (ms) => {
      value += ms;
    },
  };
};
const collect = async () => {
  const batches = [];
  const time = clock();
  const counts = await seedTelemetry(
    { ...seed, ...time },
    600,
    (batch) => {
      batches.push({ ...batch, accepted_at: undefined });
      return { accepted: batch.events.length };
    },
    new AbortController().signal
  );
  return { batches, counts };
};
test("seed_is_repeatable_and_bounded", async () => {
  const a = await collect();
  assert.deepEqual(a, await collect());
  assert.equal(a.counts.submitted, 600);
  assert.equal(a.counts.stored, 0);
  assert.ok(
    a.batches.every(
      (b) =>
        b.events.length <= 256 &&
        b.events.every((e) => Buffer.byteLength(e.payload) <= 1024)
    )
  );
  assert.ok(a.counts.elapsed_ms >= 3000);
});
test("splits_logs_and_traces_equally", async () => {
  const counts = await seedTelemetry(
    { ...seed, ...clock() },
    518,
    (b) => ({ accepted: b.events.length }),
    new AbortController().signal
  );
  assert.equal(counts.logs, 259);
  assert.equal(counts.traces, 259);
  assert.equal(workload.seed.current_events, 2_592_000);
  assert.equal(workload.seed.aged_events, 25_920);
});
test("expired_rows_are_not_drops", () => {
  assert.deepEqual(
    accountTelemetry({
      accepted: 10,
      expired: 2,
      service_generated: 17,
      stored: 8,
    }),
    {
      accepted: 10,
      dropped: 0,
      expired: 2,
      pending: 0,
      service_generated: 17,
      stored: 8,
    }
  );
});
test("accepted_queue_rows_are_not_stored_rows", () => {
  assert.deepEqual(
    accountTelemetry({
      accepted: 10,
      expired: 0,
      service_generated: 0,
      stored: 0,
    }),
    {
      accepted: 10,
      dropped: 0,
      expired: 0,
      pending: 10,
      service_generated: 0,
      stored: 0,
    }
  );
  assert.throws(() =>
    accountTelemetry({
      accepted: 1,
      expired: 0,
      service_generated: 0,
      stored: 2,
    })
  );
});
test("cancellation_stops_new_submissions", async () => {
  const stop = new AbortController();
  let calls = 0;
  const counts = await seedTelemetry(
    { ...seed, ...clock() },
    1000,
    (b) => {
      calls += 1;
      stop.abort();
      return { accepted: b.events.length };
    },
    stop.signal
  );
  assert.equal(calls, 1);
  assert.equal(counts.submitted, 200);
});
test("foreground search and analytics share one permit", async () => {
  const permit = createForegroundPermit();
  let active = 0;
  let maximum = 0;
  const task = () =>
    permit(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await immediate();
      active -= 1;
    }, new AbortController().signal);
  await Promise.all([task(), task(), task()]);
  assert.equal(maximum, 1);
});
test("analytics fixture is one acknowledged 10000 row insert", async () => {
  let calls = 0;
  const result = await seedAnalyticsFixture(
    "load-test",
    (sql) => {
      calls += 1;
      assert.match(sql, /numbers\(10000\)/u);
      return { acknowledged: true };
    },
    new AbortController().signal
  );
  assert.equal(calls, 1);
  assert.equal(result.inserted_rows, 10_000);
  await assert.rejects(
    seedAnalyticsFixture(
      "load-test",
      () => ({ accepted: true }),
      new AbortController().signal
    )
  );
});
test("discovery freezes root and current production assets", async () => {
  const requests = await discoverRequests(
    {
      api: "https://api.invalid/health",
      app: "https://app.invalid",
      docs: "https://docs.invalid",
      web: "https://web.invalid",
    },
    () =>
      new Response(
        '<script src="/_next/static/chunks/a.js"></script><link href="/_next/static/a.css"><a href="/other">x</a>'
      )
  );
  assert.equal(requests.app.length, 3);
  assert.ok(Object.isFrozen(requests));
  assert.ok(Object.isFrozen(requests.app));
  assert.deepEqual(requests.api, ["https://api.invalid/health"]);
});
test("phase accounts warmups and preserves workflow IDs with bounded queue", async () => {
  const time = clock();
  const events = [];
  let workflows = 0;
  const result = await runLoad(
    { duration_ms: 20_000, http_rps: 1, name: "short" },
    {
      ...time,
      analytics: () => ({ outcome: "completed" }),
      emit: (e) => events.push(e),
      http: () => ({ outcome: "completed" }),
      requests: { api: ["p"], app: ["a"], docs: ["d"], web: ["w"] },
      search: () => ({ outcome: "completed" }),
      telemetry: () => ({ accepted: 10 }),
      workflow: async ({ emit }) => {
        workflows += 1;
        await emit({
          kind: "workflow_started",
          workflow_id: `wf-${workflows}`,
        });
        await emit({
          kind: "workflow_completed",
          workflow_id: `wf-${workflows}`,
        });
        return { outcome: "completed" };
      },
    },
    new AbortController().signal
  );
  assert.equal(result.http, 20);
  assert.equal(workflows, 2);
  assert.equal(result.queue_pending_max, 1);
  assert.equal(events.filter((e) => e.kind === "workflow_started").length, 2);
  assert.equal(events.filter((e) => e.kind === "workflow_completed").length, 2);
  assert.equal(result.telemetry_accepted, 200);
});
test("phase fails if a completed lane failed before phase end", async () => {
  const time = clock();
  await assert.rejects(
    runLoad(
      { duration_ms: 1000, http_rps: 1, name: "failed" },
      {
        ...time,
        analytics: async () => {},
        emit: async () => {},
        http: () => {
          throw new Error("HTTP failed");
        },
        requests: { api: ["p"], app: ["a"], docs: ["d"], web: ["w"] },
        search: async () => {},
        telemetry: () => ({ accepted: 10 }),
        workflow: async () => {},
      },
      new AbortController().signal
    )
  );
});
test("telemetry event times progress with bounded seed rate", async () => {
  const batches = [];
  await seedTelemetry(
    { ...seed, ...clock() },
    400,
    (b) => {
      batches.push(b);
      return { accepted: b.events.length };
    },
    new AbortController().signal
  );
  assert.equal(
    batches[1].events[0].event_time_ms - batches[0].events[0].event_time_ms,
    1000
  );
});
test("guard cancellation cannot hide failed analytics cleanup", async () => {
  const stop = new AbortController();
  const time = clock();
  await assert.rejects(
    runLoad(
      { duration_ms: 1000, http_rps: 1, name: "cleanup-fails" },
      {
        ...time,
        analytics: () => {
          stop.abort();
          throw new Error("backend remains");
        },
        emit: async () => {},
        http: async () => {},
        requests: { api: ["p"], app: ["a"], docs: ["d"], web: ["w"] },
        search: async () => {},
        telemetry: () => ({ accepted: 10 }),
        workflow: async () => {},
      },
      stop.signal
    )
  );
});

test("partial collector acknowledgement preserves accepted rows without claiming storage", async () => {
  const events = [];
  const batch = {
    accepted_at: new Date().toISOString(),
    events: Array.from({ length: 10 }, (_, index) =>
      telemetryEvent(seed, index + 1)
    ),
  };
  const submit = createTelemetryIngestor({
    ingest: () => Response.json({ partialSuccess: { rejectedLogRecords: 2 } }),
    persist: (event) => events.push(event),
  });
  await assert.rejects(submit(batch, new AbortController().signal));
  assert.equal(events[0].accepted, 3);
  assert.equal(events[0].rejected, 2);
  assert.equal(events[0].stored, 0);
});
test("steady ingestion admission is independent of bounded storage verification", async () => {
  const pending = createSteadyTelemetry({
    foreground: createForegroundPermit(),
    ingest: () => new Response("{}"),
    now: () => 1_800_000_000_000,
    persist: () => {},
    seed,
  });
  /* eslint-disable no-await-in-loop -- Fill the bounded queue serially to prove it cannot grow without storage verification. */
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await pending.submit(new AbortController().signal), {
      accepted: 10,
      stored: 0,
    });
  }
  /* eslint-enable no-await-in-loop */
  assert.equal(pending.pending(), 20);
  await assert.rejects(pending.submit(new AbortController().signal));
});
test("OTLP carries deterministic identifiers and distinct signal shapes", () => {
  const log = telemetryEvent(seed, 1);
  const trace = telemetryEvent(seed, 2);
  assert.equal(
    encodeOtlp([log], "logs").resourceLogs[0].scopeLogs[0].logRecords[0].body
      .stringValue,
    log.payload
  );
  const [span] = encodeOtlp([trace], "traces").resourceSpans[0].scopeSpans[0]
    .spans;
  assert.equal(span.traceId, trace.id.slice(0, 32));
  assert.equal(span.spanId, trace.id.slice(32, 48));
  assert.equal(span.name, trace.payload);
});
test("a guarded queued foreground request never executes", async () => {
  const barrier = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const permit = createForegroundPermit();
  const stop = new AbortController();
  const first = permit(async () => {
    entered.resolve();
    await barrier.promise;
  }, stop.signal);
  await entered.promise;
  let called = false;
  const queued = permit(() => {
    called = true;
  }, stop.signal);
  const rejected = assert.rejects(queued);
  stop.abort();
  barrier.resolve();
  await first;
  await rejected;
  assert.equal(called, false);
});

test("seed does not catch up with bursts after a delayed batch", async () => {
  const time = clock();
  const submitted = [];
  await seedTelemetry(
    { ...seed, ...time },
    800,
    (batch) => {
      submitted.push(time.now());
      if (submitted.length === 1) {
        time.sleep(5000);
      }
      return { accepted: batch.events.length };
    },
    new AbortController().signal
  );
  assert.ok(submitted.slice(1).every((at, i) => at - submitted[i] >= 1000));
});

test("foreground failure prevents queued queries from using an unresolved reader", async () => {
  const permit = createForegroundPermit();
  let ran = false;
  const first = permit(() => {
    throw new Error("reader cleanup unresolved");
  });
  const next = permit(() => {
    ran = true;
  });
  await assert.rejects(first, /cleanup unresolved/u);
  await assert.rejects(next, /cleanup unresolved/u);
  assert.equal(ran, false);
});

test("ordinary expiry rejects changed TTLs or pending/new mutations", async () => {
  const { verifyUnchangedRetention } = await import("./load.mjs");
  const baseline = {
    mutations: [{ is_done: 1, mutation_id: "old" }],
    ttls: [
      {
        ddl: "TTL toDateTime(Timestamp) + toIntervalDay(3)",
        table: "otel_logs",
      },
      {
        ddl: "TTL toDateTime(Timestamp) + toIntervalDay(3)",
        table: "otel_traces",
      },
    ],
  };
  verifyUnchangedRetention(baseline, structuredClone(baseline));
  assert.throws(() =>
    verifyUnchangedRetention(baseline, {
      ...baseline,
      mutations: [...baseline.mutations, { is_done: 1, mutation_id: "new" }],
    })
  );
  assert.throws(() =>
    verifyUnchangedRetention(
      { ...baseline, mutations: [{ is_done: 0, mutation_id: "old" }] },
      baseline
    )
  );
  assert.throws(() =>
    verifyUnchangedRetention(baseline, {
      ...baseline,
      ttls: baseline.ttls.map((row) => ({
        ...row,
        ddl: row.ddl.replace("Day(3)", "Day(4)"),
      })),
    })
  );
});

const expirySchemas = {
  logs: { attributes: "LogAttributes", table: "otel_logs" },
  traces: { attributes: "SpanAttributes", table: "otel_traces" },
};
test("boundary cohort uses the bounded ordinary expiry query path", async () => {
  const { waitNormalExpiry } = await import("./load.mjs");
  const queries = [];
  const result = await waitNormalExpiry({
    count: 2,
    persist: () => null,
    query: (sql) => {
      queries.push(sql);
      return { data: [{ rows: 0 }] };
    },
    schemas: expirySchemas,
    seed: { ...seed, cohort: "boundary" },
    signal: new AbortController().signal,
  });
  assert.equal(result.expired, 2);
  assert.equal(queries.length, 2);
  assert.ok(
    queries.every(
      (sql) =>
        sql.includes("'boundary'") && sql.includes("max_execution_time=5")
    )
  );
});
test("ordinary expiry cannot pass after its deadline", async () => {
  const { waitNormalExpiry } = await import("./load.mjs");
  let now = 0;
  const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    await assert.rejects(
      waitNormalExpiry({
        count: 2,
        deadline_ms: 1000,
        persist: () => null,
        query: () => {
          now = 2000;
          return { data: [{ rows: 0 }] };
        },
        schemas: expirySchemas,
        seed: { ...seed, cohort: "aged" },
        signal: new AbortController().signal,
      }),
      /deadline/u
    );
  } finally {
    clockSpy.mockRestore();
  }
});
