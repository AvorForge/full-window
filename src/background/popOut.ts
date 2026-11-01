/**
 * Pop-out mode (docs/ARCHITECTURE.md §5): move the tab into its own small popup
 * window (no tab strip, no toolbar) while its video is in fullscreen, and put it
 * back where it was afterwards. A placeholder tab (ui/poppedOut.html) holds its
 * place meanwhile: the tab comes back wherever the placeholder is then, and if
 * the popup window is closed the placeholder turns back into the page. The rest
 * of the browser is never touched.
 *
 * Records live in chrome.storage.session so they survive the service worker
 * being suspended between enter and exit, one per popped-out tab. Where the
 * user last left the pop-out window (and its size) is kept in
 * chrome.storage.local, so the next pop-out opens there.
 */

import { POP_OUT_MIN_SIZE, type PopOutWindowAction, type WindowBounds } from "../shared/messages";
import { WINDOW_LIMITS } from "../shared/settings";

export type WindowsApi = Pick<typeof chrome.windows, "get" | "update">;
export type PopOutWindowsApi = Pick<typeof chrome.windows, "get" | "update" | "create">;
export type PopOutTabsApi = Pick<typeof chrome.tabs, "get" | "move" | "update" | "create" | "remove">;
export type SessionArea = Pick<chrome.storage.StorageArea, "get" | "set">;

export interface PopOutRecord {
  tabId: number;
  /** The window the tab came from, and its place there. */
  fromWindowId: number;
  index: number;
  /**
   * That window's bounds and state. A tab that was its window's only tab closes the window when it leaves; on
   * the way back a new window opens with these.
   */
  fromBounds: WindowBounds;
  /** The popup window; null while it is being created. */
  popupWindowId: number | null;
  /** The size the settings asked for (outer px). */
  requested: { width: number; height: number };
  /** The placeholder tab left in the tab's place; null while it is being created, or once the user closed it. */
  placeholderTabId: number | null;
  /** The page's URL (http, https or file), to load in the placeholder if the popup window is closed. */
  url: string | null;
}

/** What the page told us about itself (see "pop-out-enter"). */
export interface PopOutPage {
  title: string;
  url: string | null;
}

/** Where the last pop-out window was when it closed, and the requested size it started from. */
export interface PopOutPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  requested: { width: number; height: number };
}

export const SESSION_KEY = "popOut";
export const PLACEMENT_KEY = "popOutPlacement";
/** Gap between a first pop-out and the corner of the window it came from. */
export const CORNER_GAP = 24;
/** The placeholder page, from the extension root (a relative URL would resolve against background/). */
export const PLACEHOLDER_PAGE = "/ui/poppedOut.html";

/** The placeholder's URL: the page's title and URL go in the query, for its tab title. */
export function placeholderUrl(page: PopOutPage): string {
  const query = new URLSearchParams({ title: page.title });
  if (page.url) query.set("url", page.url);
  return `${PLACEHOLDER_PAGE}?${query}`;
}

/** Only a web or file page goes back into the placeholder; anything else (about:, data:, javascript:...) does not. */
export function restorableUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The corner grip's size, kept within the minimum and the setting's maximum. */
export function clampPopOutSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(WINDOW_LIMITS.max, Math.max(POP_OUT_MIN_SIZE.width, Math.round(width))),
    height: Math.min(WINDOW_LIMITS.max, Math.max(POP_OUT_MIN_SIZE.height, Math.round(height))),
  };
}

type Records = Record<string, PopOutRecord>;

function boundsOf(win: chrome.windows.Window): WindowBounds {
  return {
    left: win.left ?? 0,
    top: win.top ?? 0,
    width: win.width ?? 0,
    height: win.height ?? 0,
    state: win.state ?? "normal",
  };
}

export class PopOutController {
  /** Per popup window: a resize is in flight, and the latest size asked for meanwhile (sent when it lands). */
  private readonly resizing = new Map<number, { width: number; height: number } | null>();
  /** Serializes the clean-up after a tab or window closed (both events fire when the popup window closes). */
  private closing: Promise<void> = Promise.resolve();

  constructor(
    private readonly windows: PopOutWindowsApi,
    private readonly tabs: PopOutTabsApi,
    private readonly session: SessionArea,
    private readonly local: SessionArea,
  ) {}

  private async records(): Promise<Records> {
    const stored = (await this.session.get(SESSION_KEY)) as Record<string, unknown>;
    const value = stored[SESSION_KEY];
    return typeof value === "object" && value !== null ? (value as Records) : {};
  }

  private async save(records: Records): Promise<void> {
    await this.session.set({ [SESSION_KEY]: records });
  }

  async recordForTab(tabId: number): Promise<PopOutRecord | undefined> {
    return (await this.records())[String(tabId)];
  }

  /** The pop-out whose placeholder tab is `tabId`, if any. */
  async recordForPlaceholder(tabId: number): Promise<PopOutRecord | undefined> {
    return Object.values(await this.records()).find((record) => record.placeholderTabId === tabId);
  }

