/**
 * Styling for fake fullscreen (docs/ARCHITECTURE.md §3).
 *
 * pinElement() pins the element to a rectangle with inline !important
 * declarations, inserts the backdrop div, marks the element and its
 * shadow-including ancestors, adopts a constructed stylesheet with
 * UA-equivalent rules and mirrored page :fullscreen / ::backdrop rules, and
 * neutralises ancestors that would trap `position: fixed`. restore() puts
 * every `style` attribute back as it was (keeping the page's own writes to
 * the element's other properties, see mergedStyle).
 *
 * When the element is the document root (YouTube's watch page requests
 * fullscreen on <html>), the backdrop is necessarily a descendant of the
 * element, so it cannot sit below it in z-order. It paints only four strips
 * around the pinned rectangle instead, and nothing in fill-tab
 * (backdropDeclarations, backdropStrips), so it never paints over, takes the
 * clicks of, or is composited above the root's own content, the video
 * included (§3 "Document-root requests").
 */

import { rootLayout, rootSpace, type CoordinateSpace, type PinRect, type Size } from "../shared/geometry";
import { HTML_NS, type DomNatives } from "./natives";
import {
  ANCESTOR_ATTRIBUTE,
  BACKDROP_ATTRIBUTE,
  FULLSCREEN_ATTRIBUTE,
  mayContainFullscreen,
  mirrorSelector,
  rewriteNegatedFullscreen,
  rewritePseudoClasses,
  splitSelectorList,
} from "./selectors";

export const MAX_Z_INDEX = "2147483647";
export const BACKDROP_Z_INDEX = "2147483646";
/** A page that keeps rewriting the pinned element's style attribute is given up on after this many re-applies. */
export const MAX_STYLE_REAPPLY = 100;
/** Descendant elements visited when looking for open shadow roots below the fullscreen element. */
const SHADOW_SCAN_LIMIT = 5000;
const MAX_RULE_DEPTH = 16;

export interface PinOptions {
  rect: PinRect;
  backgroundColor: string;
}

export interface Pin {
  /** New rectangle or colour (resize, settings change, go-real). */
  update(options: PinOptions): void;
  /** Re-applies markers, ancestor overrides and stylesheets when the element moved. Returns true if it moved. */
  refresh(): boolean;
  /** The page inserted the rule at `index` of `sheet` (insertRule) while pinned: mirror or rewrite it if needed. */
  ruleInserted(sheet: CSSStyleSheet, index: number): void;
  /** The element's root, the roots of its shadow hosts, up to the document. */
  roots(): Node[];
  /** A scaled element's coordinate space (geometry.ts rootSpace, scalesToRect), or null. */
  space(): CoordinateSpace | null;
  /** Removes everything this pin added and restores every `style` attribute. */
  restore(): void;
}

export type Declarations = Array<[property: string, value: string]>;

/**
 * Rules equivalent to Chromium's fullscreen UA stylesheet, keyed to the markers.
 * Wrapped in :where() so they have zero specificity, like UA rules: page rules win.
 */
export const UA_RULES = [
  `:where([${FULLSCREEN_ATTRIBUTE}]) { object-fit: contain; }`,
  `:where(iframe[${FULLSCREEN_ATTRIBUTE}]) { border: none !important; padding: 0 !important; }`,
  `:where([${FULLSCREEN_ATTRIBUTE}]) :where(video) { width: 100%; height: 100%; }`,
  `:where(:root[${ANCESTOR_ATTRIBUTE}], :root[${FULLSCREEN_ATTRIBUTE}]) { overflow: hidden !important; }`,
].join("\n");

interface StyleRecord {
  element: Element;
  style: string | null;
}

function recordStyle(n: DomNatives, element: Element): StyleRecord {
  return { element, style: n.getAttribute(element, "style") };
}

function restoreStyle(n: DomNatives, record: StyleRecord): void {
  if (record.style === null) n.removeAttribute(record.element, "style");
  else n.setAttribute(record.element, "style", record.style);
}

/**
 * The `style` attribute to restore on an element the page wrote to while it was pinned: the original value
 * with the page's own changes to properties other than ours carried over (a page keeps setting custom
 * properties on <html>, say). Changes to the properties we pinned are dropped, as UA !important rules hide
 * them in real fullscreen.
 */
