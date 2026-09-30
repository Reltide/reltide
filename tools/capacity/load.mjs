import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const workload = JSON.parse(
  await readFile(
    new URL("../../infra/capacity/workload.json", import.meta.url),
    "utf-8"
  )
);
const runPattern = /^[a-z0-9-]{1,64}$/u;
const sleep = async (ms, signal) => {
  if (ms > 0) {
    await delay(ms, undefined, { signal });
  }
};
const stopped = (signal) => signal?.aborted === true;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export const accountTelemetry = ({
  accepted,
  stored,
  expired,
  service_generated,
  dropped = 0,
}) => {
  for (const value of [accepted, stored, expired, service_generated, dropped]) {
    assert.ok(
      Number.isSafeInteger(value) && value >= 0,
      "invalid telemetry count"
    );
  }
  assert.ok(
    stored + expired + dropped <= accepted,
    "stored/expired/dropped exceeds accepted"
  );
  return {
    accepted,
    dropped,
    expired,
    pending: accepted - stored - expired - dropped,
    service_generated,
    stored,
  };
};

export const telemetryEvent = (seed, sequence) => {
  assert.match(seed.run_id, runPattern);
  const id = hash(`${seed.run_id}:${seed.cohort ?? "current"}:${sequence}`);
  const payload = JSON.stringify({
    cohort: seed.cohort ?? "current",
    id,
    run_id: seed.run_id,
    sequence,
  });
  assert.ok(Buffer.byteLength(payload) <= 1024);
  return {
    cohort: seed.cohort ?? "current",
    event_time_ms:
      seed.epoch_ms + Math.floor(((sequence - 1) * 1000) / (seed.rate ?? 200)),
    id,
    kind: sequence % 2 === 1 ? "logs" : "traces",
    payload,
    sequence,
  };
};

const otlpAttributes = (event) => [
  {
    key: "capacity.run_id",
    value: { stringValue: JSON.parse(event.payload).run_id },
  },
  { key: "capacity.sequence", value: { intValue: String(event.sequence) } },
  { key: "capacity.cohort", value: { stringValue: event.cohort } },
  { key: "capacity.id", value: { stringValue: event.id } },
];

export const encodeOtlp = (events, kind) => {
  const resource = {
    attributes: [
      { key: "service.name", value: { stringValue: "capacity-synthetic" } },
    ],
  };
  if (kind === "logs") {
    return {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              logRecords: events.map((event) => ({
                attributes: otlpAttributes(event),
                body: { stringValue: event.payload },
                severityNumber: 9,
                spanId: event.id.slice(32, 48),
                timeUnixNano: String(BigInt(event.event_time_ms) * 1_000_000n),
                traceId: event.id.slice(0, 32),
              })),
              scope: { name: "capacity" },
            },
          ],
        },
      ],
    };
  }
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: "capacity" },
            spans: events.map((event) => ({
              attributes: otlpAttributes(event),
              endTimeUnixNano: String(
                BigInt(event.event_time_ms) * 1_000_000n + 1_000_000n
              ),
              kind: 1,
              name: event.payload,
              spanId: event.id.slice(32, 48),
              startTimeUnixNano: String(
                BigInt(event.event_time_ms) * 1_000_000n
              ),
              status: { code: 1 },
              traceId: event.id.slice(0, 32),
            })),
          },
        ],
      },
    ],
  };
};

/** Submission acknowledgement is deliberately never counted as stored data. */
/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const seedTelemetry = async (seed, count, send, stop) => {
  const rate = seed.rate ?? workload.seed.events_per_second;
  const batch = Math.min(seed.batch ?? 256, rate);
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count % 2 === 0);
  assert.ok(Number.isSafeInteger(rate) && rate > 0 && rate <= 200);
  assert.ok(Number.isSafeInteger(batch) && batch > 0 && batch <= 256);
  const now = seed.now ?? performance.now.bind(performance);
  const wait = seed.sleep ?? sleep;
  const start = now();
  let previousSubmission = start;
  const counts = {
    accepted: 0,
    elapsed_ms: 0,
    logs: 0,
    rejected: 0,
    stored: 0,
    submitted: 0,
    traces: 0,
  };
  for (let offset = 0; offset < count && !stopped(stop); offset += batch) {
    const size = Math.min(batch, count - offset);
    try {
      await wait(
        Math.max(0, previousSubmission + (size * 1000) / rate - now()),
        stop
      );
    } catch (error) {
      if (!stopped(stop)) {
        throw error;
      }
    }
    if (stopped(stop)) {
      break;
    }
    const events = Array.from({ length: size }, (_, i) =>
      telemetryEvent(seed, offset + i + 1)
    );
    previousSubmission = now();
    const acceptedAt = new Date().toISOString();
    const response = await send(
      {
        accepted_at: acceptedAt,
        events,
        first_sequence: offset + 1,
        last_sequence: offset + size,
      },
      stop
    );
    assert.ok(
      Number.isSafeInteger(response.accepted) &&
        response.accepted >= 0 &&
        response.accepted <= size
    );
    counts.submitted += size;
    counts.accepted += response.accepted;
    counts.rejected += size - response.accepted;
    counts.logs += events.filter((event) => event.kind === "logs").length;
    counts.traces += events.filter((event) => event.kind === "traces").length;
  }
  counts.elapsed_ms = now() - start;
  return counts;
};

