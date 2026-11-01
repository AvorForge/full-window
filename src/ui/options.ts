import { BRAND } from "../shared/brand";
import { TOGGLE_COMMAND } from "../shared/messages";
import {
  ANCHORS,
  createDefaultDocument,
  sameSettings,
  sanitizeLength,
  sanitizeSettings,
  type FullscreenSettings,
  type LengthUnit,
  type SettingsDocument,
} from "../shared/settings";
import { loadSettings, onSettingsChanged, saveSettings } from "../shared/settingsStore";
import { ANCHOR_LABELS, byId, describeOverride, flashStatus } from "./common";

const enabledEl = byId<HTMLInputElement>("enabled");
const rectFieldsEl = byId<HTMLElement>("rect-fields");
const rectWidthEl = byId<HTMLInputElement>("rect-width");
const rectWidthUnitEl = byId<HTMLSelectElement>("rect-width-unit");
const rectHeightEl = byId<HTMLInputElement>("rect-height");
const rectHeightUnitEl = byId<HTMLSelectElement>("rect-height-unit");
const anchorEl = byId<HTMLSelectElement>("rect-anchor");
const windowFieldsEl = byId<HTMLElement>("window-fields");
const windowWidthEl = byId<HTMLInputElement>("window-width");
const windowHeightEl = byId<HTMLInputElement>("window-height");
const backgroundEl = byId<HTMLInputElement>("background");
const escapeEl = byId<HTMLInputElement>("exit-on-escape");
const filterEl = byId<HTMLInputElement>("site-filter");
const sitesEl = byId<HTMLUListElement>("sites");
const noSitesEl = byId<HTMLParagraphElement>("no-sites");
const noMatchEl = byId<HTMLParagraphElement>("no-match");
const shortcutEl = byId<HTMLElement>("shortcut");
const statusEl = byId<HTMLSpanElement>("status");
const modeEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));

let doc: SettingsDocument = createDefaultDocument();

for (const anchor of ANCHORS) {
  anchorEl.append(new Option(ANCHOR_LABELS[anchor], anchor));
}

byId("version").textContent = chrome.runtime.getManifest().version;
byId("credit").textContent = BRAND.credit;

function renderSites(): void {
  const hosts = Object.keys(doc.sites).sort();
  const filter = filterEl.value.trim().toLowerCase();
  const shown = hosts.filter((host) => host.includes(filter));
  filterEl.hidden = hosts.length === 0;
  noSitesEl.hidden = hosts.length > 0;
  noMatchEl.hidden = hosts.length === 0 || shown.length > 0;
  sitesEl.replaceChildren(
    ...shown.map((host) => {
      const item = document.createElement("li");
      const text = document.createElement("div");
      const name = document.createElement("p");
      name.className = "host";
      name.textContent = host;
      const summary = document.createElement("p");
      summary.className = "small muted";
      summary.textContent = describeOverride(doc.sites[host] ?? {});
      text.append(name, summary);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete settings for ${host}`);
      remove.addEventListener("click", () => {
        const sites = { ...doc.sites };
        delete sites[host];
        void commit({ ...doc, sites });
      });
      item.append(text, remove);
      return item;
    }),
  );
}

function render(): void {
  const g = doc.global;
  enabledEl.checked = g.enabled;
  for (const el of modeEls) el.checked = el.value === g.mode;
  // Only the size fields of the chosen mode, as in the popup.
  rectFieldsEl.hidden = g.mode !== "custom-rect";
  windowFieldsEl.hidden = g.mode !== "pop-out";
  rectWidthEl.value = String(g.customRect.width.value);
  rectWidthUnitEl.value = g.customRect.width.unit;
  rectHeightEl.value = String(g.customRect.height.value);
  rectHeightUnitEl.value = g.customRect.height.unit;
  anchorEl.value = g.customRect.anchor;
  windowWidthEl.value = String(g.windowSize.width);
  windowHeightEl.value = String(g.windowSize.height);
  backgroundEl.value = g.backgroundColor;
  escapeEl.checked = g.exitOnEscape;
  renderSites();
}

/** Reads the form; invalid numbers keep the previous value (sanitizeSettings falls back). */
function readForm(): FullscreenSettings {
  const mode = modeEls.find((el) => el.checked)?.value;
  const length = (input: HTMLInputElement, unit: HTMLSelectElement) =>
    sanitizeLength({ value: input.valueAsNumber, unit: unit.value as LengthUnit });
  return sanitizeSettings(
    {
      enabled: enabledEl.checked,
      mode,
      customRect: {
        width: length(rectWidthEl, rectWidthUnitEl),
        height: length(rectHeightEl, rectHeightUnitEl),
        anchor: anchorEl.value,
      },
      windowSize: { width: windowWidthEl.valueAsNumber, height: windowHeightEl.valueAsNumber },
      backgroundColor: backgroundEl.value,
      exitOnEscape: escapeEl.checked,
    },
    doc.global,
  );
}

/** Saves run one at a time, in the order of the changes; `pending` counts those not finished yet. */
let saving: Promise<void> = Promise.resolve();
let pending = 0;
/** Documents this page wrote whose storage.onChanged echoes may still arrive. */
let written: SettingsDocument[] = [];

function commit(next: SettingsDocument): Promise<void> {
  doc = next;
  render();
  written.push(next);
  pending += 1;
  const save = saving.then(() => saveSettings(next)).finally(() => {
    pending -= 1;
  });
  saving = save.catch(() => undefined);
  return save.then(() => flashStatus(statusEl, "Saved"));
}

// "change" (not "input"): number fields save on blur/Enter, so half-typed values are not written.
for (const el of [
  enabledEl,
  escapeEl,
  backgroundEl,
  anchorEl,
  rectWidthEl,
  rectWidthUnitEl,
  rectHeightEl,
  rectHeightUnitEl,
  windowWidthEl,
  windowHeightEl,
  ...modeEls,
]) {
  el.addEventListener("change", () => void commit({ ...doc, global: readForm() }));
}

filterEl.addEventListener("input", renderSites);

byId<HTMLButtonElement>("reset").addEventListener("click", () => {
  if (window.confirm("Reset all settings, including every site's settings, to defaults?")) {
    void commit(createDefaultDocument());
  }
});

byId<HTMLButtonElement>("open-shortcuts").addEventListener("click", () => {
  // Edge has its own scheme for the same page.
  const scheme = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
  void chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` });
});

async function showShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const keys = commands.find((command) => command.name === TOGGLE_COMMAND)?.shortcut ?? "";
    if (keys === "") byId("shortcut-line").textContent = "No shortcut is set.";
    else shortcutEl.textContent = keys;
  } catch {
    // Keep the default shown in the page.
  }
}

onSettingsChanged((next) => {
  // Every save echoes back through storage.onChanged. Re-rendering that echo would reset a field the user
  // is still typing in (number fields commit on change, i.e. on blur), so only changes made elsewhere
  // (the popup, sync from another device) are shown.
  if (sameSettings(next, doc)) {
    // Storage holds this page's latest save: any later difference is a change made elsewhere.
    if (pending === 0) written = [];
    return;
  }
  // The echo of an earlier save of this page lacks the changes made since. While saves are pending the
  // last of them overwrites storage with what the form shows anyway, so the form keeps it.
  if (pending > 0 || written.some((own) => sameSettings(own, next))) return;
  written = [];
  doc = next;
  render();
});

void showShortcut();
void loadSettings().then((result) => {
  doc = result.document;
  render();
});
