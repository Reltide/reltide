# Local Stripe migration demo

Use Node `26.11.1`, pnpm `12.11.2`, and the pinned Rust toolchain. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm nx run reltide-worker:stripe-demo
```

The uncached target runs `cargo run -p reltide-worker --locked -- stripe-demo`. It accepts only this fixed synthetic fixture, with no repository or shell-command arguments. Historical npm dependencies need registry access or a populated cache; no Stripe, GitHub, Greptile, AI, database, or hosted-service credentials are needed. Verification constructs local SDK clients and synthetic response objects, without calling Stripe resource methods.

## Generated scope and checks

The worker transforms supported old client/helper bytes for SDK `10.17.0` / explicit API `2022-08-01` into SDK `12.0.0` / explicit API `2022-11-15`, handling `latest_charge` as an ID, expanded Charge, null, or absent property. It never copies the prewritten expected helper in `after/`.

Two packages are prepared in an OS temporary directory and installed with fixed locks using `npm ci --ignore-scripts --no-audit --no-fund`. Original fixtures remain unchanged. The sparse candidate contains generated explicit target files and the retained older-pin control; its unchanged include-all TypeScript configuration checks those files. The unknown-default client remains in the old package. The patch preserves original verification scripts and TypeScript configuration. Candidate checks use fixed worker programs directly: this does not prove a repository-wide SDK upgrade or migration of the original tests.

| Report check | Required result |
| --- | --- |
| `before_typecheck` | Exact Node probe, npm version/install, and old TypeScript check pass |
| `before_baseline` | Original old-response baseline passes |
| `before_regression` | Expected exit 1 with `ERR_ASSERTION`, actual null, expected `ch_new_001`, and `strictEqual` |
| `candidate_typecheck` | Historical target install and generated sparse candidate typecheck pass |
| `candidate_regression` | Generated API pin and all supported `latest_charge` forms pass |
| `pinned_control` | SDK 12 with explicit `2022-08-01` retains legacy handling |
| `unknown_control` | Old unversioned client remains unclassified and requires version evidence |

An unrelated failure, missing executable, timeout, or unexpected old-regression success fails local verification. Each command has a 120-second timeout; Unix process groups are terminated on timeout or when the spawned command exits. stdout/stderr are drained concurrently, retaining at most 8 KiB of raw tail bytes each; final UTF-8-safe check output is capped at 16 KiB. An in-output truncation notice identifies omitted earlier bytes from either stream or the final size bound. Concatenated streams do not represent their interleaved chronology. Exit codes, command arguments/cwd, and durations remain explicit.

For manual historical comparisons, run the isolated commands in the [fixture README](../fixtures/stripe-migration/README.md). Its `before` regression intentionally exits 1; its `after` checks validate the authored reference, while the worker separately proves generation from old inputs. Historical SDKs are evidence fixtures rather than recommended platform dependencies.

## Artifacts and dashboard

The worker writes ignored local files:

- `.reltide/demo/report.json`: schema-versioned evidence, input/candidate SHA-256 fingerprints, checks, blockers, and embedded patch/preview.
- `.reltide/demo/migration.patch`: actual unified target patch.
- `.reltide/demo/pull-request.md`: local review preview with exact tested scope and evidence links.

Fingerprint paths beginning `worker-generated/tests/` identify embedded worker programs materialized in the disposable directory, rather than original fixture files. Patch/preview publish atomically before the authoritative atomic report; temporary candidates are removed on ordinary completion.

Start these in separate shells:

```sh
cargo run -p reltide-api --locked
RELTIDE_API_BASE_URL=http://127.0.0.1:3002 pnpm nx run app:dev
```

Open [the local dashboard](http://localhost:3000). Inspect findings, evidence, fingerprints, all seven check disclosures, generated diff, and PR preview. Reload performs a fresh GET. To use a production build, run `pnpm nx run app:build` then start `RELTIDE_API_BASE_URL=http://127.0.0.1:3002 pnpm nx run app:start`; API configuration is supplied at startup, and credential-free builds remain supported.

The Rust API defaults to `127.0.0.1:3002`; `RELTIDE_API_BIND` overrides its socket address. `RELTIDE_MIGRATION_REPORT=/absolute/path/report.json` selects a trusted report at API startup; changing it requires an API restart. Its sibling marker is always named `run-marker.json`. HTTP request parameters cannot choose a report path. `RELTIDE_API_BASE_URL` is server-only dashboard configuration; restart the app when changing it. Fetch has a two-second timeout and `no-store`; no Next.js filesystem/command execution is involved.

| `GET /api/v1/migrations/latest` | Meaning |
| --- | --- |
| 200 | Domain-valid report; `locally_verified`, `failed`, or `not_run` stays visible |
| 404 `{ "error": "migration_report_not_found" }` | Missing report; dashboard shows an empty state |
| 503 `{ "error": "migration_report_unavailable" }` | Marker, unreadable/nonregular/over-1-MiB file, malformed JSON, or invalid evidence; dashboard shows unavailable |

All report responses include `Cache-Control: no-store`. Errors expose no path or report bytes. Without dashboard API configuration, the page shows “Not configured”; transport/configuration/body errors show “Unavailable”. Health remains process availability only. Export OpenAPI without serving or reading a report using `cargo run -q -p reltide-api --locked -- --print-openapi`.

## Interrupted-run recovery and publication

An exclusive `.reltide/demo/run-marker.json` records the worker PID and attempt start. A new attempt removes prior artifacts; normal errors replace earlier success with failed evidence or no report if planning failed. A competing run cannot overwrite the active attempt. An abrupt interruption leaves the marker, and the API returns 503 even if a report exists.

Inspect the marker and confirm its recorded PID is no longer running. Only then remove `.reltide/demo/run-marker.json` and rerun the demo. Do not remove a live worker's marker or treat an old PID as proof without checking the process. Reload the dashboard after rerunning; ordinary completion clears the marker.

Publication remains held for unknown account-default version evidence and missing independent review of the candidate. This is local unsigned preparation evidence; no remote PR is created. Greptile is a future independent-review integration, with review tied to the candidate revision, rather than an active vendor feed or migration engine. Provider ingestion, general repository isolation, GitHub publication, and OpenAI support remain future work. A human reviews and merges every PR.
