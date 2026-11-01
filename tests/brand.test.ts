import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BRAND_KEYS, ICON_FILES, ICON_SIZES, OFF_ICON_SIZES, ROOT, brandManifest, buildExtension } from "../scripts/build.mjs";
import { ICONS, ICON_MASTER, decodeRgbaPng } from "../scripts/render-icons.mjs";
import { ACTION_ICONS } from "../src/background/serviceWorkerCore";
import { BRAND } from "../src/shared/brand";
import { readText } from "./helpers/text";

// The product name, description and version have one source each (src/shared/brand.ts, package.json); the
// build writes them into the manifest and the pages. Builds into its own directory, not build/.
const OUT_DIR = join(ROOT, "node_modules", ".cache", "brand-test-build");
let built: Record<string, any>;
const pkg = JSON.parse(readText(join(ROOT, "package.json")));
const source = JSON.parse(readText(join(ROOT, "manifest.json")));

beforeAll(async () => {
  await buildExtension({ outDir: OUT_DIR });
  built = JSON.parse(readText(join(OUT_DIR, "manifest.json")));
}, 60_000);

describe("brand", () => {
  it("is Full Window, Not Screen: Video Sizer 1.0.0 with names and a description the stores accept", () => {
    expect(BRAND.name).toBe("Full Window, Not Screen: Video Sizer");
    expect(BRAND.shortName).toBe("Full Window");
    expect(pkg.version).toBe("1.0.0");
    // Microsoft Edge Add-ons' limit for the name; Chrome's recommendation for short_name.
    expect(BRAND.name.length).toBeLessThanOrEqual(45);
    expect(BRAND.shortName.length).toBeLessThanOrEqual(12);
    expect(BRAND.description.length).toBeLessThanOrEqual(132);
    expect(BRAND.credit).toBe("Made by Avor Forge LLC");
    expect(BRAND.support).toEqual({ email: "inquiries@avorforge.com", url: "https://avorforge.com/" });
    // The repository and package are named after the short name.
    expect(pkg.name).toBe("full-window");
  });

  it("the built manifest's name, short name, description, title and version come from brand.ts and package.json", () => {
    expect(built.name).toBe(BRAND.name);
    expect(built.short_name).toBe(BRAND.shortName);
    expect(built.description).toBe(BRAND.description);
    expect(built.action.default_title).toBe(BRAND.name);
    expect(built.version).toBe(pkg.version);
  });

  it("the source manifest does not repeat them", () => {
    for (const key of BRAND_KEYS) expect(source, key).not.toHaveProperty(key);
    expect(source.action).not.toHaveProperty("default_title");
    expect(() => brandManifest({ ...source, name: "Other" }, BRAND, "1.0.0")).toThrow(/must not set "name"/);
    expect(() => brandManifest({ ...source, action: { ...source.action, default_title: "x" } }, BRAND, "1.0.0")).toThrow(/default_title/);
  });

  it("a rename is one change: brandManifest takes the names and description from the brand it is given", () => {
    const renamed = brandManifest(source, { name: "Another Name", shortName: "Another", description: "Another description." }, "2.0.0");
    expect(renamed).toMatchObject({ name: "Another Name", short_name: "Another", description: "Another description.", version: "2.0.0" });
    expect(renamed.action.default_title).toBe("Another Name");
    expect(Object.keys(renamed)[0]).toBe("manifest_version");
  });

  it("the pages' titles carry the name, and no placeholder is left in the build", () => {
    expect(readText(join(OUT_DIR, "ui/popup.html"))).toContain(`<title>${BRAND.name}</title>`);
    const options = readText(join(OUT_DIR, "ui/options.html"));
    expect(options).toContain(`<title>${BRAND.name} settings</title>`);
    expect(options).toContain(`<h1>${BRAND.name}</h1>`);
    // Files only: ui/fonts/ holds the font and its license.
    for (const entry of readdirSync(join(OUT_DIR, "ui"), { withFileTypes: true }).filter((e) => e.isFile())) {
      expect(readText(join(OUT_DIR, "ui", entry.name)), entry.name).not.toContain("%BRAND_NAME%");
    }
    // The old name is gone from everything the user sees.
    for (const file of ["ui/popup.html", "ui/options.html", "manifest.json"]) {
      expect(readText(join(OUT_DIR, file)), file).not.toMatch(/Custom Full Screen/i);
    }
  });
});

