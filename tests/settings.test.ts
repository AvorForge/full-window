import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MIGRATIONS,
  SETTINGS_KEY,
  SETTINGS_SCHEMA_VERSION,
  createDefaultDocument,
  migrateSettings,
  normalizeHostname,
  planSettingsWrite,
  resolveForSite,
  sameSettings,
  sanitizeOverride,
  serializeSettings,
  siteLookupChain,
  type SettingsDocument,
} from "../src/shared/settings";

function docWith(sites: SettingsDocument["sites"], global = createDefaultDocument().global): SettingsDocument {
  return { version: SETTINGS_SCHEMA_VERSION, global, sites };
}

describe("defaults", () => {
  it("are complete, valid and match the documented values", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      enabled: true,
      mode: "fill-tab",
      customRect: { width: { value: 80, unit: "%" }, height: { value: 80, unit: "%" }, anchor: "center" },
      windowSize: { width: 640, height: 390 },
      backgroundColor: "#000000",
      exitOnEscape: true,
    });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  it("createDefaultDocument returns an independent copy at the current version", () => {
    const a = createDefaultDocument();
    const b = createDefaultDocument();
    a.global.customRect.width.value = 10;
    expect(b.global.customRect.width.value).toBe(80);
    expect(a.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(a.sites).toEqual({});
  });

  it("empty storage yields defaults and asks to persist them", () => {
    const result = migrateSettings({});
    expect(result.status).toBe("defaults");
    expect(result.persist).toBe(true);
    expect(result.document).toEqual(createDefaultDocument());
  });
});

describe("migration", () => {
  it("leaves a current document as is (after sanitising)", () => {
    const doc = docWith({ "example.com": { mode: "custom-rect" } });
    const result = migrateSettings(serializeSettings(doc));
    expect(result.status).toBe("current");
    expect(result.persist).toBe(false);
    expect(result.document).toEqual(doc);
  });

  it("migrates the unversioned v0 shape to the current version", () => {
    const raw = {
      [SETTINGS_KEY]: {
        enabled: false,
        mode: "custom-rect",
        customRect: { width: 1024, height: 576, anchor: "top-left" },
        backgroundColor: "#112233",
        sites: {
          "youtube.com": { enabled: true, customRect: { width: 640 } },
          "Vimeo.COM": { mode: "pop-out" },
        },
      },
    };
    const result = migrateSettings(raw);
    expect(result.status).toBe("migrated");
    expect(result.fromVersion).toBe(0);
    expect(result.persist).toBe(true);
    expect(result.document.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(result.document.global).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      mode: "custom-rect",
      customRect: { width: { value: 1024, unit: "px" }, height: { value: 576, unit: "px" }, anchor: "top-left" },
      backgroundColor: "#112233",
    });
    expect(result.document.sites).toEqual({
      "youtube.com": { enabled: true, customRect: { width: { value: 640, unit: "px" } } },
      "vimeo.com": { mode: "pop-out" },
    });
  });

  it("runs every step of the migration hook in order", () => {
    const calls: number[] = [];
    const migrations = {
      0: (d: { version: number; global: unknown; sites: Record<string, unknown> }) => {
        calls.push(0);
        return { ...d, version: 1 };
      },
      1: (d: { version: number; global: unknown; sites: Record<string, unknown> }) => {
        calls.push(1);
        return { ...d, version: 2 };
      },
    };
    const result = migrateSettings({ [SETTINGS_KEY]: { mode: "fill-tab" } }, migrations, 2);
    expect(calls).toEqual([0, 1]);
    expect(result.status).toBe("migrated");
  });

  it("resets an unknown (non-numeric) version to defaults and persists", () => {
    const result = migrateSettings({ [SETTINGS_KEY]: { version: "banana", global: { mode: "custom-rect" } } });
    expect(result.status).toBe("reset");
    expect(result.persist).toBe(true);
    expect(result.document).toEqual(createDefaultDocument());
    expect(result.warnings.join()).toMatch(/unknown settings version/);
  });

  it("uses defaults for a newer version without overwriting it", () => {
    const result = migrateSettings({ [SETTINGS_KEY]: { version: SETTINGS_SCHEMA_VERSION + 98, global: {} } });
    expect(result.status).toBe("reset");
    expect(result.fromVersion).toBe(SETTINGS_SCHEMA_VERSION + 98);
    expect(result.persist).toBe(false);
    expect(result.document).toEqual(createDefaultDocument());
  });

  it("resets when a migration step is missing or skips a version", () => {
    expect(migrateSettings({ [SETTINGS_KEY]: { version: 0 } }, {}).status).toBe("reset");
    const skipping = { 0: () => ({ version: 5, global: {}, sites: {} }) };
    expect(migrateSettings({ [SETTINGS_KEY]: {} }, skipping).status).toBe("reset");
  });

  it("resets corrupt settings and drops invalid fields and hostnames", () => {
    expect(migrateSettings({ [SETTINGS_KEY]: "corrupt" }).status).toBe("reset");
    const result = migrateSettings({
      [SETTINGS_KEY]: {
        version: 1,
        global: { mode: "giant", enabled: "yes", customRect: { width: { value: 150, unit: "%" } } },
      },
      "site:bad host!": { mode: "fill-tab" },
      "site:ok.example": { mode: "nope", windowSize: { width: 99999 } },
    });
    expect(result.document.global).toEqual(DEFAULT_SETTINGS);
    expect(result.document.sites).toEqual({});
    expect(result.warnings.some((w) => w.includes("bad host!"))).toBe(true);
  });

  it("treats site items without a settings item as current with default globals", () => {
    const result = migrateSettings({ "site:example.com": { enabled: false } });
    expect(result.status).toBe("current");
    expect(result.document.global).toEqual(DEFAULT_SETTINGS);
    expect(result.document.sites).toEqual({ "example.com": { enabled: false } });
  });

  it("has a migration for every version below the current one", () => {
    for (let v = 0; v < SETTINGS_SCHEMA_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf("function");
  });
});

