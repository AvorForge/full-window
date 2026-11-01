// `npm run icons`: re-renders the committed icon PNGs (src/icons/*.png) from their SVG sources (src/icons/svg/)
// with Playwright's Chromium at deviceScaleFactor 1, the way the artwork's own exports were made: each SVG is
// the whole page at its own size, on a transparent background. The build copies the PNGs; it never renders.
// The 16 and 32 px icons are separate pixel-snapped drawings, not scaled copies of the master.
//
//   npm run icons              rewrite the PNGs
//   npm run icons -- --check   render and compare pixel for pixel with the committed PNGs; exit 1 on a difference
//
// Uses the browser at PW_TEST_CONNECT_WS_ENDPOINT when set, else launches the Chromium that @playwright/test
// pins. It never downloads browsers.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { ROOT } from "./build.mjs";

/** ON: the site is switched on. OFF: it is off, or the extension does not run on the page (the default). */
export const ICONS = [
  { svg: "src/icons/svg/window-tl-16.svg", png: "src/icons/icon-16.png", size: 16 },
  { svg: "src/icons/svg/window-tl-32.svg", png: "src/icons/icon-32.png", size: 32 },
  { svg: "src/icons/svg/window-tl-48.svg", png: "src/icons/icon-48.png", size: 48 },
  // 96 × 96 artwork centered in 16 px of transparent padding, as the stores ask; the padding is in the SVG.
  { svg: "src/icons/svg/window-tl-128.svg", png: "src/icons/icon-128.png", size: 128 },
  { svg: "src/icons/svg/window-tl-off-16.svg", png: "src/icons/icon-off-16.png", size: 16 },
  { svg: "src/icons/svg/window-tl-off-32.svg", png: "src/icons/icon-off-32.png", size: 32 },
];

/** The ON master (1024 px, no padding): the store images' icon. */
export const ICON_MASTER = "src/icons/svg/window-tl-master-1024.svg";

/**
 * A page that is just `svg`, drawn at size × size CSS pixels on a transparent background, inside `padding`
 * transparent pixels on each side.
 * @param {string} svg @param {number} size @param {number} [padding]
 */
export function iconPage(svg, size, padding = 0) {
  const pad = padding > 0 ? `body{box-sizing:border-box;padding:${padding}px}` : "";
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;width:${size}px;height:${size}px}${pad}svg{display:block;width:100%;height:100%}</style>${svg}`;
}

/**
 * Renders `svg` to a size × size PNG, with `padding`, in the given context (deviceScaleFactor 1).
 * @param {import("@playwright/test").BrowserContext} context @param {string} svg @param {number} size @param {number} [padding]
 * @returns {Promise<Buffer>}
 */
export async function renderSvg(context, svg, size, padding = 0) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconPage(svg, size, padding));
    return await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  } finally {
    await page.close();
  }
}

/**
 * The RGBA pixels of an 8-bit RGBA, non-interlaced PNG (what Chromium writes).
 * @param {Buffer} png @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function decodeRgbaPng(png) {
  let width = 0;
  let height = 0;
  /** @type {Buffer[]} */
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("expected an 8-bit RGBA, non-interlaced PNG");
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** @param {{ check?: boolean }} [options] @returns {Promise<string[]>} the PNGs that differ (check) or were written */
export async function renderIcons(options = {}) {
  // Imported here, so the tests can read ICONS and decodeRgbaPng without loading Playwright.
  const { chromium } = await import("@playwright/test");
  const endpoint = process.env["PW_TEST_CONNECT_WS_ENDPOINT"];
  const browser = endpoint ? await chromium.connect(endpoint) : await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  /** @type {string[]} */
  const listed = [];
  try {
    for (const icon of ICONS) {
      const png = await renderSvg(context, readFileSync(join(ROOT, icon.svg), "utf8"), icon.size);
      const path = join(ROOT, icon.png);
      if (options.check) {
        const want = decodeRgbaPng(readFileSync(path));
        const got = decodeRgbaPng(png);
        const same = want.width === got.width && want.height === got.height && want.pixels.equals(got.pixels);
        console.log(`${same ? "same" : "DIFFERENT"}  ${icon.png} from ${icon.svg}`);
        if (!same) listed.push(icon.png);
      } else {
        writeFileSync(path, png);
        console.log(`wrote ${icon.png} from ${icon.svg}`);
        listed.push(icon.png);
      }
    }
    console.log(`Chromium ${browser.version()}, deviceScaleFactor 1`);
  } finally {
    await context.close();
    // A connected browser belongs to someone else: disconnect only.
    await browser.close();
  }
  return listed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  renderIcons({ check }).then(
    (listed) => {
      if (check && listed.length > 0) {
        console.error(`${listed.length} PNG(s) differ from their SVG source`);
        process.exit(1);
      }
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
