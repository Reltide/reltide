import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "AGENTS.md",
    "README.md",
    "LICENSE.next-forge.md",
    "docs/**",
    "fixtures/**",
    "graft/**",
    "assets/**",
    "packages/api-client/openapi.json",
    "packages/api-client/src/generated/**",
    "opencode.json",
    "**/next-env.d.ts",
    "**/index.d.ts",
    "**/.swcrc",
  ],
});
