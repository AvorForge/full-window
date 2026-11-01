// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDSHAKE_ATTRIBUTE, openPageChannel } from "../src/content/channel";
import { createFullscreenPatchLayer } from "../src/content/fullscreenLayer";
import {
  ACTIVITY_RELAY_MS,
  allowAttributeGrantsFullscreen,
  createIsolatedController,
  findFrameElement,
  parentOrigin,
  topLevelHostname,
  type IsolatedController,
} from "../src/content/isolatedController";
import { bootstrapMainWorld } from "../src/content/mainWorldBootstrap";
import type { PopOutBar, PopOutBarActions } from "../src/content/popOutBar";
import { frameMessage, type ExitReason, type FrameMessage, type PageMessage, type ToServiceWorker } from "../src/shared/messages";
import { createDefaultDocument, type SettingsDocument, type SiteOverride, type SizeMode } from "../src/shared/settings";
import { installFullscreenStubs, settle, trustedKey } from "./helpers/fullscreenStubs";

const HOST = "example.com";

/** The MAIN world of one frame, answering like the real layer does (synchronous entered/exited reports). */
class FakeMain {
  readonly posted: Array<{ message: PageMessage; target: EventTarget | undefined }> = [];
  private readonly listeners = new Set<(message: PageMessage, target: EventTarget | null) => void>();
  active: string | null = null;
  mode: SizeMode = "fill-tab";

  post(message: PageMessage, target?: EventTarget): void {
    this.posted.push({ message, target });
    if (message.type === "config") this.mode = message.config.mode;
    if (message.type === "enter-frame-element") this.localEnter(message.requestId);
    if (message.type === "exit" && this.active !== null) this.localExit(message.reason);
  }

