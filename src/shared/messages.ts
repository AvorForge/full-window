/**
 * Typed message definitions for the three channels (docs/ARCHITECTURE.md §1, §4, §5):
 *
 *   PageMessage     MAIN world  <-> ISOLATED world, same frame (private CustomEvent channel)
 *   FrameMessage    ISOLATED    <-> ISOLATED, child frame <-> parent frame (window.postMessage)
 *   RuntimeMessage  ISOLATED / popup <-> service worker (chrome.runtime / chrome.tabs messaging)
 */

import type { CustomRect, ResolvedSettings, SizeMode } from "./settings";

// ---------------------------------------------------------------------------
// MAIN <-> ISOLATED (same frame)
// ---------------------------------------------------------------------------

/** What the MAIN-world shim needs to know; derived from ResolvedSettings. */
export interface ShimConfig {
  enabled: boolean;
  mode: SizeMode;
  /** Used by the top frame in custom-rect mode (computePinRect); child frames fill their viewport. */
  customRect: CustomRect;
  /** window === window.top for the frame this config is sent to. */
  topFrame: boolean;
  backgroundColor: string;
  exitOnEscape: boolean;
  /** Set by the toggle command: requests go to the real Fullscreen API. */
  preferReal: boolean;
}

export function toShimConfig(settings: ResolvedSettings, topFrame: boolean, preferReal = false): ShimConfig {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    customRect: settings.customRect,
    topFrame,
    backgroundColor: settings.backgroundColor,
    exitOnEscape: settings.exitOnEscape,
    preferReal,
  };
}

export type PageMessage =
  /** ISOLATED -> MAIN: (re)configure the shim. Sent on start-up and on every settings change. */
  | { type: "config"; config: ShimConfig }
  /** ISOLATED -> MAIN: leave fake fullscreen (Esc in another frame, command, tab hidden...). */
  | { type: "exit"; reason: ExitReason }
  /** ISOLATED -> MAIN: switch the active fake fullscreen element to real fullscreen. */
  | { type: "go-real" }
  /** ISOLATED -> MAIN: back from real (browser-window) fullscreen to the configured fake size. */
  | { type: "go-fake" }
  /**
   * ISOLATED -> MAIN: fake-fullscreen the element this event was dispatched on
   * (an <iframe> whose child frame entered fake fullscreen). The element is the
   * event target, never serialized.
   */
  | { type: "enter-frame-element"; requestId: string }
  /** MAIN -> ISOLATED: an element entered fake fullscreen in this frame. */
  | { type: "entered"; requestId: string; mode: SizeMode }
  /** MAIN -> ISOLATED: fake fullscreen ended in this frame. */
  | { type: "exited"; reason: ExitReason };

/**
 * Why fake fullscreen ended. "refused": the parent frame refused to pin this
 * frame's <iframe> (frame-ack accepted: false); the request turns into an error.
 */
export type ExitReason = "api" | "escape" | "command" | "frame" | "navigation" | "disabled" | "removed" | "refused";

// ---------------------------------------------------------------------------
// Child frame <-> parent frame (window.postMessage, cross-origin)
// ---------------------------------------------------------------------------

/** Constant marker; messages without it are ignored. */
export const FRAME_PROTOCOL = "custom-full-screen/frame";
export const FRAME_PROTOCOL_VERSION = 1;

export type FrameMessageBody =
  /** child -> parent: my document is in fake fullscreen, pin my <iframe>. */
  | { type: "frame-enter"; requestId: string }
  /** child -> parent: my document left fake fullscreen, unpin my <iframe>. */
  | { type: "frame-exit"; requestId: string; reason: ExitReason }
  /** parent -> child: the chain is exiting (Esc or exit in an ancestor). */
  | { type: "frame-exit-request"; requestId: string; reason: ExitReason }
  /** parent -> child: request accepted or refused (e.g. site disabled, no allowfullscreen). */
  | { type: "frame-ack"; requestId: string; accepted: boolean };

export type FrameMessage = FrameMessageBody & {
  protocol: typeof FRAME_PROTOCOL;
  version: typeof FRAME_PROTOCOL_VERSION;
};

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EXIT_REASONS: readonly ExitReason[] = ["api", "escape", "command", "frame", "navigation", "disabled", "removed", "refused"];

