import { rm } from "node:fs/promises";

import { generateFiles } from "fumadocs-openapi";

import { openapi } from "../lib/openapi.ts";

const output = "./content/docs/reference/generated";

// This directory is reserved for generated files; remove retired operations.
await rm(output, { force: true, recursive: true });
await generateFiles({
  addGeneratedComment: true,
  beforeWrite(files) {
    if (!files.some((file) => file.path.endsWith(".mdx"))) {
      throw new Error("OpenAPI reference contains no operations.");
    }
  },
  includeDescription: true,
  input: openapi,
  meta: true,
  output,
});
