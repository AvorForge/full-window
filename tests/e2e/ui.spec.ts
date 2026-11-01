// The popup and the options page in the real extension: keyboard operation, labels, the size fields that
// show and hide, a site with and without its own settings, and that what they save applies to the page.
// Also a plain demo player (fixtures/demo-player.html): it fills the tab and its own controls keep working.
import {
  expect,
  openFixture,
  openPopupFor,
  readLog,
  realFullscreenElement,
  rectOf,
  test,
  types,
  viewportOf,
  windowOf,
  type Page,
  type Worker,
} from "./harness/extension";
import { expectedRect } from "./harness/geometry";

const CHANGE = ["fullscreenchange"];

async function stored(worker: Worker, key: string): Promise<unknown> {
  return worker.evaluate(async (k) => (await chrome.storage.sync.get(k))[k], key);
}

async function storedGlobal(worker: Worker): Promise<Record<string, unknown>> {
  return ((await stored(worker, "settings")) as { global: Record<string, unknown> }).global;
}

async function openOptions(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/ui/options.html`);
  await expect(page.locator("#version")).toHaveText("1.0.0");
}

test.describe("popup", () => {
  test("keyboard only: switch, size choice, custom size fields; the custom size applies to the page", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await openFixture(page, `${origins.a}/plain-video.html`);
    const popup = await openPopupFor(context, serviceWorker, extensionId, page);
    await popup.bringToFront();
    await expect(popup).toHaveTitle("Full Window, Not Screen: Video Sizer");
    // No panel inside the popup window: Chrome and Edge draw that window square, so an inset, outlined or
    // rounded panel shows its corners (e7b14e6).
    await expect(popup.locator("body")).toHaveCSS("padding", "0px");
    await expect(popup.locator("main")).toHaveCSS("border-width", "0px");
    await expect(popup.locator("main")).toHaveCSS("border-radius", "0px");
    const enabled = popup.getByRole("switch", { name: "On for 127.0.0.1" });
    await expect(enabled).toBeChecked();
    await expect(popup.getByRole("button", { name: "Reset this site" })).toBeHidden();
    await expect(popup.locator("#state")).toHaveText("Fullscreen stays inside the tab.");
    await expect(popup.locator("#shortcut")).toContainText("switches to real fullscreen.");

    // Tab to the switch; Space turns the site off and on again.
    await popup.keyboard.press("Tab");
    await expect(enabled).toBeFocused();
    await popup.keyboard.press("Space");
    await expect(enabled).not.toBeChecked();
    await expect.poll(() => stored(serviceWorker, "site:127.0.0.1")).toEqual({ enabled: false });
    await expect(popup.getByRole("button", { name: "Reset this site" })).toBeVisible();
    await popup.keyboard.press("Space");
    await expect.poll(() => stored(serviceWorker, "site:127.0.0.1")).toBeUndefined();

    // Tab into the size group; the arrow keys choose, and only the chosen size's fields show.
    await popup.keyboard.press("Tab");
    await expect(popup.getByRole("radio", { name: "Fill tab" })).toBeFocused();
    await expect(popup.getByRole("group", { name: "Size" })).toBeVisible();
    await expect(popup.getByLabel("Width", { exact: true })).toBeHidden();
    await popup.keyboard.press("ArrowRight");
    await expect(popup.getByRole("radio", { name: "Custom size" })).toBeChecked();
    await expect.poll(() => stored(serviceWorker, "site:127.0.0.1")).toEqual({ mode: "custom-rect" });
    await expect(popup.getByLabel("Width", { exact: true })).toBeVisible();
    await expect(popup.getByLabel("Anchor")).toBeVisible();
    await expect(popup.getByLabel("Window width (px)")).toBeHidden();
    await popup.keyboard.press("ArrowRight");
    await expect(popup.getByRole("radio", { name: "Pop out" })).toBeChecked();
    await expect(popup.getByLabel("Window width (px)")).toBeVisible();
    await expect(popup.getByLabel("Window height (px)")).toBeVisible();
    await expect(popup.getByLabel("Width", { exact: true })).toBeHidden();
    await popup.keyboard.press("ArrowLeft");
    await expect(popup.getByRole("radio", { name: "Custom size" })).toBeChecked();

    // Width, its unit, height and anchor, field by field with Tab.
    await popup.keyboard.press("Tab");
    await expect(popup.getByLabel("Width", { exact: true })).toBeFocused();
    await popup.keyboard.press("ControlOrMeta+A");
    await popup.keyboard.type("50");
    await popup.keyboard.press("Tab");
    await expect(popup.getByLabel("Width unit")).toBeFocused();
    await popup.keyboard.press("Tab");
    await expect(popup.getByLabel("Height", { exact: true })).toBeFocused();
    await popup.keyboard.press("ControlOrMeta+A");
    await popup.keyboard.type("40");
    await popup.keyboard.press("Tab");
    await popup.keyboard.press("Tab");
    await expect(popup.getByLabel("Anchor")).toBeFocused();
    await popup.getByLabel("Anchor").selectOption("top-left");
    const rect = { width: 50, widthUnit: "%", height: 40, heightUnit: "%", anchor: "top-left" } as const;
    await expect
      .poll(() => stored(serviceWorker, "site:127.0.0.1"))
      .toEqual({
        mode: "custom-rect",
        customRect: { width: { value: 50, unit: "%" }, height: { value: 40, unit: "%" }, anchor: "top-left" },
      });
    await popup.close();

    // Live, without a reload: the page's next fullscreen uses this site's size.
    await page.bringToFront();
    await page.click("#enter");
    await expect.poll(async () => types(await readLog(page), CHANGE)).toEqual(CHANGE);
    expect(await realFullscreenElement(context, page)).toBeNull();
    expect(await rectOf(page.locator("#video"))).toEqual(expectedRect(await viewportOf(page), rect));
  });

  test("a site with its own settings shows them and Reset this site (by keyboard) returns it to the defaults", async ({
    context,
    serviceWorker,
    extensionId,
    page,
    origins,
  }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({ "site:127.0.0.1": { mode: "pop-out", windowSize: { width: 1000 } } });
    });
    await openFixture(page, `${origins.a}/plain-video.html`);
    const popup = await openPopupFor(context, serviceWorker, extensionId, page);
    await popup.bringToFront();
    await expect(popup.getByRole("radio", { name: "Pop out" })).toBeChecked();
    await expect(popup.getByLabel("Window width (px)")).toHaveValue("1000");
    await expect(popup.getByLabel("Window height (px)")).toHaveValue("390");
    await expect(popup.getByLabel("Width", { exact: true })).toBeHidden();
    const reset = popup.getByRole("button", { name: "Reset this site" });
    await expect(reset).toBeVisible();

    await reset.focus();
    await popup.keyboard.press("Enter");
    await expect.poll(() => stored(serviceWorker, "site:127.0.0.1")).toBeUndefined();
    await expect(reset).toBeHidden();
    await expect(popup.getByRole("radio", { name: "Fill tab" })).toBeChecked();
    await expect(popup.getByLabel("Window width (px)")).toBeHidden();
    await expect(popup.getByRole("button", { name: "Settings" })).toBeFocused();
    await popup.close();

    // The other origin never had an override: no reset link.
    const other = await context.newPage();
    await openFixture(other, `${origins.b}/plain-video.html`);
    const otherPopup = await openPopupFor(context, serviceWorker, extensionId, other);
    await expect(otherPopup.locator("#site")).toHaveText("localhost");
    await expect(otherPopup.getByRole("button", { name: "Reset this site" })).toBeHidden();
    await expect(otherPopup.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  // A toolbar popup starts with a tiny viewport and grows to fit its content, so nothing in it may follow the
  // viewport's width: the popup is 320 px wide whether or not the extension can run on the tab.
  for (const where of ["a site", "a page where the extension cannot run"] as const) {
    test(`is 320 px wide in a 60 px viewport on ${where}, with nothing cut off or broken mid-word`, async ({
      context,
      serviceWorker,
      extensionId,
      page,
      origins,
    }) => {
      if (where === "a site") await openFixture(page, `${origins.a}/plain-video.html`);
      else await page.goto("chrome://version/");
      await page.bringToFront();
      const { windowId } = await windowOf(context, page);
      const opened = context.waitForEvent("page");
      await serviceWorker.evaluate(
        async ({ url, id }) => {
          await chrome.tabs.create({ url, active: false, windowId: id });
        },
        { url: `chrome-extension://${extensionId}/ui/popup.html`, id: windowId },
      );
      const popup = await opened;
      await popup.setViewportSize({ width: 60, height: 400 });
      const site = popup.locator("#site");
      await expect(site).toHaveText(where === "a site" ? "127.0.0.1" : "Not available on this page");

      const body = await popup.locator("body").boundingBox();
      expect(body?.x).toBe(0);
      expect(body?.width).toBe(320);
      // One line: the text is not wrapped, let alone mid-word.
      const lines = await site.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
      });
      expect(lines).toBe(1);
      const inside = async (locator: ReturnType<Page["locator"]>): Promise<void> => {
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      };
      await inside(site);
      await inside(popup.getByRole("button", { name: "Settings" }));
      if (where === "a site") {
        await expect(popup.locator("#site-controls")).toBeVisible();
        await inside(popup.getByRole("switch", { name: "On for 127.0.0.1" }));
        for (const option of ["Fill tab", "Custom size", "Pop out"]) {
          const label = popup.locator(".segmented label").filter({ hasText: option });
          await inside(label);
          // The option's text fits its segment: nothing is clipped.
          expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), option).toBe(true);
        }
      } else {
        await expect(popup.locator("#site-controls")).toBeHidden();
      }
      await popup.close();
    });
  }
});

