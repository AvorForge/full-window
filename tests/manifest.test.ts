import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENTRIES, ROOT, buildExtension } from "../scripts/build.mjs";
import { packageExtension, zipName } from "../scripts/package.mjs";
import { BRAND } from "../src/shared/brand";
import { manifestReferences, validateExtensionDir } from "../scripts/validate-manifest.mjs";
import { readText } from "./helpers/text";

// Builds the real production bundle into build/ (the directory you load unpacked) and checks it.
const BUILD_DIR = join(ROOT, "build");
let manifest: Record<string, any>;
const temp: string[] = [];

beforeAll(async () => {
  await buildExtension({ outDir: BUILD_DIR });
  manifest = JSON.parse(readText(join(BUILD_DIR, "manifest.json")));
}, 60_000);

afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfs-test-"));
  temp.push(dir);
  return dir;
}

describe("built manifest", () => {
  it("is valid MV3 according to the validator", () => {
    expect(validateExtensionDir(BUILD_DIR).errors).toEqual([]);
    expect(manifest.manifest_version).toBe(3);
  });

  it("declares a MAIN-world document_start content script in all frames, before the ISOLATED one", () => {
    const [main, isolated] = manifest.content_scripts;
    expect(main).toMatchObject({
      matches: ["<all_urls>"],
      js: ["content/main-world.js"],
      run_at: "document_start",
      all_frames: true,
      match_about_blank: true,
      match_origin_as_fallback: true,
      world: "MAIN",
    });
    expect(isolated).toMatchObject({
      matches: ["<all_urls>"],
      js: ["content/isolated.js"],
      run_at: "document_start",
      all_frames: true,
      world: "ISOLATED",
    });
  });

  it("has a module service worker, popup, options page and the toggle command", () => {
    expect(manifest.background).toEqual({ service_worker: "background/serviceWorker.js", type: "module" });
    expect(manifest.action.default_popup).toBe("ui/popup.html");
    expect(manifest.options_ui).toEqual({ page: "ui/options.html", open_in_tab: true });
    expect(manifest.commands["toggle-fullscreen-mode"].suggested_key.default).toBe("Alt+Shift+F");
  });

  it("requests only the storage permission and no host permissions", () => {
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it("references only files that exist in build/, including the pages' scripts and styles", () => {
    const { referenced } = validateExtensionDir(BUILD_DIR);
    expect(referenced).toEqual(
      expect.arrayContaining(["ui/popup.js", "ui/options.js", "ui/ui.css", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-off-16.png", "icons/icon-off-32.png"]),
    );
    for (const path of [...manifestReferences(manifest), ...referenced]) {
      expect(statSync(join(BUILD_DIR, path)).isFile(), path).toBe(true);
    }
  });

  it("ships the placeholder page a popped-out video leaves in its tab, loading only local files", () => {
    const { referenced } = validateExtensionDir(BUILD_DIR);
    expect(referenced).toEqual(expect.arrayContaining(["ui/poppedOut.html", "ui/poppedOut.js", "ui/poppedOut.css", "icons/icon-128.png"]));
    const html = readText(join(BUILD_DIR, "ui/poppedOut.html"));
    expect(html).toContain("This video is in its own window");
    expect(html).toContain("Bring it back");
    // No network requests: no remote favicon, script, style or image.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["'](?:[a-z]+:|\/\/)/i);
    expect(readText(join(BUILD_DIR, "ui/poppedOut.css"))).not.toMatch(/url\(/);
  });

  it("bundles every entry point as a self-contained script", () => {
    for (const entry of ENTRIES) {
      const code = readText(join(BUILD_DIR, `${entry.out}.js`));
      expect(code.length, entry.in).toBeGreaterThan(0);
      expect(code, entry.in).not.toMatch(/^\s*import\s/m);
    }
    // The MAIN world has no chrome.* APIs; its bundle must not use them.
    expect(readText(join(BUILD_DIR, "content/main-world.js"))).not.toMatch(/\bchrome\.(runtime|storage|tabs)/);
  });

  it("ships the pages' font, Inter, with its license, and loads it from the extension", () => {
    for (const path of ["ui/fonts/inter.woff2", "ui/fonts/OFL.txt"]) {
      expect(readFileSync(join(BUILD_DIR, path)), path).toEqual(readFileSync(join(ROOT, "src", path)));
    }
    expect(readText(join(BUILD_DIR, "ui/fonts/OFL.txt"))).toMatch(/SIL Open Font License/);
    const css = readText(join(BUILD_DIR, "ui/ui.css"));
    const urls = Array.from(css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g), (match) => match[1]);
    expect(urls).toEqual(["fonts/inter.woff2"]);
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*Inter;/);
    // Graphite has no hue by its colors, not by a filter that would also gray out the backdrop color swatch.
    expect(css).not.toMatch(/grayscale/i);
  });

  it("matches the package version", () => {
    const pkg = JSON.parse(readText(join(ROOT, "package.json")));
    expect(manifest.version).toBe(pkg.version);
  });
});

describe("manifest validator", () => {
  it("rejects MV2 manifests, missing MAIN-world scripts and missing files", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "x",
        version: "1.0",
        background: { scripts: ["bg.js"] },
        browser_action: {},
        content_scripts: [{ matches: ["<all_urls>"], js: ["missing.js"] }],
      }),
    );
    const { errors } = validateExtensionDir(dir);
    expect(errors).toEqual(
      expect.arrayContaining([
        "manifest_version must be 3",
        "background must be a service worker in MV3",
        "browser_action/page_action are MV2 keys",
        "a MAIN-world content script is required",
        'referenced file "missing.js" is missing from ' + dir,
      ]),
    );
  });

  it("rejects paths escaping the extension root and wrong icon sizes", () => {
    const dir = tempDir();
    const m = JSON.parse(readText(join(BUILD_DIR, "manifest.json")));
    m.options_ui.page = "../outside.html";
    m.icons["16"] = "icons/icon-32.png";
    m.action.default_icon["16"] = "icons/icon-off-32.png";
    mkdirSync(join(dir, "icons"));
    writeFileSync(join(dir, "icons/icon-off-32.png"), readFileSync(join(BUILD_DIR, "icons/icon-off-32.png")));
    writeFileSync(join(dir, "icons/icon-32.png"), readFileSync(join(BUILD_DIR, "icons/icon-32.png")));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    const { errors } = validateExtensionDir(dir);
    expect(errors).toContain('referenced path "../outside.html" must be relative to the extension root');
    expect(errors).toContain('icon "icons/icon-32.png" must be a 16x16 PNG');
    expect(errors).toContain('icon "icons/icon-off-32.png" must be a 16x16 PNG');
  });
});

describe("package", () => {
  it("names the zip from the brand name and the version", () => {
    expect(zipName(BRAND.name, "1.0.0")).toBe("full-window-not-screen-video-sizer-1.0.0.zip");
    expect(zipName(" Some  Product: Pro! ", "2.3.4")).toBe("some-product-pro-2.3.4.zip");
  });

  it("zips build/ with manifest.json at the root", () => {
    const distDir = tempDir();
    const { zipPath, files } = packageExtension({ buildDir: BUILD_DIR, distDir });
    const pkg = JSON.parse(readText(join(ROOT, "package.json")));
    expect(zipPath).toBe(join(distDir, `full-window-not-screen-video-sizer-${pkg.version}.zip`));
    expect(existsSync(zipPath)).toBe(true);
    const unzipped = unzipSync(readFileSync(zipPath));
    expect(Object.keys(unzipped).sort()).toEqual(files);
    expect(JSON.parse(new TextDecoder().decode(unzipped["manifest.json"]))).toEqual(manifest);
    expect(files).toEqual(expect.arrayContaining(["ui/fonts/inter.woff2", "ui/fonts/OFL.txt"]));
  });
});