/**
 * Strict structural check for data received from another frame. Anything with
 * unexpected keys or types is rejected. The caller must also check
 * MessageEvent.source (see §4 of the architecture document).
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  if (msg.protocol !== FRAME_PROTOCOL || msg.version !== FRAME_PROTOCOL_VERSION) return null;
  if (typeof msg.requestId !== "string" || !REQUEST_ID.test(msg.requestId)) return null;
  const keys = Object.keys(msg).sort().join(",");
  const reasonOk = typeof msg.reason === "string" && (EXIT_REASONS as readonly string[]).includes(msg.reason);
  switch (msg.type) {
    case "frame-enter":
      return keys === "protocol,requestId,type,version" ? (msg as FrameMessage) : null;
    case "frame-exit":
    case "frame-exit-request":
      return keys === "protocol,reason,requestId,type,version" && reasonOk ? (msg as FrameMessage) : null;
    case "frame-ack":
      return keys === "accepted,protocol,requestId,type,version" && typeof msg.accepted === "boolean"
        ? (msg as FrameMessage)
        : null;
    default:
      return null;
  }
}

export function frameMessage(body: FrameMessageBody): FrameMessage {
  return { protocol: FRAME_PROTOCOL, version: FRAME_PROTOCOL_VERSION, ...body };
}

// ---------------------------------------------------------------------------
// Content script / popup <-> service worker
// ---------------------------------------------------------------------------

/** The chrome.commands name of the fake/real toggle (manifest.json "commands"). */
export const TOGGLE_COMMAND = "toggle-fullscreen-mode";

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  state: `${chrome.windows.WindowState}`;
}

/** Messages sent to the service worker (chrome.runtime.sendMessage). Window and tab ids come from `sender.tab`. */
export type ToServiceWorker =
  /**
   * Move the sender tab into its own popup window of width x height, leaving a placeholder tab in its place.
   * `title` and `url` are the page's (document.title, location.href): without the "tabs" permission tab.title
   * and tab.url are undefined. The placeholder shows the title, and turns back into the page at `url` if the
   * popup window is closed.
   */
  | { type: "pop-out-enter"; width: number; height: number; title?: string; url?: string }
  /** Put the sender tab back where its placeholder is (or where it came from). */
  | { type: "pop-out-exit" }
  /** The popped-out sender tab's own popup window: full screen, back to a floating window, or minimized. */
  | { type: "pop-out-window"; action: PopOutWindowAction }
  /** The popped-out sender tab's own popup window: resize to width x height (outer px, at least POP_OUT_MIN_SIZE). */
  | { type: "pop-out-resize"; width: number; height: number }
  /** The placeholder page ("Bring it back"): pop its tab back in, as Esc would. */
  | { type: "pop-out-return" }
  /**
   * A frame of a popped-out tab saw pointer activity; relayed to the top frame (which shows the hover bar).
   * `corner`: the pointer is in the corner zone of the viewport (the top frame then shows the corner grip too).
   */
  | { type: "pop-out-activity"; corner?: boolean }
  /** Toggle command, fake -> real: make the sender tab's window fullscreen (like F11), remembering its state. */
  | { type: "browser-fullscreen-enter" }
  /** Toggle command, real -> fake, or fake fullscreen ended: restore the remembered window state. */
  | { type: "browser-fullscreen-exit" }
  /** A frame starts up and asks for the sender tab's state (the armed mode survives navigation). */
  | { type: "tab-state" }
  /** Toggle command while idle: arm real (true) or fake (false) fullscreen for the sender tab; broadcast to its frames. */
  | { type: "set-prefer-real"; preferReal: boolean }
  /**
   * Top frame only: whether the extension is on for its site (the resolved `enabled`). Sent once the settings
   * have loaded, when `enabled` changes, and when the page is shown again (back/forward cache) or activated
   * (prerender). The service worker shows the ON or OFF toolbar icon for the sender tab.
   */
  | { type: "site-state"; enabled: boolean };

/** What the hover bar's Full screen / Exit full screen / Minimize buttons ask of the popup window. */
export type PopOutWindowAction = "fullscreen" | "normal" | "minimized";
export const POP_OUT_WINDOW_ACTIONS: readonly PopOutWindowAction[] = ["fullscreen", "normal", "minimized"];

/** The smallest size the corner grip can drag the popup window to (outer px). */
export const POP_OUT_MIN_SIZE = { width: 320, height: 200 } as const;

/** Longest page title and URL "pop-out-enter" may carry; longer ones are cut. */
export const POP_OUT_TITLE_MAX = 300;
export const POP_OUT_URL_MAX = 8192;

