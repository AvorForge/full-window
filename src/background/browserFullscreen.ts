/**
 * Browser fullscreen for the toggle command (docs/ARCHITECTURE.md §8).
 *
 * A chrome.commands shortcut gives the page no user activation, so the
 * toggle cannot call the real element.requestFullscreen(). Instead the
 * window goes fullscreen like F11 (chrome.windows.update) while the content
 * script pins the element to fill the tab. The previous window state is kept
 * in chrome.storage.session, one record per window, like pop-out mode.
 */

import type { WindowBounds } from "../shared/messages";
import type { SessionArea, WindowsApi } from "./popOut";

export const BROWSER_FULLSCREEN_KEY = "browserFullscreen";

export interface BrowserFullscreenRecord {
  windowId: number;
  tabId: number;
  previousState: WindowBounds["state"];
}

type Records = Record<string, BrowserFullscreenRecord>;

export class BrowserFullscreenController {
  constructor(
    private readonly windows: WindowsApi,
    private readonly session: SessionArea,
  ) {}

  private async records(): Promise<Records> {
    const stored = (await this.session.get(BROWSER_FULLSCREEN_KEY)) as Record<string, unknown>;
    const value = stored[BROWSER_FULLSCREEN_KEY];
    return typeof value === "object" && value !== null ? (value as Records) : {};
  }

  private async save(records: Records): Promise<void> {
    await this.session.set({ [BROWSER_FULLSCREEN_KEY]: records });
  }

  async recordForTab(tabId: number): Promise<BrowserFullscreenRecord | undefined> {
    return Object.values(await this.records()).find((record) => record.tabId === tabId);
  }

  async recordForWindow(windowId: number): Promise<BrowserFullscreenRecord | undefined> {
    return (await this.records())[String(windowId)];
  }

  /** Makes `windowId` fullscreen on behalf of `tabId`, remembering its state; returns the new state. */
  async enter(tabId: number, windowId: number): Promise<WindowBounds["state"]> {
    const records = await this.records();
    const key = String(windowId);
    const existing = records[key];
    if (existing) {
      existing.tabId = tabId;
    } else {
      const current = await this.windows.get(windowId);
      records[key] = { windowId, tabId, previousState: current.state ?? "normal" };
    }
    await this.save(records);
    const updated = await this.windows.update(windowId, { state: "fullscreen" });
    return updated.state ?? "fullscreen";
  }

  /** Restores the state of the window `tabId` made fullscreen. Returns false if it made none. */
  async exit(tabId: number): Promise<boolean> {
    const record = await this.recordForTab(tabId);
    if (!record) return false;
    const records = await this.records();
    delete records[String(record.windowId)];
    await this.save(records);
    const previous = record.previousState;
    // Already fullscreen before (the user pressed F11): leave it. Leaving "fullscreen" for "normal"
    // returns to the normal bounds Chromium kept, including a pop-out window.
    if (previous !== "fullscreen" && previous !== "locked-fullscreen") {
      await this.windows.update(record.windowId, { state: previous === "minimized" ? "normal" : previous });
    }
    return true;
  }

  /** Window closed: nothing to restore, just forget it. */
  async forgetWindow(windowId: number): Promise<void> {
    const records = await this.records();
    if (!(String(windowId) in records)) return;
    delete records[String(windowId)];
    await this.save(records);
  }
}