describe("icon", () => {
  const pixels = (path: string) => decodeRgbaPng(readFileSync(join(ROOT, path)));

  it("the build copies the committed PNGs: ON for the manifest's icons, OFF at 16 and 32 px for the toolbar default", () => {
    expect(ICON_SIZES).toEqual([16, 32, 48, 128]);
    expect(OFF_ICON_SIZES).toEqual([16, 32]);
    expect(ICON_FILES).toEqual(["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png", "icon-off-16.png", "icon-off-32.png"]);
    expect(readdirSync(join(OUT_DIR, "icons")).sort()).toEqual([...ICON_FILES].sort());
    for (const file of ICON_FILES) {
      const committed = readFileSync(join(ROOT, "src", "icons", file));
      expect(readFileSync(join(OUT_DIR, "icons", file)).equals(committed), file).toBe(true);
    }
    expect(built.icons).toEqual({ "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" });
    expect(built.action.default_icon).toEqual({ "16": "icons/icon-off-16.png", "32": "icons/icon-off-32.png" });
    expect(source.action.default_icon).toEqual(built.action.default_icon);
    // The service worker's tab icons are the same files, from the extension root (setIcon resolves a relative
    // path against the worker's folder, background/).
    expect(ACTION_ICONS.on).toEqual({ 16: `/${built.icons["16"]}`, 32: `/${built.icons["32"]}` });
    expect(ACTION_ICONS.off).toEqual({ 16: `/${built.action.default_icon["16"]}`, 32: `/${built.action.default_icon["32"]}` });
  });

  it("every PNG is RGBA at its size, with the SVG source `npm run icons` renders it from", () => {
    expect(ICONS.map((icon) => icon.png)).toEqual(ICON_FILES.map((file) => `src/icons/${file}`));
    expect(pkg.scripts.icons).toBe("node scripts/render-icons.mjs");
    for (const icon of ICONS) {
      const png = pixels(icon.png);
      expect([png.width, png.height], icon.png).toEqual([icon.size, icon.size]);
      const root = `<svg xmlns="http://www.w3.org/2000/svg" width="${icon.size}" height="${icon.size}" viewBox="0 0 ${icon.size} ${icon.size}"`;
      expect(readText(join(ROOT, icon.svg)).startsWith(root), icon.svg).toBe(true);
    }
    expect(readText(join(ROOT, ICON_MASTER)).startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"')).toBe(true);
  });

  it("the 128 px icon is 96 × 96 artwork centered in 16 px of transparent padding", () => {
    const { width, pixels: rgba } = pixels("src/icons/icon-128.png");
    let [left, top, right, bottom] = [width, width, -1, -1];
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        if ((rgba[(y * width + x) * 4 + 3] ?? 0) === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    expect({ left, top, right, bottom }).toEqual({ left: 16, top: 16, right: 111, bottom: 111 });
    expect(readText(join(ROOT, "src", "icons", "svg", "window-tl-128.svg"))).toContain('<svg x="16" y="16" width="96" height="96" viewBox="0 0 1024 1024">');
  });

  it("ON and OFF differ at both toolbar sizes", () => {
    for (const size of OFF_ICON_SIZES) {
      expect(pixels(`src/icons/icon-${size}.png`).pixels.equals(pixels(`src/icons/icon-off-${size}.png`).pixels), String(size)).toBe(false);
    }
  });

  it("the old rect-only icon and its rasteriser are gone", () => {
    expect(existsSync(join(ROOT, "src", "icons", "icon.svg"))).toBe(false);
    expect(existsSync(join(ROOT, "scripts", "icons.mjs"))).toBe(false);
  });
});
