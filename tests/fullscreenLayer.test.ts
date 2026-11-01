// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIALOG_ERROR,
  ELEMENT_TYPE_ERROR,
  NOT_ACTIVE_ERROR,
  NOT_CONNECTED_ERROR,
  PERMISSION_ERROR,
  POLICY_ERROR,
  createFullscreenPatchLayer,
  type RealFullscreenPatchLayer,
} from "../src/content/fullscreenLayer";
import { ANCESTOR_ATTRIBUTE, BACKDROP_ATTRIBUTE, FULLSCREEN_ATTRIBUTE } from "../src/content/selectors";
import { backdropStrips, holeCoversViewport, MAX_STYLE_REAPPLY, mirrorRuleList } from "../src/content/styling";
import type { PageMessage, ShimConfig } from "../src/shared/messages";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import {
  documentPrototype,
  frameElement,
  installFullscreenStubs,
  nextFrame,
  setViewport,
  settle,
  trustedChange,
  type FullscreenStubs,
  type PrefixedDocument,
  type PrefixedVideo,
} from "./helpers/fullscreenStubs";

const DocumentProto = documentPrototype();

// Captured before any layer is installed.
const nativeToString = Function.prototype.toString;
const sourceOf = (fn: unknown): string => nativeToString.call(fn as () => void);

const config: ShimConfig = {
  enabled: true,
  mode: "fill-tab",
  customRect: DEFAULT_SETTINGS.customRect,
  topFrame: true,
  backgroundColor: "#101010",
  exitOnEscape: true,
  preferReal: false,
};

let stubs: FullscreenStubs;
let layer: RealFullscreenPatchLayer;
let notes: PageMessage[];

function install(configure: ShimConfig | null = config): void {
  layer = createFullscreenPatchLayer({ configWaitMs: 30 });
  layer.install({ window: window as Window & typeof globalThis, notify: (message) => notes.push(message) });
  if (configure) layer.configure(configure);
}

beforeEach(() => {
  stubs = installFullscreenStubs();
  notes = [];
  setViewport(1000, 800);
});

afterEach(() => {
  layer?.uninstall();
  stubs.restore();
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const node of Array.from(document.querySelectorAll(`[${BACKDROP_ATTRIBUTE}]`))) node.remove();
});

const pdoc = document as PrefixedDocument;

function connectedVideo(): PrefixedVideo {
  const video = document.createElement("video") as PrefixedVideo;
  document.body.append(video);
  return video;
}

/** Records fullscreen-related events reaching the window. */
function eventLog(types = ["fullscreenchange", "webkitfullscreenchange", "fullscreenerror", "webkitfullscreenerror", "resize"]) {
  const log: Array<{ type: string; target: EventTarget | null }> = [];
  for (const type of types) window.addEventListener(type, (event) => log.push({ type, target: event.target }));
  return log;
}

describe("API surface", () => {
  const methods: Array<[object, string, string]> = [
    [Element.prototype, "requestFullscreen", "Element"],
    [Element.prototype, "webkitRequestFullscreen", "Element"],
    [Element.prototype, "webkitRequestFullScreen", "Element"],
    [HTMLVideoElement.prototype, "webkitEnterFullscreen", "HTMLVideoElement"],
    [HTMLVideoElement.prototype, "webkitEnterFullScreen", "HTMLVideoElement"],
    [HTMLVideoElement.prototype, "webkitExitFullscreen", "HTMLVideoElement"],
    [DocumentProto, "exitFullscreen", "Document"],
    [DocumentProto, "webkitExitFullscreen", "Document"],
    [DocumentProto, "webkitCancelFullScreen", "Document"],
  ];
  const getters: Array<[object, string]> = [
    [DocumentProto, "fullscreenElement"],
    [DocumentProto, "webkitFullscreenElement"],
    [DocumentProto, "webkitCurrentFullScreenElement"],
    [DocumentProto, "fullscreen"],
    [DocumentProto, "webkitIsFullScreen"],
    [HTMLVideoElement.prototype, "webkitDisplayingFullscreen"],
  ];

  it("replaces every existing member on the prototype that owns it, with the original attributes", () => {
    const before = new Map([...methods, ...getters].map(([owner, name]) => [name + String(owner === DocumentProto), Object.getOwnPropertyDescriptor(owner, name)]));
    const shadowBefore = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "fullscreenElement");
    install();
    for (const [owner, name] of methods) {
      const original = before.get(name + String(owner === DocumentProto));
      const now = Object.getOwnPropertyDescriptor(owner, name);
      expect(now, name).toBeDefined();
      expect(now?.value, name).not.toBe(original?.value);
      expect({ ...now, value: undefined }, name).toEqual({ ...original, value: undefined });
    }
    for (const [owner, name] of getters) {
      const original = before.get(name + String(owner === DocumentProto));
      const now = Object.getOwnPropertyDescriptor(owner, name);
      expect(now?.get, name).not.toBe(original?.get);
      expect({ ...now, get: undefined }, name).toEqual({ ...original, get: undefined });
    }
    // happy-dom's own ShadowRoot getter is replaced in place too.
    const shadowNow = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "fullscreenElement");
    expect(shadowNow?.get).not.toBe(shadowBefore?.get);
    // Never adds a prefixed API the browser does not have, never touches fullscreenEnabled.
    expect("mozRequestFullScreen" in Element.prototype).toBe(false);
    expect("mozCancelFullScreen" in DocumentProto).toBe(false);
    expect("mozFullScreenElement" in DocumentProto).toBe(false);
    expect(Object.getOwnPropertyDescriptor(DocumentProto, "fullscreenEnabled")?.get).toBe(stubs.originals["Document.fullscreenEnabled"]);
  });

  it("looks native: name, length, no prototype, not constructible, and the original's toString", () => {
    install();
    for (const [owner, name, ownerName] of methods) {
      const fn = Object.getOwnPropertyDescriptor(owner, name)?.value as (...args: unknown[]) => unknown;
      const original = stubs.originals[`${ownerName}.${name}`] as (...args: unknown[]) => unknown;
      expect(fn.name, name).toBe(name);
      expect(fn.length, name).toBe(original.length);
      expect(Object.hasOwn(fn, "prototype"), name).toBe(false);
      expect(() => Reflect.construct(fn, []), name).toThrow(TypeError);
      expect(Function.prototype.toString.call(fn), name).toBe(sourceOf(original));
      expect(`${fn}`, name).toBe(sourceOf(original));
    }
    const getter = Object.getOwnPropertyDescriptor(DocumentProto, "fullscreenElement")?.get as () => unknown;
    expect(getter.name).toBe("get fullscreenElement");
    expect(getter.name).toBe(stubs.originals["Document.fullscreenElement"]?.name);
    expect(Object.hasOwn(getter, "prototype")).toBe(false);
    expect(Function.prototype.toString.call(getter)).toBe(sourceOf(stubs.originals["Document.fullscreenElement"]));
    expect(Element.prototype.requestFullscreen.length).toBe(0);
    // The toString wrapper is itself disguised.
    expect(Function.prototype.toString).not.toBe(nativeToString);
    expect(Function.prototype.toString.call(Function.prototype.toString)).toBe(sourceOf(nativeToString));
    expect(Function.prototype.toString.toString()).toMatch(/\[native code\]/);
    expect(Function.prototype.toString.name).toBe("toString");
    expect(Function.prototype.toString.length).toBe(0);
    // Unrelated functions are unaffected; a non-function `this` still throws like the original.
    const plain = function plain() {
      return 1;
    };
    expect(plain.toString()).toBe(sourceOf(plain));
    expect(() => Function.prototype.toString.call({})).toThrow(TypeError);
  });

  it("uninstall() restores every descriptor and Function.prototype.toString", () => {
    const before = Object.getOwnPropertyDescriptor(Element.prototype, "requestFullscreen");
    const getterBefore = Object.getOwnPropertyDescriptor(DocumentProto, "fullscreenElement");
    const matchesBefore = Element.prototype.matches;
    install();
    layer.uninstall();
    expect(Object.getOwnPropertyDescriptor(Element.prototype, "requestFullscreen")).toEqual(before);
    expect(Object.getOwnPropertyDescriptor(DocumentProto, "fullscreenElement")).toEqual(getterBefore);
    expect(Element.prototype.matches).toBe(matchesBefore);
    expect(Function.prototype.toString).toBe(nativeToString);
  });
});