describe("per-site resolution", () => {
  it("normalises hostnames", () => {
    expect(normalizeHostname(" WWW.Example.COM. ")).toBe("www.example.com");
    expect(normalizeHostname("https://Video.Example.com:8443/watch?v=1")).toBe("video.example.com");
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("bad host")).toBeNull();
    expect(normalizeHostname("a..b")).toBeNull();
  });

  it("walks from the most specific hostname to the registrable-looking parent", () => {
    expect(siteLookupChain("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(siteLookupChain("example.com")).toEqual(["example.com"]);
    expect(siteLookupChain("localhost")).toEqual(["localhost"]);
    expect(siteLookupChain("192.168.1.10")).toEqual(["192.168.1.10"]);
    expect(siteLookupChain("[::1]")).toEqual(["[::1]"]);
  });

  it("returns global settings when no override matches", () => {
    const doc = docWith({ "other.com": { enabled: false } });
    const resolved = resolveForSite(doc, "example.com");
    expect(resolved).toEqual({ ...DEFAULT_SETTINGS, hostname: "example.com", appliedOverrides: [] });
  });

  it("applies an exact-host override on top of global settings", () => {
    const doc = docWith({ "example.com": { mode: "custom-rect", customRect: { anchor: "bottom-right" } } });
    const resolved = resolveForSite(doc, "Example.com");
    expect(resolved.mode).toBe("custom-rect");
    expect(resolved.customRect).toEqual({ ...DEFAULT_SETTINGS.customRect, anchor: "bottom-right" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.appliedOverrides).toEqual(["example.com"]);
  });

  it("applies parent-domain overrides to subdomains, most specific last", () => {
    const doc = docWith({
      "example.com": { enabled: false, mode: "pop-out", windowSize: { width: 800 } },
      "www.example.com": { enabled: true },
    });
    const www = resolveForSite(doc, "www.example.com");
    expect(www.enabled).toBe(true);
    expect(www.mode).toBe("pop-out");
    expect(www.windowSize).toEqual({ width: 800, height: 390 });
    expect(www.appliedOverrides).toEqual(["example.com", "www.example.com"]);

    expect(resolveForSite(doc, "m.example.com").enabled).toBe(false);
    expect(resolveForSite(doc, "notexample.com").enabled).toBe(true);
  });

  it("does not mutate the document", () => {
    const doc = docWith({ "example.com": { customRect: { width: { value: 50, unit: "%" } } } });
    const before = structuredClone(doc);
    resolveForSite(doc, "example.com").customRect.width.value = 1;
    expect(doc).toEqual(before);
  });

  it("uses a changed global setting where no override sets it", () => {
    const global = { ...createDefaultDocument().global, backgroundColor: "#ffffff" };
    const doc = docWith({ "example.com": { mode: "custom-rect" } }, global);
    expect(resolveForSite(doc, "example.com").backgroundColor).toBe("#ffffff");
  });

  it("ignores empty or invalid hostnames", () => {
    const doc = docWith({});
    expect(resolveForSite(doc, "").hostname).toBe("");
    expect(resolveForSite(doc, "").enabled).toBe(true);
  });
});

describe("sanitising and storage layout", () => {
  it("keeps only valid override fields", () => {
    expect(
      sanitizeOverride({
        enabled: false,
        mode: "custom-rect",
        customRect: { width: { value: 0, unit: "px" }, height: { value: 50, unit: "%" }, anchor: "middle" },
        windowSize: { width: 1000.4, height: 50 },
        backgroundColor: "#ABCDEF",
        extra: 1,
      }),
    ).toEqual({
      enabled: false,
      mode: "custom-rect",
      customRect: { height: { value: 50, unit: "%" } },
      windowSize: { width: 1000 },
      backgroundColor: "#abcdef",
    });
  });

  it("reads a saved \"Resize window\" choice as pop out (pop out replaced it)", () => {
    expect(sanitizeOverride({ mode: "window-resize", windowSize: { width: 900, height: 600 } })).toEqual({
      mode: "pop-out",
      windowSize: { width: 900, height: 600 },
    });
    const migrated = migrateSettings({ [SETTINGS_KEY]: { version: SETTINGS_SCHEMA_VERSION, global: { mode: "window-resize" } }, "site:a.example": { mode: "window-resize" } });
    expect(migrated.document.global.mode).toBe("pop-out");
    expect(migrated.document.sites["a.example"]).toEqual({ mode: "pop-out" });
  });

  it("stores each site as its own item and removes deleted ones", () => {
    const doc = docWith({ "a.com": { enabled: false } });
    const items = serializeSettings(doc);
    expect(Object.keys(items).sort()).toEqual(["settings", "site:a.com"]);
    expect(items.settings).toEqual({ version: SETTINGS_SCHEMA_VERSION, global: doc.global });
    const plan = planSettingsWrite({ ...items, "site:b.com": { enabled: true }, unrelated: 1 }, doc);
    expect(plan.remove).toEqual(["site:b.com"]);
    expect(JSON.stringify(plan.set).length).toBeLessThan(8192);
  });

  it("sameSettings compares stored content, not key order", () => {
    const a = docWith({ "a.com": { enabled: false, mode: "fill-tab" }, "b.com": { exitOnEscape: false } });
    const b = docWith({ "b.com": { exitOnEscape: false }, "a.com": { mode: "fill-tab", enabled: false } });
    expect(sameSettings(a, b)).toBe(true);
    expect(sameSettings(a, docWith({ "a.com": { enabled: false, mode: "fill-tab" } }))).toBe(false);
    const changed = docWith({ "a.com": { enabled: false, mode: "fill-tab" }, "b.com": { exitOnEscape: false } });
    changed.global.windowSize = { width: 900, height: 600 };
    expect(sameSettings(a, changed)).toBe(false);
  });
});
