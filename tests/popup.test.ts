// @vitest-environment happy-dom
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../scripts/build.mjs";
import { readText } from "./helpers/text";
import { TOGGLE_COMMAND, type ContentReplies } from "../src/shared/messages";
import { createDefaultDocument, serializeSettings, type SettingsDocument, type SiteOverride } from "../src/shared/settings";
import {
  describeShortcut,
  describeTabState,
  lengthFromInput,
  windowDimensionFromInput,
  withMode,
  withRectAnchor,
  withRectLength,
  withWindowDimension,
} from "../src/ui/popupModel";

const SITE_KEY = "site:www.example.com";

function storedWith(override: SiteOverride | null): Record<string, unknown> {
  const doc: SettingsDocument = createDefaultDocument();
  if (override) doc.sites["www.example.com"] = override;
  return serializeSettings(doc);
}

/** Puts popup.html's <main> into the document and a fake chrome.* on the global object. */
function setUp(site: Partial<ContentReplies["get-site"]> | null, stored: Record<string, unknown>, shortcut = "Alt+Shift+F") {
  const html = readText(join(ROOT, "src/ui/popup.html"));
  document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + "</main>".length);
  let sync = structuredClone(stored);
  const writes: Array<Record<string, unknown>> = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: async () => [{ id: 3 }],
      sendMessage: async (_tabId: number, message: unknown, options: unknown) => {
        if (site === null) throw new Error("Could not establish connection. Receiving end does not exist.");
        expect(message).toEqual({ type: "get-site" });
        expect(options).toEqual({ frameId: 0 });
        return { hostname: "www.example.com", active: false, preferReal: false, real: false, ...site };
      },
    },
    storage: {
      sync: {
        get: async () => structuredClone(sync),
        set: async (items: Record<string, unknown>) => {
          writes.push(structuredClone(items));
          sync = { ...sync, ...structuredClone(items) };
        },
        remove: async (keys: string[]) => {
          sync = Object.fromEntries(Object.entries(sync).filter(([key]) => !keys.includes(key)));
        },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    commands: { getAll: async () => [{ name: TOGGLE_COMMAND, shortcut }] },
    runtime: { openOptionsPage: async () => void openedOptions++ },
  };
  let openedOptions = 0;
  return { stored: () => sync, writes, openedOptions: () => openedOptions };
}

