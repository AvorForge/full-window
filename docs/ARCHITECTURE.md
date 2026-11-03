# Full Window, Not Screen: Video Sizer: architecture

Status: accepted design for v0.1, implemented: the MAIN-world patch layer (§2, §3), frames (§4),
pop-out mode (§5), the toggle command (§8), the popup, and the Playwright end-to-end tests that run all of
it with the extension loaded in Chromium (§9). Where this document and the code disagree, fix one of them in
the same change.

## 0. Overview

When a page asks for fullscreen (usually a video player), the extension intercepts the request. The browser
does **not** enter real fullscreen. Instead the requested element is pinned to a rectangle the user chose,
and the page is told, through every API it can query, that it is in fullscreen.

| Size mode       | What happens                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `fill-tab`      | The element fills the tab's viewport (default).                                       |
| `custom-rect`   | The element gets a user-set width × height (px or % of viewport) placed by an anchor. |
| `pop-out` | The service worker moves the tab into its own popup window; the element fills it.     |

Esc leaves fake fullscreen. A `chrome.commands` shortcut switches between fake and real fullscreen. Settings
are global with per-hostname overrides. No telemetry, no network requests, no API
keys, no remote code.

```
 ┌──────────────────────────── tab ────────────────────────────┐
 │ top frame                                                    │
 │  page scripts ──call──▶ MAIN-world shim (main-world.js)      │
 │                            ▲  private CustomEvent channel    │
 │                            ▼                                 │
 │                         ISOLATED script (isolated.js) ───────┼──▶ service worker
 │                            ▲ window.postMessage (validated)  │     (serviceWorker.js)
 │  ┌──── <iframe> child frame (any origin) ─────────────┐      │     chrome.windows / commands
 │  │ MAIN shim ◀──▶ ISOLATED script ─────────────────────┼──────┘     chrome.storage.sync/session
 │  └─────────────────────────────────────────────────────┘
 └──────────────────────────────────────────────────────────────┘
   popup.html / options.html ──▶ chrome.storage.sync ◀── all ISOLATED scripts (storage.onChanged)
```

Source layout (one esbuild bundle per entry point):

| Path                               | Role                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `manifest.json`                    | Source manifest; copied to `build/manifest.json`. Paths are relative to `build/`. |
| `src/content/main-world.ts`        | MAIN-world entry; installs `createFullscreenPatchLayer()`.               |
| `src/content/patchLayer.ts`        | The `FullscreenPatchLayer` seam and the no-op layer (kept for tests).    |
| `src/content/fullscreenLayer.ts`   | The real patch layer: replacements, fake state, events, exits (§2, §4). |
| `src/content/styling.ts`           | Pinning, backdrop, adopted stylesheet, ancestor neutralisation (§3).    |
| `src/content/selectors.ts`         | `:fullscreen` / `::backdrop` selector rewriting (§2, §3).               |
| `src/content/natives.ts`           | Originals captured at `document_start`; the native-looking disguise (§2). |
| `src/content/mainWorldBootstrap.ts`| Start-up guard and message routing for the MAIN world.                  |
| `src/content/channel.ts`           | Private MAIN ⇄ ISOLATED channel.                                         |
| `src/content/isolatedController.ts`| ISOLATED logic: config, frame relay, Esc, pop-out, toggle (§4, §5, §8). |
| `src/content/popOutBar.ts`         | The pop-out window's hover bar and corner resize grip (§5).             |
| `src/content/isolated.ts`          | ISOLATED-world entry: wires `chrome.*` to the controller.               |
| `src/background/serviceWorker.ts`  | Module service worker entry: `registerServiceWorker(chrome)`.           |
| `src/background/serviceWorkerCore.ts` | Service worker logic with injectable `chrome.*`: migration, command, messages, releases. |
| `src/background/popOut.ts`   | Save/restore of window bounds (§5).                                     |
| `src/background/browserFullscreen.ts` | Browser fullscreen for the toggle, save/restore of the window state (§8). |
| `src/background/tabState.ts`       | The per-tab armed mode (`preferReal`, §8).                              |
| `src/shared/settings.ts`           | Versioned schema, defaults, migration, `resolveForSite` (§6).           |
| `src/shared/settingsStore.ts`      | `chrome.storage.sync` I/O.                                               |
| `src/shared/messages.ts`           | Typed messages for all three channels, validators.                      |
| `src/shared/geometry.ts`           | `computePinRect` (mode + custom rect + viewport → pixel rect).          |
| `src/ui/popup.*`, `src/ui/options.*` | Toolbar popup (per-site) and options page (global + site list).        |
| `src/ui/ui.css`, `src/ui/fonts/`   | The pages' shared styles (Graphite design) and their font, Inter, with its license (§10). |
| `src/ui/popupModel.ts`             | Popup helpers: per-field override edits, the tab-state and shortcut lines. |
| `src/shared/brand.ts`              | Product name, description and credit; the build writes them (§10).      |
| `src/icons/`                       | The icons the build copies (ON and OFF PNGs) and their SVG sources in `src/icons/svg/` (§10). |
| `scripts/*.mjs`                    | build, package, manifest validation, icon rendering (`npm run icons`), store images. |

## 1. Injection

Two content scripts are declared in `manifest.json`, in this order:

```jsonc
{ "matches": ["<all_urls>"], "js": ["content/main-world.js"], "run_at": "document_start",
  "all_frames": true, "match_about_blank": true, "match_origin_as_fallback": true, "world": "MAIN" },
{ "matches": ["<all_urls>"], "js": ["content/isolated.js"],   "run_at": "document_start",
  "all_frames": true, "match_about_blank": true, "match_origin_as_fallback": true, "world": "ISOLATED" }
```

- **MAIN world** (`world: "MAIN"`, Chromium ≥ 111, hence `minimum_chrome_version: "111"`). It runs in the
  page's own JavaScript realm, so it can replace `Element.prototype.requestFullscreen` and friends and the page
  sees the replacements. `document_start` means it runs after the document is created and before any page
  script, so players that capture `el.requestFullscreen || el.webkitRequestFullscreen` at load time capture the
  patched functions. `all_frames` covers embeds. `match_about_blank` and `match_origin_as_fallback` cover
  `about:blank`, `about:srcdoc`, `blob:` and `data:` frames that players create and script synchronously
  from their parent. It has no `chrome.*` APIs: it cannot read storage or message the service worker.
- **ISOLATED world**. It reads `chrome.storage.sync`, resolves settings for the site, pushes a `ShimConfig` to
  the MAIN world, relays frame messages (§4), talks to the service worker (§5) and answers the popup
  (`get-site`).
- **Start-up guard.** `bootstrapMainWorld` marks the window with `Symbol.for("custom-full-screen.main-world")`
  so a second injection into a re-used `about:blank` window is a no-op.

### MAIN ⇄ ISOLATED private channel (`src/content/channel.ts`)

The two worlds share the DOM, not JavaScript objects. The channel uses `CustomEvent`s with a per-frame random
name, set up before page scripts exist:

1. Whichever script runs first generates a 128-bit id (`crypto.getRandomValues`; `randomUUID` is missing on
   insecure origins) and writes it to `<html data-cfs-channel="…">`.
2. The second script reads the id and **removes the attribute**. Both scripts run at `document_start` before
   any page script, so the page never sees it.
3. Events are named `<id>:main` / `<id>:isolated`. `detail` is a **JSON string**: object `detail`s are
   cloned or nulled across worlds, depending on the Chromium version. The listener is a capture-phase listener
   on `document`, so it also sees events dispatched on elements.
4. The creator queues outgoing messages until the other side, after registering its first listener, sends
   `hello`. Without this, a `config` sent before the MAIN world listens would be lost (a unit test covers it).
5. To refer to a DOM node (the `<iframe>` to pin, §4), the event is **dispatched on that node**. The
   receiver takes `event.composedPath()[0]`, which is the node in both worlds even inside an open shadow
   root (`event.target` would be retargeted to the shadow host for the document-level listener). Nodes are
   never serialised.
6. The channel captures `CustomEvent`, `EventTarget.prototype.dispatchEvent/addEventListener`,
   `Event.prototype.composedPath`, `Element.prototype.get/set/removeAttribute`, `JSON` and `Reflect.apply`
   at load, so later page monkey-patching cannot intercept or break the channel.

Messages are typed as `PageMessage` in `src/shared/messages.ts`: `config`, `exit`, `go-real`, `go-fake`,
`enter-frame-element` (ISOLATED→MAIN) and `entered`, `exited` (MAIN→ISOLATED).

**Before settings arrive.** Storage reads are asynchronous. A request that arrives before the first `config` is
held (its promise stays pending) for up to 250 ms (`CONFIG_WAIT_MS`) waiting for the config, then handled. If
no config arrives, the request passes through to the real API. Fullscreen requests come from user gestures, long after
`document_start`, so in practice the config is always there first. Transient user activation lasts about 5 s
in Chromium, so a late pass-through still succeeds.

### Patch layer seam (`src/content/patchLayer.ts`)

`main-world.ts` only bootstraps. Everything that touches the page's Fullscreen API sits behind:

```ts
interface FullscreenPatchLayer {
  readonly name: string;
  install(ctx: { window; notify(message, target?) }): void; // once, at document_start
  configure(config: ShimConfig): void;   // first config enables faking
  exit(reason: ExitReason): void;        // leave fake fullscreen
  goReal(): void;                        // toggle command, fake → real (browser fullscreen, fill the tab)
  goFake(): void;                        // toggle again (or window released): back to the configured size
  enterFrameElement(el: Element, requestId: string): void; // §4
  uninstall(): void;                     // restore original descriptors
}
```

`main-world.ts` installs `createFullscreenPatchLayer()` (`fullscreenLayer.ts`). `createNoopPatchLayer()`,
which records calls and changes nothing, stays for the bootstrap and channel tests.

## 2. API surface to fake

All originals are captured at `document_start` (`Object.getOwnPropertyDescriptor` on the prototype that
owns them, walking up from `Element`, `HTMLVideoElement`, `DocumentFragment`, `ShadowRoot` and, for
document members, from the document's own prototype, which in browsers reaches `Document.prototype`), and
only properties that exist are replaced. We never add a prefixed API the browser does not have, because
players use presence checks to pick a code path. (Chromium 145, for example, no longer has any of the
`HTMLVideoElement` `webkit*` members below; there they stay absent.) Everything the layer itself calls on page
objects is a captured original, called with a captured `Reflect.apply` (`natives.ts`).

### Methods

| Prototype                | Members                                                                                         | Fake behaviour |
| ------------------------ | ----------------------------------------------------------------------------------------------- | -------------- |
| `Element.prototype`      | `requestFullscreen(options?)`                                                                   | Returns a Promise (below). |
| `Element.prototype`      | `webkitRequestFullscreen()`, `webkitRequestFullScreen()`                                         | Same steps, **prefixed** request type; returns `undefined`. |
| `Element.prototype`      | `mozRequestFullScreen()` (only if present; never in Chromium today)                              | As prefixed. |
| `HTMLVideoElement.prototype` | `webkitEnterFullscreen()`, `webkitEnterFullScreen()`                                        | Prefixed request on the video itself; returns `undefined`. Where the original would throw (older Chromium threw `InvalidStateError` before metadata was loaded), the shim throws the same: it learns this once by calling the original on a video in an inert `createHTMLDocument()` document (no page-visible effect) and, for a video with `readyState` < `HAVE_METADATA`, throws a `DOMException` with the same name and message. |
| `HTMLVideoElement.prototype` | `webkitExitFullscreen()`, `webkitExitFullScreen()`                                          | Exits when the video is the fake element; otherwise the original. |
| `Document.prototype`     | `exitFullscreen()`                                                                              | Returns a Promise; exits fake fullscreen. |
| `Document.prototype`     | `webkitExitFullscreen()`, `webkitCancelFullScreen()`, `mozCancelFullScreen()`                    | Same exit steps, returns `undefined`; when nothing is fake-fullscreen, the original (a no-op). |

The request steps mirror the Fullscreen spec and Chromium:

1. If the site is disabled (`config.enabled === false`) or `config.preferReal` is set, call the captured
   original with the same `this` and arguments and return its result: **pass-through**. The same applies when
   `this` is not an element of this document (the original throws or handles it) and while the document is
   **really** fullscreen.
2. Validate like the browser would, so feature detection and error paths behave the same: `FullscreenOptions`
   is converted like WebIDL (`navigationUI` must be `auto`/`show`/`hide`, else `TypeError`, no event). Then
   Chromium's checks, in Chromium's order, each with Chromium's own `TypeError` message (measured in Chromium
   145 with the extension switched off; the e2e tests compare both, §9):

   | Check (first failing one wins)                                   | Message |
   | ---------------------------------------------------------------- | ------- |
   | an HTML element or an SVG `<svg>` (MathML `<math>` is refused too) | `Element is not an HTML or SVG element` |
   | not a `<dialog>`, modal or not                                   | `Dialog elements are invalid` |
   | connected                                                        | `Element is not connected` |
   | the document's real `fullscreenEnabled` (an `<iframe>` without `allowfullscreen` or `allow="fullscreen"` stays non-fullscreen-capable) | `Disallowed by permissions policy` |
   | transient user activation (`navigator.userActivation.isActive`), so pages that try fullscreen on load still fail exactly as they would | `Permissions check failed` |

   On failure: reject the promise with that `TypeError` and fire `fullscreenerror` (below).
3. If another element is already fake-fullscreen in this document, unpin it first, without a change event for
   it (the new element replaces it in the fullscreen stack; Chromium keeps a stack, but players only ever use
   the top). A request for the element that is already fake-fullscreen resolves without any event.
4. Set the internal state (`fakeElement`, `requestType: "unprefixed" | "prefixed"`), pin the element (§3) and,
   in a child frame, start the frame chain (§4); in the top frame in `pop-out` mode, ask the service
   worker to resize (§5).
5. **Promise and event order** (spec: "fullscreen element ready" is set in a task, the promise resolves in that
   task, and the change event fires in the next "update the rendering" step):
   - the state is visible synchronously to getters from step 4 on (Chromium also updates
     `document.fullscreenElement` before the event; players poll it inside the promise callback);
   - the promise returned by `requestFullscreen` resolves (microtask);
   - at the next animation frame the change event is dispatched, from a `requestAnimationFrame` callback
     registered during the request, so it runs before rAF callbacks the page registers afterwards (one callback
     per frame dispatches every queued enter, exit and error event in order);
   - a synthetic `resize` event is dispatched on `window` right after the change event, because players
     recompute layout on resize (real fullscreen always resizes the viewport; `fill-tab` does not).
6. **Which event**: as in Chromium, unprefixed requests fire `fullscreenchange` / `fullscreenerror`; prefixed
   requests (`webkit*`) fire `webkitfullscreenchange` / `webkitfullscreenerror`. Event handler attributes
   (`onfullscreenchange`, `onwebkitfullscreenchange`) work because real events are dispatched.
7. **Where**: the event is created with `new Event(type, { bubbles: true, composed: true })` and dispatched
   on the element, so it bubbles through its shadow-including ancestors to `document` and `window`, as in
   browsers. If the element was removed from the document in the meantime, it is dispatched on
   the document instead. `fullscreenerror` uses the same rules.

Exit steps (`exitFullscreen` and prefixed variants, Esc, element removal, navigation):

