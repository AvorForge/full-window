/**
 * ISOLATED-world logic of one frame (docs/ARCHITECTURE.md §1, §4, §5, §8),
 * separated from chrome.* wiring (isolated.ts) so it can be unit tested.
 *
 * - pushes the ShimConfig for the top-level site to the MAIN world;
 * - relays the frame chain: frame-enter / frame-ack up, frame-exit up,
 *   frame-exit-request down, validating every message and its source;
 * - Esc (capture phase, only while this frame is in a fake-fullscreen chain);
 * - top frame only: pop-out enter/exit with the service worker, the
 *   popped-out window's hover bar and corner grip (popOutBar.ts), the
 *   toggle command (browser fullscreen or arming real fullscreen), the
 *   popup's get-site, and the site's on/off state for the toolbar icon.
 */

import {
  frameMessage,
  parseFrameMessage,
  toShimConfig,
  type ContentReplies,
  type ExitReason,
  type FrameMessage,
  type FrameMessageBody,
  type PageMessage,
  type ServiceWorkerReplies,
  type ToContent,
  type ToServiceWorker,
} from "../shared/messages";
import { resolveForSite, type ResolvedSettings, type SettingsDocument, type SizeMode, type WindowSize } from "../shared/settings";
import type { PageChannel } from "./channel";
import { createPopOutBar, inCornerZone, type PopOutBar, type PopOutBarActions } from "./popOutBar";

export interface IsolatedEnvironment {
  /** This frame's window: listeners, `parent`. */
  readonly window: Window;
  readonly document: Document;
  readonly channel: Pick<PageChannel, "post" | "onMessage">;
  readonly isTopFrame: boolean;
  /** Hostname whose settings apply: the top-level site's (see topLevelHostname). */
  readonly hostname: string;
  /** targetOrigin for messages to the parent frame. */
  readonly parentOrigin: string;
  /** chrome.runtime.sendMessage. */
  sendToServiceWorker(message: ToServiceWorker): Promise<unknown>;
  /** Defaults to `target.postMessage(message, targetOrigin)`. */
  postToWindow?(target: MessageEventSource, message: FrameMessage, targetOrigin: string): void;
  /** Defaults to popOutBar.ts's createPopOutBar in this frame's window and document. */
  createPopOutBar?(actions: PopOutBarActions): PopOutBar;
}

export interface IsolatedState {
  readonly settings: ResolvedSettings | null;
  /** Fake fullscreen is active in this frame (the element or the <iframe> of a child). */
  readonly fakeActive: boolean;
  readonly preferReal: boolean;
  /** Top frame: the toggle switched the active fake fullscreen to browser fullscreen. */
  readonly real: boolean;
  /** Top frame: pop-out state with the service worker. */
  readonly popOut: "idle" | "pending" | "active";
  /** requestId this frame announced to its parent (frame-enter) and has not exited. */
  readonly sentUp: string | null;
  /** requestId of the child frame whose <iframe> this frame pinned. */
  readonly childRequestId: string | null;
}

type Reply = ContentReplies[keyof ContentReplies];

export interface IsolatedController {
  readonly state: IsolatedState;
  /** Settings loaded or changed: resolve them for the site and push the config. */
  applySettings(doc: SettingsDocument): void;
  /** A message from the service worker or popup. undefined: not for this frame (no reply). */
  handleRuntimeMessage(message: ToContent): Reply | Promise<Reply> | undefined;
  dispose(): void;
}

interface ChildLink {
  requestId: string;
  element: Element;
  source: MessageEventSource;
  origin: string;
}

/**
 * Per-site settings follow the site in the address bar: a YouTube embed on
 * example.com uses example.com's settings. location.ancestorOrigins gives the
 * top origin to cross-origin child frames in Chromium.
 */
