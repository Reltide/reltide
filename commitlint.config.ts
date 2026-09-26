import type { UserConfig } from "@commitlint/types";

const config: UserConfig = {
  defaultIgnores: false,
  extends: ["@commitlint/config-conventional"],
};

export default config;
