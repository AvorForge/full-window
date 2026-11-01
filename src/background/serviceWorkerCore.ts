/**
 * Service worker logic (docs/ARCHITECTURE.md §5, §8), with the chrome.* APIs
 * passed in so it can be unit tested: settings migration on install, the
 * toggle command, pop-out mode, browser fullscreen for the toggle, the
 * per-tab armed mode, giving the window back when the owner tab goes
 * away, navigates or is no longer shown, and the per-tab ON/OFF toolbar icon.
 */

import {
  POP_OUT_TITLE_MAX,
  POP_OUT_URL_MAX,
  TOGGLE_COMMAND,
  isToServiceWorker,
  type ContentReplies,
  type ServiceWorkerReplies,
  type ToContent,
  type ToServiceWorker,
} from "../shared/messages";
import { WINDOW_LIMITS } from "../shared/settings";
import { ensureMigrated, type StorageArea } from "../shared/settingsStore";
import { BrowserFullscreenController } from "./browserFullscreen";
import { TabStateStore } from "./tabState";
import { PLACEHOLDER_PAGE, PopOutController, type SessionArea } from "./popOut";

export { TOGGLE_COMMAND };

/**
 * Toolbar icons, from the extension root. The leading "/" matters: setIcon resolves a relative path against the
 * worker's own folder (background/), where it fails to load. OFF is also the manifest's action.default_icon:
 * Chromium shows it wherever the extension does not run (browser pages, the stores) and after every navigation
 * until the new page reports its site's state.
 */
export const ACTION_ICONS = {
  on: { 16: "/icons/icon-16.png", 32: "/icons/icon-32.png" },
  off: { 16: "/icons/icon-off-16.png", 32: "/icons/icon-off-32.png" },
} as const;

/** How many times showSiteState re-checks a tab's top document after correcting its icon. */
const SITE_STATE_RECHECKS = 2;

export interface BackgroundApi {
  runtime: Pick<typeof chrome.runtime, "id" | "onInstalled" | "onMessage">;
  commands: Pick<typeof chrome.commands, "onCommand">;
  tabs: Pick<
    typeof chrome.tabs,
    "sendMessage" | "query" | "get" | "move" | "update" | "create" | "remove" | "onRemoved" | "onUpdated" | "onActivated"
  >;
  action: Pick<typeof chrome.action, "setIcon">;
  windows: Pick<typeof chrome.windows, "get" | "update" | "create" | "onRemoved">;
  storage: { sync: StorageArea; session: SessionArea; local: SessionArea };
}

export interface BackgroundControllers {
  popOut: PopOutController;
  browserFullscreen: BrowserFullscreenController;
  tabState: TabStateStore;
  /** Restores everything `tabId` changed on its window; `notify` tells the tab's top frame. */
  release(tabId: number, notify: boolean): Promise<void>;
}

function clampWindowSize(value: number): number {
  return Math.min(WINDOW_LIMITS.max, Math.max(WINDOW_LIMITS.min, Math.round(value)));
}

