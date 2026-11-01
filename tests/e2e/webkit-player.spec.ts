// Fixture 4 (webkit-player.html): a player that only knows webkitRequestFullscreen, webkitEnterFullscreen
// (where the browser has it), webkitfullscreenchange and document.webkitFullscreenElement / webkitIsFullScreen.
import {
  evaluateUnpatched,
  expect,
  FULLSCREEN_EVENTS,
  openFixture,
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

const WEBKIT_CHANGE = ["webkitfullscreenchange"];

interface Run {
  features: Record<string, unknown>;
  enter: unknown[];
  exit: unknown[];
  controlsWhileFullscreen: string;
}

/** What a page can observe from the promise or return value onwards (§8: getters change synchronously). */
function observable(log: LogEntry[]): unknown[] {
  return log
    .filter((entry) => [...FULLSCREEN_EVENTS, "returned", "promise", "reject", "throw", "missing"].includes(entry.type))
    .map((entry) =>
      entry.type === "returned"
        ? { type: entry.type, value: entry["value"] }
        : {
            type: entry.type,
            target: entry["target"],
            fullscreenElement: entry.fullscreenElement,
            webkitFullscreenElement: entry.webkitFullscreenElement,
            webkitCurrentFullScreenElement: entry.webkitCurrentFullScreenElement,
            fullscreen: entry.fullscreen,
            webkitIsFullScreen: entry.webkitIsFullScreen,
          },
    );
}

async function controlsBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.getElementById("controls")!).backgroundColor);
}

async function run(page: Page, url: string, button: string, exitMethod: string): Promise<Run> {
  await openFixture(page, url);
  const features = await page.evaluate(() => (window as unknown as { __features: Record<string, unknown> }).__features);
  await page.click(button);
  await expect.poll(async () => types(await readLog(page), WEBKIT_CHANGE)).toEqual(WEBKIT_CHANGE);
  const enter = observable(await readLog(page));
  const controlsWhileFullscreen = await controlsBackground(page);
  const before = (await readLog(page)).length;
  await page.evaluate((method) => (window as unknown as { CFS: { exit(method: string): void } }).CFS.exit(method), exitMethod);
  await expect.poll(async () => types(await readLog(page), WEBKIT_CHANGE)).toEqual([...WEBKIT_CHANGE, ...WEBKIT_CHANGE]);
  await page.waitForTimeout(200);
  const exit = observable((await readLog(page)).slice(before));
  return { features, enter, exit, controlsWhileFullscreen };
}

test.describe("fixture 4: webkit-only player", () => {
  test("webkitRequestFullscreen on the player: the same events, getters and :-webkit-full-screen styling as real Chromium", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    const url = `${origins.a}/webkit-player.html`;
    await setOptions(context, serviceWorker, extensionId, { enabled: false });
    const real = await run(page, url, "#fs", "webkitExitFullscreen");
    await setOptions(context, serviceWorker, extensionId, { enabled: true });
    const faked = await run(page, url, "#fs", "webkitExitFullscreen");

    expect(real.enter).toEqual([
      { type: "returned", value: "undefined" },
      {
        type: "webkitfullscreenchange",
        target: "#player",
        fullscreenElement: "#player",
        webkitFullscreenElement: "#player",
        webkitCurrentFullScreenElement: "#player",
        fullscreen: true,
        webkitIsFullScreen: true,
      },
    ]);
    expect(faked).toEqual(real);
    expect(faked.controlsWhileFullscreen).toBe("rgb(0, 0, 200)");
    // Prefixed members the browser does not have stay absent (Chromium 145 has no video webkitEnterFullscreen).
    const natives = await evaluateUnpatched<Record<string, unknown>>(
      context,
      page,
      `(() => { const player = document.getElementById("player"); const video = document.getElementById("video"); return {
        webkitRequestFullscreen: typeof player.webkitRequestFullscreen, webkitRequestFullScreen: typeof player.webkitRequestFullScreen,
        webkitEnterFullscreen: typeof video.webkitEnterFullscreen, webkitEnterFullScreen: typeof video.webkitEnterFullScreen,
        webkitExitFullscreenOnVideo: typeof video.webkitExitFullscreen, webkitSupportsFullscreen: typeof video.webkitSupportsFullscreen,
        webkitDisplayingFullscreen: typeof video.webkitDisplayingFullscreen, webkitExitFullscreen: typeof document.webkitExitFullscreen,
        webkitCancelFullScreen: typeof document.webkitCancelFullScreen, webkitFullscreenEnabled: document.webkitFullscreenEnabled }; })()`,
    );
    expect(faked.features).toEqual(natives);
  });

  test("the video's own prefixed request is faked, pinned, and webkitCancelFullScreen restores it", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/webkit-player.html`);
    const video = page.locator("#video");
    const stylesBefore = await styleChain(video);
    await page.click("#video-fs");
    await expect.poll(async () => types(await readLog(page), WEBKIT_CHANGE)).toEqual(WEBKIT_CHANGE);

    expect(types(await readLog(page), [...FULLSCREEN_EVENTS])).toEqual(WEBKIT_CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(
      await page.evaluate(() => {
        const d = document as Document & { webkitFullscreenElement?: Element | null; webkitIsFullScreen?: boolean };
        return { element: d.webkitFullscreenElement?.id, is: d.webkitIsFullScreen };
      }),
    ).toEqual({ element: "video", is: true });
    const viewport = await viewportOf(page);
    expect(await rectOf(video)).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });

    await page.evaluate(() => (window as unknown as { CFS: { exit(method: string): void } }).CFS.exit("webkitCancelFullScreen"));
    await expect.poll(async () => types(await readLog(page), WEBKIT_CHANGE)).toEqual([...WEBKIT_CHANGE, ...WEBKIT_CHANGE]);
    expect(await page.evaluate(() => (document as Document & { webkitIsFullScreen?: boolean }).webkitIsFullScreen)).toBe(false);
    expect(await styleChain(video)).toEqual(stylesBefore);
  });
});