/* eslint-enable no-await-in-loop */

export const seedAnalyticsFixture = async (runId, send, stop) => {
  assert.match(runId, runPattern);
  stop?.throwIfAborted();
  // Per insert-batch-size: one synchronous 10K-row batch, using setup credentials only.
  const result = await send(
    `INSERT INTO capacity_analytics.ledger_sample SELECT '${runId}', toUInt16(number + 1) FROM numbers(10000) SETTINGS async_insert=0`,
    stop
  );
  assert.equal(
    result.acknowledged,
    true,
    "fixture insertion must acknowledge completion"
  );
  return { inserted_rows: 10_000 };
};

/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const discoverRequests = async (
  origins,
  request = fetch,
  emit = () => null
) => {
  const result = {};
  for (const kind of ["app", "web", "docs", "api"]) {
    const root = new URL(origins[kind]);
    const accepted_at = new Date().toISOString();
    const response = await request(root, {
      signal: AbortSignal.timeout(10_000),
    });
    await emit({
      accepted_at,
      completed_at: new Date().toISOString(),
      kind: "http",
      outcome: response.ok ? "completed" : "failed",
      phase: "discovery",
      status: response.status,
      url: root.href,
    });
    assert.ok(response.ok, `${kind} root unavailable`);
    const assets = new Set([root.href]);
    if (kind !== "api") {
      const html = await response.text();
      for (const [, value] of html.matchAll(
        /(?:src|href)=["'](?<asset>[^"']+)["']/gu
      )) {
        const asset = new URL(value.replaceAll("&amp;", "&"), root);
        if (
          asset.origin === root.origin &&
          asset.pathname.startsWith("/_next/static/")
        ) {
          assets.add(asset.href);
        }
      }
      assert.ok(
        assets.size > 1,
        `${kind} production static assets not discovered`
      );
    }
    result[kind] = Object.freeze([...assets].toSorted());
  }
  return Object.freeze(result);
};

/* eslint-enable no-await-in-loop */

export const createForegroundPermit = () => {
  let tail = Promise.resolve();
  let failure;
  return async (task, signal) => {
    const previous = tail;
    const { promise, resolve: release } = Promise.withResolvers();
    tail = promise;
    try {
      await previous;
      signal?.throwIfAborted();
      if (failure) {
        throw failure;
      }
      return await task(signal);
    } catch (error) {
      if (error.name !== "AbortError") {
        failure ??= error;
      }
      throw error;
    } finally {
      release();
    }
  };
};