export function registerServiceWorker(api: BackgroundApi): BackgroundControllers {
  const popOut = new PopOutController(api.windows, api.tabs, api.storage.session, api.storage.local);
  const browserFullscreen = new BrowserFullscreenController(api.windows, api.storage.session);
  const tabState = new TabStateStore(api.storage.session);
  /** The placeholder page's URL, without its query: chrome-extension://<id>/ui/poppedOut.html. */
  const placeholderOrigin = `chrome-extension://${api.runtime.id}${PLACEHOLDER_PAGE}`;

  api.runtime.onInstalled.addListener(() => {
    void ensureMigrated(api.storage.sync).then((result) => {
      for (const warning of result.warnings) console.warn("[custom-full-screen] settings:", warning);
    });
  });

  /** frameId 0: the top frame only; omitted: every frame of the tab. */
  const sendToTab = (tabId: number, message: ToContent, frameId?: number): void => {
    const sent = frameId === undefined ? api.tabs.sendMessage(tabId, message) : api.tabs.sendMessage(tabId, message, { frameId });
    // The tab may have no content script (chrome:// pages, Web Store); ignore that.
    void Promise.resolve(sent).catch(() => undefined);
  };

  /**
   * Shows the ON or OFF icon for the tab, then asks the tab's top document for its state: a report can cross a
   * navigation (sent by the old page, applied after Chromium reset the icon for the new one), and a page the
   * extension does not run on never reports. No answer means no content script there: OFF. A top frame whose
   * settings have not loaded answers null and reports when they have.
   */
  async function showSiteState(tabId: number, enabled: boolean, rechecks = SITE_STATE_RECHECKS): Promise<void> {
    try {
      await api.action.setIcon({ tabId, path: enabled ? ACTION_ICONS.on : ACTION_ICONS.off });
    } catch {
      return; // the tab has closed
    }
    let current: boolean | null;
    try {
      const reply = (await api.tabs.sendMessage(tabId, { type: "get-site-state" } satisfies ToContent, { frameId: 0 })) as
        | ContentReplies["get-site-state"]
        | undefined;
      current = typeof reply?.enabled === "boolean" ? reply.enabled : null;
    } catch {
      current = false;
    }
    if (current !== null && current !== enabled && rechecks > 0) await showSiteState(tabId, current, rechecks - 1);
  }

  api.commands.onCommand.addListener((command, tab) => {
    if (command !== TOGGLE_COMMAND) return;
    if (tab?.id !== undefined) {
      sendToTab(tab.id, { type: "command-toggle" }, 0);
      return;
    }
    void api.tabs.query({ active: true, lastFocusedWindow: true }).then(([active]) => {
      if (active?.id !== undefined) sendToTab(active.id, { type: "command-toggle" }, 0);
    });
  });

  async function handle(
    message: ToServiceWorker,
    sender: chrome.runtime.MessageSender,
  ): Promise<ServiceWorkerReplies[ToServiceWorker["type"]]> {
    // Window and tab come from the sender, never from the message body.
    const tab = sender.tab;
    if (tab?.id === undefined || tab.windowId === undefined) return { ok: false, error: "no sender tab" };
    try {
      switch (message.type) {
        case "pop-out-enter": {
          const width = clampWindowSize(message.width);
          const height = clampWindowSize(message.height);
          const page = {
            title: (message.title ?? "").slice(0, POP_OUT_TITLE_MAX),
            // The top frame's own URL as Chromium reports it, else the one the page sent.
            url: (sender.frameId === 0 && sender.url ? sender.url : message.url ?? "").slice(0, POP_OUT_URL_MAX) || null,
          };
          return { ok: true, bounds: await popOut.enter(tab.id, tab.windowId, width, height, page) };
        }
        case "pop-out-exit":
          return { ok: true, restored: await popOut.exit(tab.id) };
        // The hover bar and the corner grip act on the sender tab's own popup window only, from its top frame.
        case "pop-out-window":
          if (sender.frameId !== 0) return { ok: false, error: "not the tab's top frame" };
          return { ok: true, state: await popOut.windowAction(tab.id, tab.windowId, message.action) };
        case "pop-out-resize":
          if (sender.frameId !== 0) return { ok: false, error: "not the tab's top frame" };
          await popOut.resize(tab.id, tab.windowId, message.width, message.height);
          return { ok: true };
        case "pop-out-return":
          return { ok: true, returned: await returnFromPlaceholder(tab.id, sender) };
        case "pop-out-activity": {
          // Any frame of a popped-out tab, in its popup window: the top frame shows the hover bar.
          const record = await popOut.recordForTab(tab.id);
          if (!record || record.popupWindowId !== tab.windowId) return { ok: false, error: "not a popped-out tab" };
          sendToTab(tab.id, { type: "pop-out-activity", corner: message.corner === true }, 0);
          return { ok: true };
        }
        case "browser-fullscreen-enter":
          return { ok: true, state: await browserFullscreen.enter(tab.id, tab.windowId) };
        case "browser-fullscreen-exit":
          return { ok: true, restored: await browserFullscreen.exit(tab.id) };
        case "tab-state":
          return { ok: true, preferReal: await tabState.preferReal(tab.id) };
        case "set-prefer-real":
          await tabState.setPreferReal(tab.id, message.preferReal);
          sendToTab(tab.id, { type: "prefer-real-changed", preferReal: message.preferReal });
          return { ok: true, preferReal: message.preferReal };
        case "site-state":
          // Only the document the tab shows: its top frame, not a subframe or a prerendering page.
          if (sender.frameId !== 0 || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")) {
            return { ok: false, error: "not the tab's top frame" };
          }
          // Before any await, so the tab's reports are applied in the order they arrive.
          void showSiteState(tab.id, message.enabled);
          return { ok: true };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * "Bring it back" on the placeholder page `placeholderId`: the popped-out tab leaves fake fullscreen as with
   * Esc, and so pops back in; a tab that is not in fake fullscreen (or does not answer) is put back from here.
   */
  async function returnFromPlaceholder(placeholderId: number, sender: chrome.runtime.MessageSender): Promise<boolean> {
    // Only the extension's own placeholder page, in the tab the pop-out recorded.
    if (sender.frameId !== 0 || !sender.url?.startsWith(placeholderOrigin)) throw new Error("not the placeholder page");
    const record = await popOut.recordForPlaceholder(placeholderId);
    if (!record) throw new Error("not a placeholder");
    const reply = (await Promise.resolve(api.tabs.sendMessage(record.tabId, { type: "pop-out-leave" } satisfies ToContent, { frameId: 0 })).catch(
      () => undefined,
    )) as ContentReplies["pop-out-leave"] | undefined;
    if (reply?.handled) return true;
    await release(record.tabId, true);
    return true;
  }

  api.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== api.runtime.id || !isToServiceWorker(message)) return false;
    void handle(message, sender).then(sendResponse);
    return true; // async response
  });

  async function release(tabId: number, notify: boolean): Promise<void> {
    // Leave browser fullscreen first, so the pop-out window's normal bounds are the ones remembered.
    const leftFullscreen = await browserFullscreen.exit(tabId).catch(() => false);
    const restored = await popOut.exit(tabId).catch(() => false);
    if (!notify) return;
    if (leftFullscreen) sendToTab(tabId, { type: "browser-fullscreen-released" }, 0);
    if (restored) sendToTab(tabId, { type: "pop-out-released" }, 0);
  }

  const forgetWindow = (windowId: number): void => {
    void browserFullscreen.forgetWindow(windowId);
  };

  api.tabs.onRemoved.addListener((tabId, info) => {
    void tabState.forget(tabId);
    // A popped-out tab that closes (its pop-out window was closed) comes back as its placeholder, reloaded; a
    // closed placeholder is just forgotten. Then nothing is left to put back.
    void popOut.tabClosed(tabId).then(() => {
      if (info.isWindowClosing) forgetWindow(info.windowId);
      else void release(tabId, false);
    });
  });

  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") void release(tabId, false);
  });

  api.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void (async () => {
      const owners = new Set<number>();
      // A pop-out is alone in its window, so switching tabs elsewhere never touches it.
      const record = await browserFullscreen.recordForWindow(windowId);
      if (record && record.tabId !== tabId) owners.add(record.tabId);
      for (const owner of owners) await release(owner, true);
    })();
  });

  api.windows.onRemoved.addListener((windowId) => {
    forgetWindow(windowId);
    void popOut.windowClosed(windowId);
  });

  return { popOut, browserFullscreen, tabState, release };
}