  onMessage(listener: (message: PageMessage, target: EventTarget | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The page of this frame entered (fake) fullscreen. */
  localEnter(requestId: string): void {
    this.active = requestId;
    for (const listener of this.listeners) listener({ type: "entered", requestId, mode: this.mode }, null);
  }

  /** Fake fullscreen ended in this frame (exitFullscreen(), removal, an exit message...). */
  localExit(reason: ExitReason): void {
    this.active = null;
    for (const listener of this.listeners) listener({ type: "exited", reason }, null);
  }

  messages(type: PageMessage["type"]): PageMessage[] {
    return this.posted.filter((entry) => entry.message.type === type).map((entry) => entry.message);
  }
}

/** The service worker as seen from one frame. */
class FakeRuntime {
  readonly sent: ToServiceWorker[] = [];
  replies: Partial<Record<ToServiceWorker["type"], unknown>> = {
    "tab-state": { ok: true, preferReal: false },
    "pop-out-enter": { ok: true, bounds: { left: 0, top: 0, width: 1, height: 1, state: "normal" } },
  };
  readonly send = async (message: ToServiceWorker): Promise<unknown> => {
    this.sent.push(message);
    const reply = this.replies[message.type] ?? { ok: true };
    return typeof reply === "function" ? (reply as () => unknown)() : reply;
  };
  /** The window and toggle traffic: without the start-up tab-state and the toolbar's site-state reports. */
  types(): string[] {
    return this.sent.map((message) => message.type).filter((type) => type !== "tab-state" && type !== "site-state");
  }
  siteStates(): boolean[] {
    return this.sent.flatMap((message) => (message.type === "site-state" ? [message.enabled] : []));
  }
}

/** The hover bar (popOutBar.ts), as the controller drives it. */
class FakeBar {
  actions: PopOutBarActions | null = null;
  created = 0;
  removed = 0;
  activities = 0;
  /** The corner zone as each activity reported it, and the window leaves. */
  corners: boolean[] = [];
  leaves = 0;
  fullScreen = false;
  readonly create = (actions: PopOutBarActions): PopOutBar => {
    this.actions = actions;
    this.created++;
    const bar = this;
    return {
      activity: (corner: boolean) => {
        bar.activities++;
        bar.corners.push(corner);
      },
      leave: () => void bar.leaves++,
      get gripShown() {
        return bar.corners.at(-1) === true;
      },
      get fullScreen() {
        return bar.fullScreen;
      },
      get shown() {
        return bar.activities > 0;
      },
      leaveFullScreen: () => {
        if (!bar.fullScreen) return false;
        bar.fullScreen = false;
        void bar.actions?.windowAction("normal");
        return true;
      },
      remove: () => void bar.removed++,
    };
  };
}

class FakeWindow extends EventTarget {
  parent: FakeWindow = this;
  /** The popup window's viewport (an <iframe> of a pop-out chain fills it). */
  innerWidth = 1000;
  innerHeight = 600;
  constructor(
    readonly name: string,
    readonly origin: string,
  ) {
    super();
  }
}

interface Delivery {
  from: string;
  to: string;
  message: FrameMessage;
  targetOrigin: string;
}

interface Frame {
  name: string;
  win: FakeWindow;
  doc: Document;
  main: FakeMain;
  runtime: FakeRuntime;
  controller: IsolatedController;
  /** This frame's <iframe> element in its parent's document. */
  iframe: HTMLIFrameElement | null;
}

const frames: Frame[] = [];
let deliveries: Delivery[] = [];

afterEach(() => {
  for (const frame of frames.splice(0)) frame.controller.dispose();
  deliveries = [];
});

function settings(override: SiteOverride = {}, global: Partial<SettingsDocument["global"]> = {}): SettingsDocument {
  const doc = createDefaultDocument();
  return { ...doc, global: { ...doc.global, ...global }, sites: Object.keys(override).length > 0 ? { [HOST]: override } : {} };
}

function makeFrame(
  name: string,
  parent: Frame | null,
  options: {
    allow?: "allowfullscreen" | "none" | string;
    settings?: SettingsDocument;
    runtime?: FakeRuntime;
    prerendering?: boolean;
    bar?: FakeBar;
  } = {},
): Frame {
  const win = new FakeWindow(name, `https://${name}.test`);
  const doc = document.implementation.createHTMLDocument(name);
  if (options.prerendering) Object.defineProperty(doc, "prerendering", { value: true, configurable: true });
  let iframe: HTMLIFrameElement | null = null;
  if (parent) {
    win.parent = parent.win;
    iframe = parent.doc.createElement("iframe");
    const allow = options.allow ?? "allowfullscreen";
    if (allow === "allowfullscreen") iframe.setAttribute("allowfullscreen", "");
    else if (allow !== "none") iframe.setAttribute("allow", allow);
    Object.defineProperty(iframe, "contentWindow", { value: win });
    parent.doc.body.append(iframe);
  }
  const main = new FakeMain();
  const runtime = options.runtime ?? new FakeRuntime();
  const controller = createIsolatedController({
    window: win as unknown as Window,
    document: doc,
    channel: main,
    isTopFrame: parent === null,
    hostname: HOST,
    parentOrigin: parent ? parent.win.origin : "*",
    sendToServiceWorker: runtime.send,
    ...(options.bar ? { createPopOutBar: options.bar.create } : {}),
    // Like window.postMessage: asynchronous, structured-cloned, with the sender as source.
    postToWindow: (target, message, targetOrigin) => {
      const to = target as unknown as FakeWindow;
      deliveries.push({ from: name, to: to.name, message, targetOrigin });
      const data = structuredClone(message);
      queueMicrotask(() => to.dispatchEvent(new MessageEvent("message", { data, source: win as unknown as Window, origin: win.origin })));
    },
  });
  controller.applySettings(options.settings ?? settings());
  const frame: Frame = { name, win, doc, main, runtime, controller, iframe };
  frames.push(frame);
  return frame;
}

const R = "req_child_000001";

/** top <- child (<- grandchild), the deepest frame requesting fullscreen. */
async function chain(depth: 2 | 3, options: { settings?: SettingsDocument } = {}) {
  const top = makeFrame("top", null, options);
  const mid = makeFrame("mid", top, options);
  const leaf = depth === 3 ? makeFrame("leaf", mid, options) : mid;
  leaf.main.localEnter(R);
  await settle();
  deliveries = [];
  return { top, mid, leaf };
}

/** A pointer event at (x, y) in the viewport, leaving for no element (relatedTarget null). */
function pointerAt(type: string, x: number, y: number): Event {
  return new MouseEvent(type, { clientX: x, clientY: y, relatedTarget: null });
}

function post(to: FakeWindow, data: unknown, source: unknown, origin = "https://x.test"): void {
  to.dispatchEvent(new MessageEvent("message", { data, source: source as Window, origin }));
}

describe("frame relay", () => {
  it("a child in fake fullscreen announces itself; the parent acks and pins the child's <iframe>", async () => {
    const top = makeFrame("top", null);
    const child = makeFrame("child", top);
    child.main.localEnter(R);
    expect(child.controller.state.sentUp).toBe(R);
    await settle();
    expect(deliveries).toEqual([
      { from: "child", to: "top", message: frameMessage({ type: "frame-enter", requestId: R }), targetOrigin: "https://top.test" },
      { from: "top", to: "child", message: frameMessage({ type: "frame-ack", requestId: R, accepted: true }), targetOrigin: "https://child.test" },
    ]);
    expect(top.main.posted.filter((entry) => entry.message.type === "enter-frame-element")).toEqual([
      { message: { type: "enter-frame-element", requestId: R }, target: child.iframe },
    ]);
    expect(top.controller.state).toMatchObject({ fakeActive: true, childRequestId: R, sentUp: null });
    expect(child.controller.state).toMatchObject({ fakeActive: true, sentUp: R });
  });

  it("ignores malformed messages and messages that do not come from a direct child frame (or the parent)", async () => {
    const top = makeFrame("top", null);
    const child = makeFrame("child", top);
    const grandchild = makeFrame("grand", child);
    const pageSaw: unknown[] = [];
    top.win.addEventListener("message", (event) => pageSaw.push((event as MessageEvent).data));

    const enter = frameMessage({ type: "frame-enter", requestId: R });
    post(top.win, enter, new FakeWindow("stranger", "https://stranger.test")); // unrelated window
    post(top.win, enter, grandchild.win); // not a direct child
    post(top.win, { ...enter, extra: 1 }, child.win); // extended shape
    post(top.win, { ...enter, requestId: "x" }, child.win); // bad id
    await settle();
    expect(top.main.messages("enter-frame-element")).toEqual([]);
    expect(deliveries).toEqual([]);
    expect(pageSaw).toHaveLength(4); // not ours: the page sees them

    child.main.localEnter(R);
    await settle();
    expect(top.controller.state.fakeActive).toBe(true);
    expect(pageSaw).toHaveLength(4); // our handled protocol message did not reach the page listener
    // Exit requests and acks are only accepted from the parent, for the request that was sent up.
    post(child.win, frameMessage({ type: "frame-exit-request", requestId: R, reason: "api" }), grandchild.win);
    post(child.win, frameMessage({ type: "frame-ack", requestId: R, accepted: false }), new FakeWindow("other", "https://o.test"));
    post(child.win, frameMessage({ type: "frame-exit-request", requestId: "req_other_00001", reason: "api" }), top.win);
    // frame-exit is only accepted from the child whose <iframe> is pinned.
    post(top.win, frameMessage({ type: "frame-exit", requestId: R, reason: "api" }), grandchild.win);
    await settle();
    expect(child.main.messages("exit")).toEqual([]);
    expect(top.main.messages("exit")).toEqual([]);
    expect(child.controller.state.fakeActive).toBe(true);
  });

  for (const [label, allow, siteSettings] of [
    ["the <iframe> has no allowfullscreen", "none", settings()],
    ['allow="fullscreen \'none\'"', "fullscreen 'none'", settings()],
    ["the site is disabled", "allowfullscreen", settings({ enabled: false })],
  ] as const) {
    it(`refuses when ${label}: ack false, and the child exits with reason refused`, async () => {
      const top = makeFrame("top", null, { settings: siteSettings });
      const child = makeFrame("child", top, { allow });
      child.main.localEnter(R);
      await settle();
      expect(deliveries.at(-1)).toEqual({
        from: "top",
        to: "child",
        message: frameMessage({ type: "frame-ack", requestId: R, accepted: false }),
        targetOrigin: "https://child.test",
      });
      expect(top.main.messages("enter-frame-element")).toEqual([]);
      expect(child.main.messages("exit")).toEqual([{ type: "exit", reason: "refused" }]);
      expect(child.controller.state).toMatchObject({ fakeActive: false, sentUp: null });
      expect(deliveries.filter((d) => d.message.type === "frame-exit")).toEqual([]); // the parent never pinned it
    });
  }

  it('accepts allow="fullscreen"', async () => {
    const top = makeFrame("top", null);
    const child = makeFrame("child", top, { allow: "autoplay; fullscreen" });
    child.main.localEnter(R);
    await settle();
    expect(top.main.messages("enter-frame-element")).toHaveLength(1);
  });

  it("an exit in the child travels up; the parent exits once and does not send it back down", async () => {
    const { top, leaf } = await chain(2);
    leaf.main.localExit("escape");
    await settle();
    expect(deliveries).toEqual([
      { from: "mid", to: "top", message: frameMessage({ type: "frame-exit", requestId: R, reason: "escape" }), targetOrigin: "https://top.test" },
    ]);
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "frame" }]);
    expect(top.controller.state).toMatchObject({ fakeActive: false, childRequestId: null });
  });

