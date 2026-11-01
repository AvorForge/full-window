import type { Anchor, SiteOverride, SizeMode } from "../shared/settings";

export const MODE_LABELS: Record<SizeMode, string> = {
  "fill-tab": "Fill tab",
  "custom-rect": "Custom size",
  "pop-out": "Pop out",
};

export const ANCHOR_LABELS: Record<Anchor, string> = {
  center: "Center",
  "top-left": "Top left",
  top: "Top",
  "top-right": "Top right",
  left: "Left",
  right: "Right",
  "bottom-left": "Bottom left",
  bottom: "Bottom",
  "bottom-right": "Bottom right",
};

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

/** Short human summary of an override, e.g. "Off" or "Custom size, 80% × 60%". */
export function describeOverride(override: SiteOverride): string {
  const parts: string[] = [];
  if (override.enabled === false) parts.push("Off");
  if (override.enabled === true) parts.push("On");
  if (override.mode) parts.push(MODE_LABELS[override.mode]);
  const rect = override.customRect;
  const fmt = (l: { value: number; unit: string }): string => `${l.value}${l.unit}`;
  if (rect?.width && rect.height) parts.push(`${fmt(rect.width)} × ${fmt(rect.height)}`);
  else if (rect?.width) parts.push(`width ${fmt(rect.width)}`);
  else if (rect?.height) parts.push(`height ${fmt(rect.height)}`);
  if (rect?.anchor) parts.push(`anchored ${ANCHOR_LABELS[rect.anchor].toLowerCase()}`);
  const win = override.windowSize;
  if (win?.width !== undefined && win.height !== undefined) parts.push(`window ${win.width} × ${win.height} px`);
  else if (win?.width !== undefined) parts.push(`window width ${win.width} px`);
  else if (win?.height !== undefined) parts.push(`window height ${win.height} px`);
  if (override.backgroundColor) parts.push(`background ${override.backgroundColor}`);
  if (override.exitOnEscape !== undefined) parts.push(override.exitOnEscape ? "Esc exits" : "Esc ignored");
  return parts.join(", ") || "No changes";
}

export function flashStatus(element: HTMLElement, text: string): void {
  element.textContent = text;
  window.setTimeout(() => {
    if (element.textContent === text) element.textContent = "";
  }, 1600);
}

/** The placeholder tab's title (ui/poppedOut.html): "Popped out: <page title>", or the page's URL when it has none. */
export function placeholderTitle(search: string): string {
  const query = new URLSearchParams(search);
  const name = query.get("title")?.trim() || query.get("url") || "";
  return `Popped out: ${name}`;
}
