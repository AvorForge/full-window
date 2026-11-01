// Fixture origins for the end-to-end tests (docs/ARCHITECTURE.md §9). Every browser context answers requests to
// two origins, http://127.0.0.1:<p1> and http://localhost:<p2>, from tests/e2e/fixtures, so an <iframe> from one
// to the other is really cross-origin (and cross-site, so Chromium puts it in its own process).
// `__ORIGIN_A__` / `__ORIGIN_B__` in served text files are replaced by the two origins, so fixtures can embed
// each other.
//
// Playwright answers the requests itself (BrowserContext.route): no request opens a connection. A loopback
// HTTP server used to serve them, and on the Windows test host loopback connections sometimes timed out or were
// reset (net::ERR_CONNECTION_TIMED_OUT, net::ERR_CONNECTION_RESET) even to a server that answered the request
// before; a plain Node client saw every loopback port fail at once for seconds at a time. A frame whose load
// failed showed Chromium's error page, where no content script runs, and the test timed out waiting for it.
// Nothing listens on the two ports, so a request that escaped the routing would fail rather than reach a server.
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface Origins {
  /** http://127.0.0.1:<p1> */
  a: string;
  /** http://localhost:<p2> */
  b: string;
}

export const ORIGINS: Origins = { a: "http://127.0.0.1:41871", b: "http://localhost:41872" };

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The response for a request to one of the origins: the fixture file, with the origins filled in. */
export async function fixtureResponse(url: URL, origins: Origins = ORIGINS): Promise<FixtureResponse> {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const file = join(FIXTURES_DIR, relative);
  if (relative.split(sep).includes("..") || !file.startsWith(FIXTURES_DIR)) {
    return { status: 403, headers: {}, body: "" };
  }
  try {
    const body = (await readFile(file, "utf8")).replaceAll("__ORIGIN_A__", origins.a).replaceAll("__ORIGIN_B__", origins.b);
    return {
      status: 200,
      headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" },
      body,
    };
  } catch {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}

/** Answers every request the context's pages and frames make to the two origins. */
export async function routeFixtures(context: BrowserContext, origins: Origins = ORIGINS): Promise<void> {
  const served = new Set([origins.a, origins.b]);
  await context.route(
    (url) => served.has(url.origin),
    async (route) => {
      const response = await fixtureResponse(new URL(route.request().url()), origins);
      await route.fulfill(response);
    },
  );
}
