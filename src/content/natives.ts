/**
 * Originals captured from the page's realm at document_start, and the
 * "looking native" disguise for replacements (docs/ARCHITECTURE.md §2).
 *
 * The MAIN-world layer runs with the page's privileges and next to page
 * scripts that may later replace any global or prototype member. Everything
 * the layer calls on page objects goes through what is captured here, before
 * page scripts exist, and is called with Reflect.apply (also captured).
 */

export type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

const apply = Reflect.apply;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const getPrototypeOf = Object.getPrototypeOf;

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

/** Calls `fn` as a method of `thisArg` without using page-overridable Function.prototype.call. */
export function call<T = unknown>(fn: unknown, thisArg: unknown, args: readonly unknown[] = []): T {
  return apply(fn as AnyFunction, thisArg, args as unknown[]) as T;
}

export interface FoundProperty {
  owner: object;
  name: PropertyKey;
  descriptor: PropertyDescriptor;
}

/** Walks up the prototype chain from `start` to the object that owns `name`. */
export function findProperty(start: object | null | undefined, name: PropertyKey): FoundProperty | null {
  for (let proto = start; proto; proto = getPrototypeOf(proto) as object | null) {
    const descriptor = getOwnPropertyDescriptor(proto, name);
    if (descriptor) return { owner: proto, name, descriptor };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Disguise
// ---------------------------------------------------------------------------

export interface Disguise {
  /**
   * Defines `replacement` (a method or getter created with shorthand syntax, so
   * it has no `prototype`) in place of the original on the same owner, with the
   * same attributes, the original's `name` and `length`, and a toString that
   * reports the original's source.
   */
  replace(found: FoundProperty, key: "value" | "get", replacement: AnyFunction): void;
  /** Restores every replaced descriptor, then Function.prototype.toString. */
  restore(): void;
}

export function createDisguise(win: Window & typeof globalThis): Disguise {
  const functionPrototype = win.Function.prototype;
  const toStringFound = findProperty(functionPrototype, "toString");
  const nativeToString = toStringFound?.descriptor.value as AnyFunction;
  const originals = new WeakMap<object, AnyFunction>();
  const mapGet = WeakMap.prototype.get;
  const mapSet = WeakMap.prototype.set;
  const restores: Array<() => void> = [];

  const mimic = (replacement: AnyFunction, original: AnyFunction): void => {
    defineProperty(replacement, "length", { value: getOwnPropertyDescriptor(original, "length")?.value ?? 0, configurable: true });
    defineProperty(replacement, "name", { value: getOwnPropertyDescriptor(original, "name")?.value ?? "", configurable: true });
    apply(mapSet, originals, [replacement, original]);
  };

  const toString = {
    toString(this: unknown) {
      const original = apply(mapGet, originals, [this]) as AnyFunction | undefined;
      return apply(nativeToString, original ?? this, []);
    },
  }.toString;

  if (toStringFound && typeof nativeToString === "function") {
    mimic(toString, nativeToString);
    defineProperty(toStringFound.owner, "toString", { ...toStringFound.descriptor, value: toString });
    restores.push(() => defineProperty(toStringFound.owner, "toString", toStringFound.descriptor));
  }

  return {
    replace(found, key, replacement) {
      const original = found.descriptor[key] as AnyFunction;
      mimic(replacement, original);
      defineProperty(found.owner, found.name, { ...found.descriptor, [key]: replacement });
      restores.push(() => defineProperty(found.owner, found.name, found.descriptor));
    },
    restore() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}

// ---------------------------------------------------------------------------
// DOM originals
// ---------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
}

/** Captured DOM operations, each calling the original with the given `this`. */
export interface DomNatives {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  isElement(value: unknown): value is Element;
  isConnected(node: Node): boolean;
  ownerDocument(node: Node): Document | null;
  parentNode(node: Node): Node | null;
  rootNode(node: Node): Node;
  /** The host if `node` is a ShadowRoot, else null. */
  shadowHost(node: unknown): Element | null;
  openShadowRoot(element: Element): ShadowRoot | null;
  namespaceURI(element: Element): string | null;
  localName(element: Element): string;
  getAttribute(element: Element, name: string): string | null;
  setAttribute(element: Element, name: string, value: string): void;
  removeAttribute(element: Element, name: string): void;
  /** The original Element.prototype.matches (throws on invalid selectors). */
  matches(element: Element, selector: string): boolean;
  /** The original querySelectorAll of an element, document or fragment. */
  querySelectorAll(root: Element | Document | DocumentFragment, selector: string): Element[];
  createElement(localName: string): HTMLElement;
  appendChild(parent: Node, child: Node): void;
  remove(node: Node): void;
  documentElement(): Element | null;
  /** The element's inline style declaration, or null (elements without `style`). */
  inlineStyle(element: Element): CSSStyleDeclaration | null;
  setImportant(style: CSSStyleDeclaration, property: string, value: string): void;
  computedValue(style: CSSStyleDeclaration, property: string): string;
  /** "important" or "" (getPropertyPriority). */
  propertyPriority(style: CSSStyleDeclaration, property: string): string;
  setProperty(style: CSSStyleDeclaration, property: string, value: string, priority: string): void;
  removeProperty(style: CSSStyleDeclaration, property: string): void;
  /** The (longhand and custom) property names of a declaration block, in order. */
  propertyNames(style: CSSStyleDeclaration): string[];
  computedStyle(element: Element): CSSStyleDeclaration | null;
  viewport(): Viewport;
  scrollPosition(): { x: number; y: number };
  scrollTo(x: number, y: number): void;
  requestAnimationFrame(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  addEventListener(target: EventTarget, type: string, listener: (event: Event) => void, capture: boolean): void;
  removeEventListener(target: EventTarget, type: string, listener: (event: Event) => void, capture: boolean): void;
  dispatchEvent(target: EventTarget, event: Event): void;
  event(type: string, init?: EventInit): Event;
  typeError(message: string): TypeError;
  domException(message: string, name: string): DOMException;
  resolved(value: unknown): Promise<unknown>;
  rejected(reason: unknown): Promise<unknown>;
  promise(executor: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void): Promise<unknown>;
  mutationObserver(callback: () => void): { observe(target: Node, options: MutationObserverInit): void; disconnect(): void };
  randomId(): string;
  /** navigator.userActivation.isActive; true where the browser has no UserActivation API. */
  userActivationActive(): boolean;
  readyState(video: Element): number;
  /** A video element in a new inert document, for probing original behaviour without page-visible effects. */
  inertVideo(): Element | null;
  constructedSheet(): CSSStyleSheet | null;
  replaceSync(sheet: CSSStyleSheet, text: string): void;
  adoptedSheets(root: Document | ShadowRoot): CSSStyleSheet[] | null;
  setAdoptedSheets(root: Document | ShadowRoot, sheets: CSSStyleSheet[]): void;
  styleSheets(root: Document | ShadowRoot): CSSStyleSheet[];
  /** A sheet's rules, or null where they cannot be read (cross-origin). */
  cssRules(sheet: CSSStyleSheet): ArrayLike<CSSRule> | null;
  selectorText(rule: CSSRule): string;
  /** Sets a style rule's selector text; the browser ignores text it cannot parse. */
  setSelectorText(rule: CSSRule, text: string): void;
  /** The element's own animations (Element.getAnimations()), or none where the browser has no Web Animations. */
  animations(element: Element): Animation[];
  /** A keyframe effect of `animation`, or null (no effect, or one without keyframes). */
  keyframeEffect(animation: Animation): KeyframeEffect | null;
  effectTarget(effect: KeyframeEffect): Element | null;
  setEffectTarget(effect: KeyframeEffect, target: Element | null): void;
  /** The property names of an effect's keyframes, as getKeyframes() names them (camelCase, `cssOffset`). */
  keyframeProperties(effect: KeyframeEffect): string[];
  eventType(event: Event): string;
  /** composedPath()[0]: the node the event was dispatched on, even inside an open shadow root. */
  eventOrigin(event: Event): unknown;
  stopImmediatePropagation(event: Event): void;
  /** The document's focused element, retargeted to the document (the host of a focused UA shadow control). */
  activeElement(): Element | null;
  blur(element: Element): void;
  /** Calls `onSettled` once a promise settles (with `true` if it was fulfilled), without the page's Promise.prototype.then. */
  onSettled(promise: unknown, onSettled: (fulfilled: boolean) => void): void;
}

type Getter = (target: unknown) => unknown;

/** Reads `name` through the getter found from `start` at capture time (or a plain read if there is none). */
function captureGetter(start: object | null | undefined, name: string): Getter {
  const get = findProperty(start, name)?.descriptor.get;
  if (typeof get === "function") return (target) => apply(get, target, []);
  return (target) => (target as Record<string, unknown> | null)?.[name];
}

function captureMethod(start: object | null | undefined, name: string): AnyFunction | undefined {
  const value = findProperty(start, name)?.descriptor.value;
  return typeof value === "function" ? (value as AnyFunction) : undefined;
}

/** Captures everything the layer needs. Must run before any replacement is installed. */
export function captureDom(win: Window & typeof globalThis): DomNatives {
  const doc = win.document;
  const NodeProto = win.Node?.prototype;
  const ElementProto = win.Element?.prototype;
  // The document's own chain (HTMLDocument.prototype -> Document.prototype), so members are found where it inherits them.
  const DocumentProto = Object.getPrototypeOf(doc) as object;
  const FragmentProto = win.DocumentFragment?.prototype;
  const ShadowRootProto = win.ShadowRoot?.prototype;
  const StyleProto = win.CSSStyleDeclaration?.prototype;
  const EventTargetProto = win.EventTarget?.prototype;

  const nodeType = captureGetter(NodeProto, "nodeType");
  const isConnected = captureGetter(NodeProto, "isConnected");
  const ownerDocument = captureGetter(NodeProto, "ownerDocument");
  const parentNode = captureGetter(NodeProto, "parentNode");
  const getRootNode = captureMethod(NodeProto, "getRootNode");
  const appendChild = captureMethod(NodeProto, "appendChild");
  const removeChild = captureMethod(NodeProto, "removeChild");
  const host = captureGetter(ShadowRootProto, "host");
  const shadowRoot = captureGetter(ElementProto, "shadowRoot");
  const namespaceURI = captureGetter(ElementProto, "namespaceURI");
  const localName = captureGetter(ElementProto, "localName");
  const getAttribute = captureMethod(ElementProto, "getAttribute");
  const setAttribute = captureMethod(ElementProto, "setAttribute");
  const removeAttribute = captureMethod(ElementProto, "removeAttribute");
  const matches = captureMethod(ElementProto, "matches");
  const querySelectorAll = new Map<object | undefined, AnyFunction | undefined>([
    [ElementProto, captureMethod(ElementProto, "querySelectorAll")],
    [DocumentProto, captureMethod(DocumentProto, "querySelectorAll")],
    [FragmentProto, captureMethod(FragmentProto, "querySelectorAll")],
  ]);
  const createElement = captureMethod(DocumentProto, "createElement");
  const documentElement = captureGetter(DocumentProto, "documentElement");
  const styleGetters = [win.HTMLElement?.prototype, win.SVGElement?.prototype, (win as unknown as { MathMLElement?: { prototype: object } }).MathMLElement?.prototype]
    .map((proto) => findProperty(proto, "style")?.descriptor.get)
    .filter((get): get is AnyFunction => typeof get === "function");
  const setProperty = captureMethod(StyleProto, "setProperty");
  const getPropertyValue = captureMethod(StyleProto, "getPropertyValue");
  const getPropertyPriority = captureMethod(StyleProto, "getPropertyPriority");
  const removeProperty = captureMethod(StyleProto, "removeProperty");
  const styleItem = captureMethod(StyleProto, "item");
  const styleLength = captureGetter(StyleProto, "length");
  const getComputedStyle = win.getComputedStyle;
  const innerWidth = captureGetter(win, "innerWidth");
  const innerHeight = captureGetter(win, "innerHeight");
  const scrollX = captureGetter(win, "scrollX");
  const scrollY = captureGetter(win, "scrollY");
  const scrollTo = win.scrollTo;
  const requestAnimationFrame = win.requestAnimationFrame;
  const setTimeout = win.setTimeout;
  const clearTimeout = win.clearTimeout;
  const addEventListener = captureMethod(EventTargetProto, "addEventListener");
  const removeEventListener = captureMethod(EventTargetProto, "removeEventListener");
  const dispatchEvent = captureMethod(EventTargetProto, "dispatchEvent");
  // The window's own references: the same EventTarget methods in browsers, bound ones in test DOMs.
  const windowListen = win.addEventListener;
  const windowUnlisten = win.removeEventListener;
  const windowDispatch = win.dispatchEvent;
  const NativeEvent = win.Event;
  const NativeTypeError = win.TypeError;
  const NativeDOMException = win.DOMException;
  const NativePromise = win.Promise;
  const promiseResolve = NativePromise.resolve;
  const promiseReject = NativePromise.reject;
  const NativeMutationObserver = win.MutationObserver;
  const observe = captureMethod(NativeMutationObserver?.prototype, "observe");
  const disconnect = captureMethod(NativeMutationObserver?.prototype, "disconnect");
  const crypto = win.crypto;
  const getRandomValues = crypto?.getRandomValues;
  const userActivation = captureGetter(win.navigator, "userActivation");
  const isActive = captureGetter((win as unknown as { UserActivation?: { prototype: object } }).UserActivation?.prototype, "isActive");
  const readyState = captureGetter(win.HTMLMediaElement?.prototype, "readyState");
  const implementation = captureGetter(DocumentProto, "implementation");
  const createHTMLDocument = captureMethod(Object.getPrototypeOf(implementation(doc) ?? {}) as object, "createHTMLDocument");
  const NativeSheet = win.CSSStyleSheet;
  const replaceSync = captureMethod(NativeSheet?.prototype, "replaceSync");
  const adopted = new Map<object | undefined, PropertyDescriptor | undefined>([
    [DocumentProto, findProperty(DocumentProto, "adoptedStyleSheets")?.descriptor],
    [ShadowRootProto, findProperty(ShadowRootProto, "adoptedStyleSheets")?.descriptor],
  ]);
  const documentStyleSheets = captureGetter(DocumentProto, "styleSheets");
  const cssRules = captureGetter(NativeSheet?.prototype, "cssRules");
  const StyleRuleProto = win.CSSStyleRule?.prototype;
  const selectorText = captureGetter(StyleRuleProto, "selectorText");
  const selectorTextSetter = findProperty(StyleRuleProto, "selectorText")?.descriptor.set;
  const getAnimations = captureMethod(ElementProto, "getAnimations");
  const NativeKeyframeEffect = (win as unknown as { KeyframeEffect?: { prototype: object } }).KeyframeEffect;
  const animationEffect = captureGetter((win as unknown as { Animation?: { prototype: object } }).Animation?.prototype, "effect");
  const effectTarget = captureGetter(NativeKeyframeEffect?.prototype, "target");
  const effectTargetSetter = findProperty(NativeKeyframeEffect?.prototype, "target")?.descriptor.set;
  const getKeyframes = captureMethod(NativeKeyframeEffect?.prototype, "getKeyframes");
  const EventProto = win.Event?.prototype;
  const eventType = captureGetter(EventProto, "type");
  const composedPath = captureMethod(EventProto, "composedPath");
  const stopImmediatePropagation = captureMethod(EventProto, "stopImmediatePropagation");
  const promiseThen = captureMethod(NativePromise.prototype, "then");
  const activeElement = captureGetter(DocumentProto, "activeElement");
  const blur = captureMethod(win.HTMLElement?.prototype, "blur");
  const shadowStyleSheets = captureGetter(ShadowRootProto, "styleSheets");

  const shadowHost = (node: unknown): Element | null => {
    if (node === null || typeof node !== "object") return null;
    try {
      if (nodeType(node) !== 11) return null;
      const value = host(node);
      return isElementValue(value) ? value : null;
    } catch {
      return null;
    }
  };
  const isElementValue = (value: unknown): value is Element => {
    if (value === null || typeof value !== "object") return false;
    try {
      return nodeType(value) === 1;
    } catch {
      return false;
    }
  };
  const protoKey = (root: object): object | undefined => {
    if (nodeType(root) === 9) return DocumentProto;
    return nodeType(root) === 11 ? FragmentProto : ElementProto;
  };
  const adoptedDescriptor = (root: Document | ShadowRoot): PropertyDescriptor | undefined =>
    adopted.get(shadowHost(root) ? ShadowRootProto : DocumentProto);

  return {
    window: win,
    document: doc,
    isElement: isElementValue,
    isConnected: (node) => isConnected(node) === true,
    ownerDocument: (node) => (ownerDocument(node) as Document | null) ?? null,
    parentNode: (node) => (parentNode(node) as Node | null) ?? null,
    rootNode: (node) => (getRootNode ? (call(getRootNode, node) as Node) : node),
    shadowHost,
    openShadowRoot: (element) => (shadowRoot(element) as ShadowRoot | null) ?? null,
    namespaceURI: (element) => (namespaceURI(element) as string | null) ?? null,
    localName: (element) => String(localName(element) ?? ""),
    getAttribute: (element, name) => call<string | null>(getAttribute, element, [name]),
    setAttribute: (element, name, value) => void call(setAttribute, element, [name, value]),
    removeAttribute: (element, name) => void call(removeAttribute, element, [name]),
    matches: (element, selector) => call<boolean>(matches, element, [selector]),
    querySelectorAll: (root, selector) => {
      const method = querySelectorAll.get(protoKey(root));
      return method ? Array.from(call<ArrayLike<Element>>(method, root, [selector])) : [];
    },
    createElement: (name) => call<HTMLElement>(createElement, doc, [name]),
    appendChild: (parent, child) => void call(appendChild, parent, [child]),
    remove: (node) => {
      const parent = parentNode(node);
      if (parent) call(removeChild, parent, [node]);
    },
    documentElement: () => (documentElement(doc) as Element | null) ?? null,
    inlineStyle: (element) => {
      for (const get of styleGetters) {
        try {
          const style = apply(get, element, []) as CSSStyleDeclaration | undefined;
          if (style) return style;
        } catch {
          // not this kind of element
        }
      }
      return null;
    },
    setImportant: (style, property, value) => void call(setProperty, style, [property, value, "important"]),
    computedValue: (style, property) => String(call(getPropertyValue, style, [property]) ?? "").trim(),
    propertyPriority: (style, property) => String(call(getPropertyPriority, style, [property]) ?? ""),
    setProperty: (style, property, value, priority) => void call(setProperty, style, [property, value, priority]),
    removeProperty: (style, property) => void call(removeProperty, style, [property]),
    propertyNames: (style) => {
      const names: string[] = [];
      const length = Number(styleLength(style)) || 0;
      for (let i = 0; i < length; i++) names.push(String(call(styleItem, style, [i])));
      return names;
    },
    computedStyle: (element) => {
      try {
        return call<CSSStyleDeclaration>(getComputedStyle, win, [element]);
      } catch {
        return null;
      }
    },
    viewport: () => ({ width: Number(innerWidth(win)) || 0, height: Number(innerHeight(win)) || 0 }),
    scrollPosition: () => ({ x: Number(scrollX(win)) || 0, y: Number(scrollY(win)) || 0 }),
    scrollTo: (x, y) => {
      if (typeof scrollTo === "function") call(scrollTo, win, [x, y]);
    },
    requestAnimationFrame: (callback) => void call(requestAnimationFrame, win, [callback]),
    setTimeout: (callback, ms) => call(setTimeout, win, [callback, ms]),
    clearTimeout: (handle) => void call(clearTimeout, win, [handle]),
    addEventListener: (target, type, listener, capture) =>
      void call(target === win ? windowListen : addEventListener, target, [type, listener, capture]),
    removeEventListener: (target, type, listener, capture) =>
      void call(target === win ? windowUnlisten : removeEventListener, target, [type, listener, capture]),
    dispatchEvent: (target, event) => void call(target === win ? windowDispatch : dispatchEvent, target, [event]),
    event: (type, init) => new NativeEvent(type, init),
    typeError: (message) => new NativeTypeError(message),
    domException: (message, name) => new NativeDOMException(message, name),
    resolved: (value) => call<Promise<unknown>>(promiseResolve, NativePromise, [value]),
    rejected: (reason) => call<Promise<unknown>>(promiseReject, NativePromise, [reason]),
    promise: (executor) => new NativePromise(executor),
    mutationObserver: (callback) => {
      const observer = new NativeMutationObserver(() => callback());
      return {
        observe: (target, options) => void call(observe, observer, [target, options]),
        disconnect: () => void call(disconnect, observer),
      };
    },
    randomId: () => {
      const bytes = new Uint8Array(16);
      call(getRandomValues, crypto, [bytes]);
      return "cfs" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    },
    userActivationActive: () => {
      try {
        const activation = userActivation(win.navigator);
        if (activation === undefined || activation === null) return true;
        return isActive(activation) === true;
      } catch {
        return true;
      }
    },
    readyState: (video) => Number(readyState(video) ?? 0),
    inertVideo: () => {
      try {
        const inert = call<Document>(createHTMLDocument, implementation(doc), [""]);
        return call<Element>(createElement, inert, ["video"]);
      } catch {
        return null;
      }
    },
    constructedSheet: () => {
      try {
        return NativeSheet && replaceSync ? new NativeSheet() : null;
      } catch {
        return null;
      }
    },
    replaceSync: (sheet, text) => void call(replaceSync, sheet, [text]),
    adoptedSheets: (root) => {
      const get = adoptedDescriptor(root)?.get;
      if (!get) return null;
      try {
        return Array.from(apply(get, root, []) as ArrayLike<CSSStyleSheet>);
      } catch {
        return null;
      }
    },
    setAdoptedSheets: (root, sheets) => {
      const set = adoptedDescriptor(root)?.set;
      if (set) apply(set, root, [sheets]);
    },
    styleSheets: (root) => {
      try {
        const list = (shadowHost(root) ? shadowStyleSheets(root) : documentStyleSheets(root)) as ArrayLike<CSSStyleSheet> | undefined;
        return list ? Array.from(list) : [];
      } catch {
        return [];
      }
    },
    cssRules: (sheet) => {
      try {
        return (cssRules(sheet) as ArrayLike<CSSRule> | null | undefined) ?? null;
      } catch {
        return null; // cross-origin
      }
    },
    selectorText: (rule) => String(selectorText(rule) ?? ""),
    setSelectorText: (rule, text) => {
      if (typeof selectorTextSetter === "function") apply(selectorTextSetter, rule, [text]);
    },
    animations: (element) => {
      if (!getAnimations) return [];
      try {
        return Array.from(call<ArrayLike<Animation>>(getAnimations, element));
      } catch {
        return [];
      }
    },
    keyframeEffect: (animation) => {
      const effect = animationEffect(animation) as KeyframeEffect | null | undefined;
      return effect && getKeyframes && findProperty(effect, "getKeyframes") ? effect : null;
    },
    effectTarget: (effect) => (effectTarget(effect) as Element | null) ?? null,
    setEffectTarget: (effect, target) => {
      if (typeof effectTargetSetter === "function") apply(effectTargetSetter, effect, [target]);
    },
    keyframeProperties: (effect) => {
      const names: string[] = [];
      try {
        for (const keyframe of Array.from(call<ArrayLike<Record<string, unknown>>>(getKeyframes, effect))) {
          for (const name of Object.keys(keyframe)) if (!names.includes(name)) names.push(name);
        }
      } catch {
        // not a keyframe effect
      }
      return names;
    },
    eventType: (event) => String(eventType(event) ?? ""),
    eventOrigin: (event) => (composedPath ? call<unknown[]>(composedPath, event)[0] : undefined),
    stopImmediatePropagation: (event) => void call(stopImmediatePropagation, event),
    activeElement: () => {
      const element = activeElement(doc);
      return isElementValue(element) ? element : null;
    },
    blur: (element) => {
      if (blur) call(blur, element);
    },
    onSettled: (promise, onSettled) => {
      if (!promiseThen || promise === null || typeof promise !== "object") return;
      try {
        call(promiseThen, promise, [() => onSettled(true), () => onSettled(false)]);
      } catch {
        // not a native promise
      }
    },
  };
}
