import { describe, expect, it } from "vitest";
import {
  CORNER_GAP,
  PLACEMENT_KEY,
  PopOutController,
  SESSION_KEY,
  placeholderUrl,
  restorableUrl,
  type PopOutTabsApi,
  type PopOutWindowsApi,
  type SessionArea,
} from "../src/background/popOut";

function area() {
  let stored: Record<string, unknown> = {};
  const api = {
    get: async () => structuredClone(stored),
    set: async (items: Record<string, unknown>) => {
      stored = { ...stored, ...structuredClone(items) };
    },
  } as unknown as SessionArea;
  return { api, stored: () => stored };
}

/** Windows and tabs as Chromium keeps them: tab 3 sits at index 2 of window 7. */
function fakes() {
  const wins = new Map<number, chrome.windows.Window>([[7, { id: 7, left: 100, top: 50, width: 1500, height: 1000, state: "normal" } as chrome.windows.Window]]);
  const tabs = new Map<number, { windowId: number; index: number; active: boolean; url?: string }>([[3, { windowId: 7, index: 2, active: true }]]);
  const created: chrome.windows.CreateData[] = [];
  /** Tabs the controller opened (placeholders), removed, and navigated. */
  const tabsCreated: chrome.tabs.CreateProperties[] = [];
  const removed: number[] = [];
  const navigated: Array<{ tabId: number; url: string }> = [];
  const windowUpdates: Array<{ id: number; info: chrome.windows.UpdateInfo }> = [];
  let nextTabId = 100;
  /** The state a new window opens in (Chromium has opened pop-outs minimized). */
  let createState: chrome.windows.Window["state"] = "normal";
  /** Which window update calls are still pending (the resize coalescing tests hold them). */
  let holdUpdates: Array<() => void> | null = null;
  const focused: number[] = [];
  let nextId = 20;
  let rejectPosition = false;
  /** Like Chromium: a tab leaving a window shifts the tabs after it left; one arriving shifts them right. */
  const detach = (id: number) => {
    const tab = tabs.get(id)!;
    for (const other of tabs.values()) if (other.windowId === tab.windowId && other.index > tab.index) other.index--;
    // A window closes once its last tab has left.
    if (![...tabs.entries()].some(([otherId, other]) => otherId !== id && other.windowId === tab.windowId)) wins.delete(tab.windowId);
  };
  const insert = (windowId: number, index: number) => {
    for (const other of tabs.values()) if (other.windowId === windowId && other.index >= index) other.index++;
  };
  const windows = {
    get: async (id: number) => {
      const win = wins.get(id);
      if (!win) throw new Error(`No window with id: ${id}.`);
      return { ...win };
    },
    create: async (data: chrome.windows.CreateData) => {
      created.push(data);
      if (rejectPosition && data.left !== undefined) throw new Error("Invalid value for bounds.");
      const id = nextId++;
      const win = { id, left: data.left ?? 300, top: data.top ?? 200, width: data.width ?? 800, height: data.height ?? 600, state: createState, type: data.type ?? "normal" };
      wins.set(id, win as chrome.windows.Window);
      if (data.tabId !== undefined) {
        detach(data.tabId as number);
        tabs.set(data.tabId as number, { windowId: id, index: 0, active: true });
      }
      return { ...win } as chrome.windows.Window;
    },
    update: async (id: number, info: chrome.windows.UpdateInfo) => {
      windowUpdates.push({ id, info });
      if (holdUpdates) await new Promise<void>((resolve) => holdUpdates!.push(resolve));
      if (!wins.has(id)) throw new Error(`No window with id: ${id}.`);
      if (info.focused) focused.push(id);
      wins.set(id, { ...wins.get(id)!, ...info } as chrome.windows.Window);
      return { ...wins.get(id)! };
    },
  } as unknown as PopOutWindowsApi;
  const tabsApi = {
    get: async (id: number) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      return { id, ...tabs.get(id)! } as chrome.tabs.Tab;
    },
    create: async (props: chrome.tabs.CreateProperties) => {
      tabsCreated.push(props);
      if (!wins.has(props.windowId!)) throw new Error(`No window with id: ${props.windowId}.`);
      const id = nextTabId++;
      insert(props.windowId!, props.index!);
      tabs.set(id, { windowId: props.windowId!, index: props.index!, active: props.active ?? true, url: props.url! });
      return { id, windowId: props.windowId, index: props.index } as chrome.tabs.Tab;
    },
    remove: async (id: number) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      removed.push(id);
      detach(id);
      tabs.delete(id);
    },
    move: async (id: number, props: chrome.tabs.MoveProperties) => {
      if (!wins.has(props.windowId!)) throw new Error(`No window with id: ${props.windowId}.`);
      // The popup closes once its only tab has left.
      detach(id);
      insert(props.windowId!, props.index!);
      tabs.set(id, { windowId: props.windowId!, index: props.index!, active: false });
      return { id } as chrome.tabs.Tab;
    },
    update: async (id: number, props: chrome.tabs.UpdateProperties) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      if (props.url !== undefined) {
        navigated.push({ tabId: id, url: props.url });
        tabs.set(id, { ...tabs.get(id)!, url: props.url });
      } else tabs.set(id, { ...tabs.get(id)!, active: props.active ?? false });
      return { id } as chrome.tabs.Tab;
    },
  } as unknown as PopOutTabsApi;
  const session = area();
  const local = area();
  const controller = new PopOutController(windows, tabsApi, session.api, local.api);
  return {
    controller, wins, tabs, created, focused, session, local, tabsCreated, removed, navigated, windowUpdates,
    rejectPositions: () => (rejectPosition = true),
    openMinimized: () => (createState = "minimized"),
    /** Window updates wait until released; returns the release function (all pending, and later ones run). */
    holdWindowUpdates: () => {
      holdUpdates = [];
      return () => {
        const pending = holdUpdates ?? [];
        holdUpdates = null;
        pending.forEach((resolve) => resolve());
      };
    },
    /** The user drags and resizes the pop-out window. */
    moveWindow: (id: number, bounds: Partial<chrome.windows.Window>) => wins.set(id, { ...wins.get(id)!, ...bounds }),
  };
}

