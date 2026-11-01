import type { PageMessage } from "../shared/messages";
import { openPageChannel, type PageChannel } from "./channel";
import type { FullscreenPatchLayer } from "./patchLayer";

const INSTALLED = Symbol.for("custom-full-screen.main-world");

export interface MainWorldHandle {
  channel: PageChannel;
  layer: FullscreenPatchLayer;
}

/**
 * Installs `layer` in this frame and routes ISOLATED-world messages to it.
 * Returns null if the script already ran in this window (about:blank re-use).
 */
export function bootstrapMainWorld(
  win: Window & typeof globalThis,
  layer: FullscreenPatchLayer,
): MainWorldHandle | null {
  const marker = win as unknown as Record<symbol, unknown>;
  if (marker[INSTALLED]) return null;
  Object.defineProperty(win, INSTALLED, { value: true });

  const channel = openPageChannel("main", win.document);
  layer.install({ window: win, notify: (message, target) => channel.post(message, target) });

  channel.onMessage((message: PageMessage, target) => {
    switch (message.type) {
      case "config":
        layer.configure(message.config);
        break;
      case "exit":
        layer.exit(message.reason);
        break;
      case "go-real":
        layer.goReal();
        break;
      case "go-fake":
        layer.goFake();
        break;
      case "enter-frame-element":
        if (target instanceof win.Element) layer.enterFrameElement(target, message.requestId);
        break;
      default:
        break;
    }
  });
  return { channel, layer };
}
