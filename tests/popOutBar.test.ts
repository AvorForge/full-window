// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAR_LABELS, CORNER_ZONE_PX, HIDE_DELAY_MS, createPopOutBar, inCornerZone, type PopOutBar } from "../src/content/popOutBar";
import type { PopOutWindowAction } from "../src/shared/messages";

/** The bar in this document, with its closed shadow root (caught as it is attached) and what it asked for. */
function makeBar(options: { windowAction?: (action: PopOutWindowAction) => Promise<boolean> } = {}) {
  let shadow: ShadowRoot | null = null;
  const attach = HTMLElement.prototype.attachShadow;
  const spy = vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (this: HTMLElement, init: ShadowRootInit) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const calls: Array<{ type: string; value: unknown }> = [];
  const resizes: Array<{ width: number; height: number; answer: () => void }> = [];
  const bar = createPopOutBar(window as unknown as Window, document, {
    popBackIn: () => void calls.push({ type: "popBackIn", value: null }),
    windowAction: async (action) => {
      calls.push({ type: "windowAction", value: action });
      return options.windowAction ? options.windowAction(action) : true;
    },
    resize: (width, height) => new Promise<void>((answer) => resizes.push({ width, height, answer })),
  });
  spy.mockRestore();
  const root = shadow as unknown as ShadowRoot;
  const host = () => document.querySelector("[data-shown]") ?? document.documentElement.lastElementChild;
  const button = (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  return { bar, root, host, button, calls, resizes };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function pointer(type: string, init: { screenX?: number; screenY?: number; button?: number; pointerId?: number } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: init.button ?? 0, screenX: init.screenX ?? 0, screenY: init.screenY ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

let bars: PopOutBar[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "outerWidth", { value: 640, configurable: true });
  Object.defineProperty(window, "outerHeight", { value: 390, configurable: true });
});

afterEach(() => {
  for (const bar of bars.splice(0)) bar.remove();
  vi.useRealTimers();
});

describe("popOutBar", () => {
  it("builds its buttons in a closed shadow root, each with its tooltip and accessible name; hidden until activity", () => {
    const { bar, root, button } = makeBar();
    bars.push(bar);
    expect(document.documentElement.lastElementChild?.shadowRoot).toBeNull();
    expect(bar.shown).toBe(false);
    for (const [action, label] of [
      ["pop-back-in", BAR_LABELS.popBackIn],
      ["full-screen", BAR_LABELS.fullScreen],
      ["minimize", BAR_LABELS.minimize],
    ] as const) {
      expect(button(action).title).toBe(label);
      expect(button(action).getAttribute("aria-label")).toBe(label);
      expect(button(action).querySelector("svg")).not.toBeNull();
    }
    expect(root.querySelector(".grip")).not.toBeNull();
    expect(BAR_LABELS).toEqual({ popBackIn: "Pop back in", fullScreen: "Full screen", exitFullScreen: "Exit full screen", minimize: "Minimize" });
  });

  it("shows on activity and hides 2 s after the last, but not while the pointer is over it", () => {
    const { bar, root, host } = makeBar();
    bars.push(bar);
    bar.activity(false);
    expect(bar.shown).toBe(true);
    expect(host()?.hasAttribute("data-shown")).toBe(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 100);
    bar.activity(false);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 100);
    expect(bar.shown).toBe(true);
    vi.advanceTimersByTime(100);
    expect(bar.shown).toBe(false);

    bar.activity(false);
    root.querySelector(".bar")!.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(HIDE_DELAY_MS * 3);
    expect(bar.shown).toBe(true);
    root.querySelector(".bar")!.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(bar.shown).toBe(false);
  });

  it("Full screen toggles to Exit full screen and back; Minimize; Pop back in", async () => {
    const { bar, button, calls } = makeBar();
    bars.push(bar);
    button("full-screen").click();
    await flush();
    expect(bar.fullScreen).toBe(true);
    expect(button("full-screen").title).toBe("Exit full screen");
    expect(button("full-screen").getAttribute("aria-label")).toBe("Exit full screen");
    button("full-screen").click();
    await flush();
    expect(bar.fullScreen).toBe(false);
    expect(button("full-screen").title).toBe("Full screen");
    button("minimize").click();
    button("pop-back-in").click();
    await flush();
    expect(calls).toEqual([
      { type: "windowAction", value: "fullscreen" },
      { type: "windowAction", value: "normal" },
      { type: "windowAction", value: "minimized" },
      { type: "popBackIn", value: null },
    ]);
  });

  it("keeps the label when the service worker refuses; Esc's leaveFullScreen goes back to floating only when full screen", async () => {
    let accept = false;
    const { bar, button, calls } = makeBar({ windowAction: async () => accept });
    bars.push(bar);
    button("full-screen").click();
    await flush();
    expect(bar.fullScreen).toBe(false);
    expect(button("full-screen").title).toBe("Full screen");
    expect(bar.leaveFullScreen()).toBe(false);
    accept = true;
    button("full-screen").click();
    await flush();
    expect(bar.leaveFullScreen()).toBe(true);
    expect(bar.fullScreen).toBe(false);
    expect(button("full-screen").title).toBe("Full screen");
    expect(calls.at(-1)).toEqual({ type: "windowAction", value: "normal" });
  });

  it("the grip resizes by screen deltas from the window's outer size, at least 320 x 200, one request in flight, coalesced to the latest", async () => {
    const { bar, root, resizes } = makeBar();
    bars.push(bar);
    const grip = root.querySelector(".grip")!;
    grip.dispatchEvent(pointer("pointerdown", { screenX: 1000, screenY: 700 }));
    expect(bar.shown).toBe(true);
    grip.dispatchEvent(pointer("pointermove", { screenX: 1010, screenY: 705 }));
    grip.dispatchEvent(pointer("pointermove", { screenX: 1050, screenY: 730 }));
    grip.dispatchEvent(pointer("pointermove", { screenX: 1100, screenY: 760 }));
    // One in flight; the two after it collapsed into the latest.
    expect(resizes.map(({ width, height }) => [width, height])).toEqual([[650, 395]]);
    resizes[0]!.answer();
    await flush();
    expect(resizes.map(({ width, height }) => [width, height])).toEqual([
      [650, 395],
      [740, 450],
    ]);
    // The floor.
    grip.dispatchEvent(pointer("pointerup", { screenX: 0, screenY: 0 }));
    resizes[1]!.answer();
    await flush();
    expect(resizes.at(-1)).toMatchObject({ width: 320, height: 200 });
    expect(resizes).toHaveLength(3);
    // The drag is over: moves no longer resize, and the bar hides as usual.
    grip.dispatchEvent(pointer("pointermove", { screenX: 1200, screenY: 900 }));
    resizes[2]!.answer();
    await flush();
    expect(resizes).toHaveLength(3);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(bar.shown).toBe(false);
  });

  it("the corner zone: within 56 px of the right edge and of the bottom edge of the viewport, edges included", () => {
    expect(CORNER_ZONE_PX).toBe(56);
    const [w, h] = [640, 360];
    // In: the corner itself, the zone's inner edges, and the edges of the viewport.
    for (const [x, y] of [
      [w - 1, h - 1],
      [w - 20, h - 20],
      [w - 56, h - 56],
      [w - 56, h],
      [w, h - 56],
      [w, h],
    ] as const) {
      expect(inCornerZone(x, y, w, h), `${x}, ${y}`).toBe(true);
    }
    // Out: 57 px from either edge, the middle, the other corners, beyond the viewport, no coordinates.
    for (const [x, y] of [
      [w - 57, h - 10],
      [w - 10, h - 57],
      [w - 57, h - 57],
      [w / 2, h / 2],
      [w - 10, 10],
      [10, h - 10],
      [w + 1, h - 10],
      [w - 10, h + 1],
      [Number.NaN, Number.NaN],
    ] as const) {
      expect(inCornerZone(x, y, w, h), `${x}, ${y}`).toBe(false);
    }
  });

  it("the grip shows with the bar only while the pointer is in the corner zone, and hides as soon as it leaves", () => {
    const { bar, host } = makeBar();
    bars.push(bar);
    const grip = () => host()?.hasAttribute("data-grip") === true;
    // Activity in the middle: the bar, no grip.
    bar.activity(false);
    expect([bar.shown, bar.gripShown, grip()]).toEqual([true, false, false]);
    // In the corner: the grip too.
    bar.activity(true);
    expect([bar.shown, bar.gripShown, grip()]).toEqual([true, true, true]);
    // Out of the corner again: at once, the bar stays with its own timer.
    vi.advanceTimersByTime(HIDE_DELAY_MS - 100);
    bar.activity(false);
    expect([bar.shown, bar.gripShown, grip()]).toEqual([true, false, false]);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 100);
    expect(bar.shown).toBe(true);
    // The pointer left the window from the corner: the grip goes, the bar keeps its timer.
    bar.activity(true);
    bar.leave();
    expect([bar.shown, bar.gripShown, grip()]).toEqual([true, false, false]);
    // The bar hides as before, the grip with it; the next activity in the corner shows both.
    bar.activity(true);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect([bar.shown, bar.gripShown, grip()]).toEqual([false, false, false]);
    bar.activity(true);
    expect([bar.shown, bar.gripShown, grip()]).toEqual([true, true, true]);
  });

  it("hidden, the grip takes no pointer events; only the shown grip (the bar's and the corner's attributes) takes them", () => {
    const { bar, root, host } = makeBar();
    bars.push(bar);
    const rules = Array.from(root.adoptedStyleSheets.flatMap((sheet) => Array.from(sheet.cssRules))).filter(
      (rule): rule is CSSStyleRule => "selectorText" in rule,
    );
    const pointerEvents = (selector: string) =>
      rules.filter((rule) => rule.selectorText.split(",").some((part) => part.trim() === selector)).map((rule) => rule.style.getPropertyValue("pointer-events"));
    expect(pointerEvents(".grip")).toContain("none");
    // pointer-events: auto for the grip in exactly one place: the shown grip.
    const auto = rules.filter((rule) => rule.style.getPropertyValue("pointer-events") === "auto" && rule.selectorText.includes(".grip"));
    expect(auto.map((rule) => rule.selectorText.trim())).toEqual([":host([data-shown][data-grip]) .grip"]);
    // Neither the bar alone nor the corner alone makes it so.
    bar.activity(false);
    expect([host()?.hasAttribute("data-shown"), host()?.hasAttribute("data-grip")]).toEqual([true, false]);
    bar.activity(true);
    expect([host()?.hasAttribute("data-shown"), host()?.hasAttribute("data-grip")]).toEqual([true, true]);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(host()?.hasAttribute("data-shown") || host()?.hasAttribute("data-grip")).toBe(false);
  });

  it("during a grip drag the grip stays shown out of the corner zone; after it, it follows the zone again", () => {
    const { bar, root, host, resizes } = makeBar();
    bars.push(bar);
    const grip = root.querySelector(".grip")!;
    bar.activity(true);
    grip.dispatchEvent(pointer("pointerdown", { screenX: 1000, screenY: 700 }));
    // The window lags behind the pointer: moves are reported out of the zone, the grip stays.
    bar.activity(false);
    grip.dispatchEvent(pointer("pointermove", { screenX: 1100, screenY: 760 }));
    expect([bar.gripShown, host()?.hasAttribute("data-grip")]).toEqual([true, true]);
    expect(resizes).toHaveLength(1);
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);
    expect(bar.gripShown).toBe(true);
    // The drag ends out of the zone (at the 320 x 200 floor, say): the grip goes at once.
    grip.dispatchEvent(pointer("pointerup", { screenX: 0, screenY: 0 }));
    expect([bar.shown, bar.gripShown, host()?.hasAttribute("data-grip")]).toEqual([true, false, false]);
    // Ended in the zone: it stays.
    bar.activity(true);
    grip.dispatchEvent(pointer("pointerdown", { screenX: 10, screenY: 10, pointerId: 2 }));
    grip.dispatchEvent(pointer("pointerup", { screenX: 20, screenY: 20, pointerId: 2 }));
    expect(bar.gripShown).toBe(true);
  });

  it("stays while the grip is dragged, and remove() takes everything away", () => {
    const { bar, root } = makeBar();
    bars.push(bar);
    const grip = root.querySelector(".grip")!;
    grip.dispatchEvent(pointer("pointerdown", { screenX: 10, screenY: 10 }));
    vi.advanceTimersByTime(HIDE_DELAY_MS * 2);
    expect(bar.shown).toBe(true);
    bar.remove();
    bars = [];
    expect(document.querySelector("[popover]")).toBeNull();
    expect(document.documentElement.querySelectorAll("div").length).toBe(0);
  });
});