export function mergedStyle(n: DomNatives, original: string | null, current: Element, ours: Declarations): string | null {
  const scratch = (value: string | null): CSSStyleDeclaration | null => {
    const element = n.createElement("div");
    if (value !== null) n.setAttribute(element, "style", value);
    return n.inlineStyle(element);
  };
  const resultElement = n.createElement("div");
  if (original !== null) n.setAttribute(resultElement, "style", original);
  const result = n.inlineStyle(resultElement);
  const before = scratch(original);
  const pinned = scratch(null);
  const now = n.inlineStyle(current);
  if (!result || !before || !pinned || !now) return original;
  for (const [property, value] of ours) n.setImportant(pinned, property, value);
  const skip = new Set(n.propertyNames(pinned));
  for (const property of n.propertyNames(now)) {
    if (skip.has(property)) continue;
    const value = n.computedValue(now, property);
    const priority = n.propertyPriority(now, property);
    if (value !== n.computedValue(before, property) || priority !== n.propertyPriority(before, property)) {
      n.setProperty(result, property, value, priority);
    }
  }
  const kept = new Set(n.propertyNames(now));
  for (const property of n.propertyNames(before)) {
    if (!skip.has(property) && !kept.has(property)) n.removeProperty(result, property);
  }
  return n.getAttribute(resultElement, "style");
}

function applyDeclarations(n: DomNatives, element: Element, declarations: Declarations): void {
  const style = n.inlineStyle(element);
  if (!style) return;
  for (const [property, value] of declarations) n.setImportant(style, property, value);
}

/** Replaced elements draw their own content into whatever box they get: pinned at the rect's size, never scaled. */
const REPLACED = ["video", "iframe", "frame", "canvas", "img", "embed", "object"];

/**
 * Whether a pinned element is laid out at least viewport-sized and scaled onto the rectangle (rootLayout) rather
 * than sized to it. In real fullscreen the element is the viewport, so a container's content may size itself with
 * vw/vh or innerWidth/innerHeight and position itself with `position: fixed`, all of which refer to the viewport:
 * the document root (YouTube's watch page) and container players such as Twitch's (a fixed, viewport-sized
 * player inside `div#root`). Shrinking such a container to a custom rectangle lets that content overflow it. The
 * transform also makes the container the containing block of its fixed descendants, as the viewport is in real
 * fullscreen. A <video> or an <iframe> (whose own viewport becomes the rectangle) just takes the rectangle's size.
 */
export function scalesToRect(n: DomNatives, element: Element): boolean {
  if (element === n.documentElement()) return true;
  return n.namespaceURI(element) === HTML_NS && !REPLACED.includes(n.localName(element));
}

/** Inline !important declarations that pin `element` to `rect`. */
export function elementDeclarations(n: DomNatives, element: Element, options: PinOptions): Declarations {
  const { rect } = options;
  const html = n.namespaceURI(element) === HTML_NS;
  const isVideo = html && n.localName(element) === "video";
  const isFrame = html && n.localName(element) === "iframe";
  // A container is laid out at least viewport-sized and scaled onto the rect (rootLayout, scalesToRect).
  const scaled = scalesToRect(n, element);
  const layout = scaled ? rootLayout(rect, n.viewport()) : { width: rect.width, height: rect.height, scale: 1 };
  const declarations: Declarations = [
    ["position", "fixed"],
    ["left", `${rect.left}px`],
    ["top", `${rect.top}px`],
    ["width", `${layout.width}px`],
    ["height", `${layout.height}px`],
    ["right", "auto"],
    ["bottom", "auto"],
    ["min-width", "0"],
    ["min-height", "0"],
    ["max-width", "none"],
    ["max-height", "none"],
    ["margin", "0"],
    ["box-sizing", "border-box"],
    ["transform", layout.scale === 1 ? "none" : `scale(${layout.scale})`],
    ["z-index", MAX_Z_INDEX],
  ];
  if (scaled) declarations.push(["transform-origin", "0 0"]);
  if (isVideo) declarations.push(["padding", "0"], ["object-fit", "contain"]);
  if (isVideo || isFrame) declarations.push(["background", options.backgroundColor]);
  return declarations;
}

const px = (value: number): string => `${value}px`;

/**
 * Where a document-root pin's backdrop goes, in the root's local coordinates: a scaled root (rootLayout) is the
 * containing block of its fixed descendants, the backdrop included, so the backdrop covers the viewport from
 * -rect/scale and the hole is the rect divided by the scale.
 */
