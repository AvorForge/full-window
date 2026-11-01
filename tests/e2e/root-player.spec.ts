// Fixture 5 (root-player.html): a watch page that, like YouTube's, asks for fullscreen on <html> rather than
// on its player, sizes the player with 100vh and keeps writing custom properties on <html>. Regression for the
// black tab on YouTube (docs/ARCHITECTURE.md §3 "Document-root requests"): the backdrop, a child of <html>,
// painted over the whole page because the fullscreen element was its own ancestor.
import {
  backdropCount,
  expect,
  expectColour,
  hitAtScreen,
  openFixture,
  pixelAt,
  readLog,
  realFullscreenElement,
  rectOf,
  screenRectOf,
  setOptions,
  test,
  types,
  viewportOf,
  type Page,
  type Rect,
} from "./harness/extension";
import { expectedRect, pointOutside } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];
const VIDEO = "#1464dc";

/** The id (or tag) of the topmost element at a point, or "backdrop" (the backdrop or one of its strips). */
async function hitAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return null;
      return hit.closest("[data-cfs-backdrop]") ? "backdrop" : hit.id || hit.localName;
    },
    { x, y },
  );
}

/**
 * The page state an exit must give back: style attributes, classes, markers, sheets, scroll position. <html>'s
 * style is checked separately, because the page writes it during fullscreen (expectRootStyleKept).
 */
async function pageState(page: Page): Promise<unknown> {
  return page.evaluate(() => ({
    nodes: [document.documentElement, document.body, ...document.querySelectorAll("#shell, #player-box, #player, #video")].map((node) => ({
      node: node.id || node.localName,
      style: node === document.documentElement ? "(html)" : node.getAttribute("style"),
      class: node.getAttribute("class"),
      fullscreen: node.hasAttribute("fullscreen"),
      markers: node.getAttributeNames().filter((name) => name.startsWith("data-cfs")),
    })),
    sheets: document.adoptedStyleSheets.length,
    scroll: [window.scrollX, window.scrollY],
  }));
}

/** Waits until the page wrote <html>'s style a few times while fake-fullscreen; the pin must stay in place. */
async function pageWroteRoot(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.getPropertyValue("--page-writes")))).toBeGreaterThan(5);
}

/** After exit, <html> has its original style plus the custom property the page set meanwhile, and none of ours. */
async function expectRootStyleKept(page: Page, original: string | null): Promise<void> {
  const after = await page.evaluate(() => document.documentElement.getAttribute("style"));
  expect(after).toMatch(new RegExp(`^${original}; --page-writes: \\d+;$`));
}

