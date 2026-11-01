# Store listing: Full Window, Not Screen: Video Sizer

Copy for the Chrome Web Store and Microsoft Edge Add-ons. The name and the short description are also in
`src/shared/brand.ts`, which the build writes into the manifest; keep them the same here. Images:
`store/screenshots/` (1280 × 800), `store/promo-tile-440x280.png` and `store/marquee-1400x560.png` are
owner-approved designed files, committed as they are; `npm run store:assets` makes `store/edge-logo-300x300.png`.

## Title

Full Window, Not Screen: Video Sizer

## Short description

At most 132 characters (the manifest description; the Chrome Web Store shows it as the summary).

Keeps a video's fullscreen inside the tab, at a size you choose. The site's own player controls keep working.

## Long description

When you press a video player's fullscreen button, the extension keeps the video inside the browser tab
instead of taking over the screen. The page still believes it is fullscreen, so the site's own player controls
keep working: play and pause, seeking, volume, captions, quality and the player's exit button. Picture-in-picture
shows only the browser's own controls; here you keep the site's player.

Choose the size:
- Fill tab: the video covers the page area of the tab.
- Custom size: a width and height in pixels or percent of the tab, placed at an anchor (center, a corner or an edge).
- Pop out: the video's tab moves into its own small window you can put anywhere, and goes back when you leave.

Esc leaves. Alt+Shift+F switches between fullscreen inside the tab and the browser's real fullscreen; you can
change the key in the browser's shortcuts page. Settings apply to every site, and any site can have its own
from the toolbar button.

Tested with the players on YouTube, Twitch, Kick, Facebook, Streamable and LinkedIn.

Small: about 85 KB, about 1 MB of memory per tab, and no extra work while the video plays.

Privacy: no data collected, no network requests, no account. Settings are kept in the browser's own
extension storage, which the browser may sync to your other devices.

## Single purpose

Keeps a web page's fullscreen request (usually a video player's) inside the browser tab, at a size the user
chooses.

## Permission justifications

- Access to all sites (content scripts on all URLs): to intercept fullscreen requests in pages, including
  players embedded from other sites in frames. The scripts read and send nothing.
- storage: to save settings (the default size, backdrop color, Esc, and each site's own settings).

Remote code: none. All code is in the package.

Data use (Chrome Web Store privacy practices): no user data is collected or used. Tick none of the data
categories, and certify the three statements (not sold to third parties, not used or transferred for purposes
unrelated to the single purpose, not used for creditworthiness or lending).

## Chrome Web Store fields

- Category: Make Chrome Yours › Functionality & UI
- Language: English
- Privacy policy URL: where `store/privacy.html` is hosted
- Homepage URL: where `store/site/index.html` is hosted
- Support URL: https://avorforge.com/
- Contact email: inquiries@avorforge.com
- Screenshots: `store/screenshots/1-5` (the Chrome Web Store takes five)
- Small promo tile: `store/promo-tile-440x280.png`
- Marquee promo tile: `store/marquee-1400x560.png`

## Microsoft Edge Add-ons fields

- Display name: Full Window, Not Screen: Video Sizer
- Short description: the short description above
- Description: the long description above
- Category: Productivity
- Search terms: fullscreen, video, tab, window, player, video size, theater mode
- Privacy policy: required, because the extension runs on all sites; the URL where `store/privacy.html` is hosted
- Website URL: where `store/site/index.html` is hosted
- Support contact: inquiries@avorforge.com, https://avorforge.com/
- Store logo: `store/edge-logo-300x300.png`
- Small promotional tile: `store/promo-tile-440x280.png`
- Screenshots: all six files in `store/screenshots/`
- Mature content: no
- Notes for certification: no account or test credentials are needed. Open any page with a video, press the
  player's fullscreen button, and the video fills the tab; Esc leaves. The toolbar button sets the size for
  the site.