function rootBackdropBox(rect: PinRect, viewport: Size): { box: Size & { left: number; top: number }; hole: [number, number, number, number] } {
  const { scale } = rootLayout(rect, viewport);
  const offset = scale === 1 ? { left: 0, top: 0 } : rect;
  return {
    box: { left: -offset.left / scale, top: -offset.top / scale, width: viewport.width / scale, height: viewport.height / scale },
    hole: [rect.left / scale, rect.top / scale, (rect.left + rect.width) / scale, (rect.top + rect.height) / scale],
  };
}

/** Whether a document-root pin's rectangle covers the whole viewport (fill-tab, pop-out, go-real). */
export function holeCoversViewport(rect: PinRect, viewport: Size): boolean {
  return rect.left <= 0 && rect.top <= 0 && rect.left + rect.width >= viewport.width && rect.top + rect.height >= viewport.height;
}

/**
 * The backdrop's inline declarations. Below <html> the backdrop covers the viewport under the element. For a
 * document-root pin (`rootViewport` given) it lives inside the element, above everything the root paints, so
 * it must not overlap the pinned rectangle at all (§3 "Document-root requests"): there it is a box that
 * paints nothing and takes no clicks, holding four strips around the rectangle (backdropStrips), and it is
 * not rendered when the rectangle covers the viewport, as in fill-tab. A backdrop with a clip-path hole would
 * look the same, but Chromium composites it, and its clip mask, as layers over the whole video.
 */
export function backdropDeclarations(options: PinOptions, rootViewport?: Size): Declarations {
  const { rect } = options;
  let geometry: Declarations = [
    ["top", "0"],
    ["right", "0"],
    ["bottom", "0"],
    ["left", "0"],
    ["width", "auto"],
    ["height", "auto"],
  ];
  let display = "block";
  let paint: Declarations = [["background", options.backgroundColor]];
  if (rootViewport) {
    const { box } = rootBackdropBox(rect, rootViewport);
    geometry = [
      ["top", px(box.top)],
      ["left", px(box.left)],
      ["right", "auto"],
      ["bottom", "auto"],
      ["width", px(box.width)],
      ["height", px(box.height)],
    ];
    if (holeCoversViewport(rect, rootViewport)) display = "none";
    paint = [
      ["background", "transparent"],
      ["pointer-events", "none"],
    ];
  }
  return [
    ["position", "fixed"],
    ...geometry,
    ["clip-path", "none"],
    ["display", display],
    ["margin", "0"],
    ["padding", "0"],
    ["border", "0"],
    ["opacity", "1"],
    ["transform", "none"],
    ["z-index", BACKDROP_Z_INDEX],
    ...paint,
  ];
}

/**
 * The inline declarations of a document-root backdrop's four strips (top, bottom, left, right of the pinned
 * rectangle), in the backdrop's coordinates. They tile the viewport around the rectangle without overlapping
 * it; strips of a rectangle that touches the viewport's edge are empty.
 */
export function backdropStrips(options: PinOptions, rootViewport: Size): Declarations[] {
  const { box, hole } = rootBackdropBox(options.rect, rootViewport);
  const [left, top, right, bottom] = hole;
  const { width, height } = box;
  const boxes: Array<[x: number, y: number, w: number, h: number]> = [
    [0, 0, width, top],
    [0, bottom, width, height - bottom],
    [0, top, left, bottom - top],
    [right, top, width - right, bottom - top],
  ];
  return boxes.map(([x, y, w, h]) => [
    ["position", "absolute"],
    ["left", px(x)],
    ["top", px(y)],
    ["width", px(Math.max(0, w))],
    ["height", px(Math.max(0, h))],
    ["right", "auto"],
    ["bottom", "auto"],
    ["display", "block"],
    ["margin", "0"],
    ["padding", "0"],
    ["border", "0"],
    ["box-sizing", "border-box"],
    ["opacity", "1"],
    ["transform", "none"],
    ["pointer-events", "auto"],
    // Each strip is a layer of its own: Chromium would otherwise merge the four into one layer spanning the hole.
    ["will-change", "transform"],
    ["background", options.backgroundColor],
  ]);
}

