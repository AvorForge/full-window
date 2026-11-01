// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { HANDSHAKE_ATTRIBUTE, openPageChannel, type PageChannel } from "../src/content/channel";
import { bootstrapMainWorld } from "../src/content/mainWorldBootstrap";
import { createNoopPatchLayer } from "../src/content/patchLayer";
import type { PageMessage, ShimConfig } from "../src/shared/messages";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const config: ShimConfig = {
  enabled: true,
  mode: "fill-tab",
  customRect: DEFAULT_SETTINGS.customRect,
  topFrame: true,
  backgroundColor: "#000000",
  exitOnEscape: true,
  preferReal: false,
};

const opened: PageChannel[] = [];
function open(side: "main" | "isolated"): PageChannel {
  const channel = openPageChannel(side, document);
  opened.push(channel);
  return channel;
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  document.documentElement.removeAttribute(HANDSHAKE_ATTRIBUTE);
  document.body.replaceChildren();
});

describe("private page channel", () => {
  it("handshakes through a temporary attribute that is removed before page scripts run", () => {
    const main = open("main");
    expect(document.documentElement.getAttribute(HANDSHAKE_ATTRIBUTE)).toBe(main.id);
    const isolated = open("isolated");
    expect(isolated.id).toBe(main.id);
    expect(document.documentElement.hasAttribute(HANDSHAKE_ATTRIBUTE)).toBe(false);
    expect(main.id).toMatch(/^cfs-[0-9a-f]{32}$/);
  });

  it("works whichever world runs first and queues messages until the other side connects", () => {
    const isolated = open("isolated");
    const received: PageMessage[] = [];
    isolated.post({ type: "config", config }); // nobody listening yet: queued
    const main = open("main");
    main.onMessage((m) => received.push(m));
    expect(received).toEqual([{ type: "config", config }]);
  });

  it("delivers in both directions, never to its own side, and passes the target element", () => {
    const main = open("main");
    const isolated = open("isolated");
    const toMain: Array<[PageMessage, EventTarget | null]> = [];
    const toIsolated: PageMessage[] = [];
    main.onMessage((m, t) => toMain.push([m, t]));
    isolated.onMessage((m) => toIsolated.push(m));

    // Stands in for an <iframe> (happy-dom would try to load a real one).
    const iframe = document.createElement("div");
    document.body.append(iframe);
    isolated.post({ type: "enter-frame-element", requestId: "req_0123456789" }, iframe);
    main.post({ type: "exited", reason: "escape" });

    expect(toMain).toEqual([[{ type: "enter-frame-element", requestId: "req_0123456789" }, iframe]]);
    expect(toIsolated).toEqual([{ type: "exited", reason: "escape" }]);
  });

  it("passes the node the event was dispatched on even inside an open shadow root", () => {
    const main = open("main");
    const isolated = open("isolated");
    const targets: Array<EventTarget | null> = [];
    main.onMessage((_message, target) => targets.push(target));
    const host = document.createElement("div");
    document.body.append(host);
    const frame = document.createElement("div"); // stands in for an <iframe> in a player's shadow DOM
    host.attachShadow({ mode: "open" }).append(frame);
    isolated.post({ type: "enter-frame-element", requestId: "req_0123456789" }, frame);
    expect(targets).toEqual([frame]);
  });

  it("ignores events from page scripts that do not carry a JSON envelope", () => {
    const main = open("main");
    const isolated = open("isolated");
    const received: PageMessage[] = [];
    main.onMessage((m) => received.push(m));
    document.dispatchEvent(new CustomEvent(`${isolated.id}:isolated`, { detail: { type: "exit" } }));
    document.dispatchEvent(new CustomEvent(`${isolated.id}:isolated`, { detail: "{not json" }));
    expect(received).toEqual([]);
  });
});

describe("MAIN-world bootstrap with the no-op patch layer", () => {
  it("installs the layer, routes ISOLATED messages to it and leaves the Fullscreen API untouched", () => {
    const requestFullscreen = Element.prototype.requestFullscreen;
    const fullscreenElement = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");
    const layer = createNoopPatchLayer();
    const handle = bootstrapMainWorld(window as unknown as Window & typeof globalThis, layer);
    expect(handle).not.toBeNull();
    if (handle) opened.push(handle.channel);
    expect(layer.state.installed).toBe(true);

    const isolated = open("isolated");
    // Stands in for an <iframe> (happy-dom would try to load a real one).
    const iframe = document.createElement("div");
    document.body.append(iframe);
    isolated.post({ type: "config", config });
    isolated.post({ type: "exit", reason: "command" });
    isolated.post({ type: "go-real" });
    isolated.post({ type: "go-fake" });
    isolated.post({ type: "enter-frame-element", requestId: "req_0123456789" }, iframe);

    expect(layer.state.config).toEqual(config);
    expect(layer.state.calls).toEqual([
      "install",
      "configure",
      "exit:command",
      "goReal",
      "goFake",
      "enterFrameElement:req_0123456789",
    ]);
    expect(Element.prototype.requestFullscreen).toBe(requestFullscreen);
    expect(Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement")).toEqual(fullscreenElement);

    // A second injection into the same window is a no-op.
    expect(bootstrapMainWorld(window as unknown as Window & typeof globalThis, createNoopPatchLayer())).toBeNull();
  });
});