const phaseOperations = (clients, result, stop, emit, permit) => ({
  foreground: async () => {
    const search = await permit((signal) => clients.search(signal), stop);
    result.search += 1;
    const analytics = await permit((signal) => clients.analytics(signal), stop);
    result.analytics += 1;
    return { analytics, search };
  },
  http: () => {
    const group = ["app", "web", "docs", "api"][result.http % 4];
    const requests = clients.requests[group];
    const url = requests[Math.floor(result.http / 4) % requests.length];
    result.http += 1;
    return clients.http(url, stop);
  },
  telemetry: async () => {
    const output = await clients.telemetry(
      { count: 10, offset: result.telemetry_accepted },
      stop
    );
    result.telemetry_accepted += output.accepted;
    return output;
  },
  verification: () => clients.verifyTelemetry?.(stop),
  workflow: () => {
    result.workflows += 1;
    result.queue_pending_max = 1;
    return clients.workflow({ emit }, stop);
  },
});
/** Bounded per-lane in-flight work; delayed requests are never caught up in a burst. */
export const runLoad = async (phase, clients, stop) => {
  assert.ok(Number.isFinite(phase.duration_ms) && phase.duration_ms > 0);
  assert.ok([0, 1, 3, 5].includes(phase.http_rps));
  const now = clients.now ?? performance.now.bind(performance);
  const wait = clients.sleep ?? sleep;
  const start = now();
  const permit = clients.foreground ?? createForegroundPermit();
  const result = {
    analytics: 0,
    http: 0,
    phase: phase.name,
    queue_pending_max: 0,
    search: 0,
    skipped: 0,
    telemetry_accepted: 0,
    workflows: 0,
  };
  const state = { failure: undefined, sequence: 0 };
  const active = new Map();
  const next = {
    foreground: start,
    http: start,
    telemetry: start,
    verification: start,
    workflow: start,
  };
  const emit = (event) => {
    state.sequence += 1;
    return clients.emit({
      accepted_at: new Date().toISOString(),
      completed_at: null,
      phase: phase.name,
      sequence: state.sequence,
      ...event,
    });
  };
  const operations = phaseOperations(clients, result, stop, emit, permit);
  const launch = (kind) => {
    const acceptedAt = new Date().toISOString();
    const task = (async () => {
      try {
        await emit({ accepted_at: acceptedAt, kind, outcome: "submitted" });
        stop.throwIfAborted();
        const output = await operations[kind]();
        await emit({
          accepted_at: acceptedAt,
          completed_at: new Date().toISOString(),
          kind,
          outcome: "completed",
          ...output,
        });
      } catch (error) {
        if (!stopped(stop) || error.name !== "AbortError") {
          state.failure ??= error;
        }
        try {
          await emit({
            accepted_at: acceptedAt,
            completed_at: new Date().toISOString(),
            kind,
            outcome: stopped(stop) ? "cancelled" : "failed",
          });
        } catch (persistError) {
          state.failure ??= persistError;
        }
      } finally {
        active.delete(kind);
      }
    })();
    active.set(kind, task);
  };
  /* eslint-disable no-await-in-loop -- Admission is a paced stream; parallelizing iterations would create an unbounded request queue. */
  while (
    now() - start < phase.duration_ms &&
    !stopped(stop) &&
    !state.failure
  ) {
    const elapsed = now();
    for (const [kind, interval] of [
      ["http", phase.http_rps ? 1000 / phase.http_rps : Infinity],
      ["telemetry", 1000],
      ["verification", 1000],
      ["foreground", 10_000],
      ["workflow", 10_000],
    ]) {
      if (phase.http_rps === 0 || elapsed < next[kind]) {
        continue;
      }
      next[kind] = elapsed + interval;
      if (active.has(kind)) {
        result.skipped += 1;
        continue;
      }
      launch(kind);
    }
    await Promise.resolve();
    try {
      await wait(
        Math.max(
          0.01,
          Math.min(
            100,
            phase.duration_ms - (now() - start),
            ...Object.values(next)
              .filter((value) => value > now())
              .map((value) => value - now())
          )
        ),
        stop
      );
    } catch (error) {
      if (!stopped(stop)) {
        throw error;
      }
    }
  }
  /* eslint-enable no-await-in-loop */
  await Promise.all(active.values());
  if (state.failure) {
    throw state.failure;
  }
  return result;
};

const queryLimits =
  "SETTINGS max_execution_time=5, max_memory_usage=134217728, max_rows_to_read=50000, max_bytes_to_read=67108864, read_overflow_mode='throw', result_overflow_mode='throw', timeout_overflow_mode='throw'";
/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const discoverTelemetry = async (query, signal) => {
  const databases = await query(
    `SELECT name FROM system.databases WHERE name='otel' LIMIT 1 ${queryLimits} FORMAT JSON`,
    signal
  );
  assert.equal(databases.data[0]?.name, "otel");
  const tables = await query(
    `SELECT name,engine,sorting_key,primary_key,partition_key,create_table_query FROM system.tables WHERE database='otel' AND name IN ('otel_logs','otel_traces') LIMIT 2 ${queryLimits} FORMAT JSON`,
    signal
  );
  assert.equal(tables.data.length, 2);
  const schemas = {};
  for (const kind of ["logs", "traces"]) {
    const table = `otel_${kind}`;
    const columns = await query(
      `SELECT name,type,comment FROM system.columns WHERE database='otel' AND table='${table}' ORDER BY position LIMIT 100 ${queryLimits} FORMAT JSON`,
      signal
    );
    const names = new Set(columns.data.map((column) => column.name));
    const attributes = kind === "logs" ? "LogAttributes" : "SpanAttributes";
    for (const name of ["Timestamp", "ServiceName", attributes]) {
      assert.ok(names.has(name), `required telemetry column missing: ${name}`);
    }
    const metadata = tables.data.find((value) => value.name === table);
    assert.ok(
      metadata.sorting_key.includes("Timestamp") &&
        metadata.sorting_key.includes("ServiceName"),
      "unsupported telemetry sort key"
    );
    schemas[kind] = { attributes, columns: columns.data, table, ...metadata };
  }
  return schemas;
};
/* eslint-enable no-await-in-loop */

