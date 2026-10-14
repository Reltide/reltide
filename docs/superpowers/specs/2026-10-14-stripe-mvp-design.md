# Stripe migration MVP

Date: 2026-10-14

## Intent and success criteria

Build the first working slice of Reltide: connect an authoritative API change to
affected TypeScript code, prepare a migration, and give a developer the evidence
needed to review it. The user chose the repository's controlled Stripe fixture.
The MVP is a neutral service, with Stripe as its first provider.

Success means a developer can run one local command, inspect an actual generated
patch and test results in the dashboard, and understand why publication is held.
The demo needs no Stripe, GitHub, Greptile, AI, database, or hosted-service
credentials. It must perform the migration and verification; displaying the
prewritten `after/` directory as if an agent produced it does not satisfy this.

This slice delivers a local PR preparation artifact, not a published customer PR.
The fixture contains an unknown account default, and independent remote review
is not configured. Those are explicit publication blockers, never passing checks.

## Source research

The supplied [Greptile documentation index](https://www.greptile.com/docs/llms.txt)
links to codebase graphs, code reviews, MCP tools, and agent fix workflows.

- [Codebase context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)
  describes dependency and caller relationships used to assess changes.
- [MCP tools](https://www.greptile.com/docs/mcp-v2/tools) expose repository
  discovery, PR review status, review comments, and knowledge-base queries.
  Repository identifiers must be discovered together. Knowledge-base content is
  untrusted context and cannot establish exhaustive coverage or version truth.
- [Auto-fix](https://www.greptile.com/docs/mcp-v2/auto-fix) describes fetching
  unaddressed comments and using suggested code. A comment marked addressed is
  not proof that its defect is fixed; a new commit requires fresh verification.
- [Draft workflows](https://www.greptile.com/docs/code-review/tips-recipes)
  describe requesting review explicitly on a draft. Greptile is a potential
  independent reviewer, not a provider changelog feed or a migration engine.

The historical migration is Stripe's [2022-11-15 removal of
PaymentIntent.charges](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent).
The fixture README pins SDK declarations to immutable upstream commits and
explains the explicit-version, older-pin, and unknown-default controls. The old
SDKs are historical evidence, not recommended current dependencies.

## Recommended approach and alternatives

Implement a deterministic migration for the controlled fixture, with Rust
owning analysis, patch generation, command execution, and result policy. This
proves the failure-to-fix loop with inspectable evidence at low operating cost.

A dashboard containing only sample results would be quicker but would not prove
the migration. A general GitHub App, polling service, and AI editing agent would
cover more repositories but would add onboarding, authentication, isolation,
persistence, and deployment before the core behavior has been demonstrated.

## Architecture and repository boundaries

- `crates/domain`: serializable run, evidence, finding, check, patch, and
  publication-blocker models; the controlled Stripe migration decision rules.
- `apps/worker`: a local CLI that reads the fixed trusted fixture, generates the
  candidate in a disposable directory, runs verification, and writes artifacts.
- `apps/api`: a read-only operation that serves the configured local run report
  through the existing Axum/OpenAPI contract. Health retains its current meaning.
- `packages/api-client`: regenerate the committed contract and typed Fetch SDK
  from Rust; Next.js consumes it rather than defining another backend.
- `apps/app`: render a Geist dashboard with provider/version context, findings,
  evidence links, patch preview, checks, and publication blockers. Provide useful
  empty and unavailable states when the API or report is missing.
- Documentation: local quickstart, limits, verification commands, and the future
  Greptile review handoff. An implementation plan will choose exact file splits.

Use existing dependency versions wherever possible. Supplied AGENTS instructions
specify Node 26.10.0/pnpm 12.6.0, while current manifests specify Node
26.11.1/pnpm 12.11.2. Resolve this mismatch explicitly during setup without
silently editing dependency pins or CI requirements.

No production infrastructure changes are needed. Future hosting retains Rust,
Hetzner hel1, self-hosted Temporal, separate PostgreSQL persistence, and R2 EU.

## Migration and verification flow

1. Read the trusted `fixtures/stripe-migration` inputs. Record source identity
   and content fingerprints so a report identifies the exact analyzed bytes.
   Reject unsupported layouts or changed source patterns with a clear failure.
2. Record the provider change and immutable SDK evidence. Analyze the supported
   explicit `2022-08-01` client and its `charges.data[0].id` helper. Include the
   older-version control and the unknown-default control as separate findings.
3. Verify the old fixture's TypeScript and existing baseline first. Run the
   new-shape regression against the old helper and record the expected failure
   separately from verification errors. Unexpected failure causes block the run.
4. Generate a disposable candidate from the explicit target's supported inputs,
   upgrade its SDK/API version to the fixture's historical target, and rewrite
   the helper to accept a string ID, expanded Charge, or null. Generate edits
   from the supported old pattern, not by copying `after/src/latest-charge.ts`.
5. The candidate is explicitly a target-only preview. The ambiguous module is
   not silently dropped from a repository-wide upgrade or claimed unaffected.
   A package-wide SDK upgrade can change unversioned clients' defaults, so the
   unknown account version blocks publication of the overall migration.
6. Run candidate type checking and regression tests on the generated candidate.
   Verify the older API pin still has legacy handling. Compare controls without
   modifying the original fixture. Verification fixtures never call Stripe.
7. Write a versioned JSON report, a unified patch, and a Markdown PR preview.
   Include real command exit codes, bounded logs, evidence, candidate scope,
   source fingerprints, and blockers. Write atomically to an ignored local
   artifact directory. A rerun must not misrepresent a stale success as current.
8. The API and dashboard expose the report. A successful local candidate has
   passing local checks but remains held for unknown version evidence and
   independent review. The PR preview has no fabricated GitHub URL, review
   score, repository installation, polling timestamp, or customer history.

The runner executes only fixed commands against this trusted synthetic fixture.
It accepts no arbitrary repository paths or shell commands through an HTTP
request. General customer repository execution requires disposable isolation in
the later GitHub/Temporal slice.

## Product surface

The primary view is a migration workbench: the Stripe change and version range,
one generated candidate, explicit pinned/unknown dispositions, and the evidence
needed to review them. A diff preview and check list make the workflow concrete.
Developer actions include refreshing a report, opening authoritative evidence,
and inspecting the PR preview. Publishing and merging are not offered as active
actions before their prerequisites are implemented.

OpenAI is documented as the next provider rather than presented as connected.
Provider monitoring is represented honestly as a supplied historical change.
No fake operational metrics, connected repositories, or completed remote checks.

## Verification and release gates

Add meaningful Rust tests for version classification, supported transformation,
unsupported input rejection, check failures, and publication blockers. Add API
integration/contract tests and frontend response tests for missing, valid, and
invalid reports. Exercise the actual CLI against the controlled fixture and
inspect the dashboard in a browser when available.

Run required frontend formatting, type checking, builds, contract drift checks,
and workspace Rust format/Clippy/tests. Run `pnpm ci:release` for full release
verification if Docker is available; report any unavailable gate accurately.
Refresh Graft after substantial code changes. Keep migration/live-operation Nx
targets uncached. Do not weaken protected settings or checks to obtain success.

## Subsequent delivery slices

After this local loop is proven: repository-scoped GitHub App installation;
Rust authentication and authorization; durable jobs in self-hosted Temporal;
provider evidence ingestion and version scope; isolated execution; independent
Greptile review tied to the current candidate revision; and idempotent draft PR
publication. OpenAI and optional feature-adoption changes follow the same
evidence and human-review requirements. No merge automation is planned.
