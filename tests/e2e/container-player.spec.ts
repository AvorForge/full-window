// Fixture 2 (container-player.html): a YouTube-style div.player > video + controls inside a transformed,
// overflow-hidden, z-index wrapper, page :fullscreen / ::backdrop CSS, a shadow-DOM variant, and an
// anti-tamper feature check of the Fullscreen API.
import {
  backdropCount,
  evaluateUnpatched,
  expect,
  expectColour,
  openFixture,
  pixelAt,
  readLog,
  realFullscreenElement,
  rectOf,
  screenRectOf,
  setOptions,
  styleChain,
  test,
  types,
  viewportOf,
  type Page,
} from "./harness/extension";
import { expectedRect, pointOutside } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];

/** Computed background colour of an element of the document, or of the shadow root of `shadowHost`. */
async function background(page: Page, selector: string, shadowHost?: string): Promise<string | null> {
  return page.evaluate(
    ({ selector, shadowHost }) => {
      const root = shadowHost ? document.querySelector(shadowHost)?.shadowRoot : document;
      const element = root?.querySelector(selector);
      return element ? getComputedStyle(element).backgroundColor : null;
    },
    { selector, shadowHost },
  );
}

test.describe("fixture 2: container player", () => {
  test("the feature check sees native-looking functions, identical to an unpatched world", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/container-player.html`);
    const features = await page.evaluate(() => (window as unknown as { __features: Record<string, unknown> }).__features);
    expect(features).toMatchObject({
      type: "function",
      toString: "function requestFullscreen() { [native code] }",
      callToString: "function requestFullscreen() { [native code] }",
      native: true,
      toStringOfToString: "function toString() { [native code] }",
      name: "requestFullscreen",
      length: 0,
      hasPrototype: false,
      getterToString: "function get fullscreenElement() { [native code] }",
      getterName: "get fullscreenElement",
      exitToString: "function exitFullscreen() { [native code] }",
    });
    // The same probe in an isolated world, whose prototypes the extension never touched.
    const natives = await evaluateUnpatched<Record<string, unknown>>(
      context,
      page,
      `(() => {
        const source = Function.prototype.toString;
        const request = Element.prototype.requestFullscreen;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "requestFullscreen");
        const getter = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");
        return {
          type: typeof request, toString: request.toString(), callToString: source.call(request),
          native: /\\[native code\\]/.test(source.call(request)), toStringOfToString: source.call(source),
          name: request.name, length: request.length,
          hasPrototype: Object.prototype.hasOwnProperty.call(request, "prototype"),
          writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable,
          getterToString: source.call(getter.get), getterName: getter.get.name,
          exitToString: source.call(Document.prototype.exitFullscreen),
        };
      })()`,
    );
    expect(features).toEqual(natives);
  });

  test("the player escapes its transformed, clipped, low z-index wrapper and gets its :fullscreen rules", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/container-player.html`);
    const player = page.locator("#player");
    const stylesBefore = await styleChain(player);
    const videoStyleBefore = await page.locator("#video").getAttribute("style");
    expect(await background(page, ".controls")).toBe("rgb(200, 0, 0)");

    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(types(await readLog(page), ["tampered"])).toEqual([]);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("player");
    // The player's own fullscreenchange handler ran with the getters set (YouTube style class toggle).
    expect(await player.getAttribute("class")).toBe("player is-fullscreen");

    const viewport = await viewportOf(page);
    expect(await rectOf(player)).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    // Above the fixed z-index 1000 masthead and the z-index 10 sidebar, despite the z-index 1 wrapper.
    expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 10)?.closest("#player")?.id)).toBe("player");
    expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth - 3, window.innerHeight - 60)?.closest("#player")?.id)).toBe(
      "player",
    );
    // The page's .player:fullscreen rules apply; the video fills the player.
    expect(await background(page, ".controls")).toBe("rgb(0, 0, 200)");
    expect(await background(page, "#player")).toBe("rgb(5, 6, 7)");
    expect(await rectOf(page.locator("#video"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect((await readLog(page)).filter((entry) => entry.type === "keydown")).toEqual([]);
    expect(await styleChain(player)).toEqual(stylesBefore);
    expect(stylesBefore.find((entry) => entry.node === "#wrapper")?.style).toBe("outline: 1px dotted rgb(1, 2, 3)");
    expect(await page.locator("#video").getAttribute("style")).toBe(videoStyleBefore);
    expect(await player.getAttribute("class")).toBe("player");
    expect(await background(page, ".controls")).toBe("rgb(200, 0, 0)");
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("wrapper")!).transform)).not.toBe("none");
    expect(await backdropCount(page)).toBe(0);
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
  });

  test("custom-rect: the page's ::backdrop colour does not replace the chosen background", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const rect = { width: 640, widthUnit: "px", height: 50, heightUnit: "%", anchor: "top-right" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect, backgroundColor: "#13579b" });
    await openFixture(page, `${origins.a}/container-player.html`);
    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);

    const viewport = await viewportOf(page);
    const expected = expectedRect(viewport, rect);
    // On screen (the page measures the scaled player in its own unscaled space, docs/ARCHITECTURE.md §3).
    const near = async (selector: string): Promise<void> => {
      const actual = await screenRectOf(page.locator(selector));
      for (const side of ["left", "top", "width", "height"] as const) expect(Math.abs(actual[side] - expected[side]), `${selector} ${side}`).toBeLessThanOrEqual(1);
    };
    await near("#player");
    // Regression for Twitch in custom-rect: a fixed, viewport-sized layer of the player stays inside the rectangle
    // (it covered the whole tab: nothing between it and the pinned player was its containing block). It spans the
    // rectangle up to the thin band an aspect ratio other than the viewport's leaves (docs/ARCHITECTURE.md §8).
    const layer = await screenRectOf(page.locator("#persistent"));
    expect(layer.left).toBeGreaterThanOrEqual(expected.left - 1);
    expect(layer.top).toBeGreaterThanOrEqual(expected.top - 1);
    expect(layer.left + layer.width).toBeLessThanOrEqual(expected.left + expected.width + 1);
    expect(layer.top + layer.height).toBeLessThanOrEqual(expected.top + expected.height + 1);
    expect(layer.width).toBeGreaterThan(expected.width * 0.98);
    expect(layer.height).toBeGreaterThan(expected.height * 0.98);
    // In its own space the player is laid out at least viewport-sized, as the viewport it is in real fullscreen.
    const own = await rectOf(page.locator("#player"));
    expect(own.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(own.height).toBeGreaterThanOrEqual(viewport.height - 1);
    const point = pointOutside(viewport, expected);
    expectColour(await pixelAt(page, point.x, point.y), "#13579b");
    // The masthead (fixed, z-index 1000) is hidden behind the backdrop too.
    expectColour(await pixelAt(page, 5, 5), "#13579b");
  });

  test("shadow-DOM variant: retargeted getters, composed events, shadow :fullscreen rules, exact restore", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/container-player.html`);
    const player = page.locator("#s-player");
    const stylesBefore = await styleChain(player);
    expect(stylesBefore.map((entry) => entry.node)).toEqual(["#s-player", "#s-wrapper", "#shadow-host", "#main", "body", "html"]);

    await page.click("#s-fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    const log = await readLog(page);
    // Composed: the event reached the document listener from inside the shadow root, with the element as origin.
    expect(log.find((entry) => entry.type === "fullscreenchange")).toMatchObject({ target: "#s-player", fullscreenElement: "#shadow-host" });
    expect(
      await page.evaluate(() => {
        const host = document.getElementById("shadow-host")!;
        return {
          document: document.fullscreenElement?.id ?? null,
          shadowRoot: host.shadowRoot!.fullscreenElement?.id ?? null,
          hostMatches: host.matches(":fullscreen"),
          playerMatches: host.shadowRoot!.getElementById("s-player")!.matches(":fullscreen"),
          query: host.shadowRoot!.querySelector(":fullscreen")?.id ?? null,
        };
      }),
    ).toEqual({ document: "shadow-host", shadowRoot: "s-player", hostMatches: false, playerMatches: true, query: "s-player" });
    expect(await page.locator("#s-player").getAttribute("class")).toBe("player is-fullscreen");

    const viewport = await viewportOf(page);
    expect(await rectOf(player)).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    expect(await background(page, ".controls", "#shadow-host")).toBe("rgb(0, 0, 200)");

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await styleChain(player)).toEqual(stylesBefore);
    expect(await background(page, ".controls", "#shadow-host")).toBe("rgb(200, 0, 0)");
    expect(await page.evaluate(() => document.getElementById("shadow-host")!.shadowRoot!.adoptedStyleSheets.length)).toBe(0);
    expect(await backdropCount(page)).toBe(0);
  });
});
