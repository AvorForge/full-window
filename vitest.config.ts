import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // A skipped or empty suite must fail the gate rather than pass silently.
    passWithNoTests: false,
  },
});
