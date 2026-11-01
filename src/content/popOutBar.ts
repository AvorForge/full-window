/**
 * The popped-out window's hover bar and corner grip (docs/ARCHITECTURE.md §5), drawn by the top frame's
 * ISOLATED script over the faked-fullscreen video while the tab is popped out.
 *
 * Everything sits in a closed shadow root on a host element the page's CSS cannot reach: the host's own
 * declarations are inline and !important, the shadow's rules a constructed stylesheet (not a <style> element,
 * which a page's CSP could block), and the icons are built with createElementNS (no innerHTML, which Trusted
 * Types would refuse). The host is a manual popover, so it is in the top layer, above any z-index; where
 * popovers are missing it falls back to the highest z-index.
 *
 * The bar shows on pointer activity (in this document, or relayed from a child frame by the service worker) and
 * hides HIDE_DELAY_MS after the last one, unless the pointer is over the bar or grip, a grip drag is going on or
 * keyboard focus is in it. The grip shows with it only while the pointer is in the corner zone (inCornerZone) or
 * a grip drag is going on; hidden, it takes no pointer events, so a click there reaches the player's own corner
 * controls. The grip resizes the window: pointer capture, screenX/screenY deltas from the start of the drag, at
 * least POP_OUT_MIN_SIZE, one resize request in flight and the rest coalesced to the latest.
 */

import { POP_OUT_MIN_SIZE, type PopOutWindowAction } from "../shared/messages";
import { MAX_Z_INDEX } from "./styling";

/** How long the bar stays after the pointer stops or leaves. */
export const HIDE_DELAY_MS = 2000;
/** The fade-out's length: the popover leaves the top layer after it. */
const FADE_MS = 180;

/** The grip shows while the pointer is within this many px of the viewport's right edge and of its bottom edge. */
export const CORNER_ZONE_PX = 56;

