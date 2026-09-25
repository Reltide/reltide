# MAX-8 Rust API Contract Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Rust health operation and make the Next.js dashboard consume a reproducible, generated TypeScript client.

**Architecture:** Axum and utoipa-axum register one operation and produce the OpenAPI document from that registration. A local generator script captures the document without starting the server, invokes pinned Hey API, and verifies committed output byte-for-byte. The dashboard calls the generated operation on the server and shows an explicit status.

**Tech Stack:** Rust 1.98.1, Axum, Utoipa, Tokio, Node 26.9.0, pnpm 12.6.0, Hey API, Nx 23.2.1, Next.js 16.3.6, TypeScript 5.9.3.

**Spec:** docs/superpowers/specs/2026-09-25-max-8-rust-api-contract-design.md

## Global Constraints

- Application HTTP behavior and OpenAPI ownership remain in Rust. Next.js only renders and calls the API.
- The API's local default is 127.0.0.1:3002. The app reads a server-only base URL and builds without a running API.
- Commit the OpenAPI snapshot and generated client. Generation runs locally without hosted credentials or a live service.
- Keep pnpm, Cargo, and generator dependencies pinned and lockfiles committed. Do not add the deprecated separate Hey API Fetch package.
- Use Ultracite/Oxlint/Oxfmt for TypeScript quality and the repository's Rust format, Clippy, and test commands.
- Preserve the existing Nx API → domain and client → API graph; add app → client through a workspace dependency.

## File map

| File | Responsibility |
| --- | --- |
| apps/api/src/lib.rs | Router, health response, shared OpenAPI object |
| apps/api/src/main.rs | Offline contract print and HTTP startup |
| apps/api/tests/contract.rs | Router response, served contract, CLI contract |
| apps/api/Cargo.toml and Cargo.lock | Exact Rust dependencies |
| packages/api-client/package.json | Workspace identity, Hey API version, scripts |
| packages/api-client/project.json | Nx build, generation, and drift targets |
| packages/api-client/scripts/contract.mjs | Offline Rust export, codegen, comparison |
| packages/api-client/openapi.json | Committed contract for client and future docs |
| packages/api-client/src/generated/ | Committed Hey API output |
| packages/api-client/src/index.ts | Stable public exports |
| apps/app/lib/api-status.ts | Server-side status call and error interpretation |
| apps/app/lib/api-status.test.ts | Real local HTTP integration cases |
| apps/app/app/page.tsx | Render connection state |
| apps/app/package.json and apps/app/next.config.mjs | Client workspace dependency and transpilation |
| tools/rust-workspace.test.mjs | Nx graph and affected propagation |
| README.md | Local start, configuration, errors, generation |

## Review Focus

- An unset API URL renders an unconfigured state; Task 3 tests it.
- A malformed URL or network refusal renders unavailable without crashing; Task 3 tests both.
- A 200 response with the wrong body must not be reported healthy; Task 3 tests it.
- A changed Rust schema or stale generated file must fail the read-only drift check; Task 2 tests and probes it.
- Offline OpenAPI export must be valid JSON and must not include logs or need a port; Task 1 tests it.

---

### Task 1: Rust health route and single-source contract

**Files:** apps/api/src/lib.rs, apps/api/src/main.rs, apps/api/tests/contract.rs, apps/api/Cargo.toml, Cargo.lock.

**Interfaces:** Produces public api() returning (axum::Router, utoipa::openapi::OpenApi). The binary prints the OpenAPI object for --print-openapi and otherwise serves the router.

- [x] **Step 1: Add test dependencies and write failing router and CLI tests.** Add axum, tower, and serde_json dependencies so the tests compile; update Cargo.lock. In apps/api/tests/contract.rs, use tower::ServiceExt to send GET /api/v1/health and GET /openapi.json to api(). Assert status 200, JSON content type, and the literal object {"status":"ok"}. Parse the served contract and the --print-openapi output as JSON; assert that paths./api/v1/health.get.responses.200 exists and the two documents match. The CLI test uses the Cargo binary path and verifies stdout contains only JSON.

