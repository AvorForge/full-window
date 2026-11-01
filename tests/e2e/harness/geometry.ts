// Expected pin rectangles, written from the specification (docs/ARCHITECTURE.md §3, §6) rather than taken
// from src/shared/geometry.ts, so the e2e tests check the extension against the spec.
import type { Rect } from "./extension";

export interface RectCase {
  width: number;
  widthUnit: "px" | "%";
  height: number;
  heightUnit: "px" | "%";
  anchor: string;
}

function side(value: number, unit: "px" | "%", available: number): number {
  const pixels = unit === "%" ? (available * value) / 100 : value;
  return Math.min(available, Math.max(1, Math.round(pixels)));
}

export function expectedRect(viewport: { width: number; height: number }, rect: RectCase): Rect {
  const width = side(rect.width, rect.widthUnit, viewport.width);
  const height = side(rect.height, rect.heightUnit, viewport.height);
  const freeX = viewport.width - width;
  const freeY = viewport.height - height;
  const left = rect.anchor.endsWith("left") ? 0 : rect.anchor.endsWith("right") ? freeX : Math.round(freeX / 2);
  const top = rect.anchor.startsWith("top") ? 0 : rect.anchor.startsWith("bottom") ? freeY : Math.round(freeY / 2);
  return { left, top, width, height };
}

/** A point of the viewport outside `rect`, in the middle of the largest uncovered band. */
export function pointOutside(viewport: { width: number; height: number }, rect: Rect): { x: number; y: number } {
  const bands = [
    { size: rect.left, x: rect.left / 2, y: viewport.height / 2 },
    { size: viewport.width - (rect.left + rect.width), x: (rect.left + rect.width + viewport.width) / 2, y: viewport.height / 2 },
    { size: rect.top, x: viewport.width / 2, y: rect.top / 2 },
    { size: viewport.height - (rect.top + rect.height), x: viewport.width / 2, y: (rect.top + rect.height + viewport.height) / 2 },
  ].sort((a, b) => b.size - a.size);
  const best = bands[0];
  if (!best || best.size < 2) throw new Error("the rectangle covers the viewport");
  return { x: Math.floor(best.x), y: Math.floor(best.y) };
}
