# Full Window, Not Screen: Video Sizer

A Chromium (Chrome / Edge) Manifest V3 extension that keeps page fullscreen requests inside the tab, at a size
you choose. Published on the Chrome Web Store and Microsoft Edge Add-ons as **Full Window, Not Screen: Video
Sizer**; the repository and npm package are named `full-window`.

When a page asks for fullscreen (usually a video player), the extension intercepts the request. The browser does
not enter real fullscreen. Instead the element is pinned to a rectangle you choose, and the page still believes
it is fullscreen:

- **Fill tab**: the video covers the tab's page area (default).
- **Custom size**: a width × height in px or % of the tab, placed by an anchor (center by default).
- **Pop out**: the tab moves into its own small window with no tabs or toolbar, and the video fills it. A
  placeholder tab ("Popped out: …", with a **Bring it back** button) keeps its place; when you leave, the tab goes
  back wherever the placeholder is then. Closing the small window loads the page again in the placeholder, so the
  tab is never lost. The next pop-out opens where you left the last one. Move the pointer over the small window
  for a bar with **Pop back in**, **Full screen** (the video fills the screen; **Exit full screen** or Esc goes
  back to the small window) and **Minimize**, and a grip in the bottom-right corner to resize it by dragging.
  The window keeps Chrome's own title bar (an extension can't remove it); its close button pops the video back
  in, as above.

Esc leaves custom fullscreen. A keyboard shortcut (default Alt+Shift+F, changeable at
`chrome://extensions/shortcuts`) switches between custom and real fullscreen. Settings are global, with per-site
overrides set from the toolbar popup. No telemetry, no network requests, no accounts or API keys. Settings stay
in your browser profile (`chrome.storage.sync`).

> Status: 1.0.0: the Fullscreen API shim, embeds in frames, pop-out mode, the toggle shortcut, the popup
> and the options page. The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The unit tests run with
> `npm run validate`, the end-to-end tests in Chromium with `npm run test:e2e`. The store listing, privacy
> policy, product page and images are in [`store/`](store/).

## Using it

When a video player (or any page) asks for fullscreen, the video is pinned to your chosen size instead and the
page behaves as if it were fullscreen. **Esc** leaves (unless you turned that off). Embedded players work too: a
YouTube embed on example.com fills the size you chose for example.com.

### Toolbar popup (this site)

Click the extension's toolbar icon on a page:

- The site's name with an **on/off switch**: off means fullscreen requests on this site go to the browser's real
  fullscreen. The line under the name says what fullscreen does in this tab now (inside the tab, real fullscreen
  after the shortcut, or off for the site) and whether it is active right now.
- **Size**: *Fill tab*, *Custom size* or *Pop out*. Choosing the size the site gets anyway (the default)
  stores nothing, so the site keeps following the default.
- For **Custom size**: width and height, each in **%** of the tab or **px**, and the **anchor** (center, a corner
  or an edge) where the rectangle sits.
- For **Pop out**: the **outer** width × height of the pop-out window in px, including its title bar, so the
  video area is a little smaller.
- One line with the real-fullscreen shortcut, **Reset this site** (only when the site has its own settings) and
  **Settings**.

Every change is saved immediately as this site's override and also applies to its subdomains. **Reset this
site** drops the override. Settings you do not change keep following the defaults.

### Options page (defaults for every site)

Open it with **Settings** in the popup, or from the extension's card at `chrome://extensions`:

