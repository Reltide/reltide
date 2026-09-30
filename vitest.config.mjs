import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { NX_DAEMON: "false" },
    exclude: [...configDefaults.exclude, "**/.capacity/**"],
    globalSetup: ["./tools/vitest-setup.mjs"],
  },
});
