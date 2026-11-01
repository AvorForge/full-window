/**
 * Per-tab state that outlives a document: which fullscreen the toggle command
 * armed for the tab (docs/ARCHITECTURE.md §8). Kept in
 * chrome.storage.session so it survives the service worker being suspended;
 * forgotten when the tab closes.
 */

import type { SessionArea } from "./popOut";

export const PREFER_REAL_KEY = "preferReal";

export class TabStateStore {
  constructor(private readonly session: SessionArea) {}

  private async all(): Promise<Record<string, true>> {
    const stored = (await this.session.get(PREFER_REAL_KEY)) as Record<string, unknown>;
    const value = stored[PREFER_REAL_KEY];
    return typeof value === "object" && value !== null ? { ...(value as Record<string, true>) } : {};
  }

  /** True when the next fullscreen request in the tab should reach the real API. */
  async preferReal(tabId: number): Promise<boolean> {
    return (await this.all())[String(tabId)] === true;
  }

  async setPreferReal(tabId: number, preferReal: boolean): Promise<void> {
    const all = await this.all();
    if (preferReal) all[String(tabId)] = true;
    else delete all[String(tabId)];
    await this.session.set({ [PREFER_REAL_KEY]: all });
  }

  async forget(tabId: number): Promise<void> {
    if (await this.preferReal(tabId)) await this.setPreferReal(tabId, false);
  }
}
