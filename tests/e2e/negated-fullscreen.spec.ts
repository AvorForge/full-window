// negated-fullscreen.html, the offline regression for Loom's share page (https://www.loom.com/share/..., live run in
// Chrome 156, 2026-10-30): emotion inserts `.css-15mfcn7:not(:fullscreen) [data-hide-ifnot-fullscreen] { display:
// none }` with insertRule. Mirroring cannot stop that rule from matching a fake-fullscreen element, so the Pause and
// "Exit full screen" buttons stayed 0 × 0 in every mode (docs/ARCHITECTURE.md §3 "Emulating :fullscreen").
import { expect, openFixture, readLog, realFullscreenElement, test, types, type Page } from "./harness/extension";

const CHANGE = ["fullscreenchange"];

const shown = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((s) => {
    const box = document.querySelector(s)!.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }, selector);

const selectors = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { selectors(): string[] }).selectors());

test.describe(":not(:fullscreen) rules (Loom)", () => {
  test("insertRule-inserted :not(:fullscreen) rules stop hiding the fullscreen-only controls, and hide them again after exit", async ({
    context,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/negated-fullscreen.html`);
    const selectorsBefore = await selectors(page);
    expect(selectorsBefore).toHaveLength(4);
    expect(await shown(page, "#pause")).toBe(false);
    expect(await shown(page, "#exit")).toBe(false);
    expect(await shown(page, "#enter")).toBe(true);

    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    // As in real fullscreen: the fullscreen-only controls show (before the fix: 0 × 0), the normal bar does not,
    // and so does the rule the page inserted from its fullscreenchange handler, while fullscreen.
    await expect(page.locator("#pause")).toBeVisible();
    await expect(page.locator("#exit")).toBeVisible();
    expect(await shown(page, "#enter")).toBe(false);
    await expect(page.locator("#late")).toBeVisible();
    await page.click("#pause");
    expect(types(await readLog(page), ["pause"])).toEqual(["pause"]);

    // The page's own exit button works, and everything is as before.
    await page.click("#exit");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE]);
    expect(await shown(page, "#pause")).toBe(false);
    expect(await shown(page, "#exit")).toBe(false);
    expect(await shown(page, "#late")).toBe(false);
    expect(await shown(page, "#enter")).toBe(true);
    expect(await selectors(page)).toEqual([...selectorsBefore, ".css-late1:not(:fullscreen) [data-late-only]"]);
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);

    // And the same again: the rules are found on the next enter too.
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual([...CHANGE, ...CHANGE, ...CHANGE]);
    await expect(page.locator("#exit")).toBeVisible();
    await expect(page.locator("#late")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toHaveLength(4);
    expect(await shown(page, "#exit")).toBe(false);
    expect(await selectors(page)).toEqual([...selectorsBefore, ".css-late1:not(:fullscreen) [data-late-only]"]);
  });
});