describe("PopOutController", () => {
  it("moves the tab into a popup in the source window's bottom-right corner, then back to its place", async () => {
    const f = fakes();
    const bounds = await f.controller.enter(3, 7, 640, 400);
    // 100 + 1500 - 640 - gap, 50 + 1000 - 400 - gap
    expect(f.created[0]).toEqual({ tabId: 3, type: "popup", focused: true, left: 960 - CORNER_GAP, top: 650 - CORNER_GAP, width: 640, height: 400 });
    expect(bounds).toMatchObject({ left: 960 - CORNER_GAP, top: 650 - CORNER_GAP, width: 640, height: 400, state: "normal" });
    expect(f.tabs.get(3)?.windowId).toBe(20);
    expect(f.session.stored()[SESSION_KEY]).toEqual({
      "3": {
        tabId: 3,
        fromWindowId: 7,
        index: 2,
        fromBounds: { left: 100, top: 50, width: 1500, height: 1000, state: "normal" },
        popupWindowId: 20,
        requested: { width: 640, height: 400 },
        placeholderTabId: 100,
        url: null,
      },
    });
    // The placeholder holds the tab's place: opened just before it, it has the tab's index once the tab left. Not active.
    expect(f.tabsCreated).toEqual([{ windowId: 7, index: 2, active: false, url: placeholderUrl({ title: "", url: null }) }]);
    expect(f.tabs.get(100)).toMatchObject({ windowId: 7, index: 2, active: false });

    expect(await f.controller.exit(3)).toBe(true);
    expect(f.tabs.get(3)).toEqual({ windowId: 7, index: 2, active: true });
    expect(f.removed).toEqual([100]);
    expect(f.tabs.has(100)).toBe(false);
    expect(f.focused).toEqual([7]);
    expect(f.wins.has(20)).toBe(false);
    expect(f.session.stored()[SESSION_KEY]).toEqual({});
    expect(await f.controller.exit(3)).toBe(false);
    // The browser window itself was never touched.
    expect(f.wins.get(7)).toMatchObject({ left: 100, top: 50, width: 1500, height: 1000, state: "normal" });
  });

  it("opens the next pop-out where the last one was left, at the size it was left at", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    f.moveWindow(20, { left: 40, top: 30, width: 720, height: 440 });
    await f.controller.exit(3);
    expect(f.local.stored()[PLACEMENT_KEY]).toEqual({ left: 40, top: 30, width: 720, height: 440, requested: { width: 640, height: 400 } });

    await f.controller.enter(3, 7, 640, 400);
    expect(f.created[1]).toMatchObject({ left: 40, top: 30, width: 720, height: 440 });
  });

  it("uses a changed size setting, at the remembered position", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    f.moveWindow(20, { left: 40, top: 30, width: 720, height: 440 });
    await f.controller.exit(3);

    await f.controller.enter(3, 7, 960, 580);
    expect(f.created[1]).toMatchObject({ left: 40, top: 30, width: 960, height: 580 });
  });

  it("doesn't remember a fullscreen or maximized pop-out's bounds", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    f.moveWindow(20, { left: 0, top: 0, width: 1920, height: 1080, state: "fullscreen" });
    await f.controller.exit(3);
    expect(f.local.stored()[PLACEMENT_KEY]).toBeUndefined();
  });

  it("lets Chromium place the window when the remembered position is off the screens", async () => {
    const f = fakes();
    f.rejectPositions();
    const bounds = await f.controller.enter(3, 7, 640, 400);
    expect(f.created.at(-1)).toEqual({ tabId: 3, type: "popup", focused: true, width: 640, height: 400 });
    expect(bounds).toMatchObject({ width: 640, height: 400 });
  });

  it("keeps going when Chromium refuses the bounds after creating the window: the tab can still go back", async () => {
    const f = fakes();
    f.rejectPositions();
    const update = (f.controller as unknown as { windows: PopOutWindowsApi }).windows;
    update.update = (async () => {
      throw new Error("Invalid value for bounds. Bounds must be at least 50% within visible screen space.");
    }) as PopOutWindowsApi["update"];
    await f.controller.enter(3, 7, 640, 400);
    expect(f.session.stored()[SESSION_KEY]).toMatchObject({ "3": { popupWindowId: 20 } });
    expect(await f.controller.exit(3)).toBe(true);
    expect(f.tabs.get(3)?.windowId).toBe(7);
  });

  it("opens a window like the one it came from when that one has closed (the tab was its only tab)", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    f.wins.delete(7);
    expect(await f.controller.exit(3)).toBe(true);
    expect(f.created.at(-1)).toEqual({ tabId: 3, focused: true, left: 100, top: 50, width: 1500, height: 1000 });
    expect(f.tabs.get(3)?.windowId).toBe(21);
  });

  it("maximizes the new window again if the one it came from was maximized", async () => {
    const f = fakes();
    f.wins.set(7, { ...f.wins.get(7)!, state: "maximized" });
    await f.controller.enter(3, 7, 640, 400);
    f.wins.delete(7);
    await f.controller.exit(3);
    expect(f.wins.get(21)?.state).toBe("maximized");
  });

  it("a second enter for the same tab returns the open pop-out instead of making another", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    const again = await f.controller.enter(3, 20, 640, 400);
    expect(f.created).toHaveLength(1);
    expect(again).toMatchObject({ width: 640, height: 400 });
    expect(await f.controller.recordForWindow(20)).toMatchObject({ tabId: 3 });
  });

  it("forgets a tab that closed: nothing to put back", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    await f.controller.tabClosed(3);
    expect(f.session.stored()[SESSION_KEY]).toEqual({});
    expect(await f.controller.exit(3)).toBe(false);
  });
});

