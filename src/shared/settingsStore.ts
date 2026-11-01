/**
 * chrome.storage.sync I/O for the settings document. The pure schema logic
 * lives in settings.ts; this file only reads, migrates and writes.
 */

import {
  SETTINGS_KEY,
  SITE_KEY_PREFIX,
  migrateSettings,
  planSettingsWrite,
  siteLookupChain,
  type MigrationResult,
  type SettingsDocument,
} from "./settings";

export type StorageArea = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;

function defaultArea(): StorageArea {
  return chrome.storage.sync;
}

/** Reads and migrates. Does not write; see ensureMigrated for that. */
export async function loadSettings(area: StorageArea = defaultArea()): Promise<MigrationResult> {
  const raw = (await area.get(null)) as Record<string, unknown>;
  return migrateSettings(raw);
}

/**
 * The storage items a page on `hostname` needs: the global settings and the overrides of its own lookup chain
 * (www.example.com, example.com). The content scripts read only these, so their work per page and per frame
 * doesn't grow with the number of sites that have their own settings.
 */
export function siteKeys(hostname: string): string[] {
  return [SETTINGS_KEY, ...siteLookupChain(hostname).map((host) => SITE_KEY_PREFIX + host)];
}

/** Reads and migrates only what a page on `hostname` needs (siteKeys); the document has just those sites. */
export async function loadSiteSettings(hostname: string, area: StorageArea = defaultArea()): Promise<MigrationResult> {
  const raw = (await area.get(siteKeys(hostname))) as Record<string, unknown>;
  return migrateSettings(raw);
}

/** Writes `doc`, removing "site:" items for overrides that were deleted. */
export async function saveSettings(doc: SettingsDocument, area: StorageArea = defaultArea()): Promise<void> {
  const raw = (await area.get(null)) as Record<string, unknown>;
  const plan = planSettingsWrite(raw, doc);
  await area.set(plan.set);
  if (plan.remove.length > 0) await area.remove(plan.remove);
}

/** Loads, and persists the result when migration changed it (called by the service worker on install/update). */
export async function ensureMigrated(area: StorageArea = defaultArea()): Promise<MigrationResult> {
  const result = await loadSettings(area);
  if (result.persist && result.status !== "current") await saveSettings(result.document, area);
  return result;
}

/** True when a storage change touches settings. */
export function isSettingsChange(changes: Record<string, chrome.storage.StorageChange>): boolean {
  return Object.keys(changes).some((key) => key === SETTINGS_KEY || key.startsWith(SITE_KEY_PREFIX));
}

/**
 * Calls `listener` with the freshly migrated document whenever sync settings change. With `hostname`, only
 * changes to that page's items (siteKeys) count, and only those items are read again.
 */
export function onSettingsChanged(listener: (doc: SettingsDocument) => void, hostname?: string): () => void {
  const keys = hostname === undefined ? null : new Set(siteKeys(hostname));
  const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
    if (areaName !== "sync" || !isSettingsChange(changes)) return;
    if (keys && !Object.keys(changes).some((key) => keys.has(key))) return;
    void (hostname === undefined ? loadSettings() : loadSiteSettings(hostname)).then((result) => listener(result.document));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
