# Coolify operations — MAX-26

Deployment inspected on **27 September 2026**. Coolify runs on the existing management server; no application, database, build or customer execution runs there. The owner selected **private SSH access for now**. A public HTTPS hostname is intentionally deferred; do not open the bootstrap/dashboard ports or create DNS records as part of routine maintenance.

## Hosts and access

| Role | Hetzner ID | Public IPv4 | Private IPv4 | Purpose |
| --- | --- | --- | --- | --- |
| Management | 167550981 | 89.167.70.241 | 172.30.0.2 | Coolify and supporting containers |
| Staging | 167541435 | 2.29.40.210 | 172.30.0.3 | Staging deployment target; harmless smoke service |
| Production | 167541434 | 2.29.45.211 | 172.30.0.4 | Production deployment target; no application deployed |

All are existing CX23 servers in `hel1`, with Ubuntu 26.04.1, 2 shared CPUs, 4 GB memory and a 40 GB included disk. All have deletion/rebuild protection. Their Hetzner firewalls allow operator SSH; workload hosts also allow management-source SSH. Web, database and bootstrap ports remain closed on IPv4 and IPv6. If the operator IP changes, update the allowlists through the authenticated Hetzner Console/CLI before attempting access.

Open the dashboard through an authenticated SSH tunnel:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:8000:127.0.0.1:8000 \
  -L 127.0.0.1:6001:127.0.0.1:6001 \
  -L 127.0.0.1:6002:127.0.0.1:6002 root@89.167.70.241
```

Visit `http://127.0.0.1:8000`. SSH encrypts traffic crossing the network; HTTP is limited to loopback at each end. Google Authenticator 2FA is confirmed and public registration is disabled. The initial administrator password was removed from the controller's `.env*` bootstrap variables after setup. The temporary setup API token is revoked and the administrative API is disabled after verification.

Recovery material is outside Git and the server, in the operator's private local folder `~/.local/share/reltide/coolify-recovery/2026-09-27/` (directories 0700, secrets 0600). It contains `administrator.json`, confirmed 2FA recovery codes, the two dedicated target keys, `recovery.agekey`, the encrypted backup and backup metadata. The setup QR HTML was removed after the owner confirmed enrollment. Copy this folder into the owner's normal secure offline/password-manager backup process; losing its age identity prevents backup decryption. Never put the identity, APP_KEY, API keys or codes in a ticket, PR, log or repository.

Each target has a distinct ED25519 key, stored encrypted in Coolify. Its authorized-key entry permits the management public IPv4 only, with agent, port and X11 forwarding and user RC disabled. Existing operator keys remain available for recovery. Coolify currently requires privileged target access; the controller is therefore a trusted management system. Builds remain in CI, and these hosts are not dedicated build servers.

## Versions and network controls

The checked-in files under [`infra/coolify`](../../infra/coolify) record the deployment and the review fixes awaiting rollout as identified below:

