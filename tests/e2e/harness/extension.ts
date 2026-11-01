// Playwright fixtures for the end-to-end tests (docs/ARCHITECTURE.md §9): a fresh Chromium profile per test
// with the production build loaded as an unpacked extension, the extension's service worker, the fixtures' two
// origins (answered by Playwright, see harness/server.ts), and helpers that look at the browser from outside the
// page (CDP, the service worker, an isolated world the extension did not patch).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import { decodePng, hexToRgb, type Rgba } from "./png";
import { ORIGINS, routeFixtures, type Origins } from "./server";

export { expect };
export type { BrowserContext, Origins, Page, Worker };

export const BUILD_DIR = fileURLToPath(new URL("../../../build/", import.meta.url));

/** Outer size of the test window, on a desktop-sized screen (headless Chromium's default screen is 800 × 600). */
export const WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const SCREEN_SIZE = { width: 1920, height: 1080 } as const;

export interface LogEntry {
  type: string;
  time: number;
  fullscreenElement: string | null;
  webkitFullscreenElement: string | null;
  webkitCurrentFullScreenElement: string | null;
  fullscreen: boolean | undefined;
  webkitIsFullScreen: boolean | undefined;
  matchedFullscreen: string | null;
  [key: string]: unknown;
}

export interface WindowInfo {
  windowId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Fixtures {
  /**
   * Keep Chromium's back/forward cache on (Playwright switches it off by default with --disable-back-forward-cache),
   * for tests of pages restored from it.
   */
  backForwardCache: boolean;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  page: Page;
}

interface WorkerFixtures {
  origins: Origins;
}

async function launch(userDataDir: string, backForwardCache = false): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    ...(backForwardCache ? { ignoreDefaultArgs: ["--disable-back-forward-cache"] } : {}),
    // channel "chromium" is Chromium's new headless mode, which loads extensions; the default headless
    // binary (chromium-headless-shell) does not.
    channel: "chromium",
    headless: true,
    // The page's viewport follows the window, so pop-out and browser fullscreen change it as they
    // would for a user.
    viewport: null,
    args: [
      `--disable-extensions-except=${BUILD_DIR}`,
      `--load-extension=${BUILD_DIR}`,
      `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
      // The window must fit the screen: Chromium refuses chrome.windows bounds less than half on screen.
      `--screen-info={${SCREEN_SIZE.width}x${SCREEN_SIZE.height}}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
}

async function saveFailureArtifacts(context: BrowserContext, outputPath: (name: string) => string): Promise<void> {
  const pages = context.pages();
  for (const [index, page] of pages.entries()) {
    try {
      await page.screenshot({ path: outputPath(`page-${index}.png`), timeout: 5_000 });
    } catch {
      // A closed or hung page has no screenshot.
    }
    const logs: Record<string, unknown> = {};
    for (const frame of page.frames()) {
      try {
        logs[frame.url()] = await frame.evaluate(() => (window as unknown as { __log?: unknown }).__log ?? null);
      } catch (error) {
        logs[frame.url()] = `unavailable: ${String(error)}`;
      }
    }
    await writeFile(outputPath(`page-${index}-log.json`), JSON.stringify(logs, null, 2));
  }
}

// ---------------------------------------------------------------------------------------------------------
// The extension's service worker
// ---------------------------------------------------------------------------------------------------------

/**
 * How long readyServiceWorker waits, from launch, for the extension's worker to appear and for
 * runtime.onInstalled to store the default settings (on a loaded host the first write takes several seconds).
 */
export const SERVICE_WORKER_TIMEOUT = 15_000;

const isExtensionWorker = (url: string): boolean => url.startsWith("chrome-extension://");

/** The newest extension worker Playwright knows of: a worker that restarted on a new target replaces the old one. */
function currentWorker(context: BrowserContext): Worker | undefined {
  return context.serviceWorkers().filter((worker) => isExtensionWorker(worker.url())).at(-1);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface WorkerVersion {
  versionId: string;
  scriptURL: string;
  runningStatus: string;
  status: string;
}

interface WorkerTargets {
  /** Extension service-worker targets in the browser (CDP Target.getTargets). */
  targets: Array<{ url: string; attached: boolean }>;
  /** The extension's service-worker versions (CDP ServiceWorker domain): running status and lifecycle state. */
  versions: WorkerVersion[];
  scopes: string[];
}

/**
 * What the browser itself reports about extension service workers, over a CDP session on a page (best effort).
 * With `wake`, a stopped worker is started again: it only starts for an event, and an evaluate sent to it waits
 * until it does.
 */
async function inspectWorkers(context: BrowserContext, wake = false): Promise<WorkerTargets | string> {
  const page = context.pages()[0];
  if (!page) return "no page to open a CDP session on";
  const read = async (): Promise<WorkerTargets> => {
    const session = await context.newCDPSession(page);
    try {
      const { targetInfos } = await session.send("Target.getTargets");
      const result: WorkerTargets = {
        targets: targetInfos
          .filter((target) => target.type === "service_worker" && isExtensionWorker(target.url))
          .map((target) => ({ url: target.url, attached: target.attached })),
        versions: [],
        scopes: [],
      };
      // ServiceWorker.enable reports every registration and version at once.
      session.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        for (const registration of registrations) {
          if (isExtensionWorker(registration.scopeURL) && !registration.isDeleted) result.scopes.push(registration.scopeURL);
        }
      });
      session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        for (const version of versions) {
          if (!isExtensionWorker(version.scriptURL)) continue;
          result.versions = result.versions.filter((known) => known.versionId !== version.versionId);
          result.versions.push(version);
        }
      });
      await session.send("ServiceWorker.enable");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (wake && result.versions.some((version) => version.runningStatus === "stopped")) {
        for (const scopeURL of result.scopes) await session.send("ServiceWorker.startWorker", { scopeURL });
      }
      return result;
    } finally {
      await session.detach().catch(() => undefined);
    }
  };
  return withTimeout(
    read().catch((error: unknown) => `CDP unavailable: ${String(error)}`),
    3_000,
    "CDP did not answer within 3 s",
  );
}