describe("PopOutController: the placeholder tab", () => {
  const page = { title: "Demo player", url: "https://video.example/watch?v=1" };

  it("carries the page's title and URL in its own URL, and records the URL to restore", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400, page);
    expect(f.tabsCreated[0]?.url).toBe("/ui/poppedOut.html?title=Demo+player&url=https%3A%2F%2Fvideo.example%2Fwatch%3Fv%3D1");
    expect(await f.controller.recordForPlaceholder(100)).toMatchObject({ tabId: 3, url: page.url });
    // Only web and file pages are loaded back.
    expect(restorableUrl("file:///Users/me/video.html")).toBe("file:///Users/me/video.html");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://settings", "not a url", undefined]) expect(restorableUrl(url)).toBeNull();
  });

  it("brings the tab back to where the placeholder is now (dragged to another window and index), then closes it", async () => {
    const f = fakes();
    f.wins.set(8, { id: 8, left: 0, top: 0, width: 900, height: 700, state: "normal" } as chrome.windows.Window);
    await f.controller.enter(3, 7, 640, 400, page);
    f.tabs.set(100, { ...f.tabs.get(100)!, windowId: 8, index: 5 });
    expect(await f.controller.exit(3)).toBe(true);
    expect(f.tabs.get(3)).toEqual({ windowId: 8, index: 5, active: true });
    expect(f.removed).toEqual([100]);
    expect(f.focused).toEqual([8]);
  });

  it("falls back to the recorded window and index when the user closed the placeholder", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400, page);
    f.tabs.delete(100);
    await f.controller.tabClosed(100);
    // Closing the placeholder does nothing to the pop-out.
    expect(await f.controller.recordForTab(3)).toMatchObject({ popupWindowId: 20, placeholderTabId: null });
    expect(f.tabs.get(3)?.windowId).toBe(20);
    expect(await f.controller.exit(3)).toBe(true);
    expect(f.tabs.get(3)).toEqual({ windowId: 7, index: 2, active: true });
    expect(f.removed).toEqual([]);
  });

  it("falls back to the recorded place when the placeholder is gone without a word (its record is stale)", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400, page);
    f.tabs.delete(100);
    expect(await f.controller.exit(3)).toBe(true);
    expect(f.tabs.get(3)).toEqual({ windowId: 7, index: 2, active: true });
  });

  it("closing the popup window turns the placeholder back into the page", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400, page);
    f.tabs.delete(3);
    f.wins.delete(20);
    // Both events fire for the popup window's X; the page is loaded once.
    await Promise.all([f.controller.tabClosed(3), f.controller.windowClosed(20)]);
    expect(f.navigated).toEqual([{ tabId: 100, url: page.url }]);
    expect(f.session.stored()[SESSION_KEY]).toEqual({});
  });

  it("closes the placeholder again when no popup window could be made: the tab never left", async () => {
    const f = fakes();
    (f.controller as unknown as { windows: PopOutWindowsApi }).windows.create = (async () => {
      throw new Error("no windows today");
    }) as PopOutWindowsApi["create"];
    await expect(f.controller.enter(3, 7, 640, 400, page)).rejects.toThrow("no popup window");
    expect(f.removed).toEqual([100]);
    expect(f.tabs.get(3)).toMatchObject({ windowId: 7, index: 2 });
    expect(f.session.stored()[SESSION_KEY]).toEqual({});
  });

  it("does nothing when the popup window closes and the placeholder is gone too", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400, page);
    f.tabs.delete(100);
    await f.controller.tabClosed(100);
    f.tabs.delete(3);
    await f.controller.windowClosed(20);
    expect(f.navigated).toEqual([]);
    expect(f.session.stored()[SESSION_KEY]).toEqual({});
  });
});

