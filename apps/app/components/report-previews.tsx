/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Labeled, bounded scroll regions require keyboard focus to expose their full text. */
import type { MigrationReport } from "@repo/api-client";

const previewClassName =
  "max-h-96 overflow-auto bg-surface-hover p-4 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export const DiffPreview = ({ diff }: { diff: string }) => {
  if (!diff) {
    return (
      <p className="geist-copy-small text-muted-foreground p-5">
        No generated patch is present in this report.
      </p>
    );
  }
  // Split the supplied patch for browsing; every byte remains available below.
  const sections = diff.split(/(?=^diff --git )/mu).filter(Boolean);
  return (
    <div className="divide-y">
      {sections.map((section, index) => {
        const header = section.split("\n", 1)[0] ?? "Unified patch";
        return (
          <details
            key={`${index}-${header}`}
            open={header.endsWith(".ts")}
            className="group"
          >
            <summary className="focus-visible:outline-ring cursor-pointer px-5 py-4 font-mono text-xs break-all focus-visible:outline-2 focus-visible:outline-offset-2">
              {header}
            </summary>
            <section
              className={previewClassName}
              tabIndex={0}
              aria-label={`Patch section ${index + 1}: ${header}`}
            >
              <pre>
                <code>{section}</code>
              </pre>
            </section>
          </details>
        );
      })}
    </div>
  );
};

export const PrPreview = ({ preview }: { preview: string }) => (
  <section
    id="pr-preview"
    className="bg-surface scroll-mt-6 overflow-hidden rounded-lg border"
  >
    <div className="border-b p-5">
      <p className="geist-label text-muted-foreground mb-1 uppercase">
        Local artifact
      </p>
      <h2 className="geist-heading-section">Pull request preview</h2>
      <p className="geist-copy-small text-muted-foreground mt-2">
        Prepared Markdown from the worker. Publication is held; no GitHub pull
        request has been created.
      </p>
    </div>
    {preview ? (
      <section
        className={`${previewClassName} break-words whitespace-pre-wrap`}
        tabIndex={0}
        aria-label="Pull request Markdown preview"
      >
        <pre className="break-words whitespace-pre-wrap">
          <code>{preview}</code>
        </pre>
      </section>
    ) : (
      <p className="geist-copy-small text-muted-foreground p-5">
        A PR preview has not been generated.
      </p>
    )}
  </section>
);

export const Fingerprints = ({
  fingerprints,
}: {
  fingerprints: MigrationReport["source_fingerprints"];
}) => (
  <details className="bg-surface rounded-lg border">
    <summary className="geist-copy-small focus-visible:outline-ring cursor-pointer p-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
      Inspect {fingerprints.length} source fingerprints
    </summary>
    <p className="geist-copy-small text-muted-foreground px-5 pb-4">
      SHA-256 identities recorded by the worker. candidate/ identifies generated
      files; worker-generated/ identifies disposable verification programs.
    </p>
    <ul className="space-y-4 px-5 pb-5">
      {fingerprints.map((fingerprint) => (
        <li
          key={fingerprint.path}
          className="font-mono text-xs leading-5 break-all"
        >
          <span className="block font-medium">{fingerprint.path}</span>
          <span className="text-muted-foreground">{fingerprint.sha256}</span>
        </li>
      ))}
    </ul>
  </details>
);