function describeWorkers(context: BrowserContext, browser: WorkerTargets | string): string {
  const known = context.serviceWorkers().map((worker) => worker.url());
  const playwright = `Playwright reports ${known.length === 0 ? "no service worker" : known.join(", ")}`;
  if (typeof browser === "string") return `${playwright}; browser state unknown (${browser})`;
  if (browser.targets.length === 0 && browser.versions.length === 0) {
    return `no extension service worker target exists in the browser; ${playwright}`;
  }
  const targets = browser.targets.map((target) => `${target.url} (${target.attached ? "attached" : "not attached"})`);
  const versions = browser.versions.map(
    (version) => `${version.scriptURL} version ${version.versionId} ${version.runningStatus}, ${version.status}`,
  );
  return (
    `extension service worker target ${targets.length > 0 ? targets.join(", ") : "none"}; ` +
    `worker state ${versions.length > 0 ? versions.join("; ") : "unknown (no version reported)"}; ${playwright}`
  );
}

/**
 * The extension's service worker, once it answers and runtime.onInstalled stored the default settings (so a
 * test's own write is not raced). Race-free: it listens for the worker before looking for one, and every poll
 * takes the newest worker Playwright knows of, so a worker that attaches meanwhile or is replaced is found. An
 * evaluate that is slow to answer is not abandoned, but a newer worker is tried alongside it. Gives up after
 * `timeout` ms with an error that starts "service worker not ready:" and says what the browser reports.
 */
