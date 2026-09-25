import { fileURLToPath } from "node:url";

import { config } from "@repo/next-config";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

export default withMDX({
  ...config,
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
});
