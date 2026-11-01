import { describe, expect, it } from "vitest";
import {
  FRAME_PROTOCOL,
  FRAME_PROTOCOL_VERSION,
  frameMessage,
  isToContent,
  isToServiceWorker,
  parseFrameMessage,
  toShimConfig,
} from "../src/shared/messages";
import { createDefaultDocument, resolveForSite } from "../src/shared/settings";

const id = "req_0123456789";

describe("frame protocol validation", () => {
  it("accepts well-formed messages", () => {
    for (const body of [
      { type: "frame-enter", requestId: id },
      { type: "frame-exit", requestId: id, reason: "escape" },
      { type: "frame-exit-request", requestId: id, reason: "api" },
      { type: "frame-ack", requestId: id, accepted: false },
    ] as const) {
      const message = frameMessage(body);
      expect(message.protocol).toBe(FRAME_PROTOCOL);
      expect(message.version).toBe(FRAME_PROTOCOL_VERSION);
      expect(parseFrameMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it("rejects foreign, malformed or extended messages", () => {
    const valid = frameMessage({ type: "frame-enter", requestId: id });
    for (const bad of [
      null,
      "frame-enter",
      [valid],
      { ...valid, protocol: "other" },
      { ...valid, version: 2 },
      { ...valid, requestId: "short" },
      { ...valid, requestId: "<script>alert(1)</script>" },
      { ...valid, type: "frame-pwn" },
      { ...valid, extra: true },
      frameMessage({ type: "frame-exit", requestId: id, reason: "escape" }) && {
        ...frameMessage({ type: "frame-exit", requestId: id, reason: "escape" }),
        reason: "because",
      },
      { ...frameMessage({ type: "frame-ack", requestId: id, accepted: true }), accepted: "yes" },
    ]) {
      expect(parseFrameMessage(bad)).toBeNull();
    }
  });
});

describe("runtime message guards", () => {
  it("recognise service worker and content messages", () => {
    expect(isToServiceWorker({ type: "pop-out-enter", width: 800, height: 600 })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-enter", width: "800", height: 600 })).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-exit" })).toBe(true);
    expect(isToServiceWorker({ type: "get-site" })).toBe(false);
    expect(isToContent({ type: "get-site" })).toBe(true);
    expect(isToContent({ type: "pop-out-exit" })).toBe(false);
    expect(isToContent(undefined)).toBe(false);
  });

  it("validate the toggle and tab-state messages", () => {
    for (const type of ["browser-fullscreen-enter", "browser-fullscreen-exit", "tab-state"]) expect(isToServiceWorker({ type }), type).toBe(true);
    expect(isToServiceWorker({ type: "set-prefer-real", preferReal: true })).toBe(true);
    expect(isToServiceWorker({ type: "set-prefer-real", preferReal: "yes" })).toBe(false);
    expect(isToServiceWorker({ type: "set-prefer-real" })).toBe(false);
    expect(isToContent({ type: "prefer-real-changed", preferReal: false })).toBe(true);
    expect(isToContent({ type: "prefer-real-changed" })).toBe(false);
    expect(isToContent({ type: "browser-fullscreen-released" })).toBe(true);
    expect(isToContent({ type: "set-prefer-real", preferReal: true })).toBe(false);
    expect(isToServiceWorker({ type: "prefer-real-changed", preferReal: true })).toBe(false);
  });

  it("validate the pop-out messages: page title and URL, window actions, resize, return, activity", () => {
    expect(isToServiceWorker({ type: "pop-out-enter", width: 800, height: 600, title: "Demo", url: "https://video.example/" })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-enter", width: 800, height: 600, title: 3 })).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-enter", width: 800, height: 600, url: {} })).toBe(false);
    for (const action of ["fullscreen", "normal", "minimized"]) expect(isToServiceWorker({ type: "pop-out-window", action }), action).toBe(true);
    for (const action of ["maximized", "locked-fullscreen", undefined]) expect(isToServiceWorker({ type: "pop-out-window", action }), String(action)).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-resize", width: 640, height: 390 })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-resize", width: Number.NaN, height: 390 })).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-resize", width: 640 })).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-return" })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-activity" })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-activity", corner: true })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-activity", corner: false })).toBe(true);
    expect(isToServiceWorker({ type: "pop-out-activity", corner: "yes" })).toBe(false);
    expect(isToContent({ type: "pop-out-leave" })).toBe(true);
    expect(isToContent({ type: "pop-out-activity" })).toBe(true);
    expect(isToContent({ type: "pop-out-activity", corner: true })).toBe(true);
    expect(isToContent({ type: "pop-out-activity", corner: 1 })).toBe(false);
    expect(isToServiceWorker({ type: "pop-out-leave" })).toBe(false);
  });

  it("accept the refused exit reason in frame messages", () => {
    const message = frameMessage({ type: "frame-exit-request", requestId: id, reason: "refused" });
    expect(parseFrameMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it("derive the shim config from resolved settings", () => {
    const resolved = resolveForSite(createDefaultDocument(), "example.com");
    expect(toShimConfig(resolved, true)).toEqual({
      enabled: true,
      mode: "fill-tab",
      customRect: resolved.customRect,
      topFrame: true,
      backgroundColor: "#000000",
      exitOnEscape: true,
      preferReal: false,
    });
  });
});
