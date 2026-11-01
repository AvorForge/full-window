// Pop-out mode (§5): the service worker moves the tab into its own popup window at the set size while its video is
// in fullscreen, leaves a placeholder tab in its place, and puts it back where the placeholder is on exit and on
// navigation. Closing the popup window turns the placeholder back into the page. The browser window is never resized. The
// layout of windows and tabs comes from chrome.windows in the service worker (by tab id: without the "tabs"
// permission the extension doesn't see tab URLs).
import { expect as baseExpect, openFixture, readLog, rectOf, setOptions, test, types, viewportOf, type BrowserContext, type Page, type Worker } from "./harness/extension";

const CHANGE = ["fullscreenchange"];

// Popup windows are created, resized and closed by the service worker through chrome.windows. On a busy host
// (four browsers at once, load well past the CPU count) that alone took longer than the default 5 s, and the
// popup was not there yet when the poll gave up, so these waits are longer. Waits that measure time keep their own.
const expect = baseExpect.configure({ timeout: 15_000 });
const SIZE = { width: 700, height: 460 };

interface Layout {
  id: number;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  state: string;
  tabs: Array<{ id: number; index: number }>;
}

async function layout(worker: Worker): Promise<Layout[]> {
  return worker.evaluate(async () =>
    (await chrome.windows.getAll({ populate: true })).map((w) => ({
      id: w.id ?? -1,
      type: w.type ?? "",
      left: w.left ?? 0,
      top: w.top ?? 0,
      width: w.width ?? 0,
      height: w.height ?? 0,
      state: w.state ?? "",
      tabs: (w.tabs ?? []).map((t) => ({ id: t.id ?? -1, index: t.index })),
    })),
  );
}

/** The id of the active tab of the (only) normal window: the page under test, once brought to the front. */
async function activeTab(worker: Worker): Promise<number> {
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, windowType: "normal" }))[0]?.id ?? -1);
}

/** The window holding tab `id`, and the tab's index there. */
async function whereIs(worker: Worker, id: number): Promise<{ window: Layout; index: number } | undefined> {
  for (const window of await layout(worker)) {
    const tab = window.tabs.find((t) => t.id === id);
    if (tab) return { window, index: tab.index };
  }
  return undefined;
}

/** The pop-out record of tab `id` (chrome.storage.session), with its placeholder tab and popup window. */
async function record(worker: Worker, id: number): Promise<{ placeholderTabId: number | null; popupWindowId: number | null } | undefined> {
  return worker.evaluate(async (tabId) => {
    const stored = (await chrome.storage.session.get("popOut")) as { popOut?: Record<string, { placeholderTabId: number | null; popupWindowId: number | null }> };
    return stored.popOut?.[String(tabId)];
  }, id);
}

/** The placeholder page among the context's pages, once it has loaded. */
async function placeholderPage(context: BrowserContext): Promise<Page> {
  await expect.poll(() => context.pages().some((p) => p.url().includes("/ui/poppedOut.html"))).toBe(true);
  const placeholder = context.pages().find((p) => p.url().includes("/ui/poppedOut.html"))!;
  await placeholder.waitForLoadState();
  return placeholder;
}

const box = (w: Layout) => ({ left: w.left, top: w.top, width: w.width, height: w.height, state: w.state });

/**
 * The hover bar's buttons, by accessible name, with their centres: the bar is in a closed shadow root, so they
 * come from the accessibility tree and the DOM's box model over CDP. A hidden bar (visibility: hidden) has none.
 */
async function barButtons(page: Page): Promise<Array<{ name: string; x: number; y: number }>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: Array<{ nodeId: string; parentId?: string; ignored: boolean; role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }>;
    };
    const toolbars = new Set(nodes.filter((n) => !n.ignored && n.role?.value === "toolbar").map((n) => n.nodeId));
    const buttons = nodes.filter((n) => !n.ignored && n.role?.value === "button" && n.parentId !== undefined && toolbars.has(n.parentId));
    const found: Array<{ name: string; x: number; y: number }> = [];
    for (const button of buttons) {
      const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: button.backendDOMNodeId! })) as { model: { content: number[] } };
      const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
      found.push({ name: button.name?.value ?? "", x: (x1 + x3) / 2, y: (y1 + y3) / 2 });
    }
    return found;
  } finally {
    await cdp.detach();
  }
}