  private async patch(tabId: number, change: Partial<PopOutRecord>): Promise<void> {
    const records = await this.records();
    const record = records[String(tabId)];
    if (!record) return;
    records[String(tabId)] = { ...record, ...change };
    await this.save(records);
  }

  private async forget(tabId: number): Promise<void> {
    const records = await this.records();
    delete records[String(tabId)];
    await this.save(records);
  }

  /** The pop-out whose popup window is `windowId`, if any. */
  async recordForWindow(windowId: number): Promise<PopOutRecord | undefined> {
    return Object.values(await this.records()).find((record) => record.popupWindowId === windowId);
  }

  private async placement(): Promise<PopOutPlacement | undefined> {
    const stored = (await this.local.get(PLACEMENT_KEY)) as Record<string, unknown>;
    const value = stored[PLACEMENT_KEY] as PopOutPlacement | undefined;
    return value && typeof value.left === "number" && typeof value.width === "number" ? value : undefined;
  }

  /**
   * Moves `tabId` out of `fromWindowId` into a popup window of width x height (outer px). The window opens where
   * the last pop-out was left, at the size it was left at unless the setting changed since; the first one opens
   * in the bottom-right corner of the window the tab came from, as does one whose remembered place Chromium
   * refuses (less than half on any display). A placeholder tab, not active, takes the tab's place. Returns the
   * popup's bounds.
   */
  async enter(tabId: number, fromWindowId: number, width: number, height: number, page: PopOutPage = { title: "", url: null }): Promise<WindowBounds> {
    const records = await this.records();
    const existing = records[String(tabId)];
    if (existing?.popupWindowId != null) return boundsOf(await this.windows.get(existing.popupWindowId));

    const tab = await this.tabs.get(tabId);
    const from = await this.windows.get(fromWindowId);
    const requested = { width: Math.round(width), height: Math.round(height) };
    const last = await this.placement();
    const sameSize = last && last.requested.width === requested.width && last.requested.height === requested.height;
    const size = sameSize ? { width: last.width, height: last.height } : requested;
    const corner = {
      left: Math.round((from.left ?? 0) + (from.width ?? size.width) - size.width - CORNER_GAP),
      top: Math.round((from.top ?? 0) + (from.height ?? size.height) - size.height - CORNER_GAP),
    };
    let position = last ? { left: last.left, top: last.top } : corner;

    const record: PopOutRecord = {
      tabId,
      fromWindowId,
      index: tab.index,
      fromBounds: boundsOf(from),
      popupWindowId: null,
      requested,
      placeholderTabId: null,
      url: restorableUrl(page.url ?? undefined),
    };
    records[String(tabId)] = record;
    await this.save(records);

    // The placeholder opens before the tab leaves, so the window (whose only tab the video may be) stays open. Just
    // before the tab, so it has the tab's index once the tab has gone, and Chromium activates the tab's right-hand
    // neighbour rather than the placeholder (unless there is no other tab).
    const placeholder = await this.tabs
      .create({ windowId: fromWindowId, index: tab.index, active: false, url: placeholderUrl(page) })
      .catch(() => undefined);
    if (placeholder?.id !== undefined) await this.patch(tabId, { placeholderTabId: placeholder.id });

    // Chromium rejects a position less than half on any display (the displays changed since the last pop-out):
    // then the corner of the window the tab came from, then wherever Chromium places it.
    const create = (at: { left: number; top: number } | null): Promise<chrome.windows.Window | undefined> =>
      this.windows.create({ tabId, type: "popup", focused: true, ...at, ...size });
    let popup = await create(position)
      .catch(async () => {
        if (position === corner) throw new Error("corner refused");
        position = corner;
        return create(corner);
      })
      .catch(() => create(null))
      .catch(() => undefined);
    const popupId = popup?.id;
    if (popup === undefined || popupId === undefined) {
      // The tab never left: no placeholder, no pop-out.
      await this.forget(tabId);
      if (placeholder?.id !== undefined) await this.tabs.remove(placeholder.id).catch(() => undefined);
      throw new Error("no popup window");
    }
    // The tab is out now: record its window before anything else can fail, so exit can always put it back.
    await this.patch(tabId, { popupWindowId: popupId });
    // Chromium can create the window at a default size (headless always does): set the bounds once more. If it
    // refuses them (a position or size it counts as off screen), the window just keeps the bounds it has.
    if (popup.width !== size.width || popup.height !== size.height || popup.left !== position.left || popup.top !== position.top) {
      popup = await this.windows
        .update(popupId, { ...position, ...size })
        .catch(() => this.windows.update(popupId, size))
        .catch(() => popup);
    }
    // A popup can open minimized (or otherwise not as a floating window): show it, in front.
    const shown = await this.windows.get(popupId).catch(() => popup);
    if (shown?.state !== undefined && shown.state !== "normal") {
      popup = await this.windows.update(popupId, { state: "normal", focused: true }).catch(() => shown);
    }
    return boundsOf(popup ?? (await this.windows.get(popupId)));
  }

