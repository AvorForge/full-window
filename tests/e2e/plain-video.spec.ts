// Fixture 1 (plain-video.html): a <video> whose button calls video.requestFullscreen().
import {
  backdropCount,
  clearLog,
  expect,
  expectColour,
  openFixture,
  pixelAt,
  readLog,
  realFullscreenElement,
  rectOf,
  setOptions,
  styleChain,
  test,
  types,
  viewportOf,
  windowOf,
  FULLSCREEN_EVENTS,
  type LogEntry,
} from "./harness/extension";
import { expectedRect, pointOutside, type RectCase } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];

test.describe("fixture 1: plain video", () => {
  test("fill-tab: the page's getters report fullscreen while the browser is not fullscreen", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const windowBefore = await windowOf(context, page);
    const outerBefore = await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));

    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);

    // The browser is not in real fullscreen.
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await page.evaluate(() => window.matchMedia("(display-mode: fullscreen)").matches)).toBe(false);
    expect(await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }))).toEqual(outerBefore);
    expect(await windowOf(context, page)).toEqual(windowBefore);
    expect(windowBefore.windowState).toBe("normal");

    // ...while every getter the page can ask says it is.
    const fullscreen = {
      fullscreenElement: "#video",
      webkitFullscreenElement: "#video",
      webkitCurrentFullScreenElement: "#video",
      fullscreen: true,
      webkitIsFullScreen: true,
      matchedFullscreen: "#video",
    };
    expect(await page.evaluate(() => (window as unknown as { CFS: { getters(): unknown } }).CFS.getters())).toEqual(fullscreen);
    expect(await page.evaluate(() => document.getElementById("video")?.matches(":fullscreen"))).toBe(true);

    // Promise first (with the getters already set), then the change event on the video, then resize.
    const log = await readLog(page);
    expect(types(log, ["request", "promise", "reject", "fullscreenchange", "fullscreenerror", "resize"])).toEqual([
      "request",
      "promise",
      "fullscreenchange",
      "resize",
    ]);
    expect(log.find((entry) => entry.type === "promise")).toMatchObject(fullscreen);
    expect(log.find((entry) => entry.type === "fullscreenchange")).toMatchObject({ ...fullscreen, target: "#video", trusted: false });

    // fill-tab: the video covers the whole viewport, above the page.
    const viewport = await viewportOf(page);
    expect(await rectOf(page.locator("#video"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.id)).toBe("video");
    expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth - 5, window.innerHeight - 5)?.id)).toBe("video");
  });

  test("Esc exits: getters reset, one change event, the page never sees Esc, inline styles restored exactly", async ({ page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const video = page.locator("#video");
    const stylesBefore = await styleChain(video);
    expect(stylesBefore[0]).toEqual({ node: "#video", style: "border: 3px solid rgb(10, 20, 30); width: 480px", markers: [] });

    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await styleChain(video)).not.toEqual(stylesBefore);
    expect(await backdropCount(page)).toBe(1);

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);

    const log = await readLog(page);
    const exitEvent = log.filter((entry) => entry.type === "fullscreenchange")[1];
    expect(exitEvent).toMatchObject({ target: "#video", fullscreenElement: null, fullscreen: false });
    // Neither the keydown nor the keyup of that Esc reached the page's listeners.
    expect(log.filter((entry) => entry.type === "keydown" || entry.type === "keyup")).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { CFS: { getters(): unknown } }).CFS.getters())).toEqual({
      fullscreenElement: null,
      webkitFullscreenElement: null,
      webkitCurrentFullScreenElement: null,
      fullscreen: false,
      webkitIsFullScreen: false,
      matchedFullscreen: null,
    });
    expect(await styleChain(video)).toEqual(stylesBefore);
    expect(await backdropCount(page)).toBe(0);

    // Out of fullscreen, Esc is the page's again.
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await readLog(page)).filter((entry) => entry.type === "keydown").map((entry) => entry.key))
      .toEqual(["Escape", "Escape"]);
    expect(types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
  });

  test("document.exitFullscreen() resolves, then fires one change event, and restores the styles", async ({ page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const stylesBefore = await styleChain(page.locator("#video"));
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);

    await page.evaluate(() => (window as unknown as { CFS: { exit(): void } }).CFS.exit());
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    const log = await readLog(page);
    const afterExit = log.slice(log.findIndex((entry) => entry.type === "exit"));
    expect(types(afterExit, ["exit", "promise", "reject", "fullscreenchange"])).toEqual(["exit", "promise", "fullscreenchange"]);
    expect(afterExit.find((entry) => entry.type === "promise")).toMatchObject({ fullscreenElement: null, fullscreen: false });
    expect(await styleChain(page.locator("#video"))).toEqual(stylesBefore);

    // Exiting again when nothing is fullscreen rejects, like Chromium.
    await page.evaluate(() => (window as unknown as { CFS: { exit(): void } }).CFS.exit());
    await expect
      .poll(async () => (await readLog(page)).filter((entry) => entry.type === "reject").map((entry) => entry["name"]))
      .toEqual(["TypeError"]);
  });

  test("error paths reject and fire the error events exactly as real Chromium does", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const KINDS = ["disconnected", "prefixed-disconnected", "svg-rect", "math", "dialog", "modal-dialog", "bad-options", "exit-idle"];
    const events = (log: LogEntry[]): string[] =>
      log.filter((entry) => (FULLSCREEN_EVENTS as readonly string[]).includes(entry.type)).map((entry) => `${entry.type}@${String(entry["target"])}`);
    const run = async (): Promise<Record<string, unknown>> => {
      const results: Record<string, unknown> = {};
      // A request while the page loads, without a user gesture.
      await openFixture(page, `${origins.a}/plain-video.html?onload`);
      await expect.poll(async () => events(await readLog(page))).toHaveLength(1);
      // Precondition: the page had no transient user activation at the request (Playwright's evaluates carry a
      // user gesture; openFixture keeps them out of a document that is still parsing).
      const activation = (await readLog(page)).find((entry) => entry.type === "activation");
      expect(activation?.["isActive"], "precondition: no user activation at the ?onload request").toBe(false);
      results["load"] = (await readLog(page))
        .filter((entry) => entry.type !== "resize" && entry.type !== "activation")
        .map((entry) => [entry.type, entry["name"], entry["message"], entry["target"], entry.fullscreenElement]);
      for (const kind of KINDS) {
        await clearLog(page);
        const outcome = await page.evaluate(async (kind) => {
          const SVG = "http://www.w3.org/2000/svg";
          const MATHML = "http://www.w3.org/1998/Math/MathML";
          const append = <T extends Element>(element: T, id: string): T => {
            element.id = id;
            document.body.append(element);
            return element;
          };
          const cases: Record<string, () => unknown> = {
            disconnected: () => document.createElement("div").requestFullscreen(),
            "prefixed-disconnected": () => (document.createElement("div") as unknown as { webkitRequestFullscreen(): unknown }).webkitRequestFullscreen(),
            "svg-rect": () => append(document.createElementNS(SVG, "svg"), "svg").appendChild(append(document.createElementNS(SVG, "rect"), "rect")).requestFullscreen(),
            math: () => append(document.createElementNS(MATHML, "math"), "math").requestFullscreen(),
            dialog: () => append(document.createElement("dialog"), "dialog").requestFullscreen(),
            "modal-dialog": () => {
              const dialog = append(document.createElement("dialog"), "modal");
              dialog.showModal();
              return dialog.requestFullscreen().finally(() => dialog.close());
            },
            "bad-options": () => document.getElementById("video")!.requestFullscreen({ navigationUI: "sideways" as FullscreenNavigationUI }),
            "exit-idle": () => document.exitFullscreen(),
          };
          try {
            const value = await cases[kind]!();
            return `resolved ${String(value)} fullscreenElement=${String(document.fullscreenElement)}`;
          } catch (error) {
            return `${(error as Error).name}: ${(error as Error).message}`;
          }
        }, kind);
        await page.waitForTimeout(150);
        results[kind] = { outcome, events: events(await readLog(page)) };
      }
      return results;
    };

    await setOptions(context, serviceWorker, extensionId, { enabled: false });
    const real = await run();
    await setOptions(context, serviceWorker, extensionId, { enabled: true });
    const faked = await run();
    expect(faked).toEqual(real);
    // Every case failed in real Chromium (the prefixed request returns undefined and only fires the event).
    for (const kind of KINDS) {
      const { outcome, events: fired } = real[kind] as { outcome: string; events: string[] };
      if (kind === "prefixed-disconnected") {
        expect(outcome).toBe("resolved undefined fullscreenElement=null");
        expect(fired).toEqual(["webkitfullscreenerror@[object HTMLDocument]"]);
      } else {
        expect(outcome, kind).toMatch(/^TypeError: /);
      }
    }
    // The comparison is meaningful only if the second run was faked: a valid request there is faked.
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(await realFullscreenElement(context, page)).toBeNull();
  });

  test("removing the element exits, with the same event as real Chromium (at the document)", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const run = async (): Promise<unknown[]> => {
      await openFixture(page, `${origins.a}/plain-video.html`);
      await page.click("#enter");
      await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
      await clearLog(page);
      await page.evaluate(() => document.getElementById("video")!.remove());
      await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
      await page.waitForTimeout(200);
      expect(await backdropCount(page)).toBe(0);
      expect(await realFullscreenElement(context, page)).toBeNull();
      return (await readLog(page))
        .filter((entry) => (FULLSCREEN_EVENTS as readonly string[]).includes(entry.type))
        .map((entry) => [entry.type, entry["target"], entry.fullscreenElement, entry.fullscreen]);
    };
    await setOptions(context, serviceWorker, extensionId, { enabled: false });
    const real = await run();
    await setOptions(context, serviceWorker, extensionId, { enabled: true });
    const faked = await run();
    expect(real).toEqual([["fullscreenchange", "[object HTMLDocument]", null, false]]);
    expect(faked).toEqual(real);
  });

  test("with exitOnEscape off, Esc reaches the page and does not exit", async ({ context, serviceWorker, extensionId, page, origins }) => {
    await setOptions(context, serviceWorker, extensionId, { exitOnEscape: false });
    await openFixture(page, `${origins.a}/plain-video.html`);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await readLog(page)).filter((entry) => entry.type === "keydown").map((entry) => entry["key"]))
      .toEqual(["Escape", "Escape"]); // the window and document listeners
    await page.waitForTimeout(200);
    expect(types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
  });

  const CASES: Array<RectCase & { backgroundColor: string }> = [
    { width: 50, widthUnit: "%", height: 40, heightUnit: "%", anchor: "top-left", backgroundColor: "#2a7f3c" },
    { width: 400, widthUnit: "px", height: 300, heightUnit: "px", anchor: "bottom-right", backgroundColor: "#7a1f5c" },
    { width: 60, widthUnit: "%", height: 250, heightUnit: "px", anchor: "center", backgroundColor: "#203a8c" },
    { width: 320, widthUnit: "px", height: 90, heightUnit: "%", anchor: "right", backgroundColor: "#c8b400" },
    { width: 70, widthUnit: "%", height: 200, heightUnit: "px", anchor: "bottom", backgroundColor: "#000000" },
  ];

  for (const rect of CASES) {
    const label = `${rect.width}${rect.widthUnit} × ${rect.height}${rect.heightUnit} at ${rect.anchor}`;
    test(`custom-rect ${label}: pinned to the rectangle, ${rect.backgroundColor} around it`, async ({
      context,
      serviceWorker,
      extensionId,
      page,
      origins,
    }) => {
      await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect, backgroundColor: rect.backgroundColor });
      await openFixture(page, `${origins.a}/plain-video.html`);
      await page.click("#enter");
      await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);

      const viewport = await viewportOf(page);
      const expected = expectedRect(viewport, rect);
      expect(await rectOf(page.locator("#video"))).toEqual(expected);
      const point = pointOutside(viewport, expected);
      expectColour(await pixelAt(page, point.x, point.y), rect.backgroundColor);
      // The backdrop is not inert: a click around the rectangle does not reach the page underneath.
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute("data-cfs-backdrop"), point)).toBe(true);
    });
  }

  test("fill-tab set through the options page fills the viewport", async ({ context, serviceWorker, extensionId, page, origins }) => {
    await setOptions(context, serviceWorker, extensionId, {
      mode: "custom-rect",
      rect: { width: 30, widthUnit: "%", height: 30, heightUnit: "%", anchor: "top-left" },
    });
    await setOptions(context, serviceWorker, extensionId, { mode: "fill-tab" });
    await openFixture(page, `${origins.a}/plain-video.html`);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    const viewport = await viewportOf(page);
    expect(await rectOf(page.locator("#video"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
  });
});