- Coolify **4.3.23**, PostgreSQL 15, Redis 7 and realtime **1.0.20** use exact image digests in `docker-compose.custom.yml`. The observed deployment still uses realtime **1.0.19**; the reviewed **1.0.20** patch awaits host rollout and live acceptance.
- Traefik **3.7.13** uses an exact digest on all hosts. The installer's 3.6 branch was replaced because its security support ended. [Supported Traefik releases](https://doc.traefik.io/traefik/deprecation/releases/), [3.7.13 release](https://github.com/traefik/traefik/releases/tag/v3.7.13).
- Docker Engine **29.8.1**, containerd **2.3.6** and Compose **5.5.1** were installed from Docker's official Ubuntu repository. Normal OS security maintenance remains enabled.
- Coolify-managed Sentinel **1.0.1** and helper **1.0.17** were observed. Unlike the supplied compose images, upstream can update these version-tagged helpers independently of the disabled controller auto-update setting. Inspect their versions/digests during maintenance; do not claim all helper updates are disabled. [Coolify 4.3.23 source](https://github.com/coollabsio/coolify/tree/v4.3.23).

Controller ports 8000, 6001 and 6002 bind only to loopback. Its proxy binds web ports to loopback, and the Traefik dashboard port is not published. The only private listener is `172.30.0.2:9800`: the file provider permits authenticated Sentinel POST callbacks and a minimal health GET from `.3` and `.4`. Other paths return 404; missing Sentinel authentication returns 401.

The reviewed proxy definitions disable Traefik's unused API/dashboard with `--api=false`, exclude the proxy container itself from Docker discovery with `traefik.enable=false`, and remove its router/service labels. `api.insecure=false` alone did not protect the earlier `api@internal` router on HTTP port 80: without an explicit rule, Docker discovery supplied a default host rule that clients could match with a crafted Host header. The ping healthcheck and application Docker/file routing remain enabled. These proxy fixes await installation through Coolify's proxy configuration editor/API on all three hosts. Keep public web ingress closed until acceptance verifies `/dashboard/`, `/api/http/routers` and `/api/rawdata` return 404 for the proxy's default host and `coolify-proxy`/`traefik-coolify-proxy` Host headers, while a legitimate application route and `/ping` remain healthy. Inspect regenerated proxy configuration after Coolify updates. [Traefik API configuration](https://doc.traefik.io/traefik/v3.7/reference/install-configuration/api-dashboard/)

Network `reltide-management-private` (`12689126`, `172.30.0.0/24`) is delete-protected. Hetzner private networks are isolated but **not encrypted**. Only health/monitoring uses this private HTTP listener; operator administration uses SSH. Private resource metadata and Sentinel bearer credentials remain inside this trusted network. [Hetzner network FAQ](https://docs.hetzner.com/networking/networks/faq/).

Cloud Firewalls do not cover private traffic. `private-network-firewall.sh` atomically installs INPUT and DOCKER-USER restrictions, preserving other Docker rules. Target peers cannot open each other's SSH or container ports. The management callback is the sole allowed new private container connection. `docker-firewall.conf`, installed as `/etc/systemd/system/docker.service.d/reltide-firewall.conf`, makes successful rule installation a prerequisite for Docker startup. Install the script as `/usr/local/sbin/reltide-private-firewall`, set `/etc/reltide/host-role`, install/enable its unit, and run `systemctl daemon-reload` before restarting Docker. Do not remove this drop-in while the private network is attached.

## Deployment separation

Project **Reltide** has distinct `staging` and `production` environments and deployment targets. Persistent storage roots are `/data/reltide/staging/volumes` on staging and `/data/reltide/production/volumes` on production. Reserved host secret directories are `/etc/reltide/staging/secrets` and `/etc/reltide/production/secrets`, mode 0700. Actual application credentials are created in their environment at deployment; there are no application credentials or databases to copy between these empty targets. Do not create project-wide production secrets or share database volumes across environments.

The staging smoke service uses `staging-smoke.compose.yml`: digest-pinned whoami **1.12.0**, read-only filesystem, dropped capabilities, no new privileges, 64 MiB limit, and loopback port 18080. Verify with:

```bash
ssh root@2.29.40.210 'curl -fsS http://127.0.0.1:18080/'
```

No public route is needed. Stop/delete this named smoke service through Coolify when the first real staging application replaces it. Publish prebuilt application images from trusted CI; never execute untrusted customer repositories on these hosts.

## Backups and recovery

`reltide-controller-backup.timer` runs daily at **02:15 UTC**, with up to five minutes of jitter and persistent catch-up. Its service makes a custom-format PostgreSQL dump and captures the matching `.env`/APP_KEY, Coolify SSH keys, upstream and custom compose files, proxy configuration, and host monitoring/firewall/backup configuration. It excludes SSH multiplex sockets. A lock prevents overlap; temporary plaintext is root-only and removed on exit.

The archive is encrypted with age before upload. The server holds only the **public recipient** in `/etc/reltide/recovery-recipient.txt`. Rotate the bucket credential at least quarterly and after any controller compromise, verifying a new upload before revoking the previous credential. Bucket-scoped object credentials live in `/etc/reltide/controller-backup.json` (0600), using `https://<account-id>.eu.r2.cloudflarestorage.com`. The owner-selected **Reltide Cloudflare account** (`08b3e06cb2d437fff43076acee66e082`) owns bucket `reltide-coolify-backups`, which has immutable **EU jurisdiction**, no custom public domain and disabled `r2.dev` access. Create future application and Temporal backup buckets in this same Reltide account, with separate environment credentials. The `controller/` lifecycle expires objects after 30 days and incomplete multipart uploads after one day. The script rejects archives above 128 MiB; daily backups at that ceiling use approximately 3.75 GiB over 30 days. Manual copies also consume the shared allowance.

Coolify's **S3 Storage → Reltide R2 Backups** entry (`kevnpeounkmfz4ld62l5pqai`) connects to this same bucket with the Reltide account's EU endpoint, region `auto`, and the existing bucket-scoped credentials. Coolify encrypts these credentials in its database; credential rotation must update both this entry and the host's credential file. Connection validation and a temporary object's upload, download, and deletion passed on 27 September 2026.

**Settings → Backup** also runs a native `coolify-db` backup at **03:15 UTC** (`15 3 * * *`, schedule `yxk2omsi9btdu9psblt8xcpk`), with S3 enabled for **Reltide R2 Backups**. This schedule appears under the storage's **Resources** tab and its execution history shows local and S3 availability. Coolify retains at most 3 local backups, 3 days or 0.25 GB locally, and 30 backups, 30 days or 1 GB in S3; the first reached limit applies. Its timeout is 600 seconds and its missing-backup alert threshold is two days. Native objects use `data/coolify/backups/coolify/coolify-db-hostdockerinternal/`, with retention enforced by Coolify separately from the `controller/` R2 lifecycle.

Native PostgreSQL `.dmp` files contain Coolify's encrypted secret values, but have no age wrapper and exclude the APP_KEY and host configuration. They use HTTPS to the private EU bucket and [R2's automatic encryption at rest](https://developers.cloudflare.com/r2/reference/data-security/). Continue the **02:15 UTC age-encrypted recovery bundle** above to preserve the matching key, SSH files, and configuration required for a full restore. Its archives remain separate from Coolify's native backup history. The first native run on 27 September 2026 showed **Success / S3 Available**; the 323,467-byte object downloaded from R2 matched the local dump's SHA-256 and passed the isolated administrator/MFA/SSH-key/inventory/login restore drill in **9.29 seconds**. A fresh encrypted bundle also captured the new schedule.

```bash
ssh root@89.167.70.241 'systemctl start reltide-controller-backup.service'
ssh root@89.167.70.241 'cat /var/lib/reltide-controller-backup/last-success.json'
ssh root@89.167.70.241 'systemctl list-timers reltide-controller-backup.timer'
```

The success record contains object key, SHA-256, size and time, after upload/HEAD checks. RPO is up to 24 hours after a successful daily backup; this is not continuous replication. A separate host monitor alerts when the verified upload is more than 26 hours old. Check the journal after a failed job and resolve it before accepting a fresh RPO.

For each monthly drill and before an upgrade, retrieve the recorded object on the operator machine and verify its SHA-256 against the record. For example, with the recorded key substituted and Wrangler authorized for the Reltide account (older personal-account OAuth grants cannot access it):

```bash
umask 077
CLOUDFLARE_ACCOUNT_ID=08b3e06cb2d437fff43076acee66e082 \
  wrangler r2 object get reltide-coolify-backups/controller/YYYY/MM/DD/OBJECT.tar.gz.age \
  --jurisdiction eu --remote --file controller.tar.gz.age
shasum -a 256 controller.tar.gz.age
age --decrypt -i /secure/path/recovery.agekey -o controller.tar.gz controller.tar.gz.age
mkdir -m 700 restored-controller
tar -xzf controller.tar.gz -C restored-controller
python3 infra/coolify/restore-drill.py restored-controller /secure/path/administrator.json
```

The drill rejects remote Docker endpoints, pins a local Unix socket, and uses an internal Docker network with isolated gateway mode. It restores into a fresh PostgreSQL container, validates the administrator password and confirmed 2FA secret, decrypts all target keys with the recovered APP_KEY, checks inventory and serves the restored login page. Its current pilot acceptance profile requires three servers, at least three SSH keys and at least one deployment across Coolify's separate services and applications; replacing the smoke service with an application satisfies that profile. This is a pilot sanity check, not a complete inventory comparison; revise the profile when the topology changes. It starts no scheduler, queue worker or SSH operation, publishes no ports, and removes only its uniquely named containers/network and anonymous volumes. Delete extracted plaintext after the drill; retain the encrypted archive and result.

The 27 September drill retrieved and decrypted an encrypted archive from R2, restored three servers and one staging service, verified the administrator/MFA state and decrypted three SSH keys. The first database/cryptographic drill took 61.29 seconds including image downloads. A repeat including the restored HTTP login page passed in 11.31 seconds. After the owner selected the Reltide Cloudflare account, the earlier encrypted archive was copied there and a fresh 91,260-byte backup was downloaded and decrypted from that account; its complete data/MFA/key/login drill passed in **6.69 seconds**. The temporary personal-account bucket and its credential were removed only after verification. This measures local data recovery, **not a cold replacement-server RTO**; DNS/IP replacement and full disaster recovery remain unmeasured.

For an actual controller loss, stop the old controller before permitting the replacement to contact targets. Recover onto an authorized management host with the same pinned images. Restore the database and matching `/data/coolify` files from one archive, including ownership/modes and APP_KEY; never generate a new APP_KEY over a restored database. Restore `/etc/reltide`, scripts, systemd units, Docker configuration and the firewall drop-in; adapt private/public addresses and SSH source allowlists if the host changed. Restore the DB before starting the controller's scheduler/queue. Validate login/MFA and both dedicated keys, then start the pinned compose stack and timers. Review any credentials included in the snapshot and rotate them if compromise caused the loss. Keep the private age identity off the replacement host.

**This backup contains no application or Temporal database data, application volumes or WAL.** Those services require their own host-managed backup/WAL archiving, retention and restore checks that run without Coolify. Their deployment must not be accepted based on this controller drill. No application database was provisioned by MAX-26.

## Monitoring and update procedure

Each host runs `reltide-monitor.timer` every five minutes. Three consecutive checks alert on root disk ≥80%, memory ≥85% or one-minute load ≥1.5 per CPU. Production independently checks controller health and alerts after two failures; recovery sends one notification. Unresolved alerts repeat daily. State updates preserve successful deliveries and retry individual failures without blocking other checks. State and the lock live in `/run/reltide-monitor`, created by the service's `RuntimeDirectory` and preserved between timer invocations, so a full root filesystem does not prevent their allocation. Reboot clears this state and restarts consecutive-check counts. If runtime state writes fail, the monitor attempts notifications for every current failure immediately, reports the state error and exits unsuccessfully; notifications can repeat until storage recovers. Journald and service failure status expose delivery and state errors.

The service also uses `PrivateTmp=disconnected` so its private temporary directories use tmpfs instead of allocating on the host's root disk. This preserves isolation during disk pressure. The management host reports systemd 259.5, which supports this setting. [systemd execution settings](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml).

The PR review follow-up changes the monitor state location, temporary-directory backing and restore acceptance profile. These fixes have local regression coverage and await installation on the hosts; the earlier live acceptance checks below used the preceding monitor. Install the updated `monitor.py` as `/usr/local/sbin/reltide-monitor` and the updated service unit on each host, run `systemctl daemon-reload`, then verify the next timer invocation and `/run/reltide-monitor` state. The first invocation starts fresh consecutive-check counts. The restore drill runs from the updated repository checkout.

Alerts use a sending-only Resend key restricted to the existing verified `gloups.app` domain, with `ops@gloups.app` as sender and the approved administrator email as recipient. The secret is in `/etc/reltide/alerts.json` (0600), outside Git. Coolify's own deployment/backup/server failure notifications use the same approved channel. The five-minute host timers run independently of Coolify. A simultaneous production and management outage cannot notify through this design; it is not an external third-party uptime service.

Acceptance checks on 27 September confirmed delivery of Coolify's test mail, labeled injected resource failure/recovery messages, and labeled **actual controller stop/recovery** messages. Staging continued serving while the controller was stopped. Private peer SSH and proxy ports were blocked, the private callback enforced route/auth restrictions, public IPv4 dashboard/web ports were blocked, and sampled IPv6 dashboard ports were blocked. Staging survived both a Docker stop/start and a reboot, with the firewall active before Docker. Repeated rule installation preserved the Docker hook.

Before each controller/proxy update:

1. Review current official releases, supported branches and migration notes; select exact images/digests. Coolify controller auto-update is disabled. Check upstream-managed Sentinel/helper versions separately.
2. Confirm resource headroom and healthy targets. Take an encrypted backup, download it and run the restore drill. Record the previous image digests and matching snapshot.
3. Update the tracked override/proxy configuration through a reviewed PR. Preserve loopback bindings, private callback rules and the Docker firewall dependency. Use Coolify's proxy configuration editor/API for proxy changes; do not reset to the public defaults.
4. Apply the pinned controller compose files with the matching `.env`. Inspect health, migration results, MFA login, target connectivity, metrics, staging smoke, alerts and backup freshness. Verify public/private port restrictions after Docker changes.
5. If validation fails, stop the new controller. Restore the prior **database and matching configuration snapshot together** and its recorded image digests; simply downgrading an image after schema migration is not a safe rollback. Validate through SSH before resuming scheduler/queue operations. Target workloads continue independently unless explicitly redeployed.

An initial sample after a controller restart used about **1.32 GiB of 3.73 GiB host memory** and **7.01 GiB of 37.21 GiB root filesystem**. This is a point-in-time observation, not a production capacity test. The three-server base is **€17.97/month net**; see the [pilot forecast](../decisions/pilot-budget.md) for shared backup allowances and the remaining complete-bill gate.

Repository verification includes `RELTIDE_PROXY_DOCKER_TEST=1 python3 -m unittest discover -s infra/coolify -p 'test_*.py'`, shell syntax checks, compose validation, and `pnpm ci:release`. The Docker flag enables the local routing regression: ephemeral containers from the pinned images bind only to loopback, test all three proxy definitions and a legitimate application route, then clean up. Without the flag, that integration check is explicitly skipped. Live provisioning, notifications and backup operations are deliberately outside cached Nx targets.
