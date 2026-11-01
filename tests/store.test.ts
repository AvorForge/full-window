import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../scripts/build.mjs";
import { BRAND } from "../src/shared/brand";
import { readText, toLf } from "./helpers/text";

// The store kit in store/: listing copy, privacy policy, the owner-approved product page (store/site/), screenshots,
// promo tile and marquee, and the Edge logo `npm run store:assets` makes.
const STORE = join(ROOT, "store");
const read = (path: string): string => readText(join(STORE, path));

function pngSize(path: string): { width: number; height: number } {
  const png = readFileSync(join(STORE, path));
  expect(png.readUInt32BE(0), path).toBe(0x89504e47);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The sites the live compatibility run in docs/ARCHITECTURE.md §8 proves, and ones the listing must not name. */
const TESTED = ["YouTube", "Twitch", "Kick", "Facebook", "Streamable", "LinkedIn"];
const NOT_TESTED = ["Reddit", "Rumble", "Vimeo", "Dailymotion", "TikTok", "Instagram", "Netflix", "Prime Video", "Disney", "Max", "Hulu"];

function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`## ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + title.length + 4);
  const end = rest.indexOf("\n## ");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

describe("store listing", () => {
  const listing = read("listing.md");

  it("has the title and a short description of at most 132 characters, the same as the manifest's", () => {
    expect(section(listing, "Title")).toBe(BRAND.name);
    const short = section(listing, "Short description").split("\n").at(-1) ?? "";
    expect(short).toBe(BRAND.description);
    expect(short.length).toBeLessThanOrEqual(132);
  });

  it("parses the same from a CRLF checkout (core.autocrlf=true)", () => {
    const crlf = listing.replace(/\n/g, "\r\n");
    expect(section(toLf(crlf), "Title")).toBe(BRAND.name);
    expect(section(toLf(crlf), "Single purpose")).toBe(section(listing, "Single purpose"));
  });

  it("the long description names only the sites docs/ARCHITECTURE.md proves, and the measured facts", () => {
    const long = section(listing, "Long description").replace(/\s+/g, " ");
    const architecture = readText(join(ROOT, "docs", "ARCHITECTURE.md"));
    const siteNotes = architecture.slice(architecture.indexOf("### Site notes (live compatibility run, 2026-10-25)"), architecture.indexOf("## 9. Test plan"));
    for (const site of TESTED) {
      expect(long, site).toContain(site);
      // A row of the site notes table, not the "Not tested" rows.
      expect(siteNotes, site).toMatch(new RegExp(`^\\| ${site}(?![^|]*\\|[^|]*\\| Not tested)`, "m"));
    }
    for (const site of NOT_TESTED) expect(long, site).not.toMatch(new RegExp(`\\b${site}\\b`));
    expect(long).not.toMatch(/\bX\b/);
    expect(long).toContain("player controls keep working");
    expect(long).toMatch(/picture-in-picture/i);
    expect(long).toContain("about 85 KB");
    expect(long).toContain("about 1 MB");
    expect(long).toContain("no extra work while the video plays");
    expect(long).toContain("no data collected, no network requests");
  });

  it("has the single purpose, the permission justifications and the Edge fields", () => {
    expect(section(listing, "Single purpose").length).toBeGreaterThan(20);
    const permissions = section(listing, "Permission justifications");
    expect(permissions).toMatch(/all sites.*intercept fullscreen requests/is);
    expect(permissions).toMatch(/storage: to save settings/);
    const edge = section(listing, "Microsoft Edge Add-ons fields");
    for (const field of ["Display name", "Short description", "Description", "Category", "Search terms", "Privacy policy", "Store logo", "Screenshots"]) {
      expect(edge, field).toContain(`- ${field}:`);
    }
  });

  it("lists the support contact for both stores", () => {
    const chrome = section(listing, "Chrome Web Store fields");
    expect(chrome).toContain(`- Support URL: ${BRAND.support.url}`);
    expect(chrome).toContain(`- Contact email: ${BRAND.support.email}`);
    const edge = section(listing, "Microsoft Edge Add-ons fields");
    expect(edge).toContain(`- Support contact: ${BRAND.support.email}, ${BRAND.support.url}`);
  });
});

/** The durations over 200 ms in `transition` and `transition-duration` declarations (the shorthand's first time is its duration). */
function longTransitions(css: string): string[] {
  const long: string[] = [];
  for (const [, property, value] of css.matchAll(/\btransition(-duration)?\s*:([^;}]*)/gi)) {
    for (const item of (value ?? "").split(",")) {
      const times = item.match(/(?<![\w.-])\d*\.?\d+m?s\b/gi) ?? [];
      for (const time of property ? times : times.slice(0, 1)) {
        const ms = time.toLowerCase().endsWith("ms") ? parseFloat(time) : parseFloat(time) * 1000;
        if (ms > 200) long.push(time);
      }
    }
  }
  return long;
}

/** Whether a `@media (prefers-reduced-motion: reduce)` block sets `transition: none`. */
function reducedMotionDisablesTransitions(css: string): boolean {
  for (const match of css.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*{/gi)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; depth > 0 && end < css.length; end++) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
    }
    if (/\btransition\s*:\s*none\b/i.test(css.slice(match.index, end))) return true;
  }
  return false;
}

/** A tag's name (lowercased) and its attributes (names lowercased, values as written). */
interface Tag {
  name: string;
  attrs: Record<string, string>;
}

/** The start tags in `html`, comments left out. */
function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const [, name, rest] of source.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const [, attr, double, single, bare] of (rest ?? "").matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[(attr ?? "").toLowerCase()] = double ?? single ?? bare ?? "";
    }
    tags.push({ name: (name ?? "").toLowerCase(), attrs });
  }
  return tags;
}

/** The visible text of an HTML fragment: tags dropped, &nbsp; and whitespace runs as one space, ’ as '. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of each `<h2>` section (the heading and what follows it, up to the next `<h2>` or the end of main/body). */
function h2Sections(html: string): string[] {
  const start = html.indexOf("<h2");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = html.slice(start);
  const ends = ["</main>", "</body>"].map((tag) => rest.indexOf(tag)).filter((at) => at >= 0);
  return rest
    .slice(0, Math.min(...ends))
    .split(/(?=<h2\b)/)
    .map(textOf);
}

const SITE = join(STORE, "site");
/** A URL with a scheme ("https:", "mailto:", "data:") or protocol-relative: not a file of the kit. */
const ABSOLUTE = /^\s*(?:[a-z][a-z\d+.-]*:|\/\/)/i;
/** A URL on some host ("https://…", "//…"). */
const REMOTE = /^\s*(?:[a-z][a-z\d+.-]*:)?\/\//i;

/**
 * The file under store/site/ a local reference from a page in store/site/ points at (a directory means its
 * index.html), or null for a reference to the page itself ("#top", "#").
 */
function siteFile(ref: string): string | null {
  const path = ref.trim().replace(/[?#].*$/, "");
  if (path === "") return null;
  const file = join(SITE, path.endsWith("/") || path === "." ? join(path, "index.html") : path);
  expect(file.startsWith(SITE + "/") || file.startsWith(SITE + "\\"), ref).toBe(true);
  return file;
}

/** The URLs a `srcset` lists (each candidate's URL, without its width or density descriptor). */
function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url !== "");
}

/** The `url(...)` values in CSS, unquoted. */
function cssUrls(css: string): string[] {
  return Array.from(css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi), ([, double, single, bare]) => double ?? single ?? bare ?? "");
}

describe("store pages", () => {
  // The plain privacy policy (store/privacy.html) is self-contained: nothing is loaded from elsewhere (links to the
  // stores are fine; they are not requests), and it has no script.
  const external = /(?:src|srcset)\s*=\s*["']?(?:https?:)?\/\/|<link\b[^>]*href\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|@import|<script\b/i;
  const PAGES = ["site/index.html", "site/privacy.html"];

  it("privacy.html says nothing is collected, no network requests, and settings stay in browser storage", () => {
    const html = read("privacy.html");
    expect(html).not.toMatch(external);
    expect(html).toContain(BRAND.name);
    expect(html).toMatch(/Nothing\./);
    expect(html).toMatch(/makes no network requests/);
    expect(html).toMatch(/browser's own extension storage/);
    expect(html).toMatch(/may sync/);
  });

  it("privacy.html and site/privacy.html have the same text, section by section", () => {
    const plain = h2Sections(read("privacy.html"));
    const styled = h2Sections(read("site/privacy.html"));
    expect(plain).toHaveLength(5);
    expect(styled).toEqual(plain);
    expect(textOf(read("site/privacy.html"))).toContain(textOf(read("privacy.html").match(/<p>Last updated:[^<]*<\/p>/)?.[0] ?? "missing"));
  });

  it("both privacy pages give the credit and the support contact as plain links", () => {
    for (const page of ["privacy.html", "site/privacy.html"]) {
      const html = read(page);
      expect(html, page).toContain(BRAND.credit);
      expect(html, page).toContain(`<a href="mailto:${BRAND.support.email}">${BRAND.support.email}</a>`);
      expect(html, page).toContain(`<a href="${BRAND.support.url}">avorforge.com</a>`);
      expect(html, page).not.toContain("Made by …");
    }
  });

  it("site/index.html shows the product name, the credit, the support links and the privacy page, and no tested-sites list", () => {
    const html = read("site/index.html");
    const text = textOf(html);
    expect(html).toContain(`<title>${BRAND.name}</title>`);
    // The heading sets the name in two lines: "Full Window, Not Screen" over "Video Sizer".
    const h1 = textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
    for (const part of BRAND.name.split(": ")) expect(h1).toContain(part);
    // The approved page credits the company in its copyright line ("Copyright © 2026 Avor Forge LLC."), not with
    // BRAND.credit's "Made by" wording; its privacy page (above) has the "Made by" line.
    expect(text).toMatch(new RegExp(`Copyright © \\d{4} ${BRAND.credit.replace(/^Made by /, "")}\\.`));
    const links = tagsOf(html).filter((tag) => tag.name === "a").map((tag) => tag.attrs["href"]);
    expect(links).toContain(`mailto:${BRAND.support.email}`);
    expect(links).toContain(BRAND.support.url);
    expect(links).toContain("privacy.html");
    // The owner dropped the "Tested on" tile (2026-11-01): the page names no sites.
    expect(text).not.toContain("Tested on");
    for (const site of TESTED) expect(text, site).not.toContain(site);
    // The page's icon is the ON icon's master SVG, as it is.
    expect(readFileSync(join(SITE, "assets", "icon.svg"))).toEqual(readFileSync(join(ROOT, "src", "icons", "svg", "window-tl-master-1024.svg")));
  });

  it("every local src, srcset, poster and href in the site's pages points at a file under store/site/", () => {
    const referenced = new Set<string>();
    for (const page of PAGES) {
      for (const tag of tagsOf(read(page))) {
        const refs = ["src", "href", "poster"].flatMap((attr) => (tag.attrs[attr] === undefined ? [] : [tag.attrs[attr]]));
        if (tag.attrs["srcset"] !== undefined) refs.push(...srcsetUrls(tag.attrs["srcset"]));
        for (const ref of refs) {
          if (ref === undefined || ABSOLUTE.test(ref)) continue;
          const file = siteFile(ref);
          if (file === null) continue;
          expect(existsSync(file), `${page}: <${tag.name}> ${ref}`).toBe(true);
          referenced.add(file.slice(SITE.length + 1).replace(/\\/g, "/"));
        }
      }
    }
    for (const file of ["styles.css", "script.js", "fonts/inter.woff2", "privacy.html", "index.html", "assets/hero.mp4", "assets/hero-poster.webp", "assets/icon.svg"]) {
      expect(referenced, file).toContain(file);
    }
    // The stylesheet's own references (the font, the wallpaper) are local files or inline data: URLs.
    const css = read("site/styles.css");
    expect(cssUrls(css).length).toBeGreaterThan(0);
    for (const url of cssUrls(css)) {
      if (url.startsWith("data:")) continue;
      expect(url, url).not.toMatch(ABSOLUTE);
      expect(existsSync(siteFile(url) ?? ""), `styles.css: ${url}`).toBe(true);
    }
  });

  it("the site's pages load nothing from another origin", () => {
    for (const page of PAGES) {
      const html = read(page);
      for (const tag of tagsOf(html)) {
        for (const [attr, value] of Object.entries(tag.attrs)) {
          if (!(REMOTE.test(value) || /^\s*(?:mailto|javascript):/i.test(value)) || attr === "xmlns") continue;
          // Absolute URLs are allowed only where nothing is fetched: <meta> content (Open Graph), the canonical
          // <link>, and plain <a href> links (https and mailto). JSON-LD is script text, checked below.
          const allowed =
            (tag.name === "meta" && attr === "content") ||
            (tag.name === "link" && attr === "href" && tag.attrs["rel"] === "canonical") ||
            (tag.name === "a" && attr === "href" && /^(?:https:|mailto:)/.test(value));
          expect(allowed, `${page}: <${tag.name} ${attr}="${value}">`).toBe(true);
        }
        if (tag.name === "script") {
          // Scripts are JSON-LD data or a local file, never a remote script.
          const local = tag.attrs["src"] !== undefined && !ABSOLUTE.test(tag.attrs["src"]);
          expect(tag.attrs["type"] === "application/ld+json" || local, `${page}: <script>`).toBe(true);
        }
        if (tag.attrs["style"] !== undefined) {
          for (const url of cssUrls(tag.attrs["style"])) expect(url, `${page}: style ${url}`).not.toMatch(REMOTE);
        }
      }
      for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if ((body ?? "").trim() !== "") expect(() => JSON.parse(body ?? ""), `${page}: inline script`).not.toThrow();
      }
      for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        expect(css, page).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
      }
      expect(html, page).not.toMatch(/<(?:iframe|object|embed|base)\b/i);
    }
    expect(read("site/styles.css")).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
    // The script sends nothing anywhere: no network API, and it adds no element that would load something.
    expect(read("site/script.js")).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b|\bimport\s*\(|\bnew\s+Image\b|createElement\(\s*["'](?:script|iframe|img|link)/,
    );
    // The Open Graph image the page names is in the kit.
    expect(read("site/index.html")).toContain('content="https://avorforge.com/full-window/assets/og.jpg"');
    expect(existsSync(join(SITE, "assets", "og.jpg"))).toBe(true);
    // The page links to the public source, in the privacy band and the footer.
    expect(read("site/index.html").match(/href="https:\/\/github\.com\/AvorForge\/full-window"/g)).toHaveLength(2);
  });

  it("flags a remote load, a missing file and a remote script in the checks above", () => {
    const tags = tagsOf('<img src="https://cdn.example/x.png"><a class="x" href="mailto:a@b.c">a</a><script src="//cdn.example/s.js"></script>');
    expect(tags.map((tag) => [tag.name, tag.attrs["src"] ?? tag.attrs["href"]])).toEqual([
      ["img", "https://cdn.example/x.png"],
      ["a", "mailto:a@b.c"],
      ["script", "//cdn.example/s.js"],
    ]);
    expect(REMOTE.test("//cdn.example/s.js")).toBe(true);
    expect(REMOTE.test("og:type")).toBe(false);
    expect(existsSync(siteFile("assets/nope.webp") ?? "")).toBe(false);
    expect(siteFile("./")).toBe(join(SITE, "index.html"));
    expect(siteFile("#top")).toBeNull();
    expect(srcsetUrls("a.webp 1x, b.webp 2x")).toEqual(["a.webp", "b.webp"]);
    expect(h2Sections("<h2>A</h2><p>It’s&nbsp;one</p>\n<h2>B</h2> <p>two</p></main><footer><p>x</p>")).toEqual(["A It's one", "B two"]);
  });

  it("no marketing decoration: no gradients, glow or animation in the extension pages and the plain privacy policy", () => {
    // store/site/ is exempt: the product page was designed with gradients, a hero video and transitions, and the
    // owner approved it as it is. The plain store/privacy.html stays under the rule.
    for (const page of ["privacy.html", "../src/ui/popup.html", "../src/ui/options.html", "../src/ui/ui.css"]) {
      const text = read(page);
      expect(text, page).not.toMatch(/gradient|text-shadow|@keyframes|animation/i);
    }
    // The plain privacy policy has no transitions at all.
    expect(read("privacy.html")).not.toMatch(/transition/i);
    // The extension pages may have short state transitions on controls (200 ms or less), switched off by
    // prefers-reduced-motion: reduce.
    for (const page of ["../src/ui/popup.html", "../src/ui/options.html", "../src/ui/ui.css"]) {
      expect(longTransitions(read(page)), page).toEqual([]);
    }
    expect(reducedMotionDisablesTransitions(read("../src/ui/ui.css"))).toBe(true);
  });

  it("flags a ui.css transition longer than 200 ms, or one without a reduced-motion override", () => {
    const css = read("../src/ui/ui.css");
    expect(longTransitions(`${css}\n.x { transition: opacity 250ms ease; }`)).toEqual(["250ms"]);
    expect(longTransitions(".x { transition: left 0.3s ease 50ms; }")).toEqual(["0.3s"]);
    expect(longTransitions(".x { transition-duration: 120ms, 1s; }")).toEqual(["1s"]);
    expect(reducedMotionDisablesTransitions(".x { transition: left 120ms ease; }")).toBe(false);
  });
});

/** The approved screenshots, in order: the Chrome Web Store gets 1-5, Microsoft Edge Add-ons all six. */
const SCREENSHOTS = [
  "1-fills-the-tab.png",
  "2-everything-else-stays-put.png",
  "3-pick-any-size.png",
  "4-or-pop-it-out.png",
  "5-collects-nothing.png",
  "6-player-still-works.png",
];

describe("store images", () => {
  it("six 1280 × 800 screenshots, a 440 × 280 promo tile, a 1400 × 560 marquee and a 300 × 300 Edge logo", () => {
    expect(readdirSync(join(STORE, "screenshots")).sort()).toEqual(SCREENSHOTS);
    for (const shot of SCREENSHOTS) expect(pngSize(`screenshots/${shot}`), shot).toEqual({ width: 1280, height: 800 });
    expect(pngSize("promo-tile-440x280.png")).toEqual({ width: 440, height: 280 });
    expect(pngSize("marquee-1400x560.png")).toEqual({ width: 1400, height: 560 });
    expect(pngSize("edge-logo-300x300.png")).toEqual({ width: 300, height: 300 });
    expect(existsSync(join(SITE, "screenshot.png"))).toBe(false);
    expect(readdirSync(STORE).sort()).toEqual([
      "edge-logo-300x300.png",
      "listing.md",
      "marquee-1400x560.png",
      "privacy.html",
      "promo-tile-440x280.png",
      "screenshots",
      "site",
    ]);
  });

  it("listing.md gives the Chrome Web Store screenshots 1-5 and the marquee, and Edge all six", () => {
    const listing = read("listing.md");
    const chrome = section(listing, "Chrome Web Store fields");
    expect(chrome).toContain("- Screenshots: `store/screenshots/1-5` (the Chrome Web Store takes five)");
    expect(chrome).toContain("- Small promo tile: `store/promo-tile-440x280.png`");
    expect(chrome).toContain("- Marquee promo tile: `store/marquee-1400x560.png`");
    expect(SCREENSHOTS.filter((shot) => /^[1-5]-/.test(shot))).toHaveLength(5);
    const edge = section(listing, "Microsoft Edge Add-ons fields");
    expect(edge).toContain("- Screenshots: all six files in `store/screenshots/`");
    expect(edge).toContain("- Store logo: `store/edge-logo-300x300.png`");
  });

  it("npm run store:assets makes only the Edge logo; the approved images and page are committed files", () => {
    const { scripts } = JSON.parse(readText(join(ROOT, "package.json")));
    expect(scripts["store:assets"]).toBe("node scripts/store-assets.mjs");
    // The script's code, without its comments (which name the approved files it leaves alone).
    const code = readText(join(ROOT, "scripts", "store-assets.mjs")).replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain('"edge-logo-300x300.png"');
    expect(code.match(/\bwriteFileSync\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/screenshots|promo-tile|marquee|"site"|copyFileSync|\.screenshot\(\s*\{\s*path/);
  });
});
