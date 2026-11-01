import { TOGGLE_COMMAND, type ContentReplies } from "../shared/messages";
import {
  ANCHORS,
  normalizeHostname,
  resolveForSite,
  type Anchor,
  type LengthUnit,
  type ResolvedSettings,
  type SettingsDocument,
  type SiteOverride,
  type SizeMode,
} from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/settingsStore";
import { ANCHOR_LABELS, byId, describeOverride, flashStatus } from "./common";
import {
  describeShortcut,
  describeTabState,
  lengthFromInput,
  windowDimensionFromInput,
  withMode,
  withRectAnchor,
  withRectLength,
  withWindowDimension,
  type Axis,
  type TabStatus,
} from "./popupModel";

const siteEl = byId<HTMLHeadingElement>("site");
const stateEl = byId<HTMLParagraphElement>("state");
const enabledEl = byId<HTMLInputElement>("site-enabled");
const controls = byId<HTMLElement>("site-controls");
const modeEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="site-mode"]'));
const rectSizeEl = byId<HTMLElement>("rect-size");
const rectWidthEl = byId<HTMLInputElement>("rect-width");
const rectWidthUnitEl = byId<HTMLSelectElement>("rect-width-unit");
const rectHeightEl = byId<HTMLInputElement>("rect-height");
const rectHeightUnitEl = byId<HTMLSelectElement>("rect-height-unit");
const anchorEl = byId<HTMLSelectElement>("rect-anchor");
const windowSizeEl = byId<HTMLElement>("window-size");
const windowWidthEl = byId<HTMLInputElement>("window-width");
const windowHeightEl = byId<HTMLInputElement>("window-height");
const shortcutEl = byId<HTMLParagraphElement>("shortcut");
const clearEl = byId<HTMLButtonElement>("clear-site");
const statusEl = byId<HTMLSpanElement>("status");

for (const anchor of ANCHORS) {
  const option = document.createElement("option");
  option.value = anchor;
  option.textContent = ANCHOR_LABELS[anchor];
  anchorEl.append(option);
}

let doc: SettingsDocument;
let hostname = "";
let tab: TabStatus = { hostname: "", active: false, preferReal: false, real: false };
let shortcut = "Alt+Shift+F";

/** Asks the tab's top frame for its hostname and fullscreen state; fails on pages without content scripts. */
async function querySite(): Promise<ContentReplies["get-site"] | null> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id === undefined) return null;
  try {
    const reply = (await chrome.tabs.sendMessage(active.id, { type: "get-site" }, { frameId: 0 })) as
      | ContentReplies["get-site"]
      | undefined;
    return reply && reply.hostname ? reply : null;
  } catch {
    return null;
  }
}

/** The toggle's current key combination (the user can change it at chrome://extensions/shortcuts). */
async function queryShortcut(): Promise<string> {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === TOGGLE_COMMAND)?.shortcut ?? "";
  } catch {
    return shortcut;
  }
}

/** What this site gets without its own override (global plus any parent-domain override). */
function baseline(): ResolvedSettings {
  const sites = { ...doc.sites };
  delete sites[hostname];
  return resolveForSite({ ...doc, sites }, hostname);
}

function render(): void {
  const override: SiteOverride = doc.sites[hostname] ?? {};
  const resolved = resolveForSite(doc, hostname);
  enabledEl.checked = resolved.enabled;
  for (const el of modeEls) el.checked = el.value === resolved.mode;

  // Only the size fields of the mode in effect for this site.
  rectSizeEl.hidden = resolved.mode !== "custom-rect";
  windowSizeEl.hidden = resolved.mode !== "pop-out";
  rectWidthEl.value = String(resolved.customRect.width.value);
  rectWidthUnitEl.value = resolved.customRect.width.unit;
  rectHeightEl.value = String(resolved.customRect.height.value);
  rectHeightUnitEl.value = resolved.customRect.height.unit;
  anchorEl.value = resolved.customRect.anchor;
  windowWidthEl.value = String(resolved.windowSize.width);
  windowHeightEl.value = String(resolved.windowSize.height);

  stateEl.textContent = describeTabState(tab, resolved.enabled);
  shortcutEl.textContent = describeShortcut(tab, shortcut);

  const hasOverride = Object.keys(override).length > 0;
  clearEl.hidden = !hasOverride;
  clearEl.title = hasOverride ? `This site's own settings: ${describeOverride(override)}` : "";
}

async function update(change: (override: SiteOverride) => SiteOverride): Promise<void> {
  const next = change({ ...(doc.sites[hostname] ?? {}) });
  const sites = { ...doc.sites };
  if (Object.keys(next).length > 0) sites[hostname] = next;
  else delete sites[hostname];
  doc = { ...doc, sites };
  render();
  await saveSettings(doc);
  flashStatus(statusEl, "Saved");
}

enabledEl.addEventListener("change", () => {
  void update((override) => {
    if (enabledEl.checked === baseline().enabled) delete override.enabled;
    else override.enabled = enabledEl.checked;
    return override;
  });
});

for (const el of modeEls) {
  el.addEventListener("change", () => {
    if (el.checked) void update((override) => withMode(override, baseline(), el.value as SizeMode));
  });
}

// "change" (not "input"): number fields save on blur/Enter, so half-typed values are not written.
for (const [axis, valueEl, unitEl] of [
  ["width", rectWidthEl, rectWidthUnitEl],
  ["height", rectHeightEl, rectHeightUnitEl],
] as Array<[Axis, HTMLInputElement, HTMLSelectElement]>) {
  const commit = (): void => {
    const length = lengthFromInput(valueEl.valueAsNumber, unitEl.value as LengthUnit);
    if (!length) {
      render(); // not a number: show the stored value again
      return;
    }
    void update((override) => withRectLength(override, baseline(), axis, length));
  };
  valueEl.addEventListener("change", commit);
  unitEl.addEventListener("change", commit);
}

anchorEl.addEventListener("change", () => {
  void update((override) => withRectAnchor(override, baseline(), anchorEl.value as Anchor));
});

for (const [axis, valueEl] of [
  ["width", windowWidthEl],
  ["height", windowHeightEl],
] as Array<[Axis, HTMLInputElement]>) {
  valueEl.addEventListener("change", () => {
    const value = windowDimensionFromInput(valueEl.valueAsNumber);
    if (value === undefined) {
      render();
      return;
    }
    void update((override) => withWindowDimension(override, baseline(), axis, value));
  });
}

clearEl.addEventListener("click", () => {
  void update(() => ({}));
  // The link disappears with the override; keep the keyboard focus inside the popup.
  byId<HTMLButtonElement>("open-options").focus();
});

byId<HTMLButtonElement>("open-options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  const [settings, site, keys] = await Promise.all([loadSettings(), querySite(), queryShortcut()]);
  doc = settings.document;
  shortcut = keys;
  if (!site) {
    siteEl.textContent = "Not available on this page";
    shortcutEl.hidden = true;
    return;
  }
  tab = site;
  hostname = normalizeHostname(site.hostname) ?? site.hostname;
  siteEl.textContent = hostname;
  enabledEl.setAttribute("aria-label", `On for ${hostname}`);
  enabledEl.hidden = false;
  stateEl.hidden = false;
  controls.hidden = false;
  render();
}

export const ready = init();