describe("request and exit order", () => {
  it("getters change synchronously, the promise resolves in a microtask, the change event fires at the next animation frame, then resize", async () => {
    install();
    const video = connectedVideo();
    const log: string[] = [];
    document.addEventListener("fullscreenchange", (event) => log.push(`change:${event.target === video}:${document.fullscreenElement === video}`));
    window.addEventListener("resize", () => log.push("resize"));
    const promise = video.requestFullscreen().then((value) => log.push(`resolved:${String(value)}:${document.fullscreenElement === video}`));
    log.push(`sync:${document.fullscreenElement === video}:${document.fullscreen}:${pdoc.webkitIsFullScreen}`);
    requestAnimationFrame(() => log.push("page-raf")); // registered after the request: runs after our change event
    await promise;
    log.push("after-promise");
    await nextFrame();
    expect(log).toEqual(["sync:true:true:true", "resolved:undefined:true", "after-promise", "change:true:true", "resize", "page-raf"]);
    expect(notes).toEqual([{ type: "entered", requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), mode: "fill-tab" }]);
    expect(stubs.calls).toEqual([]); // the browser never saw the request

    log.length = 0;
    const exited = document.exitFullscreen().then(() => log.push(`exit-resolved:${document.fullscreenElement}`));
    log.push(`exit-sync:${document.fullscreenElement}:${document.fullscreen}`);
    await exited;
    await nextFrame();
    expect(log).toEqual(["exit-sync:null:false", "exit-resolved:null", "change:true:false", "resize"]);
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "api" });
  });

  it("prefixed requests fire webkitfullscreenchange, unprefixed ones fullscreenchange; handler attributes run", async () => {
    install();
    const video = connectedVideo();
    const log = eventLog();
    let handler = 0;
    pdoc.onwebkitfullscreenchange = () => handler++;
    expect(video.webkitRequestFullscreen()).toBeUndefined();
    expect(pdoc.webkitFullscreenElement).toBe(video);
    expect(pdoc.webkitCurrentFullScreenElement).toBe(video);
    await nextFrame();
    expect(pdoc.webkitExitFullscreen()).toBeUndefined();
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["webkitfullscreenchange", "resize", "webkitfullscreenchange", "resize"]);
    expect(handler).toBe(2);

    log.length = 0;
    await video.requestFullscreen();
    await nextFrame();
    expect(pdoc.webkitCancelFullScreen()).toBeUndefined();
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["fullscreenchange", "resize", "fullscreenchange", "resize"]);
  });

  it("dispatches bubbling, composed events from inside shadow roots and retargets the getters", async () => {
    install();
    const outerHost = document.createElement("div");
    document.body.append(outerHost);
    const outer = outerHost.attachShadow({ mode: "open" });
    const innerHost = document.createElement("div");
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: "closed" });
    const video = document.createElement("video");
    inner.append(video);
    const unrelated = document.createElement("div").attachShadow({ mode: "open" });

    const seen: Array<[string, boolean]> = [];
    const listen = (label: string, target: EventTarget): void =>
      target.addEventListener("fullscreenchange", (event) => seen.push([label, event.composedPath()[0] === video]));
    listen("document", document);
    listen("window", window);
    await video.requestFullscreen();
    expect(document.fullscreenElement).toBe(outerHost);
    expect(outer.fullscreenElement).toBe(innerHost);
    expect(inner.fullscreenElement).toBe(video);
    expect(unrelated.fullscreenElement).toBeNull();
    await nextFrame();
    expect(seen).toEqual([
      ["document", true],
      ["window", true],
    ]);
  });

  it("webkitEnterFullscreen fakes a prefixed request on the video; the video's webkitExitFullscreen leaves", async () => {
    install();
    const video = connectedVideo();
    const log = eventLog();
    expect(video.webkitEnterFullscreen()).toBeUndefined();
    expect(document.fullscreenElement).toBe(video);
    expect(video.webkitDisplayingFullscreen).toBe(true);
    await nextFrame();
    video.webkitExitFullscreen();
    expect(document.fullscreenElement).toBeNull();
    expect(video.webkitDisplayingFullscreen).toBe(false);
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["webkitfullscreenchange", "resize", "webkitfullscreenchange", "resize"]);
    expect(stubs.calls).toEqual([]);
  });

  it("webkitEnterFullscreen throws InvalidStateError before metadata where the original does", () => {
    stubs.videoEnterThrows = true;
    install();
    const video = connectedVideo();
    expect(video.readyState).toBe(0);
    let thrown: unknown;
    try {
      video.webkitEnterFullscreen();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("InvalidStateError");
    expect(document.fullscreenElement).toBeNull();
    expect(stubs.calls).toEqual([]); // the probe ran on a video in an inert document, not on this one
  });

  it("a second request on another element replaces the first; one backdrop", async () => {
    install();
    const first = connectedVideo();
    const second = connectedVideo();
    await first.requestFullscreen();
    await second.requestFullscreen();
    expect(document.fullscreenElement).toBe(second);
    expect(first.hasAttribute("style")).toBe(false);
    expect(first.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
    expect(document.querySelectorAll(`[${BACKDROP_ATTRIBUTE}]`)).toHaveLength(1);
    // Requesting the current element again resolves without another event.
    const log = eventLog();
    await nextFrame();
    log.length = 0;
    await second.requestFullscreen();
    await nextFrame();
    expect(log).toEqual([]);
  });
});