  it("an exit at the top travels down through every frame of a three-level chain, once each", async () => {
    const { top, mid, leaf } = await chain(3);
    expect(top.main.messages("enter-frame-element")).toEqual([{ type: "enter-frame-element", requestId: R }]);
    expect(mid.main.messages("enter-frame-element")).toEqual([{ type: "enter-frame-element", requestId: R }]);
    top.main.localExit("api");
    await settle();
    await settle();
    expect(deliveries.map((d) => [d.from, d.to, d.message.type])).toEqual([
      ["top", "mid", "frame-exit-request"],
      ["mid", "leaf", "frame-exit-request"],
    ]);
    expect(mid.main.messages("exit")).toEqual([{ type: "exit", reason: "frame" }]);
    expect(leaf.main.messages("exit")).toEqual([{ type: "exit", reason: "frame" }]);
    for (const frame of [top, mid, leaf]) expect(frame.controller.state.fakeActive, frame.name).toBe(false);
  });

  it("an exit in the middle frame goes both ways", async () => {
    const { top, mid, leaf } = await chain(3);
    mid.main.localExit("api");
    await settle();
    expect(deliveries.map((d) => [d.from, d.to, d.message.type])).toEqual([
      ["mid", "leaf", "frame-exit-request"],
      ["mid", "top", "frame-exit"],
    ]);
    expect(leaf.main.messages("exit")).toHaveLength(1);
    expect(top.main.messages("exit")).toHaveLength(1);
  });

  it("a local element replacing the child's <iframe> ends the child's chain", async () => {
    const { top, mid } = await chain(2);
    top.main.localEnter("req_top_local_01");
    await settle();
    expect(deliveries.map((d) => [d.from, d.to, d.message.type])).toEqual([["top", "mid", "frame-exit-request"]]);
    expect(mid.main.messages("exit")).toEqual([{ type: "exit", reason: "frame" }]);
    expect(top.controller.state).toMatchObject({ fakeActive: true, childRequestId: null });
  });

