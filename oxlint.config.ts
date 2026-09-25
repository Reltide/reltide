import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next, antiSlop],
  ignorePatterns: [
    ...core.ignorePatterns,
    "**/.next/**",
    "**/.source/**",
    "**/node_modules/**",
    "**/dist/**",
    "packages/api-client/src/generated/**",
    "**/next-env.d.ts",
    "**/index.d.ts",
    "fixtures/**",
  ],
});