const batchPredicate = (seed, events, attributes) => {
  assert.match(seed.run_id, runPattern);
  assert.ok(
    ["current", "aged", "steady", "boundary"].includes(seed.cohort ?? "current")
  );
  const [first] = events;
  const last = events.at(-1);
  return `ServiceName='capacity-synthetic' AND Timestamp>=fromUnixTimestamp64Milli(${first.event_time_ms}) AND Timestamp<=fromUnixTimestamp64Milli(${last.event_time_ms}) AND ${attributes}['capacity.run_id']='${seed.run_id}' AND ${attributes}['capacity.cohort']='${seed.cohort ?? "current"}' AND toUInt32OrZero(${attributes}['capacity.sequence']) BETWEEN ${first.sequence} AND ${last.sequence}`;
};
/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const verifyTelemetryBatch = async (
  seed,
  batch,
  schemas,
  query,
  signal
) => {
  let stored = 0;
  const proofs = [];
  for (const kind of ["logs", "traces"]) {
    const events = batch.events.filter((event) => event.kind === kind);
    if (!events.length) {
      continue;
    }
    const { table, attributes } = schemas[kind];
    const predicate = batchPredicate(seed, events, attributes);
    const seq = `toUInt32OrZero(${attributes}['capacity.sequence'])`;
    const sql = `SELECT count() AS rows, uniqExact(${seq}) AS unique_sequences, sum(${seq}) AS sequence_sum, countIf(${attributes}['capacity.id'] != lower(hex(SHA256(concat('${seed.run_id}:${seed.cohort ?? "current"}:',${attributes}['capacity.sequence']))))) AS checksum_errors FROM otel.${table} WHERE ${predicate} LIMIT 1 ${queryLimits} FORMAT JSON`;
    const deadline = Date.now() + 30_000;
    let aggregate;
    do {
      signal.throwIfAborted();
      const response = await query(sql, signal);
      [aggregate] = response.data;
      if (Number(aggregate.rows) === events.length) {
        break;
      }
      await sleep(500, signal);
    } while (Date.now() < deadline);
    assert.equal(
      Number(aggregate.rows),
      events.length,
      "accepted batch has not become stored rows"
    );
    assert.equal(Number(aggregate.unique_sequences), events.length);
    assert.equal(
      Number(aggregate.sequence_sum),
      events.reduce((sum, event) => sum + event.sequence, 0)
    );
    assert.equal(Number(aggregate.checksum_errors), 0);
    const samples = [
      events[0],
      events[Math.floor(events.length / 2)],
      events.at(-1),
    ];
    const uniqueSamples = [
      ...new Map(samples.map((event) => [event.sequence, event])).values(),
    ];
    const sampleResult = await query(
      `SELECT ${seq} AS sequence, ${attributes}['capacity.id'] AS id FROM otel.${table} WHERE ${predicate} AND ${seq} IN (${uniqueSamples.map((event) => event.sequence).join(",")}) ORDER BY sequence LIMIT 3 ${queryLimits} FORMAT JSON`,
      signal
    );
    const { data: sample } = sampleResult;
    assert.deepEqual(
      sample.map((value) => ({
        id: value.id,
        sequence: Number(value.sequence),
      })),
      uniqueSamples
        .map(({ sequence, id }) => ({ id, sequence }))
        .toSorted((a, b) => a.sequence - b.sequence)
    );
    stored += events.length;
    proofs.push({
      checksum_errors: 0,
      event_time_ms: [events[0].event_time_ms, events.at(-1).event_time_ms],
      kind,
      rows: events.length,
      sampled_ids: sample,
      sequence_sum: Number(aggregate.sequence_sum),
      stored_at: new Date().toISOString(),
    });
  }
  return { proofs, stored };
};
/* eslint-enable no-await-in-loop */

