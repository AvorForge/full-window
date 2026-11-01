// @vitest-environment happy-dom
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../scripts/build.mjs";
import { BRAND } from "../src/shared/brand";
import { TOGGLE_COMMAND } from "../src/shared/messages";
import { createDefaultDocument, serializeSettings, type SettingsDocument } from "../src/shared/settings";
import { readText } from "./helpers/text";

type Listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

/**
 * Puts options.html's <main> into the document and a fake chrome.* whose writes echo through onChanged.
 * `latency`, when given, delays every storage read, write and echo by the milliseconds it returns.
 */
function setUp(initial: SettingsDocument = createDefaultDocument(), shortcut = "Alt+Shift+F", latency?: () => number) {
  // happy-dom has no Option constructor; options.ts fills the anchor <select> with it.
  (globalThis as unknown as { Option: unknown }).Option ??= class {
    constructor(text: string, value: string) {
      const option = document.createElement("option");
      option.textContent = text;
      option.value = value;
      return option;
    }
  };
  const html = readText(join(ROOT, "src/ui/options.html"));
  document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + "</main>".length);
  let sync: Record<string, unknown> = serializeSettings(initial);
  const created: string[] = [];
  const listeners: Listener[] = [];
  const delay = async (): Promise<void> => {
    if (latency) await settle(latency());
  };
  const write = (items: Record<string, unknown>): void => {
    sync = { ...sync, ...structuredClone(items) };
    const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: value }]));
    // chrome.storage.onChanged fires asynchronously after the write.
    setTimeout(() => {
      for (const listener of listeners) listener(changes, "sync");
    }, latency?.() ?? 5);
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: async () => {
          await delay();
          return structuredClone(sync);
        },
        set: async (items: Record<string, unknown>) => {
          await delay();
          write(items);
        },
        remove: async (keys: string[]) => {
          await delay();
          sync = Object.fromEntries(Object.entries(sync).filter(([key]) => !keys.includes(key)));
          const changes = Object.fromEntries(keys.map((key) => [key, { oldValue: {} }]));
          setTimeout(() => {
            for (const listener of listeners) listener(changes, "sync");
          }, latency?.() ?? 5);
        },
      },
      onChanged: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: () => undefined,
      },
    },
    tabs: { create: async ({ url }: { url: string }) => void created.push(url) },
    runtime: { getManifest: () => ({ version: "1.0.0" }) },
    commands: { getAll: async () => [{ name: TOGGLE_COMMAND, shortcut }] },
  };
  return { stored: () => sync, write, created };
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openOptions(): Promise<void> {
  vi.resetModules();
  await import("../src/ui/options");
  await settle();
}

function global(storage: { stored(): Record<string, unknown> }): Record<string, unknown> {
  return (storage.stored()["settings"] as { global: Record<string, unknown> }).global;
}

async function change(id: string, value: string): Promise<void> {
  const element = byId<HTMLInputElement | HTMLSelectElement>(id);
  element.value = value;
  element.dispatchEvent(new Event("change"));
  await settle();
}

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error("no element");
  element.click();
  await settle();
}

