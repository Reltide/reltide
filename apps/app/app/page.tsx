import { Button } from "@repo/design-system/components/ui/button";
import type { Metadata } from "next";
import { connection } from "next/server";

import { MigrationWorkbench } from "../components/migration-workbench";
import { getMigrationReport } from "../lib/migration-report";

export const metadata: Metadata = {
  title: "Stripe migration workbench | Reltide",
};

const stateLabels = {
  empty: "Waiting for evidence",
  unavailable: "Report unavailable",
  unconfigured: "Setup needed",
};
const stateCopy = {
  empty: {
    detail:
      "The API has no local migration report. Once the synthetic Stripe run has produced evidence, reload to review its candidate and check outcomes.",
    title: "No migration report yet",
  },
  unavailable: {
    detail:
      "The API could not supply a readable report. A run may be active or interrupted, or the service may be unreachable. Reload after the local run or service has recovered.",
    title: "Migration report is unavailable",
  },
  unconfigured: {
    detail:
      "Configure the local API connection at application startup, then reload to inspect the worker’s report.",
    title: "Migration API is not configured",
  },
};

const Dashboard = async () => {
  // Render even the unconfigured state at request time: startup config is not build-time data.
  await connection();
  const state = await getMigrationReport(process.env.RELTIDE_API_BASE_URL);
  return (
    <div className="bg-surface-hover min-h-screen">
      <a
        href="#content"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md p-3 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="bg-surface border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <span
              className="bg-primary text-primary-foreground flex h-8 w-8 items-center justify-center rounded-md font-semibold"
              aria-hidden="true"
            >
              R
            </span>
            <span className="font-semibold tracking-tight">Reltide</span>
            <span className="text-muted-foreground" aria-hidden="true">
              /
            </span>
            <span className="geist-copy-small text-muted-foreground">
              API Sync
            </span>
          </div>
          <span className="geist-copy-small rounded-md border px-2.5 py-1 text-xs">
            Synthetic fixture
          </span>
        </div>
      </header>
      <main
        id="content"
        tabIndex={-1}
        className="focus-visible:outline-ring mx-auto max-w-7xl space-y-6 px-5 py-8 focus-visible:outline-2 sm:px-8 sm:py-10"
      >
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="geist-label text-muted-foreground mb-2 uppercase">
              Migration workbench
            </p>
            <h1 className="geist-heading-page">Stripe API migration</h1>
            <p className="geist-copy-small text-muted-foreground mt-3">
              Review the candidate, its source evidence, and what still holds
              publication.
            </p>
          </div>
          <form action="/" method="get">
            <Button
              type="submit"
              className="border-border bg-surface text-foreground hover:bg-surface-active"
            >
              <span aria-hidden="true">↻</span> Reload report
            </Button>
          </form>
        </div>
        <p className="geist-copy-small text-muted-foreground bg-surface rounded-lg border px-5 py-3">
          Trusted synthetic fixture:{" "}
          <code className="text-foreground break-all">
            {state.kind === "available"
              ? state.report.fixture
              : "fixtures/stripe-migration"}
          </code>
          . Historical scenario, local execution, no live Stripe calls.
        </p>
        {state.kind === "available" ? (
          <>
            <nav aria-label="Report sections" className="border-b">
              <ul className="flex flex-wrap gap-x-6 gap-y-2 pb-3">
                {[
                  ["findings", "Findings"],
                  ["diff", "Diff"],
                  ["checks", "Checks"],
                  ["evidence", "Evidence"],
                  ["pr-preview", "PR preview"],
                ].map(([id, label]) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      className="geist-copy-small focus-visible:outline-ring inline-block rounded-sm py-2 font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <MigrationWorkbench report={state.report} />
          </>
        ) : (
          <section className="bg-surface rounded-lg border px-6 py-12 sm:px-10">
            <p className="geist-label text-muted-foreground mb-3 uppercase">
              {stateLabels[state.kind]}
            </p>
            <h2 className="geist-heading-section">
              {stateCopy[state.kind].title}
            </h2>
            <p className="geist-copy-small text-muted-foreground mt-3 max-w-xl">
              {stateCopy[state.kind].detail}
            </p>
            <p className="geist-copy-small mt-6">
              Publication remains held until evidence and independent review are
              available.
            </p>
          </section>
        )}
      </main>
      <footer className="mx-auto flex max-w-7xl flex-wrap justify-between gap-2 px-5 py-6 sm:px-8">
        <p className="geist-copy-small text-muted-foreground text-xs">
          Reltide · Evidence before publication
        </p>
        <p className="geist-copy-small text-muted-foreground text-xs">
          Human review required
        </p>
      </footer>
    </div>
  );
};

export default Dashboard;
