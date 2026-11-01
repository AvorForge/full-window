// Per-site override through the toolbar popup (§6): disabling 127.0.0.1 makes fixture 1 use the real
// Fullscreen API (pass-through) while localhost is still faked.
import {
  backdropCount,
  expect,
  openFixture,
  openPopupFor,
  readLog,
  realFullscreenElement,
  styleChain,
  test,
  types,
  type Page,
} from "./harness/extension";

const CHANGE = ["fullscreenchange"];

async function markers(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("[data-cfs-fullscreen], [data-cfs-fullscreen-ancestor], [data-cfs-backdrop]").length);
}

test.describe("per-site override", () => {
  test("disabling 127.0.0.1 in the popup makes fixture 1 enter real fullscreen; localhost is still faked", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const stylesBefore = await styleChain(page.locator("#video"));

    const popup = await openPopupFor(context, serviceWorker, extensionId, page);
    await expect(popup.locator("#site")).toHaveText("127.0.0.1");
    await expect(popup.locator("#site-enabled")).toBeChecked();
    await popup.bringToFront();
    await popup.locator("#site-enabled").uncheck();
    await expect
      .poll(() => serviceWorker.evaluate(async () => (await chrome.storage.sync.get("site:127.0.0.1"))["site:127.0.0.1"]))
      .toEqual({ enabled: false });
    await expect(popup.locator("#clear-site")).toBeVisible();
    await popup.close();

    // Live, without a reload: the request goes to the real API.
    await page.bringToFront();
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(types(await readLog(page), ["request", "promise", "fullscreenchange"])).toEqual(["request", "promise", "fullscreenchange"]);
    // Nothing of the fake: no markers, no backdrop, the video's inline style untouched, native :fullscreen.
    expect(await markers(page)).toBe(0);
    expect(await styleChain(page.locator("#video"))).toEqual(stylesBefore);
    expect(await page.evaluate(() => document.querySelector(":fullscreen")?.id)).toBe("video");
    await page.evaluate(() => (window as unknown as { CFS: { exit(): void } }).CFS.exit());
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await realFullscreenElement(context, page)).toBeNull();

    // The other fixture origin is another site: still faked.
    const other = await context.newPage();
    await openFixture(other, `${origins.b}/plain-video.html`);
    await other.click("#enter");
    await expect.poll(async () => types(await readLog(other), CHANGE)).toEqual(CHANGE);
    expect(await other.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(await realFullscreenElement(context, other)).toBeNull();
    expect(await backdropCount(other)).toBe(1);

    // The override is stored: after a reload 127.0.0.1 still passes through.
    await openFixture(page, `${origins.a}/plain-video.html`);
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBe("#video");
    expect(await markers(page)).toBe(0);
  });
});