const barNames = async (page: Page): Promise<string[]> => (await barButtons(page)).map((b) => b.name);

/** Clicks the hover bar's button `name` (showing the bar first). */
async function clickBar(page: Page, name: string): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.move(210, 210);
  await expect.poll(() => barNames(page)).toContain(name);
  const button = (await barButtons(page)).find((b) => b.name === name)!;
  await page.mouse.click(button.x, button.y);
}

/** The hover bar's host is shown (it is in the top layer while it is). */
async function barShown(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector("[popover][data-shown]")?.matches(":popover-open") === true);
}

/** The corner grip is shown (its host's attribute: the grip itself is in the closed shadow root). */
async function gripShown(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector("[popover][data-shown][data-grip]")?.matches(":popover-open") === true);
}

/** What takes the pointer at (x, y): our host (the bar or grip, retargeted from the closed shadow root) or the page's element. */
async function hitAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px!, py!);
    if (!element) return "nothing";
    if (element.matches("[popover]")) return "ours";
    return element.closest("[id]")?.id ?? element.localName;
  }, [x, y]);
}

async function fillsViewportWith(page: Page, selector: string): Promise<boolean> {
  const viewport = await viewportOf(page);
  const rect = await rectOf(page.locator(selector));
  return rect.left === 0 && rect.top === 0 && rect.width === viewport.width && rect.height === viewport.height;
}

const fillsViewport = (page: Page): Promise<boolean> => fillsViewportWith(page, "#video");

