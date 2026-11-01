// Zips build/ into dist/<name>-<version>.zip (manifest.json at the zip root), e.g. dist/full-window-not-screen-video-sizer-1.0.0.zip.
// The name and version are the built manifest's, which the build takes from src/shared/brand.ts and package.json.
import { zipSync } from "fflate";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";
import { validateExtensionDir } from "./validate-manifest.mjs";

/**
 * The zip's file name for a product name and version: "Full Window, Not Screen: Video Sizer", "1.0.0" -> "full-window-not-screen-video-sizer-1.0.0.zip".
 * @param {string} name @param {string} version
 */
export function zipName(name, version) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}-${version}.zip`;
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]))
    .sort();
}

/**
 * @param {{ buildDir?: string, distDir?: string }} [options]
 * @returns {{ zipPath: string, files: string[] }}
 */
export function packageExtension(options = {}) {
  const buildDir = resolve(ROOT, options.buildDir ?? "build");
  const distDir = resolve(ROOT, options.distDir ?? "dist");
  const { errors } = validateExtensionDir(buildDir);
  if (errors.length > 0) throw new Error(`run "npm run build" first; ${buildDir} is not a valid extension:\n  - ${errors.join("\n  - ")}`);

  // Fixed timestamp so the same build always produces the same zip.
  const mtime = new Date("2020-01-01T00:00:00Z");
  /** @type {Record<string, [Uint8Array, { mtime: Date, level: 9 }]>} */
  const entries = {};
  const files = listFiles(buildDir).map((file) => relative(buildDir, file).split(sep).join("/"));
  for (const name of files) {
    entries[name] = [readFileSync(join(buildDir, name)), { mtime, level: 9 }];
  }
  const manifest = JSON.parse(readFileSync(join(buildDir, "manifest.json"), "utf8"));
  mkdirSync(distDir, { recursive: true });
  const zipPath = join(distDir, zipName(manifest.name, manifest.version));
  writeFileSync(zipPath, zipSync(entries));
  return { zipPath, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { zipPath, files } = packageExtension();
    console.log(`packaged ${files.length} files into ${relative(ROOT, zipPath)} (${statSync(zipPath).size} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
