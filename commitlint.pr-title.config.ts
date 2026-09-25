import type { UserConfig } from "@commitlint/types";

import commitConfig from "./commitlint.config.ts";

const config: UserConfig = {
  ...commitConfig,
  defaultIgnores: false,
};

export default config;