export interface ServiceWorkerReplies {
  "pop-out-enter": { ok: true; bounds: WindowBounds } | { ok: false; error: string };
  "pop-out-exit": { ok: true; restored: boolean } | { ok: false; error: string };
  "pop-out-window": { ok: true; state: WindowBounds["state"] } | { ok: false; error: string };
  "pop-out-resize": { ok: true } | { ok: false; error: string };
  "pop-out-return": { ok: true; returned: boolean } | { ok: false; error: string };
  "pop-out-activity": { ok: true } | { ok: false; error: string };
  "browser-fullscreen-enter": { ok: true; state: WindowBounds["state"] } | { ok: false; error: string };
  "browser-fullscreen-exit": { ok: true; restored: boolean } | { ok: false; error: string };
  "tab-state": { ok: true; preferReal: boolean } | { ok: false; error: string };
  "set-prefer-real": { ok: true; preferReal: boolean } | { ok: false; error: string };
  "site-state": { ok: true } | { ok: false; error: string };
}

/** Messages sent to a tab's content scripts (chrome.tabs.sendMessage). */
export type ToContent =
  /** The chrome.commands toggle fired for this tab (sent to the top frame). */
  | { type: "command-toggle" }
  /** The service worker restored the window (tab deactivated/closed); keep fake fullscreen in fill-tab. */
  | { type: "pop-out-released" }
  /** "Bring it back" on the placeholder page: leave fake fullscreen as Esc does (sent to the top frame). */
  | { type: "pop-out-leave" }
  /** Pointer activity in one of the popped-out tab's frames (sent to the top frame); `corner` as above. */
  | { type: "pop-out-activity"; corner?: boolean }
  /** The service worker left browser fullscreen (tab deactivated); the top frame goes back to the fake size. */
  | { type: "browser-fullscreen-released" }
  /** The armed mode of the tab changed (broadcast to every frame). */
  | { type: "prefer-real-changed"; preferReal: boolean }
  /** Popup asks the top frame which site it is on and what is armed / active. */
  | { type: "get-site" }
  /** The service worker asks the top frame for its site's `enabled` (null: settings not loaded yet), to check the toolbar icon. */
  | { type: "get-site-state" };

export interface ContentReplies {
  "command-toggle": { handled: boolean };
  "pop-out-released": { ok: true };
  /** handled: false when the tab was not in fake fullscreen (the service worker then puts it back itself). */
  "pop-out-leave": { handled: boolean };
  "pop-out-activity": { ok: true };
  "browser-fullscreen-released": { ok: true };
  "prefer-real-changed": { ok: true };
  "get-site": {
    hostname: string;
    /** Fake fullscreen is active in this tab. */
    active: boolean;
    /** The toggle armed real fullscreen: the next request goes to the real API. */
    preferReal: boolean;
    /** The active fake fullscreen was switched to real (browser-window) fullscreen. */
    real: boolean;
  };
  "get-site-state": { enabled: boolean | null };
}

export type RuntimeMessage = ToServiceWorker | ToContent;

const TO_SW_TYPES = new Set<string>([
  "pop-out-enter",
  "pop-out-exit",
  "pop-out-window",
  "pop-out-resize",
  "pop-out-return",
  "pop-out-activity",
  "browser-fullscreen-enter",
  "browser-fullscreen-exit",
  "tab-state",
  "set-prefer-real",
  "site-state",
]);
const TO_CONTENT_TYPES = new Set<string>([
  "command-toggle",
  "pop-out-released",
  "pop-out-leave",
  "pop-out-activity",
  "browser-fullscreen-released",
  "prefer-real-changed",
  "get-site",
  "get-site-state",
]);

function hasType(value: unknown): value is { type: string } & Record<string, unknown> {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function isToServiceWorker(value: unknown): value is ToServiceWorker {
  if (!hasType(value) || !TO_SW_TYPES.has(value.type)) return false;
  if (value.type === "pop-out-enter") {
    const optionalString = (field: unknown): boolean => field === undefined || typeof field === "string";
    return Number.isFinite(value.width) && Number.isFinite(value.height) && optionalString(value.title) && optionalString(value.url);
  }
  if (value.type === "pop-out-resize") return Number.isFinite(value.width) && Number.isFinite(value.height);
  if (value.type === "pop-out-window") return (POP_OUT_WINDOW_ACTIONS as readonly unknown[]).includes(value.action);
  if (value.type === "set-prefer-real") return typeof value.preferReal === "boolean";
  if (value.type === "site-state") return typeof value.enabled === "boolean";
  if (value.type === "pop-out-activity") return value.corner === undefined || typeof value.corner === "boolean";
  return true;
}

export function isToContent(value: unknown): value is ToContent {
  if (!hasType(value) || !TO_CONTENT_TYPES.has(value.type)) return false;
  if (value.type === "prefer-real-changed") return typeof value.preferReal === "boolean";
  if (value.type === "pop-out-activity") return value.corner === undefined || typeof value.corner === "boolean";
  return true;
}
