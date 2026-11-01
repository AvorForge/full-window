import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_KEY, SETTINGS_SCHEMA_VERSION, createDefaultDocument, serializeSettings } from "../src/shared/settings";
import { loadSiteSettings, onSettingsChanged, siteKeys, type StorageArea } from "../src/shared/settingsStore";

/** A sync area holding the global settings and `sites` overrides; records which keys each get asked for. */
function syncArea(sites: Record<string, object>) {
  const doc = createDefaultDocument();
  doc.global.backgroundColor = "#123456";
  for (const [host, override] of Object.entries(sites)) doc.sites[host] = override;
  const stored: Record<string, unknown> = serializeSettings(doc);
  const asked: unknown[] = [];
  const area = {
    get: async (keys: string | string[] | null) => {
      asked.push(keys);
      if (keys === null) return structuredClone(stored);
      const list = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, structuredClone(stored[key])]));
    },
    set: async () => undefined,
    remove: async () => undefined,
  } as unknown as StorageArea;
  return { area, asked };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loading one site's settings", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("asks only for the global settings and the site's own lookup chain", () => {
    expect(siteKeys("www.example.com")).toEqual([SETTINGS_KEY, "site:www.example.com", "site:example.com"]);
    expect(siteKeys("127.0.0.1")).toEqual([SETTINGS_KEY, "site:127.0.0.1"]);
    expect(siteKeys("")).toEqual([SETTINGS_KEY]);
  });

  it("reads those items only, and gets the same settings as reading everything", async () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`site${i}.example`, { enabled: false }]));
    const { area, asked } = syncArea({ ...many, "example.com": { mode: "custom-rect" }, "www.example.com": { mode: "pop-out" } });
    const result = await loadSiteSettings("www.example.com", area);
    expect(asked).toEqual([[SETTINGS_KEY, "site:www.example.com", "site:example.com"]]);
    expect(result.document.global.backgroundColor).toBe("#123456");
    expect(result.document.sites).toEqual({ "example.com": { mode: "custom-rect" }, "www.example.com": { mode: "pop-out" } });
    expect(result.document.version).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("with a hostname, reacts only to changes to that site's items, and reads only those", async () => {
    const { area, asked } = syncArea({ "example.com": { enabled: false } });
    let listener: ((changes: Record<string, unknown>, area: string) => void) | undefined;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { sync: area, onChanged: { addListener: (l: typeof listener) => (listener = l), removeListener: () => undefined } },
    };
    const seen: unknown[] = [];
    onSettingsChanged((doc) => seen.push(doc.sites), "example.com");

    listener!({ "site:other.example": { newValue: {} } }, "sync");
    listener!({ unrelated: { newValue: 1 } }, "sync");
    listener!({ "site:example.com": { newValue: {} } }, "local");
    await flush();
    expect(seen).toEqual([]);

    listener!({ "site:example.com": { newValue: { enabled: false } } }, "sync");
    listener!({ [SETTINGS_KEY]: { newValue: {} } }, "sync");
    await flush();
    expect(seen).toEqual([{ "example.com": { enabled: false } }, { "example.com": { enabled: false } }]);
    expect(asked).toEqual([siteKeys("example.com"), siteKeys("example.com")]);
  });
});