export async function readyServiceWorker(context: BrowserContext, timeout = SERVICE_WORKER_TIMEOUT): Promise<Worker> {
  const started = Date.now();
  const deadline = started + timeout;
  let wakeUp: () => void = () => undefined;
  const onWorker = (): void => wakeUp();
  context.on("serviceworker", onWorker);
  try {
    // One evaluate in flight per Worker object; its last outcome is kept for the error.
    const pending = new Map<Worker, Promise<void>>();
    const outcomes = new Map<Worker, string>();
    let ready: Worker | undefined;
    let lastWake = 0;
    const check = (worker: Worker): void => {
      if (pending.has(worker)) return;
      const asked = Date.now();
      outcomes.set(worker, "evaluate sent, no answer yet");
      pending.set(
        worker,
        worker
          .evaluate(async () => (await chrome.storage.sync.get("settings"))["settings"] !== undefined)
          .then(
            (stored) => {
              outcomes.set(worker, stored ? "ready" : `answered after ${Date.now() - asked} ms, settings not stored yet`);
              if (!stored) return;
              ready ??= worker;
              wakeUp();
            },
            (error: unknown) => {
              outcomes.set(worker, `evaluate failed: ${String(error).split("\n")[0]}`);
            },
          )
          .finally(() => pending.delete(worker)),
      );
    };
    while (!ready && Date.now() < deadline) {
      const worker = currentWorker(context);
      if (worker) check(worker);
      const tick = new Promise<void>((resolve) => {
        wakeUp = resolve;
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
      });
      await tick;
      // An evaluate unanswered for a second may be waiting on a stopped worker.
      if (!ready && worker && pending.has(worker) && Date.now() - lastWake > 1_000) {
        lastWake = Date.now();
        await inspectWorkers(context, true);
      }
    }
    if (ready) return ready;
    const worker = currentWorker(context);
    let last = worker ? (outcomes.get(worker) ?? "never evaluated") : "no extension worker to evaluate";
    if (last.includes("Execution context was destroyed")) {
      // Playwright binds a service worker's first execution context only (CRServiceWorker in playwright-core).
      last += " (the worker stopped and started again on the same target; Playwright's Worker keeps its first, destroyed context)";
    }
    throw new Error(
      `service worker not ready: ${describeWorkers(context, await inspectWorkers(context))}; ` +
        `last check of the current worker: ${last}; waited ${Date.now() - started} ms`,
    );
  } finally {
    context.off("serviceworker", onWorker);
  }
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  origins: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(ORIGINS);
    },
    { scope: "worker" },
  ],

  backForwardCache: [false, { option: true }],

  context: async ({ origins, backForwardCache }, use, testInfo) => {
    const userDataDir = await mkdtemp(join(tmpdir(), "cfs-e2e-"));
    const context = await launch(userDataDir, backForwardCache);
    await routeFixtures(context, origins);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    try {
      await use(context);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await saveFailureArtifacts(context, (name) => testInfo.outputPath(name));
        await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
      } else {
        await context.tracing.stop();
      }
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  serviceWorker: async ({ context }, use) => {
    await use(await readyServiceWorker(context));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  page: async ({ context, serviceWorker }, use) => {
    void serviceWorker;
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

// ---------------------------------------------------------------------------------------------------------
// Pages and fixtures
// ---------------------------------------------------------------------------------------------------------

type Target = Page | Frame;

/**
 * How long openFixture waits for the page and its frames to become ready, well inside the 45 s test timeout so
 * that a frame that never does is reported by waitForFixture instead of by the test timeout.
 */
export const FIXTURE_TIMEOUT = 20_000;

interface FixtureState {
  url: string;
  readyState: string;
  ready: boolean;
  mainWorld: boolean;
  channelConsumed: boolean;
  channelAttribute: string | null;
}

async function fixtureState(target: Target): Promise<FixtureState | string> {
  const probe = target.evaluate((): FixtureState => {
    const win = window as unknown as Record<string | symbol, unknown>;
    const channel = document.documentElement.getAttribute("data-cfs-channel");
    return {
      url: location.href,
      readyState: document.readyState,
      ready: win["__ready"] === true,
      mainWorld: win[Symbol.for("custom-full-screen.main-world")] === true,
      channelConsumed: channel === null,
      channelAttribute: channel,
    };
  });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("the frame did not answer within 3 s"), 3_000));
  return Promise.race([probe, timeout]).catch((error: unknown) => `the frame could not be evaluated: ${String(error)}`);
}

/** The frame's URL as Playwright knows it and, for an <iframe>, its src (an error page has lost the URL it failed on). */
async function describeFrame(target: Target): Promise<string> {
  const frame = "mainFrame" in target ? target.mainFrame() : target;
  const parts = [`Playwright frame URL ${frame.url()}`];
  if (frame.parentFrame()) {
    const src = frame
      .frameElement()
      .then((element) => element.getAttribute("src"))
      .catch(() => null);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));
    parts.push(`iframe src ${(await Promise.race([src, timeout])) ?? "unknown"}`);
  }
  return parts.join(", ");
}

/**
 * Wait until both content scripts ran in the frame and the fixture's own script finished. Gives up after
 * `timeout` ms with an error that starts "fixture not ready:" and says which of the three conditions failed.
 */
