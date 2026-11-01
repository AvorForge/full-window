import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../scripts/build.mjs";
import { readText, toLf } from "./helpers/text";

// npm run validate is the project's complete gate; there is deliberately no GitHub Actions workflow.
describe("repository", () => {
  it("has no GitHub Actions workflows", () => {
    expect(existsSync(join(ROOT, ".github", "workflows"))).toBe(false);
  });

  it("validate runs the type-check and every unit test", () => {
    const { scripts } = JSON.parse(readText(join(ROOT, "package.json")));
    expect(scripts.validate).toBe("npm run type-check && npm run test");
    expect(scripts.test).toBe("vitest run");
  });

  it("test:all runs validate, then the end-to-end tests, which stay out of validate", () => {
    const { scripts } = JSON.parse(readText(join(ROOT, "package.json")));
    expect(scripts["test:e2e"]).toBe("playwright test");
    expect(scripts["test:all"]).toBe("npm run validate && npm run test:e2e");
    expect(`${scripts.validate} ${scripts.test} ${scripts["type-check"]}`).not.toMatch(/e2e|playwright/);
  });

  it(".gitattributes checks text out with LF everywhere and keeps images and zips binary", () => {
    const attributes = readText(join(ROOT, ".gitattributes"));
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
    for (const ext of ["png", "zip"]) expect(attributes).toMatch(new RegExp(`^\\*\\.${ext} binary$`, "m"));
  });

  it("text read by the tests parses the same with CRLF line endings", () => {
    expect(toLf("# A\r\n\r\n## B\r\ntext\rmore\n")).toBe("# A\n\n## B\ntext\nmore\n");
  });
});
