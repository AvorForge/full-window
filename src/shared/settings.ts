/**
 * Versioned settings schema, defaults, migration and per-site resolution.
 *
 * Storage layout in chrome.storage.sync (see docs/ARCHITECTURE.md §6):
 *   "settings"        -> { version: number, global: FullscreenSettings }
 *   "site:<hostname>" -> SiteOverride   (one item per site, keeps every item
 *                                        well under the 8 KiB per-item quota)
 *
 * Everything in this module is pure (no chrome.* access) so it can be unit
 * tested and shared by the service worker, the isolated content script and
 * the UI pages. Storage I/O lives in settingsStore.ts.
 */

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_KEY = "settings";
export const SITE_KEY_PREFIX = "site:";

export const SIZE_MODES = ["fill-tab", "custom-rect", "pop-out"] as const;
export type SizeMode = (typeof SIZE_MODES)[number];

export const LENGTH_UNITS = ["px", "%"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

export const ANCHORS = [
  "center",
  "top-left",
  "top",
  "top-right",
  "left",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type Anchor = (typeof ANCHORS)[number];

export interface Length {
  value: number;
  unit: LengthUnit;
}

export interface CustomRect {
  width: Length;
  height: Length;
  anchor: Anchor;
}

export interface WindowSize {
  /** The pop-out window's outer width in CSS px, as passed to chrome.windows.create. */
  width: number;
  /** Outer window height in CSS px. */
  height: number;
}

export interface FullscreenSettings {
  /** Master switch. When false the shim passes every call through to the real API. */
  enabled: boolean;
  mode: SizeMode;
  customRect: CustomRect;
  windowSize: WindowSize;
  /** Color painted behind the pinned element (emulates ::backdrop). */
  backgroundColor: string;
  /** Esc leaves fake fullscreen (the page never sees that keydown). */
  exitOnEscape: boolean;
}

/** A per-site override: any subset of the settings, nested objects partial too. */
export interface SiteOverride {
  enabled?: boolean;
  mode?: SizeMode;
  customRect?: Partial<CustomRect>;
  windowSize?: Partial<WindowSize>;
  backgroundColor?: string;
  exitOnEscape?: boolean;
}

export interface SettingsDocument {
  version: typeof SETTINGS_SCHEMA_VERSION;
  global: FullscreenSettings;
  /** Keyed by normalized hostname (see normalizeHostname). */
  sites: Record<string, SiteOverride>;
}

export interface ResolvedSettings extends FullscreenSettings {
  /** The normalized hostname settings were resolved for ("" if none). */
  hostname: string;
  /** Override keys that applied, least specific first. */
  appliedOverrides: string[];
}

export const PX_LIMITS = { min: 1, max: 100_000 } as const;
export const PERCENT_LIMITS = { min: 1, max: 100 } as const;
export const WINDOW_LIMITS = { min: 100, max: 16_384 } as const;

export const DEFAULT_SETTINGS: Readonly<FullscreenSettings> = Object.freeze({
  enabled: true,
  mode: "fill-tab",
  customRect: Object.freeze({
    width: Object.freeze({ value: 80, unit: "%" }),
    height: Object.freeze({ value: 80, unit: "%" }),
    anchor: "center",
  }),
  // The pop-out window: its page area is about 13 px narrower and 35 px shorter (frame and title bar), so this
  // gives a 16:9 video about 627 × 355.
  windowSize: Object.freeze({ width: 640, height: 390 }),
  backgroundColor: "#000000",
  exitOnEscape: true,
}) as FullscreenSettings;

export function cloneSettings(settings: FullscreenSettings): FullscreenSettings {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    customRect: {
      width: { ...settings.customRect.width },
      height: { ...settings.customRect.height },
      anchor: settings.customRect.anchor,
    },
    windowSize: { ...settings.windowSize },
    backgroundColor: settings.backgroundColor,
    exitOnEscape: settings.exitOnEscape,
  };
}

export function createDefaultDocument(): SettingsDocument {
  return { version: SETTINGS_SCHEMA_VERSION, global: cloneSettings(DEFAULT_SETTINGS), sites: {} };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pop out replaced "Resize window" (2026-10-30); a saved "window-resize" now means pop out. */
const LEGACY_WINDOW_RESIZE = "window-resize";

function oneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeLength(raw: unknown): Length | undefined {
  if (!isRecord(raw) || !oneOf(LENGTH_UNITS, raw.unit) || !isFiniteNumber(raw.value)) return undefined;
  const limits = raw.unit === "px" ? PX_LIMITS : PERCENT_LIMITS;
  if (raw.value < limits.min || raw.value > limits.max) return undefined;
  return { value: raw.value, unit: raw.unit };
}

function sanitizeWindowDimension(raw: unknown): number | undefined {
  if (!isFiniteNumber(raw)) return undefined;
  const rounded = Math.round(raw);
  return rounded >= WINDOW_LIMITS.min && rounded <= WINDOW_LIMITS.max ? rounded : undefined;
}

function sanitizeColor(raw: unknown): string | undefined {
  return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

/** Returns only the valid fields of an override; invalid fields are dropped. */
export function sanitizeOverride(raw: unknown): SiteOverride {
  const out: SiteOverride = {};
  if (!isRecord(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  const mode = raw.mode === LEGACY_WINDOW_RESIZE ? "pop-out" : raw.mode;
  if (oneOf(SIZE_MODES, mode)) out.mode = mode;
  if (isRecord(raw.customRect)) {
    const rect: Partial<CustomRect> = {};
    const width = sanitizeLength(raw.customRect.width);
    const height = sanitizeLength(raw.customRect.height);
    if (width) rect.width = width;
    if (height) rect.height = height;
    if (oneOf(ANCHORS, raw.customRect.anchor)) rect.anchor = raw.customRect.anchor;
    if (Object.keys(rect).length > 0) out.customRect = rect;
  }
  if (isRecord(raw.windowSize)) {
    const size: Partial<WindowSize> = {};
    const width = sanitizeWindowDimension(raw.windowSize.width);
    const height = sanitizeWindowDimension(raw.windowSize.height);
    if (width !== undefined) size.width = width;
    if (height !== undefined) size.height = height;
    if (Object.keys(size).length > 0) out.windowSize = size;
  }
  const color = sanitizeColor(raw.backgroundColor);
  if (color) out.backgroundColor = color;
  if (typeof raw.exitOnEscape === "boolean") out.exitOnEscape = raw.exitOnEscape;
  return out;
}

/** Applies a (sanitized) override on top of complete settings, returning a new object. */
export function applyOverride(base: FullscreenSettings, override: SiteOverride): FullscreenSettings {
  const next = cloneSettings(base);
  if (override.enabled !== undefined) next.enabled = override.enabled;
  if (override.mode !== undefined) next.mode = override.mode;
  if (override.customRect) {
    if (override.customRect.width) next.customRect.width = { ...override.customRect.width };
    if (override.customRect.height) next.customRect.height = { ...override.customRect.height };
    if (override.customRect.anchor) next.customRect.anchor = override.customRect.anchor;
  }
  if (override.windowSize) {
    if (override.windowSize.width !== undefined) next.windowSize.width = override.windowSize.width;
    if (override.windowSize.height !== undefined) next.windowSize.height = override.windowSize.height;
  }
  if (override.backgroundColor !== undefined) next.backgroundColor = override.backgroundColor;
  if (override.exitOnEscape !== undefined) next.exitOnEscape = override.exitOnEscape;
  return next;
}

/** Complete settings from untrusted input: every invalid or missing field falls back to `fallback`. */
export function sanitizeSettings(raw: unknown, fallback: FullscreenSettings = DEFAULT_SETTINGS): FullscreenSettings {
  return applyOverride(fallback, sanitizeOverride(raw));
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST_CHARS = /^[a-z0-9.\-_[\]:]+$/;

/**
 * Normalizes a hostname for use as an override key: trims, lower-cases and
 * strips a trailing dot. Accepts a bare hostname or a full URL. Returns null
 * for input that cannot be a hostname.
 */
export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.includes("/")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.+$/, "");
  if (host === "" || !HOST_CHARS.test(host) || host.startsWith(".") || host.includes("..")) return null;
  return host;
}

/**
 * Override keys to consult for a hostname, most specific first:
 * "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"].
 * IP addresses and single-label hosts (localhost) only match themselves; the
 * walk never reaches a bare top-level label such as "com".
 */
export function siteLookupChain(hostname: string): string[] {
  const host = normalizeHostname(hostname);
  if (host === null) return [];
  if (IPV4.test(host) || host.includes(":")) return [host];
  const labels = host.split(".");
  const chain: string[] = [];
  for (let i = 0; i < labels.length - 1 || i === 0; i++) {
    chain.push(labels.slice(i).join("."));
  }
  return chain;
}

/**
 * Effective settings for a page: global settings, then every matching
 * override from least to most specific (example.com before www.example.com).
 */
export function resolveForSite(doc: SettingsDocument, hostname: string): ResolvedSettings {
  const chain = siteLookupChain(hostname);
  let settings = cloneSettings(doc.global);
  const applied: string[] = [];
  for (const key of [...chain].reverse()) {
    const override = doc.sites[key];
    if (override) {
      settings = applyOverride(settings, override);
      applied.push(key);
    }
  }
  return { ...settings, hostname: chain[0] ?? "", appliedOverrides: applied };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Untyped intermediate form used while migrating. Each migration step takes
 * the shape of version N and returns the shape of version N + 1.
 */
export interface RawDocument {
  version: number;
  global: unknown;
  sites: Record<string, unknown>;
}

export type Migration = (doc: RawDocument) => RawDocument;

/**
 * Migration hook: MIGRATIONS[n] upgrades a version-n document to n + 1.
 * Version 0 is the unversioned pre-release shape, where the global settings
 * sat directly under "settings" (no `version`, no `global` wrapper),
 * customRect sizes were bare pixel numbers, and per-site overrides lived in
 * `settings.sites` instead of separate "site:" items.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: (doc) => {
    const legacy = isRecord(doc.global) ? { ...doc.global } : {};
    const legacySites = isRecord(legacy.sites) ? legacy.sites : {};
    delete legacy.sites;
    const upgradeRect = (rect: unknown): unknown => {
      if (!isRecord(rect)) return rect;
      const toLength = (v: unknown): unknown => (isFiniteNumber(v) ? { value: v, unit: "px" } : v);
      return { ...rect, width: toLength(rect.width), height: toLength(rect.height) };
    };
    const upgrade = (settings: UnknownRecord): UnknownRecord =>
      "customRect" in settings ? { ...settings, customRect: upgradeRect(settings.customRect) } : settings;
    const sites: Record<string, unknown> = { ...doc.sites };
    for (const [host, override] of Object.entries(legacySites)) {
      if (isRecord(override) && !(host in sites)) sites[host] = upgrade(override);
    }
    return { version: 1, global: upgrade(legacy), sites };
  },
};

export type MigrationStatus =
  /** Nothing stored yet: defaults. */
  | "defaults"
  /** Stored document already at the current version. */
  | "current"
  /** Stored document upgraded from an older version. */
  | "migrated"
  /** Stored document unusable (corrupt or unknown version): defaults. */
  | "reset";

export interface MigrationResult {
  document: SettingsDocument;
  status: MigrationStatus;
  /** Version found in storage (null if none or not a number). */
  fromVersion: number | null;
  /**
   * Whether the caller should write `document` back. False when the stored
   * data comes from a newer build (a downgrade): we run on defaults in memory
   * and leave the newer data untouched for when that build returns.
   */
  persist: boolean;
  warnings: string[];
}

function finalize(doc: RawDocument, warnings: string[]): SettingsDocument {
  const sites: Record<string, SiteOverride> = {};
  for (const [rawHost, rawOverride] of Object.entries(doc.sites)) {
    const host = normalizeHostname(rawHost);
    if (host === null) {
      warnings.push(`dropped override with invalid hostname "${rawHost}"`);
      continue;
    }
    const override = sanitizeOverride(rawOverride);
    if (Object.keys(override).length > 0) sites[host] = { ...sites[host], ...override };
  }
  return { version: SETTINGS_SCHEMA_VERSION, global: sanitizeSettings(doc.global), sites };
}

/**
 * Turns a raw storage dump (chrome.storage.sync.get(null)) into a valid,
 * current-version SettingsDocument. Never throws.
 */
export function migrateSettings(
  raw: Record<string, unknown>,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  targetVersion: number = SETTINGS_SCHEMA_VERSION,
): MigrationResult {
  const warnings: string[] = [];
  const siteItems: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(SITE_KEY_PREFIX)) siteItems[key.slice(SITE_KEY_PREFIX.length)] = value;
  }
  const meta = raw[SETTINGS_KEY];

  if (meta === undefined && Object.keys(siteItems).length === 0) {
    return { document: createDefaultDocument(), status: "defaults", fromVersion: null, persist: true, warnings };
  }
  if (meta !== undefined && !isRecord(meta)) {
    warnings.push("stored settings are not an object; using defaults");
    return { document: createDefaultDocument(), status: "reset", fromVersion: null, persist: true, warnings };
  }

  const metaRecord: UnknownRecord = meta ?? {};
  const rawVersion = metaRecord.version;
  // No "settings" item but some "site:" items (e.g. sync delivered only part of
  // the data): treat as current with default globals. A "settings" item
  // without a version is the unversioned v0 shape.
  const fromVersion = meta === undefined ? targetVersion : rawVersion === undefined ? 0 : rawVersion;

  if (typeof fromVersion !== "number" || !Number.isInteger(fromVersion) || fromVersion < 0) {
    warnings.push(`unknown settings version ${JSON.stringify(rawVersion)}; using defaults`);
    return { document: createDefaultDocument(), status: "reset", fromVersion: null, persist: true, warnings };
  }
  if (fromVersion > targetVersion) {
    warnings.push(`settings version ${fromVersion} is newer than ${targetVersion}; using defaults without saving`);
    return { document: createDefaultDocument(), status: "reset", fromVersion, persist: false, warnings };
  }

  let doc: RawDocument =
    fromVersion === 0
      ? { version: 0, global: meta === undefined ? {} : metaRecord, sites: siteItems }
      : { version: fromVersion, global: metaRecord.global, sites: siteItems };

  while (doc.version < targetVersion) {
    const step = migrations[doc.version];
    if (!step) {
      warnings.push(`no migration from version ${doc.version}; using defaults`);
      return { document: createDefaultDocument(), status: "reset", fromVersion, persist: true, warnings };
    }
    const next = step(doc);
    if (next.version !== doc.version + 1) {
      warnings.push(`migration from version ${doc.version} produced version ${next.version}; using defaults`);
      return { document: createDefaultDocument(), status: "reset", fromVersion, persist: true, warnings };
    }
    doc = next;
  }

  return {
    document: finalize(doc, warnings),
    status: fromVersion === targetVersion ? "current" : "migrated",
    fromVersion,
    persist: fromVersion !== targetVersion,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function siteStorageKey(hostname: string): string {
  return SITE_KEY_PREFIX + hostname;
}

/** Storage items for a document (the inverse of migrateSettings for current data). */
export function serializeSettings(doc: SettingsDocument): Record<string, unknown> {
  const items: Record<string, unknown> = {
    [SETTINGS_KEY]: { version: doc.version, global: cloneSettings(doc.global) },
  };
  for (const [host, override] of Object.entries(doc.sites)) {
    items[siteStorageKey(host)] = override;
  }
  return items;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** True when two documents store exactly the same items (key order does not matter). */
export function sameSettings(a: SettingsDocument, b: SettingsDocument): boolean {
  return canonicalJson(serializeSettings(a)) === canonicalJson(serializeSettings(b));
}

/**
 * What to write to move storage from `stored` (a raw dump) to `doc`:
 * items to set, and "site:" keys whose overrides no longer exist.
 */
export function planSettingsWrite(
  stored: Record<string, unknown>,
  doc: SettingsDocument,
): { set: Record<string, unknown>; remove: string[] } {
  const set = serializeSettings(doc);
  const remove = Object.keys(stored).filter((key) => key.startsWith(SITE_KEY_PREFIX) && !(key in set));
  return { set, remove };
}