export async function waitForFixture(target: Target, timeout = FIXTURE_TIMEOUT): Promise<void> {
  try {
    await target.waitForFunction(
      () => {
        const win = window as unknown as Record<string | symbol, unknown>;
        return (
          win["__ready"] === true &&
          win[Symbol.for("custom-full-screen.main-world")] === true &&
          !document.documentElement.hasAttribute("data-cfs-channel")
        );
      },
      undefined,
      { timeout },
    );
  } catch (error) {
    const frameUrl = await describeFrame(target);
    const state = await fixtureState(target);
    if (typeof state === "string") {
      throw new Error(`fixture not ready: ${frameUrl} after ${timeout} ms; ${state}`, { cause: error });
    }
    const failing = [
      state.ready ? null : "window.__ready !== true (the fixture's own script did not finish)",
      state.mainWorld ? null : "the MAIN-world content script did not run",
      state.channelConsumed
        ? null
        : `data-cfs-channel is still on <html> (${state.channelAttribute}): the MAIN <-> ISOLATED handshake did not finish`,
    ].filter((condition): condition is string => condition !== null);
    throw new Error(
      `fixture not ready: ${state.url} (${frameUrl}) after ${timeout} ms; ` +
        `document.readyState ${state.readyState} (${state.readyState === "complete" ? "finished loading" : "not finished loading"}); ` +
        `failing: ${failing.length > 0 ? failing.join("; ") : "none now (it became ready just after the timeout)"}`,
      { cause: error },
    );
  }
}

export async function openFixture(page: Page, url: string): Promise<void> {
  // One deadline for the whole load. The frames are checked before the load event is awaited, so a frame that
  // never becomes ready is reported by waitForFixture, not by page.goto timing out.
  const deadline = Date.now() + FIXTURE_TIMEOUT;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());
  await page.goto(url, { waitUntil: "commit", timeout: FIXTURE_TIMEOUT });
  await page.bringToFront();
  // Playwright runs every evaluate, waitForFixture's too, with a user gesture: one that reached the document
  // while it was still parsing gave its scripts transient user activation, and a request on load succeeded.
  // So nothing is evaluated in it before DOMContentLoaded (after its parser-inserted scripts ran); a document
  // that never gets there is reported by waitForFixture below.
  await page.waitForLoadState("domcontentloaded", { timeout: remaining() }).catch(() => undefined);
  await waitForFixture(page, remaining());
  // A ready document has parsed its <iframe>s, so their frames are attached: walk down the tree level by level.
  const frames = page.mainFrame().childFrames();
  for (const frame of frames) {
    await waitForFixture(frame, remaining());
    frames.push(...frame.childFrames());
  }
  await page.waitForLoadState("load", { timeout: remaining() });
  // The ISOLATED script pushes the settings asynchronously after document_start; give it a moment so a
  // request is not held waiting for them (it would still be handled, after up to 250 ms).
  await page.waitForTimeout(250);
}

export async function readLog(target: Target): Promise<LogEntry[]> {
  return target.evaluate(() => (window as unknown as { __log: LogEntry[] }).__log.slice());
}

export async function clearLog(target: Target): Promise<void> {
  await target.evaluate(() => {
    (window as unknown as { __log: LogEntry[] }).__log.length = 0;
  });
}

export function types(log: LogEntry[], wanted?: readonly string[]): string[] {
  return log.map((entry) => entry.type).filter((type) => !wanted || wanted.includes(type));
}

export const FULLSCREEN_EVENTS = [
  "fullscreenchange",
  "fullscreenerror",
  "webkitfullscreenchange",
  "webkitfullscreenerror",
] as const;

export async function getters(target: Target): Promise<Omit<LogEntry, "type" | "time">> {
  return target.evaluate(() => (window as unknown as { CFS: { getters(): Omit<LogEntry, "type" | "time"> } }).CFS.getters());
}

export async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

/**
 * An element's box on screen, as the browser lays it out (Playwright measures it over CDP). While a document
 * root is scaled onto a custom rectangle the page's own getBoundingClientRect() reports the root's unscaled
 * space instead (docs/ARCHITECTURE.md §3), so screen geometry is taken from here.
 */
export async function screenRectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

/**
 * The topmost element at a screen point, from an isolated world the extension did not patch: its id or tag, or
 * "backdrop" for the backdrop or one of its strips.
 */
export async function hitAtScreen(context: BrowserContext, page: Page, x: number, y: number): Promise<string | null> {
  return evaluateUnpatched<string | null>(
    context,
    page,
    `(() => { const hit = document.elementFromPoint(${x}, ${y}); if (!hit) return null; return hit.closest("[data-cfs-backdrop]") ? "backdrop" : hit.id || hit.localName; })()`,
  );
}

