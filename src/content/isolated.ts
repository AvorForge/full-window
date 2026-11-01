/**
 * ISOLATED-world content script entry (document_start, all frames).
 *
 * Wires chrome.* to the frame's IsolatedController: settings from
 * chrome.storage.sync, messages from the service worker and the popup, and
 * requests to the service worker. The logic lives in isolatedController.ts.
 */

import { isToContent, type ToServiceWorker } from "../shared/messages";
import { loadSiteSettings, onSettingsChanged } from "../shared/settingsStore";
import { openPageChannel } from "./channel";
import { createIsolatedController, parentOrigin, topLevelHostname } from "./isolatedController";

const isTopFrame = window === window.top;

const hostname = topLevelHostname(location, isTopFrame);

const controller = createIsolatedController({
  window,
  document,
  channel: openPageChannel("isolated"),
  isTopFrame,
  hostname,
  parentOrigin: parentOrigin(location),
  sendToServiceWorker: (message: ToServiceWorker) => chrome.runtime.sendMessage(message),
});

// Only this site's settings: the global ones and its own overrides, not every site's.
void loadSiteSettings(hostname).then((result) => controller.applySettings(result.document));
onSettingsChanged((doc) => controller.applySettings(doc), hostname);

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isToContent(message)) return false;
  const reply = controller.handleRuntimeMessage(message);
  if (reply === undefined) return false;
  if (reply instanceof Promise) {
    void reply.then(sendResponse, () => sendResponse({ handled: false }));
    return true; // async response
  }
  sendResponse(reply);
  return false;
});
