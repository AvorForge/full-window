/**
 * Chromium-shaped Fullscreen API stubs for happy-dom, which has none of it
 * (only ShadowRoot.prototype.fullscreenElement, returning null). The stubs are
 * the "originals" the patch layer captures: they record every call, keep a
 * simulated real fullscreen element and behave like Chromium for the paths the
 * shim passes through. restore() removes everything again.
 */

export interface StubCall {
  name: string;
  self: unknown;
  args: unknown[];
}

export interface FullscreenStubs {
  readonly calls: StubCall[];
  /** The value the last stubbed request/exit returned (identity checks for pass-through). */
  lastResult: unknown;
  /** The simulated real fullscreen element (set by a stubbed request). */
  realElement: Element | null;
  /** document.fullscreenEnabled (false: e.g. an <iframe> without allowfullscreen). */
  fullscreenEnabled: boolean;
  /** navigator.userActivation.isActive. */
  userActive: boolean;
  /** Old Chromium: webkitEnterFullscreen() throws InvalidStateError on a video without media. */
  videoEnterThrows: boolean;
  /** The stub functions and getters, by "Owner.member", for comparisons with the replacements. */
  readonly originals: Record<string, (...args: unknown[]) => unknown>;
  restore(): void;
}

type Proto = Record<string, unknown>;

/**
 * The Document.prototype that `document` inherits from. In browsers that is
 * window.Document.prototype; happy-dom's window.Document is a subclass that its
 * HTMLDocument does not extend, so walk the document's own chain.
 */
export function documentPrototype(win: Window & typeof globalThis = window): Document {
  let proto = Object.getPrototypeOf(win.document) as object | null;
  while (proto && (proto as { constructor?: { name?: string } }).constructor?.name !== "Document") proto = Object.getPrototypeOf(proto) as object | null;
  return (proto ?? win.Document.prototype) as Document;
}

