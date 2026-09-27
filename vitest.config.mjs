import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { NX_DAEMON: "false" },
    globalSetup: ["./tools/vitest-setup.mjs"],
  },
});
