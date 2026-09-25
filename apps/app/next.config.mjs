import { config } from "@repo/next-config";
import { fileURLToPath } from "node:url";

export default {
  ...config,
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};
