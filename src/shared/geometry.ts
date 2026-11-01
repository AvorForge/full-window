import type { Anchor, FullscreenSettings, Length } from "./settings";

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in CSS px relative to the frame's viewport (what position: fixed uses). */
export interface PinRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function resolveLength(length: Length, available: number): number {
  const px = length.unit === "%" ? (available * length.value) / 100 : length.value;
  return Math.max(1, Math.min(Math.round(px), available));
}

function offset(free: number, position: "start" | "middle" | "end"): number {
  if (position === "start") return 0;
  if (position === "end") return free;
  return Math.round(free / 2);
}

function anchorAxes(anchor: Anchor): { x: "start" | "middle" | "end"; y: "start" | "middle" | "end" } {
  const x = anchor.endsWith("left") ? "start" : anchor.endsWith("right") ? "end" : "middle";
  const y = anchor.startsWith("top") ? "start" : anchor.startsWith("bottom") ? "end" : "middle";
  return { x, y };
}

/**
 * The rectangle the fullscreen element is pinned to in the top frame.
 * fill-tab and pop-out fill the viewport; custom-rect is clamped to it.
 */
export function computePinRect(settings: Pick<FullscreenSettings, "mode" | "customRect">, viewport: Size): PinRect {
  if (settings.mode !== "custom-rect") {
    return { left: 0, top: 0, width: viewport.width, height: viewport.height };
  }
  const width = resolveLength(settings.customRect.width, viewport.width);
  const height = resolveLength(settings.customRect.height, viewport.height);
  const axes = anchorAxes(settings.customRect.anchor);
  return {
    left: offset(viewport.width - width, axes.x),
    top: offset(viewport.height - height, axes.y),
    width,
    height,
  };
}

/** How a document-root fullscreen element is laid out: a layout box scaled uniformly onto the pinned rect. */
export interface RootLayout {
  width: number;
  height: number;
  scale: number;
}

/**
 * Layout for a pinned document root (docs/ARCHITECTURE.md §3 "Document-root requests"). The root's content
 * keeps sizing itself with vh/vw, innerWidth/innerHeight and fixed positioning, which all refer to the real
 * viewport, so the root cannot simply be shrunk to a smaller rectangle: the page would overflow it. Instead
 * it is laid out at the rectangle's aspect ratio, at least as large as the viewport in both dimensions (and
 * exactly as large in one), and scaled down uniformly so it covers the rectangle exactly. A rect that fills
 * the viewport (fill-tab, pop-out, child frames) gives the viewport itself and scale 1.
 */
export function rootLayout(rect: PinRect, viewport: Size): RootLayout {
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  if (!Number.isFinite(scale) || scale <= 0 || scale >= 1) return { width: rect.width, height: rect.height, scale: 1 };
  return { width: rect.width / scale, height: rect.height / scale, scale };
}

/**
 * The page's coordinate space while <html> or a container is scaled onto a custom rectangle (rootLayout): the
 * element's own unscaled box, whose origin is the rectangle's top-left corner. Layout values (offsetWidth,
 * clientWidth, innerWidth, vh) are in this space; pointer positions and getBoundingClientRect() are on screen.
 * Players that mix the two (a seek bar mapping `clientX - rect.left` onto its offsetWidth) land off by the scale,
 * so while it is scaled the page is given both in the element's space (docs/ARCHITECTURE.md §3).
 */
export interface CoordinateSpace {
  left: number;
  top: number;
  scale: number;
}

/** The root's coordinate space for a pin, or null when it is not scaled (fill-tab, pop-out, frames). */
export function rootSpace(rect: PinRect, viewport: Size): CoordinateSpace | null {
  const { scale } = rootLayout(rect, viewport);
  return scale === 1 ? null : { left: rect.left, top: rect.top, scale };
}

/** A screen (viewport) position in the root's space. */
export function toRootX(space: CoordinateSpace, x: number): number {
  return (x - space.left) / space.scale;
}

export function toRootY(space: CoordinateSpace, y: number): number {
  return (y - space.top) / space.scale;
}

/** A position in the root's space on screen (the inverse of toRootX / toRootY). */
export function fromRootX(space: CoordinateSpace, x: number): number {
  return space.left + x * space.scale;
}

export function fromRootY(space: CoordinateSpace, y: number): number {
  return space.top + y * space.scale;
}