~~~rust
let (router, _) = reltide_api::api();
let response = router.oneshot(
    Request::builder().uri("/api/v1/health").body(Body::empty())?
).await?;
assert_eq!(response.status(), StatusCode::OK);
let body = to_bytes(response.into_body(), 1024).await?;
assert_eq!(serde_json::from_slice::<Value>(&body)?, json!({"status": "ok"}));
~~~
- [x] **Step 2: Run RED.** Run cargo test -p reltide-api --locked. Expected: tests cannot import reltide_api::api yet; the endpoint contract is missing.
- [x] **Step 3: Add minimal Rust code.** Pin axum 0.8.9, utoipa 6.0.0, utoipa-axum 0.3.0, tokio 1.53.1, serde 1.0.229, tower 0.5.3, and serde_json 1.0.151 as appropriate. Define HealthResponse with Serialize and ToSchema. Register the annotated handler with OpenApiRouter::new().routes(routes!(health)).split_for_parts(). Attach GET /openapi.json using a clone of that OpenAPI object. Parse the bind address with a fallible error path; default to 127.0.0.1:3002. Print with OpenApi::to_pretty_json in --print-openapi mode.

~~~rust
#[derive(Serialize, ToSchema)]
struct HealthResponse { status: &'static str }

#[utoipa::path(get, path = "/api/v1/health", operation_id = "getHealth",
    responses((status = 200, body = HealthResponse)))]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

pub fn api() -> (Router, OpenApi) {
    let (router, document) = OpenApiRouter::new()
        .routes(routes!(health))
        .split_for_parts();
    let served = document.clone();
    let router = router.route("/openapi.json", get(move || {
        let document = served.clone();
        async move { Json(document) }
    }));
    (router, document)
}
~~~
- [x] **Step 4: Run GREEN.** Run cargo test -p reltide-api, cargo fmt --all -- --check, and cargo clippy -p reltide-api --all-targets --locked -- -D warnings. Expected: all pass.
- [x] **Step 5: Commit.** Commit the Rust files and Cargo.lock as feat: serve Rust health contract.

### Task 2: Generate and check the TypeScript client

**Files:** packages/api-client/package.json, packages/api-client/project.json, packages/api-client/tsconfig.json, packages/api-client/scripts/contract.mjs, packages/api-client/src/index.ts, packages/api-client/src/generated/, packages/api-client/openapi.json, tools/api-client.test.mjs, pnpm-lock.yaml.

**Interfaces:** Consumes cargo run -p reltide-api --locked -- --print-openapi. Produces pnpm nx run @repo/api-client:generate, pnpm nx run @repo/api-client:check-contract, and a package export with the generated health operation and types.

- [x] **Step 1: Write failing drift tests.** Add a Vitest test that creates two temporary artifact directories, writes unequal OpenAPI/TypeScript files, and asserts the exported comparison helper reports the changed path; assert equal directories return no differences. This test catches a stale client, not a specific implementation text. Add an integration assertion that the checked-in contract contains the health operation.

~~~js
test("changed generated source is reported", async () => {
  const left = await makeArtifacts({ "client.ts": "old" });
  const right = await makeArtifacts({ "client.ts": "new" });
  expect(await compareArtifactTrees(left, right)).toEqual(["client.ts"]);
});
~~~
- [x] **Step 2: Run RED.** Run pnpm exec vitest run tools/api-client.test.mjs. Expected: the comparison helper and/or generated contract is missing.
- [x] **Step 3: Add the workspace package and generator.** Pin @hey-api/openapi-ts at 0.99.0. The generator script invokes the Rust --print-openapi mode with execFileSync, writes the contract to a temporary directory, invokes Hey API createClient with that local file, and either copies complete output for --generate or compares complete output for --check. Use mkdtemp and remove only the script's temporary directory in finally. Keep the check path read-only for the repository. Expose generated code through src/index.ts. Define Nx generate, check-contract, typecheck, and uncached build targets; build runs check-contract and typecheck.

