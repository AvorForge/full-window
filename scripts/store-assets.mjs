// `npm run store:assets`: renders the one store image made in the repo, store/edge-logo-300x300.png (the ON icon,
// for Edge Add-ons' store logo): the ON master SVG (src/icons/svg/) as 240 × 240 artwork in 30 px of transparent
// padding, drawn by Playwright's Chromium at deviceScaleFactor 1, as `npm run icons` draws the icons.
//
// The rest of store/ is not generated: the screenshots (store/screenshots/*.png), the promo tile
// (store/promo-tile-440x280.png), the marquee (store/marquee-1400x560.png) and the product page (store/site/) are
// designed assets, made outside the repo from real Chrome captures and approved by the owner, so they are
// committed as files. Replace them with new approved files; never regenerate them.
//
// Uses the browser at PW_TEST_CONNECT_WS_ENDPOINT when set, else launches the Chromium that @playwright/test
// pins. It never downloads browsers.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";
import { ICON_MASTER, renderSvg } from "./render-icons.mjs";

export const EDGE_LOGO = join(ROOT, "store", "edge-logo-300x300.png");

export async function generateStoreAssets() {
  const endpoint = process.env["PW_TEST_CONNECT_WS_ENDPOINT"];
  const browser = endpoint ? await chromium.connect(endpoint) : await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    // The master has no padding: 240 × 240 artwork in 30 px of transparent padding.
    writeFileSync(EDGE_LOGO, await renderSvg(context, readFileSync(join(ROOT, ICON_MASTER), "utf8"), 300, 30));
    console.log(`wrote ${EDGE_LOGO} (Chromium ${browser.version()}, deviceScaleFactor 1)`);
  } finally {
    await context.close();
    // A connected browser belongs to someone else: disconnect only.
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateStoreAssets().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