export function topLevelHostname(loc: Pick<Location, "hostname"> & { ancestorOrigins?: DOMStringList }, isTopFrame: boolean): string {
  if (isTopFrame) return loc.hostname;
  const ancestors = loc.ancestorOrigins;
  const topOrigin = ancestors && ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
  if (topOrigin) {
    try {
      return new URL(topOrigin).hostname;
    } catch {
      // fall through
    }
  }
  return loc.hostname;
}

/** targetOrigin for postMessage to the parent: its origin when known, else "*" (messages carry no secret). */
export function parentOrigin(loc: { ancestorOrigins?: DOMStringList }): string {
  const origin = loc.ancestorOrigins && loc.ancestorOrigins.length > 0 ? loc.ancestorOrigins[0] : undefined;
  return origin && origin !== "null" ? origin : "*";
}

/**
 * Does the `allow` attribute grant fullscreen? null when it says nothing about
 * it. `allow="fullscreen"` (default allowlist 'src') and any allowlist other
 * than 'none' grant it.
 */
export function allowAttributeGrantsFullscreen(allow: string | null): boolean | null {
  if (!allow) return null;
  for (const directive of allow.split(";")) {
    const [feature, ...allowlist] = directive.trim().split(/\s+/);
    if (feature?.toLowerCase() === "fullscreen") return !allowlist.includes("'none'");
  }
  return null;
}

/** Is `frame` (an <iframe>/<frame> of `doc`) allowed to be fullscreen, as far as this document can tell? */
export function frameAllowsFullscreen(doc: Document, frame: Element): boolean {
  if ((doc as { fullscreenEnabled?: boolean }).fullscreenEnabled === false) return false;
  const policy = (frame as { featurePolicy?: { allowsFeature?: (feature: string) => boolean } }).featurePolicy;
  if (policy && typeof policy.allowsFeature === "function") {
    try {
      return policy.allowsFeature("fullscreen");
    } catch {
      // fall back to the attributes
    }
  }
  if (frame.hasAttribute("allowfullscreen")) return true;
  const granted = allowAttributeGrantsFullscreen(frame.getAttribute("allow"));
  if (granted !== null) return granted;
  // Default allowlist 'self': a same-origin frame (its document is readable) may go fullscreen.
  try {
    return (frame as HTMLIFrameElement).contentDocument != null;
  } catch {
    return false;
  }
}

/** The <iframe>/<frame> of `doc` (or of an open shadow root in it) whose contentWindow is `source`. */
export function findFrameElement(doc: Document, source: unknown): Element | null {
  if (!source) return null;
  const isFrame = (element: Element): boolean =>
    (element.localName === "iframe" || element.localName === "frame") && (element as HTMLIFrameElement).contentWindow === source;
  for (const frame of Array.from(doc.querySelectorAll("iframe, frame"))) if (isFrame(frame)) return frame;
  const visitShadows = (root: Document | ShadowRoot): Element | null => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      const shadow = element.shadowRoot;
      if (!shadow) continue;
      for (const frame of Array.from(shadow.querySelectorAll("iframe, frame"))) if (isFrame(frame)) return frame;
      const nested = visitShadows(shadow);
      if (nested) return nested;
    }
    return null;
  };
  return visitShadows(doc);
}

/**
 * A child frame relays pointer activity to the top frame (the hover bar) at most this often; the pointer entering
 * or leaving the corner zone (the grip) is relayed at once.
 */
export const ACTIVITY_RELAY_MS = 400;

function isOk(reply: unknown): boolean {
  return typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
}

