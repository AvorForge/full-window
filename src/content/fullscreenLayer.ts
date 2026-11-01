/**
 * The real FullscreenPatchLayer (docs/ARCHITECTURE.md §2-§4).
 *
 * Replaces the Fullscreen API on the prototypes that own it, at
 * document_start. Once settings arrive and say so, a fullscreen request pins
 * the element to the configured rectangle (styling.ts) instead of entering
 * real fullscreen, and every getter, event, promise and :fullscreen match
 * tells the page it is fullscreen. Disabled sites, `preferReal` and real
 * fullscreen in progress pass every call through to the captured originals.
 */

import { computePinRect, fromRootX, fromRootY, toRootX, toRootY, type CoordinateSpace } from "../shared/geometry";
import type { ExitReason, ShimConfig } from "../shared/messages";
import { HTML_NS, SVG_NS, call, captureDom, createDisguise, findProperty, type AnyFunction, type Disguise, type DomNatives } from "./natives";
import type { FullscreenPatchLayer, PatchContext } from "./patchLayer";
import { rewriteSelectorArgument } from "./selectors";
import { pinElement, type Pin, type PinOptions } from "./styling";

/** How long a request that arrives before the first config is held (§1 "Before settings arrive"). */
export const CONFIG_WAIT_MS = 250;

export type RequestType = "unprefixed" | "prefixed";

const CHANGE_EVENT: Record<RequestType, string> = { unprefixed: "fullscreenchange", prefixed: "webkitfullscreenchange" };
const ERROR_EVENT: Record<RequestType, string> = { unprefixed: "fullscreenerror", prefixed: "webkitfullscreenerror" };
const REAL_CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"];
const REAL_ERROR_EVENTS = ["fullscreenerror", "webkitfullscreenerror"];

/** Chromium's rejection messages (checked against Chromium 145, docs/ARCHITECTURE.md §2 step 2). */
export const ELEMENT_TYPE_ERROR = "Element is not an HTML or SVG element";
export const DIALOG_ERROR = "Dialog elements are invalid";
export const NOT_CONNECTED_ERROR = "Element is not connected";
export const POLICY_ERROR = "Disallowed by permissions policy";
export const PERMISSION_ERROR = "Permissions check failed";
export const NOT_ACTIVE_ERROR = "Failed to execute 'exitFullscreen' on 'Document': Document not active";

const NAVIGATION_UI = ["auto", "show", "hide"];
const construct = Reflect.construct;
const HAVE_METADATA = 1;

interface QueuedEvent {
  type: string;
  target: Element;
  change: boolean;
  cancelled: boolean;
  dispatched: boolean;
}

interface Active {
  element: Element;
  type: RequestType;
  requestId: string;
  pin: Pin;
  enterEvent: QueuedEvent;
  removal: { disconnect(): void };
}

export interface FullscreenLayerOptions {
  /** Hold time for requests before the first config, in ms (tests shorten it). */
  configWaitMs?: number;
}

export interface FullscreenLayerInspection {
  readonly element: Element | null;
  readonly requestType: RequestType | null;
  readonly requestId: string | null;
  readonly real: boolean;
  readonly config: ShimConfig | null;
}

export interface RealFullscreenPatchLayer extends FullscreenPatchLayer {
  /** Read-only view of the state, for tests and debugging. */
  readonly inspect: FullscreenLayerInspection;
}