async function openPopup(): Promise<void> {
  vi.resetModules();
  const popup = await import("../src/ui/popup");
  await popup.ready;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function change(id: string, value: string): Promise<void> {
  const element = byId<HTMLInputElement | HTMLSelectElement>(id);
  element.value = value;
  element.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function chooseMode(value: string): Promise<void> {
  const radio = document.querySelector<HTMLInputElement>(`input[name="site-mode"][value="${value}"]`);
  if (!radio) throw new Error(`no ${value} radio`);
  radio.click(); // checks it and fires change, as a click or an arrow key does
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const checkedMode = (): string | undefined => document.querySelector<HTMLInputElement>('input[name="site-mode"]:checked')?.value;

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("popup", () => {
  it("custom-rect: edits width, height (px or %) and anchor for this site and saves them as a site override", async () => {
    const storage = setUp({}, storedWith({ mode: "custom-rect" }));
    await openPopup();
    expect(byId("site").textContent).toBe("www.example.com");
    expect(checkedMode()).toBe("custom-rect");
    expect(byId("rect-size").hidden).toBe(false);
    expect(byId("window-size").hidden).toBe(true);
    expect(byId<HTMLInputElement>("rect-width").value).toBe("80");
    expect(byId<HTMLSelectElement>("rect-width-unit").value).toBe("%");
    expect(byId<HTMLSelectElement>("rect-anchor").value).toBe("center");
    // The stored value stays "center"; only the label is US English.
    expect(byId<HTMLSelectElement>("rect-anchor").selectedOptions[0]?.textContent).toBe("Center");

    byId<HTMLInputElement>("rect-width").value = "640";
    await change("rect-width-unit", "px");
    await change("rect-height", "55");
    await change("rect-anchor", "top-left");
    expect(storage.stored()[SITE_KEY]).toEqual({
      mode: "custom-rect",
      customRect: { width: { value: 640, unit: "px" }, height: { value: 55, unit: "%" }, anchor: "top-left" },
    });
    expect(byId("clear-site").title).toBe("This site's own settings: Custom size, 640px × 55%, anchored top left");

    // Back to what the site gets anyway: the field leaves the override.
    byId<HTMLInputElement>("rect-width").value = "80";
    await change("rect-width-unit", "%");
    await change("rect-height", "80");
    await change("rect-anchor", "center");
    expect(storage.stored()[SITE_KEY]).toEqual({ mode: "custom-rect" });
  });

  it("pop-out: edits the pop-out window width × height for this site", async () => {
    const storage = setUp({}, storedWith(null));
    await openPopup();
    expect(byId("rect-size").hidden).toBe(true);
    expect(byId("window-size").hidden).toBe(true); // fill-tab has no size
    await chooseMode("pop-out");
    expect(byId("window-size").hidden).toBe(false);
    expect(byId<HTMLInputElement>("window-width").value).toBe("640");
    await change("window-width", "1600");
    await change("window-height", "50"); // below the minimum: clamped
    expect(storage.stored()[SITE_KEY]).toEqual({ mode: "pop-out", windowSize: { width: 1600, height: 100 } });

    const writes = storage.writes.length;
    await change("window-width", ""); // not a number: nothing saved, the stored value comes back
    expect(storage.writes).toHaveLength(writes);
    expect(byId<HTMLInputElement>("window-width").value).toBe("1600");
  });

  it("the size choice shows only its own fields, and choosing the default size drops the override", async () => {
    const storage = setUp({}, storedWith(null));
    await openPopup();
    expect(checkedMode()).toBe("fill-tab");
    const visible = (): string[] => ["rect-size", "window-size"].filter((id) => !byId(id).hidden);
    expect(visible()).toEqual([]);

    await chooseMode("custom-rect");
    expect(visible()).toEqual(["rect-size"]);
    expect(storage.stored()[SITE_KEY]).toEqual({ mode: "custom-rect" });

    await chooseMode("pop-out");
    expect(visible()).toEqual(["window-size"]);
    expect(storage.stored()[SITE_KEY]).toEqual({ mode: "pop-out" });

    await chooseMode("fill-tab"); // what the site gets anyway
    expect(visible()).toEqual([]);
    expect(storage.stored()[SITE_KEY]).toBeUndefined();
    expect(byId("clear-site").hidden).toBe(true);
  });

  it("a site without an override: no reset link; the switch saves an override and the link appears", async () => {
    const storage = setUp({}, storedWith(null));
    await openPopup();
    const enabled = byId<HTMLInputElement>("site-enabled");
    expect(enabled.hidden).toBe(false);
    expect(enabled.checked).toBe(true);
    expect(byId("clear-site").hidden).toBe(true);

    enabled.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.stored()[SITE_KEY]).toEqual({ enabled: false });
    expect(byId("clear-site").hidden).toBe(false);
    expect(byId("state").textContent).toBe("Off: this site gets real fullscreen.");
    expect(byId("status").textContent).toBe("Saved");

    enabled.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.stored()[SITE_KEY]).toBeUndefined();
    expect(byId("clear-site").hidden).toBe(true);
  });

  it("a site with an override: shows it, and Reset this site removes it and shows the defaults", async () => {
    const storage = setUp({}, storedWith({ enabled: false, mode: "pop-out", windowSize: { width: 1000 } }));
    await openPopup();
    expect(byId<HTMLInputElement>("site-enabled").checked).toBe(false);
    expect(checkedMode()).toBe("pop-out");
    expect(byId<HTMLInputElement>("window-width").value).toBe("1000");
    const reset = byId<HTMLButtonElement>("clear-site");
    expect(reset.hidden).toBe(false);
    expect(reset.textContent).toBe("Reset this site");

    reset.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.stored()[SITE_KEY]).toBeUndefined();
    expect(byId<HTMLInputElement>("site-enabled").checked).toBe(true);
    expect(checkedMode()).toBe("fill-tab");
    expect(byId("window-size").hidden).toBe(true);
    expect(reset.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("open-options");
  });

  it("follows a parent domain's override and the global defaults", async () => {
    const doc = createDefaultDocument();
    doc.global.mode = "custom-rect";
    doc.sites["example.com"] = { customRect: { width: { value: 500, unit: "px" } } };
    setUp({}, serializeSettings(doc));
    await openPopup();
    expect(checkedMode()).toBe("custom-rect");
    expect(byId<HTMLInputElement>("rect-width").value).toBe("500");
    expect(byId<HTMLSelectElement>("rect-width-unit").value).toBe("px");
    expect(byId("clear-site").hidden).toBe(true); // www.example.com itself has no override
  });

  it("shows what fullscreen does in this tab and the real-fullscreen shortcut", async () => {
    setUp({}, storedWith(null));
    await openPopup();
    expect(byId("state").textContent).toBe("Fullscreen stays inside the tab.");
    expect(byId("shortcut").textContent).toBe("Alt+Shift+F switches to real fullscreen.");

    setUp({ active: true }, storedWith(null));
    await openPopup();
    expect(byId("state").textContent).toBe("In fullscreen inside the tab now.");

    setUp({ active: true, real: true }, storedWith(null), "Ctrl+Shift+Y");
    await openPopup();
    expect(byId("state").textContent).toBe("In real fullscreen now.");
    expect(byId("shortcut").textContent).toBe("Ctrl+Shift+Y returns to the custom size.");

    setUp({ preferReal: true }, storedWith(null));
    await openPopup();
    expect(byId("state").textContent).toBe("Real fullscreen is set for this tab.");
    expect(byId("shortcut").textContent).toBe("Alt+Shift+F switches back to fullscreen inside the tab.");

    setUp({}, storedWith(null), "");
    await openPopup();
    expect(byId("shortcut").textContent).toBe("No shortcut set for real fullscreen.");
  });

  it("every control has a label, and the size choice is a radio group", async () => {
    setUp({}, storedWith({ mode: "custom-rect" }));
    await openPopup();
    const name = (el: HTMLElement): string =>
      el.getAttribute("aria-label") ?? Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent?.trim()).join(" ");
    const controls = Array.from(document.querySelectorAll<HTMLElement>("input, select"));
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) expect(name(control), control.id || control.outerHTML).not.toBe("");
    expect(name(byId("site-enabled"))).toBe("On for www.example.com");
    expect(byId("site-enabled").getAttribute("role")).toBe("switch");
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="site-mode"]'));
    expect(radios.map(name)).toEqual(["Fill tab", "Custom size", "Pop out"]);
    expect(radios[0]?.closest("fieldset")?.querySelector("legend")?.textContent).toBe("Size");
    expect(name(byId("rect-width"))).toBe("Width");
    expect(name(byId("rect-width-unit"))).toBe("Width unit");
    expect(name(byId("rect-anchor"))).toBe("Anchor");
    expect(name(byId("window-width"))).toBe("Window width (px)");
    expect(name(byId("window-height"))).toBe("Window height (px)");
  });

  it("Settings opens the options page", async () => {
    const storage = setUp({}, storedWith(null));
    await openPopup();
    byId<HTMLButtonElement>("open-options").click();
    expect(storage.openedOptions()).toBe(1);
  });

  it("says so on pages without the content script", async () => {
    setUp(null, storedWith(null));
    await openPopup();
    expect(byId("site").textContent).toBe("Not available on this page");
    expect(byId("site-controls").hidden).toBe(true);
    expect(byId("site-enabled").hidden).toBe(true);
    expect(byId("open-options").hidden).toBe(false);
  });
});

