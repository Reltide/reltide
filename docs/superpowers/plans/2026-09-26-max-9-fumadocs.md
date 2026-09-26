# MAX-9 Fumadocs Implementation Plan

> For agentic workers: use `superpowers:executing-plans` for inline execution, followed by a fresh whole-branch review.

**Goal:** Build searchable product and API documentation with deterministic contract and internal-link checks, runnable from a Next.js standalone bundle.

**Architecture:** Rust exports the committed OpenAPI contract. One preparation script generates ignored MDX from that contract; Fumadocs renders and indexes it. Nx orders contract checking, preparation, link validation, and building. No live API or hosted documentation service is required.

**Tech stack:** Existing Next.js 16.3.6, Fumadocs core/UI 16.15.14 and MDX 15.4.5; add exact stable `fumadocs-openapi` 12.0.3, `next-validate-link` 1.6.7, and `shiki` 4.4.3 if required by OpenAPI rendering.

**Spec:** [Approved design](../specs/2026-09-25-max-9-fumadocs-design.md).

## Global Constraints

- Work in the isolated `codex/max-9-fumadocs` worktree. Use Node 26.9.0 and pnpm 12.6.0.
- Query Graft before source exploration. Keep business logic in Rust; search is a local documentation index.
- Generated files live only in `apps/docs/content/docs/reference/generated/`, ignored by Git. Preparation removes stale output and fails for an absent or malformed schema.
- Preparation and validation are noncached, avoiding stale generated output and concurrent writers. Build can retain its existing Nx cache.
- Use official integration APIs. External links are not fetched during validation.
- Tests exercise behavior; prose and configuration changes use compilation, graph queries, and actual staged-hook checks instead of source-text assertions.
- User approved implementation; proceed inline without another permission gate. Create a draft PR for human review after verification. MAX-10 and repository visibility are outside this change.

## Review Focus

1. Removed operations leave stale generated pages: Task 1 regenerates after changing a fixture schema and asserts the old page is absent.
2. Missing or malformed schemas silently produce an empty reference: Task 1 asserts a nonzero preparation exit for both inputs.
3. Route checks accept nonexistent fragments: Task 1 runs the checker against disposable content with missing routes and anchors.
4. Rust or contract changes fail to affect docs or bypass drift checks: Task 3 queries Nx affected projects and builds against a stale contract in an isolated fixture.
5. Standalone rendering/search depends on the source tree or Rust process: Task 3 copies only standalone output and static assets, checks pages, 404, API rendering, and local search.

### Task 1: Deterministic preparation and link validation

**Files:** `apps/docs/lib/openapi.ts`, `apps/docs/scripts/prepare-content.mjs`, `apps/docs/scripts/check-links.mjs`, `tools/docs.test.mjs`, `apps/docs/package.json`, root `package.json`, `.gitignore`.

**Interfaces**
- Consumes: committed `packages/api-client/openapi.json`, Fumadocs source loader, pinned runtime.
- Produces: `openapi` exported from `lib/openapi.ts`; preparation CLI generating `reference/generated/getHealth.mdx`; checker CLI resolving source routes and TOC hashes; `pnpm test:docs`; MDX-safe staged hook.

- [ ] Add pinned integration dependencies, then create disposable-copy tests. Run `pnpm exec vitest run tools/docs.test.mjs`. Expected: failure because preparation/checker scripts do not yet exist.
- [ ] Test names/assertions: “generates health and removes stale operations” asserts `getHealth.mdx` contains `/api/v1/health`, adds then removes a second operation and checks file absence; “rejects missing and malformed schemas” asserts nonzero exit; “validates routes and heading fragments” asserts success for real routes/anchors and failure for `/docs/missing` and `/docs/#missing-heading`.
- [ ] Implement `openapi = createOpenAPI({ input: { reltide: async () => schema } })` from a static local JSON import. Preparation uses `generateFiles`, local cwd-relative output and cleanup; checker uses `fumadocs-mdx/node`, `scanURLs`, `validateFiles`, and `printErrors(..., true)`.
- [ ] Correct staged routing: supported code/config glob retains Ultracite; MDX uses Oxfmt; ignored `.md` is excluded. Reproduce MDX-only `lint-staged` success with the real staged files. Expected: formatter succeeds, no “No files found to lint”.
- [ ] Run docs tests and `pnpm check`. Expected: all pass. Commit with the normal hooks: `feat(docs): generate API content and validate links (MAX-9)`.
- [ ] Completion command: `pnpm exec vitest run tools/docs.test.mjs`.

