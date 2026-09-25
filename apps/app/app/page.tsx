import { Button } from "@repo/design-system/components/ui/button";

import { getApiStatus } from "../lib/api-status";

export const dynamic = "force-dynamic";

const apiLabels = {
  available: "Connected",
  unavailable: "Unavailable",
  unconfigured: "Not configured",
} as const;

const Dashboard = async () => {
  const apiStatus = await getApiStatus(process.env.RELTIDE_API_BASE_URL);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-12 px-6 py-10">
      <header className="flex items-center justify-between border-b pb-6">
        <span className="geist-heading-section">Reltide</span>
        <span className="geist-label text-muted-foreground rounded-full border px-3 py-1">
          Internal foundation
        </span>
      </header>
      <section className="max-w-2xl space-y-5">
        <p className="geist-label text-muted-foreground uppercase">API Sync</p>
        <h1 className="geist-heading-page">
          Review API changes with evidence.
        </h1>
        <p className="geist-copy-large text-muted-foreground">
          Repository connection and migration runs arrive in the next delivery
          slices. This shell establishes the shared interface and build
          boundary.
        </p>
        <Button disabled>Connect a repository</Button>
      </section>
      <section aria-label="Local API status" className="rounded-xl border p-6">
        <h2 className="geist-heading-section">Local API</h2>
        <p className="geist-copy-small text-muted-foreground mt-2">
          Process health: {apiLabels[apiStatus.kind]}
        </p>
      </section>
      <section aria-label="Current workspace" className="rounded-xl border p-6">
        <h2 className="geist-heading-section">No repositories connected</h2>
        <p className="geist-copy-small text-muted-foreground mt-2">
          Once connected, affected code paths and verified draft pull requests
          will appear here.
        </p>
      </section>
    </main>
  );
};

export default Dashboard;
