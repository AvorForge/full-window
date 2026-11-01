// The toggle command (§8). Playwright cannot press an extension shortcut, so the tests do what the
// service worker's chrome.commands.onCommand listener does: send `command-toggle` to frame 0 of the tab,
// from the service worker's own context.
import {
  boundsOf,
  expect,
  openFixture,
  readLog,
  realFullscreenElement,
  rectOf,
  setOptions,
  tabIdOf,
  test,
  types,
  viewportOf,
  windowOf,
  type BrowserContext,
  type Page,
  type Worker,
} from "./harness/extension";
import { expectedRect } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];
const RECT = { width: 50, widthUnit: "%", height: 50, heightUnit: "%", anchor: "center" } as const;

async function toggle(context: BrowserContext, worker: Worker, page: Page): Promise<unknown> {
  const tabId = await tabIdOf(context, worker, page);
  return worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "command-toggle" }, { frameId: 0 }), tabId);
}

async function videoRect(page: Page): Promise<{ rect: unknown; viewport: { width: number; height: number } }> {
  return { rect: await rectOf(page.locator("#video")), viewport: await viewportOf(page) };
}

test.describe("toggle command", () => {
  test("during fake fullscreen it switches the window to browser fullscreen and back, restoring it", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect: RECT });
    await openFixture(page, `${origins.a}/plain-video.html`);
    const before = await windowOf(context, page);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    const fake = await videoRect(page);
    expect(fake.rect).toEqual(expectedRect(fake.viewport, RECT));

    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("fullscreen");
    expect(await page.evaluate(() => window.matchMedia("(display-mode: fullscreen)").matches)).toBe(true);
    // The element fills the tab, the page still believes it is fullscreen, and nothing told it otherwise.
    await expect
      .poll(async () => {
        const { rect, viewport } = await videoRect(page);
        return JSON.stringify(rect) === JSON.stringify({ left: 0, top: 0, width: viewport.width, height: viewport.height });
      })
      .toBe(true);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(types(await readLog(page), CHANGE)).toEqual(CHANGE);

    // Toggling again restores the window and the configured rectangle; still fake-fullscreen.
    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("normal");
    expect(await windowOf(context, page)).toEqual(before);
    await expect.poll(async () => {
      const { rect, viewport } = await videoRect(page);
      return JSON.stringify(rect) === JSON.stringify(expectedRect(viewport, RECT));
    }).toBe(true);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(types(await readLog(page), CHANGE)).toEqual(CHANGE);

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
  });

  test("leaving fake fullscreen while switched to browser fullscreen restores the window", async ({ context, serviceWorker, page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const before = await windowOf(context, page);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("fullscreen");

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(async () => (await windowOf(context, page))).toEqual(before);
  });

  test("while idle it arms real fullscreen for the tab, across reloads, and toggling again arms the fake", async ({
    context,
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect
      .poll(() => serviceWorker.evaluate(async () => (await chrome.storage.session.get("preferReal"))["preferReal"]))
      .toEqual({ [String(await tabIdOf(context, serviceWorker, page))]: true });

    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    await page.evaluate(() => (window as unknown as { CFS: { exit(): void } }).CFS.exit());
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);

    // The armed mode belongs to the tab: a reload keeps it.
    await openFixture(page, `${origins.a}/plain-video.html`);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    await page.evaluate(() => (window as unknown as { CFS: { exit(): void } }).CFS.exit());
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);

    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE, ...CHANGE]);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
  });

  test("with a cross-origin frame chain, the top frame switches to browser fullscreen and the iframe fills the tab", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect: RECT });
    await openFixture(page, `${origins.a}/embed-parent.html`);
    const before = await windowOf(context, page);
    const child = page.frames().find((frame) => frame.url().includes("name=allowed"));
    if (!child) throw new Error("no child frame");
    await child.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await rectOf(page.locator("#allowed"))).toEqual(expectedRect(await viewportOf(page), RECT));

    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("fullscreen");
    await expect
      .poll(async () => {
        const viewport = await viewportOf(page);
        return JSON.stringify(await rectOf(page.locator("#allowed"))) === JSON.stringify({ left: 0, top: 0, width: viewport.width, height: viewport.height });
      })
      .toBe(true);
    expect(await child.evaluate(() => document.fullscreenElement?.id)).toBe("video");

    // Esc in the child leaves everything, including browser fullscreen.
    await child.locator("#child-focus").focus();
    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(async () => types(await readLog(child), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(() => windowOf(context, page)).toEqual(before);
  });

  test("switching to another tab while switched to browser fullscreen restores the window; the page keeps its rectangle", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect: RECT });
    await openFixture(page, `${origins.a}/plain-video.html`);
    const before = await windowOf(context, page);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("fullscreen");

    await context.newPage();
    await expect.poll(() => windowOf(context, page)).toEqual(before);
    await page.bringToFront();
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    await expect.poll(async () => {
      const { rect, viewport } = await videoRect(page);
      return JSON.stringify(rect) === JSON.stringify(expectedRect(viewport, RECT));
    }).toBe(true);
    // The next toggle switches to browser fullscreen again.
    expect(await toggle(context, serviceWorker, page)).toEqual({ handled: true });
    await expect.poll(async () => (await boundsOf(context, page, before.windowId)).windowState).toBe("fullscreen");
  });
});