  it("finds frames inside open shadow roots, and only <iframe>/<frame> elements", () => {
    const doc = document.implementation.createHTMLDocument("");
    const host = doc.createElement("div");
    doc.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const iframe = doc.createElement("iframe");
    const decoy = doc.createElement("div");
    const source = new FakeWindow("w", "https://w.test");
    Object.defineProperty(iframe, "contentWindow", { value: source });
    Object.defineProperty(decoy, "contentWindow", { value: source });
    shadow.append(decoy, iframe);
    expect(findFrameElement(doc, source)).toBe(iframe);
    expect(findFrameElement(doc, new FakeWindow("x", "https://x.test"))).toBeNull();
    expect(findFrameElement(doc, null)).toBeNull();
  });
});

describe("Esc", () => {
  it("exits the whole chain from any frame of it, and the page never sees that Esc", async () => {
    const { top, leaf } = await chain(2);
    const pageSaw: string[] = [];
    leaf.win.addEventListener("keydown", (event) => pageSaw.push((event as KeyboardEvent).key));
    leaf.win.addEventListener("keyup", (event) => pageSaw.push(`up:${(event as KeyboardEvent).key}`));
    const down = trustedKey("keydown", "Escape");
    leaf.win.dispatchEvent(down);
    leaf.win.dispatchEvent(trustedKey("keyup", "Escape"));
    expect(down.defaultPrevented).toBe(true);
    expect(pageSaw).toEqual([]);
    expect(leaf.main.messages("exit")).toEqual([{ type: "exit", reason: "escape" }]);
    await settle();
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "frame" }]);

    // Again with focus in the top frame.
    leaf.main.localEnter(R);
    await settle();
    top.win.dispatchEvent(trustedKey("keydown", "Escape"));
    expect(top.main.messages("exit").at(-1)).toEqual({ type: "exit", reason: "escape" });
    await settle();
    expect(leaf.main.messages("exit").at(-1)).toEqual({ type: "exit", reason: "frame" });
  });

  it("lets Esc through when idle, when exitOnEscape is off, and for synthetic events", async () => {
    const top = makeFrame("top", null);
    const pageSaw: string[] = [];
    top.win.addEventListener("keydown", (event) => pageSaw.push((event as KeyboardEvent).key));
    top.win.dispatchEvent(trustedKey("keydown", "Escape")); // idle
    top.main.localEnter(R);
    top.win.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); // untrusted
    top.win.dispatchEvent(trustedKey("keydown", "Enter"));
    top.controller.applySettings(settings({ exitOnEscape: false }));
    top.win.dispatchEvent(trustedKey("keydown", "Escape"));
    expect(pageSaw).toEqual(["Escape", "Escape", "Enter", "Escape"]);
    expect(top.main.messages("exit")).toEqual([]);
  });

  it("leaves fake fullscreen when the page is hidden for navigation", () => {
    const top = makeFrame("top", null);
    top.main.localEnter(R);
    top.win.dispatchEvent(new Event("pagehide"));
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "navigation" }]);
  });
});