export async function viewportOf(target: Target): Promise<{ width: number; height: number }> {
  return target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

/**
 * The `style` attribute of the element and of every shadow-including ancestor, plus any data-cfs-* marker
 * left on them, so a test can compare the state before fullscreen with the state after exit.
 */
export async function styleChain(locator: Locator): Promise<Array<{ node: string; style: string | null; markers: string[] }>> {
  return locator.evaluate((element) => {
    const chain: Array<{ node: string; style: string | null; markers: string[] }> = [];
    let node: Element | null = element;
    while (node) {
      chain.push({
        node: node.id ? `#${node.id}` : node.localName,
        style: node.getAttribute("style"),
        markers: node.getAttributeNames().filter((name) => name.startsWith("data-cfs")),
      });
      if (node.parentElement) node = node.parentElement;
      else {
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return chain;
  });
}

export async function backdropCount(target: Target): Promise<number> {
  return target.evaluate(() => document.querySelectorAll("[data-cfs-backdrop]").length);
}

// ---------------------------------------------------------------------------------------------------------
// The browser seen from outside the page
// ---------------------------------------------------------------------------------------------------------

async function withSession<T>(context: BrowserContext, target: Target, run: (session: CDPSession) => Promise<T>): Promise<T> {
  const session = await context.newCDPSession(target);
  try {
    return await run(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** CDP Browser.getWindowForTarget: the window id (the same id chrome.windows uses), bounds and state. */
export async function windowOf(context: BrowserContext, page: Page): Promise<WindowInfo> {
  return withSession(context, page, async (session) => {
    const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
    return {
      windowId,
      left: bounds.left ?? 0,
      top: bounds.top ?? 0,
      width: bounds.width ?? 0,
      height: bounds.height ?? 0,
      windowState: bounds.windowState ?? "normal",
    };
  });
}

/**
 * The window's outer width minus its viewport's: 0 in headless Chromium on Linux and macOS, the native window
 * frame on Windows (16 px). Tests that compare the viewport with window bounds take it off.
 */
export async function frameWidthOf(context: BrowserContext, page: Page): Promise<number> {
  const { width } = await windowOf(context, page);
  return width - (await viewportOf(page)).width;
}

/** CDP Browser.getWindowBounds for a window id. */
export async function boundsOf(context: BrowserContext, page: Page, windowId: number): Promise<Omit<WindowInfo, "windowId">> {
  return withSession(context, page, async (session) => {
    const { bounds } = await session.send("Browser.getWindowBounds", { windowId });
    return {
      left: bounds.left ?? 0,
      top: bounds.top ?? 0,
      width: bounds.width ?? 0,
      height: bounds.height ?? 0,
      windowState: bounds.windowState ?? "normal",
    };
  });
}

/**
 * The document's real fullscreen element, read in a fresh isolated world: its prototypes are not the page's,
 * so the extension's MAIN-world replacements cannot answer. `null` unless the browser really is fullscreen.
 * Works for the main frame and for out-of-process (cross-site) frames.
 */
export async function realFullscreenElement(context: BrowserContext, target: Target): Promise<string | null> {
  return withSession(context, target, async (session) => {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "cfs-e2e-probe",
    });
    const { result } = await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression:
        "(() => { const el = document.fullscreenElement; return el ? (el.id ? '#' + el.id : el.localName) : null; })()",
    });
    return (result.value as string | null) ?? null;
  });
}

/** Evaluate an expression in an unpatched isolated world of the page (for comparing natives). */
export async function evaluateUnpatched<T>(context: BrowserContext, page: Page, expression: string): Promise<T> {
  return withSession(context, page, async (session) => {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "cfs-e2e-natives",
    });
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value as T;
  });
}

/** The tab id (chrome.tabs) of a page: the active tab of its window after bringing it to the front. */
export async function tabIdOf(context: BrowserContext, worker: Worker, page: Page): Promise<number> {
  await page.bringToFront();
  const { windowId } = await windowOf(context, page);
  return worker.evaluate(async (id) => {
    const [tab] = await chrome.tabs.query({ windowId: id, active: true });
    if (tab?.id === undefined) throw new Error("no active tab");
    return tab.id;
  }, windowId);
}

/** One pixel of the page's rendering, in CSS pixels. */
export async function pixelAt(page: Page, x: number, y: number): Promise<Rgba> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: "allow", scale: "css" });
  return decodePng(png).pixel(0, 0);
}