test.describe("pop-out mode", () => {
  test.beforeEach(async ({ context, serviceWorker, extensionId }) => {
    await setOptions(context, serviceWorker, extensionId, { mode: "pop-out", windowSize: SIZE });
  });

  test("entering moves the tab into a popup of the set size; Esc puts it back in its place; the browser window is untouched", async ({
    context,
    serviceWorker,
    page,
    origins,
  }) => {
    const url = `${origins.a}/plain-video.html`;
    await openFixture(page, url);
    // Another tab after it, so its place in the window matters.
    const other = await context.newPage();
    await other.goto(`${origins.a}/plain-page.html`);
    await page.bringToFront();
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    expect(before.window.type).toBe("normal");

    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    // Headless creates the popup at a default size; the service worker sets the bounds just after.
    await expect
      .poll(async () => {
        const out = (await whereIs(serviceWorker, tab))!;
        return [out.window.width, out.window.height, out.window.tabs.length];
      })
      .toEqual([SIZE.width, SIZE.height, 1]);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    await expect.poll(() => fillsViewport(page)).toBe(true);
    expect(await page.evaluate(() => !(document.getElementById("video") as HTMLVideoElement).paused)).toBe(true);
    const main = (await layout(serviceWorker)).find((w) => w.id === before.window.id)!;
    expect(box(main)).toEqual(box(before.window));
    // A placeholder holds the tab's place: same window, same index, not active, titled after the page.
    await expect.poll(async () => (await record(serviceWorker, tab))?.placeholderTabId ?? null).not.toBeNull();
    const placeholderId = (await record(serviceWorker, tab))!.placeholderTabId!;
    expect(await whereIs(serviceWorker, placeholderId)).toMatchObject({ window: { id: before.window.id }, index: before.index });
    expect(main.tabs).toHaveLength(before.window.tabs.length);
    expect(await activeTab(serviceWorker)).not.toBe(placeholderId);
    await expect(await placeholderPage(context)).toHaveTitle("Popped out: Fixture 1: plain video");

    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.id).toBe(before.window.id);
    expect((await whereIs(serviceWorker, tab))!.index).toBe(before.index);
    await expect.poll(async () => (await layout(serviceWorker)).filter((w) => w.type === "popup")).toEqual([]);
    expect(box((await whereIs(serviceWorker, tab))!.window)).toEqual(box(before.window));
    // The placeholder is gone and the tab is the active one again.
    await expect.poll(() => whereIs(serviceWorker, placeholderId)).toBeUndefined();
    expect((await whereIs(serviceWorker, tab))!.window.tabs).toHaveLength(before.window.tabs.length);
    expect(await activeTab(serviceWorker)).toBe(tab);
  });

  test("Bring it back on the placeholder pops the video back in, to wherever the placeholder is", async ({ context, serviceWorker, page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const other = await context.newPage();
    await other.goto(`${origins.a}/plain-page.html`);
    await page.bringToFront();
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    const placeholder = await placeholderPage(context);
    const placeholderId = (await record(serviceWorker, tab))!.placeholderTabId!;
    // The user drags the placeholder to the end of the tab strip.
    await serviceWorker.evaluate(async (id) => void (await chrome.tabs.move(id, { index: -1 })), placeholderId);
    const moved = (await whereIs(serviceWorker, placeholderId))!;
    expect(moved.index).toBe(before.window.tabs.length - 1);

    await expect(placeholder.getByRole("heading", { name: "This video is in its own window" })).toBeVisible();
    await placeholder.getByRole("button", { name: "Bring it back" }).click();
    // As with Esc: fake fullscreen ends and the tab comes back, where the placeholder was.
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.id).toBe(before.window.id);
    expect((await whereIs(serviceWorker, tab))!.index).toBe(moved.index);
    await expect.poll(() => whereIs(serviceWorker, placeholderId)).toBeUndefined();
    await expect.poll(async () => (await layout(serviceWorker)).filter((w) => w.type === "popup")).toEqual([]);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await activeTab(serviceWorker)).toBe(tab);
  });

  test("closing the popup window turns the placeholder back into the page", async ({ context, serviceWorker, page, origins }) => {
    const url = `${origins.a}/plain-video.html`;
    await openFixture(page, url);
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    const placeholder = await placeholderPage(context);
    const { placeholderTabId, popupWindowId } = (await record(serviceWorker, tab))!;

    // The title bar's X.
    await serviceWorker.evaluate(async (id) => chrome.windows.remove(id), popupWindowId!);
    await expect.poll(() => page.isClosed()).toBe(true);
    // The placeholder's own tab loads the page again.
    await expect(placeholder).toHaveURL(url);
    await expect(placeholder).toHaveTitle("Fixture 1: plain video");
    // In the placeholder's tab, at the page's old place; nothing else left over.
    expect(await whereIs(serviceWorker, placeholderTabId!)).toMatchObject({ window: { id: before.window.id }, index: before.index });
    expect(context.pages().some((p) => p.url().includes("/ui/poppedOut.html"))).toBe(false);
    expect(await record(serviceWorker, tab)).toBeUndefined();
  });

  test("the next pop-out opens where the last one was left", async ({ serviceWorker, page, origins }) => {
    const url = `${origins.a}/plain-video.html`;
    await openFixture(page, url);
    const tab = await activeTab(serviceWorker);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    // Once the service worker has set its bounds (headless creates it at a default size first).
    await expect.poll(async () => (await whereIs(serviceWorker, tab))!.window.width).toBe(SIZE.width);
    const popup = (await whereIs(serviceWorker, tab))!.window;
    // The user drags it to the top-left corner.
    await serviceWorker.evaluate(async (id) => {
      await chrome.windows.update(id, { left: 40, top: 30 });
    }, popup.id);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))!.window.left).toBe(40);

    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))!.window).toMatchObject({ left: 40, top: 30, width: SIZE.width, height: SIZE.height });
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
  });

  test("navigating puts the tab back; a window it was the only tab of stays open with the placeholder", async ({ serviceWorker, page, origins }) => {
    const url = `${origins.a}/plain-video.html`;
    await openFixture(page, url);
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    expect(before.window.tabs).toHaveLength(1);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");

    // Its window had only this tab; the placeholder keeps it open, untouched.
    expect((await layout(serviceWorker)).map((w) => w.type).sort()).toEqual(["normal", "popup"]);
    const main = (await layout(serviceWorker)).find((w) => w.id === before.window.id)!;
    expect(box(main)).toEqual(box(before.window));
    expect(main.tabs).toHaveLength(1);
    await page.goto(`${origins.a}/container-player.html`);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.id).toBe(before.window.id);
    expect(box((await whereIs(serviceWorker, tab))!.window)).toEqual(box(before.window));
    await expect.poll(async () => (await layout(serviceWorker)).filter((w) => w.type === "popup")).toEqual([]);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.tabs.length).toBe(1);
  });

  test("the hover bar shows on pointer movement and hides about 2 s after it stops, but not while the pointer is on it", async ({
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const tab = await activeTab(serviceWorker);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.width).toBe(SIZE.width);
    await page.mouse.move(5, 5);
    await expect.poll(() => barShown(page), { timeout: 4_000 }).toBe(false);
    // Faded out and out of the top layer: nothing of it left to reach.
    await expect.poll(() => barNames(page)).toEqual([]);

    await page.mouse.move(300, 300);
    await page.mouse.move(320, 310);
    const moved = Date.now();
    await expect.poll(() => barShown(page)).toBe(true);
    // Three buttons, each with its tooltip and accessible name, in the pill at the top centre.
    expect(await barNames(page)).toEqual(["Pop back in", "Full screen", "Minimize"]);
    const buttons = await barButtons(page);
    const viewport = await viewportOf(page);
    expect(Math.abs(buttons[1]!.x - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(buttons.every((b) => b.y < 40)).toBe(true);
    // The pointer stops: gone about 2 s later, not before.
    await expect.poll(() => barShown(page), { timeout: 5_000 }).toBe(false);
    expect(Date.now() - moved).toBeGreaterThanOrEqual(1_900);

    // The pointer rests on the bar: it stays.
    await page.mouse.move(300, 300);
    await expect.poll(() => barShown(page)).toBe(true);
    const minimize = (await barButtons(page)).find((b) => b.name === "Minimize")!;
    await page.mouse.move(minimize.x, minimize.y);
    await page.waitForTimeout(3_000);
    expect(await barShown(page)).toBe(true);
    // And leaves it: hidden again.
    await page.mouse.move(300, 300);
    await expect.poll(() => barShown(page), { timeout: 5_000 }).toBe(false);
    // Once it has faded out, the page's own content takes the pointer where the bar was.
    await expect.poll(() => page.evaluate(() => document.elementFromPoint(innerWidth / 2, 30)?.id)).toBe("video");
  });

  test("the bar's Full screen, Exit full screen and Minimize set the popup window's state; Esc leaves full screen first", async ({
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.width).toBe(SIZE.width);
    const popupId = (await whereIs(serviceWorker, tab))!.window.id;
    const state = async () => (await layout(serviceWorker)).find((w) => w.id === popupId)?.state;
    const main = (await layout(serviceWorker)).find((w) => w.id === before.window.id)!;

    await clickBar(page, "Full screen");
    await expect.poll(state).toBe("fullscreen");
    await expect.poll(() => barNames(page)).toEqual(["Pop back in", "Exit full screen", "Minimize"]);
    await clickBar(page, "Exit full screen");
    await expect.poll(state).toBe("normal");
    await expect.poll(() => barNames(page)).toEqual(["Pop back in", "Full screen", "Minimize"]);

    // Esc while full screen: back to the floating window, still popped out; the next Esc pops it back in.
    await clickBar(page, "Full screen");
    await expect.poll(state).toBe("fullscreen");
    await page.keyboard.press("Escape");
    await expect.poll(state).toBe("normal");
    expect((await whereIs(serviceWorker, tab))!.window.id).toBe(popupId);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");

    await clickBar(page, "Minimize");
    await expect.poll(state).toBe("minimized");
    // Only the popup: the browser window is as it was.
    expect(box((await layout(serviceWorker)).find((w) => w.id === before.window.id)!)).toEqual(box(main));
    await serviceWorker.evaluate(async (id) => void (await chrome.windows.update(id, { state: "normal" })), popupId);
    await expect.poll(state).toBe("normal");

    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.id).toBe(before.window.id);
    expect((await whereIs(serviceWorker, tab))!.index).toBe(before.index);
  });

  test("the bar's Pop back in does what Esc does: the tab goes back to its place", async ({ context, serviceWorker, page, origins }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const other = await context.newPage();
    await other.goto(`${origins.a}/plain-page.html`);
    await page.bringToFront();
    const tab = await activeTab(serviceWorker);
    const before = (await whereIs(serviceWorker, tab))!;
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    await expect.poll(async () => (await record(serviceWorker, tab))?.placeholderTabId ?? null).not.toBeNull();
    const placeholderId = (await record(serviceWorker, tab))!.placeholderTabId!;

    await clickBar(page, "Pop back in");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.id).toBe(before.window.id);
    expect((await whereIs(serviceWorker, tab))!.index).toBe(before.index);
    await expect.poll(() => whereIs(serviceWorker, placeholderId)).toBeUndefined();
    await expect.poll(async () => (await layout(serviceWorker)).filter((w) => w.type === "popup")).toEqual([]);
    expect(await activeTab(serviceWorker)).toBe(tab);
    // The bar is gone with the pop-out.
    expect(await page.evaluate(() => document.querySelector("[popover]"))).toBeNull();
  });

  test("dragging the corner grip resizes the popup window, at least 320 x 200, and the next pop-out opens at that size", async ({
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const tab = await activeTab(serviceWorker);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.width).toBe(SIZE.width);
    const popup = async () => (await whereIs(serviceWorker, tab))!.window;
    const start = await popup();

    const grip = async (): Promise<{ x: number; y: number }> => {
      const viewport = await viewportOf(page);
      return { x: viewport.width - 8, y: viewport.height - 8 };
    };
    await page.mouse.move(300, 300);
    await page.mouse.move(310, 300);
    await expect.poll(() => barShown(page)).toBe(true);
    const startViewport = await viewportOf(page);
    let at = await grip();
    // Not near the corner: no grip there yet.
    expect(await hitAt(page, at.x, at.y)).toBe("video");
    await page.mouse.move(at.x, at.y);
    // In the corner: the grip is ours (the closed shadow root's host).
    expect(await gripShown(page)).toBe(true);
    expect(await hitAt(page, at.x, at.y)).toBe("ours");
    await page.mouse.down();
    await page.mouse.move(at.x + 60, at.y + 20, { steps: 4 });
    await page.mouse.move(at.x + 120, at.y + 70, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => [(await popup()).width, (await popup()).height]).toEqual([start.width + 120, start.height + 70]);
    // Its place is unchanged: the window grows from the bottom-right corner.
    expect([(await popup()).left, (await popup()).top]).toEqual([start.left, start.top]);
    await expect.poll(async () => (await viewportOf(page)).width).toBe(startViewport.width + 120);

    // Smaller than the floor: 320 x 200.
    await page.mouse.move(300, 300);
    at = await grip();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x - 2000, at.y - 2000, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => [(await popup()).width, (await popup()).height]).toEqual([320, 200]);
    await page.mouse.move(100, 100);
    at = await grip();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 280, at.y + 160, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => [(await popup()).width, (await popup()).height]).toEqual([600, 360]);

    // The size it was dragged to is remembered, and the next pop-out opens at it.
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
    const placement = await serviceWorker.evaluate(async () => (await chrome.storage.local.get("popOutPlacement"))["popOutPlacement"]);
    expect(placement).toMatchObject({ width: 600, height: 360, requested: SIZE });
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");
    await expect.poll(async () => [(await popup()).width, (await popup()).height]).toEqual([600, 360]);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
  });

  test("the corner grip shows only while the pointer is near the bottom-right corner; hidden, the corner is the page's", async ({
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const tab = await activeTab(serviceWorker);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.width).toBe(SIZE.width);
    const viewport = await viewportOf(page);
    const corner = { x: viewport.width - 8, y: viewport.height - 8 };

    // The pointer in the middle: the bar shows, the grip does not, and the corner is the page's.
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.move(viewport.width / 2 + 10, viewport.height / 2);
    await expect.poll(() => barShown(page)).toBe(true);
    expect(await gripShown(page)).toBe(false);
    expect(await hitAt(page, corner.x, corner.y)).toBe("video");
    expect(await hitAt(page, viewport.width - 1, viewport.height - 1)).toBe("video");

    // Into the corner zone (56 px from the right and bottom edges), but not onto the grip: it shows at once.
    await page.mouse.move(viewport.width - 50, viewport.height - 50);
    expect(await gripShown(page)).toBe(true);
    expect(await hitAt(page, corner.x, corner.y)).toBe("ours");
    // 57 px from the right edge: out of the zone, hidden at once (the bar stays).
    await page.mouse.move(viewport.width - 57, viewport.height - 20);
    expect(await gripShown(page)).toBe(false);
    expect(await barShown(page)).toBe(true);
    // Hit testing does not wait for the fade.
    expect(await hitAt(page, corner.x, corner.y)).toBe("video");
    // Onto the grip, through the zone as a real pointer goes, and resting there: it stays, with the bar.
    await page.mouse.move(viewport.width - 40, viewport.height - 30);
    await page.mouse.move(corner.x, corner.y, { steps: 3 });
    expect(await gripShown(page)).toBe(true);
    await page.waitForTimeout(2_500);
    expect([await barShown(page), await gripShown(page)]).toEqual([true, true]);
    // Out of the window past the corner: gone at once.
    await page.mouse.move(viewport.width + 20, viewport.height + 20);
    await expect.poll(() => gripShown(page)).toBe(false);
    expect(await hitAt(page, corner.x, corner.y)).toBe("video");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
  });

  test("a click on the demo player's own fullscreen button, in the corner, reaches the player while the bar shows", async ({
    serviceWorker,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/demo-player.html`);
    const tab = await activeTab(serviceWorker);
    // The player's own button takes the page into (fake) fullscreen, which pops it out.
    await page.click("#fs");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.width).toBe(SIZE.width);
    await expect.poll(() => fillsViewportWith(page, "#player")).toBe(true);
    const viewport = await viewportOf(page);
    const fs = await rectOf(page.locator("#fs"));
    // The button is in the corner, partly under where the grip would be.
    expect(fs.left + fs.width).toBeGreaterThan(viewport.width - 22);
    expect(fs.top + fs.height).toBeGreaterThan(viewport.height - 22);
    const under = { x: (fs.left + fs.width + viewport.width - 22) / 2, y: (fs.top + fs.height + viewport.height - 22) / 2 };

    await page.mouse.move(300, 200);
    await page.mouse.move(310, 200);
    await expect.poll(() => barShown(page)).toBe(true);
    expect(await gripShown(page)).toBe(false);
    // Where the grip was drawn on top of it (in the 22 px corner tab), the player's button takes the pointer.
    expect(await hitAt(page, under.x, under.y)).toBe("fs");
    expect(await hitAt(page, fs.left + fs.width / 2, fs.top + fs.height / 2)).toBe("fs");

    // A real click on the button: the player gets it and leaves fullscreen, which pops the tab back in.
    await page.mouse.click(fs.left + fs.width / 2, fs.top + fs.height / 2);
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("normal");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  });

  test("switching tabs in the browser window leaves the pop-out playing", async ({ context, serviceWorker, page, origins }) => {
    const url = `${origins.a}/plain-video.html`;
    await openFixture(page, url);
    const tab = await activeTab(serviceWorker);
    await page.click("#enter");
    await expect.poll(async () => (await whereIs(serviceWorker, tab))?.window.type).toBe("popup");

    const other = await context.newPage();
    await other.goto(`${origins.a}/plain-page.html`);
    await other.bringToFront();
    await page.waitForTimeout(300);
    expect((await whereIs(serviceWorker, tab))!.window.type).toBe("popup");
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe("video");
    expect(await page.evaluate(() => !(document.getElementById("video") as HTMLVideoElement).paused)).toBe(true);
  });
});