describe("pop-out wiring (top ISOLATED <-> service worker)", () => {
  const resizeSettings = () => settings({}, { mode: "pop-out", windowSize: { width: 1600, height: 900 } });

  it("asks the service worker to pop the tab out when the MAIN layer reports entered in pop-out mode, and to put it back on exit", async () => {
    const top = makeFrame("top", null, { settings: resizeSettings() });
    top.doc.title = "Demo player";
    top.main.localEnter(R);
    await settle();
    // With the page's title and URL, for the placeholder tab.
    expect(top.runtime.sent).toContainEqual({ type: "pop-out-enter", width: 1600, height: 900, title: "Demo player", url: top.doc.location.href });
    expect(top.controller.state.popOut).toBe("active");
    top.main.localExit("api");
    await settle();
    expect(top.runtime.types()).toEqual(["pop-out-enter", "pop-out-exit"]);
    expect(top.controller.state.popOut).toBe("idle");
  });

  it("resizes once for a chain that ends at the top; child frames and other modes never resize", async () => {
    const { top, leaf } = await chain(2, { settings: resizeSettings() });
    expect(top.runtime.types()).toEqual(["pop-out-enter"]);
    expect(leaf.runtime.types()).toEqual([]);

    const fill = makeFrame("fill", null);
    fill.main.localEnter(R);
    await settle();
    expect(fill.runtime.types()).toEqual([]);
  });

  it("after pop-out-released, fake fullscreen stays and the exit does not restore again", async () => {
    const top = makeFrame("top", null, { settings: resizeSettings() });
    top.main.localEnter(R);
    await settle();
    expect(top.controller.handleRuntimeMessage({ type: "pop-out-released" })).toEqual({ ok: true });
    expect(top.controller.state).toMatchObject({ fakeActive: true, popOut: "idle" });
    top.main.localExit("api");
    await settle();
    expect(top.runtime.types()).toEqual(["pop-out-enter"]);
  });

  it("shows the hover bar while popped out (top frame only), and takes it down when the pop-out ends", async () => {
    const bar = new FakeBar();
    const top = makeFrame("top", null, { settings: resizeSettings(), bar });
    top.win.dispatchEvent(new Event("pointermove"));
    expect(bar.created).toBe(0);
    top.main.localEnter(R);
    await settle();
    expect(bar.created).toBe(1);
    // Pointer activity here, or relayed from a child frame by the service worker.
    top.win.dispatchEvent(new Event("pointermove"));
    top.win.dispatchEvent(new Event("pointerdown"));
    expect(top.controller.handleRuntimeMessage({ type: "pop-out-activity" })).toEqual({ ok: true });
    expect(bar.activities).toBe(3);
    top.main.localExit("escape");
    await settle();
    expect(bar.removed).toBe(1);
    expect(top.controller.handleRuntimeMessage({ type: "pop-out-activity" })).toEqual({ ok: true });
    expect(bar.activities).toBe(3);

    // Released by the service worker (navigation...): the bar goes too.
    top.main.localEnter(R);
    await settle();
    expect(bar.created).toBe(2);
    top.controller.handleRuntimeMessage({ type: "pop-out-released" });
    expect(bar.removed).toBe(2);
  });

  it("the bar's buttons: Pop back in exits as Esc does; Full screen, Minimize and the grip ask for the sender's own popup", async () => {
    const bar = new FakeBar();
    const top = makeFrame("top", null, { settings: resizeSettings(), bar });
    top.runtime.replies["pop-out-window"] = { ok: true, state: "fullscreen" };
    top.main.localEnter(R);
    await settle();
    expect(await bar.actions!.windowAction("fullscreen")).toBe(true);
    expect(await bar.actions!.windowAction("minimized")).toBe(true);
    await bar.actions!.resize(800, 450);
    expect(top.runtime.sent.slice(-3)).toEqual([
      { type: "pop-out-window", action: "fullscreen" },
      { type: "pop-out-window", action: "minimized" },
      { type: "pop-out-resize", width: 800, height: 450 },
    ]);
    top.runtime.replies["pop-out-window"] = { ok: false, error: "not a popped-out tab" };
    expect(await bar.actions!.windowAction("normal")).toBe(false);
    bar.actions!.popBackIn();
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "escape" }]);
    await settle();
    expect(top.runtime.types().at(-1)).toBe("pop-out-exit");
  });

  it("Esc while the popup is full screen returns it to floating first; the next Esc pops back in", async () => {
    const bar = new FakeBar();
    const top = makeFrame("top", null, { settings: resizeSettings(), bar });
    top.main.localEnter(R);
    await settle();
    bar.fullScreen = true;
    const first = trustedKey("keydown", "Escape");
    top.win.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(top.main.messages("exit")).toEqual([]);
    await settle();
    expect(top.runtime.sent.at(-1)).toEqual({ type: "pop-out-window", action: "normal" });
    top.win.dispatchEvent(trustedKey("keyup", "Escape"));
    top.win.dispatchEvent(trustedKey("keydown", "Escape"));
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "escape" }]);
  });

  it("a child frame of a pop-out chain relays pointer activity to the service worker, at most every 400 ms", async () => {
    const { top, leaf } = await chain(2, { settings: resizeSettings() });
    const relayed = () => leaf.runtime.types().filter((type) => type === "pop-out-activity").length;
    leaf.win.dispatchEvent(new Event("pointermove"));
    leaf.win.dispatchEvent(new Event("pointermove"));
    expect(relayed()).toBe(1);
    expect(top.runtime.types()).not.toContain("pop-out-activity");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + ACTIVITY_RELAY_MS);
    leaf.win.dispatchEvent(new Event("pointerdown"));
    expect(relayed()).toBe(2);
    clock.mockRestore();

    // Not in fake fullscreen, or not in pop-out mode: nothing.
    leaf.main.localExit("api");
    await settle();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * ACTIVITY_RELAY_MS);
    leaf.win.dispatchEvent(new Event("pointermove"));
    expect(relayed()).toBe(2);
    vi.restoreAllMocks();
    const fill = await chain(2);
    fill.leaf.win.dispatchEvent(new Event("pointermove"));
    expect(fill.leaf.runtime.types()).toEqual([]);
  });

  it("the top frame tells the bar whether the pointer is in the corner zone, and when it leaves the window", async () => {
    const bar = new FakeBar();
    const top = makeFrame("top", null, { settings: resizeSettings(), bar });
    top.main.localEnter(R);
    await settle();
    top.win.dispatchEvent(pointerAt("pointermove", 500, 300));
    top.win.dispatchEvent(pointerAt("pointermove", 1000 - 20, 600 - 20));
    top.win.dispatchEvent(pointerAt("pointerdown", 1000 - 56, 600 - 56));
    top.win.dispatchEvent(pointerAt("pointermove", 1000 - 57, 600 - 20));
    expect(bar.corners).toEqual([false, true, true, false]);
    // Out of the window (past its corner): the grip goes. Into a child frame (inside the viewport) or onto
    // another element: nothing.
    top.win.dispatchEvent(pointerAt("pointerout", 500, 300));
    top.win.dispatchEvent(pointerAt("pointerout", 1000 - 5, 600 - 5));
    expect(bar.leaves).toBe(0);
    top.win.dispatchEvent(pointerAt("pointerout", 1000 + 3, 600 + 2));
    expect(bar.leaves).toBe(1);
    // Relayed from a child frame: as the child saw it (no flag, as from an older child: not in the corner).
    top.controller.handleRuntimeMessage({ type: "pop-out-activity", corner: true });
    top.controller.handleRuntimeMessage({ type: "pop-out-activity", corner: false });
    top.controller.handleRuntimeMessage({ type: "pop-out-activity" });
    expect(bar.corners.slice(-3)).toEqual([true, false, false]);
  });

  it("a child frame relays the corner zone with its activity: entry and exit at once, the rest throttled", async () => {
    const { top, leaf } = await chain(2, { settings: resizeSettings() });
    const relayed = () => leaf.runtime.sent.flatMap((message) => (message.type === "pop-out-activity" ? [message.corner] : []));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    leaf.win.dispatchEvent(pointerAt("pointermove", 500, 300));
    leaf.win.dispatchEvent(pointerAt("pointermove", 520, 310));
    expect(relayed()).toEqual([false]);
    // Into the corner zone, within the 400 ms: at once.
    clock.mockReturnValue(1_000_050);
    leaf.win.dispatchEvent(pointerAt("pointermove", 1000 - 30, 600 - 30));
    expect(relayed()).toEqual([false, true]);
    // Moving within it: throttled as before.
    clock.mockReturnValue(1_000_100);
    leaf.win.dispatchEvent(pointerAt("pointermove", 1000 - 10, 600 - 10));
    leaf.win.dispatchEvent(pointerAt("pointerdown", 1000 - 10, 600 - 10));
    expect(relayed()).toEqual([false, true]);
    clock.mockReturnValue(1_000_050 + ACTIVITY_RELAY_MS);
    leaf.win.dispatchEvent(pointerAt("pointermove", 1000 - 12, 600 - 12));
    expect(relayed()).toEqual([false, true, true]);
    // Out of it: at once too.
    clock.mockReturnValue(1_000_060 + ACTIVITY_RELAY_MS);
    leaf.win.dispatchEvent(pointerAt("pointermove", 1000 - 57, 600 - 12));
    expect(relayed()).toEqual([false, true, true, false]);
    clock.mockReturnValue(1_000_070 + ACTIVITY_RELAY_MS);
    leaf.win.dispatchEvent(pointerAt("pointermove", 400, 200));
    expect(relayed()).toEqual([false, true, true, false]);
    // The child frame never draws or asks for a grip; the top frame sends no activity of its own.
    expect(top.runtime.types()).not.toContain("pop-out-activity");
    expect(leaf.runtime.types().filter((type) => type !== "pop-out-activity")).toEqual([]);
    clock.mockRestore();
  });

  it("Bring it back (pop-out-leave) leaves fake fullscreen as Esc does, which puts the tab back", async () => {
    const top = makeFrame("top", null, { settings: resizeSettings() });
    const leaf = makeFrame("leaf", top);
    expect(top.controller.handleRuntimeMessage({ type: "pop-out-leave" })).toEqual({ handled: false });
    expect(leaf.controller.handleRuntimeMessage({ type: "pop-out-leave" })).toBeUndefined();
    top.main.localEnter(R);
    await settle();
    expect(top.controller.handleRuntimeMessage({ type: "pop-out-leave" })).toEqual({ handled: true });
    expect(top.main.messages("exit")).toEqual([{ type: "exit", reason: "escape" }]);
    await settle();
    expect(top.runtime.types()).toEqual(["pop-out-enter", "pop-out-exit"]);
    expect(top.controller.state).toMatchObject({ fakeActive: false, popOut: "idle" });
  });

  it("gives the window back when fake fullscreen ends while the resize is still pending", async () => {
    const runtime = new FakeRuntime();
    let answer: (value: unknown) => void = () => undefined;
    runtime.replies["pop-out-enter"] = () => new Promise((resolve) => (answer = resolve));
    const top = makeFrame("top", null, { settings: resizeSettings(), runtime });
    top.main.localEnter(R);
    await settle();
    expect(top.controller.state.popOut).toBe("pending");
    top.main.localExit("api");
    answer({ ok: true, bounds: {} });
    await settle();
    expect(runtime.types()).toEqual(["pop-out-enter", "pop-out-exit"]);
    expect(top.controller.state.popOut).toBe("idle");
  });
});