describe("errors", () => {
  it("a disconnected element: rejects with TypeError and fires fullscreenerror at the document", async () => {
    install();
    const log = eventLog();
    const element = document.createElement("div");
    const error = await element.requestFullscreen().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(NOT_CONNECTED_ERROR);
    expect(document.fullscreenElement).toBeNull();
    await nextFrame();
    expect(log).toEqual([{ type: "fullscreenerror", target: document }]);
    expect(notes).toEqual([]);
  });

  it("fullscreenEnabled false (an <iframe> without allowfullscreen): rejects and fires fullscreenerror at the element", async () => {
    stubs.fullscreenEnabled = false;
    install();
    const video = connectedVideo();
    const log = eventLog();
    const error = await video.requestFullscreen().catch((e: unknown) => e);
    expect((error as TypeError).message).toBe(POLICY_ERROR);
    expect(document.fullscreenEnabled).toBe(false); // the original value, unchanged
    await nextFrame();
    expect(log).toEqual([{ type: "fullscreenerror", target: video }]);
  });

  it("no transient user activation: rejects like the browser (pages that try fullscreen on load still fail)", async () => {
    stubs.userActive = false;
    install();
    const video = connectedVideo();
    const log = eventLog();
    await expect(video.requestFullscreen()).rejects.toThrow(PERMISSION_ERROR);
    expect(video.webkitRequestFullscreen()).toBeUndefined();
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["fullscreenerror", "webkitfullscreenerror"]);
    expect(document.fullscreenElement).toBeNull();
  });

  it("rejects elements that cannot be fullscreen and invalid options", async () => {
    install();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    svg.append(rect);
    document.body.append(svg);
    await expect(rect.requestFullscreen()).rejects.toThrow(ELEMENT_TYPE_ERROR);
    // Chromium accepts neither MathML <math> nor any <dialog>, modal or not.
    const math = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
    document.body.append(math);
    await expect(math.requestFullscreen()).rejects.toThrow(ELEMENT_TYPE_ERROR);
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    await expect(dialog.requestFullscreen()).rejects.toThrow(DIALOG_ERROR);
    const video = connectedVideo();
    await expect(video.requestFullscreen({ navigationUI: "sideways" as FullscreenNavigationUI })).rejects.toThrow(TypeError);
    expect(document.fullscreenElement).toBeNull();
    await svg.requestFullscreen(); // an SVG <svg> element is allowed
    expect(document.fullscreenElement).toBe(svg);
  });

  it("checks in Chromium's order: element type, dialog, connected, permissions policy, user activation", async () => {
    stubs.fullscreenEnabled = false;
    stubs.userActive = false;
    install();
    const message = (promise: Promise<void>): Promise<string> => promise.then(() => "resolved", (e: unknown) => (e as TypeError).message);
    expect(await message(document.createElementNS("http://www.w3.org/2000/svg", "rect").requestFullscreen())).toBe(ELEMENT_TYPE_ERROR);
    expect(await message(document.createElement("dialog").requestFullscreen())).toBe(DIALOG_ERROR);
    expect(await message(document.createElement("div").requestFullscreen())).toBe(NOT_CONNECTED_ERROR);
    expect(await message(connectedVideo().requestFullscreen())).toBe(POLICY_ERROR);
    stubs.fullscreenEnabled = true;
    expect(await message(connectedVideo().requestFullscreen())).toBe(PERMISSION_ERROR);
  });

  it("exitFullscreen() when nothing is fullscreen rejects with TypeError", async () => {
    install();
    const error = await document.exitFullscreen().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(NOT_ACTIVE_ERROR);
    expect(pdoc.webkitExitFullscreen()).toBeUndefined(); // the prefixed exit is a no-op, as in Chromium
  });
});