  /**
   * Puts `tabId` back where its placeholder is now (the user may have dragged it), and closes the placeholder;
   * without one, where the tab came from. Returns false if it is not popped out.
   */
  async exit(tabId: number): Promise<boolean> {
    const records = await this.records();
    const record = records[String(tabId)];
    if (!record) return false;
    delete records[String(tabId)];
    await this.save(records);

    if (record.popupWindowId !== null) {
      try {
        const popup = await this.windows.get(record.popupWindowId);
        if (popup.state === "normal" || popup.state === undefined) {
          const { left, top, width, height } = boundsOf(popup);
          await this.local.set({ [PLACEMENT_KEY]: { left, top, width, height, requested: record.requested } satisfies PopOutPlacement });
        }
      } catch {
        // The popup is already gone.
      }
    }
    let target = { windowId: record.fromWindowId, index: record.index };
    if (record.placeholderTabId !== null) {
      const placeholder = await this.tabs.get(record.placeholderTabId).catch(() => undefined);
      if (placeholder?.windowId !== undefined) target = { windowId: placeholder.windowId, index: placeholder.index };
    }
    try {
      try {
        await this.tabs.move(tabId, target);
      } catch (error) {
        if (target.windowId === record.fromWindowId && target.index === record.index) throw error;
        target = { windowId: record.fromWindowId, index: record.index };
        await this.tabs.move(tabId, target);
      }
    } catch {
      // The window it came from has closed (it was its only tab, or the user closed it): open one like it.
      const { left, top, width, height, state } = record.fromBounds;
      const win = await this.windows
        .create({ tabId, focused: true, left, top, width, height })
        .catch(() => this.windows.create({ tabId, focused: true }));
      if (win?.id !== undefined && (state === "maximized" || state === "fullscreen")) await this.windows.update(win.id, { state }).catch(() => undefined);
      return true;
    }
    // The tab is in the placeholder's place (it moved in before it): the placeholder's work is done.
    if (record.placeholderTabId !== null) await this.tabs.remove(record.placeholderTabId).catch(() => undefined);
    await this.tabs.update(tabId, { active: true });
    await this.windows.update(target.windowId, { focused: true }).catch(() => undefined);
    return true;
  }

  /**
   * A tab closed. A popped-out tab (its popup window closed with the title bar's X): the placeholder turns back
   * into the page, which reloads but is not lost; with no placeholder left, nothing to do. A placeholder: the
   * pop-out goes on, and comes back where the tab came from.
   */
  tabClosed(tabId: number): Promise<void> {
    const run = this.closing.then(async () => {
      const records = await this.records();
      const record = records[String(tabId)];
      if (record) {
        delete records[String(tabId)];
        await this.save(records);
        if (record.placeholderTabId !== null && record.url !== null) {
          await this.tabs.update(record.placeholderTabId, { url: record.url }).catch(() => undefined);
        }
        return;
      }
      const owner = Object.values(records).find((r) => r.placeholderTabId === tabId);
      if (owner) await this.patch(owner.tabId, { placeholderTabId: null });
    });
    this.closing = run.catch(() => undefined);
    return run;
  }

  /** A window closed: if it was a popup, its tab is gone (see tabClosed). */
  async windowClosed(windowId: number): Promise<void> {
    const record = await this.recordForWindow(windowId);
    if (record) await this.tabClosed(record.tabId);
  }

  /** `tabId`'s own popup window, if `tabId` is popped out and sits in it (`windowId`); else it throws. */
  private async ownPopup(tabId: number, windowId: number): Promise<number> {
    const record = await this.recordForTab(tabId);
    if (!record || record.popupWindowId === null || record.popupWindowId !== windowId) throw new Error("not a popped-out tab");
    return record.popupWindowId;
  }

  /** The hover bar: the popup window of `tabId` (in `windowId`) goes full screen, back to floating, or minimized. */
  async windowAction(tabId: number, windowId: number, action: PopOutWindowAction): Promise<WindowBounds["state"]> {
    const popupId = await this.ownPopup(tabId, windowId);
    const info: chrome.windows.UpdateInfo = action === "normal" ? { state: "normal", focused: true } : { state: action };
    const win = await this.windows.update(popupId, info);
    return win?.state ?? action;
  }

  /**
   * The corner grip: resizes the popup window of `tabId` (in `windowId`) to width x height, at least
   * POP_OUT_MIN_SIZE. One update at a time per window; sizes asked for meanwhile collapse into the latest.
   */
  async resize(tabId: number, windowId: number, width: number, height: number): Promise<void> {
    const popupId = await this.ownPopup(tabId, windowId);
    const size = clampPopOutSize(width, height);
    if (this.resizing.has(popupId)) {
      this.resizing.set(popupId, size);
      return;
    }
    this.resizing.set(popupId, null);
    try {
      let next: { width: number; height: number } | null = size;
      while (next) {
        await this.windows.update(popupId, next).catch(() => undefined);
        next = this.resizing.get(popupId) ?? null;
        this.resizing.set(popupId, null);
      }
    } finally {
      this.resizing.delete(popupId);
    }
  }
}
