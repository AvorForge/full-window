import { describe, expect, it } from "vitest";
import { computePinRect, fromRootX, fromRootY, rootLayout, rootSpace, toRootX, toRootY } from "../src/shared/geometry";
import { DEFAULT_SETTINGS, type CustomRect } from "../src/shared/settings";

const viewport = { width: 1600, height: 900 };

function rect(customRect: Partial<CustomRect>) {
  return computePinRect({ mode: "custom-rect", customRect: { ...DEFAULT_SETTINGS.customRect, ...customRect } }, viewport);
}

describe("computePinRect", () => {
  it("fills the viewport in fill-tab and pop-out modes", () => {
    for (const mode of ["fill-tab", "pop-out"] as const) {
      expect(computePinRect({ mode, customRect: DEFAULT_SETTINGS.customRect }, viewport)).toEqual({
        left: 0,
        top: 0,
        ...viewport,
      });
    }
  });

  it("centres a percentage rect by default", () => {
    expect(rect({})).toEqual({ left: 160, top: 90, width: 1280, height: 720 });
  });

  it("honours px sizes and anchors", () => {
    const size = { width: { value: 640, unit: "px" }, height: { value: 360, unit: "px" } } as const;
    expect(rect({ ...size, anchor: "top-left" })).toEqual({ left: 0, top: 0, width: 640, height: 360 });
    expect(rect({ ...size, anchor: "bottom-right" })).toEqual({ left: 960, top: 540, width: 640, height: 360 });
    expect(rect({ ...size, anchor: "top" })).toEqual({ left: 480, top: 0, width: 640, height: 360 });
    expect(rect({ ...size, anchor: "left" })).toEqual({ left: 0, top: 270, width: 640, height: 360 });
  });

  it("clamps a rect larger than the viewport", () => {
    expect(rect({ width: { value: 5000, unit: "px" }, height: { value: 100, unit: "%" } })).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
  });
});

describe("rootLayout", () => {
  it("is the rect itself, unscaled, when the rect fills the viewport", () => {
    expect(rootLayout({ left: 0, top: 0, width: 1600, height: 900 }, viewport)).toEqual({ width: 1600, height: 900, scale: 1 });
  });

  it("lays a smaller rect out at least viewport-sized, at the rect's aspect ratio, and scales it down onto it", () => {
    // Wider than the viewport's aspect ratio: as tall as the viewport, wider than it.
    expect(rootLayout({ left: 0, top: 0, width: 800, height: 300 }, viewport)).toEqual({ width: 2400, height: 900, scale: 1 / 3 });
    // Narrower: as wide as the viewport, taller than it.
    expect(rootLayout({ left: 0, top: 0, width: 400, height: 900 }, viewport)).toEqual({ width: 1600, height: 3600, scale: 0.25 });
    const { width, height, scale } = rootLayout({ left: 400, top: 225, width: 800, height: 450 }, viewport);
    expect([width * scale, height * scale, scale]).toEqual([800, 450, 0.5]);
  });

  it("does not scale for an empty viewport", () => {
    expect(rootLayout({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ width: 10, height: 10, scale: 1 });
  });
});

describe("rootSpace and the root coordinate conversions", () => {
  it("is null when the root is not scaled", () => {
    expect(rootSpace({ left: 0, top: 0, width: 1000, height: 800 }, { width: 1000, height: 800 })).toBeNull();
  });

  it("maps screen positions into the scaled root's unscaled box and back", () => {
    const space = rootSpace({ left: 300, top: 300, width: 400, height: 200 }, { width: 1000, height: 800 });
    expect(space).toEqual({ left: 300, top: 300, scale: 0.25 });
    if (!space) return;
    expect([toRootX(space, 350), toRootY(space, 325)]).toEqual([200, 100]);
    expect([fromRootX(space, 200), fromRootY(space, 100)]).toEqual([350, 325]);
    // 25 % across an on-screen bar is 25 % across the same bar in the root's layout.
    const bar = { left: 300, width: 400 };
    const layoutWidth = bar.width / space.scale;
    expect((toRootX(space, bar.left + bar.width * 0.25) - toRootX(space, bar.left)) / layoutWidth).toBeCloseTo(0.25);
  });
});
