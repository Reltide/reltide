import { config } from "@repo/next-config";
import { createMDX } from "fumadocs-mdx/next";
import { fileURLToPath } from "node:url";

const withMDX = createMDX();

export default withMDX({
  ...config,
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
});