describe("popup model", () => {
  const base = createDefaultDocument().global;

  it("edits one override field at a time and drops fields equal to the baseline", () => {
    const wide = withRectLength({}, base, "width", { value: 640, unit: "px" });
    expect(wide).toEqual({ customRect: { width: { value: 640, unit: "px" } } });
    expect(withRectLength(wide, base, "width", { value: 80, unit: "%" })).toEqual({});
    expect(withRectAnchor({ mode: "custom-rect" }, base, "bottom")).toEqual({ mode: "custom-rect", customRect: { anchor: "bottom" } });
    expect(withRectAnchor({ customRect: { anchor: "bottom" } }, base, "center")).toEqual({});
    expect(withWindowDimension({}, base, "height", 900)).toEqual({ windowSize: { height: 900 } });
    expect(withWindowDimension({ windowSize: { height: 900 } }, base, "height", 390)).toEqual({});
    expect(withMode({ enabled: false }, base, "custom-rect")).toEqual({ enabled: false, mode: "custom-rect" });
    expect(withMode({ enabled: false, mode: "custom-rect" }, base, "fill-tab")).toEqual({ enabled: false });
  });

  it("clamps form values to the setting limits", () => {
    expect(lengthFromInput(250, "%")).toEqual({ value: 100, unit: "%" });
    expect(lengthFromInput(0, "px")).toEqual({ value: 1, unit: "px" });
    expect(lengthFromInput(Number.NaN, "px")).toBeUndefined();
    expect(windowDimensionFromInput(99_999)).toBe(16_384);
    expect(windowDimensionFromInput(Number.NaN)).toBeUndefined();
  });

  it("describes the tab's fullscreen and the shortcut", () => {
    const idle = { active: false, preferReal: false, real: false };
    expect(describeTabState(idle, false)).toBe("Off: this site gets real fullscreen.");
    expect(describeTabState({ ...idle, active: true }, false)).toBe("In fullscreen inside the tab now.");
    expect(describeShortcut({ ...idle, preferReal: true }, "")).toBe("No shortcut set for real fullscreen.");
    expect(describeShortcut({ ...idle, active: true, preferReal: true }, "Alt+Shift+F")).toBe("Alt+Shift+F switches to real fullscreen.");
  });
});
