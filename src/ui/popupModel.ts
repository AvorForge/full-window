/**
 * Pure helpers for the popup: editing a site override field by field (a value
 * equal to what the site gets anyway removes the field) and the lines that
 * describe the tab's fullscreen and the shortcut.
 */

import type { ContentReplies } from "../shared/messages";
import {
  PERCENT_LIMITS,
  PX_LIMITS,
  WINDOW_LIMITS,
  type Anchor,
  type FullscreenSettings,
  type Length,
  type LengthUnit,
  type SiteOverride,
  type SizeMode,
} from "../shared/settings";

export type TabStatus = ContentReplies["get-site"];
export type Axis = "width" | "height";

/** Drops nested objects that became empty. */
function prune(override: SiteOverride): SiteOverride {
  if (override.customRect && Object.keys(override.customRect).length === 0) delete override.customRect;
  if (override.windowSize && Object.keys(override.windowSize).length === 0) delete override.windowSize;
  return override;
}

/** A length from the form, clamped to the limits of its unit; undefined if the value is not a number. */
export function lengthFromInput(value: number, unit: LengthUnit): Length | undefined {
  if (!Number.isFinite(value)) return undefined;
  const limits = unit === "px" ? PX_LIMITS : PERCENT_LIMITS;
  const rounded = unit === "px" ? Math.round(value) : Math.round(value * 10) / 10;
  return { value: Math.min(limits.max, Math.max(limits.min, rounded)), unit };
}

/** An outer window dimension from the form, clamped to WINDOW_LIMITS; undefined if not a number. */
export function windowDimensionFromInput(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(WINDOW_LIMITS.max, Math.max(WINDOW_LIMITS.min, Math.round(value)));
}

export function withRectLength(override: SiteOverride, baseline: FullscreenSettings, axis: Axis, length: Length): SiteOverride {
  const customRect = { ...override.customRect };
  const base = baseline.customRect[axis];
  if (length.value === base.value && length.unit === base.unit) delete customRect[axis];
  else customRect[axis] = { ...length };
  return prune({ ...override, customRect });
}

export function withRectAnchor(override: SiteOverride, baseline: FullscreenSettings, anchor: Anchor): SiteOverride {
  const customRect = { ...override.customRect };
  if (anchor === baseline.customRect.anchor) delete customRect.anchor;
  else customRect.anchor = anchor;
  return prune({ ...override, customRect });
}

export function withWindowDimension(override: SiteOverride, baseline: FullscreenSettings, axis: Axis, value: number): SiteOverride {
  const windowSize = { ...override.windowSize };
  if (value === baseline.windowSize[axis]) delete windowSize[axis];
  else windowSize[axis] = value;
  return prune({ ...override, windowSize });
}

/** A mode equal to what the site gets anyway is not stored, so the site keeps following the default. */
export function withMode(override: SiteOverride, baseline: FullscreenSettings, mode: SizeMode): SiteOverride {
  const next = { ...override };
  if (mode === baseline.mode) delete next.mode;
  else next.mode = mode;
  return next;
}

/** One line under the site's name: what fullscreen in this tab does now, or will do next. */
export function describeTabState(status: Pick<TabStatus, "active" | "preferReal" | "real">, enabled: boolean): string {
  if (status.active && status.real) return "In real fullscreen now.";
  if (status.active) return "In fullscreen inside the tab now.";
  if (!enabled) return "Off: this site gets real fullscreen.";
  if (status.preferReal) return "Real fullscreen is set for this tab.";
  return "Fullscreen stays inside the tab.";
}

/** The shortcut line; `shortcut` is "" when the user removed the key. */
export function describeShortcut(status: Pick<TabStatus, "active" | "preferReal" | "real">, shortcut: string): string {
  if (shortcut === "") return "No shortcut set for real fullscreen.";
  if (status.active && status.real) return `${shortcut} returns to the custom size.`;
  if (!status.active && status.preferReal) return `${shortcut} switches back to fullscreen inside the tab.`;
  return `${shortcut} switches to real fullscreen.`;
}
