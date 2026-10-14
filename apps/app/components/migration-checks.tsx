/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Labeled, bounded scroll regions require keyboard focus to expose their full text. */
import type { CheckKind, CheckResult, CheckStatus } from "@repo/api-client";

const checkLabels: Record<CheckKind, string> = {
  before_baseline: "Original baseline",
  before_regression: "Original regression",
  before_typecheck: "Original typecheck",
  candidate_regression: "Candidate regression",
  candidate_typecheck: "Candidate typecheck",
  pinned_control: "Pinned API control",
  unknown_control: "Unknown default control",
};
const statusColors: Record<CheckStatus, string> = {
  expected_failure: "text-foreground",
  failed: "text-destructive",
  not_run: "text-muted-foreground",
  passed: "text-success",
};
const statusLabels: Record<CheckStatus, string> = {
  expected_failure: "Expected failure",
  failed: "Failed",
  not_run: "Not run",
  passed: "Passed",
};

export const MigrationChecks = ({ checks }: { checks: CheckResult[] }) => (
  <section id="checks" className="bg-surface scroll-mt-6 rounded-lg border">
    <div className="border-b p-5">
      <h2 className="geist-heading-section">Local verification</h2>
      <p className="geist-copy-small text-muted-foreground mt-2">
        Actual worker command outcomes on synthetic inputs. The original
        regression is expected to fail before migration. Passing the unknown
        control does not resolve its account version.
      </p>
    </div>
    {checks.length === 0 ? (
      <p className="geist-copy-small text-muted-foreground p-5">
        No local command outcomes have been recorded.
      </p>
    ) : (
      <ul className="divide-y">
        {checks.map((check) => (
          <li key={check.kind} className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="geist-copy-small font-medium">
                {checkLabels[check.kind]}
              </h3>
              <span
                className={`geist-copy-small rounded-md border px-2 py-1 ${statusColors[check.status]}`}
              >
                {statusLabels[check.status]}
              </span>
            </div>
            <p className="geist-copy-small text-muted-foreground mt-2 font-mono text-xs">
              Exit: {check.exit_code ?? "not recorded"} · Duration:{" "}
              {check.duration_ms} ms
            </p>
            <details className="mt-3">
              <summary className="geist-copy-small focus-visible:outline-ring w-fit cursor-pointer rounded-sm py-1 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                Command and retained output
              </summary>
              <section
                className="bg-surface-hover focus-visible:outline-ring mt-3 max-h-72 overflow-auto rounded-md border p-4 font-mono text-xs leading-6 break-words whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-offset-2"
                tabIndex={0}
                aria-label={`${checkLabels[check.kind]} command and output`}
              >
                <pre className="break-words whitespace-pre-wrap">
                  <code>
                    {check.command}
                    {"\n\n"}
                    {check.output || "No output retained."}
                  </code>
                </pre>
              </section>
            </details>
          </li>
        ))}
      </ul>
    )}
  </section>
);