test.describe("options page", () => {
  test("keyboard and labels: on/off, size choice with its fields, backdrop color, Esc; each saves", async ({
    serviceWorker,
    extensionId,
    page,
  }) => {
    await openOptions(page, extensionId);
    await expect(page).toHaveTitle("Full Window, Not Screen: Video Sizer settings");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Default size",
      "Backdrop color",
      "Esc exits",
      "Sites",
      "Keyboard shortcut",
      "About",
    ]);

    const enabled = page.getByRole("switch", { name: "On for all sites" });
    await enabled.focus();
    await page.keyboard.press("Space");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["enabled"]).toBe(false);
    await page.keyboard.press("Space");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["enabled"]).toBe(true);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: "Fill tab" })).toBeFocused();
    await expect(page.locator("#rect-fields")).toBeHidden();
    await expect(page.locator("#window-fields")).toBeHidden();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["mode"]).toBe("custom-rect");
    await expect(page.locator("#rect-fields")).toBeVisible();
    await expect(page.locator("#window-fields")).toBeHidden();
    await page.getByLabel("Width", { exact: true }).fill("640");
    await page.getByLabel("Width unit").selectOption("px");
    await page.getByLabel("Height", { exact: true }).fill("60");
    await page.getByLabel("Anchor").selectOption("bottom");
    await expect
      .poll(async () => (await storedGlobal(serviceWorker))["customRect"])
      .toEqual({ width: { value: 640, unit: "px" }, height: { value: 60, unit: "%" }, anchor: "bottom" });

    await page.getByRole("radio", { name: "Custom size" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["mode"]).toBe("pop-out");
    await expect(page.locator("#rect-fields")).toBeHidden();
    await page.getByLabel("Window width (px)").fill("1100");
    await page.getByLabel("Window height (px)").fill("700");
    await page.getByLabel("Window height (px)").press("Tab");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["windowSize"]).toEqual({ width: 1100, height: 700 });

    await page.getByLabel("Color around the video").fill("#406080");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["backgroundColor"]).toBe("#406080");

    const escape = page.getByRole("switch", { name: "Esc leaves fullscreen inside the tab" });
    await expect(escape).toBeChecked();
    await escape.focus();
    // "Saved" shows for 1.6 s; record every status text so a slow poll below cannot miss it.
    await page.evaluate(() => {
      const status = document.getElementById("status")!;
      const seen: string[] = [];
      (window as unknown as { __statusSeen: string[] }).__statusSeen = seen;
      new MutationObserver(() => seen.push(status.textContent ?? "")).observe(status, { childList: true, characterData: true, subtree: true });
    });
    await page.keyboard.press("Space");
    await expect.poll(async () => (await storedGlobal(serviceWorker))["exitOnEscape"]).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __statusSeen: string[] }).__statusSeen)).toContain("Saved");
  });

  test("Sites: filter and Delete; shortcut and About", async ({ serviceWorker, extensionId, page }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        "site:video.example": { mode: "custom-rect" },
        "site:news.example": { enabled: false },
      });
    });
    await openOptions(page, extensionId);
    const hosts = page.locator("#sites .host");
    await expect(hosts).toHaveText(["news.example", "video.example"]);
    await expect(page.locator("#sites")).toContainText("Off");

    const filter = page.getByRole("searchbox", { name: "Filter sites" });
    await filter.fill("video");
    await expect(hosts).toHaveText(["video.example"]);
    await filter.fill("zzz");
    await expect(hosts).toHaveCount(0);
    await expect(page.getByText("No matching sites.")).toBeVisible();
    await filter.fill("");

    const remove = page.getByRole("button", { name: "Delete settings for news.example" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => stored(serviceWorker, "site:news.example")).toBeUndefined();
    await expect(hosts).toHaveText(["video.example"]);

    await expect(page.locator("#shortcut")).not.toHaveText("");
    await expect(page.locator("#shortcut-line")).toContainText("switches between fullscreen inside the tab and real fullscreen.");
    await expect(page.getByRole("button", { name: "Change it in the browser's shortcuts page" })).toBeVisible();
    await expect(page.getByText("No data collected. No network requests.")).toBeVisible();
    await expect(page.locator("#credit")).toHaveText(/^Made by /);
  });
});

test.describe("demo player", () => {
  test("fills the tab, and the player's own controls keep working", async ({ context, page, origins }) => {
    await openFixture(page, `${origins.a}/demo-player.html`);
    await page.click("#fs");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("player");
    expect(await realFullscreenElement(context, page)).toBeNull();
    const viewport = await viewportOf(page);
    expect(await rectOf(page.locator("#player"))).toEqual({ left: 0, top: 0, width: viewport.width, height: viewport.height });

    await page.click("#play");
    await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
    expect(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).paused)).toBe(true);
    const bar = await rectOf(page.locator("#bar"));
    await page.mouse.click(bar.left + bar.width * 0.75, bar.top + bar.height / 2);
    await expect(page.locator("#time")).toHaveText(/^2:[23]\d \//); // 75 % of 3:20, give or take a frame

    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  });
});
