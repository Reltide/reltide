import { fileURLToPath } from "node:url";

import { config } from "@repo/next-config";

export default {
  ...config,
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};