describe("toggle command", () => {
  it("fake active: switches to browser fullscreen and fills the tab; again: back to the fake size", async () => {
    const top = makeFrame("top", null);
    top.main.localEnter(R);
    await expect(top.controller.handleRuntimeMessage({ type: "command-toggle" })).resolves.toEqual({ handled: true });
    expect(top.runtime.types()).toEqual(["browser-fullscreen-enter"]);
    expect(top.main.messages("go-real")).toHaveLength(1);
    expect(top.controller.handleRuntimeMessage({ type: "get-site" })).toEqual({ hostname: HOST, active: true, preferReal: false, real: true });

    await expect(top.controller.handleRuntimeMessage({ type: "command-toggle" })).resolves.toEqual({ handled: true });
    expect(top.main.messages("go-fake")).toHaveLength(1);
    expect(top.runtime.types()).toEqual(["browser-fullscreen-enter", "browser-fullscreen-exit"]);
    expect(top.controller.state.real).toBe(false);
  });

  it("leaving fake fullscreen while real restores the window state, then puts the tab back from the pop-out", async () => {
    const top = makeFrame("top", null, { settings: settings({ mode: "pop-out" }) });
    top.main.localEnter(R);
    await settle();
    await top.controller.handleRuntimeMessage({ type: "command-toggle" });
    top.main.localExit("escape");
    await settle();
    expect(top.runtime.types()).toEqual(["pop-out-enter", "browser-fullscreen-enter", "browser-fullscreen-exit", "pop-out-exit"]);
  });

  it("when the service worker cannot go fullscreen, nothing changes", async () => {
    const runtime = new FakeRuntime();
    runtime.replies["browser-fullscreen-enter"] = { ok: false, error: "no window" };
    const top = makeFrame("top", null, { runtime });
    top.main.localEnter(R);
    await expect(top.controller.handleRuntimeMessage({ type: "command-toggle" })).resolves.toEqual({ handled: false });
    expect(top.main.messages("go-real")).toEqual([]);
    expect(top.controller.state.real).toBe(false);
  });

  it("idle: flips preferReal for the tab, pushes it to the MAIN world and tells the service worker", async () => {
    const top = makeFrame("top", null);
    await top.controller.handleRuntimeMessage({ type: "command-toggle" });
    const configs = () => top.main.messages("config").map((message) => (message.type === "config" ? message.config.preferReal : null));
    expect(configs().at(-1)).toBe(true);
    expect(top.runtime.sent.at(-1)).toEqual({ type: "set-prefer-real", preferReal: true });
    expect(top.controller.handleRuntimeMessage({ type: "get-site" })).toMatchObject({ active: false, preferReal: true });
    await top.controller.handleRuntimeMessage({ type: "command-toggle" });
    expect(configs().at(-1)).toBe(false);
    expect(top.runtime.sent.at(-1)).toEqual({ type: "set-prefer-real", preferReal: false });
  });

  it("prefer-real-changed (broadcast to every frame) updates each frame's config", () => {
    const top = makeFrame("top", null);
    const child = makeFrame("child", top);
    expect(child.controller.handleRuntimeMessage({ type: "prefer-real-changed", preferReal: true })).toBeUndefined();
    const last = child.main.messages("config").at(-1);
    expect(last?.type === "config" && last.config).toMatchObject({ preferReal: true, topFrame: false });
    expect(top.controller.handleRuntimeMessage({ type: "prefer-real-changed", preferReal: true })).toEqual({ ok: true });
  });

  it("reads the tab's armed mode from the service worker at start-up", async () => {
    const runtime = new FakeRuntime();
    runtime.replies["tab-state"] = { ok: true, preferReal: true };
    const child = makeFrame("child", makeFrame("top", null), { runtime });
    expect(runtime.sent[0]).toEqual({ type: "tab-state" });
    await settle();
    const last = child.main.messages("config").at(-1);
    expect(last?.type === "config" && last.config.preferReal).toBe(true);
  });

  it("browser-fullscreen-released returns the element to the fake size", async () => {
    const top = makeFrame("top", null);
    top.main.localEnter(R);
    await top.controller.handleRuntimeMessage({ type: "command-toggle" });
    expect(top.controller.handleRuntimeMessage({ type: "browser-fullscreen-released" })).toEqual({ ok: true });
    expect(top.main.messages("go-fake")).toHaveLength(1);
    expect(top.controller.state.real).toBe(false);
    top.main.localExit("api");
    await settle();
    expect(top.runtime.types()).toEqual(["browser-fullscreen-enter"]); // nothing left to restore
  });

  it("only the top frame answers get-site, command-toggle and the window messages", () => {
    const child = makeFrame("child", makeFrame("top", null));
    for (const type of ["get-site", "command-toggle", "pop-out-released", "browser-fullscreen-released"] as const) {
      expect(child.controller.handleRuntimeMessage({ type }), type).toBeUndefined();
    }
  });
});

