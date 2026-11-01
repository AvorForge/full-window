// End-to-end tests with the extension loaded in headless Chromium (docs/ARCHITECTURE.md §9).
// `npm run test:e2e`; not part of `npm run validate`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Failing tests keep a screenshot per page, a trace and every frame's window.__log here (gitignored);
  // the fixtures in tests/e2e/harness/extension.ts write them.
  outputDir: "test-results",
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Every test launches its own Chromium with a fresh profile.
  workers: 4,
  projects: [
    { name: "e2e", testIgnore: "**/root-player-activity.spec.ts" },
    // Its tests make some 260 mouse moves and waits each over a page that repaints on every move, and every
    // test records a trace with screenshots and snapshots (tests/e2e/harness/extension.ts). On the Windows test
    // host more than two such recordings at once slowed every action about fourfold, past the test timeout
    // (with or without the extension loaded); one at a time each test takes about 11 s.
    { name: "e2e-one-at-a-time", testMatch: "**/root-player-activity.spec.ts", workers: 1 },
  ],
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
});
