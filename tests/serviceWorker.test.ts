import { describe, expect, it } from "vitest";
import { BROWSER_FULLSCREEN_KEY, BrowserFullscreenController } from "../src/background/browserFullscreen";
import { ACTION_ICONS, registerServiceWorker, type BackgroundApi } from "../src/background/serviceWorkerCore";
import { PREFER_REAL_KEY } from "../src/background/tabState";
import { PLACEMENT_KEY, SESSION_KEY, type SessionArea, type WindowsApi } from "../src/background/popOut";
import { TOGGLE_COMMAND, type ToContent } from "../src/shared/messages";
import { SETTINGS_KEY } from "../src/shared/settings";

type Listener = (...args: never[]) => unknown;

function event() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (listener: Listener) => void listeners.push(listener),
    fire: (...args: unknown[]) => listeners.map((listener) => (listener as (...a: unknown[]) => unknown)(...args)),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake chrome.* with one window (7) holding tabs 3 (index 0) and 4 (index 1). */
function fakeChrome(initialState: chrome.windows.Window["state"] = "normal") {
  let win = { id: 7, left: 10, top: 20, width: 1500, height: 1000, state: initialState } as chrome.windows.Window;
  /** Window 7's updates. */
  const updates: chrome.windows.UpdateInfo[] = [];
  /** Windows the extension created (pop-outs), and where tabs were moved. */
  const created: chrome.windows.CreateData[] = [];
  const popups = new Map<number, chrome.windows.Window>();
  const moves: Array<{ tabId: number; windowId: number; index: number }> = [];
  const tabWindow = new Map<number, number>([
    [3, 7],
    [4, 7],
  ]);
  let local: Record<string, unknown> = {};
  const toTabs: Array<{ tabId: number; message: ToContent; options?: { frameId?: number } }> = [];
  /** Placeholder tabs the extension opened (from 50 up), where they are, and what they were navigated to. */
  const placeholders = new Map<number, { windowId: number; index: number; url: string }>();
  const tabsCreated: chrome.tabs.CreateProperties[] = [];
  const tabsRemoved: number[] = [];
  const navigated: Array<{ tabId: number; url: string }> = [];
  const popupUpdates: Array<{ id: number; info: chrome.windows.UpdateInfo }> = [];
  /** What a tab's top frame answers to pop-out-leave (no entry: no answer). */
  const leaveReplies = new Map<number, { handled: boolean }>();
  /** The toolbar icons set per tab (the 16 px path). */
  const icons: Array<{ tabId: number; icon: string }> = [];
  const closedTabs = new Set<number>();
  /** What each tab's top frame answers to get-site-state; no entry: no content script there (a browser page). */
  const topFrames = new Map<number, boolean | null>();
  let session: Record<string, unknown> = {};
  let sync: Record<string, unknown> = {};
  const events = {
    installed: event(),
    message: event(),
    command: event(),
    removed: event(),
    updated: event(),
    activated: event(),
    windowRemoved: event(),
  };
  const area = (get: () => Record<string, unknown>, set: (next: Record<string, unknown>) => void) => ({
    get: async (keys?: string | null) => {
      const all = structuredClone(get());
      return typeof keys === "string" ? (keys in all ? { [keys]: all[keys] } : {}) : all;
    },
    set: async (items: Record<string, unknown>) => set({ ...get(), ...structuredClone(items) }),
    remove: async (keys: string | string[]) => {
      const next = { ...get() };
      for (const key of Array.isArray(keys) ? keys : [keys]) delete next[key];
      set(next);
    },
  });
  const api = {
    runtime: { id: "extension-id", onInstalled: events.installed, onMessage: events.message },
    commands: { onCommand: events.command },
    tabs: {
      sendMessage: async (tabId: number, message: ToContent, options?: { frameId?: number }) => {
        toTabs.push(options ? { tabId, message, options } : { tabId, message });
        if (message.type === "pop-out-leave") return leaveReplies.get(tabId);
        if (message.type !== "get-site-state") return undefined;
        if (closedTabs.has(tabId) || !topFrames.has(tabId)) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { enabled: topFrames.get(tabId) };
      },
      query: async () => [{ id: 4, windowId: 7 }],
      get: async (tabId: number) => {
        const placeholder = placeholders.get(tabId);
        if (placeholder) return { id: tabId, ...placeholder } as chrome.tabs.Tab;
        if (!tabWindow.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        return { id: tabId, windowId: tabWindow.get(tabId), index: tabId === 3 ? 0 : 1 } as chrome.tabs.Tab;
      },
      create: async (props: chrome.tabs.CreateProperties) => {
        tabsCreated.push(props);
        const id = 50 + tabsCreated.length - 1;
        placeholders.set(id, { windowId: props.windowId!, index: props.index!, url: props.url! });
        return { id, windowId: props.windowId, index: props.index } as chrome.tabs.Tab;
      },
      remove: async (tabId: number) => {
        if (!placeholders.delete(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        tabsRemoved.push(tabId);
      },
      move: async (tabId: number, props: { windowId: number; index: number }) => {
        if (props.windowId !== 7) throw new Error(`No window with id: ${props.windowId}.`);
        moves.push({ tabId, ...props });
        const from = tabWindow.get(tabId)!;
        tabWindow.set(tabId, props.windowId);
        popups.delete(from);
        return { id: tabId } as chrome.tabs.Tab;
      },
      update: async (tabId: number, props: chrome.tabs.UpdateProperties) => {
        if (props.url !== undefined) {
          if (!placeholders.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
          navigated.push({ tabId, url: props.url });
        }
        return { id: tabId } as chrome.tabs.Tab;
      },
      onRemoved: events.removed,
      onUpdated: events.updated,
      onActivated: events.activated,
    },
    action: {
      setIcon: async ({ tabId, path }: { tabId: number; path: Record<number, string> }) => {
        if (closedTabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        icons.push({ tabId, icon: path[16] ?? "" });
      },
    },
    windows: {
      get: async (id: number) => {
        if (id === 7) return { ...win };
        const popup = popups.get(id);
        if (!popup) throw new Error(`No window with id: ${id}.`);
        return { ...popup };
      },
      update: async (id: number, info: chrome.windows.UpdateInfo) => {
        if (id !== 7) {
          popupUpdates.push({ id, info });
          if (!popups.has(id)) throw new Error(`No window with id: ${id}.`);
          popups.set(id, { ...popups.get(id)!, ...info } as chrome.windows.Window);
          return { ...popups.get(id)! };
        }
        if (Object.keys(info).length === 1 && info.focused) return { ...win }; // focusing it back is not a change
        updates.push(info);
        win = { ...win, ...info } as chrome.windows.Window;
        return { ...win };
      },
      create: async (data: chrome.windows.CreateData) => {
        created.push(data);
        const id = 20 + created.length - 1;
        const popup = { id, left: data.left ?? 0, top: data.top ?? 0, width: data.width ?? 0, height: data.height ?? 0, state: "normal" } as chrome.windows.Window;
        popups.set(id, popup);
        if (typeof data.tabId === "number") {
          // The tabs after it in its old window move left (the placeholder takes its index).
          const from = tabWindow.get(data.tabId);
          const index = data.tabId === 3 ? 0 : 1;
          for (const placeholder of placeholders.values()) if (placeholder.windowId === from && placeholder.index > index) placeholder.index--;
          tabWindow.set(data.tabId, id);
        }
        return { ...popup };
      },
      onRemoved: events.windowRemoved,
    },
    storage: {
      session: area(
        () => session,
        (next) => (session = next),
      ),
      sync: area(
        () => sync,
        (next) => (sync = next),
      ),
      local: area(
        () => local,
        (next) => (local = next),
      ),
    },
  };
  const controllers = registerServiceWorker(api as unknown as BackgroundApi);
  /** Sends a runtime message as `sender` and resolves with the response. */
  const send = (message: unknown, sender: Partial<chrome.runtime.MessageSender> = { id: "extension-id", tab: { id: 3, windowId: 7 } as chrome.tabs.Tab }) =>
    new Promise<unknown>((resolve) => {
      const [keepOpen] = events.message.fire(message, sender, resolve);
      if (keepOpen !== true) resolve("no response");
    });
  return {
    api,
    events,
    controllers,
    send,
    updates,
    toTabs,
    icons,
    closedTabs,
    topFrames,
    created,
    moves,
    popups,
    placeholders,
    tabsCreated,
    tabsRemoved,
    navigated,
    popupUpdates,
    leaveReplies,
    tabWindow: (tabId: number) => tabWindow.get(tabId),
    window: () => win,
    session: () => session,
    sync: () => sync,
    local: () => local,
  };
}

describe("service worker", () => {
  it("sends the toggle command to the top frame of the command's tab, or of the active tab", async () => {
    const f = fakeChrome();
    f.events.command.fire(TOGGLE_COMMAND, { id: 3 });
    f.events.command.fire("some-other-command", { id: 3 });
    f.events.command.fire(TOGGLE_COMMAND, undefined);
    await flush();
    expect(f.toTabs).toEqual([
      { tabId: 3, message: { type: "command-toggle" }, options: { frameId: 0 } },
      { tabId: 4, message: { type: "command-toggle" }, options: { frameId: 0 } },
    ]);
  });

  it("migrates the stored settings on install", async () => {
    const f = fakeChrome();
    f.events.installed.fire({ reason: "install" });
    await flush();
    expect(f.sync()[SETTINGS_KEY]).toMatchObject({ version: 1 });
  });

  it("pops the sender tab out into its own window (size clamped) and puts it back; ignores other extensions and senders without a tab", async () => {
    const f = fakeChrome();
    expect(await f.send({ type: "pop-out-enter", width: 1600.4, height: 50 })).toMatchObject({ ok: true, bounds: { width: 1600, height: 100 } });
    expect(f.created).toEqual([{ tabId: 3, type: "popup", focused: true, left: 10 + 1500 - 1600 - 24, top: 20 + 1000 - 100 - 24, width: 1600, height: 100 }]);
    expect(f.tabWindow(3)).toBe(20);
    expect(f.session()[SESSION_KEY]).toEqual({
      "3": {
        tabId: 3,
        fromWindowId: 7,
        index: 0,
        fromBounds: { left: 10, top: 20, width: 1500, height: 1000, state: "normal" },
        popupWindowId: 20,
        requested: { width: 1600, height: 100 },
        placeholderTabId: 50,
        url: null,
      },
    });
    // Opened just before the tab before it leaves, so the window stays open and the placeholder has its index.
    expect(f.tabsCreated).toEqual([{ windowId: 7, index: 0, active: false, url: "/ui/poppedOut.html?title=" }]);
    expect(f.placeholders.get(50)).toMatchObject({ windowId: 7, index: 0 });
    expect(await f.send({ type: "pop-out-exit" })).toEqual({ ok: true, restored: true });
    expect(f.moves).toEqual([{ tabId: 3, windowId: 7, index: 0 }]);
    expect(f.tabsRemoved).toEqual([50]);
    expect(f.local()[PLACEMENT_KEY]).toMatchObject({ width: 1600, height: 100 });
    // The browser window itself is never resized.
    expect(f.updates).toEqual([]);

    expect(await f.send({ type: "pop-out-enter", width: 800, height: 600 }, { id: "other-extension", tab: { id: 3, windowId: 7 } as chrome.tabs.Tab })).toBe("no response");
    expect(await f.send({ type: "pop-out-enter", width: "800", height: 600 })).toBe("no response");
    expect(await f.send({ type: "pop-out-enter", width: 800, height: 600 }, { id: "extension-id" })).toEqual({ ok: false, error: "no sender tab" });
    expect(f.created).toHaveLength(1);
  });

  it("makes the window browser-fullscreen for the toggle and restores its state", async () => {
    const f = fakeChrome("maximized");
    expect(await f.send({ type: "browser-fullscreen-enter" })).toEqual({ ok: true, state: "fullscreen" });
    expect(f.session()[BROWSER_FULLSCREEN_KEY]).toEqual({ "7": { windowId: 7, tabId: 3, previousState: "maximized" } });
    expect(await f.send({ type: "browser-fullscreen-exit" })).toEqual({ ok: true, restored: true });
    expect(f.updates).toEqual([{ state: "fullscreen" }, { state: "maximized" }]);
    expect(await f.send({ type: "browser-fullscreen-exit" })).toEqual({ ok: true, restored: false });
  });

  it("keeps the armed mode per tab, broadcasts changes to every frame of the tab and forgets it when the tab closes", async () => {
    const f = fakeChrome();
    expect(await f.send({ type: "tab-state" })).toEqual({ ok: true, preferReal: false });
    expect(await f.send({ type: "set-prefer-real", preferReal: true })).toEqual({ ok: true, preferReal: true });
    expect(f.toTabs).toEqual([{ tabId: 3, message: { type: "prefer-real-changed", preferReal: true } }]);
    expect(await f.send({ type: "tab-state" })).toEqual({ ok: true, preferReal: true });
    expect(await f.send({ type: "tab-state" }, { id: "extension-id", tab: { id: 4, windowId: 7 } as chrome.tabs.Tab })).toEqual({ ok: true, preferReal: false });
    f.events.removed.fire(3, { windowId: 7, isWindowClosing: false });
    await flush();
    expect(f.session()[PREFER_REAL_KEY]).toEqual({});
  });

  it("puts a popped-out tab back and leaves browser fullscreen when it navigates, without notifying it", async () => {
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    await f.send({ type: "browser-fullscreen-enter" });
    f.events.updated.fire(3, { status: "complete" });
    f.events.updated.fire(3, { status: "loading" });
    for (let i = 0; i < 4; i++) await flush();
    expect(f.moves).toEqual([{ tabId: 3, windowId: 7, index: 0 }]);
    expect(f.updates).toEqual([{ state: "fullscreen" }, { state: "normal" }]);
    expect(f.session()[SESSION_KEY]).toEqual({});
    expect(f.toTabs).toEqual([]);
  });

  it("forgets a popped-out tab whose pop-out window was closed: nothing to put back (no page URL to load)", async () => {
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    f.events.removed.fire(3, { windowId: 20, isWindowClosing: true });
    f.events.windowRemoved.fire(20);
    for (let i = 0; i < 4; i++) await flush();
    expect(f.session()[SESSION_KEY]).toEqual({});
    expect(f.moves).toEqual([]);
    expect(f.created).toHaveLength(1);
  });

  it("when another tab is activated, leaves browser fullscreen and tells the owner's top frame; a pop-out stays out", async () => {
    const f = fakeChrome();
    await f.send({ type: "browser-fullscreen-enter" });
    await f.send({ type: "pop-out-enter", width: 800, height: 600 }, { id: "extension-id", tab: { id: 4, windowId: 7 } as chrome.tabs.Tab });
    f.events.activated.fire({ tabId: 3, windowId: 7 }); // the owner itself: nothing to do
    await flush();
    expect(f.toTabs).toEqual([]);
    f.events.activated.fire({ tabId: 4, windowId: 7 });
    for (let i = 0; i < 4; i++) await flush();
    expect(f.window()).toMatchObject({ state: "normal" });
    expect(f.toTabs).toEqual([{ tabId: 3, message: { type: "browser-fullscreen-released" }, options: { frameId: 0 } }]);
    expect(f.moves).toEqual([]);
    expect(f.tabWindow(4)).toBe(20);
  });

  it("passes the page's title and the top frame's URL to the placeholder, which turns back into the page if the popup is closed", async () => {
    const f = fakeChrome();
    const sender = { id: "extension-id", tab: { id: 3, windowId: 7 } as chrome.tabs.Tab, frameId: 0, url: "https://video.example/watch" };
    await f.send({ type: "pop-out-enter", width: 800, height: 600, title: "Demo", url: "https://spoofed.example/" }, sender);
    expect(f.tabsCreated[0]?.url).toBe("/ui/poppedOut.html?title=Demo&url=https%3A%2F%2Fvideo.example%2Fwatch");
    // The popup window's X: its tab closes, then the window.
    f.events.removed.fire(3, { windowId: 20, isWindowClosing: true });
    f.events.windowRemoved.fire(20);
    for (let i = 0; i < 6; i++) await flush();
    expect(f.navigated).toEqual([{ tabId: 50, url: "https://video.example/watch" }]);
    expect(f.session()[SESSION_KEY]).toEqual({});
    expect(f.moves).toEqual([]);
  });

  it("closing the placeholder does nothing to the pop-out; the tab still comes back where it came from", async () => {
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    f.placeholders.delete(50);
    f.events.removed.fire(50, { windowId: 7, isWindowClosing: false });
    for (let i = 0; i < 4; i++) await flush();
    expect(f.tabWindow(3)).toBe(20);
    expect(f.session()[SESSION_KEY]).toMatchObject({ "3": { popupWindowId: 20, placeholderTabId: null } });
    expect(await f.send({ type: "pop-out-exit" })).toEqual({ ok: true, restored: true });
    expect(f.moves).toEqual([{ tabId: 3, windowId: 7, index: 0 }]);
  });

  it("acts on the popup window of the sender's own popped-out tab only, from its top frame", async () => {
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    const inPopup = (tabId = 3, windowId = 20, frameId = 0) => ({ id: "extension-id", tab: { id: tabId, windowId } as chrome.tabs.Tab, frameId });
    const before = f.popupUpdates.length;
    expect(await f.send({ type: "pop-out-window", action: "fullscreen" }, inPopup())).toEqual({ ok: true, state: "fullscreen" });
    expect(await f.send({ type: "pop-out-window", action: "normal" }, inPopup())).toEqual({ ok: true, state: "normal" });
    expect(await f.send({ type: "pop-out-window", action: "minimized" }, inPopup())).toEqual({ ok: true, state: "minimized" });
    expect(await f.send({ type: "pop-out-resize", width: 100, height: 900.2 }, inPopup())).toEqual({ ok: true });
    expect(f.popupUpdates.slice(before)).toEqual([
      { id: 20, info: { state: "fullscreen" } },
      { id: 20, info: { state: "normal", focused: true } },
      { id: 20, info: { state: "minimized" } },
      { id: 20, info: { width: 320, height: 900 } },
    ]);
    const refused = { ok: false, error: "not a popped-out tab" };
    // Another tab, the popped-out tab claiming another window, a subframe, other extensions, bad actions.
    expect(await f.send({ type: "pop-out-window", action: "minimized" }, inPopup(4, 20))).toEqual(refused);
    expect(await f.send({ type: "pop-out-resize", width: 800, height: 600 }, inPopup(4, 7))).toEqual(refused);
    expect(await f.send({ type: "pop-out-window", action: "minimized" }, inPopup(3, 7))).toEqual(refused);
    expect(await f.send({ type: "pop-out-window", action: "minimized" }, inPopup(3, 20, 2))).toEqual({ ok: false, error: "not the tab's top frame" });
    expect(await f.send({ type: "pop-out-resize", width: 800, height: 600 }, inPopup(3, 20, 2))).toEqual({ ok: false, error: "not the tab's top frame" });
    expect(await f.send({ type: "pop-out-window", action: "minimized" }, { ...inPopup(), id: "other-extension" })).toBe("no response");
    expect(await f.send({ type: "pop-out-window", action: "maximized" }, inPopup())).toBe("no response");
    expect(await f.send({ type: "pop-out-resize", width: "800", height: 600 }, inPopup())).toBe("no response");
    expect(f.popupUpdates).toHaveLength(before + 4);
  });

  it("relays pointer activity in a popped-out tab's frames to its top frame, with the corner zone, and nothing from other tabs", async () => {
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    expect(await f.send({ type: "pop-out-activity" }, { id: "extension-id", tab: { id: 3, windowId: 20 } as chrome.tabs.Tab, frameId: 5 })).toEqual({ ok: true });
    expect(await f.send({ type: "pop-out-activity", corner: true }, { id: "extension-id", tab: { id: 3, windowId: 20 } as chrome.tabs.Tab, frameId: 5 })).toEqual({ ok: true });
    expect(await f.send({ type: "pop-out-activity" }, { id: "extension-id", tab: { id: 4, windowId: 7 } as chrome.tabs.Tab, frameId: 5 })).toEqual({
      ok: false,
      error: "not a popped-out tab",
    });
    expect(f.toTabs).toEqual([
      { tabId: 3, message: { type: "pop-out-activity", corner: false }, options: { frameId: 0 } },
      { tabId: 3, message: { type: "pop-out-activity", corner: true }, options: { frameId: 0 } },
    ]);
  });

  it("Bring it back: the placeholder page asks the tab to leave fake fullscreen, or puts it back itself", async () => {
    const placeholder = { id: "extension-id", tab: { id: 50, windowId: 7 } as chrome.tabs.Tab, frameId: 0, url: "chrome-extension://extension-id/ui/poppedOut.html?title=x" };
    const f = fakeChrome();
    await f.send({ type: "pop-out-enter", width: 800, height: 600 });
    f.leaveReplies.set(3, { handled: true });
    expect(await f.send({ type: "pop-out-return" }, placeholder)).toEqual({ ok: true, returned: true });
    expect(f.toTabs).toEqual([{ tabId: 3, message: { type: "pop-out-leave" }, options: { frameId: 0 } }]);
    // The tab's own pop-out-exit (after leaving fake fullscreen) puts it back.
    expect(f.moves).toEqual([]);

    const g = fakeChrome();
    await g.send({ type: "pop-out-enter", width: 800, height: 600 });
    expect(await g.send({ type: "pop-out-return" }, placeholder)).toEqual({ ok: true, returned: true });
    expect(g.moves).toEqual([{ tabId: 3, windowId: 7, index: 0 }]);
    expect(g.tabsRemoved).toEqual([50]);
    expect(g.toTabs.at(-1)).toEqual({ tabId: 3, message: { type: "pop-out-released" }, options: { frameId: 0 } });

    // Only the placeholder page itself: not a web page, not another tab.
    const h = fakeChrome();
    await h.send({ type: "pop-out-enter", width: 800, height: 600 });
    expect(await h.send({ type: "pop-out-return" }, { ...placeholder, url: "https://evil.example/" })).toEqual({ ok: false, error: "not the placeholder page" });
    expect(await h.send({ type: "pop-out-return" }, { ...placeholder, tab: { id: 4, windowId: 7 } as chrome.tabs.Tab })).toEqual({ ok: false, error: "not a placeholder" });
    expect(h.moves).toEqual([]);
  });

  it("forgets the records of a closed window without touching it", async () => {
    const f = fakeChrome();
    await f.send({ type: "browser-fullscreen-enter" });
    const updates = f.updates.length;
    f.events.windowRemoved.fire(7);
    await flush();
    expect(f.session()[BROWSER_FULLSCREEN_KEY]).toEqual({});
    f.events.removed.fire(3, { windowId: 7, isWindowClosing: true });
    await flush();
    expect(f.updates).toHaveLength(updates);
  });
});

describe("toolbar icon (site-state from a tab's top frame)", () => {
  const ON = ACTION_ICONS.on[16];
  const OFF = ACTION_ICONS.off[16];
  const top = (tabId = 3): Partial<chrome.runtime.MessageSender> => ({ id: "extension-id", tab: { id: tabId, windowId: 7 } as chrome.tabs.Tab, frameId: 0 });

  it("sets the ON or OFF icon for the sender's tab, never a tab named in the message", async () => {
    const f = fakeChrome();
    f.topFrames.set(3, true);
    expect(await f.send({ type: "site-state", enabled: true }, top())).toEqual({ ok: true });
    await flush();
    expect(f.icons).toEqual([{ tabId: 3, icon: ON }]);
    f.topFrames.set(3, false);
    expect(await f.send({ type: "site-state", enabled: false, tabId: 4 }, top())).toEqual({ ok: true });
    await flush();
    expect(f.icons).toEqual([
      { tabId: 3, icon: ON },
      { tabId: 3, icon: OFF },
    ]);
    // Each report is checked with the tab's top frame only.
    expect(f.toTabs.filter((sent) => sent.message.type === "get-site-state")).toEqual([
      { tabId: 3, message: { type: "get-site-state" }, options: { frameId: 0 } },
      { tabId: 3, message: { type: "get-site-state" }, options: { frameId: 0 } },
    ]);
    expect(ACTION_ICONS).toEqual({
      on: { 16: "/icons/icon-16.png", 32: "/icons/icon-32.png" },
      off: { 16: "/icons/icon-off-16.png", 32: "/icons/icon-off-32.png" },
    });
  });

  it("ignores reports without a sender tab, from a subframe or a prerendering page, malformed or from another extension", async () => {
    const f = fakeChrome();
    f.topFrames.set(3, true);
    expect(await f.send({ type: "site-state", enabled: true }, { id: "extension-id", frameId: 0 })).toEqual({ ok: false, error: "no sender tab" });
    expect(await f.send({ type: "site-state", enabled: true }, { ...top(), frameId: 5 })).toEqual({ ok: false, error: "not the tab's top frame" });
    expect(await f.send({ type: "site-state", enabled: true }, { id: "extension-id", tab: { id: 3, windowId: 7 } as chrome.tabs.Tab })).toEqual({ ok: false, error: "not the tab's top frame" });
    expect(await f.send({ type: "site-state", enabled: true }, { ...top(), documentLifecycle: "prerender" })).toEqual({
      ok: false,
      error: "not the tab's top frame",
    });
    expect(await f.send({ type: "site-state", enabled: "yes" }, top())).toBe("no response");
    expect(await f.send({ type: "site-state" }, top())).toBe("no response");
    expect(await f.send({ type: "site-state", enabled: true }, { ...top(), id: "other-extension" })).toBe("no response");
    await flush();
    expect(f.icons).toEqual([]);
    expect(await f.send({ type: "site-state", enabled: true }, { ...top(), documentLifecycle: "active" })).toEqual({ ok: true });
    await flush();
    expect(f.icons).toEqual([{ tabId: 3, icon: ON }]);
  });

  it("corrects a report that crossed a navigation: OFF where the extension does not run, else the new page's state", async () => {
    const f = fakeChrome();
    // The old page's ON report lands after the tab moved to a browser page (no content script answers).
    await f.send({ type: "site-state", enabled: true }, top());
    await flush();
    expect(f.icons).toEqual([
      { tabId: 3, icon: ON },
      { tabId: 3, icon: OFF },
    ]);
    // An OFF report lands after the tab moved to a page whose site is on.
    f.icons.length = 0;
    f.topFrames.set(3, true);
    await f.send({ type: "site-state", enabled: false }, top());
    await flush();
    expect(f.icons).toEqual([
      { tabId: 3, icon: OFF },
      { tabId: 3, icon: ON },
    ]);
    // The new page's settings have not loaded (null): it reports itself, nothing is changed meanwhile.
    f.icons.length = 0;
    f.topFrames.set(3, null);
    await f.send({ type: "site-state", enabled: true }, top());
    await flush();
    expect(f.icons).toEqual([{ tabId: 3, icon: ON }]);
  });

  it("survives a tab that closed before its icon was set", async () => {
    const f = fakeChrome();
    f.closedTabs.add(3);
    expect(await f.send({ type: "site-state", enabled: true }, top())).toEqual({ ok: true });
    await flush();
    expect(f.icons).toEqual([]);
    f.topFrames.set(4, false);
    expect(await f.send({ type: "site-state", enabled: false }, top(4))).toEqual({ ok: true });
    await flush();
    expect(f.icons).toEqual([{ tabId: 4, icon: OFF }]);
  });

  it("follows the site's switch only: the per-tab toggle never changes the icon", async () => {
    const f = fakeChrome();
    await f.send({ type: "set-prefer-real", preferReal: true }, top());
    f.events.command.fire(TOGGLE_COMMAND, { id: 3 });
    await flush();
    expect(f.icons).toEqual([]);
  });
});

describe("BrowserFullscreenController", () => {
  function fakes(state: chrome.windows.Window["state"]) {
    let win = { id: 9, state } as chrome.windows.Window;
    const updates: chrome.windows.UpdateInfo[] = [];
    let stored: Record<string, unknown> = {};
    const windows = {
      get: async () => ({ ...win }),
      update: async (_id: number, info: chrome.windows.UpdateInfo) => {
        updates.push(info);
        win = { ...win, ...info } as chrome.windows.Window;
        return { ...win };
      },
    } as unknown as WindowsApi;
    const session = {
      get: async () => structuredClone(stored),
      set: async (items: Record<string, unknown>) => {
        stored = { ...stored, ...structuredClone(items) };
      },
    } as unknown as SessionArea;
    return { controller: new BrowserFullscreenController(windows, session), updates };
  }

  it("leaves a window that was already fullscreen (F11) as it is, and hands the record to the last tab", async () => {
    const f = fakes("fullscreen");
    await f.controller.enter(1, 9);
    await f.controller.enter(2, 9);
    expect(await f.controller.exit(1)).toBe(false);
    expect(await f.controller.exit(2)).toBe(true);
    expect(f.updates).toEqual([{ state: "fullscreen" }, { state: "fullscreen" }]);
  });
});
