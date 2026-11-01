// Fixture 3 (embed-parent.html on origin A with embed-child.html from origin B, and the nested
// embed-nested.html → embed-middle.html (B) → embed-child.html (A)): the frame chain of §4.
import {
  backdropCount,
  expect as baseExpect,
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
  type LogEntry,
  type Page,
} from "./harness/extension";
import { expectedRect, pointOutside } from "./harness/geometry";
import type { Frame } from "@playwright/test";

const CHANGE = ["fullscreenchange"];

// Popup windows are created, resized and closed by the service worker through chrome.windows. On a busy host
// (four browsers at once, load well past the CPU count) that alone took longer than the default 5 s, and the
// popup was not there yet when the poll gave up, so these waits are longer. Waits that measure time keep their own.
const expect = baseExpect.configure({ timeout: 15_000 });

async function frameOf(parent: Page | Frame, selector: string): Promise<Frame> {
  const handle = await parent.locator(selector).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame for ${selector}`);
  return frame;
}

async function changes(target: Page | Frame): Promise<number> {
  return types(await readLog(target), CHANGE).length;
}

function keys(log: LogEntry[]): unknown[] {
  return log.filter((entry) => entry.type === "keydown" || entry.type === "keyup").map((entry) => entry["key"]);
}

test.describe("fixture 3: cross-origin frames", () => {
  test("the iframe is pinned in the parent, one change event per document on enter and on Esc in the child", async ({
    context,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const child = await frameOf(page, "#allowed");
    expect(new URL(child.url()).origin).toBe(origins.b);
    const iframeStyles = await styleChain(page.locator("#allowed"));
    const videoStyles = await styleChain(child.locator("#video"));

    await child.click("#enter");
    await expect.poll(() => changes(page)).toBe(1);
    await expect.poll(() => changes(child)).toBe(1);

    // Parent: the <iframe> is the fullscreen element, pinned to the viewport, above the page.
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("allowed");
    expect((await readLog(page)).find((entry) => entry.type === "fullscreenchange")).toMatchObject({
      target: "#allowed",
      fullscreenElement: "#allowed",
    });
    const viewport = await viewportOf(page);
    expect(await rectOf(page.locator("#allowed"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.id)).toBe("allowed");
    // Child: the video fills the frame, which now has the parent's viewport size; promise before event.
    expect(await child.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(types(await readLog(child), ["request", "promise", "reject", "fullscreenchange", "fullscreenerror"])).toEqual([
      "request",
      "promise",
      "fullscreenchange",
    ]);
    expect(await viewportOf(child)).toEqual(viewport);
    expect(await rectOf(child.locator("#video"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    // Nothing is really fullscreen, in either document.
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await realFullscreenElement(context, child)).toBeNull();

    // Focus is in the child (its button was clicked): Esc there exits the whole chain.
    expect(await child.evaluate(() => document.hasFocus())).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => changes(child)).toBe(2);
    await expect.poll(() => changes(page)).toBe(2);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await child.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(keys(await readLog(child))).toEqual([]);
    expect(keys(await readLog(page))).toEqual([]);
    expect(await styleChain(page.locator("#allowed"))).toEqual(iframeStyles);
    expect(await styleChain(child.locator("#video"))).toEqual(videoStyles);
    expect(await backdropCount(page)).toBe(0);
    expect(await backdropCount(child)).toBe(0);
    // Still exactly one exit event each after things settle.
    await page.waitForTimeout(300);
    expect(await changes(page)).toBe(2);
    expect(await changes(child)).toBe(2);
  });

  test("Esc with focus in the parent exits the chain too", async ({ page, origins }) => {
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const child = await frameOf(page, "#allowed");
    const iframeStyles = await styleChain(page.locator("#allowed"));

    await child.click("#enter");
    await expect.poll(() => changes(page)).toBe(1);
    await expect.poll(() => changes(child)).toBe(1);

    await page.locator("#parent-focus").focus();
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => changes(page)).toBe(2);
    await expect.poll(() => changes(child)).toBe(2);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await child.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(keys(await readLog(page))).toEqual([]);
    expect(await styleChain(page.locator("#allowed"))).toEqual(iframeStyles);
    await page.waitForTimeout(300);
    expect(await changes(page)).toBe(2);
    expect(await changes(child)).toBe(2);
  });

  test("the iframe without allowfullscreen gets fullscreenerror, exactly as without the extension", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const ERRORS = ["request", "promise", "reject", "fullscreenchange", "fullscreenerror"];
    const run = async (): Promise<LogEntry[]> => {
      await openFixture(page, `${origins.a}/embed-parent.html`);
      const denied = await frameOf(page, "#denied");
      expect(await denied.evaluate(() => document.fullscreenEnabled)).toBe(false);
      await denied.click("#enter");
      await expect.poll(async () => types(await readLog(denied), ["fullscreenerror"])).toEqual(["fullscreenerror"]);
      await page.waitForTimeout(300);
      expect(await changes(page)).toBe(0);
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
      expect(await denied.evaluate(() => document.fullscreenElement)).toBeNull();
      expect(await backdropCount(page)).toBe(0);
      return (await readLog(denied)).filter((entry) => ERRORS.includes(entry.type));
    };

    // Real Chromium first (the extension switched off in the options page), then with the extension.
    await setOptions(context, serviceWorker, extensionId, { enabled: false });
    const real = await run();
    await setOptions(context, serviceWorker, extensionId, { enabled: true });
    const faked = await run();

    const shape = (log: LogEntry[]): unknown[] =>
      log.map((entry) => ({ type: entry.type, name: entry["name"], message: entry["message"], fullscreenElement: entry.fullscreenElement }));
    expect(shape(real)).toEqual([
      { type: "request", name: undefined, message: undefined, fullscreenElement: null },
      { type: "reject", name: "TypeError", message: "Disallowed by permissions policy", fullscreenElement: null },
      { type: "fullscreenerror", name: undefined, message: undefined, fullscreenElement: null },
    ]);
    expect(shape(faked)).toEqual(shape(real));
  });

  test("nested two-level chain: each document pins its frame; Esc in the innermost, in the middle and at the top exits all", async ({
    context,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/embed-nested.html`);
    const middle = await frameOf(page, "#outer");
    const inner = await frameOf(middle, "#inner");
    expect(new URL(middle.url()).origin).toBe(origins.b);
    expect(new URL(inner.url()).origin).toBe(origins.a);
    const documents = [page, middle, inner] as const;
    const outerStyles = await styleChain(page.locator("#outer"));
    const innerStyles = await styleChain(middle.locator("#inner"));
    const videoStyles = await styleChain(inner.locator("#video"));

    const enter = async (expected: number): Promise<void> => {
      await inner.click("#enter");
      for (const target of documents) await expect.poll(() => changes(target)).toBe(expected);
      expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("outer");
      expect(await middle.evaluate(() => document.fullscreenElement?.id)).toBe("inner");
      expect(await inner.evaluate(() => document.fullscreenElement?.id)).toBe("video");
      const viewport = await viewportOf(page);
      const full = { left: 0, top: 0, width: viewport.width, height: viewport.height };
      expect(await rectOf(page.locator("#outer"))).toEqual(full);
      // Each frame's viewport follows its parent's resize a few frames later (on the Windows test host the
      // innermost video reached full size up to 234 ms after its fullscreenchange), so the frames are polled.
      await expect.poll(() => rectOf(middle.locator("#inner"))).toEqual(full);
      await expect.poll(() => rectOf(inner.locator("#video"))).toEqual(full);
      for (const target of documents) expect(await realFullscreenElement(context, target)).toBeNull();
    };
    const exited = async (expected: number): Promise<void> => {
      for (const target of documents) await expect.poll(() => changes(target)).toBe(expected);
      for (const target of documents) expect(await target.evaluate(() => document.fullscreenElement)).toBeNull();
      expect(await styleChain(page.locator("#outer"))).toEqual(outerStyles);
      expect(await styleChain(middle.locator("#inner"))).toEqual(innerStyles);
      expect(await styleChain(inner.locator("#video"))).toEqual(videoStyles);
      for (const target of documents) expect(await backdropCount(target)).toBe(0);
    };

    // Esc in the innermost frame (focus is there after the click).
    await enter(1);
    await page.keyboard.press("Escape");
    await exited(2);

    // Esc in the middle frame travels both ways.
    await enter(3);
    await middle.locator("#middle-focus").focus();
    await page.keyboard.press("Escape");
    await exited(4);

    // Esc in the top frame travels down to the innermost.
    await enter(5);
    await page.locator("#parent-focus").focus();
    await page.keyboard.press("Escape");
    await exited(6);

    await page.waitForTimeout(300);
    for (const target of documents) {
      expect(await changes(target)).toBe(6);
      expect(keys(await readLog(target))).toEqual([]);
    }
  });

  test("custom-rect: the top document pins the iframe to the rectangle, the child fills its frame", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const rect = { width: 60, widthUnit: "%", height: 400, heightUnit: "px", anchor: "bottom-left" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect, backgroundColor: "#406080" });
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const child = await frameOf(page, "#allowed");
    await child.click("#enter");
    await expect.poll(() => changes(page)).toBe(1);
    await expect.poll(() => changes(child)).toBe(1);

    const viewport = await viewportOf(page);
    const expected = expectedRect(viewport, rect);
    expect(await rectOf(page.locator("#allowed"))).toEqual(expected);
    expect(await viewportOf(child)).toEqual({ width: expected.width, height: expected.height });
    expect(await rectOf(child.locator("#video"))).toEqual({ left: 0, top: 0, width: expected.width, height: expected.height });
    const point = pointOutside(viewport, expected);
    expectColour(await pixelAt(page, point.x, point.y), "#406080");

    await page.keyboard.press("Escape");
    await expect.poll(() => changes(page)).toBe(2);
    await expect.poll(() => changes(child)).toBe(2);
  });

  test("pop-out: a request in the child frame pops the tab out once; Esc puts it back", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "pop-out", windowSize: { width: 1000, height: 640 } });
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const windows = () =>
      serviceWorker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((w) => ({ type: w.type, width: w.width, height: w.height, tabs: w.tabs?.length })));
    const before = await windows();
    const child = await frameOf(page, "#allowed");
    await child.click("#enter");
    await expect.poll(() => changes(page)).toBe(1);
    // The browser window stays, holding the placeholder tab in the page's place.
    await expect.poll(async () => (await windows()).filter((w) => w.type === "popup")).toEqual([{ type: "popup", width: 1000, height: 640, tabs: 1 }]);
    expect((await windows()).filter((w) => w.type === "normal")).toEqual(before);
    const viewport = await viewportOf(page);
    await expect.poll(() => rectOf(page.locator("#allowed"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });

    await page.keyboard.press("Escape");
    await expect.poll(() => changes(child)).toBe(2);
    await expect.poll(() => changes(page)).toBe(2);
    await expect.poll(windows).toEqual(before);
  });

  test("pop-out: pointer movement over the cross-origin iframe's video shows the top frame's hover bar", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "pop-out", windowSize: { width: 1000, height: 640 } });
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const popups = () => serviceWorker.evaluate(async () => (await chrome.windows.getAll()).filter((w) => w.type === "popup").map((w) => w.width));
    const child = await frameOf(page, "#allowed");
    await child.click("#enter");
    await expect.poll(popups).toEqual([1000]);
    const viewport = await viewportOf(page);
    await expect.poll(() => rectOf(page.locator("#allowed"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    const barShown = () => page.evaluate(() => document.querySelector("[popover][data-shown]")?.matches(":popover-open") === true);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await expect.poll(barShown, { timeout: 5_000 }).toBe(false);

    // The pointer is over the iframe: only the child frame sees it, and the service worker relays it to the top.
    await child.evaluate(() => {
      (window as unknown as { __moves: number }).__moves = 0;
      addEventListener("pointermove", () => (window as unknown as { __moves: number }).__moves++);
    });
    await page.mouse.move(viewport.width / 2 + 40, viewport.height / 2 + 20, { steps: 3 });
    expect(await child.evaluate(() => (window as unknown as { __moves: number }).__moves)).toBeGreaterThan(0);
    await expect.poll(barShown).toBe(true);
    // Drawn by the top frame only; the child frame draws nothing.
    expect(await child.evaluate(() => document.querySelector("[popover]"))).toBeNull();
    await expect.poll(barShown, { timeout: 5_000 }).toBe(false);
    // Its buttons work as in the top document: Pop back in ends the chain and the pop-out.
    await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 2 });
    await expect.poll(barShown).toBe(true);
    // Top centre: the middle of the three buttons is Full screen; the first, 34 px to its left, Pop back in.
    await page.mouse.click(viewport.width / 2 - 34, 30);
    await expect.poll(() => changes(child)).toBe(2);
    await expect.poll(() => changes(page)).toBe(2);
    await expect.poll(popups).toEqual([]);
  });

  test("pop-out: over the cross-origin iframe's video the corner shows the grip and the middle does not; the grip resizes", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "pop-out", windowSize: { width: 1000, height: 640 } });
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const popups = () =>
      serviceWorker.evaluate(async () => (await chrome.windows.getAll()).filter((w) => w.type === "popup").map((w) => ({ width: w.width, height: w.height })));
    const child = await frameOf(page, "#allowed");
    await child.click("#enter");
    await expect.poll(popups).toEqual([{ width: 1000, height: 640 }]);
    const viewport = await viewportOf(page);
    await expect.poll(() => rectOf(page.locator("#allowed"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    const barShown = () => page.evaluate(() => document.querySelector("[popover][data-shown]")?.matches(":popover-open") === true);
    const gripShown = () => page.evaluate(() => document.querySelector("[popover][data-shown][data-grip]")?.matches(":popover-open") === true);
    /** What takes the pointer at (x, y) in the top document: our host, or the page's element. */
    const hitAt = (x: number, y: number) =>
      page.evaluate(([px, py]) => {
        const element = document.elementFromPoint(px!, py!);
        return element?.matches("[popover]") ? "ours" : (element?.id ?? "nothing");
      }, [x, y]);
    const corner = { x: viewport.width - 8, y: viewport.height - 8 };
    await child.evaluate(() => {
      (window as unknown as { __moves: number }).__moves = 0;
      addEventListener("pointermove", () => (window as unknown as { __moves: number }).__moves++);
    });

    // The middle, over the iframe (only the child frame sees the pointer): the bar, no grip; the corner is the page's.
    await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 3 });
    await expect.poll(barShown).toBe(true);
    expect(await child.evaluate(() => (window as unknown as { __moves: number }).__moves)).toBeGreaterThan(0);
    expect(await gripShown()).toBe(false);
    expect(await hitAt(corner.x, corner.y)).toBe("allowed");

    // The corner zone, still over the iframe: the child relays it at once and the top frame shows the grip.
    await page.mouse.move(viewport.width - 40, viewport.height - 40);
    await expect.poll(gripShown).toBe(true);
    expect(await hitAt(corner.x, corner.y)).toBe("ours");
    // Back to the middle within the throttle: hidden again, at once.
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await expect.poll(gripShown).toBe(false);
    expect(await barShown()).toBe(true);
    expect(await hitAt(corner.x, corner.y)).toBe("allowed");

    // Into the corner and onto the grip (drawn by the top frame over the iframe): dragging it resizes the popup.
    await page.mouse.move(viewport.width - 40, viewport.height - 40);
    await expect.poll(gripShown).toBe(true);
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 60, corner.y + 30, { steps: 4 });
    await page.mouse.move(corner.x + 100, corner.y + 50, { steps: 4 });
    await page.mouse.up();
    await expect.poll(popups).toEqual([{ width: 1100, height: 690 }]);
    expect(await child.evaluate(() => document.querySelector("[popover]"))).toBeNull();
    await page.keyboard.press("Escape");
    await expect.poll(popups).toEqual([]);
  });
});
