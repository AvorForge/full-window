import { describe, expect, it } from "vitest";
import { describeOverride, placeholderTitle } from "../src/ui/common";

describe("describeOverride", () => {
  it("summarises overrides in plain words", () => {
    expect(describeOverride({})).toBe("No changes");
    expect(describeOverride({ enabled: false })).toBe("Off");
    expect(describeOverride({ enabled: true })).toBe("On");
    expect(describeOverride({ customRect: { width: { value: 50, unit: "%" } }, backgroundColor: "#202020" })).toBe(
      "width 50%, background #202020",
    );
    expect(
      describeOverride({
        mode: "custom-rect",
        customRect: { width: { value: 640, unit: "px" }, height: { value: 60, unit: "%" }, anchor: "bottom-left" },
      }),
    ).toBe("Custom size, 640px × 60%, anchored bottom left");
    expect(describeOverride({ mode: "pop-out", windowSize: { width: 1600, height: 900 }, exitOnEscape: false })).toBe(
      "Pop out, window 1600 × 900 px, Esc ignored",
    );
  });
});

describe("placeholderTitle", () => {
  it("is the page's title after \"Popped out: \", or its URL when it has none", () => {
    expect(placeholderTitle("?title=Demo+player&url=https%3A%2F%2Fvideo.example%2F")).toBe("Popped out: Demo player");
    expect(placeholderTitle("?title=&url=https%3A%2F%2Fvideo.example%2F")).toBe("Popped out: https://video.example/");
    expect(placeholderTitle("")).toBe("Popped out: ");
  });
});
