/**
 * The seam between the MAIN-world entry point and the Fullscreen API shim.
 *
 * main-world.ts owns start-up and messaging; a FullscreenPatchLayer owns every
 * change to the page's Fullscreen API (docs/ARCHITECTURE.md §2-§4). The real
 * layer is createFullscreenPatchLayer() in fullscreenLayer.ts; the no-op layer
 * below stays for tests of the bootstrap and channel.
 */

import type { ExitReason, PageMessage, ShimConfig } from "../shared/messages";

export interface PatchContext {
  /** The frame's window (MAIN world). */
  readonly window: Window & typeof globalThis;
  /** Sends a message to the ISOLATED world of the same frame. */
  readonly notify: (message: PageMessage, target?: EventTarget) => void;
}

export interface FullscreenPatchLayer {
  readonly name: string;
  /** Replaces the Fullscreen API on the prototypes. Called once, at document_start. */
  install(context: PatchContext): void;
  /** Settings arrived or changed. Before the first call the layer must not fake anything. */
  configure(config: ShimConfig): void;
  /** Leave fake fullscreen if active (Esc elsewhere in the chain, command, tab hidden). */
  exit(reason: ExitReason): void;
  /** Switch the active fake fullscreen element to real fullscreen (toggle command). */
  goReal(): void;
  /** Back from goReal() to the configured fake size (toggle command again, or the window was released). */
  goFake(): void;
  /** A child frame entered fake fullscreen: fake-fullscreen its <iframe> element here. */
  enterFrameElement(element: Element, requestId: string): void;
  /** Restores every original property descriptor. */
  uninstall(): void;
}

export interface NoopPatchLayer extends FullscreenPatchLayer {
  /** Inspection hooks for tests. */
  readonly state: {
    installed: boolean;
    config: ShimConfig | null;
    calls: string[];
  };
}

/** Records calls and changes nothing on the page: every Fullscreen API call reaches the browser. */
export function createNoopPatchLayer(): NoopPatchLayer {
  const state: NoopPatchLayer["state"] = { installed: false, config: null, calls: [] };
  return {
    name: "noop",
    state,
    install() {
      state.installed = true;
      state.calls.push("install");
    },
    configure(config) {
      state.config = config;
      state.calls.push("configure");
    },
    exit(reason) {
      state.calls.push(`exit:${reason}`);
    },
    goReal() {
      state.calls.push("goReal");
    },
    goFake() {
      state.calls.push("goFake");
    },
    enterFrameElement(_element, requestId) {
      state.calls.push(`enterFrameElement:${requestId}`);
    },
    uninstall() {
      state.installed = false;
      state.calls.push("uninstall");
    },
  };
}
