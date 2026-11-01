import { describe, expect, it } from "vitest";
import { mirrorSelector, rewriteNegatedFullscreen, rewritePseudoClasses, rewriteSelectorArgument, splitSelectorList } from "../src/content/selectors";

const F = "[data-cfs-fullscreen]";
const A = "[data-cfs-fullscreen-ancestor]";

describe("rewritePseudoClasses", () => {
  it("replaces every fullscreen pseudo-class, case-insensitively, by its marker", () => {
    expect(rewritePseudoClasses(".player:fullscreen video").text).toBe(`.player${F} video`);
    expect(rewritePseudoClasses("div:FullScreen, :-webkit-full-screen, :-moz-full-screen").text).toBe(`div${F}, ${F}, ${F}`);
    expect(rewritePseudoClasses(":-webkit-full-screen-ancestor:not(iframe)").text).toBe(`${A}:not(iframe)`);
    expect(rewritePseudoClasses(":not(:fullscreen)").text).toBe(`:not(${F})`);
  });

  it("leaves strings, attribute selectors, escapes, other pseudo-classes and pseudo-elements alone", () => {
    for (const selector of ['[title=":fullscreen"]', "[data-x=':fullscreen']", ".a\\:fullscreen", ":fullscreen-like", "a:hover", "::before", ":is(a, b)"]) {
      expect(rewritePseudoClasses(selector), selector).toEqual({ text: selector, changed: false, backdropAt: -1 });
    }
    expect(rewritePseudoClasses("video::backdrop").backdropAt).toBe(5);
  });

  it("rewriteSelectorArgument skips text that cannot contain a fullscreen pseudo-class", () => {
    expect(rewriteSelectorArgument("div > span")).toBe("div > span");
    expect(rewriteSelectorArgument("div:fullscreen")).toBe(`div${F}`);
  });
});

describe("splitSelectorList", () => {
  it("splits on top-level commas only", () => {
    expect(splitSelectorList('a, :is(b, c) d , [x=","], e\\,f')).toEqual(["a", ":is(b, c) d", '[x=","]', "e\\,f"]);
  });
});

describe("mirrorSelector", () => {
  it("rewrites fullscreen selectors and skips the rest", () => {
    expect(mirrorSelector(".p:fullscreen .c", () => false)).toEqual({ selector: `.p${F} .c`, backdrop: false });
    expect(mirrorSelector(".p .c", () => true)).toBeNull();
  });

  it("maps X::backdrop to the backdrop marker only when the fake element matches X", () => {
    const subjects: string[] = [];
    const matches = (subject: string): boolean => {
      subjects.push(subject);
      return subject !== "dialog";
    };
    expect(mirrorSelector(".player:fullscreen::backdrop", matches)).toEqual({ selector: "[data-cfs-backdrop]", backdrop: true });
    expect(mirrorSelector("::backdrop", matches)).toEqual({ selector: "[data-cfs-backdrop]", backdrop: true });
    expect(mirrorSelector("dialog::backdrop", matches)).toBeNull();
    expect(mirrorSelector("video::backdrop:hover", matches)).toBeNull();
    expect(subjects).toEqual([`.player${F}`, "*", "dialog"]);
  });
});

describe("rewriteNegatedFullscreen", () => {
  it("makes a negated fullscreen pseudo-class also match the marker (Loom's :not(:fullscreen) rules)", () => {
    expect(rewriteNegatedFullscreen(".css-15mfcn7:not(:fullscreen) [data-hide-ifnot-fullscreen]")).toBe(
      `.css-15mfcn7:not(:is(:fullscreen, ${F})) [data-hide-ifnot-fullscreen]`,
    );
    expect(rewriteNegatedFullscreen(".p:not(:-webkit-full-screen) .bar")).toBe(`.p:not(:is(:-webkit-full-screen, ${F})) .bar`);
    expect(rewriteNegatedFullscreen("body:not(:-webkit-full-screen-ancestor)")).toBe(`body:not(:is(:-webkit-full-screen-ancestor, ${A}))`);
    // At any depth inside the negation, and only there.
    expect(rewriteNegatedFullscreen(":not(:has(> :fullscreen)) .x, .y:fullscreen")).toBe(`:not(:has(> :is(:fullscreen, ${F}))) .x, .y:fullscreen`);
    expect(rewriteNegatedFullscreen(".a:is(:not(.b), :fullscreen) .c:not(:fullscreen)")).toBe(`.a:is(:not(.b), :fullscreen) .c:not(:is(:fullscreen, ${F}))`);
  });

  it("returns null without a negated fullscreen pseudo-class, and leaves strings and escapes alone", () => {
    for (const selector of [".p:fullscreen .bar", ":has(:fullscreen)", ":not(.a) :fullscreen", ':not([title=":fullscreen"])', ":not(.a\\:fullscreen)", "a:hover"]) {
      expect(rewriteNegatedFullscreen(selector), selector).toBeNull();
    }
  });
});