export function createIsolatedController(env: IsolatedEnvironment): IsolatedController {
  const { window: win, document: doc, channel, isTopFrame } = env;
  const postToWindow =
    env.postToWindow ??
    ((target: MessageEventSource, message: FrameMessage, targetOrigin: string) => (target as Window).postMessage(message, targetOrigin));

  let settings: ResolvedSettings | null = null;
  let preferReal = false;
  let fakeActive = false;
  let real = false;
  let popOut: IsolatedState["popOut"] = "idle";
  let sentUp: string | null = null;
  let child: ChildLink | null = null;
  /** When the exit came from another frame of the chain, the reason to pass along. */
  let chainReason: ExitReason | null = null;
  let swallowEscapeUp = false;
  /** Top frame: the hover bar and grip, while the tab is popped out. */
  let bar: PopOutBar | null = null;
  /** Child frame: when it last relayed pointer activity to the top frame, and whether it was in the corner zone. */
  let lastActivity = -Infinity;
  let lastCorner = false;

  const send = async <T extends ToServiceWorker>(message: T): Promise<ServiceWorkerReplies[T["type"]] | undefined> => {
    try {
      return (await env.sendToServiceWorker(message)) as ServiceWorkerReplies[T["type"]] | undefined;
    } catch {
      return undefined; // service worker unavailable (extension reloaded)
    }
  };

  const post = (target: MessageEventSource, body: FrameMessageBody, targetOrigin: string): void => {
    try {
      postToWindow(target, frameMessage(body), targetOrigin);
    } catch {
      // the other frame is gone or its origin changed
    }
  };

  const toMain = (message: PageMessage, target?: EventTarget): void => channel.post(message, target);

  const pushConfig = (): void => {
    if (settings) toMain({ type: "config", config: toShimConfig(settings, isTopFrame, preferReal) });
  };

  // -------------------------------------------------------------------------
  // Toolbar icon: the top frame reports its site's on/off state (docs/ARCHITECTURE.md §5)
  // -------------------------------------------------------------------------

  /** The `enabled` last sent to the service worker; null: none sent by this document yet. */
  let reportedEnabled: boolean | null = null;

  /**
   * Tells the service worker whether the extension is on for this site, so it shows the tab's ON or OFF icon.
   * `again`: even if unchanged, because Chromium reset the tab's icon (the page came back from the
   * back/forward cache, or a prerendered page was activated). A prerendering page waits for its activation:
   * it is not the page the tab shows.
   */
  const reportSiteState = (again: boolean): void => {
    if (!isTopFrame || !settings || (doc as { prerendering?: boolean }).prerendering === true) return;
    if (!again && reportedEnabled === settings.enabled) return;
    reportedEnabled = settings.enabled;
    void send({ type: "site-state", enabled: settings.enabled });
  };

  // -------------------------------------------------------------------------
  // Pop-out mode (§5) and browser fullscreen (§8), top frame only
  // -------------------------------------------------------------------------

  const enterPopOut = async (size: WindowSize): Promise<void> => {
    popOut = "pending";
    // The placeholder tab shows the title, and loads the URL again if the popup window is closed.
    const reply = await send({ type: "pop-out-enter", width: size.width, height: size.height, title: doc.title, url: doc.location?.href ?? "" });
    if (popOut !== "pending") {
      // Exited or released while the window was being resized: give it back.
      if (isOk(reply)) await send({ type: "pop-out-exit" });
      return;
    }
    popOut = isOk(reply) ? "active" : "idle";
    if (popOut === "active") showBar();
  };

  const barActions: PopOutBarActions = {
    popBackIn: () => {
      if (fakeActive) toMain({ type: "exit", reason: "escape" });
    },
    windowAction: async (action) => isOk(await send({ type: "pop-out-window", action })),
    resize: (width, height) => send({ type: "pop-out-resize", width, height }),
  };

  const showBar = (): void => {
    if (bar) return;
    try {
      bar = env.createPopOutBar ? env.createPopOutBar(barActions) : createPopOutBar(win, doc, barActions);
    } catch {
      bar = null; // the page's document would not take it; Esc and the window's own controls still work
    }
  };

  const removeBar = (): void => {
    bar?.remove();
    bar = null;
  };

  const leaveWindowModes = async (): Promise<void> => {
    if (real) {
      real = false;
      await send({ type: "browser-fullscreen-exit" });
    }
    const wasActive = popOut === "active";
    popOut = "idle"; // a pending enter sends the exit itself when its reply arrives
    removeBar();
    if (wasActive) await send({ type: "pop-out-exit" });
  };

  // -------------------------------------------------------------------------
  // MAIN world reports
  // -------------------------------------------------------------------------

  const onEntered = (requestId: string, mode: SizeMode): void => {
    fakeActive = true;
    if (child && child.requestId !== requestId) {
      // A local element replaced the child's <iframe>: the child's chain ends.
      post(child.source, { type: "frame-exit-request", requestId: child.requestId, reason: "api" }, child.origin);
      child = null;
    }
    if (!isTopFrame) {
      sentUp = requestId;
      lastCorner = false; // a new chain: the top frame's new bar starts without the grip
      post(win.parent, { type: "frame-enter", requestId }, env.parentOrigin);
    } else if (mode === "pop-out" && popOut === "idle" && !real && settings) {
      void enterPopOut(settings.windowSize);
    }
  };

  const onExited = (reason: ExitReason): void => {
    fakeActive = false;
    const propagated = chainReason ?? reason;
    chainReason = null;
    // Exiting anywhere exits the whole chain: down to the child, up to the parent (never back to the sender).
    if (child) {
      post(child.source, { type: "frame-exit-request", requestId: child.requestId, reason: propagated }, child.origin);
      child = null;
    }
    if (sentUp !== null) {
      post(win.parent, { type: "frame-exit", requestId: sentUp, reason: propagated }, env.parentOrigin);
      sentUp = null;
    }
    if (isTopFrame) void leaveWindowModes();
  };

  const unsubscribe = channel.onMessage((message) => {
    if (message.type === "entered") onEntered(message.requestId, message.mode);
    else if (message.type === "exited") onExited(message.reason);
  });

  // -------------------------------------------------------------------------
  // Frame relay (§4)
  // -------------------------------------------------------------------------

  const replyOrigin = (origin: string): string => (origin && origin !== "null" ? origin : "*");

  /** Tells the MAIN world to exit because of another frame; its "exited" report continues the chain. */
  const exitFromChain = (reason: ExitReason): void => {
    if (!fakeActive) {
      chainReason = null;
      return;
    }
    toMain({ type: "exit", reason: reason === "refused" ? "refused" : "frame" });
  };

  const onFrameEnter = (message: FrameMessage, event: MessageEvent): boolean => {
    const source = event.source;
    const frame = findFrameElement(doc, source);
    if (!frame || !source) return false; // only direct child frames of this document
    const origin = replyOrigin(event.origin);
    const accepted = settings?.enabled !== false && frameAllowsFullscreen(doc, frame);
    post(source, { type: "frame-ack", requestId: message.requestId, accepted }, origin);
    if (!accepted) return true;
    if (child && child.source !== source) {
      post(child.source, { type: "frame-exit-request", requestId: child.requestId, reason: "api" }, child.origin);
    }
    child = { requestId: message.requestId, element: frame, source, origin };
    // The event is dispatched on the <iframe>, so the MAIN world gets the element itself.
    toMain({ type: "enter-frame-element", requestId: message.requestId }, frame);
    return true;
  };

  const onFrameExit = (message: FrameMessage & { reason: ExitReason }, event: MessageEvent): boolean => {
    if (!child || event.source !== child.source || message.requestId !== child.requestId) return false;
    child = null; // do not send the exit back down
    chainReason = message.reason;
    exitFromChain(message.reason);
    return true;
  };

  const onFrameExitRequest = (message: FrameMessage & { reason: ExitReason }, event: MessageEvent): boolean => {
    if (isTopFrame || event.source !== win.parent || sentUp === null || message.requestId !== sentUp) return false;
    sentUp = null; // do not send the exit back up
    chainReason = message.reason;
    exitFromChain(message.reason);
    return true;
  };

  const onFrameAck = (message: FrameMessage & { accepted: boolean }, event: MessageEvent): boolean => {
    if (isTopFrame || event.source !== win.parent || sentUp === null || message.requestId !== sentUp) return false;
    if (!message.accepted) {
      // The parent will not pin our <iframe>: exit locally and report a fullscreen error.
      sentUp = null;
      chainReason = "refused";
      exitFromChain("refused");
    }
    return true;
  };

  const onWindowMessage = (event: MessageEvent): void => {
    const message = parseFrameMessage(event.data);
    if (!message) return;
    let handled = false;
    switch (message.type) {
      case "frame-enter":
        handled = onFrameEnter(message, event);
        break;
      case "frame-exit":
        handled = onFrameExit(message, event);
        break;
      case "frame-exit-request":
        handled = onFrameExitRequest(message, event);
        break;
      case "frame-ack":
        handled = onFrameAck(message, event);
        break;
    }
    // Our own protocol: page listeners registered after us do not need to see it.
    if (handled) event.stopImmediatePropagation();
  };

  // -------------------------------------------------------------------------
  // Esc and navigation
  // -------------------------------------------------------------------------

  const isEscape = (event: KeyboardEvent): boolean => event.key === "Escape" || event.key === "Esc";

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!fakeActive || !settings?.exitOnEscape || !isEscape(event) || !event.isTrusted) return;
    // In real fullscreen the browser consumes this Esc; the page never sees it.
    event.preventDefault();
    event.stopImmediatePropagation();
    swallowEscapeUp = true;
    // A popped-out window that is full screen goes back to floating first; the next Esc pops it back in.
    if (bar?.leaveFullScreen()) return;
    toMain({ type: "exit", reason: "escape" });
  };

  /** Is the pointer of `event` in the corner zone of this frame's viewport (the grip's, docs/ARCHITECTURE.md §5)? */
  const cornerOf = (event: Event): boolean => {
    const { clientX, clientY } = event as PointerEvent;
    return inCornerZone(clientX, clientY, win.innerWidth, win.innerHeight);
  };

  /**
   * Pointer activity shows the popped-out window's hover bar, and in the corner zone its grip. The top frame
   * shows them itself; a child frame in a pop-out-mode chain (the video may be in a cross-origin iframe, whose
   * pointer events the top frame never sees) tells the service worker, at most every ACTIVITY_RELAY_MS but at
   * once when the pointer enters or leaves the corner zone, which relays it to the top frame of a popped-out tab
   * and refuses anything else. The chain's <iframe>s are pinned to fill their parents' viewports, so the child's
   * viewport is the popup window's and its corner zone the top frame's.
   */
  const onPointerActivity = (event: Event): void => {
    const corner = cornerOf(event);
    if (isTopFrame) {
      bar?.activity(corner);
      return;
    }
    if (!fakeActive || settings?.mode !== "pop-out" || preferReal) return;
    const now = Date.now();
    if (corner === lastCorner && now - lastActivity < ACTIVITY_RELAY_MS) return;
    lastActivity = now;
    lastCorner = corner;
    void send({ type: "pop-out-activity", corner });
  };

  /** Top frame: the pointer left the window (not just into a child frame), so it left the corner zone too. */
  const onPointerOut = (event: Event): void => {
    if (!isTopFrame || !bar || (event as PointerEvent).relatedTarget !== null) return;
    const { clientX: x, clientY: y } = event as PointerEvent;
    if (x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight) return;
    bar.leave();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!swallowEscapeUp || !isEscape(event)) return;
    swallowEscapeUp = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onPageHide = (): void => {
    if (fakeActive) toMain({ type: "exit", reason: "navigation" });
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) reportSiteState(true);
  };

  const onPrerenderingChange = (): void => reportSiteState(true);

  // Registered at document_start, before any page listener, in the capture phase.
  win.addEventListener("message", onWindowMessage, true);
  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("keyup", onKeyUp, true);
  win.addEventListener("pagehide", onPageHide, true);
  win.addEventListener("pageshow", onPageShow as EventListener, true);
  doc.addEventListener("prerenderingchange", onPrerenderingChange);
  win.addEventListener("pointermove", onPointerActivity, { capture: true, passive: true });
  win.addEventListener("pointerdown", onPointerActivity, { capture: true, passive: true });
  win.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });

  // -------------------------------------------------------------------------
  // Toggle command (§8) and runtime messages
  // -------------------------------------------------------------------------

  const setPreferReal = (value: boolean): void => {
    if (value === preferReal) return;
    preferReal = value;
    pushConfig();
  };

  const toggle = async (): Promise<ContentReplies["command-toggle"]> => {
    if (fakeActive) {
      if (!real) {
        // No user gesture reaches the page from a command: use browser fullscreen and fill the tab.
        const reply = await send({ type: "browser-fullscreen-enter" });
        if (!isOk(reply)) return { handled: false };
        if (!fakeActive) {
          await send({ type: "browser-fullscreen-exit" });
          return { handled: false };
        }
        real = true;
        toMain({ type: "go-real" });
        return { handled: true };
      }
      real = false;
      toMain({ type: "go-fake" });
      await send({ type: "browser-fullscreen-exit" });
      return { handled: true };
    }
    // Idle: arm the other mode for this tab; the service worker tells every frame.
    setPreferReal(!preferReal);
    void send({ type: "set-prefer-real", preferReal });
    return { handled: true };
  };

  // The armed mode belongs to the tab and outlives this document.
  void send({ type: "tab-state" }).then((reply) => {
    if (reply && reply.ok) setPreferReal(reply.preferReal);
  });

  return {
    get state(): IsolatedState {
      return {
        settings,
        fakeActive,
        preferReal,
        real,
        popOut,
        sentUp,
        childRequestId: child?.requestId ?? null,
      };
    },

    applySettings(next) {
      settings = resolveForSite(next, env.hostname);
      pushConfig();
      reportSiteState(false);
    },

    handleRuntimeMessage(message) {
      switch (message.type) {
        case "get-site":
          return isTopFrame ? { hostname: env.hostname, active: fakeActive, preferReal, real } : undefined;
        case "command-toggle":
          return isTopFrame ? toggle() : undefined;
        case "pop-out-released":
          if (!isTopFrame) return undefined;
          popOut = "idle"; // fake fullscreen stays, now effectively fill-tab
          removeBar();
          return { ok: true };
        case "pop-out-leave":
          // "Bring it back" on the placeholder: as Esc, leaving fake fullscreen pops the tab back in.
          if (!isTopFrame) return undefined;
          if (!fakeActive || popOut === "idle") return { handled: false };
          toMain({ type: "exit", reason: "escape" });
          return { handled: true };
        case "pop-out-activity":
          // Pointer activity in a child frame, relayed by the service worker.
          if (!isTopFrame) return undefined;
          bar?.activity(message.corner === true);
          return { ok: true };
        case "browser-fullscreen-released":
          if (!isTopFrame) return undefined;
          if (real) {
            real = false;
            toMain({ type: "go-fake" });
          }
          return { ok: true };
        case "prefer-real-changed":
          setPreferReal(message.preferReal);
          return isTopFrame ? { ok: true } : undefined;
        case "get-site-state":
          return isTopFrame ? { enabled: settings?.enabled ?? null } : undefined;
        default:
          return undefined;
      }
    },

    dispose() {
      unsubscribe();
      win.removeEventListener("message", onWindowMessage, true);
      win.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("keyup", onKeyUp, true);
      win.removeEventListener("pagehide", onPageHide, true);
      win.removeEventListener("pageshow", onPageShow as EventListener, true);
      doc.removeEventListener("prerenderingchange", onPrerenderingChange);
      win.removeEventListener("pointermove", onPointerActivity, true);
      win.removeEventListener("pointerdown", onPointerActivity, true);
      win.removeEventListener("pointerout", onPointerOut, true);
      removeBar();
    },
  };
}
