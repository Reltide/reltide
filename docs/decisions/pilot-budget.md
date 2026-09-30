# MAX-11 — pilot deployment and budget

**Evidence refreshed: 27 September 2026. Status: incomplete; billable migration admission remains closed.** The owner's latest clarification selects self-hosted application PostgreSQL with the open-source `pg_clickhouse` extension on the existing production CX23, alongside Temporal and ClickStack. It supersedes the brief request for ClickHouse Managed Postgres; no managed service was provisioned. The dedicated management CX23 runs Coolify; staging is a test host. This replaces the repository's Neon target. The owner reports no retained Neon/Verda or paid registry costs, free Resend, an existing $10/month OpenCode Go subscription, and a domain still to purchase at approximately $10/year.

The sub-€100 monthly target remains a constraint. Current hosting and the planning allocation are recorded below; combined production capacity, database recovery, invoice reconciliation, and enforced spending limits are not yet validated. Neither the former €93.02 Verda estimate nor idle host samples complete [MAX-11](https://linear.app/maximebrmd/issue/MAX-11/validate-the-pilot-bill-and-define-resource-limits).

## Authenticated inventory

Official `hcloud` reads using context `reltide` and the signed-in Hetzner Console show three allocated servers in `hel1`, Finland. The visible Cloud account contains one project, `Default` (`16171545`); its CLI context name is `reltide`. The owner confirms only these Hetzner resources and R2 are infrastructure costs; the console inspection does not independently audit separate Robot/konsoleH accounts.

| Server | ID | Type / CPU | RAM | Included disk | OS image | Role |
| --- | --- | --- | --- | --- | --- | --- |
| `reltide-production` | `167541434` | CX23, 2 shared vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | Trusted production, combined test pending |
| `reltide-staging` | `167541435` | CX23, 2 shared vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | Tests and capacity experiment |
| `reltide-management` | `167550981` | CX23, 2 shared vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | Dedicated Coolify controller |

All three are running, have assigned Primary IPv4/IPv6 with `auto_delete=true`, attached Cloud Firewalls, and deletion/rebuild protection. Private network `reltide-management-private` (`12689126`, `172.30.0.0/24`) joins all three trusted hosts. No attached volumes, floating IPs, snapshots, automatic server backups, load balancers, Storage Boxes, or DNS zones were returned in this project. Included server disks are not separate billable volumes. Repeat inventory before deployment or admission:

```bash
hcloud --context reltide server list -o json
hcloud --context reltide primary-ip list -o json
hcloud --context reltide floating-ip list -o json
hcloud --context reltide network list -o json
hcloud --context reltide firewall list -o json
hcloud --context reltide volume list -o json
hcloud --context reltide image list --type snapshot -o json
hcloud --context reltide image list --type backup -o json
hcloud --context reltide load-balancer list -o json
hcloud --context reltide storage-box list -o json
hcloud --context reltide zone list -o json
hcloud --context reltide api /pricing
hcloud --context reltide server-type list -o json
```

This audit used read-only cloud and SSH commands; it did not create compute, resize a host, deploy the production stack, or change live firewall rules. [Official CLI](https://github.com/hetznercloud/cli), [Cloud API reference](https://docs.hetzner.cloud/reference/cloud).

## Guest samples and controller recovery

Read-only SSH sampling on 27 September returned these host values. Memory available comes from `/proc/meminfo`; root disk values come from `df -B1 /`. These are single samples, not sustained peak measurements.

| Host | Available / total memory | Used / total root filesystem | Current containers |
| --- | --- | --- | --- |
| Production | 3.13 / 3.73 GiB | 2.83 / 37.21 GiB | Traefik proxy and Coolify Sentinel |
| Staging | 3.18 / 3.73 GiB | 2.86 / 37.21 GiB | Proxy, Sentinel, and a 64 MiB smoke service |
| Management | 2.51 / 3.73 GiB | 7.02 / 37.21 GiB | Coolify 4.3.23, its PostgreSQL/Redis/realtime services, proxy and Sentinel |

All three reported zero swap. Production's kernel journal returned no OOM entries in the preceding 24 hours. That observation does not test the absent application, databases, Temporal, or ClickStack.

Management's controller-backup timer was active. The service reported `Result=success`, exit status 0, and last completion at `2026-09-27 12:15:33 UTC`. [MAX-26 / draft PR #16](https://github.com/Reltide/reltide/pull/16) records a fresh encrypted archive restoring the controller database, administrator/MFA state, three SSH keys, inventory, and login page locally in 6.69 seconds. This is reported MAX-26 evidence, not a new drill or a measured cold-host RTO. PR #16 was merged for human-reviewed controller setup. See the [Coolify runbook](../operations/coolify.md) for its recovery evidence and workload gates.

The signed-in Reltide Cloudflare account (`08b3e06cb2d437fff43076acee66e082`) shows the EU-jurisdiction `reltide-coolify-backups` bucket, Standard storage, public access disabled, and two encrypted objects of 94.38 KB and 91.26 KB. Its bucket-size metric still displayed 0 B; use object metadata and billed usage rather than interpreting delayed metrics as empty storage. Subscriptions show Workers Free and R2 Paid (usage billing). Billable usage displays $0.00 observed/projected for the first day of the 27 September–26 October cycle, without a usage breakdown yet. This is not a whole-month bill. The connected API credential could not read this account, so the authenticated dashboard was used rather than the connector's personal-account default.

## Placement and service boundaries

| Component | Target and acceptance condition |
| --- | --- |
| Next.js apps, Rust API/workers | Existing production CX23; CI builds and distributes images. Rust owns backend and database access. Test actual bundles and binaries together. |
| Application PostgreSQL with `pg_clickhouse` | Self-hosted on production, private access and separate credentials/storage from Temporal. Pin the extension build, verify foreign-table queries, and restore with the same extension libraries. No application database was deployed by this audit. |
| Temporal Server/UI and PostgreSQL | Production, private endpoints and separate persistence. Previous targets were Temporal v1.31.3 and PostgreSQL 16.15. Recheck supported stable releases, resolve image digests, apply matching core/visibility schemas, and test workflow/restore before implementation. These are not deployed versions or a certified pairing. |
| ClickStack | ClickHouse, OTel collector, HyperDX and MongoDB on production. Exercise ingestion, search, retention, backups and restarts alongside the application and Temporal. A quickstart alone is insufficient capacity evidence. |
| Coolify | Dedicated management CX23; builds and customer execution stay elsewhere. Controller recovery does not recover application data. |
| Artifacts and backups | Private R2 Standard buckets with immutable `eu` jurisdiction in the Reltide account. Buckets share account-wide quotas; use the EU-specific S3 endpoint. |
| Disposable execution | Fresh Finnish job-owned VMs separate from every trusted host and its private network. [MAX-12](https://linear.app/maximebrmd/issue/MAX-12/prove-hetzner-isolation-for-disposable-repository-jobs) must prove isolation before customer code runs. |

There is one production failure domain. Staging does not provide automatic failover. Resizing entails a planned interruption; it does not provide recovery or high availability. Follow [Temporal deployment guidance](https://docs.temporal.io/self-hosted-guide/deployment) and [ClickStack production guidance](https://clickhouse.com/docs/clickstack/managing/production). The capacity experiment requires its implementation design before deployment.

### Self-hosted extension decision

The selected [open-source `pg_clickhouse` extension](https://clickhouse.com/docs/products/managed-postgres/extensions/pg_clickhouse/introduction) runs inside ordinary PostgreSQL and queries a separate ClickHouse server. PostgreSQL retains application transactions, constraints and authoritative records. The extension does not automatically copy those records into ClickHouse. The capacity experiment uses a separately seeded synthetic analytics table on the existing test ClickHouse instance, a restricted read role, and explicit query limits; it does not introduce a production CDC pipeline or mix business data into ClickStack telemetry tables.

Use release [v0.10.0](https://github.com/ClickHouse/pg_clickhouse/releases/tag/v0.10.0), verified as the latest non-prerelease on 27 September, with its source and recursive dependencies pinned. Extension installation, query pushdown, failure isolation and recovery compatibility still need measured evidence. Temporal PostgreSQL does not load the extension. PostgreSQL backups preserve foreign-table definitions and mappings, not the remote ClickHouse data; production analytics retention/rebuild or backup requirements need their own evidence before that data is relied upon.

This selection adds no managed-database subscription, new server or paid CDC service to the forecast. The **€54.40/month** planning allocation remains unchanged; extra CPU, memory, disk, build and recovery work must fit the measured envelope. Any required resize changes the forecast before deployment.

## Prices and planning allocation

Authenticated `/pricing` returns EUR, 20% VAT, CX23 at €0.0088/hour or €5.49/month net, and Primary IPv4 at €0.0008/hour or €0.50/month net. The allocated full-month base is **3 × (€5.49 + €0.50) = €17.97 net**, or **€21.564 (€21.56 rounded) gross at the displayed rate**. The signed-in account Usage page shows only `Default`, **€0.70 current September usage**, and prices including 20% VAT. Prorated usage is not a full-month forecast. The invoice portal did not yield a final invoice; reconcile final tax/rounding/credits when available. Do not add VAT again to gross invoices.

R2 Standard prices rechecked on 27 September are $0.015/GB-month, $4.50/million Class A operations, $0.36/million Class B operations, and free egress. Monthly free allowances are 10 GB-month, 1 million Class A and 10 million Class B operations across the account. Billing rounds up units: even slightly exceeding free Class A operations can add $4.50 and exceed the €2 storage allocation. Reserve shared operations before crossing that boundary. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Authenticated Resend usage was 8/100 daily emails and 8/3,000 monthly. The account allows 3/3 domains; use its actual limits rather than the old one-domain assumption. The owner confirms no paid upgrade; existing consumers share the quota. [Resend pricing](https://resend.com/pricing).

The forecast uses the existing conservative **$1 = €1 planning conversion**, the owner's reported $10 OpenCode monthly cost, and a **provisional $10 annual domain**. Subscription tax and actual currency conversion require receipt reconciliation; the domain is not purchased or quoted. R2, recovery and job amounts below are cash reserves including applicable taxes/FX, not pre-tax invoices. Do not tax those reserves again.

| Monthly bucket | Planning cash (€) | Basis |
| --- | ---: | --- |
| Three Hetzner CX23 hosts and IPv4 | 21.564 | Authenticated schedule, displayed 20% VAT |
| R2 storage and operations allowance | 2.00 | Proposed shared quotas below; observed billed amount $0.00 |
| Resend | 0.00 | Owner-confirmed free plan, within authenticated quota |
| OpenCode Go subscription | 10.00 | Owner's existing $10/month subscription at planning conversion |
| Domain, annual cost amortized | 0.833333… | Provisional $10/year divided by 12 |
| Recovery reserve, separate from jobs | 8.00 | Restore VM/storage, backup growth, rounding |
| Job reserve, separate from recovery | 12.00 | ≤3 runs, each ≤€4 for VM/model/verification/retry/cleanup |
| **Monthly equivalent allocation** | **54.397333… ≈ €54.40** | Includes all owner-reported costs and reserves; domain/tax/FX remain provisional |
| **Headroom to €95 admission threshold** | **40.602666… ≈ €40.60** | Keep another €5 between threshold and €100 target |

When the $10 annual domain payment occurs, replace €0.833333… with the whole €10 payment in that month's cash check: **€63.564 ≈ €63.56**, before any receipt adjustments. Do not count both the amortized amount and the full purchase in the same cash calculation. Other current subscriptions, retained Neon/Verda resources and paid image registry costs are zero per the owner, rather than independently inspected invoices.

Included Go usage is not charged a second time as cash per token. The €12 job reserve conservatively retains the existing cash ceilings until metering is tested; Go quota consumption is tracked separately. Any paid API fallback, new registry charge, email upgrade, GitHub plan purchase or extra host requires revising the cash forecast first. GitHub Free is current; [MAX-27](https://linear.app/maximebrmd/issue/MAX-27/enable-required-ci-status-enforcement-for-the-private-repository) still requires an owner plan change before private-repository required-status enforcement. Public Team pricing starts at $4/user/month; do not assume it has been bought. [GitHub pricing](https://github.com/pricing).

## OpenCode Go candidate for MAX-20

Current [official Go documentation](https://opencode.ai/docs/go/) confirms $10/month and coding-agent API use. Its public model list returned `deepseek-v4.1-flash`; the documented endpoint is `https://opencode.ai/zen/go/v1/chat/completions`. A custom coding client needs its own user agent and stable `x-opencode-session` header. DeepSeek V4.1 Flash currently has $12/5-hour, $30/week and $60/month usage limits, with peak input/output rates $0.30/$1.20 per million tokens. Limits are metered value, not extra subscription charges. Enabled “Use balance” can fall back to paid Zen credits; require it disabled for the pilot. The privacy table lists no training and zero retention; its agreement currently runs through 30 September 2026. Recheck coverage before customer source is sent.

At the existing 100,000-input/20,000-output ceiling, worst peak uncached usage is **0.10 × $0.30 + 0.02 × $1.20 = $0.054/run**, or $0.162 for three runs, before any separately counted usage. These are calculated quota estimates, not measured runs or accuracy evidence. Personal usage shares subscription limits. Credentials, actual quota/fallback settings, Rust adapter behavior, patch quality and independent verification remain MAX-20 work. No model request or credential transfer was performed by this audit.

## Stock, resizing and disposable cost

The live API reports CX23, CX33 and CX43 unavailable in `hel1` at inspection. CPX22 (2 vCPU/4 GB/80 GB, €0.0312/hour or €19.49/month net) and CPX32 (4 vCPU/8 GB/160 GB, €0.0569/hour or €35.49/month net) report available. This is not a reservation or a verified resize transition. Recheck live price, supported transitions, architecture and quota before resource mutation.

An illustrative CPX22 allocation of four aggregate rounded billable hours with IPv4 costs `4 × (€0.0312 + €0.0008) = €0.128 net`, or €0.1536 at displayed VAT, before extra storage/snapshots/traffic. It fits the €0.50 execution cash ceiling arithmetically; fixture performance and isolation are untested. Each fresh baseline/verification/retry VM incurs separate hourly rounding within that four-hour reservation.

For production-only capacity sensitivity, CX23 → CX33 adds €3/month net; CX43 adds €10.50; CPX32 adds €30. These are price differences, not tested or authorized resize operations. CPX32 would raise the three-host base to €47.97 net (€57.564 at 20%), the monthly allocation to **€90.40**, and domain-purchase-month cash to **€99.56**. That purchase-month scenario exceeds the €95 admission threshold and must be reforecast before dispatch. Stock pressure does not authorize another region.

Allocated servers accrue charges even when powered off. Hetzner rounds each lifetime up to hours and charges Primary IPs separately. Cleanup must verify deletion, not shutdown. Alerts notify rather than enforce spending limits. [Billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

## Proposed limits to validate before admission

These are reviewable limits, not deployed controls.

| Area | Initial limit / rejection condition |
| --- | --- |
| Admission | ≤3 runs/month, ≤1 concurrent run. Reserve worst-case cash before starting; reject if billed + unsettled fixed costs + recovery reserve + active/new run reservations exceeds €95. Failed/cancelled runs consume a slot and actual spending. Settle reservations without double-counting billed amounts. |
| Per-run cash | ≤€4: model/fallback reserve ≤€2.50; execution, temporary IPs/storage ≤€0.50; R2 churn ≤€0.25; variance ≤€0.75. All include tax/FX. Included Go usage consumes quota, not a second cash charge; no automatic paid fallback. R2 actual charges also reconcile to the monthly account allocation. |
| Model and quota | ≤100,000 input tokens, ≤20,000 output tokens, and ≤€2.50 metered value across the original attempt, verification and one retry. Stop at first limit. Reserve ≥€0.40 for verification and ≥€0.60 for retry within that cap; reject if account quota or maximum in-flight response cannot fit. Include cache/tool/request costs. |
| Time | ≤4 aggregate rounded billable VM hours and ≤4 hours end-to-end including boot, fresh verification, one retry and cleanup; only one job VM at a time. Revalidate the €0.50 quote before dispatch. |
| Verification | Immutable passing baseline, independent verification in a fresh environment, ≤1 patch retry. Unknown scope/evidence, failed baseline, exhausted budget, stale base or failed checks holds publication. |
| Job artifacts | ≤1 GiB new retained artifacts/run; ≤5 billing GB-month total; ≤10,000 Class A and ≤100,000 Class B operations/run. Convert GiB to billing GB. |
| Shared R2 account | ≤40 billing GB-month; ≤100,000 Class A and ≤1 million Class B operations/month across backups, manual copies and jobs. Operations remain inside the free tier; crossing a cap closes admission pending a revised forecast. Storage-only cost at 40 GB-month is $0.45 before tax/FX. |
| Backup allocation | Controller ≤4.03 decimal GB (30 ×128 MiB daily uploads, excluding manual copies); application backups/WAL ≤14 GB; Temporal backups/WAL ≤14 GB; job artifacts ≤5 GB. Remaining 2.97 GB covers manual copies/rounding. Exceeding a cap alerts and closes admission; preserve the last recoverable backup. |
| Cleanup | Delete only job-owned VM/IP/volume/snapshot resources within 10 minutes of finish/cancel/timeout; reconcile provider state before admitting another job. Never include purchased trusted hosts or their private network. |

The €0.25/run R2 cap cannot absorb a $4.50 Class A unit; shared-operation reservations are mandatory. Reservation/metering logic was not implemented by this audit.

## Remaining acceptance evidence

1. **Billing and distribution:** reconcile final Hetzner invoices, OpenCode receipts and payment conversion; replace the domain estimate with an approved quote when selected. Record CI/image distribution and verify it adds no unbudgeted charge. Reforecast if reported paid-resource scope changes.
2. **Combined capacity:** the owner approved the original written staging spec and then clarified the self-hosted extension requirement. The revised [capacity and recovery spec](../superpowers/specs/2026-09-27-staging-capacity-design.md) and [implementation plan](../superpowers/plans/2026-09-27-staging-capacity.md) include it; review and execution-method selection remain pending. Run actual application/API/worker, application PostgreSQL with `pg_clickhouse`, separate Temporal PostgreSQL, Temporal, ClickHouse, collector, HyperDX and MongoDB together. Exercise requests, a workflow, ingestion/search, bounded foreign-table analytics, backups and controlled restarts. Record peak memory, minimum available memory, CPU, disk growth, request latency, queue delay, telemetry drops and OOMs; idle samples are not a pass.
3. **Resource controls:** specify bounded database pools, worker concurrency, service memory/process limits, collector queues, ClickHouse query/merge limits and three-day telemetry TTL in the capacity design. Proposed host stop conditions are any OOM/repeated restart, available memory <512 MiB, disk >70% or <10 GiB free, sustained CPU >80%, or failed latency/queue targets. Validate backup/restart headroom. Measure resize interruption and rollback rather than promising currently unavailable stock.
4. **Database recovery:** independently prove encrypted application/Temporal backups and WAL replay off-server, including actual RPO/RTO. Restore the application database into the pinned extension-capable image and verify its mappings and bounded foreign query against the separately seeded ClickHouse fixture. This verifies extension compatibility, not recovery of ClickHouse data from PostgreSQL backups. Daily backups alone can lose up to 24 hours; improve that claim only after WAL archiving/replay tests. Controller backups do not meet this item. Backup failure or WAL/archive growth closes admission and triggers alerts.
5. **Isolation and metering:** prove MAX-12's controls outside guest control, cancellation/orphan cleanup, hourly reservations, selected-model in-flight limits and concurrent admission rejection. Cloud Firewalls do not filter private-network or metadata traffic; guest firewall rules alone are insufficient. [Firewall FAQ](https://docs.hetzner.com/cloud/firewalls/faq/).

Capacity/recovery evidence is classified with `node tools/capacity/report.mjs --verdict .capacity/<run-id>` using the [versioned evidence contract](../maintenance.md#capacity-evidence-reports). FAIL takes precedence over missing evidence; shortened local correctness, pruning clones and unit fixtures do not establish native capacity. Missing backup, restart, recovery or native measurements remains BLOCKED. The offline evaluator does not authorize execution or close billing/admission requirements.

MAX-11 remains In Progress. Its dependent isolation, Temporal and application-database issues remain gated; this forecast does not authorize a billable job or additional provisioning.