/** Overrides for an ancestor whose computed style would trap, clip or bury a fixed-position descendant. */
export function ancestorOverrides(n: DomNatives, element: Element): Declarations {
  const computed = n.computedStyle(element);
  if (!computed) return [];
  const value = (property: string): string => n.computedValue(computed, property);
  const isSet = (v: string): boolean => v !== "" && v !== "none";
  const out: Declarations = [];
  for (const property of ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter", "clip-path"]) {
    if (isSet(value(property))) out.push([property, "none"]);
  }
  if (isSet(value("mask-image")) || isSet(value("-webkit-mask-image"))) out.push(["mask", "none"], ["-webkit-mask", "none"]);
  if (/\b(paint|layout|strict|content)\b/.test(value("contain"))) out.push(["contain", "none"]);
  const containerType = value("container-type");
  if (containerType !== "" && containerType !== "normal") out.push(["container-type", "normal"]);
  if (/transform|perspective|filter|contain|translate|rotate|scale/.test(value("will-change"))) out.push(["will-change", "auto"]);
  const visibility = value("content-visibility");
  if (visibility !== "" && visibility !== "visible") out.push(["content-visibility", "visible"]);
  if (value("transform-style") === "preserve-3d") out.push(["transform-style", "flat"]);
  const zIndex = value("z-index");
  if (zIndex !== "" && zIndex !== "auto") out.push(["z-index", MAX_Z_INDEX]);
  const opacity = Number.parseFloat(value("opacity"));
  if (!Number.isNaN(opacity) && opacity < 1) out.push(["opacity", "1"]);
  const blend = value("mix-blend-mode");
  if (blend !== "" && blend !== "normal") out.push(["mix-blend-mode", "normal"]);
  if (value("isolation") === "isolate") out.push(["isolation", "auto"]);
  return out;
}

/**
 * Animated properties (as getKeyframes() names them) that make an element a containing block for fixed
 * descendants, or clip them or put them in a stacking context. Chromium keeps an element with a running or
 * filling animation of a transform or filter property a containing block even when an !important declaration
 * wins the cascade (a finished `fill: both` entrance animation on a hero wrapper, videojs.org).
 */
const TRAPPING_ANIMATIONS = new Set([
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "filter",
  "backdropFilter",
  "offsetPath",
  "offsetDistance",
  "offsetRotate",
  "offsetAnchor",
  "offsetPosition",
  "cssOffset",
  "clipPath",
  "mask",
  "maskImage",
  "webkitMask",
  "webkitMaskImage",
  "opacity",
  "zIndex",
]);

export interface AnimationRecord {
  effect: KeyframeEffect;
  target: Element;
}

/**
 * Takes the element's running and filling animations of the properties above off it, by setting their
 * effect's target to null: the animation keeps its timing, play state and events (a running one keeps
 * running, off screen) and stops affecting the element. restoreAnimations() sets the target back, so the
 * element shows the animation where its timeline is then: a finished one its end state, with no replay.
 * `animation: none` would restart CSS animations when removed, and pause() leaves the element a containing block.
 */
export function neutraliseAnimations(n: DomNatives, element: Element): AnimationRecord[] {
  const records: AnimationRecord[] = [];
  for (const animation of n.animations(element)) {
    const effect = n.keyframeEffect(animation);
    if (!effect || n.effectTarget(effect) !== element) continue;
    if (!n.keyframeProperties(effect).some((property) => TRAPPING_ANIMATIONS.has(property))) continue;
    try {
      n.setEffectTarget(effect, null);
    } catch {
      continue;
    }
    if (n.effectTarget(effect) === null) records.push({ effect, target: element });
  }
  return records;
}

/** Puts back what neutraliseAnimations() took off, unless the page retargeted the effect meanwhile. */
export function restoreAnimations(n: DomNatives, records: AnimationRecord[]): void {
  for (const { effect, target } of records.reverse()) {
    try {
      if (n.effectTarget(effect) === null) n.setEffectTarget(effect, target);
    } catch {
      // the effect is gone
    }
  }
}

/** The parent of `node`, crossing from a shadow root to its host. */
function parentOrHost(n: DomNatives, node: Node): Node | null {
  const parent = n.parentNode(node);
  if (!parent) return null;
  return n.shadowHost(parent) ?? parent;
}

/** Shadow-including ancestors of `element`, nearest first, up to and including <html>. */
export function ancestorsOf(n: DomNatives, element: Element): Element[] {
  const ancestors: Element[] = [];
  for (let node = parentOrHost(n, element); node && n.isElement(node); node = parentOrHost(n, node)) ancestors.push(node);
  return ancestors;
}

/** The element's root, then the root of each enclosing shadow host, ending with the document (if connected). */
export function rootsOf(n: DomNatives, element: Element): Node[] {
  const roots: Node[] = [];
  let node: Node = element;
  for (;;) {
    const root = n.rootNode(node);
    roots.push(root);
    const host = n.shadowHost(root);
    if (!host) return roots;
    node = host;
  }
}

