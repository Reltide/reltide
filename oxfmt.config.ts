import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "AGENTS.md",
    "README.md",
    "LICENSE.next-forge.md",
    "docs/**",
    "fixtures/**",
    "graft/**",
    "assets/**",
    "opencode.json",
    "**/next-env.d.ts",
    "**/index.d.ts",
    "**/.swcrc",
  ],
});
