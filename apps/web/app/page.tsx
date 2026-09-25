import { ButtonLink } from "@repo/design-system/components/ui/button";

const Home = () => (
  <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between border-b pb-6">
      <span className="geist-heading-section">Reltide</span>
      <span className="geist-copy-small text-muted-foreground">
        Invited pilot in development
      </span>
    </header>
    <section className="flex min-h-[65vh] flex-col justify-center gap-7 py-16">
      <p className="geist-label text-muted-foreground uppercase">API Sync</p>
      <h1 className="geist-heading-hero md:geist-heading-hero-lg max-w-4xl">
        Know what changed. Review a verified migration.
      </h1>
      <p className="geist-copy-large text-muted-foreground max-w-2xl">
        Reltide is being built to connect provider changes to the code they
        affect and prepare migration drafts for engineers to review.
      </p>
      <div>
        <ButtonLink href="#workflow">See the planned workflow</ButtonLink>
      </div>
    </section>
    <section id="workflow" className="grid gap-4 border-t py-12 md:grid-cols-3">
      <div className="rounded-xl border p-6">
        <h2 className="geist-heading-section">Track</h2>
        <p className="geist-copy-small text-muted-foreground mt-2">
          Capture official provider evidence.
        </p>
      </div>
      <div className="rounded-xl border p-6">
        <h2 className="geist-heading-section">Locate</h2>
        <p className="geist-copy-small text-muted-foreground mt-2">
          Map applicable changes to repository code.
        </p>
      </div>
      <div className="rounded-xl border p-6">
        <h2 className="geist-heading-section">Verify</h2>
        <p className="geist-copy-small text-muted-foreground mt-2">
          Prepare a tested draft pull request for human review.
        </p>
      </div>
    </section>
  </main>
);

export default Home;