- **Default size**: whether fullscreen requests are intercepted at all (*On for all sites*), the size, and the
  custom width/height/anchor or the outer window width × height (only the chosen size's fields show);
- **Backdrop color**: what fills the tab outside a custom-size rectangle;
- **Esc exits**: whether Esc leaves custom fullscreen;
- **Sites**: the sites with their own settings (set from the popup), with a filter box and **Delete**;
- **Keyboard shortcut**: the current key and a button that opens the browser's shortcuts page
  (`chrome://extensions/shortcuts`, or `edge://extensions/shortcuts` in Edge);
- **About**: the version, the privacy facts, the credit, and **Reset all settings**.

Both pages follow the system's light or dark theme: black on a white page, or white on a black one, with no other
color. The chosen size and the switches that are on are drawn in black (light) or white (dark).

### The Alt+Shift+F toggle

The shortcut (default **Alt+Shift+F**; change it at `chrome://extensions/shortcuts`, or in Edge at
`edge://extensions/shortcuts`) switches between custom and real fullscreen:

- **During custom fullscreen**: the browser window goes fullscreen (like F11) and the video fills it. Press it
  again to return to your custom size and the previous window state. (A browser shortcut cannot start the
  page's own real fullscreen, which needs a click in the page, so this uses the window instead.)
- **Otherwise**: it arms **real** fullscreen for this tab: the next time the page asks for fullscreen, the
  browser's real fullscreen is used. Press it again to arm custom fullscreen again. The popup shows what is
  armed; the choice lasts until you toggle again or close the tab.

Switching to another tab gives the window back (from *Resize the window* or the toggle's window fullscreen);
the video stays pinned in its tab.

## Tested sites

Tested live on 2026-10-25 with this version, signed out, in Chromium 145 (headless, Windows), with the default
fill-tab size and with an 80 % × 80 % custom size. On each site the site's own fullscreen button (or shortcut) was
used, then the player's own controls and keyboard shortcuts were exercised in custom fullscreen and compared with
the browser's real fullscreen on the same page: play/pause, clicking the video, seeking by click and drag, mute and
volume, captions, the settings/quality menu, double-click, the player's exit button, Esc, and the controls hiding
and coming back. Details per site and check, and the two layout bugs this run found and fixed (YouTube's seek bar
and Twitch's player in a custom size), are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8 "Site notes".

| Site | Custom fullscreen with the player's own controls |
| ---- | ------------------------------------------------ |
| YouTube watch page | Works, both sizes |
| YouTube embed (on another site) | Works, both sizes (entered with the player's `f` shortcut: the embed showed no controls in the test browser) |
| Twitch live channel, VOD, and embed | Works, both sizes |
| Kick live channel | Works, both sizes |
| Facebook public video | Works, both sizes |
| Streamable | Works, both sizes |
| LinkedIn public video post | Works, both sizes (some of its controls could not be exercised, see §8) |
| X, Reddit, Rumble, Vimeo, Dailymotion, TikTok | Not tested: they blocked the automated test browser (bot check, access denied or login wall) or would not play in it |
| Instagram reels | Nothing to test: the reel player has no fullscreen button |
| Netflix, Prime Video, Disney+, Max, Hulu | Not tested: they need an account (and DRM) |

## Requirements

- Node.js 20 or newer (`.nvmrc` pins the version used for development), npm
- Chrome or Edge 111 or newer

## Build

```sh
npm ci             # install exactly what package-lock.json pins
npm run build      # production bundle into build/ (an unpacked extension)
```

| Script               | What it does                                                               |
| -------------------- | -------------------------------------------------------------------------- |
| `npm run build`      | Bundle every entry point with esbuild into `build/`, copy `manifest.json`, pages, font and icons, validate the result |
| `npm run build:dev`  | Same, unminified with inline source maps                                   |
| `npm run type-check` | `tsc` in strict mode over `src/`, `tests/` (including the e2e tests) and the build scripts |
| `npm test`           | Unit tests (vitest; happy-dom for DOM code)                               |
| `npm run validate`   | `type-check` + `test`: the gate that needs no browser (the tests also run the production build, validate `build/` and zip it) |
| `npm run test:e2e`   | End-to-end tests: the built extension loaded in headless Chromium (Playwright), see below |
| `npm run test:all`   | `validate`, then `test:e2e`                                                |
| `npm run package`    | Build, then zip `build/` into `dist/<name>-<version>.zip` (named from `brand.ts` and `package.json`, e.g. `dist/full-window-not-screen-video-sizer-1.0.0.zip`) |
| `npm run store:assets` | Render the Edge store logo `store/edge-logo-300x300.png` from the ON icon with Playwright's Chromium (see below) |
| `npm run icons`      | Re-render the icon PNGs in `src/icons/` from their SVG sources with Playwright's Chromium (`-- --check` compares instead) |

## Name and brand

The product name, the short name, the one-line description, the credit line and the support contact are in
`src/shared/brand.ts`. The build writes them into `build/manifest.json` (`name`, `short_name` from the short name,
`description`, `action.default_title`) and the pages' titles (`%BRAND_NAME%` in `src/ui/*.html`); the version
comes from `package.json`. The source `manifest.json` does not set these keys, so renaming the extension is a
change to `brand.ts` (plus the store copy in `store/`).

The ON icon is design 5b from icon round 8, used as delivered; the OFF icon is option A from round 9 (a small
video in the window). Its SVG sources are in `src/icons/svg/`, and the PNGs
the extension ships are committed in `src/icons/`. The build copies them; `npm run icons` re-renders them with
Playwright's Chromium. ON (`icon-{16,32,48,128}.png`) is the store, install and extensions-page icon. OFF
(`icon-off-{16,32}.png`) is the toolbar's default. A page's top frame tells the service worker whether the
extension is on for its site, and the service worker shows ON or OFF for that tab (`chrome.action.setIcon`, no
extra permission).

## Store kit

`store/` holds what the Chrome Web Store and Microsoft Edge Add-ons ask for:

- `listing.md`: title, short and long description, single-purpose statement, permission justifications, the
  privacy answers and the Edge fields;
- `privacy.html`: the privacy policy as a plain page, ready to host (the same text as `site/privacy.html`);
- `site/`: the product page, live at https://avorforge.com/full-window/ at launch: `index.html`,
  `privacy.html` (the privacy policy styled like the page), `styles.css`, `script.js`, `fonts/inter.woff2` and
  `assets/` (its images, the hero video and the Open Graph image). It loads nothing from another origin;
- `screenshots/`: six 1280 × 800 screenshots. The Chrome Web Store takes five, so Chrome gets 1-5 and Microsoft
  Edge Add-ons all six;
- `promo-tile-440x280.png` (both stores), `marquee-1400x560.png` (Chrome's marquee promo tile) and
  `edge-logo-300x300.png` (Edge's store logo).

The screenshots, the promo tile, the marquee and the product page are designed assets: made outside the repo
from real Chrome captures and approved by the owner, so they are committed as files and nothing here
regenerates them. To change one, replace the file with a new approved one. `npm run store:assets` only renders
the Edge logo from the ON icon's master SVG, with the Chromium that `@playwright/test` pins (or the browser at
`PW_TEST_CONNECT_WS_ENDPOINT`; it never downloads browsers). Like `npm run icons`, it gives the committed logo's
exact bytes only on the host that rendered it: antialiasing and gradient dithering differ a little between hosts.

## End-to-end tests

The end-to-end tests load the production build into a real headless Chromium and drive fixture pages served
on two local origins, `http://127.0.0.1:<port>` and `http://localhost:<port>`, so the embeds are really
cross-origin. They cover fill-tab and custom sizes, Esc, cross-origin frames, window resizing, the per-site
switch in the popup and the toggle. Nothing touches the network; the test video is drawn on a canvas.

```sh
npm ci
npx playwright install chromium   # once, unless PLAYWRIGHT_BROWSERS_PATH already points at a matching build
npm run test:e2e                  # builds build/ first, then runs tests/e2e/*.spec.ts
npm run test:e2e -- tests/e2e/frames.spec.ts   # one file
npm run test:e2e -- -g "pop-out"         # tests whose title matches
npm run test:all                  # npm run validate, then npm run test:e2e
```

- Each test starts its own Chromium with a fresh profile and the extension loaded
  (`--load-extension=build/`, new headless mode via `channel: "chromium"`).
- When a test fails, `test-results/<test>/` (gitignored) keeps:
  - a screenshot of every page;
  - a Playwright trace (`npx playwright show-trace test-results/<test>/trace.zip`);
  - `page-<n>-log.json` with each frame's `window.__log`, the fixtures' record of requests, events and getter
    values.
- `npm run validate` does not run these tests, because they need a Chromium download.
- Run `validate` and `test:e2e` one after the other, not side by side: both rebuild `build/`.

[`docs/ARCHITECTURE.md` §9](docs/ARCHITECTURE.md) lists the fixtures and what each test asserts.

## Load it unpacked

**Chrome**

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `build/` folder.
5. Optional: pin the extension from the puzzle-piece menu, and change the shortcut at `chrome://extensions/shortcuts`.

**Edge**

1. Run `npm run build`.
2. Open `edge://extensions`.
3. Turn on **Developer mode** (left sidebar).
4. Click **Load unpacked** and select the `build/` folder.

After rebuilding, click the reload icon on the extension's card, then reload the pages you test on. Content
scripts are injected at page load.

## Layout

```
manifest.json               source manifest (paths relative to build/); copied by the build
src/background/             service worker (module): settings migration, shortcut, window resizing,
                            browser fullscreen for the toggle, per-tab armed mode
src/content/main-world.ts   MAIN-world script: installs the Fullscreen API patch layer
src/content/fullscreenLayer.ts, styling.ts, selectors.ts, natives.ts
                            the patch layer: fake fullscreen state and events, pinning and stylesheets,
                            :fullscreen rewriting, captured originals and the native-looking disguise
src/content/isolated.ts     ISOLATED-world script (logic in isolatedController.ts): settings, popup replies,
                            frame relay, Esc, pop-out and toggle messages; popOutBar.ts draws the pop-out
                            window's hover bar and resize grip
src/shared/                 settings schema + resolveForSite, typed messages, geometry
src/shared/brand.ts         product name, short name, description, credit and support contact (the build writes them into the manifest)
src/ui/                     popup, options and pop-out placeholder (poppedOut.html) pages; ui.css styles them
src/ui/fonts/               Inter, the pages' font (inter.woff2), and its license (OFL.txt)
src/icons/                  the icon PNGs the build copies (ON, and OFF for the toolbar default); svg/ holds their sources
scripts/                    build, package, manifest validation, icon rendering (npm run icons), the Edge store logo
store/                      store listing, privacy policy, product page (site/), screenshots, promo tile, marquee, Edge logo
tests/                      unit tests (tests/helpers/: Fullscreen API stubs for happy-dom)
tests/e2e/                  end-to-end tests (Playwright): specs, harness/ (extension fixtures, fixture
                            server, CDP helpers), fixtures/ (the pages they drive)
playwright.config.ts        end-to-end test configuration
docs/ARCHITECTURE.md        design decisions
```

## Credits and licenses

The popup and the options page use [Inter](https://github.com/rsms/inter) 4.1 by The Inter Project Authors,
under the [SIL Open Font License 1.1](src/ui/fonts/OFL.txt). The extension ships a Latin subset of it,
`src/ui/fonts/inter.woff2` (weights 400 to 600), with the license as `ui/fonts/OFL.txt` next to it in the package.
The pages load it from the extension's own files; nothing is fetched from the web.