### Task 2: Documentation, API rendering, and Nx ordering

**Files:** `apps/docs/components/api-page.tsx`, docs page renderer/source, docs tsconfig/package, MDX and metadata under `apps/docs/content/docs`, `README.md`.

**Interfaces**
- Consumes: Task 1 `openapi`, generated MDX, preparation/checker CLIs.
- Produces: product/setup/permissions/verification/review-limit/reference pages; bundled API renderer; ordered Nx targets `prepare-content`, `check-links`, `build`, `dev`, `typecheck`.

- [ ] Extend disposable-copy tests to compile/load all intended docs slugs and confirm health searchable structured data. Run docs tests. Expected: missing initial pages before content changes.
- [ ] Add ordered navigation and content that distinguishes current health/shell implementation from the planned invited pilot. Setup records exact toolchains and commands, ports 3000/3001/3004, and standalone packaging. Reference landing links to the generated health page.
- [ ] Add the official OpenAPI client component and server preload adapter in the MDX renderer. Include component TSX in typechecking; keep shared tokens/fonts.
- [ ] Set `docs` implicit dependency `@repo/api-client`. `prepare-content` is noncached and depends on its `check-contract`; `check-links` depends on preparation; build depends on link validation and existing upstream builds. Dev/typecheck also prepare content. Add docs test target and root test command.
- [ ] Run `pnpm nx show project docs --json`, `pnpm nx run docs:check-links`, `pnpm nx run docs:build`, and `pnpm typecheck`. Expected: ordered contract/preparation/link/build tasks and all commands pass.
- [ ] Commit with normal hooks: `feat(docs): publish initial guides and Rust API reference (MAX-9)`.
- [ ] Completion command: `pnpm exec vitest run tools/docs.test.mjs`.

### Task 3: Contract, affected-graph, and standalone evidence

**Files:** `tools/docs-standalone.mjs`, behavior/graph tests, docs test/smoke target wiring, README as needed.

**Interfaces**
- Consumes: Task 2 docs Nx graph and `.next/standalone` output.
- Produces: repeatable standalone smoke command; affected/drift evidence; full verified branch and draft PR.

- [ ] Add `tools/docs-standalone.mjs` with isolated copy, ephemeral local port, bounded startup and process cleanup. Assert setup/scope/permissions/verification/review-limit/reference routes, generated health operation, unknown-page 404, and `/api/search?query=health` includes the generated reference. Run against baseline output if available. Expected: failure for missing guides/API page.
- [ ] Add graph assertions using Nx JSON queries for changed `apps/api/src/lib.rs` and `packages/api-client/openapi.json`. Expected: `docs` affected. Verify stale contract blocks normal docs build by editing only a disposable worktree and restoring/removing it afterward.
- [ ] Run `pnpm test:docs`, `pnpm nx run docs:build`, and standalone smoke. Expected: all pass without a Rust process, schema source file outside the copied output, or hosted credentials.
- [ ] Run `pnpm typecheck`, `pnpm check`, `pnpm build`, `pnpm test:api-contract`, and `cargo test -p reltide-api --locked`. Expected: all pass. Run `graft build` and inspect the final diff.
- [ ] Commit: `test(docs): verify contract graph and standalone output (MAX-9)`. Completion command: `pnpm test:docs`.
- [ ] Request one fresh-context whole-branch review; resolve material findings and rerun the affected checks. Push the task branch, create and attach a draft PR, and move MAX-9 to In Review with verification evidence.

## Self-review

All approved requirements map to the three tasks. Shared names and paths are consistent. Tests cover generation, invalid inputs, links, graph propagation, drift ordering, and isolated runtime behavior; prose/config are verified by their actual consumers. The final reviewer should examine the five focus areas above and the product wording against current implementation.
