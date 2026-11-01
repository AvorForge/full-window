// native-controls.html, the offline regression for a video file opened directly (archive.org's
// big_buck_bunny_720p_surround.mp4, live run in Chrome 156, 2026-10-30) and every page with native <video controls>:
// the fullscreen button of Chromium's built-in controls requests fullscreen from the UA shadow DOM, which the
// MAIN-world shim never sees, so the browser went really fullscreen and the chosen size was never applied
// (docs/ARCHITECTURE.md §2 "Native video controls").
import {
  backdropCount,
  expect,
  openFixture,
  readLog,
  realFullscreenElement,
  rectOf,
  setOptions,
  styleChain,
  tabIdOf,
  test,
  types,
  viewportOf,
  type BrowserContext,
  type Page,
} from "./harness/extension";
import { expectedRect } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];
const FULLSCREEN_LOG = ["fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "webkitfullscreenerror", "resize"];

/** Clicks the fullscreen button of the video's built-in controls, found in the accessibility tree, with the mouse. */
async function clickNativeFullscreen(context: BrowserContext, page: Page): Promise<void> {
  await page.mouse.move(300, 200);
  const session = await context.newCDPSession(page);
  try {
    let button: number | undefined;
    await expect
      .poll(async () => {
        const { nodes } = await session.send("Accessibility.getFullAXTree");
        button = nodes.find((node) => node.role?.value === "button" && /full ?screen/i.test(String(node.name?.value ?? "")))?.backendDOMNodeId;
        return button !== undefined;
      })
      .toBe(true);
    if (button === undefined) throw new Error("no fullscreen button in the video's controls");
    const { model } = await session.send("DOM.getBoxModel", { backendNodeId: button });
    const [x1, y1, , , x3, y3] = model.content;
    await page.mouse.click(((x1 ?? 0) + (x3 ?? 0)) / 2, ((y1 ?? 0) + (y3 ?? 0)) / 2);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function markers(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("[data-cfs-fullscreen], [data-cfs-fullscreen-ancestor], [data-cfs-backdrop]").length);
}

test.describe("native <video controls> fullscreen button (direct video links)", () => {
  test("fill-tab: the real fullscreen it starts becomes fake fullscreen, with one change event; Esc and the button leave", async ({
    context,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/native-controls.html`);
    const stylesBefore = await styleChain(page.locator("#video"));
    await clickNativeFullscreen(context, page);
    // Before the fix: real fullscreen on the video, no markers.
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await markers(page)).toBeGreaterThan(0);
    const viewport = await viewportOf(page);
    expect(await rectOf(page.locator("#video"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    // The page saw what a request through the shim gives: one change event on the video with the getters set,
    // then resize; neither the real enter nor the real exit.
    const log = (await readLog(page)).filter((entry) => FULLSCREEN_LOG.includes(entry.type));
    expect(log.map((entry) => entry.type)).toEqual(["fullscreenchange", "resize"]);
    // Like every event of the shim, it is not trusted (isTrusted cannot be faked; docs/ARCHITECTURE.md §8).
    expect(log[0]).toMatchObject({ target: "#video", fullscreenElement: "#video", trusted: false });

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await styleChain(page.locator("#video"))).toEqual(stylesBefore);
    expect(await backdropCount(page)).toBe(0);

    // Again, then the same button (on the fake-fullscreen video) leaves fake fullscreen, as it would leave real.
    await clickNativeFullscreen(context, page);
    await expect.poll(async () => types(await readLog(page), CHANGE)).toHaveLength(3);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    await clickNativeFullscreen(context, page);
    await expect.poll(async () => types(await readLog(page), CHANGE)).toHaveLength(4);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await styleChain(page.locator("#video"))).toEqual(stylesBefore);
    // No loop: nothing more happens.
    await page.waitForTimeout(500);
    expect(types(await readLog(page), CHANGE)).toHaveLength(4);
  });

  test("custom-rect 80 %: the video gets the chosen rectangle", async ({ context, serviceWorker, extensionId, page, origins }) => {
    const RECT = { width: 80, widthUnit: "%", height: 80, heightUnit: "%", anchor: "center" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect: RECT });
    await openFixture(page, `${origins.a}/native-controls.html`);
    await clickNativeFullscreen(context, page);
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await rectOf(page.locator("#video"))).toEqual(expectedRect(await viewportOf(page), RECT));
  });

  test("after the real-fullscreen toggle, and on a disabled site, the native button's real fullscreen stays real", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/native-controls.html`);
    // The toggle while idle arms real fullscreen for the tab (§8), as chrome.commands.onCommand does.
    const tabId = await tabIdOf(context, serviceWorker, page);
    expect(await serviceWorker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "command-toggle" }, { frameId: 0 }), tabId)).toEqual({
      handled: true,
    });
    await expect
      .poll(() => serviceWorker.evaluate(async () => Object.values((await chrome.storage.session.get("preferReal"))["preferReal"] ?? {})))
      .toContain(true);
    await clickNativeFullscreen(context, page);
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    await page.waitForTimeout(300);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    expect(await markers(page)).toBe(0);
    expect(types(await readLog(page), CHANGE)).toEqual(CHANGE);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(async () => realFullscreenElement(context, page)).toBeNull();
    // Disarm, then switch the extension off: still real.
    await serviceWorker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "command-toggle" }, { frameId: 0 }), tabId);
    await setOptions(context, serviceWorker, extensionId, { enabled: false });
    await openFixture(page, `${origins.a}/native-controls.html`);
    await clickNativeFullscreen(context, page);
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    await page.waitForTimeout(300);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    expect(await markers(page)).toBe(0);
  });
});