/** Open shadow roots of `element` and of its descendants (recursively), bounded. */
function shadowRootsBelow(n: DomNatives, element: Element): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  let budget = SHADOW_SCAN_LIMIT;
  const visit = (elements: Element[]): void => {
    for (const candidate of elements) {
      if (--budget < 0) return;
      const root = n.openShadowRoot(candidate);
      if (root && !found.includes(root)) {
        found.push(root);
        visit(n.querySelectorAll(root, "*"));
      }
    }
  };
  visit([element, ...n.querySelectorAll(element, "*")]);
  return found;
}

// ---------------------------------------------------------------------------
// Mirroring page rules
// ---------------------------------------------------------------------------

export interface SelectorRewrite {
  rule: CSSRule;
  /** The rule's selector text with negated fullscreen pseudo-classes rewritten (rewriteNegatedFullscreen). */
  text: string;
}

interface MirrorOutput {
  rules: string[];
  /** Rules for the backdrop div, which lives in the document whatever root they came from. */
  backdrop: string[];
  /** Page rules to rewrite in place, as `X:not(:fullscreen) Y` (mirroring cannot stop them from matching). */
  rewrites: SelectorRewrite[];
}

type AnyRule = CSSRule & {
  selectorText?: string;
  style?: CSSStyleDeclaration;
  cssRules?: CSSRuleList;
  styleSheet?: CSSStyleSheet | null;
  media?: MediaList;
  layerName?: string | null;
};

const STYLE_RULE = 1;
const IMPORT_RULE = 3;

/** The text between a style rule's outer braces (declarations and nested rules). */
function ruleBody(cssText: string, selectorText: string): string {
  const open = cssText.indexOf("{", Math.min(selectorText.length, cssText.length));
  const close = cssText.lastIndexOf("}");
  return open >= 0 && close > open ? cssText.slice(open + 1, close) : "";
}

function wrap(prelude: string, rules: string[]): string {
  return `${prelude} {\n${rules.join("\n")}\n}`;
}

function mirrorRule(rule: AnyRule, subjectMatches: (subject: string) => boolean, depth: number, out: MirrorOutput): void {
  if (rule.type === STYLE_RULE) {
    const selectorText = rule.selectorText ?? "";
    const own: string[] = [];
    const backdrop: string[] = [];
    if (mayContainFullscreen(selectorText)) {
      for (const selector of splitSelectorList(selectorText)) {
        const mirrored = mirrorSelector(selector, subjectMatches);
        if (mirrored) (mirrored.backdrop ? backdrop : own).push(mirrored.selector);
      }
      const negated = rewriteNegatedFullscreen(selectorText);
      if (negated !== null) out.rewrites.push({ rule, text: negated });
    }
    if (own.length > 0) out.rules.push(`${own.join(", ")} {${rewritePseudoClasses(ruleBody(rule.cssText, selectorText)).text}}`);
    if (backdrop.length > 0) out.backdrop.push(`${backdrop.join(", ")} { ${rule.style?.cssText ?? ""} }`);
    if (rule.cssRules && rule.cssRules.length > 0) {
      // CSS nesting: mirror nested fullscreen rules under the unchanged parent selector (a mirrored parent
      // already carries them in its body); negated ones are rewritten in place either way.
      const nested = mirrorRuleList(rule.cssRules, subjectMatches, depth + 1);
      if (own.length === 0 && nested.rules.length > 0) out.rules.push(wrap(selectorText, nested.rules));
      out.rewrites.push(...nested.rewrites);
    }
    return;
  }
  if (rule.type === IMPORT_RULE) {
    const imported = rule.styleSheet;
    if (!imported) return;
    const inner = mirrorRuleList(imported.cssRules, subjectMatches, depth + 1);
    const media = rule.media?.mediaText ?? "";
    let rules = inner.rules;
    let backdrop = inner.backdrop;
    if (media !== "") {
      rules = rules.length > 0 ? [wrap(`@media ${media}`, rules)] : rules;
      backdrop = backdrop.length > 0 ? [wrap(`@media ${media}`, backdrop)] : backdrop;
    }
    if (typeof rule.layerName === "string") {
      const prelude = rule.layerName === "" ? "@layer" : `@layer ${rule.layerName}`;
      rules = rules.length > 0 ? [wrap(prelude, rules)] : rules;
      backdrop = backdrop.length > 0 ? [wrap(prelude, backdrop)] : backdrop;
    }
    out.rules.push(...rules);
    out.backdrop.push(...backdrop);
    out.rewrites.push(...inner.rewrites);
    return;
  }
  if (rule.cssRules) {
    // Conditional and grouping rules (@media, @supports, @layer, @container, @scope): keep the prelude.
    const cssText = rule.cssText;
    const prelude = cssText.slice(0, cssText.indexOf("{")).trim();
    if (!prelude.startsWith("@") || /^@(-[a-z]+-)?(keyframes|page|font-feature-values)\b/i.test(prelude)) return;
    const inner = mirrorRuleList(rule.cssRules, subjectMatches, depth + 1);
    if (inner.rules.length > 0) out.rules.push(wrap(prelude, inner.rules));
    if (inner.backdrop.length > 0) out.backdrop.push(wrap(prelude, inner.backdrop));
    out.rewrites.push(...inner.rewrites);
  }
}

