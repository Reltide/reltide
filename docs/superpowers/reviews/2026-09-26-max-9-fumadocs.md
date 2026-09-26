# MAX-9 implementation and review evidence

**Hosting update — 26 September 2026:** Hetzner Cloud in Finland replaces the Verda target recorded in this review. The verification evidence below is historical; production deployment remains separate work. See [the current pilot deployment decision](../../decisions/pilot-budget.md).

## Result

Fumadocs guides, generated Rust API reference, local search, Nx contract/link gates, and standalone packaging are implemented. The site is intended for Verda; production deployment and required CI wiring are subsequent work.

## Verification

Node 26.9.0, pnpm 12.6.0, and Rust 1.98.1 were used. Frozen installation, docs link/build/smoke targets, workspace typecheck/quality, full uncached build, and Rust API contract tests passed. Docs tests passed 12/12; existing API/client/graph tests passed 13/13. A disposable stale-contract checkout stopped docs preparation/build. Implementation commits used the normal hooks, including a successful MDX-only staged check.

The standalone smoke copies only runtime output plus static/public assets, supplies a minimal environment, and checks guides, health rendering, local search, unknown-slug 404, and CSS/JS assets. It runs without a Rust process or hosted credentials.

## Independent review

A fresh GPT-6 Astra reviewer found one Important issue: missing relative MDX links and query-only URLs with missing anchors were skipped by the installed link validator. Both cases were reproduced by failing regression tests, fixed, and verified with the green suites above. No Critical or Minor issues were reported. Current main's PR-title commit was integrated by a clean rebase; the upstream CI/security configuration was preserved.

## Rulings I made

- Execute the approved design inline without another plan approval — user explicitly approved implementation; redundant gates conflict with developer autonomy — cost if wrong: user may want plan detail adjusted during implementation.
- Keep preparation and link validation noncached — inexpensive commands must run fresh before build and own generated output — cost if wrong: repeated checks take additional seconds.
- Verify prose/config through real consumers instead of new source-text tests — developer instructions exclude low-impact tests mirroring implementation — cost if wrong: narrower isolated test coverage for config, covered by build/graph/hook evidence.
- Use a synchronous schema input function — official integration permits Awaitable and Ultracite rejects async without await — cost if wrong: no behavioral cost; schema remains bundled and local.
- Assert the static JSON import as Fumadocs Document with a SAFETY comment — TypeScript widens JSON literal types; Rust export drift validation is the input boundary — cost if wrong: unchecked direct script usage could accept a malformed but generatable schema; normal Nx builds verify Rust first.
- Use a top-level MDX component factory for the page-specific preload adapter — official nested example conflicts with React lint; server rendering retains identical preload behavior — cost if wrong: server-only component mapping may need adjustment when render mode changes.
- Treat the standalone runner as an acceptance test, not feature code requiring another test — Task 2 replaced baseline output before the runner existed; assertions exercise only the copied runtime — cost if wrong: a false-positive harness bug could evade author review; fresh reviewer checks it.
- Finish with a draft PR on the task branch, preserving the worktree — user authorized implementation and developer instructions include autonomous draft PRs; human merge remains required — cost if wrong: remote draft appears before the user wanted it, reversible by closing it.
- Production Verda deployment and CI enforcement remain deferred to MAX-10/platform work — MAX-9 requires portable standalone output, verified locally — cost if wrong: this PR does not establish deployed production readiness or enforced CI gates.
- Browser hydration/visual interaction is not claimed by the HTTP smoke — official Fumadocs UI and inherited tokens render, API/search/assets are verified, browser interaction was outside this smoke contract — cost if wrong: an interactive browser regression could still require follow-up.
