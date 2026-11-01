// Fixture 5 (root-player.html?activity): while a document-root fullscreen is up, the player shows and hides
// its controls and a tooltip on every mouse move, as YouTube's does. Regression for the black flicker of the
// video on YouTube (docs/ARCHITECTURE.md §3 "Document-root requests", §8): the extension must make no style
// or marker writes and run no neutralise/restore cycles in response, and nothing of its backdrop may be
// composited over the video (a clip-path'ed backdrop was, with its clip mask, in fill-tab and custom-rect).
import {
  expect,
  openFixture,
  readLog,
  screenRectOf,
  setOptions,
  test,
  types,
  viewportOf,
  type BrowserContext,
  type Page,
  type Rect,
} from "./harness/extension";
import { expectedRect } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];
const NONE = { style: 0, markers: 0, attributes: 0, sheets: 0 };

interface Writes {
  style: number;
  markers: number;
  attributes: number;
  sheets: number;
  callbacks: number;
  log: string[];
}

/**
 * Counts the DOM writes made by the extension's content scripts: init scripts run before the MAIN-world
 * content script captures its natives, so it captures these wrappers, which tell its calls apart from the
 * page's by the chrome-extension:// URL on the stack. Same-value style writes leave no mutation record, so a
 * MutationObserver alone would miss them. Marker writes (data-cfs-*) are the neutralise/restore cycles.
 */
function countExtensionWrites(): void {
  const stats = { style: 0, markers: 0, attributes: 0, sheets: 0, callbacks: 0, log: [] as string[] };
  Object.defineProperty(window, "__cfsWrites", { value: stats });
  const ours = (): boolean => (new Error().stack ?? "").includes("chrome-extension://");
  type Kind = "style" | "markers" | "attributes" | "sheets";
  const wrap = (proto: object, name: string, kind: (args: unknown[]) => Kind): void => {
    const target = proto as Record<string, (...args: unknown[]) => unknown>;
    const original = target[name] as (...args: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (ours()) {
        stats[kind(args)]++;
        if (stats.log.length < 40) stats.log.push(`${name}(${args.map(String).join(", ").slice(0, 80)})`);
      }
      return original.apply(this, args);
    };
  };
  const attribute = ([name]: unknown[]): Kind => (name === "style" ? "style" : String(name).startsWith("data-cfs") ? "markers" : "attributes");
  wrap(CSSStyleDeclaration.prototype, "setProperty", () => "style");
  wrap(CSSStyleDeclaration.prototype, "removeProperty", () => "style");
  wrap(Element.prototype, "setAttribute", attribute);
  wrap(Element.prototype, "removeAttribute", attribute);
  wrap(CSSStyleSheet.prototype, "replaceSync", () => "sheets");
  const Native = window.MutationObserver;
  const Counted = function (this: unknown, callback: MutationCallback) {
    const mine = ours();
    return new Native((records, observer) => {
      if (mine) stats.callbacks++;
      callback(records, observer);
    });
  } as unknown as typeof MutationObserver;
  Counted.prototype = Native.prototype;
  window.MutationObserver = Counted;
}

async function writes(page: Page): Promise<Writes> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __cfsWrites: Writes }).__cfsWrites)));
}

/** No writes since the reset. The extension's observers may run on the tooltip insertions; they must find nothing to do. */
async function expectNoWrites(page: Page): Promise<void> {
  const { style, markers, attributes, sheets, log } = await writes(page);
  expect({ style, markers, attributes, sheets }, log.join("\n")).toEqual(NONE);
}

async function resetWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stats = (window as unknown as { __cfsWrites: Writes }).__cfsWrites;
    for (const key of ["style", "markers", "attributes", "sheets", "callbacks"] as const) stats[key] = 0;
    stats.log.length = 0;
  });
}

/** Mouse moves over the video, along it, and on and off it, for about three seconds. */
async function moveAround(page: Page, video: Rect, off: { x: number; y: number }): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i <= 40; i++) {
      await page.mouse.move(video.left + 10 + ((video.width - 20) * i) / 40, video.top + video.height * (0.3 + 0.4 * Math.abs(Math.sin(i / 6))));
      await page.waitForTimeout(16);
    }
    await page.mouse.move(off.x, off.y, { steps: 5 });
    await page.waitForTimeout(150);
    await page.mouse.move(video.left + video.width / 2, video.top + video.height / 2, { steps: 5 });
    await page.waitForTimeout(250); // the controls autohide
  }
}