/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const createTelemetryIngestor =
  ({ ingest, persist }) =>
  async (batch, signal) => {
    let accepted = 0;
    for (const kind of ["logs", "traces"]) {
      const events = batch.events.filter((event) => event.kind === kind);
      if (!events.length) {
        continue;
      }
      signal.throwIfAborted();
      const response = await ingest(kind, encodeOtlp(events, kind), signal);
      assert.ok(response.ok, "OTLP ingestion rejected");
      const output = await response.json();
      const rejected = Number(
        kind === "logs"
          ? (output.partialSuccess?.rejectedLogRecords ?? 0)
          : (output.partialSuccess?.rejectedSpans ?? 0)
      );
      assert.ok(
        Number.isSafeInteger(rejected) &&
          rejected >= 0 &&
          rejected <= events.length
      );
      accepted += events.length - rejected;
      await persist({
        accepted: events.length - rejected,
        accepted_at: batch.accepted_at,
        completed_at: new Date().toISOString(),
        first_sequence: events[0].sequence,
        kind: "telemetry_accepted",
        last_sequence: events.at(-1).sequence,
        rejected,
        signal: kind,
        stored: 0,
      });
      assert.equal(
        rejected,
        0,
        "partial OTLP acceptance is not a complete seed"
      );
    }
    return { accepted, stored: 0 };
  };
/* eslint-enable no-await-in-loop */
export const createTelemetrySender = (options) => async (batch, signal) => {
  const { accepted } = await createTelemetryIngestor(options)(batch, signal);
  const proof = await verifyTelemetryBatch(
    options.seed,
    batch,
    options.schemas,
    options.query,
    signal
  );
  await options.persist({
    accepted,
    completed_at: new Date().toISOString(),
    kind: "telemetry_stored",
    proofs: proof.proofs,
    stored: proof.stored,
  });
  return { accepted, stored: proof.stored };
};
export const createSteadyTelemetry = (options) => {
  const queue = [];
  let sequence = 0;
  const now = options.now ?? Date.now;
  const submit = async (signal) => {
    assert.ok(
      queue.length < 20,
      "telemetry verification backlog exceeded20 bounded batches"
    );
    const seed = {
      ...options.seed,
      cohort: "steady",
      epoch_ms: now() - Math.floor((sequence * 1000) / 200),
    };
    const batch = {
      accepted_at: new Date(now()).toISOString(),
      events: Array.from({ length: 10 }, () => {
        sequence += 1;
        return telemetryEvent(seed, sequence);
      }),
    };
    const result = await createTelemetryIngestor(options)(batch, signal);
    queue.push({ batch, seed, submitted_ms: now() });
    return result;
  };
  const verify = async (signal, force = false) => {
    const [item] = queue;
    if (!item || (!force && now() - item.submitted_ms < 2000)) {
      return { stored: 0 };
    }
    const proof = await options.foreground(
      (stop) =>
        verifyTelemetryBatch(
          item.seed,
          item.batch,
          options.schemas,
          options.query,
          stop
        ),
      signal
    );
    await options.persist({
      completed_at: new Date().toISOString(),
      kind: "telemetry_stored",
      proofs: proof.proofs,
      stored: proof.stored,
    });
    queue.shift();
    return proof;
  };
  const flush = async (signal) => {
    /* eslint-disable no-await-in-loop -- Drain the fixed-size verification queue before completing a phase. */
    while (queue.length) {
      await verify(signal, true);
    }
    /* eslint-enable no-await-in-loop */
  };
  return { flush, pending: () => queue.length, submit, verify };
};

/* eslint-disable no-await-in-loop -- Keep batches bounded and verify each response before admitting the next operation. */
export const verifyUnchangedRetention = (before, after) => {
  assert.deepEqual(before.ttls.map(({ table }) => table).toSorted(), [
    "otel_logs",
    "otel_traces",
  ]);
  for (const { ddl } of before.ttls) {
    assert.match(ddl, /TTL .*toIntervalDay\(3\)/u);
  }
  assert.ok(
    before.mutations.every(({ is_done }) => Number(is_done) === 1),
    "ordinary expiry requires no pending TTL preparation mutation"
  );
  assert.deepEqual(
    after,
    before,
    "ordinary expiry requires unchanged TTL and mutation baseline"
  );
};

