/**
 * MAIN-world content script entry. Runs at document_start in every frame,
 * before page scripts, so the Fullscreen API can be patched before players
 * capture references to it. No chrome.* APIs are available here.
 */

import { createFullscreenPatchLayer } from "./fullscreenLayer";
import { bootstrapMainWorld } from "./mainWorldBootstrap";

bootstrapMainWorld(window, createFullscreenPatchLayer());
