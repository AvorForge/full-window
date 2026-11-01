/**
 * Background service worker (module). Owns everything that needs privileged
 * APIs: settings migration, the chrome.commands toggle, pop-out mode and
 * browser fullscreen. No network access, no telemetry. The logic lives in
 * serviceWorkerCore.ts.
 */

import { registerServiceWorker } from "./serviceWorkerCore";

export { TOGGLE_COMMAND } from "./serviceWorkerCore";

registerServiceWorker(chrome);