export function installFullscreenStubs(win: Window & typeof globalThis = window): FullscreenStubs {
  const restores: Array<() => void> = [];
  const define = (target: object, name: string, descriptor: PropertyDescriptor): void => {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, descriptor);
    restores.push(() => {
      if (previous) Object.defineProperty(target, name, previous);
      else delete (target as Proto)[name];
    });
  };

  const stubs: FullscreenStubs = {
    calls: [],
    lastResult: undefined,
    realElement: null,
    fullscreenEnabled: true,
    userActive: true,
    videoEnterThrows: false,
    originals: {},
    restore() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };

  const record = (name: string, self: unknown, args: unknown[]): void => {
    stubs.calls.push({ name, self, args });
  };
  const isDocument = (self: unknown): self is Document => self instanceof win.Node && self.nodeType === win.Node.DOCUMENT_NODE;
  const illegal = (): never => {
    throw new win.TypeError("Illegal invocation");
  };

  // WebIDL operations: writable, enumerable, configurable. Shorthand methods, like natives, have no prototype.
  const method = (owner: object, ownerName: string, name: string, fn: (this: unknown, ...args: unknown[]) => unknown): void => {
    stubs.originals[`${ownerName}.${name}`] = fn;
    define(owner, name, { value: fn, writable: true, enumerable: true, configurable: true });
  };
  const getter = (owner: object, ownerName: string, name: string, body: (this: unknown) => unknown): void => {
    // Like a native accessor: its own function per property, named "get <name>".
    const get = Object.getOwnPropertyDescriptor(
      {
        get [name]() {
          return body.call(this);
        },
      },
      name,
    )?.get as (this: unknown) => unknown;
    stubs.originals[`${ownerName}.${name}`] = get;
    define(owner, name, { get, enumerable: true, configurable: true });
  };

  const request = (name: string, prefixed: boolean) =>
    ({
      [name](this: unknown, ...args: unknown[]) {
        if (!(this instanceof win.Element)) {
          if (prefixed) illegal();
          return Promise.reject(new win.TypeError("Illegal invocation"));
        }
        record(name, this, args);
        stubs.realElement = this;
        const result = prefixed ? undefined : Promise.resolve();
        stubs.lastResult = result;
        return result;
      },
    })[name] as (this: unknown, ...args: unknown[]) => unknown;

  const element = win.Element.prototype;
  method(element, "Element", "requestFullscreen", request("requestFullscreen", false));
  method(element, "Element", "webkitRequestFullscreen", request("webkitRequestFullscreen", true));
  method(element, "Element", "webkitRequestFullScreen", request("webkitRequestFullScreen", true));

  const video = win.HTMLVideoElement.prototype;
  for (const name of ["webkitEnterFullscreen", "webkitEnterFullScreen"]) {
    method(video, "HTMLVideoElement", name, {
      [name](this: unknown, ...args: unknown[]) {
        if ((this as Element | null)?.localName !== "video") illegal();
        const target = this as HTMLVideoElement;
        if (stubs.videoEnterThrows && target.readyState === 0) {
          throw new win.DOMException("This element may only enter fullscreen mode after its metadata has been loaded.", "InvalidStateError");
        }
        if (target.ownerDocument !== win.document) return; // an inactive document: Chromium does nothing
        record(name, target, args);
        if (target.isConnected) stubs.realElement = target;
        stubs.lastResult = undefined;
      },
    }[name] as (this: unknown, ...args: unknown[]) => unknown);
  }
  for (const name of ["webkitExitFullscreen", "webkitExitFullScreen"]) {
    method(video, "HTMLVideoElement", name, {
      [name](this: unknown, ...args: unknown[]) {
        record(`video.${name}`, this, args);
        if (stubs.realElement === this) stubs.realElement = null;
      },
    }[name] as (this: unknown, ...args: unknown[]) => unknown);
  }
  getter(video, "HTMLVideoElement", "webkitDisplayingFullscreen", function (this: unknown) {
    return stubs.realElement === this;
  });
  getter(video, "HTMLVideoElement", "webkitSupportsFullscreen", () => stubs.fullscreenEnabled);

  const doc = documentPrototype(win);
  method(doc, "Document", "exitFullscreen", {
    exitFullscreen(this: unknown, ...args: unknown[]) {
      if (!isDocument(this)) return Promise.reject(new win.TypeError("Illegal invocation"));
      record("exitFullscreen", this, args);
      if (stubs.realElement === null) {
        const rejected = Promise.reject(new win.TypeError("Document not active"));
        stubs.lastResult = rejected;
        return rejected;
      }
      stubs.realElement = null;
      const resolved = Promise.resolve();
      stubs.lastResult = resolved;
      return resolved;
    },
  }.exitFullscreen as (this: unknown, ...args: unknown[]) => unknown);
  for (const name of ["webkitExitFullscreen", "webkitCancelFullScreen"]) {
    method(doc, "Document", name, {
      [name](this: unknown, ...args: unknown[]) {
        if (!isDocument(this)) illegal();
        record(name, this, args);
        stubs.realElement = null;
      },
    }[name] as (this: unknown, ...args: unknown[]) => unknown);
  }
  const fullscreenElement = function (this: unknown): Element | null {
    if (!isDocument(this)) illegal();
    return this === win.document ? stubs.realElement : null;
  };
  for (const name of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"]) getter(doc, "Document", name, fullscreenElement);
  for (const name of ["fullscreen", "webkitIsFullScreen"]) {
    getter(doc, "Document", name, function (this: unknown) {
      return fullscreenElement.call(this) !== null;
    });
  }
  for (const name of ["fullscreenEnabled", "webkitFullscreenEnabled"]) {
    getter(doc, "Document", name, function (this: unknown) {
      if (!isDocument(this)) illegal();
      return stubs.fullscreenEnabled;
    });
  }

  // navigator.userActivation (Navigator.prototype getter returning a UserActivation).
  class UserActivation {
    get isActive(): boolean {
      return stubs.userActive;
    }
    get hasBeenActive(): boolean {
      return true;
    }
  }
  const activation = new UserActivation();
  define(win, "UserActivation", { value: UserActivation, writable: true, configurable: true });
  getter(win.Navigator.prototype, "Navigator", "userActivation", () => activation);

  return stubs;
}

/** The prefixed members lib.dom does not declare. */
export interface PrefixedDocument extends Document {
  readonly webkitIsFullScreen: boolean;
  readonly webkitFullscreenElement: Element | null;
  readonly webkitCurrentFullScreenElement: Element | null;
  webkitExitFullscreen(): void;
  webkitCancelFullScreen(): void;
  onwebkitfullscreenchange: ((event: Event) => unknown) | null;
}

export interface PrefixedVideo extends HTMLVideoElement {
  webkitRequestFullscreen(): void;
  webkitRequestFullScreen(): void;
  webkitEnterFullscreen(): void;
  webkitExitFullscreen(): void;
  readonly webkitDisplayingFullscreen: boolean;
}

/** happy-dom's viewport control (fires resize). */
export function setViewport(width: number, height: number): void {
  (window as unknown as { happyDOM?: { setViewport(size: { width: number; height: number }): void } }).happyDOM?.setViewport({ width, height });
}

/** An <iframe> that happy-dom can attach without trying to load a page (it has no network). */
export function frameElement(doc: Document = document): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  frame.setAttribute("srcdoc", "");
  return frame;
}

/** Resolves after the next animation frame (after rAF callbacks registered before this call). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Lets microtasks, MutationObserver callbacks and zero-delay timers run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A keyboard event that looks trusted to listeners (happy-dom cannot create trusted events). */
export function trustedKey(type: "keydown" | "keyup", key: string): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

/** The browser's own fullscreen change event (as from native <video controls>), trusted as far as listeners can tell. */
export function trustedChange(type = "fullscreenchange"): Event {
  const event = new Event(type, { bubbles: true, composed: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}