describe("PopOutController: the popup window", () => {
  it("shows a popup that opened minimized: state normal, focused", async () => {
    const f = fakes();
    f.openMinimized();
    const bounds = await f.controller.enter(3, 7, 640, 400);
    expect(f.windowUpdates.at(-1)).toEqual({ id: 20, info: { state: "normal", focused: true } });
    expect(bounds.state).toBe("normal");
  });

  it("leaves a popup that opened normal alone", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    expect(f.windowUpdates.some((update) => update.info.state !== undefined)).toBe(false);
  });

  it("opens in the first pop-out's corner when Chromium refuses the remembered place (off every display)", async () => {
    const f = fakes();
    await f.local.api.set({ [PLACEMENT_KEY]: { left: 9000, top: 9000, width: 640, height: 400, requested: { width: 640, height: 400 } } });
    const create = (f.controller as unknown as { windows: PopOutWindowsApi }).windows.create;
    (f.controller as unknown as { windows: PopOutWindowsApi }).windows.create = (async (data: chrome.windows.CreateData) => {
      if (data.left === 9000) throw new Error("Invalid value for bounds. Bounds must be at least 50% within visible screen space.");
      return create(data);
    }) as PopOutWindowsApi["create"];
    await f.controller.enter(3, 7, 640, 400);
    expect(f.tabs.get(3)?.windowId).toBe(20);
    expect(f.wins.get(20)).toMatchObject({ left: 960 - CORNER_GAP, top: 650 - CORNER_GAP, width: 640, height: 400 });
  });

  it("acts on a tab's own popup window only: full screen, floating again, minimized", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    expect(await f.controller.windowAction(3, 20, "fullscreen")).toBe("fullscreen");
    expect(await f.controller.windowAction(3, 20, "normal")).toBe("normal");
    expect(await f.controller.windowAction(3, 20, "minimized")).toBe("minimized");
    expect(f.windowUpdates.slice(-3)).toEqual([
      { id: 20, info: { state: "fullscreen" } },
      { id: 20, info: { state: "normal", focused: true } },
      { id: 20, info: { state: "minimized" } },
    ]);
    const before = f.windowUpdates.length;
    // A tab that is not popped out, or a popped-out tab reporting another window, is refused.
    await expect(f.controller.windowAction(4, 20, "minimized")).rejects.toThrow("not a popped-out tab");
    await expect(f.controller.windowAction(3, 7, "minimized")).rejects.toThrow("not a popped-out tab");
    await expect(f.controller.resize(4, 20, 800, 600)).rejects.toThrow("not a popped-out tab");
    await expect(f.controller.resize(3, 7, 800, 600)).rejects.toThrow("not a popped-out tab");
    expect(f.windowUpdates).toHaveLength(before);
  });

  it("resizes to at least 320 x 200", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    await f.controller.resize(3, 20, 100.4, 50);
    expect(f.windowUpdates.at(-1)).toEqual({ id: 20, info: { width: 320, height: 200 } });
    await f.controller.resize(3, 20, 812.6, 455);
    expect(f.wins.get(20)).toMatchObject({ width: 813, height: 455 });
  });

  it("keeps one resize in flight and coalesces the rest to the latest size", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    const before = f.windowUpdates.length;
    const release = f.holdWindowUpdates();
    const first = f.controller.resize(3, 20, 700, 420);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all([f.controller.resize(3, 20, 710, 430), f.controller.resize(3, 20, 720, 440), f.controller.resize(3, 20, 730, 450)]);
    expect(f.windowUpdates.slice(before)).toEqual([{ id: 20, info: { width: 700, height: 420 } }]);
    release();
    await first;
    expect(f.windowUpdates.slice(before)).toEqual([
      { id: 20, info: { width: 700, height: 420 } },
      { id: 20, info: { width: 730, height: 450 } },
    ]);
    expect(f.wins.get(20)).toMatchObject({ width: 730, height: 450 });
  });

  it("remembers the size the grip dragged to when the pop-out ends", async () => {
    const f = fakes();
    await f.controller.enter(3, 7, 640, 400);
    await f.controller.resize(3, 20, 900, 520);
    await f.controller.exit(3);
    expect(f.local.stored()[PLACEMENT_KEY]).toMatchObject({ width: 900, height: 520, requested: { width: 640, height: 400 } });
  });
});
