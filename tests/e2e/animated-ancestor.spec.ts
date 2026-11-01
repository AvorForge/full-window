// animated-ancestor.html, the offline regression for https://videojs.org/ (live run in Chrome 156, 2026-10-30):
// the player's hero wrapper has a finished `fill-mode: both` transform animation, which kept it a containing block
// for the pinned player, so the player landed at the wrapper's offset (152, 144) instead of the requested rectangle
// and its control bar was off screen (docs/ARCHITECTURE.md §3 "Ancestors that break position: fixed").
import {
  expect,
  openFixture,
  readLog,
  realFullscreenElement,
  screenRectOf,
  setOptions,
  styleChain,
  test,
  types,
  viewportOf,
  type Page,
  type Rect,
} from "./harness/extension";
import { expectedRect } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];
const ANIMATION_EVENTS = ["animationstart", "animationend", "animationcancel", "animationiteration"];

interface HeroAnimation {
  count: number;
  name: string | null;
  playState: string | null;
  currentTime: number | null;
  transform: string;
}

const heroAnimation = (page: Page): Promise<HeroAnimation> =>
  page.evaluate(() => (window as unknown as { heroAnimation(): HeroAnimation }).heroAnimation());

/** The rectangle rounded to whole pixels (a scaled container's box can be fractional on screen). */
const rounded = (rect: Rect): Rect => ({
  left: Math.round(rect.left),
  top: Math.round(rect.top),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

test.describe("player under an animated ancestor (videojs.org)", () => {
  test("fill-tab: a finished fill-mode transform animation does not trap the player; exit restores it without a replay", async ({
    context,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/animated-ancestor.html`);
    await expect.poll(async () => (await heroAnimation(page)).playState).toBe("finished");
    const before = await heroAnimation(page);
    expect(before).toMatchObject({ count: 1, name: "hero-video-in", playState: "finished" });
    const stylesBefore = await styleChain(page.locator("#player"));
    const eventsBefore = types(await readLog(page), ANIMATION_EVENTS);
    expect(eventsBefore).toEqual(["animationstart", "animationend"]);

    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    const viewport = await viewportOf(page);
    // Before the fix: at the wrapper's offset (152, 144), the control bar below the viewport.
    expect(rounded(await screenRectOf(page.locator("#player")))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });
    const bar = rounded(await screenRectOf(page.locator("#bar")));
    expect(bar.top + bar.height).toBe(viewport.height);

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    // The wrapper looks as before: the same finished animation at the same time, its end state, no replay.
    expect(await heroAnimation(page)).toEqual(before);
    expect(types(await readLog(page), ANIMATION_EVENTS)).toEqual(eventsBefore);
    expect(await styleChain(page.locator("#player"))).toEqual(stylesBefore);
    expect(rounded(await screenRectOf(page.locator("#hero")))).toMatchObject({ left: 152, width: 800, height: 450 });
  });

  test("custom-rect 80 %: a running transform animation does not trap the player and keeps running", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const RECT = { width: 80, widthUnit: "%", height: 80, heightUnit: "%", anchor: "center" } as const;
    await setOptions(context, serviceWorker, extensionId, { mode: "custom-rect", rect: RECT });
    await openFixture(page, `${origins.a}/animated-ancestor.html?running`);
    const before = await heroAnimation(page);
    expect(before).toMatchObject({ count: 1, name: "hero-drift", playState: "running" });
    const eventsBefore = types(await readLog(page), ANIMATION_EVENTS);
    expect(eventsBefore).toEqual(["animationstart"]);

    // The button moves with the running animation, so it never counts as stable: click where it is.
    await page.click("#fs", { force: true });
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    const viewport = await viewportOf(page);
    expect(rounded(await screenRectOf(page.locator("#player")))).toEqual(expectedRect(viewport, RECT));

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    // Still the same running animation, further along its timeline: it was neither restarted nor cancelled.
    const after = await heroAnimation(page);
    expect(after).toMatchObject({ count: 1, name: "hero-drift", playState: "running" });
    expect(after.currentTime).toBeGreaterThan(before.currentTime ?? Infinity);
    expect(after.transform).not.toBe("none");
    expect(types(await readLog(page), ANIMATION_EVENTS)).toEqual(eventsBefore);
  });

  test("an animation that starts on the wrapper while pinned is taken off too, and is back after exit", async ({ page, origins }) => {
    await openFixture(page, `${origins.a}/animated-ancestor.html`);
    await expect.poll(async () => (await heroAnimation(page)).playState).toBe("finished");
    await page.click("#fs");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    const viewport = await viewportOf(page);
    const full = { left: 0, top: 0, width: viewport.width, height: viewport.height };

    await page.evaluate(() => document.getElementById("hero")!.classList.add("wobble"));
    await expect.poll(async () => types(await readLog(page), ["animationstart"]).length).toBe(2);
    await expect.poll(async () => rounded(await screenRectOf(page.locator("#player")))).toEqual(full);

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await heroAnimation(page)).toMatchObject({ count: 1, name: "wobble", playState: "running" });
  });
});