- `exitFullscreen()` when nothing is fake-fullscreen and nothing is really fullscreen rejects with
  `TypeError` ("Failed to execute 'exitFullscreen' on 'Document': Document not active"), like Chromium; the shim rejects itself while faking is enabled, and in
  pass-through the original does. If the document is **really** fullscreen (pass-through), call the original.
  (`goReal` does not make the element really fullscreen, see §8, so exits after it are fake exits.)
- Otherwise: unpin (§3), clear state, resolve the promise, fire the change event of the matching type at the
  former element (or the document if it was disconnected) at the next animation frame, then `resize`.
  In a frame chain, exiting anywhere exits the whole chain (§4), which matches "fully exit fullscreen" for
  the single-level fullscreen players use.
- A `MutationObserver` on the document and on every shadow root between it and the fake element notices
  removal of the element and exits with reason `removed`. An element that is only moved (players re-parent
  the video into their fullscreen container) stays fake-fullscreen: markers, ancestor overrides and
  stylesheets are re-applied for its new ancestors.
- Exit reason `refused` (the parent frame refused to pin this frame's `<iframe>`, §4): if the enter's change
  event has not been dispatched yet it is cancelled and only `fullscreenerror` fires, so the page sees a failed
  request; otherwise the exit change event is followed by `fullscreenerror`.

### Getters

| Owner                                 | Property                                                                 | Fake value |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| `Document.prototype`                  | `fullscreenElement`, `webkitFullscreenElement`, `webkitCurrentFullScreenElement`, `mozFullScreenElement` | The fake element **retargeted** to the document: if it is inside a shadow tree, its outermost shadow host in the document tree. `null` when idle. |
| `ShadowRoot.prototype`                | `fullscreenElement` (and `webkitFullscreenElement` if present)           | The fake element retargeted to that shadow root: the element itself if it is in this shadow tree, the host of the nested shadow tree containing it if deeper, `null` if it is not inside this root. |
| `Document.prototype`                  | `fullscreen`, `webkitIsFullScreen`, `mozFullScreen`                      | `fakeElement !== null` |
| `HTMLVideoElement.prototype`          | `webkitDisplayingFullscreen` (if present)                                 | `true` for the fake element |
| `Document.prototype`                  | `fullscreenEnabled`, `webkitFullscreenEnabled`                           | Original value, unchanged: the shim never makes fullscreen possible where the browser forbids it. |

When the shim is in pass-through (site disabled, `preferReal`, or a real fullscreen in progress), every getter
returns the original getter's value. While fake-fullscreen, the original getters are still consulted first: if
the document is really fullscreen (after `goReal`), the real value wins.

The fake element also matches `:fullscreen` in `Element.prototype.matches` / `webkitMatchesSelector` /
`closest` / `querySelector(All)` and in the `querySelector(All)` of documents and `DocumentFragment` (so shadow
roots): these are wrapped to rewrite `:fullscreen`, `:-webkit-full-screen`, `:-moz-full-screen` and
`:-webkit-full-screen-ancestor` to the attribute markers of §3 **only while a fake element exists** (zero cost
otherwise). Only string arguments are rewritten, and never inside quoted strings, attribute selectors or
escapes (`selectors.ts`). Some players test `el.matches(":fullscreen")` instead of `document.fullscreenElement`.

### Looking native

Players and anti-tamper code check `typeof el.requestFullscreen === "function"` and sometimes
`/\[native code\]/.test(fn.toString())`. The layer therefore:

- defines replacements with the **same property attributes** (`writable`, `enumerable`, `configurable`) as the
  originals, on the **same prototype**;
- creates methods with `{ name() {} }` shorthand syntax, so they have no `prototype` property and are not
  constructible, and sets `name` and `length` to the originals' values (`requestFullscreen.length === 0`);
  getters are named `get fullscreenElement`;
- wraps `Function.prototype.toString` once (itself disguised the same way) with a `WeakMap` from each
  replacement to its original, so `toString` returns the original's `function requestFullscreen() { [native
  code] }`; `Function.prototype.toString.call(Function.prototype.toString)` also reports native code;
- never leaks extension frames in stack traces of errors thrown to the page: errors are created as
  `new TypeError(message)` from inside the replacement, whose frame shows as a script in the page's realm
  (the MAIN-world script has a `chrome-extension://` URL; this is a known, accepted leak for private use).

Checked in Chromium 145 with the production bundle: every member keeps its owner, attributes and `toString`
output, and no member appears or disappears.

### Native video controls (real fullscreen the page did not ask for)