/**
 * Mirrors the :fullscreen / ::backdrop rules of a rule list (recursing into
 * grouping rules and @import), and lists the rules with a negated fullscreen
 * pseudo-class to rewrite in place. Unreadable rules and sheets are skipped.
 */
export function mirrorRuleList(
  rules: ArrayLike<CSSRule> | null | undefined,
  subjectMatches: (subject: string) => boolean,
  depth = 0,
): MirrorOutput {
  const out: MirrorOutput = { rules: [], backdrop: [], rewrites: [] };
  if (!rules || depth > MAX_RULE_DEPTH) return out;
  for (const rule of Array.from(rules)) {
    try {
      mirrorRule(rule as AnyRule, subjectMatches, depth, out);
    } catch {
      // cross-origin @import or a rule the browser cannot serialise
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

const ownSheets = new WeakSet<CSSStyleSheet>();

export function pinElement(n: DomNatives, element: Element, initial: PinOptions): Pin {
  const doc = n.document;
  let options = initial;
  const elementRecord = recordStyle(n, element);
  const root = element === n.documentElement();
  // A fixed <html> has no scrollable overflow, so the document scrolls to 0 while it is pinned.
  const scroll = root ? n.scrollPosition() : null;
  let expectedStyle: string | null = null;
  /** Whether the page wrote the element's style attribute while it was pinned. */
  let pageWrote = false;
  let applied: Declarations = [];
  let space: CoordinateSpace | null = null;
  let pinned: Array<[property: string, value: string, priority: string]> = [];
  let reapplied = 0;
  let ancestors: Element[] = [];
  let ancestorRecords: StyleRecord[] = [];
  let animationRecords: AnimationRecord[] = [];
  /** Our sheet per root, with the mirrored rules it holds (the document's also holds the backdrop rules). */
  let adopted: Array<{ root: Document | ShadowRoot; sheet: CSSStyleSheet; rules: string[] }> = [];
  let backdropRules: string[] = [];
  /** Page rules rewritten in place, with their original and rewritten selector text. */
  let rewritten: Array<{ rule: CSSRule; original: string; applied: string }> = [];
  /** Roots listened to for animations and transitions that start on an ancestor while pinned. */
  let listened: Node[] = [];

  const readPinned = (style: CSSStyleDeclaration, property: string): [string, string, string] => [
    property,
    n.computedValue(style, property),
    n.propertyPriority(style, property),
  ];

  const applyElement = (): void => {
    const declarations = elementDeclarations(n, element, options);
    applied = declarations;
    space = scalesToRect(n, element) ? rootSpace(options.rect, n.viewport()) : null;
    applyDeclarations(n, element, declarations);
    const style = n.inlineStyle(element);
    pinned = style ? declarations.map(([property]) => readPinned(style, property)) : [];
    expectedStyle = n.getAttribute(element, "style");
  };

  /** Whether every pinned declaration is still in the inline style, with its value and priority. */
  const intact = (): boolean => {
    const style = n.inlineStyle(element);
    return (
      style !== null &&
      pinned.every(([property, value, priority]) => {
        const [, now, nowPriority] = readPinned(style, property);
        return now === value && nowPriority === priority;
      })
    );
  };

  // Players that rewrite the element's inline style (e.g. on resize) would knock it out of place. Writes that
  // leave our declarations alone (custom properties a page keeps setting on <html>, say) are not a fight.
  const guard = n.mutationObserver(() => {
    const now = n.getAttribute(element, "style");
    if (now === expectedStyle) return;
    pageWrote = true;
    if (intact()) {
      expectedStyle = now;
      return;
    }
    if (reapplied >= MAX_STYLE_REAPPLY) return;
    reapplied++;
    applyElement();
  });

  const backdrop = n.createElement("div");
  n.setAttribute(backdrop, BACKDROP_ATTRIBUTE, "");
  n.setAttribute(backdrop, "aria-hidden", "true");

  const subjectMatches = (subject: string): boolean => {
    try {
      return n.matches(element, subject);
    } catch {
      return false;
    }
  };

  /**
   * Rewrites page rules in place (`X:not(:fullscreen) Y`, rewriteNegatedFullscreen), keeping the original
   * selector text for restoreRewrites(). Text the browser does not take leaves the rule as it was.
   */
  const applyRewrites = (rewrites: SelectorRewrite[]): void => {
    for (const { rule, text } of rewrites) {
      if (rewritten.some((record) => record.rule === rule)) continue; // a sheet adopted by two roots
      try {
        const original = n.selectorText(rule);
        n.setSelectorText(rule, text);
        const applied = n.selectorText(rule);
        if (applied !== original) rewritten.push({ rule, original, applied });
      } catch {
        // not a style rule after all
      }
    }
  };

  /** Puts every rewritten selector back, unless the page changed it meanwhile. */
  const restoreRewrites = (): void => {
    for (const { rule, original, applied } of rewritten.reverse()) {
      try {
        if (n.selectorText(rule) === applied) n.setSelectorText(rule, original);
      } catch {
        // the rule is gone
      }
    }
    rewritten = [];
  };

  const sheetText = (entry: (typeof adopted)[number]): string =>
    [UA_RULES, ...entry.rules, ...(entry.root === doc ? backdropRules : [])].join("\n");

  const adoptSheets = (): void => {
    const pathRoots = rootsOf(n, element).filter((root): root is Document | ShadowRoot => root === doc || n.shadowHost(root) !== null);
    const roots = [...pathRoots, ...shadowRootsBelow(n, element).filter((root) => !pathRoots.includes(root))];
    const perRoot: Array<[Document | ShadowRoot, string[]]> = [];
    backdropRules = [];
    for (const root of roots) {
      const rules: string[] = [];
      for (const sheet of [...n.styleSheets(root), ...(n.adoptedSheets(root) ?? [])]) {
        if (ownSheets.has(sheet)) continue;
        const list = n.cssRules(sheet); // null for cross-origin sheets
        if (list === null) continue;
        const mirrored = mirrorRuleList(list, subjectMatches);
        rules.push(...mirrored.rules);
        backdropRules.push(...mirrored.backdrop);
        applyRewrites(mirrored.rewrites);
      }
      perRoot.push([root, rules]);
    }
    for (const [root, rules] of perRoot) {
      const current = n.adoptedSheets(root);
      const sheet = n.constructedSheet();
      if (current === null || sheet === null) continue;
      const entry = { root, sheet, rules };
      try {
        n.replaceSync(sheet, sheetText(entry));
        n.setAdoptedSheets(root, [...current, sheet]);
      } catch {
        continue;
      }
      ownSheets.add(sheet);
      adopted.push(entry);
    }
  };

  const removeSheets = (): void => {
    for (const { root, sheet } of adopted) {
      try {
        const current = n.adoptedSheets(root);
        if (current) n.setAdoptedSheets(root, current.filter((candidate) => candidate !== sheet));
        n.replaceSync(sheet, "");
      } catch {
        // the root is gone
      }
    }
    adopted = [];
    backdropRules = [];
    restoreRewrites();
  };

  /** Applies the overrides an ancestor needs now that it does not have yet (an inline write only for those). */
  const overrideAncestor = (ancestor: Element): void => {
    const style = n.inlineStyle(ancestor);
    const missing = ancestorOverrides(n, ancestor).filter(
      ([property, value]) => !style || n.computedValue(style, property) !== value || n.propertyPriority(style, property) !== "important",
    );
    if (missing.length === 0) return;
    if (!ancestorRecords.some((record) => record.element === ancestor)) ancestorRecords.push(recordStyle(n, ancestor));
    applyDeclarations(n, ancestor, missing);
  };

  /** An animation or transition started on an ancestor while pinned: take it off too, and override what it left. */
  const onAnimationStart = (event: Event): void => {
    const target = n.eventOrigin(event);
    if (!n.isElement(target) || target === n.documentElement() || !ancestors.includes(target)) return;
    animationRecords.push(...neutraliseAnimations(n, target));
    overrideAncestor(target);
  };
  const ANIMATION_EVENTS = ["animationstart", "transitionrun"];

  const attach = (): void => {
    ancestors = ancestorsOf(n, element);
    n.setAttribute(element, FULLSCREEN_ATTRIBUTE, "");
    for (const ancestor of ancestors) n.setAttribute(ancestor, ANCESTOR_ATTRIBUTE, "");
    const html = n.documentElement();
    for (const ancestor of ancestors) {
      if (ancestor === html) continue;
      // First the animations: what is left once they are off decides the overrides.
      animationRecords.push(...neutraliseAnimations(n, ancestor));
      const overrides = ancestorOverrides(n, ancestor);
      if (overrides.length === 0) continue;
      ancestorRecords.push(recordStyle(n, ancestor));
      applyDeclarations(n, ancestor, overrides);
    }
    listened = rootsOf(n, element);
    for (const root of listened) for (const type of ANIMATION_EVENTS) n.addEventListener(root, type, onAnimationStart, true);
    adoptSheets();
  };

  const detach = (): void => {
    for (const root of listened) for (const type of ANIMATION_EVENTS) n.removeEventListener(root, type, onAnimationStart, true);
    listened = [];
    removeSheets();
    for (const record of ancestorRecords.reverse()) restoreStyle(n, record);
    ancestorRecords = [];
    restoreAnimations(n, animationRecords);
    animationRecords = [];
    n.removeAttribute(element, FULLSCREEN_ATTRIBUTE);
    for (const ancestor of ancestors) n.removeAttribute(ancestor, ANCESTOR_ATTRIBUTE);
    ancestors = [];
  };

  // A document-root backdrop paints through four strips around the rectangle (backdropStrips).
  const strips = root ? backdropStrips(options, n.viewport()).map(() => n.createElement("div")) : [];
  for (const strip of strips) n.appendChild(backdrop, strip);

  applyElement();
  attach();
  const applyBackdrop = (): void => {
    const viewport = root ? n.viewport() : undefined;
    applyDeclarations(n, backdrop, backdropDeclarations(options, viewport));
    if (viewport) backdropStrips(options, viewport).forEach((declarations, i) => strips[i] && applyDeclarations(n, strips[i], declarations));
  };
  applyBackdrop();
  let appliedKey = JSON.stringify([options, n.viewport()]);
  const html = n.documentElement();
  if (html) n.appendChild(html, backdrop);
  guard.observe(element, { attributes: true, attributeFilter: ["style"] });

  return {
    update(next) {
      // Spurious resize events and unchanged settings leave the pin as it is: no style writes.
      const key = JSON.stringify([next, n.viewport()]);
      if (key === appliedKey) return;
      appliedKey = key;
      options = next;
      applyElement();
      applyBackdrop();
    },
    refresh() {
      const now = ancestorsOf(n, element);
      if (now.length === ancestors.length && now.every((ancestor, i) => ancestor === ancestors[i])) return false;
      detach();
      attach();
      return true;
    },
    ruleInserted(sheet, index) {
      if (ownSheets.has(sheet) || adopted.length === 0) return;
      const rule = n.cssRules(sheet)?.[index];
      if (!rule) return;
      try {
        if (!mayContainFullscreen(rule.cssText)) return;
      } catch {
        return;
      }
      // Only sheets of the roots scanned on enter (their own <style>/<link> sheets or adopted constructed ones).
      const entry = adopted.find(({ root }) => n.styleSheets(root).includes(sheet) || n.adoptedSheets(root)?.includes(sheet));
      if (!entry) return;
      const mirrored = mirrorRuleList([rule], subjectMatches);
      applyRewrites(mirrored.rewrites);
      if (mirrored.rules.length === 0 && mirrored.backdrop.length === 0) return;
      entry.rules.push(...mirrored.rules);
      backdropRules.push(...mirrored.backdrop);
      for (const changed of adopted) {
        if (changed !== entry && !(changed.root === doc && mirrored.backdrop.length > 0)) continue;
        try {
          n.replaceSync(changed.sheet, sheetText(changed));
        } catch {
          // the root is gone
        }
      }
    },
    roots() {
      return rootsOf(n, element);
    },
    space() {
      return space;
    },
    restore() {
      space = null;
      guard.disconnect();
      detach();
      // Exact, unless the page wrote the style meanwhile (the guard may not have seen the last write yet).
      const touched = pageWrote || n.getAttribute(element, "style") !== expectedStyle;
      restoreStyle(n, touched ? { element, style: mergedStyle(n, elementRecord.style, element, applied) } : elementRecord);
      n.remove(backdrop);
      if (scroll) n.scrollTo(scroll.x, scroll.y);
    },
  };
}