~~~js
const contract = execFileSync(
  "cargo",
  ["run", "-q", "-p", "reltide-api", "--locked", "--", "--print-openapi"],
  { cwd: workspaceRoot, encoding: "utf8" }
);
await writeFile(generatedContractPath, contract);
await createClient({
  input: generatedContractPath,
  output: generatedSourcePath,
});
const changed = await compareArtifactTrees(snapshotRoot, generatedRoot);
if (mode === "--check" && changed.length > 0) {
  throw new Error("API client drift: " + changed.join(", "));
}
~~~
- [x] **Step 4: Run GREEN and negative probe.** Run the generation target, then the test, check-contract, and client typecheck targets. Temporarily change one checked-in generated artifact, run check-contract and observe failure, restore the artifact, then rerun and observe success. Expected: exact drift is detected and all normal targets pass.
- [x] **Step 5: Commit.** Commit the package, generated artifacts, scripts, tests, and lockfile as feat: generate Rust API client.

### Task 3: Consume the generated operation in the dashboard

**Files:** apps/app/lib/api-status.ts, apps/app/lib/api-status.test.ts, apps/app/app/page.tsx, apps/app/package.json, apps/app/next.config.mjs, tools/rust-workspace.test.mjs, README.md, pnpm-lock.yaml.

**Interfaces:** Consumes the generated health operation. Produces getApiStatus(baseUrl?: string): Promise<{kind:"unconfigured"|"available"|"unavailable"}> with a stable status for the page.

- [x] **Step 1: Write failing status tests and graph assertion.** In the status test, use a real ephemeral node:http server for {"status":"ok"}, non-200, and malformed 200 responses. Also test undefined, malformed URL, and a refused local connection. Add an Nx graph assertion for app → @repo/api-client and an affected-project assertion for apps/api/src/lib.rs affecting app.

~~~ts
test("unconfigured API has an explicit state", async () => {
  expect(await getApiStatus(undefined)).toEqual({ kind: "unconfigured" });
});

test("healthy Rust response is reported available", async () => {
  const server = await startLocalServer(200, { status: "ok" });
  expect(await getApiStatus(server.url)).toEqual({ kind: "available" });
  await server.close();
});
~~~
- [x] **Step 2: Run RED.** Run pnpm exec vitest run apps/app/lib/api-status.test.ts tools/rust-workspace.test.mjs. Expected: status helper is missing and the app dependency assertion fails.
- [x] **Step 3: Implement the server-side call and UI.** Add @repo/api-client: workspace:* to apps/app, transpile the package in Next, and call the generated operation from getApiStatus with a per-call URL and no-store fetch. Reject invalid or non-http(s) URLs, network errors, non-2xx, and unexpected response bodies as unavailable. Make the page dynamic, await getApiStatus(process.env.RELTIDE_API_BASE_URL), and render the status as text using existing Geist styles. Add README commands for Rust API startup, app configuration, generation, drift checking, and error states.

~~~ts
export type ApiStatus = { kind: "unconfigured" | "available" | "unavailable" };

export async function getApiStatus(baseUrl?: string): Promise<ApiStatus> {
  if (!baseUrl) return { kind: "unconfigured" };
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { kind: "unavailable" };
    }
    const result = await getHealth({
      baseUrl,
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return result.data?.status === "ok"
      ? { kind: "available" }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
~~~
- [x] **Step 4: Run GREEN and full verification.** Run the two test files, pnpm nx run app:typecheck, pnpm build, pnpm typecheck, pnpm check, pnpm rust:check, and the contract drift target. Start the Rust binary on a temporary local port and use curl against both routes; build the app with no API URL. Expected: tests and checks pass, the API returns JSON, and the frontend build needs no service.
- [x] **Step 5: Commit.** Commit dashboard, graph tests, docs, and lockfile as feat: show Rust API connection status.

## Final verification

Run git diff --check, inspect git status, and review the full branch against this spec. Confirm each Linear acceptance item with the commands and artifacts above. Update MAX-8 with the implementation evidence and the reviewable branch or PR link.
