# MAX-9: Fumadocs, API reference, and documentation validation

**Issue:** [MAX-9](https://linear.app/maximebrmd/issue/MAX-9/set-up-fumadocs-with-build-and-link-validation)

**Design approved in conversation:** 25 September 2026

**Hosting update — 26 September 2026:** Hetzner Cloud in Finland replaces the Verda target in this approved design. Standalone packaging and the implementation scope remain applicable. See [the current pilot deployment decision](../../decisions/pilot-budget.md).

## Outcome and scope

A clean checkout builds version-controlled product and developer documentation in `apps/docs`. The site uses the existing shared design tokens and Geist fonts, serves search locally, and renders an API reference from the same Rust OpenAPI contract that generates the TypeScript client. Documentation build and validation are Nx targets, and the resulting Next.js standalone output can run on Verda without a documentation SaaS or a live Rust API process.

This slice documents the invited pilot accurately. It does not implement repository onboarding, migration runs, provider monitoring, production deployment, or a live API playground proxy. MAX-10 will wire these documentation targets into required CI. The current Rust contract documents one operation, `GET /api/v1/health`; the reference grows as Rust operations are added.

## Existing boundaries

- `apps/docs` already has a Fumadocs MDX loader, a page renderer, and a local `/api/search` route. Its Next.js config inherits standalone output from `@repo/next-config` and traces the monorepo root.
- `apps/api` exports the served OpenAPI document from its Rust router. `packages/api-client/openapi.json` and the generated TypeScript client are committed together; `@repo/api-client:check-contract` regenerates in a temporary directory and fails on drift without editing the checkout.
- The resolved Nx graph does not yet connect `docs` to `@repo/api-client`. That edge is required because the docs reference reads the JSON file by path rather than through a TypeScript import.

## Documentation content and navigation

Keep author-written MDX in `apps/docs/content/docs` and add a small, ordered navigation tree. The initial pages cover:

1. **Product scope:** invited GitHub/TypeScript pilot, Stripe as the first end-to-end fixture, OpenAI in the MVP scope, and which capabilities are still planned.
2. **Local setup:** exact pinned Node, pnpm, and Rust toolchains; clean-install, build, typecheck, quality, Rust, API, and docs commands; local ports; no hosted credentials needed for the initial shells.
3. **Repository permissions:** the planned selected-repository GitHub App model, why source and pull-request access will be needed, and the distinction between future installation permissions and the currently available shell. Do not promise unimplemented scopes or a working connection flow.
4. **Verification:** immutable base commit, passing baseline, official evidence, a patch applied in a fresh checkout, required checks, and conditions that hold a patch for review instead of opening a PR.
5. **Review limits:** a human reviews and merges every draft PR, protected settings are not weakened to pass checks, and a requested revert cannot undo external side effects or restore a retired provider API version.

The index page links to these sections and to the generated API reference. Examples and wording must match the repository's current commands and the Linear product plan. Shared `@repo/design-system` styles remain the visual source of truth; Fumadocs-specific styles may adapt to those tokens but must not introduce a separate theme system.

## Contract-to-reference flow

```text
Rust router and OpenAPI registration
  -> existing contract export and drift check
  -> committed packages/api-client/openapi.json
  -> TypeScript client + Fumadocs OpenAPI page generation
  -> compiled docs and local search index
```

Use the official `fumadocs-openapi` integration with a local file input. A deterministic preparation target generates MDX endpoint pages into a reserved, ignored directory under `apps/docs/content/docs/reference/`; generated pages are not committed. An author-written reference landing page stays tracked. The Fumadocs page renderer supplies the OpenAPI component for those generated pages. The preparation step runs before docs build and link validation, including from a clean checkout. It fails on a missing or malformed schema. No runtime fetch from the Rust API or provider website is allowed.

Add an explicit Nx dependency from `docs` to `@repo/api-client`. The docs build must depend on the client's noncached contract check, so changed Rust operations with an outdated committed JSON file fail before rendering. The preparation target depends on the noncached contract check and is the sole writer of the generated directory. Link validation depends on preparation, and docs build depends on link validation, so a normal docs build also rejects contract drift and broken links without concurrent writes. Its inputs include the schema, generator code, lockfile, and relevant configuration, and its generated directory is declared as an output if caching is enabled. Verify that OpenAPI and Rust source changes mark docs affected in Nx.

The API reference is documentation, not an authenticated API client. Do not add a proxy or expose platform credentials. Its local schema must be present in a standalone runtime bundle if Fumadocs needs it after compilation; the standalone smoke check below establishes this rather than assuming output tracing is sufficient.

## Search and link checks

Keep the existing Fumadocs search route hosted by `apps/docs`. Generated API pages must appear in its index; a query for the health operation is the initial proof. The search route and page rendering must work without any external search account or running Rust API.

Add a `docs:check-links` target using Fumadocs' documented `next-validate-link` integration. It scans author-written and generated MDX, resolves internal `/docs` routes and heading fragments against the Fumadocs source, and exits nonzero for a missing route or anchor. The check is deterministic and does not require external URL requests. Include one negative verification that inserts a broken internal route or anchor into a disposable copy and confirms the target fails; the normal tree must pass. Fumadocs compilation remains a separate check from Ultracite/Oxfmt.

## Staged documentation files

The current lint-staged glob sends `.md` and `.mdx` files to `ultracite fix`. A docs-only commit fails: `docs/**` is intentionally ignored by Oxfmt, and Ultracite has no lint target for a lone Fumadocs MDX file. Keep the staged hook for supported code/config formats, route MDX through the installed Oxfmt formatter, and stop sending ignored design Markdown to Ultracite. This is a narrow correction needed to commit the new documentation normally; MDX compilation and link validation remain the required correctness checks. Verify a docs-only staged commit path without weakening the existing checks for supported files or restaging unrelated edits.

## Failure behavior

A missing schema, OpenAPI generation error, MDX compilation error, broken internal link, missing reference operation, or contract drift fails its Nx target. Unknown documentation slugs retain the existing 404 behavior. Author-written pages describe planned functionality as planned, so a successful docs build cannot be mistaken for product readiness.

## Verification and acceptance evidence

- From a clean checkout with pinned toolchains and `pnpm install --frozen-lockfile`, run `pnpm nx run @repo/api-client:check-contract`, the docs preparation target, `pnpm nx run docs:check-links`, and `pnpm nx run docs:build`.
- Run `pnpm typecheck`, `pnpm check`, and `pnpm build`; verify the Rust contract test still passes with `cargo test -p reltide-api --locked`.
- Confirm a known docs page, the generated health reference, and a health-related local search result from a standalone docs process with no Rust server and no hosted credentials.
- Confirm a broken internal link fails link validation and changed Rust/OpenAPI inputs affect the docs project. Confirm stale committed OpenAPI fails the existing contract check before docs build.

These checks provide the build, internal-link, contract-consistency, and self-hosted-output evidence required by MAX-9. The exact compatible stable package versions and integration API are verified against official Fumadocs documentation before dependencies change, then pinned in the lockfile.

## References

- [Fumadocs OpenAPI integration](https://www.fumadocs.dev/docs/integrations/openapi)
- [Fumadocs `generateFiles()`](https://www.fumadocs.dev/docs/integrations/openapi/generate-files)
- [Fumadocs built-in search](https://www.fumadocs.dev/docs/headless/search/orama)
- [Fumadocs link validation](https://www.fumadocs.dev/docs/integrations/validate-links)