test.describe("fixture 5: document-root player", () => {
  test("fill-tab: the player shows above the backdrop, its controls work, and Escape restores the page", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/root-player.html`);
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await pageState(page);
    expect(before).toMatchObject({ scroll: [0, 300] });
    const htmlStyle = await page.evaluate(() => document.documentElement.getAttribute("style"));

    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
    // The page's fullscreenchange handler switched to its fullscreen layout (100vh player).
    expect(await page.locator("#shell").getAttribute("fullscreen")).toBe("");

    const viewport = await viewportOf(page);
    const full = { left: 0, top: 0, width: viewport.width, height: viewport.height };
    expect(await rectOf(page.locator("#player"))).toEqual(full);
    // The bug: the backdrop won hit testing and painted the tab black. Now the video and the controls are on top.
    expect(await backdropCount(page)).toBe(1);
    expect(await hitAt(page, viewport.width / 2, viewport.height / 2)).toBe("video");
    expectColour(await pixelAt(page, Math.floor(viewport.width / 2), Math.floor(viewport.height / 2) - 60), VIDEO, 12);
    const play = await rectOf(page.locator("#play"));
    expect(await hitAt(page, play.left + play.width / 2, play.top + play.height / 2)).toBe("play");
    await page.click("#play");
    expect(types(await readLog(page), ["play"])).toEqual(["play"]);

    // Writes to <html>'s own style (custom properties) leave the pin in place.
    await pageWroteRoot(page);
    expect(await rectOf(page.locator("#player"))).toEqual(full);

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await pageState(page)).toEqual(before);
    await expectRootStyleKept(page, htmlStyle);
    expect(await backdropCount(page)).toBe(0);
  });

  test("custom-rect: the page is scaled into the rectangle, the backdrop covers the rest, the exit button restores", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const rect = { width: 640, widthUnit: "px", height: 360, heightUnit: "px", anchor: "center" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect, backgroundColor: "#13579b" });
    await openFixture(page, `${origins.a}/root-player.html`);
    const before = await pageState(page);
    const htmlStyle = await page.evaluate(() => document.documentElement.getAttribute("style"));

    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();

    const viewport = await viewportOf(page);
    const expected = expectedRect(viewport, rect);
    // <html> is laid out at the rectangle's aspect ratio, at least viewport-sized, and scaled onto it, so the
    // 100vh player fits the rectangle (pinning <html> to the rectangle alone would let it overflow).
    const scale = Math.min(expected.width / viewport.width, expected.height / viewport.height);
    const near = (actual: Rect, wanted: Rect): void => {
      for (const side of ["left", "top", "width", "height"] as const) expect(Math.abs(actual[side] - wanted[side]), side).toBeLessThanOrEqual(1);
    };
    // Screen geometry comes from the browser: the page itself now measures in <html>'s unscaled space.
    near(await screenRectOf(page.locator("html")), expected);
    near(await screenRectOf(page.locator("#player")), { ...expected, height: viewport.height * scale });
    expect(await hitAtScreen(context, page, expected.left + expected.width / 2, expected.top + expected.height / 2)).toBe("video");
    expectColour(await pixelAt(page, expected.left + expected.width / 2, expected.top + expected.height / 2 - 30), VIDEO, 12);
    // Around the rectangle: the backdrop, in the chosen colour, over the masthead too, and it takes the clicks.
    const outside = pointOutside(viewport, expected);
    expectColour(await pixelAt(page, outside.x, outside.y), "#13579b");
    expectColour(await pixelAt(page, 5, 5), "#13579b");
    expect(await hitAtScreen(context, page, outside.x, outside.y)).toBe("backdrop");
    const controls = await screenRectOf(page.locator("#controls"));
    expect(controls.top + controls.height).toBeLessThanOrEqual(expected.top + expected.height + 1);
    await page.click("#play");
    expect(types(await readLog(page), ["play"])).toEqual(["play"]);

    await pageWroteRoot(page);
    await page.click("#exit");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await pageState(page)).toEqual(before);
    await expectRootStyleKept(page, htmlStyle);
    expect(await backdropCount(page)).toBe(0);
  });

  test("custom-rect: the scaled page sees one coordinate space, so its seek bar lands where the pointer is and its tooltips sit on their buttons", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    // Regression for YouTube in custom-rect: <html> is scaled onto the rectangle, the player maps the pointer
    // with (clientX - getBoundingClientRect().left) / offsetWidth, and offsetWidth is the unscaled layout width.
    // A click at 25 % of the bar on screen landed at 20 %, a drag to 60 % at 48 % (scale 0.8).
    const rect = { width: 80, widthUnit: "%", height: 80, heightUnit: "%", anchor: "center" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect });
    await openFixture(page, `${origins.a}/root-player.html`);
    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    const viewport = await viewportOf(page);
    const expected = expectedRect(viewport, rect);
    expect(Math.min(expected.width / viewport.width, expected.height / viewport.height)).toBeLessThan(0.85);

    const bar = await screenRectOf(page.locator("#seek"));
    const y = bar.top + bar.height / 2;
    const fractions = async (): Promise<Array<{ phase: unknown; fraction: unknown }>> =>
      (await readLog(page)).filter((entry) => entry.type === "seek").map(({ phase, fraction }) => ({ phase, fraction }));
    await page.mouse.click(bar.left + bar.width * 0.25, y);
    await page.mouse.move(bar.left + bar.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(bar.left + bar.width * 0.6, y, { steps: 6 });
    await page.mouse.up();
    const seen = await fractions();
    const at = (phase: string, index = 0): number => Number(seen.filter((entry) => entry.phase === phase)[index]?.fraction);
    expect(at("down")).toBeCloseTo(0.25, 2);
    expect(at("down", 1)).toBeCloseTo(0.3, 2);
    expect(at("up", 1)).toBeCloseTo(0.6, 2);

    // A tooltip placed (position: fixed) from the button's getBoundingClientRect() sits right above it on screen.
    await page.hover("#play");
    const play = await screenRectOf(page.locator("#play"));
    const tip = await screenRectOf(page.locator("#tip"));
    const scale = Math.min(expected.width / viewport.width, expected.height / viewport.height);
    expect(Math.abs(tip.left - play.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(tip.top - (play.top - 24 * scale))).toBeLessThanOrEqual(1);
    // The page's own hit test, in its own space, finds the button it measured.
    expect(await page.evaluate(() => {
      const box = document.getElementById("play")!.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.id;
    })).toBe("play");

    await page.click("#exit");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    // Back to one space: the page measures the screen again.
    const after = await page.evaluate(() => document.getElementById("seek")!.getBoundingClientRect().left);
    expect(Math.abs(after - (await screenRectOf(page.locator("#seek"))).left)).toBeLessThanOrEqual(1);
  });
});
