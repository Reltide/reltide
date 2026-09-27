import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const nx = fileURLToPath(
  new URL("../node_modules/nx/dist/bin/nx.js", import.meta.url)
);

export default function setup() {
  // Build the cold project graph before timed integration assertions begin.
  execFileSync(process.execPath, [nx, "show", "projects", "--json"], {
    cwd: workspaceRoot,
    env: { ...process.env, NX_DAEMON: "false" },
    stdio: "inherit",
    timeout: 60_000,
  });
}