export const waitNormalExpiry = async ({
  seed,
  count,
  schemas,
  query,
  persist,
  signal,
  deadline_ms = workload.expiry_deadline_ms,
}) => {
  const start = Date.now();
  assert.ok(deadline_ms > 0 && deadline_ms <= 3_600_000);
  let remaining = Infinity;
  while (remaining > 0 && Date.now() - start < deadline_ms) {
    remaining = 0;
    for (let offset = 0; offset < count; offset += 200) {
      const batch = {
        events: Array.from(
          { length: Math.min(200, count - offset) },
          (_, index) => telemetryEvent(seed, offset + index + 1)
        ),
      };
      for (const kind of ["logs", "traces"]) {
        const events = batch.events.filter((event) => event.kind === kind);
        if (!events.length) {
          continue;
        }
        const { table, attributes } = schemas[kind];
        const result = await query(
          `SELECT count() AS rows FROM otel.${table} WHERE ${batchPredicate(seed, events, attributes)} LIMIT 1 ${queryLimits} FORMAT JSON`,
          signal
        );
        remaining += Number(result.data[0].rows);
      }
    }
    await persist({
      cohort: seed.cohort,
      kind: "normal_expiry_observation",
      observed_at: new Date().toISOString(),
      remaining,
    });
    if (remaining > 0) {
      await sleep(10_000, signal);
    }
  }
  assert.equal(
    remaining,
    0,
    "aged rows did not expire through normal TTL within deadline"
  );
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed <= deadline_ms,
    "ordinary expiry observation exceeded deadline"
  );
  return {
    elapsed_ms: elapsed,
    expired: count,
    mechanism: "normal TTL/background merge; no deletion or forced merge",
  };
};

/* eslint-enable no-await-in-loop */

export const createSavedSearch = async (
  { request, connectionId, runId, epoch_ms },
  signal
) => {
  assert.match(runId, runPattern);
  const create = await request("/sources", {
    body: JSON.stringify({
      connection: connectionId,
      defaultTableSelectExpression: "Body",
      from: { databaseName: "otel", tableName: "otel_logs" },
      kind: "log",
      name: `capacity-${runId}`,
      timestampValueExpression: "Timestamp",
    }),
    method: "POST",
    signal,
  });
  assert.ok(create.ok, "HyperDX source creation failed");
  const source = await create.json();
  const where = `ServiceName='capacity-synthetic' AND Timestamp>=fromUnixTimestamp64Milli(${epoch_ms}) AND Timestamp<fromUnixTimestamp64Milli(${epoch_ms + 10_000}) AND LogAttributes['capacity.run_id']='${runId}' AND LogAttributes['capacity.cohort']='current'`;
  const saved = await request("/saved-search", {
    body: JSON.stringify({
      name: `capacity-${runId}`,
      orderBy: "",
      select:
        "count() AS rows, argMin(LogAttributes['capacity.id'],toUInt64(LogAttributes['capacity.sequence'])) AS first_id",
      source: source.id ?? source._id,
      tags: ["capacity"],
      where,
      whereLanguage: "sql",
    }),
    method: "POST",
    signal,
  });
  assert.ok(saved.ok, "HyperDX saved-search creation failed");
  const record = await saved.json();
  const listed = await request("/saved-search", { signal });
  assert.ok(listed.ok);
  const listing = await listed.json();
  const persisted = listing.find(
    (value) => (value.id ?? value._id) === (record.id ?? record._id)
  );
  assert.equal(
    persisted?.where,
    where,
    "saved search must be persisted and read back"
  );
  return {
    execute: async (stop) => {
      const sql = `SELECT ${persisted.select} FROM otel.otel_logs WHERE ${persisted.where} LIMIT 1 ${queryLimits} FORMAT JSON`;
      const response = await request(
        `/clickhouse-proxy/?query=${encodeURIComponent(sql)}`,
        {
          body: "",
          headers: {
            "content-type": "text/plain",
            "x-hyperdx-connection-id": connectionId,
          },
          method: "POST",
          signal: stop,
        }
      );
      assert.ok(response.ok, "saved HyperDX query failed");
      const result = await response.json();
      assert.ok(
        Number(result.data[0].rows) > 0,
        "saved search must find seeded events"
      );
      assert.equal(
        result.data[0].first_id,
        hash(`${runId}:current:1`),
        "saved search must return a known fixture ID"
      );
      return {
        first_id: result.data[0].first_id,
        rows: Number(result.data[0].rows),
        saved_search_id: record.id ?? record._id,
      };
    },
    id: record.id ?? record._id,
    source_id: source.id ?? source._id,
  };
};