describe("toolbar icon (top frame -> service worker site-state)", () => {
  const pageShow = (persisted: boolean): Event => Object.assign(new Event("pageshow"), { persisted });

  it("the top frame reports its site's enabled once the settings have loaded", () => {
    expect(makeFrame("top", null).runtime.sent.filter((message) => message.type === "site-state")).toEqual([{ type: "site-state", enabled: true }]);
    expect(makeFrame("off", null, { settings: settings({ enabled: false }) }).runtime.siteStates()).toEqual([false]);
    expect(makeFrame("global-off", null, { settings: settings({}, { enabled: false }) }).runtime.siteStates()).toEqual([false]);
  });

  it("reports again when a settings change flips enabled (popup switch, Reset this site), not for other changes", () => {
    const top = makeFrame("top", null);
    top.controller.applySettings(settings({ mode: "custom-rect" }));
    expect(top.runtime.siteStates()).toEqual([true]);
    top.controller.applySettings(settings({ enabled: false }));
    top.controller.applySettings(settings({ enabled: false, mode: "pop-out" }));
    expect(top.runtime.siteStates()).toEqual([true, false]);
    // Reset this site: the override is removed and the global setting applies again.
    top.controller.applySettings(settings());
    expect(top.runtime.siteStates()).toEqual([true, false, true]);
  });

  it("reports again when the page comes back from the back/forward cache, not on a normal pageshow", () => {
    const top = makeFrame("top", null, { settings: settings({ enabled: false }) });
    top.win.dispatchEvent(pageShow(false));
    expect(top.runtime.siteStates()).toEqual([false]);
    top.win.dispatchEvent(pageShow(true));
    expect(top.runtime.siteStates()).toEqual([false, false]);
  });

  it("a prerendering page waits for its activation (prerenderingchange) to report", () => {
    const top = makeFrame("top", null, { prerendering: true });
    top.controller.applySettings(settings({ enabled: false }));
    expect(top.runtime.siteStates()).toEqual([]);
    Object.defineProperty(top.doc, "prerendering", { value: false, configurable: true });
    top.doc.dispatchEvent(new Event("prerenderingchange"));
    expect(top.runtime.siteStates()).toEqual([false]);
  });

  it("subframes never report", () => {
    const top = makeFrame("top", null);
    const child = makeFrame("child", top);
    child.controller.applySettings(settings({ enabled: false }));
    child.win.dispatchEvent(pageShow(true));
    child.doc.dispatchEvent(new Event("prerenderingchange"));
    expect(child.runtime.siteStates()).toEqual([]);
    expect(top.runtime.siteStates()).toEqual([true]);
  });

  it("the top frame answers the service worker's get-site-state; subframes do not; null before the settings load", () => {
    const top = makeFrame("top", null, { settings: settings({ enabled: false }) });
    expect(top.controller.handleRuntimeMessage({ type: "get-site-state" })).toEqual({ enabled: false });
    expect(makeFrame("child", top).controller.handleRuntimeMessage({ type: "get-site-state" })).toBeUndefined();
    const runtime = new FakeRuntime();
    const early = createIsolatedController({
      window: new FakeWindow("early", "https://early.test") as unknown as Window,
      document: document.implementation.createHTMLDocument("early"),
      channel: new FakeMain(),
      isTopFrame: true,
      hostname: HOST,
      parentOrigin: "*",
      sendToServiceWorker: runtime.send,
    });
    expect(early.handleRuntimeMessage({ type: "get-site-state" })).toEqual({ enabled: null });
    early.dispose();
    expect(runtime.siteStates()).toEqual([]);
  });
});

