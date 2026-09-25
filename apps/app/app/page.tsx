import { Button } from "@repo/design-system/components/ui/button";

const Dashboard = () => (
  <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-12 px-6 py-10">
    <header className="flex items-center justify-between border-b pb-6">
      <span className="text-xl font-semibold tracking-tight">Reltide</span>
      <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
        Internal foundation
      </span>
    </header>
    <section className="max-w-2xl space-y-5">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        API Sync
      </p>
      <h1 className="text-4xl font-semibold tracking-tight">Review API changes with evidence.</h1>
      <p className="text-lg text-muted-foreground">
        Repository connection and migration runs arrive in the next delivery slices. This shell
        establishes the shared interface and build boundary.
      </p>
      <Button disabled>Connect a repository</Button>
    </section>
    <section aria-label="Current workspace" className="rounded-xl border p-6">
      <h2 className="text-lg font-medium">No repositories connected</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Once connected, affected code paths and verified draft pull requests will appear here.
      </p>
    </section>
  </main>
);

export default Dashboard;
