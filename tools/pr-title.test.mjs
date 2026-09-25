import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

const lintTitle = (title) => {
  const result = spawnSync(
    "pnpm",
    ["exec", "commitlint", "--config", "commitlint.pr-title.config.ts"],
    { encoding: "utf-8", input: `${title}\n` }
  );

  if (result.error) {
    throw result.error;
  }

  return result;
};

test.each([
  "feat: add repository onboarding",
  "fix(api): handle timeouts",
  "feat!: change api contract",
])("accepts a conventional PR title: %s", (title) => {
  const result = lintTitle(title);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test.each([
  "Add repository onboarding",
  "feat: Add repository onboarding",
  "feat: ",
  "Merge pull request #42 from somebody/branch",
  'Revert "bad change"',
  "v1.2.3",
  "fixup! feat: valid",
])("rejects a nonconventional PR title: %s", (title) => {
  const result = lintTitle(title);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(
    /\[(?:type-empty|subject-empty|subject-case)\]/u
  );
});