describe("helpers", () => {
  it("resolve the top-level hostname and the parent's origin", () => {
    const ancestors = (origins: string[]) => Object.assign([...origins], { contains: (o: string) => origins.includes(o), item: (i: number) => origins[i] ?? null }) as unknown as DOMStringList;
    expect(topLevelHostname({ hostname: "www.example.com" }, true)).toBe("www.example.com");
    expect(topLevelHostname({ hostname: "embed.test", ancestorOrigins: ancestors(["https://mid.test", "https://www.example.com"]) }, false)).toBe("www.example.com");
    expect(topLevelHostname({ hostname: "embed.test" }, false)).toBe("embed.test");
    expect(parentOrigin({ ancestorOrigins: ancestors(["https://mid.test", "https://top.test"]) })).toBe("https://mid.test");
    expect(parentOrigin({ ancestorOrigins: ancestors(["null"]) })).toBe("*");
    expect(parentOrigin({})).toBe("*");
  });

  it("read the allow attribute", () => {
    expect(allowAttributeGrantsFullscreen(null)).toBeNull();
    expect(allowAttributeGrantsFullscreen("autoplay")).toBeNull();
    expect(allowAttributeGrantsFullscreen("fullscreen")).toBe(true);
    expect(allowAttributeGrantsFullscreen("autoplay; fullscreen *")).toBe(true);
    expect(allowAttributeGrantsFullscreen("fullscreen 'none'")).toBe(false);
  });
});

describe("with the real patch layer and private channel", () => {
  it("Esc exits fake fullscreen only while active, page listeners never see it, and get-site reports the state", async () => {
    const stubs = installFullscreenStubs();
    const layer = createFullscreenPatchLayer();
    const handle = bootstrapMainWorld(window as Window & typeof globalThis, layer);
    const runtime = new FakeRuntime();
    const controller = createIsolatedController({
      window,
      document,
      channel: openPageChannel("isolated", document),
      isTopFrame: true,
      hostname: HOST,
      parentOrigin: "*",
      sendToServiceWorker: runtime.send,
    });
    try {
      expect(document.documentElement.hasAttribute(HANDSHAKE_ATTRIBUTE)).toBe(false);
      controller.applySettings(settings());
      const pageSaw: string[] = [];
      document.addEventListener("keydown", (event) => pageSaw.push(event.key));
      const video = document.createElement("video");
      document.body.append(video);

      document.body.dispatchEvent(trustedKey("keydown", "Escape")); // idle: the page gets it
      await video.requestFullscreen();
      expect(controller.handleRuntimeMessage({ type: "get-site" })).toEqual({ hostname: HOST, active: true, preferReal: false, real: false });
      document.body.dispatchEvent(trustedKey("keydown", "Escape"));
      expect(document.fullscreenElement).toBeNull();
      expect(controller.state.fakeActive).toBe(false);
      expect(pageSaw).toEqual(["Escape"]);
      expect(stubs.calls).toEqual([]);
    } finally {
      controller.dispose();
      handle?.channel.close();
      layer.uninstall();
      stubs.restore();
    }
  });
});
