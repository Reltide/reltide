<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

## API Sync architecture

- The first milestone is an evidence-backed Stripe migration draft PR for a controlled TypeScript GitHub repository. The invited MVP also covers OpenAI; a human reviews and merges every PR.
- Next.js in `apps/app`, `apps/web`, and `apps/docs` renders UI and documentation. Business logic, authentication, authorization, GitHub webhooks, persistence, orchestration, and workers belong in Rust. Do not add a second application backend or database access in Next.js. The docs search route is a documentation index only.
- Platform compute, self-hosted Temporal, its PostgreSQL, and disposable execution environments target Verda in Finland. The application database targets Neon EU and private artifacts target Cloudflare R2 EU jurisdiction. External GitHub, provider sources, AI inference, and Resend remain integrations. Do not substitute Vercel hosting, Temporal Cloud, or a managed authentication backend.
- Do not weaken verification, alter protected CI/security settings to make a migration pass, or publish a PR when the baseline, evidence, version scope, or independent checks are incomplete.

## Repository commands

- Use Node `26.9.0` and pnpm `12.6.0`. Install with `pnpm install --frozen-lockfile` from a clean checkout. Versions are exact in manifests and resolved in `pnpm-lock.yaml`.
- Discover projects and targets with `pnpm nx show projects --json` and `pnpm nx show project <name> --json`. Run `pnpm build`, `pnpm typecheck`, and `pnpm check`; use `pnpm nx run <project>:<target>` for one project.
- `apps/app` uses port 3000, `apps/web` uses 3001, and `apps/docs` uses 3004. The initial shells require no hosted service or credentials.
- Frontend linting and formatting use Ultracite with Oxlint and Oxfmt. Type checking is separate. Do not add Biome, ESLint, Prettier, or Turborepo configurations. Rust checks, once the Cargo workspace exists, are `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, and `cargo test --workspace --locked`.
- Nx affected checks must include manifests, lockfiles, toolchains, shared config, and generated client inputs. Resource provisioning, migrations, notifications, and live-service operations must never be cached as reusable results.

## Tooling entry points

- Start with Graft for repo context as described above. Use the `nx-workspace`, `nx-generate`, and `nx-run-tasks` skills for Nx discovery, scaffolding, and task execution.
- Use `vercel:nextjs` and `vercel:next-forge` for frontend guidance, while keeping the Rust and Verda boundaries above. Use current official Fumadocs documentation for `apps/docs`.
- Use `rust-best-practices`, `temporal:temporal-developer`, `verda-cloud`, `neon-postgres:neon-postgres`, and `cloudflare:cloudflare` for their respective implementation areas. Use `ultracite` for frontend quality configuration.
- Use the connected Linear tools for issue context and status. Check official documentation and current stable releases before changing dependencies or provisioning. Pin deploy image versions or digests and follow Temporal's supported schema and replay upgrade sequence.
- TypeScript 5.9.3 is temporarily pinned because Nx 23.2.1's generator fails with TypeScript 7.0.2 (`ts.readConfigFile is not a function`). Revisit this compatibility on Nx upgrades; do not silently freeze it indefinitely.
