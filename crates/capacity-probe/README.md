# Synthetic capacity probe

This Rust harness uses Temporal SDK 1.0.0 and the independent application PostgreSQL ledger. It sends no integration, inference or email requests. PostgreSQL must start with `track_commit_timestamp=on`; schema setup happens only through the explicit seed command. The runtime role needs ledger SELECT/INSERT, not schema creation or UPDATE/DELETE.

`RELTIDE_CAPACITY_ENV_FILE` names an owner-only regular file (for example mode 0600). Its literal, unquoted `KEY=VALUE` lines are:

```text
TEMPORAL_ADDRESS=http://127.0.0.1:7233
TEMPORAL_NAMESPACE=reltide-capacity-example-1
TEMPORAL_TASK_QUEUE=reltide-capacity-example-1
APPLICATION_DATABASE_URL=postgresql://capacity:synthetic@127.0.0.1:5432/capacity
```

These are synthetic examples. Supply scoped credentials through that file, never through command-line arguments or committed files. Operator addresses use SSH forwarding. The namespace must already exist; this harness does not provision Temporal or other services. Namespace and task queue must both equal `reltide-capacity-<run_id>`.

Run `cargo run -p reltide-capacity-probe --locked -- <subcommand>`. `worker` consumes its restricted environment file. Other commands consume one JSON request on stdin, terminated by EOF:

| Command | Request and behavior |
| --- | --- |
| `start` | `{"run_id":"example-1","sequence":100001,"payload":"synthetic","hold_seconds":0}`; starts the SDK workflow, emits accepted identifiers, then waits for its checked result |
| `seed-ledger` | Same shape with `sequence=100000`, exactly 1024 UTF-8 payload bytes and `hold_seconds=0`; installs the schema, seeds keys 1–100000 in batches of at most 256, verifies all fixture keys/payloads/checksums |
| `verify-ledger` | Checks the requested key and original commit timestamp; the exact seed shape instead checks all 100000 fixture keys and payload/checksum pairs before checking its final watermark |
| `history` | `{"input":{"run_id":"example-1","sequence":100001,"payload":"synthetic","hold_seconds":0},"path":"/absolute/new-history.json"}`; exports full paginated SDK history to a new mode-0600 file; rejects existing paths |
| `replay` | `{"path":"/absolute/new-history.json"}`; runs the SDK workflow replayer locally without a server or database |

Requests are capped at 8192 encoded bytes. Payloads are capped at 1024 UTF-8 bytes, sequence at PostgreSQL signed bigint, run IDs at `[a-z0-9-]{1,64}`, and durable timers at 60 seconds. Use a nonzero hold only for labeled recovery/replay probes. Normal starts should use sequences above the seeded range to avoid conflicting with fixture payloads. Duplicate workflow IDs are rejected; activity redelivery of the same key/payload retains one effect and its original commit timestamp. A changed payload for an existing key fails without updating the row.

Stdout is JSON lines, protocol version 1, tagged `started`, `completed`, `watermark` or `history`. Every event has `run_id` and `timestamp_utc_ms` (Unix epoch milliseconds in UTC). Watermarks include `sequence`, `sha256`, and `post_commit_time` (the original PostgreSQL commit in RFC 3339 UTC, read after commit). `started` includes the workflow ID and Temporal run ID. History events include path and the file SHA-256. Errors are sanitized and go to stderr. Replay exits successfully only after SDK verification; it emits no fabricated completion event. Histories are capped at 256 events / 2 MiB and replay at 10 seconds; empty or noncontiguous histories fail.

Each probe process has a pool ceiling of one connection. One worker, one foreground operator and one analytics reader use at most three, leaving one within the combined four-connection ceiling. Activities have a 4.5-second client deadline, PostgreSQL statement/lock deadlines of 4/3 seconds, and Temporal start-to-close/schedule-to-close limits of 5/10 seconds with at most two attempts. The worker has one workflow-task slot, one activity slot, cache size one, two workflow pollers (one sticky/one nonsticky), one activity poller and a six-second graceful shutdown period for SIGINT/SIGTERM. Nondeterminism detection remains enabled.

The experiment controller must serialize submissions, admit at most one active workflow, and enforce at most one start per ten seconds. A workflow-task slot or cache ceiling does not impose a server-wide active-workflow limit. Multiple operator processes or workers are outside this approved configuration. `start` uses a deterministic workflow ID and rejects reuse; ordinary probes have a twenty-second execution timeout, while labeled nonzero-hold recovery probes have a bounded seventy-five-minute execution timeout to cover two sequential thirty-minute restores and fifteen minutes of coordinator/restart overhead (controller ruling R3). The client result wait remains `hold_seconds + 30` seconds; that deadline is neither workflow completion nor cancellation. Record accepted IDs even when a later acknowledgement or client connection fails, then reconcile them through history/ledger evidence.

Local integration evidence requires Task 2's isolated stack, a precreated namespace, the installed SQL schema and scoped fixture roles. These tests are explicitly ignored in the offline suite; a skipped test is not passing integration evidence. Invoke them explicitly and fail if credentials/services are absent:

```sh
cargo test -p reltide-capacity-probe --test ledger --locked -- --ignored
cargo test -p reltide-capacity-probe --test replay --locked -- --ignored
```

The ledger tests require `CAPACITY_TEST_DATABASE_URL` for the local disposable test database; they install the schema and use synthetic keys. The workflow test requires `CAPACITY_TEST_ENV_FILE` pointing to the restricted file above; it starts a real worker, completes a timer-bearing workflow, exports its history, stops the worker and replays the captured history. Use a fresh namespace/run for each invocation. Its test sequence is 900001. The experiment's later worker-restart/recovery scenario must separately prove a workflow crossing a real process restart, including lost acknowledgements and restored histories; this offline suite does not claim that evidence.
