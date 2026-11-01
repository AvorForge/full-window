// Playwright globalSetup: build the production extension into build/ before any browser loads it.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  execSync("npm run build", { cwd: root, stdio: "inherit" });
}
