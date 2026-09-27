# MAX-11 — pilot deployment and budget

**Hosting decision updated:** 2026-09-27. Authenticated inspection confirms three purchased Hetzner servers in Finnish location `hel1`. MAX-26 installed the dedicated Coolify controller and connected the staging/production targets. Application capacity and the complete recurring bill still require validation. The sub-€100/month target remains a planning constraint; the previous **€93.02/month Verda estimate is superseded** and cannot validate this deployment.

## Authenticated inventory — 2026-09-27

The official `hcloud` CLI **v1.69.0**, using context `reltide`, returned:

| Server | ID | Status | Type / CPU | RAM | Included disk | OS image | Location |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reltide-management` | `167550981` | running | `cx23`, 2 vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | `hel1`, FI |
| `reltide-production` | `167541434` | running | `cx23`, 2 vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | `hel1`, FI |
| `reltide-staging` | `167541435` | running | `cx23`, 2 vCPU, x86 | 4 GB | 40 GB | Ubuntu 26.04 | `hel1`, FI |

Each server has an assigned Primary IPv4 and IPv6. All three have attached Cloud Firewalls and deletion/rebuild protection. SSH is restricted to the operator IPv4, plus the management IPv4 on workload hosts; public web/bootstrap ports remain closed. No separately attached volumes, retained snapshots, load balancers or provider backup windows were found. Guest inspection confirmed empty workload hosts before Docker installation. The controller now runs Coolify; staging runs only a harmless smoke service; production has no application workloads.

MAX-26 added the free Hetzner network `reltide-management-private` (`12689126`, `172.30.0.0/24`, EU central zone) for restricted monitoring callbacks. Guest firewall rules isolate peers because Cloud Firewalls do not filter private traffic. The controller backup bucket `reltide-coolify-backups` belongs to the owner-selected Reltide Cloudflare account (`08b3e06cb2d437fff43076acee66e082`) and uses R2 EU jurisdiction, private access, client-side age encryption and a 30-day lifecycle. See the [Coolify runbook](../operations/coolify.md) for measured recovery evidence and remaining workload deployment gates. [Hetzner network pricing](https://docs.hetzner.com/networking/networks/faq/).

The first unauthenticated attempt failed with `no active context or token`; the owner then configured local access and the reads above succeeded. Never commit or paste tokens into documentation. Repeat inspection with the same project context before deployment:

```bash
hcloud --context reltide server list -o columns=id,name,status,type,location,primary_disk_size,private_net,volumes,protection,backup_window
hcloud --context reltide network list
hcloud --context reltide firewall list
hcloud --context reltide volume list
hcloud --context reltide primary-ip list
hcloud --context reltide image list --type snapshot
hcloud --context reltide load-balancer list
```

The API confirms **`hel1` (Finland)** for all three servers and their Primary IPs. Confirm account scope and any resources in other projects before calculating the full bill. Use actual invoices/usage and resource prices, including purchased servers that remain allocated. MAX-26 configured existing hosts, created the private network and backup bucket, and purchased no additional compute. [Official CLI](https://github.com/hetznercloud/cli), [Hetzner locations](https://docs.hetzner.com/cloud/general/locations/).

## Deployment targets (placement pending capacity validation)

| Component | Decision | Cost or constraint |
| --- | --- | --- |
| Next.js apps, Rust API/workers, Temporal Server/UI | Use the already-purchased Finnish Hetzner servers after inspecting capacity and assigning trusted-service roles. Container deployment; pin OS and runtime images when selected. | The two workload hosts are CX23, 2 vCPU/4 GB RAM/40 GB, Ubuntu 26.04 x86. The prior 4-vCPU/16-GB capacity assumption does not apply. Load-test before deciding whether production can colocate all durable services; do not buy or rescale resources from the old plan. |
| Coolify management | Dedicated existing CX23; Coolify 4.3.23, private SSH access, encrypted daily R2 EU controller backup. | €5.99/month net server + IPv4 included in the three-host base. Never place application databases, builds or customer execution on the controller. |
| Temporal persistence | Target self-hosted PostgreSQL **16.15** on a trusted Hetzner host, separate from the application DB, with persistent storage sized after inventory. Target Temporal Server **v1.31.3** (`temporalio/server`, matching `admin-tools` schema tools); PostgreSQL visibility store, no Elasticsearch. Pin images by digest at deployment. These are **targets, not deployed versions**. | Temporal's current sample pairs **v1.31.0** with PostgreSQL **16**, and its sustained-workload guide uses `temporalio/server` with managed schema updates. The v1.31.3 + 16.15 patch pairing is a reasoned target, **not an explicitly certified combination or tested deployment**; apply core and visibility schemas and run a workflow/restore smoke test before accepting it. High availability remains unproven until placement and recovery are tested. [Temporal sample versions](https://github.com/temporalio/samples-server/blob/main/compose/.env), [PostgreSQL compose](https://github.com/temporalio/samples-server/blob/main/compose/docker-compose-postgres.yml), [Temporal deployment](https://docs.temporal.io/self-hosted-guide/deployment), [Temporal v1.31.3](https://github.com/temporalio/temporal/releases/tag/v1.31.3), [PostgreSQL 16.15 release](https://www.postgresql.org/docs/16/release-16-15.html), [official image tag](https://hub.docker.com/v2/repositories/library/postgres/tags/16.15). |
| Host storage and runtime images | Inventory included server disks, attached volumes, backups, and snapshots. Select an image-distribution method compatible with the Hetzner placement policy. | Do not carry over separate Verda OS-volume or registry charges. No runtime registry is selected by this update; record placement, access, retention, and cost before deployment. |
| Application DB | Neon **Launch**, PostgreSQL **17**, `aws-eu-central-1` (Frankfurt), fixed 0.25 CU and scale to zero after inactivity. No Temporal tables in Neon. | **$0.106/CU-hour**, **$0.35/GB-month** storage, **$0.20/GB-month** instant-restore history, **$0.09/GB-month** snapshots; no monthly minimum. [Neon pricing](https://neon.com/pricing), [regions](https://neon.com/docs/introduction/regions), [Postgres 17 availability](https://neon.com/blog/postgres-17). |
| Artifacts and backup objects | Cloudflare R2 **Standard**, bucket(s) created with immutable `eu` jurisdiction; 5 GB-month artifacts + 5 GB-month encrypted PostgreSQL backups across the account. Use the EU-specific S3 endpoint. | **$0.015/GB-month** after 10 GB-month free; 1 million Class A and 10 million Class B operations free monthly, then **$4.50/million** and **$0.36/million**; egress free. Free tier is account-wide for Standard, and billing rounds up units. EU jurisdiction guarantees storage in the EU; a location hint alone does not. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/). |
| Transactional email | Target **Resend Free** via API, for transactional mail only. | **$0/month** for up to **3,000 emails/month and 100/day**. Pro is **$20/month** for 50,000/month and is outside this envelope. Resend stores message content, logs, webhook payloads, and account data in the **US**; an EU sending region changes routing, not storage. Review this transfer before sending personal data. [Resend pricing](https://resend.com/pricing), [Resend data location and DPA](https://resend.com/security/gdpr). |
| Disposable job environment | A fresh Hetzner Cloud VM in Finland for each job and independent verification, separate from trusted servers; at most one concurrent job VM. Existing purchased servers remain outside disposable cleanup. | The VM type, image, price, quota, and isolation boundary must be verified in MAX-12. The existing €0.50/run execution allowance is a **cap to validate**, not a Hetzner quote. |

The Neon, R2, Resend, and Temporal version assumptions above are carried forward from 2026-09-25; this provider change does not establish new service pricing or a tested deployment. External AI inference remains permitted, with no selected provider/model or fixed AI charge. Record its published prices, processing terms, and metering before billable work.

## Monthly envelope pending complete bill

The authenticated `/v1/pricing` read returns **EUR**, CX23 in `hel1` at **€0.0088/hour or €5.49/month net**, and Primary IPv4 at **€0.0008/hour or €0.50/month net**. Three servers plus their three IPv4 addresses therefore have a full-month base of **€17.97 net**. The API reports a **20% VAT rate**, giving **€21.564 (€21.56 rounded) gross** for that base. This is a live price schedule, not an invoice or the full deployment cost; do not substitute the earlier Finnish 25.5% model for the API gross amounts. Billing/tax treatment must be confirmed against actual invoices. [Cloud API reference](https://docs.hetzner.cloud/reference/cloud).

Let **H** be the full recurring pre-tax hosting/image/domain cost: every retained purchased server, separately charged storage/IPs/backups/snapshots, any load balancer, registry, and expected traffic overages. For the observed project, H starts at **€17.97 net plus U**, where **U** is the unquoted additional hosting/image/domain allowance. Use invoices/account rates and the provider's hourly rounding/monthly caps. Prepayment or a completed purchase does not make ongoing resources free. Do not double-count an included server disk as a separately purchased volume.

The unchanged non-hosting planning assumptions are: USD conversion at **$1 = €1** as a buffer, Neon at **120 active hours × 0.25 CU** with 1 GB-month each of data, restore-history changes, and snapshot storage; R2 at most 10 GB-month and within account-wide free operation quotas; Resend Free. Revalidate them before application deployment. Controller backups are capped at 128 MiB per archive and expire after 30 days; a daily schedule retains at most about 3.75 GiB at that ceiling, inside the existing backup allowance. Manual backups and application backups share the account allowance and require separate growth tracking.

| Monthly bucket | Calculation | Budget (€) |
| --- | --- | ---: |
| Hetzner purchased servers + IPv4 | 3 × (€5.49 + €0.50), monthly net price schedule | **17.97** |
| Additional hosting, images, and domain | Storage/backups/registry/domain/traffic and any other project resources | **U — pending** |
| Neon Launch | 120 h × 0.25 CU × $0.106 + $0.35 + $0.20 + $0.09 | 3.82 |
| R2 artifact/backup overage allowance | Account-wide free tier assumed; allowance for small overages | 2.00 |
| Resend Free | Below 3,000/month and 100/day | 0.00 |
| **Fixed services and storage** | | **23.79 + U** |
| **Recovery reserve, separate from jobs** | Restore drill, backup growth, temporary recovery VM/storage | **8.00** |
| **Job budget, separate from recovery** | At most 3 admitted runs × €4.00 maximum | **12.00** |
| **Total before modeled VAT** | Rounded planning allowances | **43.79 + U** |
| **Modeled cash total** | Apply each service's actual tax treatment; Hetzner API base uses 20% | **Pending** |
| **Headroom to €100** | Requires actual hosting, tax, and currency treatment | **Pending** |

The old planning factor was Finnish VAT at 25.5%, but the live Hetzner schedule reports 20%. Actual invoices, billing country, reverse-charge treatment, and deductibility determine the cash bill; do not apply a uniform tax factor without evidence. Do not add VAT a second time to gross invoice amounts. [Finnish Tax Administration](https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/).

Resend Pro and an always-active Neon instance exceed their existing allowances and require recalculation. The three-run allocation is a maximum, not an entitlement: no billable migration is admitted until the full Hetzner forecast is validated. [Neon pricing](https://neon.com/pricing), [Resend pricing](https://resend.com/pricing).

## Admission and per-run caps

Keep **at most three runs/month** and **one concurrent run**, only when `already billed + committed fixed costs + €8 recovery reserve + remaining admitted job caps`, with applicable taxes/currency, stays below **€95**. The €5 difference to the target absorbs billing movement. A failed or cancelled run consumes its actual spending and does not grant a free replacement slot.

| Guardrail per admitted run | Limit |
| --- | --- |
| Total incremental spending | **€4.00** at the planning FX rate: AI ≤€2.50, disposable execution and temporary storage/IPs ≤€0.50, R2 churn ≤€0.25, variance ≤€0.75. These categories are additive and require tested metering. |
| Model | Across the original attempt, verification, and one retry: ≤100,000 billable input tokens, ≤20,000 billable output tokens, and ≤€2.50 projected cost; stop at the first limit. Reserve ≤€0.40 of that model cap for verification and ≤€0.60 for retry. The selected provider's maximum possible in-flight output must fit the remaining balance before each request. |
| VM and elapsed time | One fresh cloud VM at a time; ≤4 aggregate **billable** VM hours and ≤4 hours end-to-end. Include boot, verification, retry, cleanup, and rounding for each separate VM in the reservation. Confirm that the selected Hetzner price and separately charged resources fit €0.50 before dispatch. |
| Verification and retry | One bounded verification cycle, ≤30 VM minutes and the ≤€0.40 model subcap; at most one retry, with its own ≤€0.60 model and ≤2 VM-hour subcaps. These are **inside**, not in addition to, the model and VM totals. |
| Artifacts and cleanup | ≤1 GiB new retained artifacts/run, ≤10,000 R2 Class A and ≤100,000 Class B operations. Expire artifacts to stay within 10 GB-month. Delete only job-owned disposable VMs and their temporary volumes/IPs/snapshots within 10 minutes of finish/cancel/timeout; confirm cleanup before admitting another job. Never delete a purchased trusted server through the job reconciler. |

AI price sensitivity before choosing a provider: if its published rates are `p_in` and `p_out` USD per million tokens, the run's maximum token quantities would cost `0.10 × p_in + 0.02 × p_out` euros at the planning FX rate, before any cache, tool, or request fees. Each $1/million rise in the input rate adds €0.10 at that ceiling; each $1/million rise in output adds €0.02. The selected model must fit the **€2.50 total AI cap including verification and retry** at its published rate, or the token/attempt limits must be lowered before the pilot.

Hetzner bills an allocated server even when powered off; disposable cleanup must confirm deletion. Servers have hourly rounding and a monthly price cap; Primary IPs are separate billable resources. Spending alerts notify rather than enforce a hard cap. These terms replace the previous provider's prepaid-balance assumptions. A hard €4/run guarantee still requires tested reservations and bounded in-flight spending. [Hetzner billing FAQ](https://docs.hetzner.com/cloud/billing/faq/).

## Isolation, backup, and deployment gates

- **Execution boundary:** demonstrate MAX-12 before customer code runs. Hetzner Cloud Firewalls do not filter private-network traffic or metadata-server requests, and Hetzner Cloud does not support nested virtualization. Keep disposable guests off trusted private networks, keep privileged credentials outside guests, and prove controls outside guest control where required; do not treat a shared-host container or a guest firewall as the isolation boundary. [Firewall FAQ](https://docs.hetzner.com/cloud/firewalls/faq/), [server FAQ](https://docs.hetzner.com/cloud/servers/faq/).
- **Temporal PostgreSQL:** make an encrypted whole-cluster backup to a separate R2 EU-jurisdiction backup bucket daily; retain ≤5 GB-month on average. Check backup success daily and restore to a disposable Hetzner VM monthly. Planning RPO remains up to 24 hours after a successful backup; RTO is unmeasured until the first drill. Record actual failure domains from inventory; multiple purchased servers alone do not establish high availability.
- **Neon application DB:** retain the 7-day restore-window and one scheduled-snapshot target; validate actual restore configuration, storage use, and an application restore. Application tables remain separate from Temporal persistence. [Neon pricing](https://neon.com/pricing).
- **Before deployment:** repeat authenticated inventory and check other account projects; validate roles, capacity, Ubuntu 26.04/runtime compatibility, disk sizing, network/firewall configuration, backups/deletion protection, quota, and actual resource bill. Record the image-distribution decision and pin deployed images. Initialize Temporal core/visibility schemas using matching tools; complete a workflow, inspect visibility, and demonstrate backup/restore with the target versions. Load-test the actual chosen placement; the old 4-vCPU/16-GB sizing is not a discovered Hetzner configuration. Confirm Neon EU, R2 EU jurisdiction and account-wide free-tier eligibility, Resend limits/transfer terms, actual tax/FX/domain/traffic costs, and the complete sub-€100 forecast. Reopen MAX-11 for this evidence before treating its budget gate as complete.
- **Before billable AI work:** record provider/model/version, input/output/cache/tool prices, retention/residency terms, and a tested worst-case spend limiter. Reject new jobs if model, execution, R2, email, recovery, or total allowances cannot be enforced.

This decision records the three-host base and completed controller setup. Controller recovery evidence does not establish application or Temporal recovery, execution isolation, high availability, or a validated monthly total. MAX-11 remains open for the complete bill and capacity/admission evidence.
