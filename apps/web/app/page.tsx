import { Button } from "@repo/design-system/components/ui/button";

const Home = () => (
  <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between border-b pb-6">
      <span className="text-xl font-semibold tracking-tight">Reltide</span>
      <span className="text-sm text-muted-foreground">Invited pilot in development</span>
    </header>
    <section className="flex min-h-[65vh] flex-col justify-center gap-7 py-16">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        API Sync
      </p>
      <h1 className="max-w-4xl text-5xl font-semibold leading-tight tracking-tight md:text-7xl">
        Know what changed. Review a verified migration.
      </h1>
      <p className="max-w-2xl text-lg text-muted-foreground">
        Reltide is being built to connect provider changes to the code they affect and prepare
        migration drafts for engineers to review.
      </p>
      <div>
        <Button asChild>
          <a href="#workflow">See the planned workflow</a>
        </Button>
      </div>
    </section>
    <section id="workflow" className="grid gap-4 border-t py-12 md:grid-cols-3">
      <div className="rounded-xl border p-6">
        <h2 className="font-medium">Track</h2>
        <p className="mt-2 text-sm text-muted-foreground">Capture official provider evidence.</p>
      </div>
      <div className="rounded-xl border p-6">
        <h2 className="font-medium">Locate</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Map applicable changes to repository code.
        </p>
      </div>
      <div className="rounded-xl border p-6">
        <h2 className="font-medium">Verify</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Prepare a tested draft pull request for human review.
        </p>
      </div>
    </section>
  </main>
);

export default Home;