/** Composited layers (CDP LayerTree) of the backdrop and its strips, with the page rect of each node. */
async function backdropLayers(context: BrowserContext, page: Page): Promise<Array<{ node: string; rect: Rect }>> {
  const session = await context.newCDPSession(page);
  try {
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-cfs-backdrop], [data-cfs-backdrop] *" });
    const ours = new Map<number, number>();
    for (const [index, nodeId] of nodeIds.entries()) ours.set((await session.send("DOM.describeNode", { nodeId })).node.backendNodeId, index);
    const tree: { layers: Array<{ backendNodeId?: number; drawsContent: boolean }> | null } = { layers: null };
    session.on("LayerTree.layerTreeDidChange", (event) => {
      if (event.layers) tree.layers ??= event.layers;
    });
    await session.send("LayerTree.enable");
    // The tree comes with the next frame; a mouse move over the player makes sure there is one.
    await expect
      .poll(async () => {
        if (!tree.layers) await page.mouse.move(5 + Math.random() * 10, 300);
        return tree.layers !== null;
      })
      .toBe(true);
    await session.send("LayerTree.disable");
    const layers = tree.layers ?? [];
    const found: Array<{ node: string; rect: Rect }> = [];
    for (const layer of layers) {
      const index = layer.backendNodeId === undefined ? undefined : ours.get(layer.backendNodeId);
      if (index === undefined || !layer.drawsContent) continue;
      const rect = await screenRectOf(page.locator("[data-cfs-backdrop], [data-cfs-backdrop] *").nth(index));
      found.push({ node: index === 0 ? "backdrop" : `strip ${index}`, rect });
    }
    return found;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.left + b.width - 1 && b.left < a.left + a.width - 1 && a.top < b.top + b.height - 1 && b.top < a.top + a.height - 1;

/** The video's box on screen (the page measures in the scaled root's own space in custom-rect). */
async function videoRect(page: Page): Promise<Rect> {
  return screenRectOf(page.locator("#video"));
}

test.describe("fixture 5: document-root player, controls shown and hidden on mouse movement", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(countExtensionWrites);
  });

  test("fill-tab: no style writes, no neutralise/restore cycles, and no backdrop at all over the video", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/root-player.html?activity`);
    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    // The counters see the extension: pinning <html> wrote styles and markers.
    const entered = await writes(page);
    expect(entered.style).toBeGreaterThan(0);
    expect(entered.markers).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await resetWrites(page);

    const viewport = await viewportOf(page);
    const video = await videoRect(page);
    await moveAround(page, video, { x: viewport.width - 2, y: 2 });
    expect(await page.evaluate(() => (window as unknown as { __activity: number }).__activity)).toBeGreaterThan(50);
    await expectNoWrites(page);
    // The pin held throughout (the page also kept writing custom properties on <html>).
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("position"))).toBe("fixed");

    // The rectangle is the viewport: the backdrop is not rendered, so nothing of it is composited over the video.
    expect(await backdropLayers(context, page)).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-cfs-backdrop]")!).display)).toBe("none");

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
  });

  test("custom-rect: no style writes, no neutralise/restore cycles, and the backdrop's strips stay off the video", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const rect = { width: 640, widthUnit: "px", height: 360, heightUnit: "px", anchor: "center" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect, backgroundColor: "#13579b" });
    await openFixture(page, `${origins.a}/root-player.html?activity`);
    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect((await writes(page)).style).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await resetWrites(page);

    const viewport = await viewportOf(page);
    const expected = expectedRect(viewport, rect);
    const video = await videoRect(page);
    await moveAround(page, video, { x: Math.floor(expected.left / 2), y: Math.floor(expected.top / 2) });
    expect(await page.evaluate(() => (window as unknown as { __activity: number }).__activity)).toBeGreaterThan(50);
    await expectNoWrites(page);

    // The backdrop box paints nothing and has no layer; any strip with a layer of its own lies off the video.
    const layers = await backdropLayers(context, page);
    expect(layers.map((layer) => layer.node)).not.toContain("backdrop");
    for (const layer of layers) expect(intersects(layer.rect, video), `${layer.node} ${JSON.stringify(layer.rect)}`).toBe(false);
    const strips: Rect[] = [];
    for (let i = 0; i < 4; i++) strips.push(await screenRectOf(page.locator("[data-cfs-backdrop] > div").nth(i)));
    expect(strips).toHaveLength(4);
    for (const strip of strips) expect(intersects(strip, expected), JSON.stringify(strip)).toBe(false);

    await page.click("#exit");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
  });
});
