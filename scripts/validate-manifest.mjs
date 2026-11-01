// Validates a built extension directory: manifest.json is MV3 with the shape
// docs/ARCHITECTURE.md requires, and every file it (or its HTML pages) references exists.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, posix } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ manifest: Record<string, any> | null, errors: string[], referenced: string[] }} ValidationResult
 */

/** @param {string} path */
function isPlainRelative(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !/^[a-z]+:/i.test(path) && !path.split("/").includes("..");
}

/**
 * Paths the manifest references, relative to the extension root.
 * @param {Record<string, any>} m
 * @returns {string[]}
 */
export function manifestReferences(m) {
  /** @type {string[]} */
  const refs = [];
  /** @param {unknown} v */
  const add = (v) => {
    if (typeof v === "string") refs.push(v);
  };
  /** @param {unknown} icons */
  const addIcons = (icons) => {
    if (typeof icons === "string") add(icons);
    else if (icons && typeof icons === "object") Object.values(icons).forEach(add);
  };
  add(m.background?.service_worker);
  for (const cs of m.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  add(m.action?.default_popup);
  addIcons(m.action?.default_icon);
  addIcons(m.icons);
  add(m.options_ui?.page);
  add(m.options_page);
  return [...new Set(refs)];
}

/**
 * Local scripts, stylesheets and images an HTML page loads, resolved against the page.
 * @param {string} html
 * @param {string} pagePath relative to the extension root
 */
export function htmlReferences(html, pagePath) {
  const refs = [];
  const pattern = /<(?:script|img)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = match[1] ?? match[2];
    if (!url || /^(?:[a-z]+:|\/\/|#)/i.test(url)) continue;
    refs.push(posix.normalize(posix.join(posix.dirname(pagePath), url.split(/[?#]/)[0] ?? "")));
  }
  return refs;
}

/** Extension pages the manifest does not name (the service worker opens them); their files must exist too. */
export const EXTRA_PAGES = ["ui/poppedOut.html"];

/**
 * @param {string} dir built extension directory
 * @returns {ValidationResult}
 */
export function validateExtensionDir(dir) {
  /** @type {string[]} */
  const errors = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { manifest: null, errors: [`${manifestPath} does not exist`], referenced: [] };
  /** @type {Record<string, any>} */
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { manifest: null, errors: [`manifest.json is not valid JSON: ${error}`], referenced: [] };
  }

  if (m.manifest_version !== 3) errors.push("manifest_version must be 3");
  if (typeof m.name !== "string" || m.name.length === 0 || m.name.length > 75) errors.push("name must be 1-75 characters");
  if (typeof m.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(m.version)) errors.push("version must be 1-4 dot-separated integers");
  if (typeof m.description === "string" && m.description.length > 132) errors.push("description must be at most 132 characters");
  if (m.browser_action || m.page_action) errors.push("browser_action/page_action are MV2 keys");
  if (m.background?.scripts || m.background?.page || m.background?.persistent !== undefined) errors.push("background must be a service worker in MV3");
  if (!m.background?.service_worker) errors.push("background.service_worker is required");
  if (m.background?.type !== "module") errors.push('background.type must be "module"');
  if (!Array.isArray(m.permissions) || !m.permissions.includes("storage")) errors.push('permissions must include "storage"');
  if (Array.isArray(m.web_accessible_resources) && m.web_accessible_resources.some((/** @type {unknown} */ r) => typeof r === "string")) {
    errors.push("web_accessible_resources must use the MV3 object form");
  }
  if (typeof m.content_security_policy === "string") errors.push("content_security_policy must be an object in MV3");

  const scripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  const main = scripts.find((/** @type {any} */ c) => c.world === "MAIN");
  const isolated = scripts.find((/** @type {any} */ c) => c.world === undefined || c.world === "ISOLATED");
  if (!main) errors.push("a MAIN-world content script is required");
  else {
    if (main.run_at !== "document_start") errors.push("MAIN-world content script must run at document_start");
    if (main.all_frames !== true) errors.push("MAIN-world content script must run in all frames");
    if (main.match_about_blank !== true || main.match_origin_as_fallback !== true) {
      errors.push("MAIN-world content script must set match_about_blank and match_origin_as_fallback");
    }
  }
  if (!isolated) errors.push("an ISOLATED-world content script is required");
  for (const cs of scripts) {
    if (!Array.isArray(cs.matches) || cs.matches.length === 0) errors.push("every content script needs matches");
    if (!Array.isArray(cs.js) || cs.js.length === 0) errors.push("every content script needs js");
  }
  if (!m.action?.default_popup) errors.push("action.default_popup is required");
  if (!m.options_ui?.page && !m.options_page) errors.push("an options page is required");

  const referenced = new Set([...manifestReferences(m), ...EXTRA_PAGES]);
  for (const page of [m.action?.default_popup, m.options_ui?.page, m.options_page, ...EXTRA_PAGES]) {
    if (typeof page !== "string" || !isPlainRelative(page)) continue;
    const pagePath = join(dir, page);
    if (existsSync(pagePath)) htmlReferences(readFileSync(pagePath, "utf8"), page).forEach((r) => referenced.add(r));
  }
  for (const ref of referenced) {
    if (!isPlainRelative(ref)) {
      errors.push(`referenced path "${ref}" must be relative to the extension root`);
      continue;
    }
    const full = normalize(join(dir, ref));
    if (!existsSync(full) || !statSync(full).isFile()) errors.push(`referenced file "${ref}" is missing from ${dir}`);
  }
  const defaultIcon = m.action?.default_icon;
  const sizedIcons = [...Object.entries(m.icons ?? {}), ...(defaultIcon && typeof defaultIcon === "object" ? Object.entries(defaultIcon) : [])];
  for (const [size, icon] of sizedIcons) {
    const full = join(dir, String(icon));
    if (existsSync(full)) {
      const png = readFileSync(full);
      const ok = png.length > 24 && png.readUInt32BE(0) === 0x89504e47 && png.readUInt32BE(16) === Number(size) && png.readUInt32BE(20) === Number(size);
      if (!ok) errors.push(`icon "${icon}" must be a ${size}x${size} PNG`);
    }
  }
  return { manifest: m, errors, referenced: [...referenced].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "build";
  const { errors, referenced } = validateExtensionDir(dir);
  if (errors.length > 0) {
    console.error(`${dir}: invalid extension\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`${dir}: valid MV3 extension, ${referenced.length} referenced files present`);
}