The fullscreen button of Chromium's built-in `<video controls>` requests fullscreen from inside the browser (the
media controls' UA shadow DOM), not through page script, so no replacement above ever sees it: on a video file
opened directly (Chromium's media document) and on every page that uses native controls the browser went really
fullscreen, and the chosen size and pop-out were never applied (live run 2026-10-30, §8 "Site notes"). The layer
therefore listens, in the capture phase on `window` and registered at `document_start` before any page listener,
for `fullscreenchange` / `webkitfullscreenchange`. When a **trusted** change event (the browser's own; the shim's
events and the page's synthetic ones are untrusted) reports a real `fullscreenElement`, and

- faking is on (installed, configured, `enabled`, not `preferReal`: not after the toggle armed real fullscreen,
  §8, and not on a disabled site or with the extension off), the layer is not in `goReal` (the toggle's
  browser fullscreen, which is window-level and never makes an element really fullscreen anyway),
- no request of the page's own script reached the real API since the document was last not fullscreen (every
  pass-through call marks that, and a trusted error or the real exit clears it), so a page's own real
  fullscreen stays real,
- and the element (the event's `composedPath()[0]`, or the real `fullscreenElement`) is a `<video>`/`<audio>` or
  contains one,

it adopts it: it stops that event before any page listener sees it, calls the original `exitFullscreen()`
(which needs no user activation), stops the exit's change event too, and once the document is no longer
fullscreen (the exit's promise or its change event, whichever comes first) enters fake fullscreen on the element
with the event's request type. That queues the same change event (on the element, at the next animation frame)
and `resize` that a request through the shim gives, notifies the ISOLATED world (pop-out and frame chains work as
usual) and moves focus off the controls' button: Chromium keeps key events inside its media controls (not even a
`window` capture listener sees them), so with focus left there Esc would reach neither the page nor the
extension. The page sees one change event, as for its own request, and never the real enter or exit; it can still
see the real `fullscreenElement` if it reads it in between, and the `resize` events of the real transition.

- **No loop.** Nothing here requests real fullscreen; entering fake fullscreen calls no page-visible API. A second
  click on the controls' button (which shows "enter full screen", as the video is not really fullscreen) goes
  through the same steps for the element that is already fake-fullscreen, and leaves fake fullscreen instead, as
  the button leaves real fullscreen. If the exit fails (its promise rejects), the layer gives up and the real
  fullscreen stays.
- **User activation.** Not needed by any step: `exitFullscreen()` never needs it and entering fake fullscreen
  does not call the browser. So it does not matter that the click's transient activation is already consumed by
  the browser's own request (the page reads `navigator.userActivation.isActive === false` in that change event)
  or has expired.
- **The flash.** In a headed browser the window really goes fullscreen and back before the element is pinned:
  a brief (one or two frames up to the length of the browser's fullscreen animation) flash of real fullscreen,
  with its "press Esc to exit" bubble and `resize` events. Headless Chromium does not resize the window for
  element fullscreen, so the end-to-end test cannot see it.
- **Frames.** In a child frame the adoption runs in that frame, and its chain (§4) pins the `<iframe>` in each
  parent. The parent documents themselves were really fullscreen (on the `<iframe>`) for that moment: their pages
  see the real enter and exit change events too, as the `<iframe>` holds no media element of theirs.

### Disabled for a site

The patch is installed **unconditionally** at `document_start`, because settings are not yet known. When the
resolved settings say `enabled: false`, every replacement delegates to the captured original (same `this`,
same arguments, same return value, same exceptions) and every getter returns the original getter's value.
Uninstalling on the fly is avoided: players keep references to the functions they found at load, and a live
settings change from the popup must take effect without reloading the page. `uninstall()` exists for tests
and for a future "hard disable" that only applies on the next load.

## 3. Styling

### Pinning the element

On enter, the layer records the element's current `style` attribute value (`getAttribute("style")`) and
sets these declarations as inline `!important` (inline-important beats every author rule):

```
position: fixed; left/top/width/height: <rect px>; right: auto; bottom: auto;
min-width/min-height: 0; max-width/max-height: none; margin: 0; padding: 0 (only on <video>);
box-sizing: border-box; transform: none; z-index: 2147483647;
background: <backgroundColor> (only on the element when it is <video>/<iframe>); object-fit: contain (<video>);
```

`rect` comes from `computePinRect(settings, viewport)` (`src/shared/geometry.ts`): the full viewport for
`fill-tab` and `pop-out`, otherwise width/height resolved from px or % of `innerWidth`/`innerHeight`,
clamped to the viewport and placed by the anchor (centre by default). In child frames the rect is always
the full viewport of that frame, because the parent sizes the `<iframe>`. The rect is recomputed on window
`resize` while active.

On exit, the `style` attribute is restored exactly (removed if it was absent). If the page wrote the
element's inline style during fake fullscreen, the original attribute is restored with the page's changes to
other properties carried over (`mergedStyle`: YouTube keeps setting custom properties on `<html>`), while its
changes to our properties are lost. That matches real fullscreen, where UA `!important` rules also hide them.

While active, a `MutationObserver` on the element's `style` attribute re-applies the declarations when the
page rewrites the inline style (`el.style.width = "…"` replaces our `!important` declaration, as players do on
resize). A write that leaves every pinned declaration in place (a custom property, say) is not a fight and
is not counted. A page that keeps fighting back is given up on after 100 re-applies per enter.

### Backdrop

A single `<div data-cfs-backdrop>` is inserted as the last child of `document.documentElement` (outside any
page container), styled inline `!important` with `position: fixed; top/right/bottom/left: 0; z-index:
2147483646; background: <backgroundColor>` (plus `display: block`, zero margin/padding/border, `opacity: 1`,
`transform: none`, so page rules for `div` cannot move it). It hides the page around a `custom-rect` and plays
the role of `::backdrop`. It is `aria-hidden="true"` but **not `inert`**: an inert element is skipped by hit
testing, so clicks around a custom rectangle would reach the hidden page underneath. Its background is the
user's colour; mirrored page `::backdrop` rules (below) apply to its other properties. Below `<html>` it is
this plain box; for a document-root request it is four strips around the rectangle, or not rendered, as
described next.

### Document-root requests (the black tab on YouTube)

**Observed.** With v0.1.0 on a real YouTube watch page (Chromium 145, default settings, fill-tab), YouTube's
fullscreen button turned the whole tab black, with no video and no controls. Live evidence, extension
loaded unpacked:

- The element YouTube passes to `requestFullscreen()` is `document.documentElement` (`<html>`), not
  `#movie_player`. Real fullscreen with the extension off reports the same `fullscreenElement`. There,
  `<html>` stays `position: static`, because Chromium's UA rule is `:not(:root):fullscreen`. YouTube's
  `fullscreenchange` handler sets `[fullscreen]` on `ytd-app`, `ytd-watch-flexy` and `ytd-masthead`, adds
  `body.no-scroll`, sets `overflow: hidden` and the masthead variables on `ytd-app`, and sizes the player with
  `100vh` (window-, not screen-relative).
- After our pin, `<html>` was `position: fixed; z-index: 2147483647` at 0,0 1264×705 (the whole viewport).
  The player chain was laid out correctly (`#movie_player` 0,0 1264×705, `video` 5,0 1253×705, all visible,
  opacity 1, no transform, ancestors with `z-index: auto`). But `document.elementFromPoint()` at the video's
  centre and at the fullscreen button returned `div[data-cfs-backdrop]`, and clicking play timed out.
- **Cause.** The backdrop is appended as the last child of `<html>`. When `<html>` itself is the fullscreen
  element, the backdrop is inside it, in the root stacking context. With `z-index: 2147483646` it paints over
  `<body>` and everything in it, so it covers the whole page. The usual guarantee (pinned element at
  2147483647, backdrop one below) only holds when the backdrop is outside the element, which is never true for
  the document root. The hypothesis that the page's `fullscreenchange` handler adds a stacking context on an
  ancestor after the pin was refuted: no ancestor of the video had a stacking context or an opacity, transform
  or visibility problem.
- The YouTube **embed** (`youtube.com/embed/<id>` in an `allowfullscreen` iframe) requests `<body>`, not
  `<html>`, so its backdrop stays beneath it and it was not affected. The parent pins the iframe as usual.

**Fix** (`pinElement`, `backdropDeclarations`, `rootLayout` in `src/shared/geometry.ts`). This is general,
not a YouTube quirk: any page that calls `document.documentElement.requestFullscreen()` hit it.

- **The backdrop stays off the rectangle.** For a root pin the backdrop paints and takes the clicks only
  around a custom rectangle, never over the page inside it. The first version did this with a
  `clip-path: polygon(evenodd, <viewport>, <pinned rect>)` hole. That caused the video flicker described
  below, so the backdrop is now a box that paints nothing and takes no clicks (`background: transparent;
  pointer-events: none`), holding four strips (`backdropStrips`: top, bottom, left, right of the rectangle,
  each with the user's colour, `pointer-events: auto` and `will-change: transform`). When the rectangle covers
  the viewport (fill-tab, pop-out, a go-real) the backdrop is `display: none` (`holeCoversViewport`).
  Either way the page looks and behaves as in real root fullscreen.
- **The root is scaled, not shrunk.** The root's content keeps sizing itself with `vh`/`vw`,
  `innerWidth`/`innerHeight` and `position: fixed`, which all refer to the real viewport. Pinning `<html>` to a
  smaller custom rectangle therefore let YouTube's `100vh` player overflow it: the controls ended up below the
  rectangle. Instead, `<html>` is laid out at the rectangle's aspect ratio, at least as large as the viewport in
  both dimensions (exactly as large in one), and scaled with `transform: scale(s)` (`transform-origin: 0 0`)
  so that its box covers the rectangle exactly. `s = min(rect.width / innerWidth, rect.height /
  innerHeight)`, and the result is 1 in fill-tab, pop-out and child frames.
- A transformed `<html>` is the containing block of its fixed descendants, including the backdrop. The page's
  own fixed elements therefore map into the rectangle. The backdrop and its strips are placed in `<html>`'s
  local, unscaled coordinates (left/top `−rect/s`, size `viewport/s`, rectangle `rect/s`).
- `:root[data-cfs-fullscreen]` gets the same `overflow: hidden !important` as a fullscreen ancestor root.
  A fixed `<html>` has no scrollable overflow, so the document's scroll position is recorded and put back on
  exit.

Measured again on real YouTube with the fix: in fill-tab the video wins hit testing at its centre and the
fullscreen button at its own, and play/pause and Esc work. In custom-rect 800×450 the `<html>` box is exactly
232,128 800×450, with the player, video and controls inside it, black around it, play/pause working and the
player's exit button leaving. Exit restores the `style`, `class` and markers our pin touched; what remains is
YouTube's own state, the same as after a real fullscreen exit.

#### The video flickering black on mouse movement (fixed)

**Observed.** With the build above on desktop Chrome on Windows (default settings, fill-tab), fake fullscreen
on a YouTube watch page worked, but the video area flickered black while the mouse moved over it or on and
off it. The rest of the tab did not flicker, and real fullscreen did not do this. YouTube shows and hides its
player chrome on mouse movement: it toggles `ytp-autohide` and other classes on `#movie_player` and inserts
and removes tooltip nodes.

**Measured** on real YouTube (`aqz-KE-bpKQ`, playing, Chromium 145, the production build, about 19 s of
mouse movement over the video, along it and on and off it, in fill-tab and custom-rect 80 %×80 %). Two
instruments were used. The first was a dev build with counters in `styling.ts`, `fullscreenLayer.ts` and
`natives.ts`. The second was an init script that wraps `setProperty`, `removeProperty`, `setAttribute`,
`removeAttribute`, `replaceSync` and `MutationObserver` before the MAIN-world script captures them, and counts
calls whose stack has the extension's URL.

- YouTube's activity was the same with the extension on and off: about 107 class changes on `#movie_player`,
  64 childList records and 58 style writes on its own `div`s.
- The extension's own work was close to nothing, in both modes:
  - its observers ran once, and `pin.refresh()` ran once and returned `false` (`<html>` has no ancestors to
    re-check);
  - 0 `applyElement` re-applies, 0 neutralise/restore (`attach`/`detach`) cycles and 0 `update` calls;
  - 0 style writes, 0 marker writes, 0 backdrop writes and 0 sheet writes.

  `<html>`, `body`, `ytd-app`, `#movie_player`, the video and the backdrop kept the same `style` attribute and
  the same computed `position`, `transform`, `z-index`, `clip-path`, `contain`, `will-change` and `display`
  throughout. So it was not a style flip-flop.
- The composited layer tree (CDP `LayerTree`) did differ. With the extension on, two layers that draw
  content sat above the video, after it in paint order, and covered all of it. One was
  `div[data-cfs-backdrop]` (reason `Overlap`; 1264×705 in fill-tab, 1581×882 in custom-rect). The other was its
  clip-path mask, which has no node (1268×709 and 1587×888). In real fullscreen neither exists, and the layers
  drawing above the video are YouTube's own. In fill-tab the backdrop's hole was the whole viewport, so these
  layers drew no visible pixel at all.
- The headless test browser composites in software, and a headed window on the test host also reported
  "Compositing: Software only". Its screencast (500 to 970 frames per run) showed no black frame with the
  extension on or off, before or after the fix. The flicker itself was therefore not reproduced here.

**Cause.** Chromium composites the clip-path'ed backdrop, a child of the pinned `<html>` at `z-index:
2147483646`, as a viewport-sized layer plus a clip-mask layer above the video. The video then has
non-trivial composited content stacked over its whole area that real fullscreen does not have. Hardware video
paths, such as the direct-composition overlays Chrome uses for video on Windows, handle such content
differently from a video with nothing over it. As the player chrome repaints on every mouse move, the video
flickered. This last step is inferred from the layer evidence and the user's report: the overlay behaviour
could not be observed in software compositing. Every other difference was measured and ruled out. This only
affects document-root requests: below `<html>` the backdrop is under the element, not over it, which is why
other sites did not flicker.

**Fix** (`backdropDeclarations`, `backdropStrips`, `holeCoversViewport`, `pinElement`).

- In fill-tab the backdrop is `display: none`.
- In custom-rect no part of the backdrop overlaps the rectangle:
  - the box paints nothing and gets no drawing layer;
  - each strip has `will-change: transform`. Without it Chromium merged the four strips into one layer
    spanning the hole (measured: 1581×882 over the video). With it they are four layers around the rectangle
    (1580×89, 1580×88, 159×705, 158×705) and none overlaps the video.
- After the fix, the drawing layers above the video in fill-tab are exactly the ones real fullscreen has.
- `Pin.update()` also returns early when the options and the viewport are unchanged. Repeated resize events
  or settings pushes then write nothing.

Measured again with the fixed build: still 0 style, marker and sheet writes and 0 re-attach cycles during
mouse movement in both modes. `tests/e2e/root-player-activity.spec.ts` keeps it that way offline.

#### Container players are scaled too (Twitch in custom-rect, fixed)

**Observed** in the live compatibility run (2026-10-25, Chromium 145, v0.1 build b6b34ca, custom-rect 80 % × 80 %,
§8 "Site notes"). Twitch's fullscreen button asks for fullscreen on its app root `div#root`, not on `<html>`. The
extension pinned `div#root` to the 1011 × 564 rectangle, but the video and the control bar still covered the
whole 1264 × 705 tab. Real fullscreen and fill-tab were fine.

**Cause.** Inside `div#root`, Twitch's fullscreen layout puts the player in `div.persistent-player`, which is
`position: fixed; top: 0; left: 0` and viewport-sized. Nothing between it and the pinned element was a
containing block for fixed descendants, so it was laid out against the viewport and escaped the rectangle. In
real fullscreen the element *is* the viewport, so fixed, `vw`/`vh` and `innerWidth`-sized content always fits.
This is the reason `<html>` was already scaled rather than shrunk, and it holds for any container.

**Fix** (`scalesToRect`, `elementDeclarations` in `src/content/styling.ts`). Every pinned element that is not a
replaced element (`<video>`, `<iframe>`, `<frame>`, `<canvas>`, `<img>`, `<embed>`, `<object>`, or SVG) is laid out
like the root: at the rectangle's aspect ratio, at least viewport-sized (`rootLayout`), with `transform:
scale(s)` and `transform-origin: 0 0`. The transform also makes it the containing block of its fixed descendants,
as the viewport is in real fullscreen. A `<video>` and an `<iframe>` still take the rectangle's size: a video
draws its frames into any box, and an iframe's own viewport becomes the rectangle, so its document is laid out
for it. In fill-tab, pop-out and child frames the scale is 1 and nothing changes. The backdrop of a
non-root element stays below it, as before.

#### One coordinate space while scaled (YouTube's seek bar in custom-rect, fixed)

**Observed** in the same run on a YouTube watch page in custom-rect 80 % × 80 %. A click at 25 % of the seek bar
on screen jumped to 20.3 % of the video, and a drag to 60 % ended at 48.0 %. In real fullscreen and in fill-tab
they landed at 25.1 % and 60.0 %.

**Cause.** The scaled root is laid out in its own unscaled box (1264 px wide here) and drawn at 0.8 of that.
Chromium reports pointer positions (`clientX`) and `getBoundingClientRect()` on screen, but layout values
(`offsetWidth`, `clientWidth`, `innerWidth`, CSS `vw`) in the unscaled box. YouTube maps the pointer with
`(clientX − bar.left) / width`, where the width comes from layout, so every position was off by the scale. The
same mix misplaces tooltips that a page positions (`position: fixed`) from a button's `getBoundingClientRect()`.
CSS `zoom` instead of the transform does not help: Chromium 145 also keeps `offsetWidth` unzoomed, and fixed
children of a zoomed `<html>` lose its offset (measured, `compat/zoom-probe.mjs` in the evidence).

**Fix** (`installCoordinates` in `src/content/fullscreenLayer.ts`, `rootSpace`/`toRootX`/`fromRootX` in
`src/shared/geometry.ts`). While a pinned element is scaled (`Pin.space()` is not null), the page gets every
position in the element's unscaled space, whose origin is the rectangle's top-left corner. Screen and layout
agree there, as they do in real fullscreen:

- trusted `MouseEvent` (so also pointer, wheel and drag events) `clientX`/`clientY`, `x`/`y`, `pageX`/`pageY` and
  `movementX`/`movementY`, and `Touch` `clientX`/`clientY`/`pageX`/`pageY`: `(screen − rect.left) / scale`.
  `offsetX`/`offsetY` are already local. Synthetic events a page creates keep the values it gave them
  (`isTrusted` is an unforgeable own property);
- `Element.prototype.getBoundingClientRect()` of a connected element of the document, divided the same way (a
  detached element's empty rect is left alone);
- `Document`/`ShadowRoot` `elementFromPoint` / `elementsFromPoint` take page-space points and convert them back
  to the screen for the browser.

The replacements are installed the first time an element is scaled, through the same disguise as the rest of the
layer (§2: same owner, attributes, `name`, `length` and native `toString`), and are no-ops whenever nothing is
scaled. A page that never uses a custom rectangle on a container never gets them. `getClientRects()`, `Range`
rects, `IntersectionObserver` entries and `document.caretPositionFromPoint()` are not converted (§8).

### Emulating `:fullscreen` and `::backdrop` rules

The fake element gets `data-cfs-fullscreen`, its shadow-including ancestors (up to and including `<html>`)
get `data-cfs-fullscreen-ancestor`, and the backdrop div stands in for `::backdrop`. A constructed
stylesheet, adopted via `document.adoptedStyleSheets` and the `adoptedStyleSheets` of each relevant shadow
root, carries:

1. **UA equivalents** of Chromium's fullscreen rules, keyed to the markers and wrapped in `:where()` so they
   have zero specificity, like UA rules: `[data-cfs-fullscreen] { object-fit: contain; }`,
   `iframe[data-cfs-fullscreen] { border: none !important; padding: 0 !important; }`,
   `[data-cfs-fullscreen] video { width: 100%; height: 100%; }` for container players, and
   `:root[data-cfs-fullscreen-ancestor], :root[data-cfs-fullscreen] { overflow: hidden !important; }` so no
   root scrollbar covers the pinned rectangle (the rectangle is computed from `innerWidth`/`innerHeight`,
   which include it).
2. **Mirrored page rules.** On enter, same-origin readable stylesheets are scanned for selectors containing
   `:fullscreen`, `:-webkit-full-screen`, `:-webkit-full-screen-ancestor`, `:-moz-full-screen` or
   `::backdrop`: per root, its `styleSheets` and `adoptedStyleSheets`, recursing into `@media`/`@supports`/
   `@layer`/`@container`/`@scope`, `@import` (keeping its media and layer) and CSS nesting. The roots are the
   document, every shadow root between it and the element (reached with `getRootNode()`, so closed roots too)
   and the open shadow roots of the element and its descendants (`:host(:fullscreen)` rules); each root gets
   its own sheet with the rules found in it. Selector lists are split and only the selectors involving
   fullscreen are kept (so a rule `.a:fullscreen, .b` is not duplicated for `.b`). The pseudo-classes are
   replaced by `[data-cfs-fullscreen]` / `[data-cfs-fullscreen-ancestor]`; `X::backdrop` becomes
   `[data-cfs-backdrop]` only if the fake element matches `X`, so `dialog::backdrop` rules do not restyle our
   backdrop, and backdrop rules go into the document's sheet, where the backdrop div lives. Declarations are
   copied verbatim, priority kept. Cross-origin sheets throw on `cssRules` and are skipped. Mirroring is done
   once per enter; on exit the sheets are removed from `adoptedStyleSheets` and emptied.
3. **`:not(:fullscreen)` rules, rewritten in place.** Mirroring can add rules, but it cannot stop a page rule
   from matching. A rule with a fullscreen pseudo-class inside a negation, like Loom's
   `.css-15mfcn7:not(:fullscreen) [data-hide-ifnot-fullscreen] { display: none }` (and its
   `:-webkit-full-screen` twin), keeps matching a fake-fullscreen element, which is not really `:fullscreen`:
   its fullscreen-only controls (Pause, volume, "Exit full screen") stayed `display: none` in every mode while
   the mirrored `[data-cfs-fullscreen] [data-hide-if-fullscreen]` rule hid the normal bar (live run 2026-10-30).
   So the same scan also lists every style rule whose selector has `:fullscreen`, `:-webkit-full-screen`,
   `:-moz-full-screen` or `:-webkit-full-screen-ancestor` anywhere inside a `:not(...)` (also under `:has()`,
   `:is()` or nesting, `rewriteNegatedFullscreen` in `selectors.ts`), and sets its `selectorText` with each such
   pseudo-class read as `:is(<pseudo-class>, [data-cfs-fullscreen])` (`[data-cfs-fullscreen-ancestor]` for the
   ancestor one). The rule then behaves as in real fullscreen for the fake element and as before for every
   other element; its specificity is unchanged (`:is()` takes its most specific argument, a pseudo-class and an
   attribute weigh the same). The original selector text is kept and set back on exit (unless the page changed
   it meanwhile); a sheet adopted by two roots is rewritten once. Positive uses (`:has(:fullscreen)`,
   `:is(:fullscreen)`) need nothing: the mirrored rule matches the marker there. This covers the readable sheets
   the scan reads: `<style>` and same-origin `<link>` sheets, rules added with the CSSOM (`insertRule`, as
   emotion's speedy mode does; they are in `cssRules`, not in the element's text) and constructed sheets.
   **Rules inserted while fake-fullscreen.** Emotion inserts a component's rules when it first renders, which can
   be in the page's own `fullscreenchange` handler. `CSSStyleSheet.prototype.insertRule` is replaced (disguised
   like the Fullscreen API, §2): it calls the original, and while an element is fake-fullscreen it looks at the
   one rule just inserted (a substring check for "fullscreen" / "backdrop" first), rewrites it in place if
   needed and mirrors it into the adopted sheet of its root. No other work, and none per frame or when idle.
   Not covered: rules added by `CSSGroupingRule.insertRule`, `replace()`/`replaceSync()` on a constructed sheet
   or a new `<style>` element while fake-fullscreen (they apply from the next enter). **Cross-origin sheets**
   cannot be read, so their `:not(:fullscreen)` rules cannot be rewritten (nor their `:fullscreen` rules
   mirrored, §8); there is no way to change them from a content script without a host permission.

YouTube-style players mostly key their fullscreen layout on a class or attribute they toggle in the
`fullscreenchange` handler, so (1) and (2) cover the rest. YouTube's watch page also asks for fullscreen on
`<html>` (above).

### Ancestors that break `position: fixed`

`position: fixed` is relative to the viewport only if no ancestor creates a containing block for fixed
descendants or clips/stacks them. While active, the layer walks shadow-including ancestors of the element
(up to, not including, `<html>`). For each, it records the original `style` attribute and sets inline
`!important` overrides where `getComputedStyle` shows:

| Computed property                                     | Override                         | Why |
| ----------------------------------------------------- | -------------------------------- | --- |
| `transform`, `translate`, `rotate`, `scale` ≠ none    | `none`                           | containing block |
| `perspective` ≠ none                                  | `none`                           | containing block |
| `filter`, `backdrop-filter` ≠ none                    | `none`                           | containing block |
| `contain` includes `paint`, `layout`, `strict`, `content` | `none`                       | containing block + clip |
| `container-type` ≠ normal                             | `normal`                         | implies layout containment |
| `will-change` mentions transform/perspective/filter/contain | `auto`                     | containing block |
| `content-visibility` ≠ visible                        | `visible`                        | containment |
| `clip-path`, `mask-image`/`-webkit-mask-image` ≠ none | `clip-path: none`, `mask`/`-webkit-mask: none` | clips descendants |
| creates a stacking context with `z-index` (positioned/flex/grid item) | `z-index: 2147483647` | escape a low stacking context |
| `opacity` < 1, `mix-blend-mode` ≠ normal, `isolation: isolate` | `opacity: 1` / `normal` / `auto` | stacking context |
| `transform-style: preserve-3d`                        | `flat`                           | containing block |

Everything is restored on exit from the recorded `style` attribute values. Elements are tracked in a list,
not by marker attributes, so a page re-render that replaces an ancestor does not leave stale overrides.

**Animated ancestors.** Chromium keeps an element with a running or filling (finished, `fill-mode` forwards or
both) animation of a transform or filter property a containing block for fixed descendants even when an
inline `!important` `transform: none` wins the cascade and `getComputedStyle` reports `none`. On videojs.org the
hero wrapper `div[data-hero-video]` had finished its entrance animation `hero-video-in` (fill-mode both, from
`translateY(12px) scale(0.99)` to `none`, 1.1 s), so the pinned player was at the wrapper's offset (152, 144)
and its control bar off screen (live run 2026-10-30; `animation.cancel()` moved it to 0, 0). So, before its
overrides are computed, every ancestor (not `<html>`, like the overrides) has its own animations
(`element.getAnimations()`, through the captured original) checked: each one whose keyframes (`getKeyframes()`)
animate `transform`, `translate`, `rotate`, `scale`, `perspective`, `filter`, `backdrop-filter`, the motion path
(`offset-path`, `offset-distance`, `offset-rotate`, `offset-anchor`, `offset-position`, `offset`), `clip-path`,
`mask`/`-webkit-mask`, `opacity` or `z-index` (the containing-block, clipping and stacking properties of the
table above that can be animated) is taken off the element by setting its `KeyframeEffect.target` to `null`.
The overrides are then computed from what is left, so an element whose base style was hidden by a filling
animation (say `opacity: 0` under a finished fade-in) gets the override it needs. Why `target = null`:

- It is reversible and replays nothing. The animation keeps its timing, play state and events; a running one
  keeps running off screen, a finished one stays finished at its end time. On exit the target is set back, so
  the element shows the animation where its timeline is then: a finished one its end state, as before, with no
  `animationstart`. Measured in Chromium 145: the fixed child moves to 0, 0 at once, a style recalc on the
  element (a class change) does not bring the effect back, and restoring it fires no event.
- `animation: none` would restart CSS animations when removed. `effect.updateTiming({ fill: "none" })` frees a
  finished animation only, and for a CSS animation it would override `animation-fill-mode` for good;
  `pause()` leaves the element a containing block (measured); `cancel()` cannot be undone without a replay.

On exit the effects are given back after the ancestors' `style` attributes are restored, unless the page set
another target meanwhile. An animation or transition that **starts on an ancestor while pinned** (the page adds
a class) fires `animationstart` or `transitionrun`; the pin listens for both, in the capture phase on the
document and every shadow root on the element's path, and takes it off the same way, then applies any override
the ancestor now needs. No per-frame work. Not covered: a Web Animations API animation (`element.animate()`)
started on an ancestor while pinned, which fires no event; it is taken off on the next re-attach (the element
re-parented) or the next enter. While pinned, the page's `getAnimations()` on such an ancestor does not list
the animations taken off (§8 "Detectability").

**Considered alternative: the top layer.** `popover="manual"` plus `showPopover()` (or a modal `<dialog>`)
puts the element in the top layer, which escapes containing blocks and stacking contexts without touching
ancestors. Rejected for v1: it adds visible attributes and UA popover styles (`margin: auto`, borders,
`display: none` when closed), toggles `:popover-open`, conflicts with pages that already use `popover`, and
some players observe their own attributes. Keep it as a fallback strategy behind a flag if ancestor
neutralisation proves fragile on real sites.

## 4. Frames

Real fullscreen of an element inside an `<iframe>` makes the `<iframe>` element fullscreen in every
ancestor document. Each ancestor's `document.fullscreenElement` is its `<iframe>`, and each ancestor gets a
change event. The fake mirrors that, one level at a time:

1. In the child frame, the page calls `video.requestFullscreen()`. The child's MAIN layer fakes it
   **locally**: it pins the video to the full viewport of the child frame, updates the getters and resolves the
   promise. It then sends `entered` to its ISOLATED script.
2. The child's ISOLATED script posts to `window.parent`:
   `{ protocol: "custom-full-screen/frame", version: 1, type: "frame-enter", requestId }`. `targetOrigin` is
   `location.ancestorOrigins[0]` when available (and not the opaque `"null"`), else `"*"` (the message carries
   no secret). Every frame of a chain uses the requestId of the frame where the request was made.
3. The parent's ISOLATED script receives it and **validates**:
   - `parseFrameMessage(event.data)` accepts the exact shape only (protocol, version, known `type`, exact key
     set, `requestId` matching `/^[A-Za-z0-9_-]{8,64}$/`, enum `reason`);
   - `event.source` must be the `contentWindow` of an `<iframe>`/`<frame>` in this document, including inside
     open shadow roots. The element is found by comparing `contentWindow` of each frame element. Messages from
     anything else (popups, unrelated windows, grandchildren) are dropped;
   - that frame element must be allowed fullscreen: the parent document's own `fullscreenEnabled` must be
     true, and then `iframe.featurePolicy.allowsFeature("fullscreen")` decides where the browser has it; else
     the `allowfullscreen` attribute, else an `allow` attribute directive `fullscreen` (any allowlist but
     `'none'`), else the default allowlist `'self'`: allowed only if the frame is same-origin (its
     `contentDocument` is readable). The child's own layer has already checked its real `fullscreenEnabled`,
     which reflects the exact policy; this check guards against forged messages. If the frame is not allowed,
     or the site is disabled, the parent replies `frame-ack { accepted: false }` (to `event.origin`, or `"*"`
     for an opaque origin) and the child exits locally with reason `refused`, which fires `fullscreenerror`
     (§2). The child does not wait for the ack before resolving; a refusal turns into an immediate exit, so it
     is rare and harmless.
4. The parent's ISOLATED script dispatches `enter-frame-element` **on the `<iframe>` element** over the
   private channel. The parent's MAIN layer runs the same enter steps on the `<iframe>` (without the
   activation and `fullscreenEnabled` checks, which the child and step 3 did): getters now return the iframe,
   `fullscreenchange` fires in the parent document, and the iframe is pinned. The parent fires the unprefixed
   event even for a prefixed request in the child, because `frame-enter` carries no request type. A child
   that requests again keeps its `<iframe>` pinned without another event; a new child replaces the previous
   one, which gets `frame-exit-request`. It is pinned to the
   full viewport if the parent is itself a child frame, or to the user's rect if the parent is the top frame.
5. If the parent is not the top frame, its ISOLATED script repeats step 2 with its own parent. The chain ends
   at `window.top`, which applies the size mode (and, for `pop-out`, §5).

**Exit** in any frame (Esc, `exitFullscreen()`, element removed, navigation) exits the whole chain. (The toggle
command never exits; it switches between fake and browser fullscreen, §8.)
The frame where the exit starts sends `frame-exit` up to its parent and `frame-exit-request` down to the
child whose `<iframe>` it had pinned. Every frame that receives one exits locally (MAIN reason `frame`) and
passes the message on in the same direction, never back to the frame it came from: `frame-exit` recursively up
to the top, `frame-exit-request` recursively down (to `iframe.contentWindow`, validated by `event.source ===
window.parent` and the requestId the child sent up). An exit in the deepest frame therefore travels to the
top, an exit at the top travels to the deepest frame, and an exit in a middle frame travels both ways. Every
frame fires its own change event once. `frame-exit` is accepted only from the child whose `<iframe>` is pinned,
for that request.

**Esc** is caught by a capture-phase `keydown` listener on `window` in every frame, registered at
`document_start` by the ISOLATED script (so it precedes page listeners). It is only active while this
frame is part of a fake-fullscreen chain and `exitOnEscape` is on, and only for trusted events (a page's
synthetic Esc is not ours to take). It calls `preventDefault()` and `stopImmediatePropagation()` (in real
fullscreen the page never sees that Esc), swallows the matching `keyup` too, and starts the chain exit. Focus
may be in any frame of the chain, so every frame listens.

**Navigation.** On `pagehide` a frame in fake fullscreen exits with reason `navigation`, so its parent unpins
its `<iframe>` and a page restored from the back/forward cache is not left pinned.

**Settings in frames.** All frames use the settings of the **top-level site** (the hostname in the address
bar). Cross-origin child frames get it from `location.ancestorOrigins` (Chromium); if that is unavailable, the
frame uses its own hostname, and the top frame's decision (ack) still governs.

**Threat model.** Any script in a child frame can forge `frame-enter` for its own iframe. The worst outcome is
that its own iframe is pinned. That is what it could already get by calling `requestFullscreen()` on its
document, and it is subject to the same `allowfullscreen` check. Parents never act on messages from windows
that are not their direct child frames. The ISOLATED script's `message` listener is a capture listener on
`window` registered at `document_start`; for protocol messages it accepted it calls
`stopImmediatePropagation()`, so page listeners do not see them; at most a page could infer from timing that
the extension is installed.

## 5. Pop-out mode

Pop out replaced "Resize window" on 2026-10-30. A saved `pop-out` mode is read as `pop-out`
(`sanitizeOverride` in `settings.ts`).

Messages (`ToServiceWorker` / `ServiceWorkerReplies` in `src/shared/messages.ts`):

| From → to        | Message                                                    | Reply |
| ---------------- | ---------------------------------------------------------- | ----- |
| top ISOLATED → SW | `{ type: "pop-out-enter", width, height, title, url }` | `{ ok: true, bounds }` or `{ ok: false, error }` |
| top ISOLATED → SW | `{ type: "pop-out-exit" }`                          | `{ ok: true, restored }` or `{ ok: false, error }` |
| top ISOLATED → SW | `{ type: "pop-out-window", action }` (`fullscreen`, `normal`, `minimized`) | `{ ok: true, state }` or `{ ok: false, error }` |
| top ISOLATED → SW | `{ type: "pop-out-resize", width, height }`         | `{ ok: true }` or `{ ok: false, error }` |
| any ISOLATED → SW | `{ type: "pop-out-activity", corner }`              | `{ ok: true }` or `{ ok: false, error }` |
| placeholder page → SW | `{ type: "pop-out-return" }`                    | `{ ok: true, returned }` or `{ ok: false, error }` |
| SW → top frame    | `{ type: "pop-out-released" }`                      | `{ ok: true }` |
| SW → top frame    | `{ type: "pop-out-leave" }`                         | `{ handled }` |
| SW → top frame    | `{ type: "pop-out-activity", corner }`              | `{ ok: true }` |

(The toggle command's messages are in §8.)

Only the top frame's ISOLATED script sends these, except `pop-out-activity` (`isolatedController.ts`):
- `pop-out-enter`, with the site's `windowSize`, `document.title` and `location.href`, when its MAIN layer reports `entered` with mode `pop-out`. A frame chain ends at the top, so this happens once per chain. Without the "tabs" permission `tab.title` and `tab.url` are undefined, hence the title and URL in the message; the service worker prefers the top frame's `sender.url` and keeps the URL only if it is `http:`, `https:` or `file:`.
- `pop-out-exit`, when it reports `exited`.

If fake fullscreen ends while the enter request is still pending, the exit is sent when the reply arrives. After `pop-out-released`, the tab stays in fake fullscreen and its exit sends nothing. `pop-out-leave` (from "Bring it back") exits fake fullscreen as Esc does, so the usual `pop-out-exit` follows; a tab that is not in fake fullscreen answers `handled: false` and the service worker puts it back itself.

`pop-out-window` and `pop-out-resize` are for the popped-out window's hover bar and corner grip. The service worker acts only on the popup window recorded for the sender tab (`sender.tab.id`), only if the sender tab is in that window and the sender is its top frame; anything else is refused with `not a popped-out tab` or `not the tab's top frame`. Resizes are clamped to at least 320 × 200 (outer px); one `windows.update` is in flight per window, and sizes asked for meanwhile collapse into the latest. `pop-out-activity` from any frame of a popped-out tab is relayed to its top frame (frameId 0), so pointer movement over a cross-origin iframe's video reaches the top frame; `corner` (optional, a boolean, relayed as `true` or `false`) says whether the pointer is in the corner zone.

**Hover bar and resize grip** (`src/content/popOutBar.ts`, created by the top frame's `isolatedController.ts` once `pop-out-enter` succeeded, removed on exit and on `pop-out-released`). Chromium gives an extension no way to remove a popup window's title bar, so it stays; everything else is drawn over the faked-fullscreen video:

- **Isolation:** a host `<div>` appended to `<html>`, with its own declarations inline and `!important`, holding a **closed** shadow root. The shadow's rules are a constructed stylesheet (`adoptedStyleSheets`, which a page's CSP `style-src` does not block, unlike a `<style>` element); the icons are built with `createElementNS` (no `innerHTML`, which Trusted Types would refuse). The host is a `popover="manual"` shown with `showPopover()` each time the bar appears, so it is at the top of the top layer, above any z-index; it also has the highest z-index for engines without popovers. While hidden it fades out and then leaves the top layer, and its host has `pointer-events: none`, so the page gets every click outside the bar and the shown grip.
- **Showing:** `pointermove` / `pointerdown` in the top document (capture, passive) show it; it hides `HIDE_DELAY_MS` (2 s) after the last one, unless the pointer is over the bar or grip, keyboard focus is in the bar, or a grip drag is going on. A child frame in a pop-out chain (in fake fullscreen, mode `pop-out`) sends `pop-out-activity` at most every 400 ms (`ACTIVITY_RELAY_MS`), and at once when the pointer enters or leaves the corner zone, with `corner`; the service worker relays it to the top frame of a popped-out tab only. So hovering a cross-origin iframe's video shows the bar too, and its corner the grip.
- **Look:** a small dark translucent pill at the top centre (`rgba(30, 30, 32, 0.72)` with a backdrop blur, like macOS video controls), three 32 px round buttons with white 18 px line icons. No text, so no font. `prefers-reduced-motion: reduce` turns the fade and slide off.
- **Buttons** (each with `title` and `aria-label`, in a `role="toolbar"`):
  - **Pop back in**: the MAIN layer exits with reason `escape`, exactly as Esc does, so `pop-out-exit` follows.
  - **Full screen**: `pop-out-window { action: "fullscreen" }`, then the button reads **Exit full screen** and sends `normal`. Esc while the window is full screen sends `normal` instead of exiting; the next Esc pops back in. (The button follows its own state: if the window leaves full screen some other way, the next press sends `normal`, a no-op, and the label is right again. Esc with focus inside a cross-origin child frame exits the chain directly, as before.)
  - **Minimize**: `pop-out-window { action: "minimized" }`.
- **Grip:** a 22 px corner tab flush with the bottom-right corner (diagonal lines, `cursor: nwse-resize`). Players put their own buttons in that corner (a demo player's fullscreen button, YouTube's fullscreen and settings buttons), so it does not simply show with the bar:
  - **When:** only while the bar shows *and* the pointer is in the **corner zone**, within 56 px (`CORNER_ZONE_PX`) of the viewport's right edge and of its bottom edge, edges included (`inCornerZone` in `popOutBar.ts`), or while a grip drag is going on. It hides as soon as the pointer leaves the zone (it fades, but stops taking the pointer at once), when the pointer leaves the window (a top-document `pointerout` with no `relatedTarget` outside the viewport), and with the bar. The bar's own showing and hiding is unchanged. The host carries `data-shown` and, while the grip shows, `data-grip`.
  - **Hidden, it takes no pointer events** (`pointer-events: none` on the grip, `auto` only under `:host([data-shown][data-grip])`, never waiting for the fade), so a click in the corner reaches the player's own button underneath.
  - **Over a cross-origin iframe** the top frame never sees the pointer. The child frame works out the zone in its own viewport and sends it as `corner` with `pop-out-activity`. Every `<iframe>` of a pop-out chain is pinned to fill its parent's viewport, so the child's viewport is the popup's and no conversion is needed. A change of zone is sent at once, outside the 400 ms throttle, so the grip follows within one service worker round trip. Leaving the popup window from inside the child frame sends nothing, so there the grip goes with the bar, 2 s later.
  - **Dragging:** `pointerdown` takes pointer capture and records `screenX` / `screenY` and the window's `outerWidth` / `outerHeight`; each move asks for the start size plus the screen delta, at least 320 × 200, with `pop-out-resize`. One request is in flight at a time; sizes asked for meanwhile collapse into the latest, which is sent when the reply comes (the service worker coalesces again per window). The window's own edges resize it as usual. The size it was dragged to is what exit remembers under `popOutPlacement`.

**"It popped out minimized"** (owner's report, 2026-10-30). Not reproduced. In headed Chromium 145 on macOS (this repository's test host, a 1512 × 982 display), with the 23b2087 build and with this one, three pop-outs each from a normal window and two from a maximized one: `windows.onCreated` reports the popup `normal`, a focus change to it follows, and `getAll` shows it `normal` throughout. Chromium first shows it cascaded at the source window's size (232, 182, 1280 × 800) and about 50 ms later the bounds update puts it in the corner at 640 × 390. A full-screen source window (macOS Spaces) could not be tested: Chromium did not enter full screen when the test harness's (background) app asked. Possible causes left: a source window in macOS full screen (the popup then opens in another Space), the browser not being the frontmost app, or the small 640 × 390 corner window itself being read as "minimized". Either way, a popup that is not `normal` after create and the bounds update is set to `{ state: "normal", focused: true }`, and a remembered place Chromium refuses falls back to the corner.

The service worker (`serviceWorkerCore.ts`, `PopOutController` in `src/background/popOut.ts`):

- **Sender:** takes `windowId` and `tabId` from `sender.tab`. It never trusts ids in the message body, and it ignores messages whose `sender.id` is not this extension.
- **Enter:**
  - It stores `{ tabId, fromWindowId, index, fromBounds, popupWindowId, requested, placeholderTabId, url }` under `popOut` in **`chrome.storage.session`**. Session storage survives the service worker being suspended (it will be, during a long video) and is cleared when the browser exits.
  - **Placeholder:** before the tab leaves, `chrome.tabs.create({ windowId: fromWindowId, index, active: false, url: "/ui/poppedOut.html?title=…&url=…" })` opens the extension page `ui/poppedOut.html` just before the tab. Once the tab has gone it has the tab's index, Chromium activates the tab's right-hand neighbour (the placeholder only if there is no other tab), and the old window stays open even if the video was its only tab. Its title is "Popped out: <page title>" (from the query); it shows the toolbar icon, "This video is in its own window" and a **Bring it back** button (`pop-out-return`). It loads only extension files, no favicon or anything else from the network. If no popup window can be made, the placeholder is closed again and the record dropped.
  - It then calls `chrome.windows.create({ tabId, type: "popup", focused: true, left, top, width, height })`. This moves the live tab, without a reload, into a window with no tab strip or toolbar. The page stays in fake fullscreen, so its element fills the popup.
  - Chromium can create the window at a default size (headless always does), so the bounds are set once more with `windows.update`.
  - If Chromium rejects the remembered position ("at least 50% within visible screen space", the displays changed), the window opens in the first pop-out's corner; if that is refused too, at the size only. `chrome.system.display` would need the "system.display" permission, so Chromium's own check is the test.
  - If the popup is then not in the `normal` state (it has been seen minimized), `windows.update(popup, { state: "normal", focused: true })` shows it in front.
- **Where it opens:**
  - **First pop-out:** the bottom-right corner of the window the tab came from, 24 px in.
  - **After that:** where the last pop-out was when it closed. Those bounds are kept in **`chrome.storage.local`** under `popOutPlacement`, so they outlive the browser session.
  - **Size:** the size the user left it at. If the size setting changed since, the new setting wins.
  - A pop-out that was maximized or fullscreen when it closed isn't remembered.
- **A second enter** for a tab that is already out returns the open popup's bounds.
- **Exit:**
  - It deletes the record and remembers the popup's bounds (with any size the corner grip dragged it to). Then it `chrome.tabs.move`s the tab to the placeholder's **current** window and index (the user may have dragged the placeholder), removes the placeholder, activates the tab and focuses that window. The popup closes by itself once its only tab has left.
  - If the placeholder was closed (closing it does nothing to the pop-out; its id is dropped from the record), the tab goes back to `fromWindowId` at `index`. If that window has gone too, `windows.create` opens a normal window with `fromBounds` (maximized again if it was) and the tab.
- **Releases** (without a page request):
  - **Tab starts loading a new document** (`tabs.onUpdated` with `status: "loading"`): the tab is put back. Each release first leaves browser fullscreen if the tab's toggle had entered it (§8).
  - **Tab, or its pop-out window, closes** (`tabs.onRemoved` for the tab, `windows.onRemoved` for its popup): the record is dropped and the placeholder turns back into the page with `tabs.update(placeholderTabId, { url })`. The page reloads, but the tab is not lost. If the placeholder is gone too, nothing happens. Both events fire for one close; the clean-up is serialized so the page loads once.
  - **Another tab is activated** in the browser window: nothing happens. The pop-out is alone in its window, so switching tabs elsewhere never touches it.
- **Size limits:** `width` and `height` are clamped to 100–16384 (the settings limits) first.

`chrome.windows` and `chrome.tabs.move` need no permission. The width × height setting is the pop-out window's
**outer** size, title bar included.

## 6. Settings

Defined and implemented in `src/shared/settings.ts` (pure, unit-tested); I/O in `settingsStore.ts`.

```ts
interface FullscreenSettings {
  enabled: boolean;                     // default true
  mode: "fill-tab" | "custom-rect" | "pop-out";   // default "fill-tab"
  customRect: { width: Length; height: Length; anchor: Anchor };  // 80% × 80%, "center"
  windowSize: { width: number; height: number };        // 640 × 390 (outer px of the pop-out window, 100..16384)
  backgroundColor: string;              // "#000000" (#rrggbb)
  exitOnEscape: boolean;                // true
}
type Length = { value: number; unit: "px" | "%" };     // px 1..100000, % 1..100
type Anchor = "center" | "top-left" | "top" | "top-right" | "left" | "right"
            | "bottom-left" | "bottom" | "bottom-right";
type SiteOverride = deep-partial FullscreenSettings;
interface SettingsDocument { version: 1; global: FullscreenSettings; sites: Record<hostname, SiteOverride> }
```

**Storage layout** in `chrome.storage.sync`:

| Key                | Value                                    |
| ------------------ | ---------------------------------------- |
| `settings`         | `{ version: 1, global: FullscreenSettings }` |
| `site:<hostname>`  | `SiteOverride` (only fields that differ) |

One item per site keeps each item far below sync's 8 KiB per-item quota (`QUOTA_BYTES_PER_ITEM`); the 100 KiB
total and 512-item limits allow hundreds of sites. `saveSettings` writes changed items and removes `site:`
keys of deleted overrides (`planSettingsWrite`). The options page and the popup write; every ISOLATED script
listens to `storage.onChanged` and re-pushes its config, so changes apply live. The options page listens too,
to show changes made elsewhere (the popup, sync), but ignores the echo of its own save (`sameSettings`):
re-rendering it would reset a number field the user is still typing in, because number fields only save on
`change` (blur or Enter).

**Versioning and migration hook.** `migrateSettings(rawDump)` never throws and returns
`{ document, status, fromVersion, persist, warnings }`:

| Stored data                                   | Result |
| --------------------------------------------- | ------ |
| nothing                                       | defaults, `status: "defaults"`, persist |
| `version` = current                           | sanitised, `status: "current"`, no write |
| `version` < current, or missing (= v0)        | `MIGRATIONS[v]` applied step by step to current, `status: "migrated"`, persist |
| `version` > current (written by a newer build) | defaults **in memory only**, `status: "reset"`, `persist: false`, so a downgrade does not destroy newer data |
| non-integer / negative `version`, non-object, missing step, a step that skips a version | defaults, `status: "reset"`, persist |
| only `site:` items (sync delivered partially) | current version with default globals |

Each migration is `RawDocument(vN) → RawDocument(vN+1)` on untyped data. After the last step, every field
is sanitised: invalid values fall back to the default (global) or are dropped (overrides), invalid hostnames
are dropped. Version 0 is the unversioned pre-release shape (flat globals under `settings`, bare-number pixel
sizes, sites nested in `settings.sites`); its migration exists and is tested so the hook is exercised from
day one. To change the schema: bump `SETTINGS_SCHEMA_VERSION`, add `MIGRATIONS[old]`, add a test with a stored
sample of the old shape. The service worker runs `ensureMigrated()` on `runtime.onInstalled` (install and
update); readers migrate in memory too, so a reader that wakes first never sees old data.

**Per-site resolution.** `resolveForSite(doc, hostname)`:

1. normalise the hostname (lowercase, trim, strip trailing dot; a URL is accepted and reduced to its host);
2. build the lookup chain from most to least specific, `a.b.example.com → b.example.com → example.com`.
   IP addresses and single-label hosts (`localhost`) only match themselves, and the walk never reaches a bare
   TLD;
3. start from `global` and apply each matching override from **least to most specific**, field by field
   (nested `customRect`/`windowSize` fields individually).

So an override for `example.com` applies to `www.example.com` and `m.example.com`, and a `www.example.com`
override can refine it. The result also lists `appliedOverrides` for the UI. There is no public-suffix list:
an override keyed `co.uk` would apply to all `*.co.uk` sites, but the UI only creates overrides for the
hostname of the current tab, so that cannot happen by accident. The popup writes overrides for the exact
hostname of the tab, and the options page lists and deletes them.

## 7. Permissions

```json
"permissions": ["storage"]
```

| Capability                          | How                                                   | Permission |
| ----------------------------------- | ----------------------------------------------------- | ---------- |
| Settings                            | `chrome.storage.sync`, `chrome.storage.session`       | `storage`  |
| Run on every page and frame         | `content_scripts.matches: ["<all_urls>"]`             | none extra (the install prompt shows "read and change all your data on all websites") |
| Resize/restore the window           | `chrome.windows.get/update`, `sender.tab.windowId`    | none |
| Browser fullscreen for the toggle   | `chrome.windows.update({ state: "fullscreen" })`      | none |
| Keyboard toggle                     | `commands` manifest key                               | none |
| Popup shows the toggle's shortcut   | `chrome.commands.getAll()`                            | none |
| Send the command to the active tab  | `chrome.tabs.query({ active: true })` → `tab.id`, `chrome.tabs.sendMessage` | none (`tabs` is only needed for `url`/`title`, which we do not read) |
| Popup knows the current site        | asks the tab's top-frame ISOLATED script (`get-site`) | none (no `activeTab`, no `tabs`) |
| ON/OFF toolbar icon per tab         | `chrome.action.setIcon({ tabId })`, `sender.tab.id` of the top frame's `site-state` (§5) | none |

Not requested: `host_permissions` (content scripts need none), `scripting` (static declaration suffices),
`tabs`, `activeTab`, `debugger`, `system.display`, `webRequest`. The extension makes no network requests and
has no remote code. The default MV3 extension CSP applies to the popup and options pages.

## 8. Known limits and risks

- **Screen vs viewport checks.** Some players decide "am I fullscreen?" by comparing `screen.width/height`
  with `innerWidth/innerHeight` or `outerWidth`. We do not fake `screen.*`, because that would break layout
  maths elsewhere, so such players may draw their non-fullscreen UI. Mitigation, if needed: an optional
  per-site `spoofScreen` flag that reports `screen.width/height` as the pinned rect while active.
- **`matchMedia("(display-mode: fullscreen)")`** and `@media (display-mode: fullscreen)` stay false. Rarely
  used by players.
- **Keyboard Lock API** (`navigator.keyboard.lock()`) only works in real fullscreen. Games and remote-desktop
  pages that lock Esc will not get the lock. We pass the call through, and it rejects or no-ops as the browser
  decides. Esc still exits fake fullscreen.
- **Pointer Lock** works independently of fullscreen and is unaffected.
- **Closed shadow roots.** Elements inside a closed shadow root are reachable only if the page passes them to
  `requestFullscreen` (which it does, so pinning works). `getRootNode()` from the element reaches the closed
  roots on its path, so their `:fullscreen` rules are mirrored too; other closed roots (for example a closed
  root attached to the fullscreen element itself) cannot be read. `ShadowRoot.fullscreenElement` of a closed
  root still works because the getter is on the prototype. Ancestor neutralisation walks via
  `getRootNode().host`, so it still crosses closed roots. An `<iframe>` inside a closed shadow root cannot be
  found by the parent's ISOLATED script (§4 step 3), which then drops the child's `frame-enter`: the child
  stays fake-fullscreen inside its own frame and nothing is pinned in the parent.
- **CSP has no effect on MAIN-world content scripts.** The page's Content-Security-Policy does not block
  our injected script, because it is injected by the browser, not by a `<script>` element. Our constructed
  stylesheet (`adoptedStyleSheets`) and inline `style` attribute changes made from script are also not
  subject to `style-src`. The flip side: our MAIN-world code runs with the page's privileges and must treat
  every page-provided value as hostile. Never `eval`, never call page-overridable methods (use captured
  originals).
- **Detectability.** A determined page can detect the shim: timing of events, `Symbol.for` marker, extension
  URLs in stack traces, the `data-cfs-*` markers and the backdrop div (visible to `MutationObserver`s),
  `navigator.userActivation` checks, or comparing `getComputedStyle` with expected UA fullscreen styles. The
  `Function.prototype.toString` disguise is per realm: a same-origin parent calling its own `toString` on a
  child frame's replacement sees its source. While fake-fullscreen, also: the `selectorText` of rules rewritten
  in place (§3), the replaced `CSSStyleSheet.prototype.insertRule` (disguised), the `getAnimations()` of an
  ancestor whose animations were taken off (§3), and `isTrusted: false` on every event the shim dispatches,
  including the change event of an adopted native-controls fullscreen. Acceptable for private use.
- **`document.open()`** erases a document's and its window's event listeners (HTML spec), including the private
  channel's and the ISOLATED script's, and Chromium does not inject content scripts again. A frame whose
  document is rewritten with `document.open()`/`write()` after injection (some `about:blank` embeds) keeps
  the patched prototypes, but its MAIN and ISOLATED worlds can no longer talk: a request before the first
  config passes through after 250 ms, and a frame chain from such a frame does not reach its parent.
- **Prefixed video fullscreen** (`HTMLVideoElement.webkitEnterFullscreen()` etc.) is gone from current Chromium
  (absent in 145). The layer handles it only where the browser still has it; it never adds it (§2).
- **Real-fullscreen toggle needs a user gesture.** `element.requestFullscreen()` requires transient user
  activation in the page, and a `chrome.commands` shortcut does not give one. So the toggle works like this
  (the service worker sends `command-toggle` to the top frame of the command's tab, `frameId: 0`):
  - **Fake fullscreen active** in the tab: the top ISOLATED script asks the service worker for
    `browser-fullscreen-enter`, which remembers the window's state (`BrowserFullscreenController`,
    `chrome.storage.session` key `browserFullscreen`) and calls `chrome.windows.update({ state:
    "fullscreen" })` (browser fullscreen, like F11); then it sends `go-real` and the MAIN layer re-pins the
    element to fill the tab. That looks like real fullscreen, and the page keeps believing it is in fullscreen.
    Toggling again sends `go-fake` (back to the configured size) and `browser-fullscreen-exit`, which restores
    the remembered state (`normal` returns to the normal bounds Chromium kept; a window that was already
    fullscreen is left alone). Leaving fake fullscreen while real also restores it, before the tab goes back from a
    pop-out (§5). Switching to another tab of the window does the same, and the tab gets
    `browser-fullscreen-released` (it goes back to the configured size, still fake-fullscreen).
  - **Nothing active**: the command flips `preferReal` for the tab, so the next page request goes to the real
    API (pass-through, §2). The top frame tells the service worker (`set-prefer-real`), which keeps it per tab
    in `chrome.storage.session` (key `preferReal`, so it survives navigation in that tab and is forgotten when
    the tab closes) and broadcasts `prefer-real-changed` to every frame of the tab; a new document asks for it
    with `tab-state` at start-up.
  - The popup's line under the site says which mode is armed for the tab (fake, or real because of the toggle
    or because the site is disabled), whether fake fullscreen is active and whether it was switched to real;
    its shortcut line names the key from `chrome.commands.getAll()` and what it does now.
- **Cross-origin stylesheets** cannot be mirrored (§3), and their `:not(:fullscreen)` rules cannot be rewritten
  in place, so such a rule keeps matching the fake-fullscreen element. The UA-equivalent rules and the player's
  own class toggling usually suffice.
- **Native video controls** (§2 "Native video controls"): the brief flash of real fullscreen before the element
  is pinned; and while focus is on a button of Chromium's own media controls (after the user clicks play or the
  seek bar in fake fullscreen, say), Chromium keeps key events inside the controls, so Esc reaches no listener,
  the extension's included, until focus leaves them (a click on the picture). Right after the adoption the
  extension moves focus off the fullscreen button for that reason.
- **Pages that toggle fullscreen on `resize`/`visibilitychange`**, or exit when `document.hidden`, behave as
  in real fullscreen. A pop-out is alone in its window, so tab switches elsewhere leave it alone (§5).
- **Site-specific players** may need per-site quirks. The patch layer is the only place for them, keyed by
  the resolved hostname. The YouTube black tab did not need one. Its cause, a request on the document root
  (§3 "Document-root requests"), is general, so the fix is in the styling layer for every page. Nor did the
  YouTube seek bar or the Twitch layout found in the live run (§3, "Site notes" below): no site has a quirk.
- **Containers in custom-rect are scaled.** A page that asks for fullscreen on `<html>` or on any container
  (not a `<video>`/`<iframe>`) is laid out at least viewport-sized and scaled onto the rectangle (§3), so its
  text and controls are drawn smaller, as on a smaller screen at the same resolution. When the rectangle's aspect
  ratio differs from the viewport's, a page that sizes its player with `100vh` (or `100vw`) leaves a thin band
  of its own background inside the rectangle. On real YouTube, 800×450 in a 1264×705 viewport gives a 4 px band
  below the player. While scaled, the page sees pointer positions, `getBoundingClientRect()` and
  `elementFromPoint()` in the element's unscaled space, so seek bars and tooltips work (§3 "One coordinate
  space"). Not converted: `getClientRects()`, `Range` rects, `IntersectionObserver` entries,
  `caretPositionFromPoint()`, and code that kept a reference to the original `getBoundingClientRect` from before
  the first scaled pin; a player that maps the pointer with those is off by the scale. fill-tab and
  pop-out are unaffected (scale 1).
- **Nothing of ours over a root-pinned video.** Chromium can composite anything we paint above the page's
  content as layers over its video. The clip-path'ed backdrop of a document-root pin was such a layer, and
  YouTube's video flickered black under it on mouse movement in Chrome on Windows (§3 "The video flickering
  black on mouse movement"). The root backdrop is now hidden in fill-tab and drawn as four strips around a
  custom rectangle, so nothing of ours is composited over the rectangle. The remaining limit: the overlay
  behaviour itself cannot be observed in the headless, software-composited test browser. The regression
  tests check the cause instead: zero writes during player activity, no backdrop layer over the video.
  Mutations that do not change what is pinned cost one cheap observer callback and no writes:
  - YouTube's control show/hide and tooltip insertions run the removal observer, whose `refresh()` compares
    the ancestor chain and returns;
  - writes to `<html>`'s custom properties run the style guard, which finds the pin intact.
- **Getters change one task early.** In Chromium 145, `document.fullscreenElement` (and the prefixed getters)
  are still `null` when `requestFullscreen()` / `webkitRequestFullscreen()` returns. Chromium sets them in a
  later task, before the promise resolves and before the change event. Exit works the same way. The shim
  changes them at the call (§2 step 5). This is kept on purpose: players read the state in the promise
  callback or the change handler, and from there on the fake and real Chromium agree (the e2e tests compare
  them, §9). Only a page that reads the getters in the same task as its own request or exit sees the new state
  early.
- **Window bounds Chromium will not set.** `chrome.windows.update` refuses bounds that are less than half on
  screen. A window that was mostly off-screen, or is larger than the screens left after a display change,
  cannot get its old size back. §5 restores what Chromium allows, and always restores the window state.
- **End-to-end coverage.** Every §9 end-to-end assertion runs in headless Chromium 145. No test is marked
  `test.fixme`. Two headless differences are handled in the harness, not in the extension:
  - Real element fullscreen does not change the headless window's state or size, so pass-through is detected
    from an unpatched isolated world.
  - The default headless screen is 800 × 600, so the harness sets a 1920 × 1080 screen that the
    1280 × 800 test window fits on.
  - On Windows a headless window has a 16 px frame (`innerWidth` = window width − 16), and 0 on Linux and
    macOS. Tests that compare the viewport with window bounds take `frameWidthOf()` off.

### Site notes (live compatibility run, 2026-10-25)

Run against real public pages, signed out, with the production build in Chromium 145 (managed Playwright 1.58.2
build, new headless, Windows), in fill-tab and in custom-rect 80 % × 80 %. Each control of the site's own player
was exercised in custom fullscreen and compared with real fullscreen on the same page (the extension switched off
for the site). The full per-check tables, screenshots and scripts are the run's `compat-report.md` and
`compat-evidence.zip`.

| Site (page tested) | Element the site asks for | Notes |
| ------------------ | ------------------------- | ----- |
| YouTube watch page | `<html>` (§3) | Everything matches real fullscreen in both sizes since the seek-bar fix (§3 "One coordinate space"). |
| YouTube embed in a third-party page | `<body>` in the iframe; the parent pins the `<iframe>` (§4) | In the test browser YouTube rendered the embed without any controls (no fullscreen button, `ytp-hide-controls`, also on `localhost` and with `controls=1`, extension not loaded), so it was entered with the player's own `f` shortcut. Shortcuts, clicks and exit match real fullscreen. |
| Twitch live channel and VOD | `div#root` (a container) | The player is a `position: fixed`, viewport-sized layer inside `div#root`; it covered the whole tab in a custom rectangle until containers were scaled like the root (§3 "Container players are scaled too"). |
| Twitch embed (`player.twitch.tv`) | a `div` in the iframe; the parent pins the `<iframe>` | On entering fullscreen, real or custom, the embed restarts its live stream paused at 0. Same as real fullscreen. |
| Kick live channel | a player `div` | Matches real fullscreen. Kick's own "Try 1080p / Not now" prompt was answered "Not now". |
| Facebook public video | a player `div` | Matches real fullscreen. A "See more on Facebook" login dialog appears after a few seconds; it was closed with its Close button. |
| Streamable | `div#player-<id>` | Matches real fullscreen. The cookie notice covers the fullscreen button until it is answered ("Your Privacy Choices", opt-out). |
| LinkedIn public video post (company page) | the video.js player `div` | Enter, play/pause, seek, double-click, exit and Esc match real fullscreen. Its mute, captions and playback-rate controls did nothing in real fullscreen either for the test runner, so they were not compared. |
| Instagram reel | — | The reel player has no fullscreen control: nothing to intercept. |
| TikTok, X, Reddit, Rumble, Vimeo, Dailymotion | — | Not tested: TikTok showed a login wall (after its Skip button, the next click opened a sign-up step); X answered "Access to x.com was denied" (HTTP 403); Reddit "You've been blocked by network security"; Rumble a Cloudflare bot check (HTTP 403); vimeo.com "Verify to continue"; Vimeo's embed loads but refuses playback ("Unable to play video. Please try again in a supported browser"); Dailymotion's player resources answer HTTP 403 and no `<video>` appears. Each was identical with the extension not loaded. Embeds of Twitch, Vimeo or YouTube inside Reddit or X could therefore not be reached either. |
| Netflix, Prime Video, Disney+, Max, Hulu | — | Not tested: they need accounts and DRM. |

None of these sites needed a per-site quirk. Headless limits apply to every row: real fullscreen cannot be left
with Esc there (the key goes to the page over CDP, not to the browser's handler), so Esc is only tested in custom
fullscreen, and compositing is in software, so a compositor-only effect like the YouTube flicker cannot be seen
(its causes are checked instead).

### Site notes (live compatibility run, 2026-10-30)

Run in Google Chrome 156 at main 315ff26, in fill-tab, custom-rect 80 % × 80 % and pop-out. Three bugs, each fixed
for every page, with an offline fixture and end-to-end test (§9):

| Site (page tested) | What happened | Fix |
| ------------------ | ------------- | --- |
| videojs.org (hero video at scroll 0) | The pinned `div.media-skin.media-container` was at the hero wrapper's offset (152, 144; with 80 %: 301, 230 instead of 148, 86), its control bar off screen: the wrapper's finished `fill-mode: both` transform animation kept it a containing block. | §3 "Animated ancestors" (`animated-ancestor.html`). |
| Loom share page | Pause, step, volume, time and "Exit full screen" were 0 × 0 in all three modes (only Esc got out): emotion's `.css-15mfcn7:not(:fullscreen) [data-hide-ifnot-fullscreen] { display: none }` kept matching. | §3 point 3 (`negated-fullscreen.html`). |
| archive.org video file opened directly | The fullscreen button of Chrome's built-in `<video controls>` entered real fullscreen; 80 % and pop-out were never applied. | §2 "Native video controls" (`native-controls.html`). |

## 9. Test plan

### Unit tests (vitest; `npm test`, part of `npm run validate`)

Environment: Node for pure modules; `happy-dom` (per-file `// @vitest-environment happy-dom`) for DOM code.

Scaffold:

- `tests/settings.test.ts`: defaults, migration of v0 / unknown / newer / corrupt data, hook step order,
  hostname normalisation, lookup chain, per-site resolution (exact, parent domain, precedence, no mutation),
  sanitising, storage layout.
- `tests/geometry.test.ts`: `computePinRect` for every mode, anchors, units, clamping.
- `tests/messages.test.ts`: frame-protocol validator accepts exact shapes and rejects extended or malformed
  ones; runtime message guards; `toShimConfig`.
- `tests/content.test.ts`: private channel handshake (either world first, attribute removed, queued until
  hello, element targets, foreign events ignored); the bootstrap routes to the patch layer; the no-op layer
  leaves the Fullscreen API untouched.
- `tests/popOut.test.ts`: pop-out and back with fake `chrome.windows`, `chrome.tabs` and storage: the first
  pop-out's corner position, the remembered placement and size, a changed size setting, a refused position,
  the original window gone (reopened with its bounds and maximized state), a second enter, a closed tab. The
  placeholder: opened at the tab's index, not active; the return goes to the placeholder's current place and
  removes it; the fallback when it was closed; closing the popup loads the page in it (once); nothing when it is
  gone too; no popup window means no placeholder. The popup window: a minimized one is shown (`normal`,
  focused); a refused remembered place falls back to the corner; window actions and resizes for the tab's own
  popup only; the 320 × 200 floor; one resize in flight, coalesced to the latest; the dragged size remembered.
  `tests/serviceWorker.test.ts` covers the same through the message handler and events (sender checks,
  `pop-out-return` from the placeholder page only, activity relayed to the top frame).
- `tests/popOutBar.test.ts` (happy-dom): the hover bar's buttons in a closed shadow root with their tooltips and
  accessible names; shown on activity and hidden 2 s after the last, kept while the pointer is over it or the
  grip is dragged; Full screen ⇄ Exit full screen (unchanged when the service worker refuses), Minimize, Pop
  back in, Esc's `leaveFullScreen`; the corner zone (in, out, its edges, beyond the viewport); the grip shown
  only with the bar and in the zone or during a drag, hidden at once out of it or when the pointer leaves the
  window; `pointer-events` on the grip only in its shown state; the grip's size from screen deltas, at least
  320 × 200, one request in flight and the rest coalesced to the latest; `remove()` takes everything away.
- `tests/manifest.test.ts`: runs the production build into `build/`, validates MV3 shape (MAIN world at
  `document_start` in all frames, ISOLATED world, module service worker, popup, options, only `storage`), and
  checks that every file the manifest and its HTML pages reference exists in `build/`. It also exercises the
  validator on bad manifests and checks the package zip layout.

To add with the real patch layer: added with it, in happy-dom. happy-dom 21 has no Fullscreen API (only
`ShadowRoot.prototype.fullscreenElement`, always `null`) and no `navigator.userActivation`;
`tests/helpers/fullscreenStubs.ts` installs Chromium-shaped originals (`requestFullscreen`, the `webkit*`
members, `exitFullscreen`, the getters, `UserActivation`) that record calls and simulate real fullscreen.

- every method/getter in §2 exists on the right prototype with the original attributes, `name`, `length`, no
  `prototype`, and native-looking `toString` (including `toString.toString()`): `tests/fullscreenLayer.test.ts`
  "API surface" (also: absent members stay absent, `uninstall()` restores everything);
- request → getters → promise → event order (microtask vs animation frame), prefixed vs unprefixed event
  type, bubbling and `composed` from inside a shadow root, retargeting of `document.fullscreenElement` and
  `shadowRoot.fullscreenElement`: "request and exit order";
- `fullscreenerror` + rejection for disconnected elements, `fullscreenEnabled === false`, no user
  activation; `exitFullscreen` when idle rejects: "errors";
- pass-through when disabled or `preferReal`: originals called with the same `this`/arguments, return value
  passed back: "pass-through" (also real fullscreen in progress, and the 250 ms hold both ways);
- style pinning and exact restoration of the element and neutralised ancestors; backdrop insertion/removal;
  `:fullscreen` rule mirroring (with a same-origin sheet, `@media` nesting) and `matches(":fullscreen")`:
  "styling" (also the custom rectangle, resize, the style guard; selector rewriting in
  `tests/selectors.test.ts`);
- element removal exits; Esc exits only while active and is not seen by page listeners: "exit paths" and,
  for Esc, `tests/isolatedController.test.ts` (fake frames, and once with the real layer and channel).

Also added:

- `tests/isolatedController.test.ts`: frame relay (validation of shape and source, ack and refusal for a
  missing `allowfullscreen` / `allow="fullscreen 'none'"` / disabled site, chain exit up, down and both ways
  over three frames, replacement), Esc and navigation, the top frame's pop-out wiring with the service
  worker (enter/exit, children and other modes never resize, release, exit while pending; the hover bar
  created while popped out and removed after, its buttons' messages, Esc leaving full screen first, the top
  frame's corner zone and window leave, a child frame's throttled `pop-out-activity` with `corner`, zone entry
  and exit sent at once) and the toggle
  command (go real / back, failure, arming `preferReal`, broadcast, start-up `tab-state`, release), and the
  toolbar's `site-state` (on load, when a settings change flips `enabled`, on a back/forward-cache
  `pageshow`, on prerender activation, never from a subframe; `get-site-state`).
- `tests/serviceWorker.test.ts`: `registerServiceWorker` with a fake `chrome`: the command goes to frame 0,
  message routing from `sender.tab` only, size clamping, browser fullscreen save/restore, the per-tab armed
  mode, releases on tab close / loading / activation of another tab / window close, and the toolbar icon (the
  sender's tab only, frame 0 only, the check after a crossed navigation, a closed tab, the toggle never
  changes it).
- `tests/popup.test.ts`: the popup's size choice (radio group; the default size stores nothing) and its
  fields for custom-rect and pop-out write per-field site overrides and show only for their size; a site
  with and without an override (Reset this site); a parent domain's override; labels; the tab-state and
  shortcut lines; the popup model helpers.
- `tests/options.test.ts` (also): every default control saves; only the chosen size's fields show; the site
  list's filter and Delete; the shortcut line and the shortcuts page; About; section order and labels; Reset
  all settings.
- `tests/brand.test.ts`: the built manifest's name, short name, description, toolbar title and version come
  from `src/shared/brand.ts` and `package.json`, the source manifest does not repeat them, the pages' titles;
  the build copies the committed icon PNGs (ON as the manifest's icons, OFF at 16/32 px as the toolbar
  default), each PNG has its SVG source, and the 128 px icon has 96 px artwork in 16 px of padding.
- `tests/store.test.ts`: `store/listing.md` (short description ≤ 132 characters and equal to the manifest's,
  no site names and no tested-sites list, single purpose, permissions, Edge fields, which images each store gets),
  the privacy pages (the plain and the styled one have the same text), the product page (the name, the credit, the
  support, privacy and GitHub links, no tested-sites list, every local reference is a file in `store/site/`, nothing loaded
  from another origin), the image sizes, and that `npm run store:assets` writes only the Edge logo.
- `tests/content.test.ts`, `tests/messages.test.ts`: the channel's shadow-root target, `go-fake`, and the new
  runtime message guards.
- With the end-to-end tests:
  - `tests/fullscreenLayer.test.ts` "errors": Chromium's check order and messages (§2 step 2).
  - `tests/options.test.ts`: the options page keeps a field the user is still editing when its own save
    echoes back, and still shows changes made elsewhere.
  - `tests/settings.test.ts`: `sameSettings`.
- With the document-root fix (§3):
  - `tests/geometry.test.ts`: `rootLayout` (scale 1 for a full-viewport rect; a smaller one is laid out at
    least viewport-sized at its aspect ratio and scaled onto it).
  - `tests/fullscreenLayer.test.ts` "document-root requests": the backdrop hidden in fill-tab (no
    clip-path), the scaled `<html>` and the backdrop with its four strips in its local coordinates in
    custom-rect, re-pinned on resize and hidden on a switch to fill-tab. Player activity (class toggles,
    tooltip insertions, spurious resizes) makes no `setProperty`/`removeProperty`/`setAttribute`/
    `removeAttribute` call. `backdropStrips` tile the viewport around the rectangle (never negative) and
    `holeCoversViewport` spots fill-tab. A plain backdrop below `<html>`. Page writes to `<html>`'s style are
    kept on exit and not counted against the re-apply budget. The scroll position is put back.
  - `tests/repo.test.ts`: `test:e2e` / `test:all` stay out of `validate`.
- With the live compatibility run of 2026-10-30 (§8 "Site notes"):
  - `tests/selectors.test.ts` "rewriteNegatedFullscreen": negated fullscreen pseudo-classes at any depth inside
    `:not()` become `:is(<pseudo-class>, <marker>)`, positive ones and strings, attributes and escapes do not.
  - `tests/fullscreenLayer.test.ts` "styling": the scan lists `:not(:fullscreen)` rules for the in-place rewrite
    (also inside `@media`), and a rule inserted with `insertRule` while active is mirrored (happy-dom's
    `selectorText` has no setter, so the rewrite itself is checked end to end).
  - `tests/fullscreenLayer.test.ts` "real fullscreen the page did not ask for": a trusted change event with a
    real video (or a container with one) is hidden, the original `exitFullscreen()` is called, the exit's event
    hidden, and the element is fake-fullscreen with one change event of the same prefix; again on the same
    element leaves; untrusted events, the page's own pass-through request, `preferReal`, a disabled site, an
    element without media and `goReal` stay real.
- With the live compatibility run (2026-10-25, §8 "Site notes"):
  - `tests/geometry.test.ts`: `rootSpace` and the conversions between screen and the scaled element's space.
  - `tests/fullscreenLayer.test.ts` "scaled document root: one coordinate space": while `<html>` is scaled,
    `getBoundingClientRect()` reports its unscaled space and `elementFromPoint()` takes it, only for connected
    elements and only while scaled; page-made events keep their values; a container is laid out
    viewport-sized and scaled like the root, a `<video>` and an `<iframe>` are not; the replacements are
    installed on the first scaled pin only, look native and are removed by `uninstall()`.

### End-to-end tests (Playwright; `npm run test:e2e`)

The extension runs loaded in a real Chromium, against fixture pages on two real origins. The tests are in
`tests/e2e/*.spec.ts`. Where real Chromium is the reference (error paths, prefixed events, element removal), a
test runs the same steps twice: once with the extension switched off in the options page (real Chromium) and
once with it on. It then requires both runs to give the same result.

- **Runner** (`playwright.config.ts`, fixtures in `tests/e2e/harness/extension.ts`).
  - `@playwright/test` (pinned to the version of the installed Chromium build).
  - Every test gets a fresh profile from `chromium.launchPersistentContext(tmpdir, { channel: "chromium",
    headless: true, viewport: null, args: ["--disable-extensions-except=build/", "--load-extension=build/",
    "--window-size=1280,800", "--screen-info={1920x1080}", "--autoplay-policy=no-user-gesture-required"] })`.
  - `channel: "chromium"` selects Chromium's new headless mode. Plain `headless: true` would pick
    `chromium-headless-shell`, which cannot load extensions.
  - `viewport: null` lets the page follow the window, so pop-out and browser fullscreen change what the
    page sees.
  - The screen is bigger than the window, as on a desktop, because Chromium refuses window bounds less than
    half on screen.
  - `globalSetup` (`tests/e2e/global-setup.ts`) runs `npm run build` first.
  - The extension id comes from the service worker's URL, so tests open `ui/options.html` and `ui/popup.html`
    directly.
  - The fixture waits for `runtime.onInstalled` to store the default settings before a test writes its own.
  - Four workers run in parallel.
- **Fixture origins** (`tests/e2e/harness/server.ts`).
  - Every browser context answers requests to `http://127.0.0.1:<p1>` and `http://localhost:<p2>` from
    `tests/e2e/fixtures/` itself (`BrowserContext.route`), so no request opens a connection. A loopback HTTP
    server used to serve them, and on the Windows test host loopback connections to it sometimes timed out or
    were reset; the frame then showed Chromium's error page, where no content script runs. Nothing listens on
    the two ports.
  - `__ORIGIN_A__` / `__ORIGIN_B__` in served files are replaced by the two origins, so the embeds are really
    cross-origin and cross-site (out-of-process iframes).
  - Nothing touches the network.
  - `openFixture` waits up to 20 s, well inside the 45 s test timeout, for every frame to be ready: the
    fixture's script finished, the MAIN-world script ran and the MAIN <-> ISOLATED handshake completed. If a
    frame is not, `waitForFixture` throws `fixture not ready: <url> ...` with the frame's load state and the
    conditions that failed. It evaluates nothing in the page before `DOMContentLoaded`: Playwright runs every
    evaluate with a user gesture, and one that reached a document still parsing gave its scripts transient user
    activation (the no-gesture request on load then sometimes succeeded). That test checks
    `navigator.userActivation.isActive` is false at the request.
  - The test video is a canvas animation captured with `captureStream()`.
  - `fixture-log.js` gives every fixture `window.__log`: requests, promise results, every fullscreen event,
    page `keydown`/`keyup` and `resize`, each with the getter values at that moment.
- **Seeing past the patch.** Tests do not trust the page's own getters for the browser's state:
  - Real fullscreen is read from a fresh CDP isolated world (`Page.createIsolatedWorld`), whose prototypes the
    MAIN-world shim never touched. Frames are reached through their own CDP sessions.
  - Window bounds and state come from CDP `Browser.getWindowForTarget` / `Browser.getWindowBounds`.
  - Pixels come from a 1 × 1 screenshot, decoded with a small PNG decoder (`tests/e2e/harness/png.ts`).
  - Expected rectangles are computed from the spec (`tests/e2e/harness/geometry.ts`), not from
    `src/shared/geometry.ts`.
- **Fixtures and what is asserted:**
  1. `plain-video.html` (`plain-video.spec.ts`):
     - fill-tab: the browser is not fullscreen, judged three ways: the isolated-world probe,
       `matchMedia("(display-mode: fullscreen)")` false, and `outerWidth`/`outerHeight` and the CDP window
       state unchanged. Meanwhile every getter (and `:fullscreen` matching) reports the video.
     - Order: request, then promise (with the getters set), then `fullscreenchange` on the video, then
       `resize`. The rect equals the viewport.
     - Esc exits: getters reset, exactly one change event, neither `keydown` nor `keyup` reaches the page, the
       `style` attributes of the element and all ancestors are identical to before, and the backdrop is gone.
       Afterwards Esc is the page's again.
     - `exitFullscreen()`: promise, then event. Exiting again rejects.
     - custom-rect, set through the options page and then the fixture reloaded, five size/unit/anchor
       combinations: `getBoundingClientRect()` equals the expected rect, a pixel outside it equals
       `backgroundColor`, and the backdrop takes the click. fill-tab is set through the options page too.
     - Error paths compared with real Chromium: a request on load without a gesture, disconnected (also
       prefixed), SVG `<rect>`, MathML `<math>`, `<dialog>`, modal `<dialog>`, bad `navigationUI`, idle
       `exitFullscreen()`. Element removal is compared the same way.
     - `exitOnEscape` off: Esc reaches the page and does not exit.
  2. `container-player.html` (`container-player.spec.ts`):
     - The feature check (`requestFullscreen.toString()`, `Function.prototype.toString`, name, length,
       descriptor, getter source) equals the same probe in an unpatched world.
     - The `div.player` escapes its `transform: translateZ(0)` + `overflow: hidden` + `z-index: 1` wrapper:
       it fills the viewport and covers the fixed `z-index: 1000` masthead.
     - The page's `.player:fullscreen` rules apply, and the player's `fullscreenchange` handler toggles its
       class.
     - Esc restores every `style` attribute, `adoptedStyleSheets` and the rules.
     - custom-rect: the page's `::backdrop` colour does not replace `backgroundColor`. The regression for
       Twitch: a layer of the player that is `position: fixed` and `100vw` × `100vh` in fullscreen stays inside
       the rectangle (before the fix it covered the whole tab), and the player is laid out viewport-sized in its
       own space.
     - Shadow-DOM variant: `document.fullscreenElement` is the host, `shadowRoot.fullscreenElement` is the
       player, the composed change event reaches the document, the shadow `:fullscreen` rules apply, and
       everything is restored exactly.
  3. `embed-parent.html` (origin A) with `embed-child.html` (origin B) in an `allowfullscreen` iframe and in
     one without; the nested `embed-nested.html` (A) → `embed-middle.html` (B) → `embed-child.html` (A)
     (`frames.spec.ts`):
     - The parent's `fullscreenElement` is the iframe, pinned to the viewport. The child's video fills the
       frame. Each document gets exactly one change event on enter and one on exit. Nothing is really
       fullscreen in either document.
     - Esc with focus in the child, and Esc with focus in the parent, both exit the chain and restore the
       styles.
     - The iframe without `allowfullscreen` gets the same rejection ("Disallowed by permissions policy") and
       `fullscreenerror` as real Chromium, and the parent is untouched.
     - Nested chain: every level is pinned. Esc in the innermost, the middle and the top frame each exit all
       three documents.
     - custom-rect in the top document with a pixel check; pop-out started from the child frame.
  4. `webkit-player.html` (`webkit-player.spec.ts`):
     - `webkitRequestFullscreen` gives the same return value, `webkitfullscreenchange` only (no unprefixed
       event), the same prefixed getters and the same `:-webkit-full-screen` styling as real Chromium.
     - The prefixed members Chromium 145 lacks (`video.webkitEnterFullscreen` and friends) stay absent, equal
       to an unpatched world.
     - The video's own prefixed request, then `webkitCancelFullScreen`, restores it.
  5. `root-player.html` (`root-player.spec.ts`), the offline regression for the YouTube black tab: a
     watch page (no YouTube code) whose button calls `document.documentElement.requestFullscreen()`, whose
     `fullscreenchange` handler sets `[fullscreen]` and `body.no-scroll` and sizes the player with `100vh`, and
     which keeps writing a custom property on `<html>`:
     - fill-tab: `fullscreenElement` is `<html>` and nothing is really fullscreen. The player fills the
       viewport, `elementFromPoint` at the centre is the video (it was the backdrop before the fix), the
       centre pixel is the video's colour, and the play control is hit and works. Esc restores styles,
       classes, markers, sheets and the scroll position, and keeps the page's own `<html>` style write.
     - custom-rect 640×360: `<html>` covers the rectangle exactly, the `100vh` player fits it (scaled), the
       video is on top at the centre, the backdrop colour and the clicks are outside, the controls are inside
       and work, and the page's exit button restores the page.
     - `root-player-activity.spec.ts` (`root-player.html?activity`), the offline regression for the video
       flicker: on every mouse move the page shows its controls, changes an attribute and inserts a tooltip,
       and hides them 120 ms later or on `mouseleave`, as YouTube does. An init script counts the extension's
       DOM writes by the `chrome-extension://` URL on the stack. During about 3 s of moving over the video,
       along it and on and off it, in fill-tab and custom-rect, there are 0 style, marker (neutralise/
       restore), attribute and sheet writes. In fill-tab the backdrop is `display: none` and has no layer
       (CDP `LayerTree`). In custom-rect the backdrop box has no drawing layer, no strip layer intersects the
       video, and the four strips lie outside the rectangle. Against the old clip-path backdrop, both tests
       fail.
     - custom-rect 80 % × 80 %, the regression for YouTube's seek bar: the fixture's seek bar maps the pointer
       with `(clientX − getBoundingClientRect().left) / offsetWidth`, as YouTube's does. A click at 25 % and a drag
       from 30 % to 60 % on screen land at 25 % and 60 % (before the fix: 20 % and 48 %), a tooltip placed
       (`position: fixed`) from a button's `getBoundingClientRect()` sits on that button, and after exit the
       page measures the screen again.
     - Screen geometry in these tests comes from the browser (`screenRectOf`: Playwright over CDP, and
       `hitAtScreen`: an unpatched isolated world), because the page measures in the scaled element's space.
  6. The live run of 2026-10-30 (§8 "Site notes"), one fixture per bug, each test failing before its fix:
     - `animated-ancestor.html` (`animated-ancestor.spec.ts`), for videojs.org: the player inside a hero wrapper
       with a finished `fill-mode: both` entrance animation (`hero-video-in`) lands at the viewport in fill-tab
       (before: at 152, 144) with its control bar on screen; after Esc the wrapper's animation is the same
       finished one at the same `currentTime`, with the same computed transform and no further animation event
       (no replay), and every `style` attribute is as before. `?running`: a 120 s animation still running lands
       at the 80 % rectangle and, after exit, is the same running animation further along its timeline, never
       restarted or cancelled. An animation started on the wrapper while pinned is taken off (the player stays
       at the viewport) and is back after exit.
     - `negated-fullscreen.html` (`negated-fullscreen.spec.ts`), for Loom: rules inserted with `insertRule` after
       load, `.css-15mfcn7:not(:fullscreen) [data-hide-ifnot-fullscreen] { display: none }` (and the
       `:-webkit-full-screen` twin): in fake fullscreen Pause and "Exit full screen" show (before: 0 × 0) and
       work, the normal bar does not, and a `:not(:fullscreen)` rule the page inserts from its
       `fullscreenchange` handler applies too; after exit they are hidden again and the page reads back every
       original `selectorText`; the same on a second enter.
     - `native-controls.html` (`native-controls.spec.ts`), for a video file opened directly: a click on the
       fullscreen button of Chromium's built-in controls (found in the accessibility tree) ends fake (before:
       really fullscreen, no markers), the page sees one `fullscreenchange` and `resize`, Esc leaves, the button
       on the fake-fullscreen video leaves, nothing loops; custom-rect 80 % gives the rectangle; after the toggle
       armed real fullscreen, and with the extension off, the same click stays really fullscreen.
- **pop-out** (`pop-out.spec.ts`), with the window size set through the options page; windows and tabs are read
  with `chrome.windows.getAll` in the service worker, by tab id:
  - On enter, the tab moves into a popup of the set size, alone; the element fills it and the video keeps
    playing; the browser window's bounds don't change.
  - A placeholder tab holds the old index while the tab is out, inactive, titled "Popped out: <page title>".
  - Esc puts the tab back in its window at its old index, the popup closes and the placeholder is gone.
  - "Bring it back" on the placeholder pops the video back in, to where the placeholder was dragged.
  - Closing the popup window loads the page in the placeholder's tab, at the old place.
  - The next pop-out opens where the last one was dragged to.
  - Navigating puts the tab back; a window it was the only tab of stays open with the placeholder, untouched.
  - Switching tabs in the browser window leaves the pop-out playing.
  - The hover bar (read through CDP's accessibility tree and box model: it is in a closed shadow root): hidden at
    first, shown on pointer movement with Pop back in, Full screen and Minimize at the top centre, hidden again
    about 2 s later (not sooner), kept while the pointer rests on it.
  - Full screen / Exit full screen / Minimize change the popup's `state` as `chrome.windows.getAll` reports it
    (headless reports `fullscreen` and `minimized`); Esc in full screen goes back to `normal` and stays popped
    out; Pop back in puts the tab back at its index and removes the bar.
  - Dragging the grip resizes the popup by the drag (from its bottom-right corner, position unchanged), never
    below 320 × 200; the dragged size is remembered and the next pop-out opens at it.
  - The grip (its host's `data-grip`, and `document.elementFromPoint` at the corner): with the pointer in the
    middle the bar shows and the grip does not, and the corner is the video's; in the zone it shows, 57 px out
    it hides at once while the bar stays; resting on it keeps it; out of the window past the corner it goes.
  - The demo player's own fullscreen button, in the corner, partly under where the grip is drawn: with the bar
    showing, `elementFromPoint` there is the button, and a real click on it reaches the player (it leaves
    fullscreen, which pops the tab back in).
  - `frames.spec.ts`: pointer movement over the cross-origin iframe's video (seen only by the child frame)
    shows the top frame's bar; the child draws none; the bar's Pop back in ends the chain. Over the iframe the
    corner shows the grip and the middle does not (back to the middle within the throttle hides it), and
    dragging the grip resizes the popup.
  - Both files wait up to 15 s for popup windows (`expect.configure`): on a busy host the service worker's
    `chrome.windows` calls took longer than the default 5 s.
- **Per-site override** (`per-site.spec.ts`):
  - The popup is opened as `ui/popup.html` in a background tab of the fixture's window, so its
    `tabs.query({ active, currentWindow })` finds the fixture tab as the real popup would.
  - Unchecking the popup's on/off switch stores `site:127.0.0.1`. Fixture 1 then enters real fullscreen, live
    and after a reload: the isolated world sees it, there are no markers or backdrop, the inline style is
    untouched and `:fullscreen` matches natively.
  - The same fixture on `localhost` is still faked.
- **Popup and options page** (`ui.spec.ts`):
  - The popup by keyboard only: Tab to the switch and Space; Tab into the size group and the arrow keys; the
    custom size fields by Tab. Only the chosen size's fields show; each change is stored as the site's
    override, and the page's next fullscreen uses the new custom size, live.
  - A site with an override shows it and **Reset this site** (Enter) drops it; another origin shows no reset
    link.
  - The options page by keyboard and accessible names: the on/off switch, the size group with its fields,
    backdrop colour and Esc each save; the site list's filter and Delete; the shortcut and About.
  - `demo-player.html` (a plain player with its own controls): it fills the tab and its own play/pause and seek bar
    keep working; Esc leaves.
- **Command toggle** (`toggle.spec.ts`). Playwright cannot press extension shortcuts, so the test does what
  `chrome.commands.onCommand` does: from the service worker, `chrome.tabs.sendMessage(tabId, { type:
  "command-toggle" }, { frameId: 0 })`, with the tab id of the active tab of the page's CDP window.
  - During fake fullscreen the window state becomes `fullscreen`, the element fills the tab, and the page
    sees no event.
  - Toggling again restores the window bounds exactly and the custom rect.
  - Esc while toggled restores the window. So does a tab switch, after which the tab keeps its rect.
  - With a cross-origin frame chain, the iframe fills the tab.
  - While idle, the toggle arms real fullscreen for the tab (stored in session storage, kept across a reload).
    Toggling again arms the fake.
- **Toolbar icon** (`toolbar-icon.spec.ts`). Chromium cannot read an action's icon back (there is no
  `chrome.action.getIcon`, and headless Chromium draws no toolbar). So the test records the service worker's
  `setIcon` calls, with whether each one succeeded, and the `site-state` messages it receives. A call that
  fails counts as no icon shown.
  - Only the top frame of a page with cross-origin frames reports.
  - A site switched off, then reset, changes that tab's icon, and another tab keeps its own.
  - A tab-specific title survives `pushState` but is reset by a new document, a browser page or a
    back/forward-cache restore.
  - The restored page reports again. That test keeps the cache on (the `backForwardCache` fixture option drops
    Playwright's `--disable-back-forward-cache`) and uses `plain-page.html`, because the video fixtures' canvas
    stream keeps a page out of the cache.
- **Artifacts.** For a failing test the context fixture writes these into `test-results/<test>/`
  (gitignored): `page-<n>.png` per page, a Playwright `trace.zip`, and `page-<n>-log.json` with every frame's
  `window.__log`.
- **Scripts.** `npm run test:e2e` (`playwright test`) runs the suite. `npm run test:all` runs `npm run
  validate`, then `npm run test:e2e`. The e2e tests stay out of `npm run validate` because they need a
  Chromium build matching `@playwright/test` (`npx playwright install chromium`, or `PLAYWRIGHT_BROWSERS_PATH`
  pointing at one). Vitest only collects `tests/**/*.test.ts`, Playwright only `tests/e2e/**/*.spec.ts`. The
  e2e TypeScript is type-checked by `npm run type-check`; the fixture pages under `tests/e2e/fixtures/` are
  plain page scripts and excluded from it.

## 10. Build, scripts and decisions

- **Toolchain.** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), esbuild,
  vitest + happy-dom, npm with a committed `package-lock.json`, Node ≥ 20 (`.nvmrc` pins Node 22 for development).
- **Manifest location.** `manifest.json` lives at the repo root as the hand-edited source of truth, with
  paths relative to `build/`, except for the name, short name, description, toolbar title and version:
  `npm run build` writes those from `src/shared/brand.ts` and `package.json` (and refuses a source manifest
  that sets them, so each has one source), replaces `%BRAND_NAME%` in the pages, and fails the build if `scripts/validate-manifest.mjs` finds a problem (MV3 shape or a
  referenced file missing, including scripts, styles and images referenced by the HTML pages).
- **Bundles** (`scripts/build.mjs`, target `chrome111`): the service worker as ESM (`"type": "module"`), and
  the content scripts and UI pages as IIFE (content scripts cannot be modules). One bundle per entry
  point, no code splitting, so every file is self-contained. Minified, no source maps in production;
  `npm run build:dev` builds unminified with inline source maps.
- **Icons.** ON is design 5b from icon round 8, used exactly as delivered. OFF is option A from round 9
  (`design/icons-v9`): the same window with a small video in it, instead of the round-8 watch-page wireframe,
  whose detail didn't read at toolbar size.
  - Their SVG sources are in `src/icons/svg/`: the 1024 px ON master and separate 16, 32, 48 and 128 px ON
    drawings, and the 16 and 32 px OFF drawings (OFF is only a toolbar icon). The 16 and 32 px ones are
    pixel-snapped, not scaled copies.
  - The PNGs the extension ships are committed in `src/icons/`: ON `icon-{16,32,48,128}.png` (the manifest's
    `icons`, for the stores, install and the extensions page) and OFF `icon-off-{16,32}.png` (the toolbar's
    `action.default_icon`).
  - The 128 px icon is 96 × 96 artwork centered in 16 px of transparent padding, as the stores ask.
  - The build copies the PNGs into `build/icons/` and renders nothing.
  - `npm run icons` (`scripts/render-icons.mjs`) re-renders the PNGs from their SVGs with Playwright's
    Chromium at deviceScaleFactor 1, the way the artwork's exports were made. It reproduces the delivered
    PNGs byte for byte in Chromium 145.0.7632.6 on macOS; Windows antialiases slightly differently. The OFF
    PNGs were rendered on Windows. `npm run icons -- --check` compares pixels instead of writing.
  - Which tab shows which state is in §5.
- **Store kit.** `store/` holds the listing copy, the privacy policy, the product page and the images.
  - Designed assets, approved by the owner and committed as files: the six 1280 × 800 screenshots
    (`store/screenshots/`; the Chrome Web Store takes five, so Chrome gets 1-5 and Edge all six), the 440 × 280
    promo tile, the 1400 × 560 marquee (Chrome's marquee promo tile) and the product page `store/site/`. They were
    made outside the repo from real Chrome captures; nothing in the repo regenerates them, and a change is a new
    approved file.
  - The product page (`store/site/`, live at https://avorforge.com/full-window/ at launch) has its own
    stylesheet, script, Inter and `assets/` (webp, png and svg images, the hero video and the Open Graph image),
    and loads nothing from another origin: absolute URLs are only in `<meta>`, the canonical `<link>`, JSON-LD
    and plain links. Its icon `assets/icon.svg` is the ON master SVG. `store/site/privacy.html` is the privacy
    policy styled like the page; `store/privacy.html` is the plain version with the same text.
  - `npm run store:assets` (`scripts/store-assets.mjs`) only renders the 300 × 300 Edge logo: the ON master SVG
    as 240 px artwork in 30 px of padding, drawn by Playwright's Chromium at deviceScaleFactor 1 like
    `npm run icons`. Antialiasing and gradient dithering differ a little between hosts, so a logo rendered on
    another host isn't byte-identical to the committed one (on Linux, Chromium 145.0.7632.6: 17 % of the
    channels differ, 92 % of those by 1, the rest along the rounded edges).
- **UI styling.** The popup and the options page share `src/ui/ui.css`, the owner-approved "Graphite" design:
  a pure `#FFFFFF` page in light mode and pure `#000000` in dark, with the owner-approved Level 2 colors on top.
  The colors are custom properties on `:root` that switch with the system theme under
  `@media (prefers-color-scheme: dark)` (no `data-theme` attribute, no in-page switch). The selected size
  option uses `--accent`, black in light mode and white in dark. Switches are green when on (`--switch-on`,
  `#34C759` / `#30D158`) and red when off (`--switch-off`, `#FF3B30` / `#FF453A`); the dot before the popup's
  state line uses the same two colors. *Reset this site*, *Delete* and *Reset all settings* have red text
  (`--destructive`, `#E9152D` / `#FF6165`), the shortcuts-page button blue text (`--action`), and the keyboard
  focus ring is blue (`--focus`, `#1E6EF4` / `#5CB8FF`); those colored labels sit on a solid backing so they
  stay above 4.5:1. On the options page five 24 px colored tiles with drawn 16 px SVG glyphs (`.settings-tile`
  with `.tile-size`, `.tile-color`, `.tile-escape`, `.tile-shortcut`, `.tile-about`, `aria-hidden`) lead the
  Default size, Backdrop color, Esc exits, Keyboard shortcut and About rows; the Sites filter has no tile and
  lines up with the site names below it. None of this comes from a CSS `filter`. Controls
  are "Liquid Glass" capsules: translucent fills with a bright inset rim, a small depth shadow and
  `backdrop-filter: blur(16px)` on the buttons, the closed `<select>` faces (with an SVG chevron next to each in
  the HTML; the open menus stay browser-drawn) and the segmented size control, whose chosen option is a raised
  lens. Every `<button>` is such a capsule, including *Settings*, *Reset this site* and the shortcuts-page button,
  which used to look like links (they keep the `link` class and their behavior). The options page lays each
  section out as an inset group of rows (`.group`, `#F7F7F7` / `#1E1E1E`, 16 px corners). Page-specific layout
  stays in each page's `<style>`; the popup is 320 px wide whatever the viewport. The popup has no panel
  or outline of its own, because Chrome and Edge draw the popup window square.
  Switches and the size options change color in 120 ms and the switch knob slides in 140 ms (`transition`);
  nothing else moves.
  `prefers-reduced-transparency: reduce` swaps the glass for solid fills and drops the blur, depth shadows and
  lens; `prefers-reduced-motion: reduce` turns the transitions off and keeps pressed buttons and the chosen
  option from shifting or scaling. (The store-kit test forbids gradients, glow and animations in the extension
  pages and the plain `store/privacy.html`, and any transition in that privacy page; the extension pages may only
  have transitions of 200 ms or less, with that reduced-motion override. The owner-approved product page in
  `store/site/` is exempt.)
- **Font.** Inter 4.1 (SIL Open Font License 1.1), a Latin subset with variable weight 400–600:
  `src/ui/fonts/inter.woff2` (24,184 bytes) and its license `src/ui/fonts/OFL.txt`, copied by the build to
  `ui/fonts/` and packaged. `ui.css` loads it with `@font-face` from the extension's own file, never the web.
  Both pages preload it (`<link rel="preload" … crossorigin>`) and the face uses `font-display: block`, so the
  popup's first paint is already in Inter rather than switching from a fallback font while it opens.
- **Package.** `npm run package` builds, then zips `build/` into `dist/full-window-not-screen-video-sizer-<version>.zip`
  with `manifest.json` at the zip root, fixed timestamps (reproducible), using `fflate`.
- **Scripts.** `build`, `build:dev`, `type-check` (`tsc --noEmit`, includes the `.mjs` build scripts via
  `checkJs`, the e2e tests and `playwright.config.ts`), `test` (`vitest run`), `validate` (type-check + test),
  `test:e2e` (`playwright test`, §9), `test:all` (`validate`, then `test:e2e`), `package`, `store:assets`,
  `icons` (re-render the icon PNGs).
- **CI.** There is no GitHub Actions workflow (nothing under `.github/workflows/`); the tests are run
  locally before each push. `npm run validate` is the gate that needs no browser: `tsc` strict type-check plus
  every unit test, and the manifest tests run the production build into `build/`, validate the MV3 manifest
  and every referenced file, and zip `build/` the way `npm run package` does. `npm run test:all` adds the
  end-to-end tests in Chromium (§9). Both rebuild `build/`, so run them one after the other, not in parallel.