export function expectColour(actual: Rgba, hex: string, tolerance = 2): void {
  const expected = hexToRgb(hex);
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= tolerance;
  expect(
    close(actual.r, expected.r) && close(actual.g, expected.g) && close(actual.b, expected.b),
    `pixel rgb(${actual.r}, ${actual.g}, ${actual.b}) should be ${hex}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------
// Settings through the extension's own pages
// ---------------------------------------------------------------------------------------------------------

export interface OptionsInput {
  enabled?: boolean;
  mode?: "fill-tab" | "custom-rect" | "pop-out";
  rect?: { width: number; widthUnit: "px" | "%"; height: number; heightUnit: "px" | "%"; anchor: string };
  windowSize?: { width: number; height: number };
  backgroundColor?: string;
  exitOnEscape?: boolean;
}

/**
 * Set the global settings through the options page, as a user would, and wait until they are stored.
 * The options page saves on every `change`. It is opened in its own tab, which is closed again.
 */
export async function setOptions(context: BrowserContext, worker: Worker, extensionId: string, input: OptionsInput): Promise<void> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/ui/options.html`);
  await expect(options.locator("#window-width")).not.toHaveValue("");
  if (input.enabled !== undefined) await options.locator("#enabled").setChecked(input.enabled);
  if (input.mode) await options.locator(`input[name="mode"][value="${input.mode}"]`).check();
  if (input.rect) {
    await options.locator("#rect-width-unit").selectOption(input.rect.widthUnit);
    await options.locator("#rect-width").fill(String(input.rect.width));
    await options.locator("#rect-height-unit").selectOption(input.rect.heightUnit);
    await options.locator("#rect-height").fill(String(input.rect.height));
    await options.locator("#rect-anchor").selectOption(input.rect.anchor);
  }
  if (input.windowSize) {
    await options.locator("#window-width").fill(String(input.windowSize.width));
    await options.locator("#window-height").fill(String(input.windowSize.height));
  }
  if (input.backgroundColor) await options.locator("#background").fill(input.backgroundColor);
  if (input.exitOnEscape !== undefined) await options.locator("#exit-on-escape").setChecked(input.exitOnEscape);
  // Leave the last field so its change event fires, then wait for the stored document to match (saving
  // takes longer than expect's default 5 s on a loaded host).
  await options.locator("h1").click();
  await expect
    .poll(async () => {
      const stored = await worker.evaluate(async () => (await chrome.storage.sync.get("settings"))["settings"]);
      const global = (stored as { global?: Record<string, unknown> } | undefined)?.global ?? {};
      const rect = global["customRect"] as { width: { value: number; unit: string }; height: { value: number; unit: string }; anchor: string } | undefined;
      const size = global["windowSize"] as { width: number; height: number } | undefined;
      return (
        (input.enabled === undefined || global["enabled"] === input.enabled) &&
        (input.mode === undefined || global["mode"] === input.mode) &&
        (input.rect === undefined ||
          (rect?.width.value === input.rect.width &&
            rect.width.unit === input.rect.widthUnit &&
            rect.height.value === input.rect.height &&
            rect.height.unit === input.rect.heightUnit &&
            rect.anchor === input.rect.anchor)) &&
        (input.windowSize === undefined ||
          (size?.width === input.windowSize.width && size.height === input.windowSize.height)) &&
        (input.backgroundColor === undefined || global["backgroundColor"] === input.backgroundColor.toLowerCase()) &&
        (input.exitOnEscape === undefined || global["exitOnEscape"] === input.exitOnEscape)
      );
    }, { timeout: 15_000 })
    .toBe(true);
  await options.close();
}

/**
 * Open the toolbar popup for the tab of `page`. A popup cannot be opened by Playwright, so popup.html is
 * opened in a background tab of the same window: its `tabs.query({ active, currentWindow })` then finds the
 * fixture tab, exactly as the real popup does. Returns the popup page once it shows the site.
 */
export async function openPopupFor(context: BrowserContext, worker: Worker, extensionId: string, page: Page): Promise<Page> {
  await page.bringToFront();
  const { windowId } = await windowOf(context, page);
  const opened = context.waitForEvent("page");
  await worker.evaluate(
    async ({ url, id }) => {
      await chrome.tabs.create({ url, active: false, windowId: id });
    },
    { url: `chrome-extension://${extensionId}/ui/popup.html`, id: windowId },
  );
  const popup = await opened;
  await popup.waitForLoadState();
  await expect(popup.locator("#site-controls")).toBeVisible();
  return popup;
}
