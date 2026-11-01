// Production build: one esbuild bundle per entry point, plus static files,
// into build/ (an unpacked extension). The root manifest.json is the source
// of truth for everything but the product's name, short name and description (from
// src/shared/brand.ts) and the version (from package.json); paths in it are
// relative to build/. The icons are the PNGs committed in src/icons/ (`npm run icons` renders them from
// src/icons/svg/); the build copies them.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateExtensionDir } from "./validate-manifest.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Chromium 111 is the first version with world: "MAIN" in manifest content_scripts. */
const TARGET = "chrome111";

/**
 * @type {Array<{ in: string, out: string, format: "esm" | "iife" }>}
 * Content scripts and pages are classic scripts (IIFE); the service worker is a module.
 */
export const ENTRIES = [
  { in: "src/background/serviceWorker.ts", out: "background/serviceWorker", format: "esm" },
  { in: "src/content/main-world.ts", out: "content/main-world", format: "iife" },
  { in: "src/content/isolated.ts", out: "content/isolated", format: "iife" },
  { in: "src/ui/popup.ts", out: "ui/popup", format: "iife" },
  { in: "src/ui/options.ts", out: "ui/options", format: "iife" },
  { in: "src/ui/poppedOut.ts", out: "ui/poppedOut", format: "iife" },
];

/**
 * @type {Array<[string, string]>} Static files: [source, destination relative to outDir]. HTML pages get
 * `%BRAND_NAME%` replaced by the product name; everything else is copied as-is.
 */
export const STATIC_FILES = [
  ["src/ui/popup.html", "ui/popup.html"],
  ["src/ui/options.html", "ui/options.html"],
  // The placeholder tab a popped-out video leaves in its place (opened by the service worker, not in the manifest).
  ["src/ui/poppedOut.html", "ui/poppedOut.html"],
  ["src/ui/poppedOut.css", "ui/poppedOut.css"],
  ["src/ui/ui.css", "ui/ui.css"],
  // The pages' font (Inter, loaded by ui.css with @font-face) and its license, which must ship with it.
  ["src/ui/fonts/inter.woff2", "ui/fonts/inter.woff2"],
  ["src/ui/fonts/OFL.txt", "ui/fonts/OFL.txt"],
];

/**
 * The icons, copied from src/icons/ into icons/. ON (the site is on): the manifest's "icons", and what the
 * service worker shows for a tab whose site is on. OFF, 16 and 32 px only (the toolbar's sizes):
 * "action.default_icon", and what it shows for a tab whose site is off.
 */
export const ICON_SIZES = [16, 32, 48, 128];
export const OFF_ICON_SIZES = [16, 32];
export const ICON_FILES = [...ICON_SIZES.map((size) => `icon-${size}.png`), ...OFF_ICON_SIZES.map((size) => `icon-off-${size}.png`)];

/** Manifest keys the build writes; the source manifest.json must not set them, so there is one source. */
export const BRAND_KEYS = ["name", "short_name", "description", "version"];

/**
 * The product's name, short name, description, credit and support contact (src/shared/brand.ts), bundled by
 * esbuild so plain Node can load it.
 * @returns {Promise<{ name: string, shortName: string, description: string, credit: string, support: { email: string, url: string } }>}
 */
export async function loadBrand() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/shared/brand.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "warning",
  });
  const code = result.outputFiles[0]?.text ?? "";
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.BRAND;
}

/**
 * The manifest to ship: the source manifest with the brand and package version filled in. short_name is the
 * brand's short name; the toolbar button's title is the full name.
 * @param {Record<string, any>} source @param {{ name: string, shortName: string, description: string }} brand @param {string} version
 */
export function brandManifest(source, brand, version) {
  for (const key of BRAND_KEYS) {
    if (key in source) throw new Error(`manifest.json must not set "${key}": the build writes it (src/shared/brand.ts, package.json)`);
  }
  if (source.action && "default_title" in source.action) throw new Error('manifest.json must not set "action.default_title": the build writes it');
  const { manifest_version, ...rest } = source;
  return {
    manifest_version,
    name: brand.name,
    short_name: brand.shortName,
    version,
    description: brand.description,
    ...rest,
    action: { ...rest.action, default_title: brand.name },
  };
}

/**
 * @param {{ outDir?: string, minify?: boolean, sourcemap?: boolean }} [options]
 * @returns {Promise<string>} the absolute output directory
 */
export async function buildExtension(options = {}) {
  const outDir = resolve(ROOT, options.outDir ?? "build");
  const minify = options.minify ?? true;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const format of /** @type {const} */ (["esm", "iife"])) {
    await build({
      absWorkingDir: ROOT,
      entryPoints: ENTRIES.filter((e) => e.format === format).map((e) => ({ in: e.in, out: e.out })),
      outdir: outDir,
      bundle: true,
      format,
      platform: "browser",
      target: TARGET,
      minify,
      sourcemap: options.sourcemap ? "inline" : false,
      legalComments: "none",
      charset: "utf8",
      logLevel: "warning",
    });
  }

  const brand = await loadBrand();
  for (const [from, to] of STATIC_FILES) {
    mkdirSync(dirname(join(outDir, to)), { recursive: true });
    if (from.endsWith(".html")) {
      writeFileSync(join(outDir, to), readFileSync(join(ROOT, from), "utf8").replaceAll("%BRAND_NAME%", brand.name));
    } else {
      cpSync(join(ROOT, from), join(outDir, to), { recursive: true });
    }
  }

  mkdirSync(join(outDir, "icons"), { recursive: true });
  for (const file of ICON_FILES) cpSync(join(ROOT, "src", "icons", file), join(outDir, "icons", file));

  const source = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = brandManifest(source, brand, pkg.version);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const { errors } = validateExtensionDir(outDir);
  if (errors.length > 0) throw new Error(`built extension is invalid:\n  - ${errors.join("\n  - ")}`);
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dev = process.argv.includes("--dev");
  buildExtension({ minify: !dev, sourcemap: dev }).then(
    (outDir) => console.log(`built ${dev ? "development" : "production"} extension into ${outDir}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
