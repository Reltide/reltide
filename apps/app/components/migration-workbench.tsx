import type {
  FindingDisposition,
  MigrationReport,
  VerificationStatus,
} from "@repo/api-client";
import { ButtonLink } from "@repo/design-system/components/ui/button";

import { MigrationChecks } from "./migration-checks";
import { DiffPreview, Fingerprints, PrPreview } from "./report-previews";

const dispositionLabels: Record<FindingDisposition, string> = {
  migrate: "Migrate explicit target",
  require_version_evidence: "Version evidence needed",
  retain_legacy: "Retain legacy handling",
};
const verificationColors: Record<VerificationStatus, string> = {
  failed: "text-destructive",
  locally_verified: "text-success",
  not_run: "text-foreground",
};
const verificationLabels: Record<VerificationStatus, string> = {
  failed: "Local verification failed",
  locally_verified: "Locally verified",
  not_run: "Local verification not run",
};

export const MigrationWorkbench = ({ report }: { report: MigrationReport }) => {
  const { plan } = report;
  const created = new Date(report.created_at_unix_ms);
  return (
    <div className="space-y-6">
      <section className="bg-surface grid gap-6 rounded-lg border p-6 md:grid-cols-[1fr_auto]">
        <div>
          <p className="geist-label text-muted-foreground mb-3 uppercase">
            Supplied historical change · Stripe
          </p>
          <h2 className="geist-heading-section">
            PaymentIntent.charges → latest_charge
          </h2>
          <dl className="mt-5 flex flex-wrap gap-x-10 gap-y-4">
            <div>
              <dt className="geist-copy-small text-muted-foreground">
                Stripe SDK
              </dt>
              <dd className="mt-1 font-mono text-sm">
                {plan.source_sdk_version} → {plan.target_sdk_version}
              </dd>
            </div>
            <div>
              <dt className="geist-copy-small text-muted-foreground">
                Explicit API version
              </dt>
              <dd className="mt-1 font-mono text-sm">
                {plan.source_api_version} → {plan.target_api_version}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-col items-start gap-3 md:items-end">
          <span
            className={`geist-copy-small rounded-md border px-3 py-1.5 font-medium ${verificationColors[report.verification_status]}`}
          >
            {verificationLabels[report.verification_status]}
          </span>
          <p className="geist-copy-small text-muted-foreground">
            Report created{" "}
            <time dateTime={created.toISOString()}>
              {created
                .toISOString()
                .replace("T", " ")
                .replace(/\.\d{3}Z$/u, " UTC")}
            </time>
          </p>
          <ButtonLink
            href="#pr-preview"
            className="border-border bg-surface text-foreground hover:bg-surface-hover"
          >
            Inspect PR preview <span aria-hidden="true">↓</span>
          </ButtonLink>
        </div>
      </section>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <section
            id="findings"
            className="bg-surface scroll-mt-6 rounded-lg border"
          >
            <div className="border-b p-5">
              <h2 className="geist-heading-section">Source findings</h2>
              <p className="geist-copy-small text-muted-foreground mt-2">
                Explicit target only. Pinned and unknown-default clients remain
                controls; this is not a repository-wide upgrade.
              </p>
            </div>
            <ul className="divide-y">
              {plan.findings.map((finding) => (
                <li key={`${finding.file}:${finding.line}`} className="p-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-mono text-xs leading-6 break-all">
                      {finding.file}:{finding.line}
                    </h3>
                    <span className="geist-copy-small bg-surface-active rounded-md px-2 py-1 text-xs">
                      {dispositionLabels[finding.disposition]}
                    </span>
                  </div>
                  <p className="geist-copy-small text-muted-foreground">
                    {finding.reason}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <section
            id="diff"
            className="bg-surface scroll-mt-6 overflow-hidden rounded-lg border"
          >
            <div className="border-b p-5">
              <h2 className="geist-heading-section">
                Generated candidate diff
              </h2>
              <p className="geist-copy-small text-muted-foreground mt-2">
                Worker-supplied unified patch. Source files are expanded;
                inspect manifests and the historical lockfile below.
              </p>
            </div>
            <DiffPreview diff={report.generated_diff} />
          </section>
          <MigrationChecks checks={report.checks} />
          <PrPreview preview={report.pr_preview} />
        </div>
        <aside className="space-y-6" aria-label="Publication and evidence">
          <section className="bg-surface rounded-lg border p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="geist-heading-section">Publication held</h2>
              <span className="geist-label rounded-md border px-2 py-1">
                Local only
              </span>
            </div>
            <p className="geist-copy-small text-muted-foreground">
              Local checks are separate from publication readiness. Independent
              review and human approval are still required.
            </p>
            <ul className="mt-5 space-y-5">
              {report.blockers.map((blocker) => (
                <li key={blocker.kind}>
                  <h3 className="geist-copy-small mb-1 font-medium">
                    {blocker.kind === "unknown_account_default"
                      ? "Unknown account default"
                      : "Independent review pending"}
                  </h3>
                  <p className="geist-copy-small text-muted-foreground">
                    {blocker.reason}
                  </p>
                </li>
              ))}
            </ul>
            <p className="geist-copy-small mt-5 border-t pt-4">
              No pull request published.
            </p>
          </section>
          <section
            id="evidence"
            className="bg-surface scroll-mt-6 rounded-lg border p-5"
          >
            <h2 className="geist-heading-section">Evidence</h2>
            <p className="geist-copy-small text-muted-foreground mt-2">
              Provider documentation and SDK declarations used by the migration
              plan.
            </p>
            <ul className="mt-5 space-y-5">
              {plan.evidence.map((evidence) => (
                <li key={evidence.url}>
                  <a
                    className="geist-copy-small focus-visible:outline-ring inline-block rounded-sm py-1 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                    href={evidence.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {evidence.title}
                    <span className="sr-only"> (opens in a new tab)</span>{" "}
                    <span aria-hidden="true">↗</span>
                  </a>
                  <p className="geist-copy-small text-muted-foreground mt-1 text-xs">
                    {evidence.immutable
                      ? "Commit-pinned source"
                      : "Provider reference · mutable"}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <Fingerprints fingerprints={report.source_fingerprints} />
          <p className="geist-copy-small text-muted-foreground px-1">
            OpenAI is the next provider. Its migration workflow is not
            connected.
          </p>
        </aside>
      </div>
    </div>
  );
};