const mode = (value: string): HTMLInputElement | null => document.querySelector<HTMLInputElement>(`input[name="mode"][value="${value}"]`);

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("options page", () => {
  it("the echo of its own save does not reset a field the user is still editing", async () => {
    const storage = setUp();
    await openOptions();
    const width = byId<HTMLInputElement>("window-width");
    const height = byId<HTMLInputElement>("window-height");
    expect(width.value).toBe("640");

    width.value = "900";
    width.dispatchEvent(new Event("change")); // leaving the width field saves it...
    height.value = "600"; // ...while the user already types the height
    await settle(); // the storage.onChanged echo of the width arrives
    expect(height.value).toBe("600");

    height.dispatchEvent(new Event("change"));
    await settle();
    const stored = storage.stored()["settings"] as { global: { windowSize: unknown } };
    expect(stored.global.windowSize).toEqual({ width: 900, height: 600 });
  });

  it("still shows changes made elsewhere (the popup, sync)", async () => {
    const storage = setUp();
    await openOptions();
    const doc = createDefaultDocument();
    doc.global.backgroundColor = "#123456";
    doc.sites["example.com"] = { enabled: false };
    storage.write(serializeSettings(doc));
    await settle();
    expect(byId<HTMLInputElement>("background").value).toBe("#123456");
    expect(byId("sites").textContent).toContain("example.com");
  });

  it("several fields changed in quick succession keep every value", async () => {
    // Storage answers slowly and unevenly, so every save and its onChanged echo overlap the next changes.
    const delays = [5, 10, 15];
    let call = 0;
    const storage = setUp(createDefaultDocument(), "Alt+Shift+F", () => delays[call++ % delays.length] ?? 0);
    await openOptions();
    await click(mode("custom-rect"));
    await settle(300);

    const fields: Array<[id: string, value: string]> = [
      ["rect-width-unit", "px"],
      ["rect-width", "400"],
      ["rect-height-unit", "px"],
      ["rect-height", "300"],
      ["rect-anchor", "bottom-right"],
    ];
    for (const [id, value] of fields) {
      const element = byId<HTMLInputElement | HTMLSelectElement>(id);
      element.value = value;
      element.dispatchEvent(new Event("change"));
      await settle(20); // about one save-and-echo round trip: echoes of earlier saves arrive between changes
    }
    await settle(500);
    expect(global(storage)["customRect"]).toEqual({
      width: { value: 400, unit: "px" },
      height: { value: 300, unit: "px" },
      anchor: "bottom-right",
    });
    expect(fields.map(([id]) => byId<HTMLInputElement | HTMLSelectElement>(id).value)).toEqual(fields.map(([, value]) => value));

    // A later change made elsewhere still shows, even one equal to an earlier save of this page.
    const elsewhere = createDefaultDocument();
    elsewhere.global.mode = "custom-rect";
    elsewhere.global.customRect = { ...elsewhere.global.customRect, width: { value: 400, unit: "px" } };
    storage.write(serializeSettings(elsewhere));
    await settle(300);
    expect(byId<HTMLSelectElement>("rect-height-unit").value).toBe(elsewhere.global.customRect.height.unit);
    expect(byId<HTMLSelectElement>("rect-anchor").value).toBe(elsewhere.global.customRect.anchor);
  });

  it("every default control saves: on/off, size, custom width/height/anchor, window size, backdrop, Esc", async () => {
    const storage = setUp();
    await openOptions();
    expect(mode("fill-tab")?.checked).toBe(true);

    await click(byId("enabled"));
    expect(global(storage)["enabled"]).toBe(false);
    await click(mode("custom-rect"));
    expect(global(storage)["mode"]).toBe("custom-rect");
    await change("rect-width-unit", "px");
    await change("rect-width", "960");
    await change("rect-height", "70");
    await change("rect-anchor", "bottom-right");
    expect(global(storage)["customRect"]).toEqual({
      width: { value: 960, unit: "px" },
      height: { value: 70, unit: "%" },
      anchor: "bottom-right",
    });
    await click(mode("pop-out"));
    await change("window-width", "1600");
    await change("window-height", "900");
    expect(global(storage)["mode"]).toBe("pop-out");
    expect(global(storage)["windowSize"]).toEqual({ width: 1600, height: 900 });
    await change("background", "#336699");
    expect(global(storage)["backgroundColor"]).toBe("#336699");
    await click(byId("exit-on-escape"));
    expect(global(storage)["exitOnEscape"]).toBe(false);
    expect(byId("status").textContent).toBe("Saved");
  });

  it("shows only the fields of the chosen size", async () => {
    setUp();
    await openOptions();
    const visible = (): string[] => ["rect-fields", "window-fields"].filter((id) => !byId(id).hidden);
    expect(visible()).toEqual([]);
    await click(mode("custom-rect"));
    expect(visible()).toEqual(["rect-fields"]);
    await click(mode("pop-out"));
    expect(visible()).toEqual(["window-fields"]);
    await click(mode("fill-tab"));
    expect(visible()).toEqual([]);
  });

  it("lists sites with Delete, and filters them", async () => {
    const doc = createDefaultDocument();
    doc.sites["video.example"] = { mode: "custom-rect" };
    doc.sites["news.example"] = { enabled: false };
    doc.sites["lectures.example"] = { mode: "pop-out", windowSize: { width: 1600, height: 900 } };
    const storage = setUp(doc);
    await openOptions();
    const hosts = (): string[] => Array.from(document.querySelectorAll("#sites .host")).map((el) => el.textContent ?? "");
    expect(hosts()).toEqual(["lectures.example", "news.example", "video.example"]);
    expect(byId("sites").textContent).toContain("Pop out, window 1600 × 900 px");
    expect(byId("no-sites").hidden).toBe(true);

    const filter = byId<HTMLInputElement>("site-filter");
    filter.value = "NEWS";
    filter.dispatchEvent(new Event("input"));
    expect(hosts()).toEqual(["news.example"]);
    filter.value = "nothing";
    filter.dispatchEvent(new Event("input"));
    expect(hosts()).toEqual([]);
    expect(byId("no-match").hidden).toBe(false);
    filter.value = "";
    filter.dispatchEvent(new Event("input"));

    const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Delete settings for news.example"]');
    expect(remove?.textContent).toBe("Delete");
    await click(remove);
    expect(storage.stored()["site:news.example"]).toBeUndefined();
    expect(hosts()).toEqual(["lectures.example", "video.example"]);
  });

  it("with no sites: says so and hides the filter", async () => {
    setUp();
    await openOptions();
    expect(byId("no-sites").hidden).toBe(false);
    expect(byId("site-filter").hidden).toBe(true);
    expect(byId("no-match").hidden).toBe(true);
  });

  it("shows the shortcut and opens the browser's shortcuts page", async () => {
    const storage = setUp(createDefaultDocument(), "Ctrl+Shift+Y");
    await openOptions();
    expect(byId("shortcut").textContent).toBe("Ctrl+Shift+Y");
    await click(byId("open-shortcuts"));
    expect(storage.created).toEqual(["chrome://extensions/shortcuts"]);

    setUp(createDefaultDocument(), "");
    await openOptions();
    expect(byId("shortcut-line").textContent).toBe("No shortcut is set.");
  });

  it("About shows the version, the privacy line and the credit", async () => {
    setUp();
    await openOptions();
    const about = byId("about-title").parentElement?.textContent ?? "";
    expect(byId("version").textContent).toBe("1.0.0");
    expect(about).toContain("No data collected. No network requests.");
    expect(byId("credit").textContent).toBe(BRAND.credit);
  });

  it("sections come in order, every control has a label, and there is no onboarding", async () => {
    setUp();
    await openOptions();
    expect(Array.from(document.querySelectorAll("h2")).map((h) => h.textContent)).toEqual([
      "Default size",
      "Backdrop color",
      "Esc exits",
      "Sites",
      "Keyboard shortcut",
      "About",
    ]);
    for (const control of Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))) {
      const name = control.getAttribute("aria-label") ?? Array.from(control.labels ?? []).map((l) => l.textContent?.trim()).join(" ");
      expect(name, control.id || control.outerHTML).not.toBe("");
    }
  });

  it("Reset all settings asks first, then restores the defaults and drops every site", async () => {
    const doc = createDefaultDocument();
    doc.global.mode = "custom-rect";
    doc.sites["video.example"] = { enabled: false };
    const storage = setUp(doc);
    await openOptions();
    const confirm = vi.fn(() => false);
    (globalThis as unknown as { confirm: unknown }).confirm = confirm;
    window.confirm = confirm;
    await click(byId("reset"));
    expect(global(storage)["mode"]).toBe("custom-rect");
    confirm.mockReturnValue(true);
    await click(byId("reset"));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(global(storage)["mode"]).toBe("fill-tab");
    expect(storage.stored()["site:video.example"]).toBeUndefined();
  });
});