/** Is the point (x, y), in viewport px, in the corner zone of a width x height viewport? */
export function inCornerZone(x: number, y: number, width: number, height: number): boolean {
  const right = width - x;
  const bottom = height - y;
  return right >= 0 && right <= CORNER_ZONE_PX && bottom >= 0 && bottom <= CORNER_ZONE_PX;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The bar's buttons; the words are the owner's (tooltip and accessible name alike). */
export const BAR_LABELS = {
  popBackIn: "Pop back in",
  fullScreen: "Full screen",
  exitFullScreen: "Exit full screen",
  minimize: "Minimize",
} as const;

/** 24 x 24 line icons, stroked in currentColor. */
const ICONS = {
  // A window with an arrow into its small inner window, bottom left.
  popBackIn: ["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M6 13h5v3H6z", "M17.5 8.5 12.5 13.5", "M12.5 10v3.5H16"],
  // Four corners, outwards.
  fullScreen: ["M4 9V6a2 2 0 0 1 2-2h3", "M15 4h3a2 2 0 0 1 2 2v3", "M20 15v3a2 2 0 0 1-2 2h-3", "M9 20H6a2 2 0 0 1-2-2v-3"],
  // Four corners, inwards.
  exitFullScreen: ["M9 4v3a2 2 0 0 1-2 2H4", "M20 9h-3a2 2 0 0 1-2-2V4", "M15 20v-3a2 2 0 0 1 2-2h3", "M4 15h3a2 2 0 0 1 2 2v3"],
  minimize: ["M6 12h12"],
  grip: ["M20 10 10 20", "M20 15.5 15.5 20"],
} as const;

type IconName = keyof typeof ICONS;

const STYLES = `
:host { all: initial; }
.bar, .grip {
  position: fixed;
  box-sizing: border-box;
  color: #fff;
  background: rgba(30, 30, 32, 0.72);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14) inset, 0 4px 16px rgba(0, 0, 0, 0.28);
  opacity: 0;
  visibility: hidden;
  transition: opacity ${FADE_MS}ms ease, visibility 0s linear ${FADE_MS}ms, transform ${FADE_MS}ms ease;
}
.bar {
  pointer-events: auto;
  top: 10px;
  left: 50%;
  transform: translate(-50%, -4px);
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
}
:host([data-shown]) .bar, :host([data-shown][data-grip]) .grip {
  opacity: 1;
  visibility: visible;
  transition: opacity ${FADE_MS}ms ease, visibility 0s, transform ${FADE_MS}ms ease;
}
:host([data-shown]) .bar { transform: translate(-50%, 0); }
button {
  all: unset;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  color: inherit;
  cursor: default;
  transition: background-color 120ms ease;
}
button:hover { background: rgba(255, 255, 255, 0.16); }
button:active { background: rgba(255, 255, 255, 0.26); }
button:focus-visible { outline: 2px solid rgba(255, 255, 255, 0.9); outline-offset: -2px; }
svg {
  display: block;
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/*
 * Flush with the corner and small, so it covers as little of a player's own corner controls as it can, and only
 * while the pointer is near the corner. Hidden (also while it fades), it takes no pointer events.
 */
.grip {
  pointer-events: none;
  right: 0;
  bottom: 0;
  width: 22px;
  height: 22px;
  border-radius: 11px 0 0 0;
  display: grid;
  place-items: end;
  padding: 0 3px 3px 0;
  cursor: nwse-resize;
  touch-action: none;
}
.grip svg { width: 14px; height: 14px; stroke-width: 1.6; }
:host([data-shown][data-grip]) .grip { pointer-events: auto; }
@media (prefers-reduced-motion: reduce) {
  .bar, .grip, :host([data-shown]) .bar, :host([data-shown][data-grip]) .grip, button { transition: none; }
  .bar, :host([data-shown]) .bar { transform: translate(-50%, 0); }
}
`;

export interface PopOutBarActions {
  /** "Pop back in": leave fake fullscreen, as Esc does. */
  popBackIn(): void;
  /** Full screen, back to floating, minimized: the popup window's state. Resolves to whether it was done. */
  windowAction(action: PopOutWindowAction): Promise<boolean>;
  /** Resize the popup window to width x height (outer px). Resolves when the service worker has answered. */
  resize(width: number, height: number): Promise<unknown>;
}

export interface PopOutBar {
  /**
   * Pointer activity: show the bar, and hide it HIDE_DELAY_MS after the last. `corner`: the pointer is in the
   * corner zone (inCornerZone), so the grip shows too; false hides the grip at once.
   */
  activity(corner: boolean): void;
  /** The pointer left the window: the grip goes at once (the bar keeps its own timer). */
  leave(): void;
  /** The popup window is full screen (the bar's button and Esc go back to floating). */
  readonly fullScreen: boolean;
  /** Esc while full screen: back to the floating window. Returns false if not full screen (Esc pops back in). */
  leaveFullScreen(): boolean;
  readonly shown: boolean;
  /** The grip is shown (the bar is, and the pointer is in the corner zone or dragging the grip). */
  readonly gripShown: boolean;
  remove(): void;
}

/** Builds the bar and grip in `doc`, hidden until the first activity. */
export function createPopOutBar(win: Window, doc: Document, actions: PopOutBarActions): PopOutBar {
  const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  const hostStyle: Array<[string, string]> = [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["inset", "0"],
    ["width", "auto"],
    ["height", "auto"],
    ["max-width", "none"],
    ["max-height", "none"],
    ["margin", "0"],
    ["padding", "0"],
    ["border", "0"],
    ["background", "transparent"],
    ["overflow", "visible"],
    ["pointer-events", "none"],
    ["z-index", MAX_Z_INDEX],
    ["color-scheme", "dark"],
  ];
  for (const [property, value] of hostStyle) host.style.setProperty(property, value, "important");
  const popover = typeof (host as { showPopover?: unknown }).showPopover === "function";
  if (popover) host.setAttribute("popover", "manual");
  const shadow = host.attachShadow({ mode: "closed" });
  try {
    const sheet = new (win as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    // No constructed stylesheets (old engines, test DOMs): unstyled but working.
  }

  const icon = (name: IconName): SVGSVGElement => {
    const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of ICONS[name]) {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };

  const button = (part: string, label: string, name: IconName, onClick: () => void): HTMLButtonElement => {
    const element = doc.createElement("button");
    element.type = "button";
    element.setAttribute("part", part);
    element.dataset.action = part;
    setLabel(element, label);
    element.append(icon(name));
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return element;
  };

  const setLabel = (element: HTMLElement, label: string): void => {
    element.title = label;
    element.setAttribute("aria-label", label);
  };

  let fullScreen = false;
  const setFullScreen = (value: boolean): void => {
    fullScreen = value;
    setLabel(fullScreenButton, value ? BAR_LABELS.exitFullScreen : BAR_LABELS.fullScreen);
    fullScreenButton.replaceChildren(icon(value ? "exitFullScreen" : "fullScreen"));
  };

  const bar = doc.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "toolbar");
  const popBackInButton = button("pop-back-in", BAR_LABELS.popBackIn, "popBackIn", () => actions.popBackIn());
  const fullScreenButton = button("full-screen", BAR_LABELS.fullScreen, "fullScreen", () => {
    const next = !fullScreen;
    void actions.windowAction(next ? "fullscreen" : "normal").then((done) => {
      if (done) setFullScreen(next);
    });
  });
  const minimizeButton = button("minimize", BAR_LABELS.minimize, "minimize", () => {
    void actions.windowAction("minimized").then((done) => {
      if (done) setFullScreen(false);
    });
  });
  bar.append(popBackInButton, fullScreenButton, minimizeButton);

  const grip = doc.createElement("div");
  grip.className = "grip";
  grip.setAttribute("part", "grip");
  grip.setAttribute("aria-hidden", "true");
  grip.append(icon("grip"));
  shadow.append(bar, grip);

  // ---------------------------------------------------------------------------
  // Showing and hiding
  // ---------------------------------------------------------------------------

  let shown = false;
  let hovering = false;
  let focused = false;
  let dragging = false;
  /** The pointer is in the corner zone, as last reported. */
  let corner = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  const held = (): boolean => hovering || focused || dragging;

  const mount = (): void => {
    if (!host.isConnected) (doc.documentElement ?? doc).append(host);
    if (!popover) return;
    try {
      // Re-entering puts it above anything the page put in the top layer since.
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // Not connected or not a popover any more (the page took it apart): z-index still applies.
    }
  };

  const gripShown = (): boolean => shown && (corner || dragging);

  /** The grip's attribute follows the bar, the corner zone and a drag. */
  const updateGrip = (): void => {
    if (gripShown()) host.setAttribute("data-grip", "");
    else host.removeAttribute("data-grip");
  };

  const show = (): void => {
    clearTimeout(leaveTimer);
    if (!shown) {
      shown = true;
      mount();
      host.setAttribute("data-shown", "");
    }
    updateGrip();
  };

  const hide = (): void => {
    if (!shown) return;
    shown = false;
    host.removeAttribute("data-shown");
    updateGrip();
    // After the fade, out of the top layer, so nothing of ours is above the page while hidden.
    leaveTimer = setTimeout(() => {
      if (popover && !shown) {
        try {
          host.hidePopover();
        } catch {
          // already closed
        }
      }
    }, FADE_MS);
  };

  const scheduleHide = (): void => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!held()) hide();
    }, HIDE_DELAY_MS);
  };

  const activity = (inCorner: boolean): void => {
    corner = inCorner;
    show();
    scheduleHide();
  };

  const leave = (): void => {
    corner = false;
    updateGrip();
  };

  for (const element of [bar, grip]) {
    element.addEventListener("pointerenter", () => {
      hovering = true;
      show();
    });
    element.addEventListener("pointerleave", () => {
      hovering = false;
      scheduleHide();
    });
  }
  bar.addEventListener("focusin", () => {
    focused = true;
    show();
  });
  bar.addEventListener("focusout", (event) => {
    if (bar.contains(event.relatedTarget as Node | null)) return;
    focused = false;
    scheduleHide();
  });

  // ---------------------------------------------------------------------------
  // The corner grip
  // ---------------------------------------------------------------------------

  let drag: { pointerId: number; x: number; y: number; width: number; height: number } | null = null;
  let inFlight = false;
  let pending: { width: number; height: number } | null = null;

  const send = (size: { width: number; height: number }): void => {
    if (inFlight) {
      pending = size;
      return;
    }
    inFlight = true;
    void actions
      .resize(size.width, size.height)
      .catch(() => undefined)
      .then(() => {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next) send(next);
      });
  };

  const sizeAt = (event: PointerEvent): { width: number; height: number } | null => {
    if (!drag) return null;
    return {
      width: Math.max(POP_OUT_MIN_SIZE.width, Math.round(drag.width + event.screenX - drag.x)),
      height: Math.max(POP_OUT_MIN_SIZE.height, Math.round(drag.height + event.screenY - drag.y)),
    };
  };

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, width: win.outerWidth, height: win.outerHeight };
    dragging = true;
    show();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // the pointer is gone already
    }
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const size = sizeAt(event);
    if (size) send(size);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.type === "pointerup") {
      const size = sizeAt(event);
      if (size) send(size);
    }
    drag = null;
    dragging = false;
    updateGrip();
    scheduleHide();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("lostpointercapture", endDrag);

  return {
    activity,
    leave,
    get fullScreen() {
      return fullScreen;
    },
    get shown() {
      return shown;
    },
    get gripShown() {
      return gripShown();
    },
    leaveFullScreen() {
      if (!fullScreen) return false;
      setFullScreen(false);
      void actions.windowAction("normal");
      return true;
    },
    remove() {
      clearTimeout(hideTimer);
      clearTimeout(leaveTimer);
      if (popover) {
        try {
          host.hidePopover();
        } catch {
          // not open
        }
      }
      host.remove();
    },
  };
}