describe("pass-through", () => {
  for (const [label, override] of [
    ["the site is disabled", { enabled: false }],
    ["preferReal is set", { preferReal: true }],
  ] as const) {
    it(`when ${label}, originals get the same this and arguments and their return value is passed back`, async () => {
      install({ ...config, ...override });
      const video = connectedVideo();
      const options = { navigationUI: "hide" as const };
      const result = video.requestFullscreen(options);
      expect(result).toBe(stubs.lastResult);
      expect(stubs.calls).toEqual([{ name: "requestFullscreen", self: video, args: [options] }]);
      expect(document.fullscreenElement).toBe(video); // the stub's real fullscreen, through the original getter
      expect(video.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
      const exit = document.exitFullscreen();
      expect(exit).toBe(stubs.lastResult);
      expect(stubs.calls.at(-1)).toEqual({ name: "exitFullscreen", self: document, args: [] });
      expect(video.webkitRequestFullScreen()).toBeUndefined();
      expect(stubs.calls.at(-1)).toEqual({ name: "webkitRequestFullScreen", self: video, args: [] });
      expect(notes).toEqual([]);
      await nextFrame();
    });
  }

  it("a real fullscreen in progress wins: getters report it and requests pass through", async () => {
    install();
    const real = connectedVideo();
    const other = connectedVideo();
    stubs.realElement = real;
    expect(document.fullscreenElement).toBe(real);
    await other.requestFullscreen();
    expect(stubs.calls.map((call) => call.name)).toEqual(["requestFullscreen"]);
    expect(other.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
  });

  it("holds a request made before the first config, then fakes it when the config arrives", async () => {
    install(null);
    const video = connectedVideo();
    let settled = false;
    const promise = video.requestFullscreen().then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    expect(document.fullscreenElement).toBeNull();
    layer.configure(config);
    await promise;
    expect(document.fullscreenElement).toBe(video);
    expect(stubs.calls).toEqual([]);
  });

  it("passes a held request through to the real API when no config arrives in time", async () => {
    install(null);
    const video = connectedVideo();
    const started = Date.now();
    await video.requestFullscreen();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(stubs.calls).toEqual([{ name: "requestFullscreen", self: video, args: [] }]);
    expect(video.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(false);
  });
});

describe("styling", () => {
  it("pins the element with inline !important declarations and restores the style attribute exactly", async () => {
    install();
    const video = connectedVideo();
    video.setAttribute("style", "color: red; width: 10px");
    await video.requestFullscreen();
    const style = video.style;
    for (const [property, value] of [
      ["position", "fixed"],
      ["left", "0px"],
      ["top", "0px"],
      ["width", "1000px"],
      ["height", "800px"],
      ["z-index", "2147483647"],
      ["object-fit", "contain"],
      ["box-sizing", "border-box"],
      ["transform", "none"],
    ]) {
      expect(style.getPropertyValue(property as string), property).toBe(value);
      expect(style.getPropertyPriority(property as string), property).toBe("important");
    }
    expect(style.getPropertyValue("color")).toBe("red");
    await document.exitFullscreen();
    expect(video.getAttribute("style")).toBe("color: red; width: 10px");

    const plain = document.createElement("div");
    document.body.append(plain);
    await plain.requestFullscreen();
    expect(plain.style.getPropertyValue("object-fit")).toBe(""); // only for <video>
    await document.exitFullscreen();
    expect(plain.hasAttribute("style")).toBe(false);
  });

  it("uses the custom rectangle in the top frame, recomputes it on resize, and fills the viewport in child frames", async () => {
    install({
      ...config,
      mode: "custom-rect",
      customRect: { width: { value: 50, unit: "%" }, height: { value: 300, unit: "px" }, anchor: "bottom-right" },
    });
    const video = connectedVideo();
    await video.requestFullscreen();
    const rect = () => ["left", "top", "width", "height"].map((p) => video.style.getPropertyValue(p));
    expect(rect()).toEqual(["500px", "500px", "500px", "300px"]);
    setViewport(600, 400);
    await settle();
    expect(rect()).toEqual(["300px", "100px", "300px", "300px"]);
    // goReal (toggle command) fills the tab; goFake returns to the rectangle.
    layer.goReal();
    expect(rect()).toEqual(["0px", "0px", "600px", "400px"]);
    layer.goFake();
    expect(rect()).toEqual(["300px", "100px", "300px", "300px"]);
    await document.exitFullscreen();

    layer.configure({ ...config, mode: "custom-rect", topFrame: false });
    await video.requestFullscreen();
    expect(rect()).toEqual(["0px", "0px", "600px", "400px"]);
  });

  it("neutralises ancestors that trap position: fixed, marks every ancestor, and restores them exactly", async () => {
    install();
    const outer = document.createElement("section");
    const wrapper = document.createElement("div");
    const plainAncestor = document.createElement("div");
    const video = document.createElement("video");
    wrapper.setAttribute("style", "transform: translateZ(0); position: relative; z-index: 1; opacity: 0.5; filter: blur(2px); contain: paint; will-change: transform");
    outer.append(wrapper);
    wrapper.append(plainAncestor);
    plainAncestor.append(video);
    document.body.append(outer);

    await video.requestFullscreen();
    const overridden = wrapper.style;
    for (const [property, value] of [
      ["transform", "none"],
      ["z-index", "2147483647"],
      ["opacity", "1"],
      ["filter", "none"],
      ["contain", "none"],
      ["will-change", "auto"],
    ]) {
      expect(overridden.getPropertyValue(property as string), property).toBe(value);
      expect(overridden.getPropertyPriority(property as string), property).toBe("important");
    }
    expect(overridden.getPropertyValue("position")).toBe("relative");
    expect(plainAncestor.hasAttribute("style")).toBe(false);
    expect(video.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    for (const ancestor of [plainAncestor, wrapper, outer, document.body, document.documentElement]) {
      expect(ancestor.hasAttribute(ANCESTOR_ATTRIBUTE), ancestor.tagName).toBe(true);
    }

    await document.exitFullscreen();
    expect(wrapper.getAttribute("style")).toBe(
      "transform: translateZ(0); position: relative; z-index: 1; opacity: 0.5; filter: blur(2px); contain: paint; will-change: transform",
    );
    expect(plainAncestor.hasAttribute("style")).toBe(false);
    expect(document.querySelectorAll(`[${ANCESTOR_ATTRIBUTE}], [${FULLSCREEN_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it("inserts the backdrop as the last child of <html> and removes it on exit", async () => {
    install();
    const video = connectedVideo();
    await video.requestFullscreen();
    const backdrop = document.documentElement.lastElementChild as HTMLElement;
    expect(backdrop.hasAttribute(BACKDROP_ATTRIBUTE)).toBe(true);
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.style.getPropertyValue("position")).toBe("fixed");
    expect(backdrop.style.getPropertyValue("z-index")).toBe("2147483646");
    expect(backdrop.style.getPropertyValue("background")).toContain("#101010");
    expect(video.style.getPropertyValue("background")).toContain("#101010");
    layer.configure({ ...config, backgroundColor: "#203040" });
    expect(backdrop.style.getPropertyValue("background")).toContain("#203040");
    await document.exitFullscreen();
    expect(document.querySelector(`[${BACKDROP_ATTRIBUTE}]`)).toBeNull();
  });

  it("mirrors same-origin :fullscreen and ::backdrop rules, also inside @media, into an adopted sheet", async () => {
    install();
    const style = document.createElement("style");
    style.textContent = [
      ".player:fullscreen { color: red !important; }",
      "@media (min-width: 1px) { .player:-webkit-full-screen .controls { height: 10px; } }",
      ".player:fullscreen::backdrop { background: green; }",
      "dialog::backdrop { background: blue; }",
      ".other, .x:hover { color: blue; }",
      '.x[title=":fullscreen"], .player:not(:fullscreen) { margin: 1px; }',
      ":-webkit-full-screen-ancestor { overflow: clip; }",
    ].join("\n");
    document.head.append(style);
    const player = document.createElement("div");
    player.className = "player";
    document.body.append(player);
    const adoptedBefore = document.adoptedStyleSheets.length;

    await player.requestFullscreen();
    expect(document.adoptedStyleSheets).toHaveLength(adoptedBefore + 1);
    const sheet = document.adoptedStyleSheets.at(-1) as CSSStyleSheet;
    const text = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    expect(text).toContain(`.player[${FULLSCREEN_ATTRIBUTE}] { color: red !important; }`);
    expect(text).toMatch(/@media \(min-width: 1px\) \{\s*\.player\[data-cfs-fullscreen\] \.controls \{ height: 10px; \}\s*\}/);
    expect(text).toContain(`[${BACKDROP_ATTRIBUTE}] { background: green; }`);
    expect(text).not.toContain("blue"); // dialog::backdrop and rules without :fullscreen are not copied
    expect(text).toContain(`.player:not([${FULLSCREEN_ATTRIBUTE}]) { margin: 1px; }`);
    expect(text).not.toContain('title=":fullscreen"');
    expect(text).toContain(`[${ANCESTOR_ATTRIBUTE}] { overflow: clip; }`);
    expect(text).toContain(`:where([${FULLSCREEN_ATTRIBUTE}]) { object-fit: contain; }`); // UA equivalent

    await document.exitFullscreen();
    expect(document.adoptedStyleSheets).toHaveLength(adoptedBefore);
    expect(sheet.cssRules).toHaveLength(0);
  });

  it("lists :not(:fullscreen) page rules for the in-place rewrite, and mirrors rules inserted while active", async () => {
    install();
    const style = document.createElement("style");
    document.head.append(style);
    const sheet = style.sheet as CSSStyleSheet;
    sheet.insertRule(".player:not(:fullscreen) .only-fs { display: none; }", 0);
    sheet.insertRule("@media (min-width: 1px) { .player:not(:-webkit-full-screen) .x { color: red; } }", 1);
    // The scan finds the negated rules, also inside grouping rules. (happy-dom's selectorText has no setter, so
    // the in-place rewrite itself is checked in Chromium: tests/e2e/negated-fullscreen.spec.ts.)
    const { rewrites } = mirrorRuleList(sheet.cssRules, () => false);
    expect(rewrites.map(({ text }) => text)).toEqual([
      `.player:not(:is(:fullscreen, [${FULLSCREEN_ATTRIBUTE}])) .only-fs`,
      `.player:not(:is(:-webkit-full-screen, [${FULLSCREEN_ATTRIBUTE}])) .x`,
    ]);
    const player = document.createElement("div");
    player.className = "player";
    document.body.append(player);

    await player.requestFullscreen();
    const adopted = document.adoptedStyleSheets.at(-1) as CSSStyleSheet;
    // Inserted while active (emotion's insertRule): mirrored into our sheet, and still inserted where the page asked.
    expect(sheet.insertRule(".late:fullscreen .y { color: blue; }", 2)).toBe(2);
    expect(Array.from(adopted.cssRules, (rule) => rule.cssText).join("\n")).toContain(`.late[${FULLSCREEN_ATTRIBUTE}] .y { color: blue; }`);
    expect((sheet.cssRules[2] as CSSStyleRule).selectorText).toBe(".late:fullscreen .y");

    await document.exitFullscreen();
    expect(adopted.cssRules).toHaveLength(0);
    // Not active: nothing is mirrored.
    sheet.insertRule(".later:fullscreen .z { color: green; }", 3);
    expect(document.adoptedStyleSheets).not.toContain(adopted);
  });

  it("matches(':fullscreen'), closest() and querySelector(All) see the fake element only while it is active", async () => {
    install();
    const container = document.createElement("div");
    const inner = document.createElement("span");
    const decoy = document.createElement("i");
    decoy.title = ":fullscreen";
    container.append(inner);
    document.body.append(container, decoy);
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const shadowVideo = document.createElement("video");
    shadow.append(shadowVideo);

    expect(container.matches(":fullscreen")).toBe(false);
    await container.requestFullscreen();
    expect(container.matches(":fullscreen")).toBe(true);
    expect(container.matches(":-webkit-full-screen")).toBe(true);
    expect(inner.matches(":fullscreen")).toBe(false);
    expect(inner.closest(":fullscreen")).toBe(container);
    expect(document.body.matches(":-webkit-full-screen-ancestor")).toBe(true);
    expect(document.querySelector(":fullscreen")).toBe(container);
    expect(document.querySelectorAll(":fullscreen")).toHaveLength(1);
    expect(document.body.querySelector(":fullscreen > span")).toBe(inner);
    expect(document.querySelector('[title=":fullscreen"]')).toBe(decoy); // strings are not rewritten

    await shadowVideo.requestFullscreen();
    expect(shadow.querySelector(":fullscreen")).toBe(shadowVideo);
    expect(container.matches(":fullscreen")).toBe(false);

    await document.exitFullscreen();
    expect(shadowVideo.matches(":fullscreen")).toBe(false);
    expect(document.querySelector(":fullscreen")).toBeNull();
  });

  it("re-applies the pin when the page rewrites the element's inline style", async () => {
    install();
    const video = connectedVideo();
    await video.requestFullscreen();
    video.style.width = "100px"; // drops !important, like a player resizing its video
    await settle();
    expect(video.style.getPropertyValue("width")).toBe("1000px");
    expect(video.style.getPropertyPriority("width")).toBe("important");
    await document.exitFullscreen();
    expect(video.hasAttribute("style")).toBe(false);
  });
});

describe("exit paths", () => {
  it("removing the element exits (reason removed) and fires the change event at the document", async () => {
    install();
    const wrapper = document.createElement("div");
    const video = document.createElement("video");
    wrapper.append(video);
    document.body.append(wrapper);
    await video.requestFullscreen();
    await nextFrame();
    const log = eventLog(["fullscreenchange"]);
    wrapper.remove();
    await settle();
    expect(document.fullscreenElement).toBeNull();
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "removed" });
    await nextFrame();
    expect(log).toEqual([{ type: "fullscreenchange", target: document }]);
    expect(document.querySelector(`[${BACKDROP_ATTRIBUTE}]`)).toBeNull();
  });

  it("follows an element that is moved to another container instead of exiting", async () => {
    install();
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.setAttribute("style", "transform: scale(2)");
    const video = document.createElement("video");
    first.append(video);
    document.body.append(first, second);
    await video.requestFullscreen();
    expect(first.hasAttribute(ANCESTOR_ATTRIBUTE)).toBe(true);
    second.append(video);
    await settle();
    expect(document.fullscreenElement).toBe(video);
    expect(first.hasAttribute(ANCESTOR_ATTRIBUTE)).toBe(false);
    expect(second.hasAttribute(ANCESTOR_ATTRIBUTE)).toBe(true);
    expect(second.style.getPropertyValue("transform")).toBe("none");
    await document.exitFullscreen();
    expect(second.getAttribute("style")).toBe("transform: scale(2)");
  });

  it("exits with reason disabled when the site is disabled while active", async () => {
    install();
    const video = connectedVideo();
    await video.requestFullscreen();
    layer.configure({ ...config, enabled: false });
    expect(document.fullscreenElement).toBeNull();
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "disabled" });
  });

  it("exit(reason) from the ISOLATED world leaves; a refusal before the change event becomes a fullscreenerror only", async () => {
    install();
    const video = connectedVideo();
    const log = eventLog();
    await video.requestFullscreen();
    layer.exit("refused");
    expect(document.fullscreenElement).toBeNull();
    await nextFrame();
    expect(log).toEqual([{ type: "fullscreenerror", target: video }]);
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "refused" });

    log.length = 0;
    await video.requestFullscreen();
    await nextFrame();
    layer.exit("escape");
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["fullscreenchange", "resize", "fullscreenchange", "resize"]);
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "escape" });
  });
});

describe("real fullscreen the page did not ask for (native <video controls>)", () => {
  /** The browser goes really fullscreen on `element` by itself, as the controls' button makes it. */
  function browserFullscreen(element: Element, type = "fullscreenchange"): void {
    stubs.realElement = element;
    element.dispatchEvent(trustedChange(type));
  }

  it("leaves real fullscreen and enters fake fullscreen on the video; the page sees one change event", async () => {
    install();
    const video = connectedVideo();
    const log = eventLog();
    browserFullscreen(video);
    expect(log).toEqual([]); // the real enter is not seen by the page
    expect(stubs.calls.map((c) => c.name)).toEqual(["exitFullscreen"]);
    expect(stubs.realElement).toBeNull();
    await settle();
    video.dispatchEvent(trustedChange()); // the real exit's change event: not seen either
    expect(layer.inspect.element).toBe(video);
    expect(layer.inspect.requestType).toBe("unprefixed");
    expect(video.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    expect(notes).toContainEqual(expect.objectContaining({ type: "entered", mode: "fill-tab" }));
    await nextFrame();
    expect(log.map((entry) => entry.type)).toEqual(["fullscreenchange", "resize"]);
    expect(log[0]?.target).toBe(video);

    // The same button on the fake-fullscreen video leaves fake fullscreen; no further real request (no loop).
    browserFullscreen(video);
    await settle();
    video.dispatchEvent(trustedChange());
    expect(layer.inspect.element).toBeNull();
    await nextFrame();
    expect(log.filter((entry) => entry.type === "fullscreenchange")).toHaveLength(2);
    expect(stubs.calls.map((c) => c.name)).toEqual(["exitFullscreen", "exitFullscreen"]);
  });

  it("a container with a video in it is adopted with the event's prefix; untrusted events are ignored", async () => {
    install();
    const player = document.createElement("div");
    player.append(document.createElement("video"));
    document.body.append(player);
    player.dispatchEvent(new Event("fullscreenchange", { bubbles: true })); // a page's own synthetic event
    expect(stubs.calls).toEqual([]);
    browserFullscreen(player, "webkitfullscreenchange");
    await settle();
    player.dispatchEvent(trustedChange("webkitfullscreenchange"));
    expect(layer.inspect.element).toBe(player);
    expect(layer.inspect.requestType).toBe("prefixed");
  });

  it("stays real for the page's own requests, preferReal, a disabled site, goReal and elements without media", async () => {
    // The page's own request, passed through (preferReal): its real fullscreen is the page's.
    install({ ...config, preferReal: true });
    const video = connectedVideo();
    await video.requestFullscreen();
    video.dispatchEvent(trustedChange());
    await settle();
    expect(stubs.realElement).toBe(video);
    expect(layer.inspect.element).toBeNull();
    stubs.realElement = null;
    video.dispatchEvent(trustedChange());

    // preferReal armed, without a page request (the native button after the toggle).
    browserFullscreen(video);
    await settle();
    expect(stubs.realElement).toBe(video);
    stubs.realElement = null;
    video.dispatchEvent(trustedChange());

    // A disabled site.
    layer.configure({ ...config, enabled: false });
    browserFullscreen(video);
    await settle();
    expect(stubs.realElement).toBe(video);
    stubs.realElement = null;
    video.dispatchEvent(trustedChange());

    // No media element in it.
    layer.configure(config);
    const div = document.createElement("div");
    document.body.append(div);
    browserFullscreen(div);
    await settle();
    expect(stubs.realElement).toBe(div);
    stubs.realElement = null;
    div.dispatchEvent(trustedChange());
    expect(stubs.calls.filter((c) => c.name === "exitFullscreen")).toEqual([]);

    // Switched to real by the toggle (goReal): a native request on another video stays real.
    const other = connectedVideo();
    await video.requestFullscreen();
    layer.goReal();
    browserFullscreen(other);
    await settle();
    expect(stubs.realElement).toBe(other);
    expect(layer.inspect.element).toBe(video);
  });
});

describe("frames", () => {
  it("enterFrameElement pins the <iframe>, updates the getters, fires fullscreenchange at it and passes the request id up", async () => {
    install({ ...config, mode: "custom-rect" });
    const frame = frameElement();
    frame.setAttribute("style", "border: 2px solid");
    document.body.append(frame);
    const log = eventLog(["fullscreenchange"]);
    layer.enterFrameElement(frame, "child_request_1");
    expect(document.fullscreenElement).toBe(frame);
    expect(frame.style.getPropertyValue("position")).toBe("fixed");
    expect(frame.style.getPropertyValue("width")).toBe("800px"); // the user's rectangle in the top frame (80%)
    expect(notes).toEqual([{ type: "entered", requestId: "child_request_1", mode: "custom-rect" }]);
    // The same child requests again: same element, new id, no second event.
    layer.enterFrameElement(frame, "child_request_2");
    expect(notes.at(-1)).toEqual({ type: "entered", requestId: "child_request_2", mode: "custom-rect" });
    await nextFrame();
    expect(log).toEqual([{ type: "fullscreenchange", target: frame }]);
    layer.exit("frame");
    expect(frame.getAttribute("style")).toBe("border: 2px solid");
    expect(notes.at(-1)).toEqual({ type: "exited", reason: "frame" });
  });

  it("ignores enterFrameElement while disabled or for elements of other documents", () => {
    install({ ...config, enabled: false });
    const frame = frameElement();
    document.body.append(frame);
    layer.enterFrameElement(frame, "child_request_1");
    expect(document.fullscreenElement).toBeNull();
    layer.configure(config);
    const foreign = document.implementation.createHTMLDocument("").createElement("iframe");
    layer.enterFrameElement(foreign, "child_request_1");
    expect(document.fullscreenElement).toBeNull();
    expect(notes).toEqual([]);
  });
});

describe("document-root requests (YouTube's watch page asks for fullscreen on <html>)", () => {
  const html = document.documentElement;
  const rootStyle = html.getAttribute("style");
  afterEach(() => {
    if (rootStyle === null) html.removeAttribute("style");
    else html.setAttribute("style", rootStyle);
  });

  const backdropOf = (): HTMLElement => document.querySelector(`[${BACKDROP_ATTRIBUTE}]`) as HTMLElement;

  it("fill-tab: the backdrop, inside <html>, is not rendered, so it neither covers the page nor sits over the video", async () => {
    install();
    html.setAttribute("style", "--page-token: 17");
    await html.requestFullscreen();
    expect(document.fullscreenElement).toBe(html);
    expect(html.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    expect(html.style.getPropertyValue("position")).toBe("fixed");
    expect(html.style.getPropertyValue("width")).toBe("1000px");
    expect(html.style.getPropertyValue("height")).toBe("800px");
    expect(html.style.getPropertyValue("transform")).toBe("none");
    const backdrop = backdropOf();
    expect(backdrop.parentElement).toBe(html);
    // The rectangle is the whole viewport: nothing to cover. No clip-path either (Chromium composites it, and
    // its mask, as layers over the video: the black flicker on YouTube).
    expect(backdrop.style.getPropertyValue("display")).toBe("none");
    expect(backdrop.style.getPropertyValue("clip-path")).toBe("none");
    expect(backdrop.style.getPropertyValue("width")).toBe("1000px");
    // The root's own scrollbar would cover the rectangle.
    expect(Array.from(document.adoptedStyleSheets.at(-1)?.cssRules ?? [], (rule) => rule.cssText).join("\n")).toContain(
      `:root[${FULLSCREEN_ATTRIBUTE}]`,
    );
    await document.exitFullscreen();
    expect(html.getAttribute("style")).toBe("--page-token: 17");
    expect(backdropOf()).toBeNull();
  });

  it("custom-rect: <html> is laid out at least viewport-sized and scaled onto the rect; the backdrop's strips surround the rect", async () => {
    install({ ...config, mode: "custom-rect", customRect: { width: { value: 400, unit: "px" }, height: { value: 200, unit: "px" }, anchor: "center" } });
    await html.requestFullscreen();
    // 1000 × 800 viewport, 400 × 200 rect at (300, 300): scale min(0.4, 0.25) = 0.25, layout 1600 × 800.
    expect(html.style.getPropertyValue("left")).toBe("300px");
    expect(html.style.getPropertyValue("top")).toBe("300px");
    expect(html.style.getPropertyValue("width")).toBe("1600px");
    expect(html.style.getPropertyValue("height")).toBe("800px");
    expect(html.style.getPropertyValue("transform")).toBe("scale(0.25)");
    expect(html.style.getPropertyValue("transform-origin")).toBe("0 0");
    // The scaled <html> contains the fixed backdrop: it is placed in <html>'s unscaled coordinates.
    const backdrop = backdropOf();
    expect(backdrop.style.getPropertyValue("left")).toBe("-1200px");
    expect(backdrop.style.getPropertyValue("top")).toBe("-1200px");
    expect(backdrop.style.getPropertyValue("width")).toBe("4000px");
    expect(backdrop.style.getPropertyValue("height")).toBe("3200px");
    // The box itself paints nothing and takes no clicks; its four strips cover everything but the rect.
    expect(backdrop.style.getPropertyValue("display")).toBe("block");
    expect(backdrop.style.getPropertyValue("clip-path")).toBe("none");
    expect(backdrop.style.getPropertyValue("background")).toBe("transparent");
    expect(backdrop.style.getPropertyValue("pointer-events")).toBe("none");
    const strips = (): string[][] =>
      Array.from(backdrop.children as HTMLCollectionOf<HTMLElement>, (strip) =>
        ["left", "top", "width", "height", "background", "pointer-events"].map((property) => strip.style.getPropertyValue(property)),
      );
    expect(strips()).toEqual([
      ["0px", "0px", "4000px", "1200px", "#101010", "auto"],
      ["0px", "2000px", "4000px", "1200px", "#101010", "auto"],
      ["0px", "1200px", "1200px", "800px", "#101010", "auto"],
      ["2800px", "1200px", "1200px", "800px", "#101010", "auto"],
    ]);
    // A resize re-pins both.
    setViewport(800, 800);
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(html.style.getPropertyValue("left")).toBe("200px");
    expect(html.style.getPropertyValue("width")).toBe("1600px");
    expect(backdrop.style.getPropertyValue("width")).toBe("3200px");
    expect(strips()[3]).toEqual(["2400px", "1200px", "800px", "800px", "#101010", "auto"]);
    // Switching to fill-tab hides it.
    layer.configure({ ...config, mode: "fill-tab" });
    expect(backdrop.style.getPropertyValue("display")).toBe("none");
    await document.exitFullscreen();
    expect(html.hasAttribute("style")).toBe(false);
    expect(backdropOf()).toBeNull();
  });

  it("player activity (class toggles, overlay nodes, spurious resizes) makes no style writes and no re-attach", async () => {
    // The black flicker on YouTube: the player toggles classes and inserts tooltips on every mouse move. None of
    // that changes what is pinned, so the extension must not write anything in response. Spies installed before
    // the layer captures its natives see every write it makes.
    const writes: string[] = [];
    let recording = false;
    const watched: Array<[object, string]> = [
      [CSSStyleDeclaration.prototype, "setProperty"],
      [CSSStyleDeclaration.prototype, "removeProperty"],
      [Element.prototype, "setAttribute"],
      [Element.prototype, "removeAttribute"],
    ];
    const spies = watched.map(([proto, name]) => {
      const original = (proto as Record<string, (...args: unknown[]) => unknown>)[name] as (...args: unknown[]) => unknown;
      return vi.spyOn(proto as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (recording) writes.push(`${name}(${args.join(", ")})`);
        return original.apply(this, args);
      });
    });
    try {
      install({ ...config, mode: "custom-rect" });
      const player = document.createElement("div");
      player.id = "movie_player";
      player.append(document.createElement("video"));
      document.body.append(player);
      await html.requestFullscreen();
      await settle();
      expect(document.querySelector(`[${BACKDROP_ATTRIBUTE}]`)?.children).toHaveLength(4);
      // The page's own writes are not recorded (this DOM implements classList with setAttribute); what runs
      // in response (observers, resize listeners) is.
      const ours = async (run: () => void = () => undefined): Promise<void> => {
        recording = true;
        run();
        await settle();
        recording = false;
      };
      for (let i = 0; i < 20; i++) {
        player.classList.toggle("ytp-autohide");
        const tooltip = document.createElement("div");
        tooltip.className = "ytp-tooltip";
        player.append(tooltip);
        await ours();
        tooltip.remove();
        await ours(() => window.dispatchEvent(new Event("resize")));
      }
      expect(writes).toEqual([]);
      expect(html.hasAttribute(FULLSCREEN_ATTRIBUTE)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("backdropStrips tile the viewport around the rect; holeCoversViewport spots fill-tab", () => {
    const rect = { left: 100, top: 50, width: 600, height: 400 };
    const viewport = { width: 1000, height: 800 };
    // scale = min(0.6, 0.5) = 0.5: the backdrop's own coordinates are twice the viewport's.
    const boxes = backdropStrips({ rect, backgroundColor: "red" }, viewport).map((declarations) => {
      const get = (property: string): string => declarations.find(([name]) => name === property)?.[1] ?? "";
      return ["left", "top", "width", "height"].map((property) => Number.parseFloat(get(property)));
    });
    expect(boxes).toEqual([
      [0, 0, 2000, 100],
      [0, 900, 2000, 700],
      [0, 100, 200, 800],
      [1400, 100, 600, 800],
    ]);
    const area = boxes.reduce((sum, [, , w, h]) => sum + (w as number) * (h as number), 0);
    expect(area).toBe(2000 * 1600 - 1200 * 800);
    expect(holeCoversViewport({ left: 0, top: 0, width: 1000, height: 800 }, viewport)).toBe(true);
    expect(holeCoversViewport(rect, viewport)).toBe(false);
    // A rect at the viewport's edge leaves empty strips, never negative ones.
    const edge = backdropStrips({ rect: { left: 0, top: 0, width: 1000, height: 400 }, backgroundColor: "red" }, viewport);
    expect(edge.map((declarations) => declarations.find(([name]) => name === "height")?.[1])).toEqual(["0px", "800px", "800px", "800px"]);
    expect(edge.map((declarations) => declarations.find(([name]) => name === "width")?.[1])).toEqual(["2000px", "2000px", "0px", "0px"]);
  });

  it("an element below <html> keeps a plain backdrop under it", async () => {
    install();
    const video = connectedVideo();
    await video.requestFullscreen();
    const backdrop = backdropOf();
    expect(backdrop.style.getPropertyValue("clip-path")).toBe("none");
    expect(backdrop.style.getPropertyValue("inset") || backdrop.style.getPropertyValue("top")).toBe("0px");
  });

  it("keeps the page's own writes to <html>'s style on exit, and they do not use up the re-apply budget", async () => {
    install();
    html.setAttribute("style", "--page-token: 17");
    await html.requestFullscreen();
    for (let i = 1; i <= MAX_STYLE_REAPPLY + 20; i++) {
      html.style.setProperty("--page-writes", String(i));
      await settle();
    }
    html.style.position = "static"; // a real fight still gets the pin back
    await settle();
    expect(html.style.getPropertyValue("position")).toBe("fixed");
    expect(html.style.getPropertyPriority("position")).toBe("important");
    await document.exitFullscreen();
    expect(html.style.getPropertyValue("--page-token")).toBe("17");
    expect(html.style.getPropertyValue("--page-writes")).toBe(String(MAX_STYLE_REAPPLY + 20));
    expect(html.style.getPropertyValue("position")).toBe("");
    expect(html.style.getPropertyValue("width")).toBe("");
    expect(html.style.getPropertyValue("z-index")).toBe("");
  });

  it("puts the document's scroll position back on exit", async () => {
    install();
    const scrolls: Array<[number, number]> = [];
    const scrollTo = window.scrollTo;
    window.scrollTo = ((x: number, y: number) => void scrolls.push([x, y])) as typeof window.scrollTo;
    try {
      layer.uninstall();
      Object.defineProperty(window, "scrollY", { configurable: true, get: () => 300 });
      install();
      await html.requestFullscreen();
      await document.exitFullscreen();
      expect(scrolls).toEqual([[0, 300]]);
    } finally {
      window.scrollTo = scrollTo;
      delete (window as unknown as { scrollY?: number }).scrollY;
    }
  });
});

describe("scaled document root: one coordinate space for the page (seek bars on YouTube in custom-rect)", () => {
  const html = document.documentElement;
  const rootStyle = html.getAttribute("style");
  const rect400x200 = { width: { value: 400, unit: "px" as const }, height: { value: 200, unit: "px" as const }, anchor: "center" as const };
  let points: Array<[number, number]>;
  beforeEach(() => {
    // Screen geometry as Chromium would report it, stubbed before the layer captures anything.
    points = [];
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(350, 325, 300, 50));
    vi.spyOn(DocumentProto as Document, "elementFromPoint").mockImplementation((x: number, y: number) => {
      points.push([x, y]);
      return document.body;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (rootStyle === null) html.removeAttribute("style");
    else html.setAttribute("style", rootStyle);
  });

  it("reports element boxes and takes hit-test points in <html>'s unscaled space while it is scaled, and only then", async () => {
    install({ ...config, mode: "custom-rect", customRect: rect400x200 });
    const bar = document.createElement("div");
    document.body.append(bar);
    // Not pinned yet: the browser's values pass through.
    expect(bar.getBoundingClientRect().x).toBe(350);
    await html.requestFullscreen();
    // 1000 × 800 viewport, 400 × 200 rect at (300, 300), scale 0.25: screen (350, 325) is (200, 100) in the root.
    const box = bar.getBoundingClientRect();
    expect([box.x, box.y, box.width, box.height]).toEqual([200, 100, 1200, 200]);
    expect(box).toBeInstanceOf(DOMRect);
    // A page point (200, 100) is screen (350, 325) for the browser's hit testing.
    document.elementFromPoint(200, 100);
    expect(points.at(-1)).toEqual([350, 325]);
    // A detached element's box is left alone.
    expect(document.createElement("div").getBoundingClientRect().x).toBe(350);
    // Untrusted (page-made) events are already in the page's space.
    const synthetic = new MouseEvent("mousedown", { clientX: 40, clientY: 50 });
    expect([synthetic.clientX, synthetic.clientY]).toEqual([40, 50]);
    // fill-tab: scale 1, nothing converted.
    layer.configure({ ...config, mode: "fill-tab" });
    expect(bar.getBoundingClientRect().x).toBe(350);
    document.elementFromPoint(200, 100);
    expect(points.at(-1)).toEqual([200, 100]);
    await document.exitFullscreen();
    expect(bar.getBoundingClientRect().x).toBe(350);
  });

  it("scales a container player like the root (Twitch: a fixed, viewport-sized layer inside div#root), but not a video or an iframe", async () => {
    install({ ...config, mode: "custom-rect", customRect: rect400x200 });
    const player = document.createElement("div");
    document.body.append(player);
    await player.requestFullscreen();
    // Laid out at least viewport-sized (1600 × 800 for a 400 × 200 rect in 1000 × 800) and scaled onto the rect:
    // the transform also makes it the containing block of its fixed descendants, as the viewport is.
    expect(["left", "top", "width", "height", "transform", "transform-origin"].map((property) => player.style.getPropertyValue(property))).toEqual([
      "300px",
      "300px",
      "1600px",
      "800px",
      "scale(0.25)",
      "0 0",
    ]);
    expect(player.getBoundingClientRect().x).toBe(200); // the page measures in the player's space
    await document.exitFullscreen();
    for (const element of [connectedVideo(), document.body.appendChild(document.createElement("iframe"))]) {
      await element.requestFullscreen();
      expect([element.style.getPropertyValue("width"), element.style.getPropertyValue("transform")]).toEqual(["400px", "none"]);
      expect(element.getBoundingClientRect().x).toBe(350); // no conversion: nothing is scaled
      await document.exitFullscreen();
    }
  });

  it("is installed lazily, on the first scaled root, and stays native-looking", async () => {
    const gbcr = Element.prototype.getBoundingClientRect;
    install({ ...config, mode: "fill-tab" });
    const video = connectedVideo();
    await html.requestFullscreen();
    await document.exitFullscreen();
    await video.requestFullscreen();
    await document.exitFullscreen();
    // Never scaled: the prototypes are untouched.
    expect(Element.prototype.getBoundingClientRect).toBe(gbcr);
    layer.configure({ ...config, mode: "custom-rect", customRect: rect400x200 });
    await html.requestFullscreen();
    const replaced = Element.prototype.getBoundingClientRect;
    expect(replaced).not.toBe(gbcr);
    expect(replaced.name).toBe(gbcr.name);
    expect(replaced.length).toBe(gbcr.length);
    expect(Function.prototype.toString.call(replaced)).toBe(sourceOf(gbcr));
    expect("prototype" in replaced).toBe(false);
    await document.exitFullscreen();
    layer.uninstall();
    expect(Element.prototype.getBoundingClientRect).toBe(gbcr);
  });
});
