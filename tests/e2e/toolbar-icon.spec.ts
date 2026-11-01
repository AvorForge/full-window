// The per-tab ON/OFF toolbar icon (docs/ARCHITECTURE.md §5): the top frame reports its site's state, the service
// worker sets the sender tab's icon. Chromium has no API that reads an action's icon back (there is no
// chrome.action.getIcon, and headless Chromium draws no toolbar), so these tests record the service worker's
// setIcon calls, with whether each one succeeded, and the site-state messages it receives. Chromium resets every tab-specific action value
// together (icon, title, badge) when the tab's top frame commits a new document; the tests check that reset
// with a tab-specific title, which can be read back.
import { BRAND } from "../../src/shared/brand";
import { expect, openFixture, tabIdOf, test, type Page, type Worker } from "./harness/extension";

const ON = "/icons/icon-16.png";
const OFF = "/icons/icon-off-16.png";

interface Recorded {
  /** result: "pending" until setIcon settles, then "ok" or its error (a path that does not load rejects). */
  icons: Array<{ tabId: number | undefined; icon: string; result: string }>;
  reports: Array<{ tabId: number | undefined; frameId: number | undefined; enabled: unknown }>;
}

/** Records the worker's setIcon calls and their results, and every site-state message it receives, from now on. */
async function record(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const recorded: Recorded = { icons: [], reports: [] };
    (globalThis as unknown as { __recorded: Recorded }).__recorded = recorded;
    const setIcon = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = ((details: chrome.action.TabIconDetails) => {
      const path = details.path as Record<string, string>;
      const call = { tabId: details.tabId ?? undefined, icon: path["16"] ?? "", result: "pending" };
      recorded.icons.push(call);
      const set = setIcon(details);
      set.then(
        () => (call.result = "ok"),
        (error: unknown) => (call.result = error instanceof Error ? error.message : String(error)),
      );
      return set;
    }) as typeof chrome.action.setIcon;
    chrome.runtime.onMessage.addListener((message: { type?: string; enabled?: unknown }, sender) => {
      if (message?.type === "site-state") recorded.reports.push({ tabId: sender.tab?.id, frameId: sender.frameId, enabled: message.enabled });
      return false;
    });
  });
}

const recorded = (worker: Worker): Promise<Recorded> => worker.evaluate(() => (globalThis as unknown as { __recorded: Recorded }).__recorded);
/** The icon the tab's last setIcon call showed; a call that failed or has not settled yet reads as its result. */
const lastIcon = async (worker: Worker, tabId: number): Promise<string | undefined> => {
  const call = (await recorded(worker)).icons.filter((entry) => entry.tabId === tabId).at(-1);
  return call && call.result !== "ok" ? `${call.result}: ${call.icon}` : call?.icon;
};

/** A tab-specific title: Chromium resets it with the tab's icon. */
const setProbe = (worker: Worker, tabId: number): Promise<void> => worker.evaluate((id) => chrome.action.setTitle({ tabId: id, title: "probe" }), tabId);
const title = (worker: Worker, tabId: number): Promise<string> => worker.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);

async function setSite(worker: Worker, host: string, override: Record<string, unknown> | null): Promise<void> {
  await worker.evaluate(
    async ({ key, value }) => (value === null ? chrome.storage.sync.remove(key) : chrome.storage.sync.set({ [key]: value })),
    { key: `site:${host}`, value: override },
  );
}

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __marked: boolean }).__marked = true;
  });
}
const sameDocument = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as { __marked?: boolean }).__marked === true);

test.describe("toolbar icon", () => {
  test("follows the site's switch per tab; only top frames report; a new document starts from the OFF default", async ({
    context,
    serviceWorker,
    page,
    origins,
  }) => {
    await record(serviceWorker);
    const tabId = await tabIdOf(context, serviceWorker, page);

    // A page with two cross-origin child frames: only its top frame reports.
    await openFixture(page, `${origins.a}/embed-parent.html`);
    await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(ON);
    expect((await recorded(serviceWorker)).reports).toEqual([{ tabId, frameId: 0, enabled: true }]);

    // The popup's switch (stored as the site's override) turns this tab's icon OFF, and Reset this site back ON.
    await setSite(serviceWorker, "127.0.0.1", { enabled: false });
    await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(OFF);
    await setSite(serviceWorker, "127.0.0.1", null);
    await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(ON);
    // A change that keeps the site on (its size) is not reported again.
    await setSite(serviceWorker, "127.0.0.1", { mode: "custom-rect" });
    await page.waitForTimeout(300);
    expect((await recorded(serviceWorker)).reports.map((report) => report.enabled)).toEqual([true, false, true]);

    // Tab-specific values survive a same-document navigation (the content script stays) ...
    await setProbe(serviceWorker, tabId);
    await page.evaluate(() => history.pushState(null, "", "#elsewhere"));
    expect(await title(serviceWorker, tabId)).toBe("probe");

    // ... and Chromium resets them when the top frame commits a new document, which reports again.
    const before = (await recorded(serviceWorker)).reports.length;
    await setSite(serviceWorker, "localhost", { enabled: false });
    await openFixture(page, `${origins.b}/plain-video.html`);
    expect(await title(serviceWorker, tabId)).toBe(BRAND.name);
    await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(OFF);
    expect((await recorded(serviceWorker)).reports.slice(before)).toEqual([{ tabId, frameId: 0, enabled: false }]);

    // Another tab keeps its own icon.
    const other = await context.newPage();
    const otherId = await tabIdOf(context, serviceWorker, other);
    await openFixture(other, `${origins.a}/plain-video.html`);
    await expect.poll(() => lastIcon(serviceWorker, otherId)).toBe(ON);
    expect(await lastIcon(serviceWorker, tabId)).toBe(OFF);

    // A page the extension does not run on: no report, and the tab is back on the OFF default.
    await setProbe(serviceWorker, otherId);
    const reports = (await recorded(serviceWorker)).reports.length;
    await other.goto("chrome://version");
    await expect.poll(() => title(serviceWorker, otherId)).toBe(BRAND.name);
    await other.waitForTimeout(300);
    expect((await recorded(serviceWorker)).reports).toHaveLength(reports);
    await other.close();
  });

  test.describe("with the back/forward cache", () => {
    test.use({ backForwardCache: true });

    test("a page restored from the back/forward cache reports again, after Chromium reset the tab's icon", async ({
      context,
      serviceWorker,
      page,
      origins,
    }) => {
      await record(serviceWorker);
      const tabId = await tabIdOf(context, serviceWorker, page);
      await setSite(serviceWorker, "localhost", { enabled: false });

      // plain-page.html: the video fixtures' canvas stream keeps a page out of the cache.
      await openFixture(page, `${origins.a}/plain-page.html`);
      await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(ON);
      await markDocument(page);

      await openFixture(page, `${origins.b}/plain-page.html`);
      await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(OFF);
      await setProbe(serviceWorker, tabId);
      const before = (await recorded(serviceWorker)).reports.length;

      // A restore from the cache fires pageshow, not load.
      await page.goBack({ waitUntil: "commit" });
      // The same document, restored from the cache: no new content script, so only its pageshow handler reports.
      await expect.poll(() => sameDocument(page)).toBe(true);
      await expect.poll(() => title(serviceWorker, tabId)).toBe(BRAND.name);
      await expect.poll(async () => (await recorded(serviceWorker)).reports.slice(before)).toEqual([{ tabId, frameId: 0, enabled: true }]);
      await expect.poll(() => lastIcon(serviceWorker, tabId)).toBe(ON);
    });
  });
});
