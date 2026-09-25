import { Button } from "@repo/design-system/components/ui/button";

const Dashboard = () => (
  <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-12 px-6 py-10">
    <header className="flex items-center justify-between border-b pb-6">
      <span className="geist-heading-section">Reltide</span>
      <span className="geist-label rounded-full border px-3 py-1 text-muted-foreground">
        Internal foundation
      </span>
    </header>
    <section className="max-w-2xl space-y-5">
      <p className="geist-label uppercase text-muted-foreground">API Sync</p>
      <h1 className="geist-heading-page">Review API changes with evidence.</h1>
      <p className="geist-copy-large text-muted-foreground">
        Repository connection and migration runs arrive in the next delivery slices. This shell
        establishes the shared interface and build boundary.
      </p>
      <Button disabled>Connect a repository</Button>
    </section>
    <section aria-label="Current workspace" className="rounded-xl border p-6">
      <h2 className="geist-heading-section">No repositories connected</h2>
      <p className="geist-copy-small mt-2 text-muted-foreground">
        Once connected, affected code paths and verified draft pull requests will appear here.
      </p>
    </section>
  </main>
);

export default Dashboard;