export function createFullscreenPatchLayer(options: FullscreenLayerOptions = {}): RealFullscreenPatchLayer {
  const configWaitMs = options.configWaitMs ?? CONFIG_WAIT_MS;
  let n: DomNatives;
  let win: Window & typeof globalThis;
  let doc: Document;
  let notify: PatchContext["notify"] = () => undefined;
  let disguise: Disguise | null = null;
  let installed = false;
  let config: ShimConfig | null = null;
  let active: Active | null = null;
  let real = false;
  const held: Array<() => void> = [];
  let holdTimer: unknown = null;
  const queue: QueuedEvent[] = [];
  let frameScheduled = false;
  let originalFullscreenElement: AnyFunction | undefined;
  let originalFullscreenEnabled: AnyFunction | undefined;
  let originalExitFullscreen: AnyFunction | undefined;
  /** A request of the page's own script reached the real API (pass-through): the real fullscreen it starts is the page's. */
  let pageRealRequest = false;
  /** A real fullscreen the page did not ask for, being left so that its element goes fake-fullscreen instead. */
  let adopting: { element: Element; type: RequestType; leave: boolean } | null = null;
  /** The change event of leaving that real fullscreen is still to come: the page does not see it. */
  let swallowRealExit = false;
  const videoProbe = new Map<AnyFunction, { name: string; message: string } | null>();
  const onResize = (): void => {
    if (active) updatePin();
  };
  let coordinatesInstalled = false;

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  const passThrough = (): boolean => !installed || config === null || !config.enabled || config.preferReal;

  /** The document's real fullscreen element (original getter), or null. */
  const realElement = (): unknown => (originalFullscreenElement ? call(originalFullscreenElement, doc) ?? null : null);

  const pinOptions = (): PinOptions => {
    const current = config as ShimConfig;
    const mode = !current.topFrame || real ? "fill-tab" : current.mode;
    return { rect: computePinRect({ mode, customRect: current.customRect }, n.viewport()), backgroundColor: current.backgroundColor };
  };

  const scheduleFrame = (): void => {
    if (frameScheduled) return;
    frameScheduled = true;
    n.requestAnimationFrame(flushEvents);
  };

  /** Queues an event for the next animation frame (spec: "update the rendering"). */
  const queueEvent = (type: string, target: Element, change: boolean): QueuedEvent => {
    const event: QueuedEvent = { type, target, change, cancelled: false, dispatched: false };
    queue.push(event);
    scheduleFrame();
    return event;
  };

  function flushEvents(): void {
    frameScheduled = false;
    let changed = false;
    for (const event of queue.splice(0)) {
      if (event.cancelled) continue;
      event.dispatched = true;
      // Dispatched on the element so it bubbles (composed) to the document and window; on the document if removed.
      const target = n.isConnected(event.target) && n.ownerDocument(event.target) === doc ? event.target : doc;
      n.dispatchEvent(target, n.event(event.type, { bubbles: true, composed: true }));
      changed ||= event.change;
    }
    // Real fullscreen always resizes the viewport and players recompute layout on resize.
    if (changed) n.dispatchEvent(win, n.event("resize"));
  }

  const hold = (run: () => void): void => {
    held.push(run);
    if (holdTimer === null) holdTimer = n.setTimeout(flushHeld, configWaitMs);
  };

  function flushHeld(): void {
    if (holdTimer !== null) n.clearTimeout(holdTimer);
    holdTimer = null;
    for (const run of held.splice(0)) run();
  }

  // -------------------------------------------------------------------------
  // Enter / exit
  // -------------------------------------------------------------------------

  const watchRemoval = (element: Element, pin: Pin): { disconnect(): void } => {
    const observer = n.mutationObserver(() => {
      if (!active || active.element !== element) return;
      if (!n.isConnected(element) || n.ownerDocument(element) !== doc) {
        exitActive("removed");
      } else if (pin.refresh()) {
        // Re-parented (some players move the video into a fullscreen container): watch the new roots.
        active.removal.disconnect();
        active.removal = watchRemoval(element, pin);
      }
    });
    for (const root of pin.roots()) observer.observe(root, { childList: true, subtree: true });
    return observer;
  };

  /** Releases the active element without events (replacement, exit, uninstall). */
  const release = (): Active | null => {
    const current = active;
    if (!current) return null;
    active = null;
    current.removal.disconnect();
    current.pin.restore();
    return current;
  };

  const enter = (element: Element, type: RequestType, requestId: string): void => {
    // Another element is fake-fullscreen: the new one replaces it (Chromium's stack; players only use the top).
    release();
    const pin = pinElement(n, element, pinOptions());
    const enterEvent = queueEvent(CHANGE_EVENT[type], element, true);
    active = { element, type, requestId, pin, enterEvent, removal: { disconnect: () => undefined } };
    active.removal = watchRemoval(element, pin);
    syncCoordinates();
    notify({ type: "entered", requestId, mode: (config as ShimConfig).mode });
  };

  const exitActive = (reason: ExitReason): void => {
    const current = release();
    if (!current) return;
    real = false;
    if (reason === "refused" && !current.enterEvent.dispatched) {
      // The page has not been told about the enter yet: it becomes a plain request error.
      current.enterEvent.cancelled = true;
      queueEvent(ERROR_EVENT[current.type], current.element, false);
    } else {
      queueEvent(CHANGE_EVENT[current.type], current.element, true);
      if (reason === "refused") queueEvent(ERROR_EVENT[current.type], current.element, false);
    }
    notify({ type: "exited", reason });
  };

  // -------------------------------------------------------------------------
  // Request steps
  // -------------------------------------------------------------------------

  const fullscreenEnabled = (): boolean => (originalFullscreenEnabled ? call(originalFullscreenEnabled, doc) === true : true);

  /** The browser's checks (§2 step 2), in Chromium's order; returns the rejection message or null. */
  const validate = (element: Element): string | null => {
    const namespace = n.namespaceURI(element);
    const name = n.localName(element);
    if (namespace !== HTML_NS && !(namespace === SVG_NS && name === "svg")) return ELEMENT_TYPE_ERROR;
    if (namespace === HTML_NS && name === "dialog") return DIALOG_ERROR;
    if (!n.isConnected(element)) return NOT_CONNECTED_ERROR;
    if (!fullscreenEnabled()) return POLICY_ERROR;
    if (!n.userActivationActive()) return PERMISSION_ERROR;
    return null;
  };

  /** WebIDL conversion of the FullscreenOptions argument. */
  const optionsError = (value: unknown): TypeError | null => {
    if (value === undefined || value === null) return null;
    const prefix = "Failed to execute 'requestFullscreen' on 'Element': ";
    if (typeof value !== "object" && typeof value !== "function") {
      return n.typeError(`${prefix}The provided value is not of type 'FullscreenOptions'.`);
    }
    const navigationUI = (value as { navigationUI?: unknown }).navigationUI;
    if (navigationUI !== undefined && !NAVIGATION_UI.includes(String(navigationUI))) {
      return n.typeError(
        `${prefix}Failed to read the 'navigationUI' property from 'FullscreenOptions': The provided value '${String(navigationUI)}' is not a valid enum value of type FullscreenNavigationUI.`,
      );
    }
    return null;
  };

  /** Calls the original request: the real fullscreen it may start is the page's own (not adopted, §2). */
  const passRequest = (original: AnyFunction, self: unknown, args: unknown[]): unknown => {
    pageRealRequest = true;
    try {
      return call(original, self, args);
    } catch (error) {
      pageRealRequest = false;
      throw error;
    }
  };

  const handleRequest = (original: AnyFunction, self: unknown, args: unknown[], type: RequestType): unknown => {
    if (passThrough() || !n.isElement(self) || n.ownerDocument(self) !== doc || realElement() !== null) {
      return passRequest(original, self, args);
    }
    const element = self;
    if (type === "unprefixed") {
      let conversion: TypeError | null;
      try {
        conversion = optionsError(args[0]);
      } catch (error) {
        return n.rejected(error);
      }
      if (conversion) return n.rejected(conversion);
    }
    const error = validate(element);
    if (error !== null) {
      queueEvent(ERROR_EVENT[type], element, false);
      return type === "unprefixed" ? n.rejected(n.typeError(error)) : undefined;
    }
    if (active?.element !== element) enter(element, type, n.randomId());
    return type === "unprefixed" ? n.resolved(undefined) : undefined;
  };

  /** Runs `handle` now, or holds it until the first config (or the timeout, then it passes through). */
  const request = (handle: () => unknown, type: RequestType): unknown => {
    if (!installed || config !== null) return handle();
    if (type === "unprefixed") {
      return n.promise((resolve, reject) =>
        hold(() => {
          try {
            resolve(handle());
          } catch (error) {
            reject(error);
          }
        }),
      );
    }
    hold(() => {
      try {
        handle();
      } catch {
        // The prefixed call already returned undefined to the page.
      }
    });
    return undefined;
  };

  /**
   * Older Chromium threw InvalidStateError from webkitEnterFullscreen() on a
   * video without loaded media. Probe the original once on a video in an inert
   * document (no page-visible effect) and throw the same where it would.
   */
  const videoError = (original: AnyFunction, video: Element): DOMException | null => {
    if (n.readyState(video) >= HAVE_METADATA) return null;
    if (!videoProbe.has(original)) {
      let result: { name: string; message: string } | null = null;
      const probe = n.inertVideo();
      if (probe) {
        try {
          call(original, probe);
        } catch (error) {
          const e = error as { name?: unknown; message?: unknown };
          result = { name: String(e.name ?? "InvalidStateError"), message: String(e.message ?? "") };
        }
      }
      videoProbe.set(original, result);
    }
    const thrown = videoProbe.get(original);
    return thrown ? n.domException(thrown.message, thrown.name) : null;
  };

  const handleVideoRequest = (original: AnyFunction, self: unknown, args: unknown[]): unknown => {
    if (passThrough() || !n.isElement(self) || n.ownerDocument(self) !== doc || realElement() !== null) {
      return passRequest(original, self, args);
    }
    const thrown = videoError(original, self);
    if (thrown) throw thrown;
    return handleRequest(original, self, args, "prefixed");
  };

  // -------------------------------------------------------------------------
  // Real fullscreen the page did not ask for (§2 "Native video controls")
  // -------------------------------------------------------------------------

  /** A media element, or an element with one inside. */
  const isMediaPlayer = (element: Element): boolean => {
    const name = n.localName(element);
    if (n.namespaceURI(element) === HTML_NS && (name === "video" || name === "audio")) return true;
    return n.querySelectorAll(element, "video, audio").length > 0;
  };

  /** Once the real fullscreen is left: the element goes fake-fullscreen (or, if it already was, leaves it). */
  const finishAdopting = (): void => {
    const pending = adopting;
    if (!pending || realElement() !== null) return;
    adopting = null;
    if (pending.leave) {
      if (active?.element === pending.element) exitActive("api");
      return;
    }
    if (passThrough() || !n.isConnected(pending.element) || n.ownerDocument(pending.element) !== doc) return;
    enter(pending.element, pending.type, n.randomId());
    // Focus is still on the controls' fullscreen button, and Chromium keeps key events inside its media controls:
    // not even a window capture listener sees them, so Esc would reach neither the page nor us (§2).
    if (n.activeElement() === pending.element) n.blur(pending.element);
  };

  /**
   * The browser's own <video controls> fullscreen button requests fullscreen from the UA shadow DOM, not
   * through page script, so no replacement sees it: the document just goes really fullscreen. This listener
   * (window, capture phase, registered before any page listener) sees its change event first. When the
   * extension fakes fullscreen here and the element is a media player, it hides that event from the page,
   * leaves real fullscreen (no user activation needed), hides that change event too, and then enters fake
   * fullscreen on the element, which queues the same change event (and resize) a request through the shim
   * does. Clicked again on the fake-fullscreen element, it leaves fake fullscreen, as the button would.
   */
  const onRealChange = (event: Event): void => {
    // Only the browser's own events (isTrusted is an unforgeable own property): ours and the page's are not.
    if (event.isTrusted !== true) return;
    const current = realElement();
    if (adopting || swallowRealExit) {
      n.stopImmediatePropagation(event);
      if (current !== null && adopting) return; // still real: the exit's own change event follows
      swallowRealExit = false;
      finishAdopting();
      adopting = null; // still real after our exit (a nested real fullscreen): leave it to the browser
      return;
    }
    if (current === null) {
      pageRealRequest = false;
      return;
    }
    if (pageRealRequest || passThrough() || real || !originalExitFullscreen) return;
    const origin = n.eventOrigin(event);
    const element = n.isElement(origin) && n.ownerDocument(origin) === doc ? origin : current;
    if (!n.isElement(element) || !isMediaPlayer(element)) return;
    n.stopImmediatePropagation(event);
    adopting = { element, type: n.eventType(event) === "fullscreenchange" ? "unprefixed" : "prefixed", leave: active?.element === element };
    swallowRealExit = true;
    let result: unknown;
    try {
      result = call(originalExitFullscreen, doc);
    } catch {
      adopting = null;
      swallowRealExit = false;
      return;
    }
    n.onSettled(result, (fulfilled) => {
      if (fulfilled) {
        finishAdopting();
      } else {
        adopting = null;
        swallowRealExit = false;
      }
    });
  };

  const onRealError = (event: Event): void => {
    if (event.isTrusted === true) pageRealRequest = false;
  };

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /** The fake element retargeted to the document: its outermost shadow host in the document tree. */
  const retargetToDocument = (element: Element): Element => {
    let node: Element = element;
    for (;;) {
      const host = n.shadowHost(n.rootNode(node));
      if (!host) return node;
      node = host;
    }
  };

  /** The fake element retargeted to `root`, or null if it is not inside that shadow root. */
  const retargetToRoot = (element: Element, root: unknown): Element | null => {
    let node: Element = element;
    for (;;) {
      const nodeRoot = n.rootNode(node);
      if (nodeRoot === root) return node;
      const host = n.shadowHost(nodeRoot);
      if (!host) return null;
      node = host;
    }
  };

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /** Names already replaced per owner, so a member reached from two starting prototypes is wrapped once. */
  const patched = new Map<object, Set<string>>();

  const replaceMethod = (start: object | undefined, name: string, body: (original: AnyFunction, self: unknown, args: unknown[]) => unknown): void => {
    const found = findProperty(start, name);
    if (!found || typeof found.descriptor.value !== "function" || !disguise) return;
    const names = patched.get(found.owner) ?? new Set<string>();
    if (names.has(name)) return;
    names.add(name);
    patched.set(found.owner, names);
    const original = found.descriptor.value as AnyFunction;
    // Shorthand method: no `prototype`, not constructible, like a native method.
    const replacement = {
      [name](this: unknown, ...args: unknown[]) {
        return body(original, this, args);
      },
    }[name] as AnyFunction;
    disguise.replace(found, "value", replacement);
  };

  const replaceGetter = (start: object | undefined, name: string, body: (original: AnyFunction, self: unknown) => unknown): void => {
    const found = findProperty(start, name);
    const original = found?.descriptor.get as AnyFunction | undefined;
    if (!found || typeof original !== "function" || !disguise) return;
    const getter = Object.getOwnPropertyDescriptor(
      {
        get [name]() {
          return body(original, this as unknown);
        },
      },
      name,
    )?.get as AnyFunction;
    disguise.replace(found, "get", getter);
  };

  // -------------------------------------------------------------------------
  // A scaled element's coordinate space (§3 "One coordinate space while scaled")
  // -------------------------------------------------------------------------

  /** The pinned element's coordinate space while it is scaled, else null (every replacement below is then a no-op). */
  const space = (): CoordinateSpace | null => active?.pin.space() ?? null;

  /**
   * While <html> or a container is scaled onto a custom rectangle (styling.ts scalesToRect), the page lays out
   * in the element's unscaled box but the browser reports pointer positions and getBoundingClientRect() on
   * screen. Players that combine the two (seek bars, volume sliders, tooltips positioned from a rect) are off by
   * the scale. These replacements give the page both in the element's space, as in real fullscreen, where screen
   * and layout agree. Installed on the first scaled pin only, so pages that never need them never pay for them.
   */
  const installCoordinates = (): void => {
    if (coordinatesInstalled || !disguise) return;
    coordinatesInstalled = true;
    const MouseEventProto = win.MouseEvent?.prototype;
    const TouchProto = win.Touch?.prototype;
    const DOMRectCtor = win.DOMRect;
    const originalClientX = findProperty(MouseEventProto, "clientX")?.descriptor.get as AnyFunction | undefined;
    const originalClientY = findProperty(MouseEventProto, "clientY")?.descriptor.get as AnyFunction | undefined;
    const trusted = (event: unknown): boolean => (event as Event).isTrusted === true; // unforgeable own property
    const number = (value: unknown): value is number => typeof value === "number";

    // Trusted mouse, pointer, wheel and drag events (synthetic ones a page creates already use its own space).
    const eventGetter = (name: string, convert: (s: CoordinateSpace, value: number, self: unknown) => number): void =>
      replaceGetter(MouseEventProto, name, (original, self) => {
        const value = call(original, self);
        const current = space();
        return current && number(value) && trusted(self) ? convert(current, value, self) : value;
      });
    const pageOffset = (getter: AnyFunction | undefined, self: unknown, value: number): number => {
      const client = getter ? call(getter, self) : value;
      return number(client) ? value - client : 0;
    };
    eventGetter("clientX", toRootX);
    eventGetter("clientY", toRootY);
    eventGetter("x", toRootX);
    eventGetter("y", toRootY);
    eventGetter("pageX", (s, value, self) => {
      const offset = pageOffset(originalClientX, self, value);
      return toRootX(s, value - offset) + offset;
    });
    eventGetter("pageY", (s, value, self) => {
      const offset = pageOffset(originalClientY, self, value);
      return toRootY(s, value - offset) + offset;
    });
    eventGetter("movementX", (s, value) => value / s.scale);
    eventGetter("movementY", (s, value) => value / s.scale);
    for (const [name, convert] of [
      ["clientX", toRootX],
      ["clientY", toRootY],
      ["pageX", toRootX],
      ["pageY", toRootY],
    ] as const) {
      replaceGetter(TouchProto, name, (original, self) => {
        const value = call(original, self);
        const current = space();
        return current && number(value) ? convert(current, value) : value;
      });
    }

    // Element boxes, for elements of this document (a detached element's empty rect stays empty).
    replaceMethod(win.Element?.prototype, "getBoundingClientRect", (original, self, args) => {
      const rect = call<DOMRect>(original, self, args);
      const current = space();
      if (!current || !DOMRectCtor || !n.isElement(self) || !n.isConnected(self) || n.ownerDocument(self) !== doc) return rect;
      return construct(DOMRectCtor, [
        toRootX(current, rect.x),
        toRootY(current, rect.y),
        rect.width / current.scale,
        rect.height / current.scale,
      ]) as DOMRect;
    });

    // Hit testing from page coordinates: back on screen for the browser.
    for (const proto of [Object.getPrototypeOf(doc) as object, win.ShadowRoot?.prototype]) {
      for (const name of ["elementFromPoint", "elementsFromPoint"]) {
        replaceMethod(proto, name, (original, self, args) => {
          const current = space();
          if (current && number(args[0]) && number(args[1])) args = [fromRootX(current, args[0]), fromRootY(current, args[1]), ...args.slice(2)];
          return call(original, self, args);
        });
      }
    }
  };

  /** Installs the coordinate replacements the first time a pin is scaled. */
  const syncCoordinates = (): void => {
    if (!coordinatesInstalled && space()) installCoordinates();
  };

  const updatePin = (): void => {
    if (!active) return;
    active.pin.update(pinOptions());
    syncCoordinates();
  };

  const layer: RealFullscreenPatchLayer = {
    name: "fullscreen",
    inspect: {
      get element() {
        return active?.element ?? null;
      },
      get requestType() {
        return active?.type ?? null;
      },
      get requestId() {
        return active?.requestId ?? null;
      },
      get real() {
        return real;
      },
      get config() {
        return config;
      },
    },

    install(context) {
      if (installed) return;
      win = context.window;
      doc = win.document;
      notify = context.notify;
      n = captureDom(win); // before any replacement, so internals use the originals
      disguise = createDisguise(win);
      installed = true;

      const ElementProto = win.Element?.prototype;
      // Walk from the document's own prototype, so members are found on the prototype it really inherits from.
      const DocumentProto = Object.getPrototypeOf(doc) as object;
      const FragmentProto = win.DocumentFragment?.prototype;
      const ShadowRootProto = win.ShadowRoot?.prototype;
      const VideoProto = win.HTMLVideoElement?.prototype;
      originalFullscreenElement = (findProperty(DocumentProto, "fullscreenElement") ?? findProperty(DocumentProto, "webkitFullscreenElement"))
        ?.descriptor.get as AnyFunction | undefined;
      originalFullscreenEnabled = (findProperty(DocumentProto, "fullscreenEnabled") ?? findProperty(DocumentProto, "webkitFullscreenEnabled"))
        ?.descriptor.get as AnyFunction | undefined;
      originalExitFullscreen = (findProperty(DocumentProto, "exitFullscreen") ?? findProperty(DocumentProto, "webkitExitFullscreen"))?.descriptor
        .value as AnyFunction | undefined;

      // Requests. Only members the browser has are replaced: players feature-detect prefixed APIs.
      replaceMethod(ElementProto, "requestFullscreen", (original, self, args) =>
        request(() => handleRequest(original, self, args, "unprefixed"), "unprefixed"),
      );
      for (const name of ["webkitRequestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen"]) {
        replaceMethod(ElementProto, name, (original, self, args) => request(() => handleRequest(original, self, args, "prefixed"), "prefixed"));
      }
      for (const name of ["webkitEnterFullscreen", "webkitEnterFullScreen"]) {
        replaceMethod(VideoProto, name, (original, self, args) => request(() => handleVideoRequest(original, self, args), "prefixed"));
      }

      // Exits.
      replaceMethod(DocumentProto, "exitFullscreen", (original, self, args) => {
        if (self === doc && active && realElement() === null) {
          exitActive("api");
          return n.resolved(undefined);
        }
        if (self === doc && !passThrough() && realElement() === null) return n.rejected(n.typeError(NOT_ACTIVE_ERROR));
        return call(original, self, args);
      });
      for (const name of ["webkitExitFullscreen", "webkitCancelFullScreen", "mozCancelFullScreen"]) {
        replaceMethod(DocumentProto, name, (original, self, args) => {
          if (self === doc && active && realElement() === null) {
            exitActive("api");
            return undefined;
          }
          return call(original, self, args);
        });
      }
      for (const name of ["webkitExitFullscreen", "webkitExitFullScreen"]) {
        replaceMethod(VideoProto, name, (original, self, args) => {
          if (active && self === active.element && realElement() === null) {
            exitActive("api");
            return undefined;
          }
          return call(original, self, args);
        });
      }

      // Getters. The real value wins whenever the document is really fullscreen.
      for (const name of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement", "mozFullScreenElement"]) {
        replaceGetter(DocumentProto, name, (original, self) => {
          const value = call(original, self);
          if ((value !== null && value !== undefined) || !active || self !== doc) return value;
          return retargetToDocument(active.element);
        });
      }
      for (const name of ["fullscreen", "webkitIsFullScreen", "mozFullScreen"]) {
        replaceGetter(DocumentProto, name, (original, self) => {
          const value = call(original, self);
          return value === true || (active !== null && self === doc) ? true : value;
        });
      }
      for (const name of ["fullscreenElement", "webkitFullscreenElement"]) {
        replaceGetter(ShadowRootProto, name, (original, self) => {
          const value = call(original, self);
          if ((value !== null && value !== undefined) || !active) return value;
          return retargetToRoot(active.element, self);
        });
      }
      replaceGetter(VideoProto, "webkitDisplayingFullscreen", (original, self) => {
        const value = call(original, self);
        return value === true || (active !== null && self === active.element) ? true : value;
      });

      // :fullscreen in selector APIs, rewritten to the markers only while a fake element exists.
      const selectorMethods: Array<[object | undefined, string]> = [
        [ElementProto, "matches"],
        [ElementProto, "webkitMatchesSelector"],
        [ElementProto, "closest"],
        [ElementProto, "querySelector"],
        [ElementProto, "querySelectorAll"],
        [DocumentProto, "querySelector"],
        [DocumentProto, "querySelectorAll"],
        [FragmentProto, "querySelector"],
        [FragmentProto, "querySelectorAll"],
      ];
      for (const [start, name] of selectorMethods) {
        replaceMethod(start, name, (original, self, args) => {
          if (active !== null && typeof args[0] === "string") args[0] = rewriteSelectorArgument(args[0]);
          return call(original, self, args);
        });
      }

      // Rules the page inserts while an element is fake-fullscreen (emotion's insertRule) are mirrored or rewritten too.
      replaceMethod(win.CSSStyleSheet?.prototype, "insertRule", (original, self, args) => {
        const index = call(original, self, args);
        if (active && typeof index === "number") {
          try {
            active.pin.ruleInserted(self as CSSStyleSheet, index);
          } catch {
            // the page's rule is in; ours is best effort
          }
        }
        return index;
      });

      // Registered now, before page listeners, so the pin is up to date when theirs run.
      n.addEventListener(win, "resize", onResize, false);
      // ... and so the real fullscreen of native video controls is seen before the page sees it.
      for (const type of REAL_CHANGE_EVENTS) n.addEventListener(win, type, onRealChange, true);
      for (const type of REAL_ERROR_EVENTS) n.addEventListener(win, type, onRealError, true);
    },

    configure(next) {
      config = next;
      if (held.length > 0) flushHeld();
      if (!active) return;
      if (!next.enabled) exitActive("disabled");
      else updatePin();
    },

    exit(reason) {
      exitActive(reason);
    },

    goReal() {
      if (!active) return;
      real = true;
      updatePin();
    },

    goFake() {
      real = false;
      if (active) updatePin();
    },

    enterFrameElement(element, requestId) {
      if (!installed || config === null || !config.enabled) return;
      if (!n.isElement(element) || n.ownerDocument(element) !== doc || !n.isConnected(element)) return;
      if (active?.element === element) {
        // Same <iframe>, new request in the child: keep it pinned, pass the new id up the chain.
        active.requestId = requestId;
        notify({ type: "entered", requestId, mode: config.mode });
        return;
      }
      enter(element, "unprefixed", requestId);
    },

    uninstall() {
      if (!installed) return;
      release();
      real = false;
      installed = false; // held requests now pass through
      flushHeld();
      queue.length = 0;
      n.removeEventListener(win, "resize", onResize, false);
      for (const type of REAL_CHANGE_EVENTS) n.removeEventListener(win, type, onRealChange, true);
      for (const type of REAL_ERROR_EVENTS) n.removeEventListener(win, type, onRealError, true);
      adopting = null;
      swallowRealExit = false;
      pageRealRequest = false;
      disguise?.restore();
      disguise = null;
      patched.clear();
      coordinatesInstalled = false;
    },
  };
  return layer;
}
