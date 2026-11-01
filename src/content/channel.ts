/**
 * Private MAIN <-> ISOLATED channel for one frame (docs/ARCHITECTURE.md §1).
 *
 * Both worlds share the DOM but not JS objects. At document_start, before any
 * page script runs, whichever script runs first writes a random channel id to
 * a temporary attribute on <html>; the second consumes and removes it and,
 * once it has a listener, says hello (the first queues until then). Messages
 * are CustomEvents named "<id>:<side>" carrying a JSON string (objects in
 * `detail` do not cross worlds reliably), dispatched on the
 * document or on a target element (so a DOM node can be referenced without
 * serialising it). Page scripts never see the id.
 */

import type { PageMessage } from "../shared/messages";

export const HANDSHAKE_ATTRIBUTE = "data-cfs-channel";

export type ChannelSide = "main" | "isolated";

export interface PageChannel {
  readonly id: string;
  /** Sends to the other world. `target` defaults to the document; it must be in this document. */
  post(message: PageMessage, target?: EventTarget): void;
  /** Receives from the other world. `target` is the node the event was dispatched on. */
  onMessage(listener: (message: PageMessage, target: EventTarget | null) => void): () => void;
  close(): void;
}

interface Envelope {
  hello?: true;
  message?: PageMessage;
}

// Captured at document_start, before page scripts can replace them.
const natives = {
  CustomEvent: globalThis.CustomEvent,
  dispatchEvent: globalThis.EventTarget?.prototype.dispatchEvent,
  addEventListener: globalThis.EventTarget?.prototype.addEventListener,
  removeEventListener: globalThis.EventTarget?.prototype.removeEventListener,
  composedPath: globalThis.Event?.prototype.composedPath,
  getAttribute: globalThis.Element?.prototype.getAttribute,
  setAttribute: globalThis.Element?.prototype.setAttribute,
  removeAttribute: globalThis.Element?.prototype.removeAttribute,
  stringify: JSON.stringify,
  parse: JSON.parse,
  apply: Reflect.apply,
};

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "cfs-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function openPageChannel(side: ChannelSide, doc: Document = document): PageChannel {
  const root = doc.documentElement;
  const existing = natives.getAttribute.call(root, HANDSHAKE_ATTRIBUTE);
  const creator = existing === null || existing === "";
  const id = creator ? randomId() : existing;
  if (creator) natives.setAttribute.call(root, HANDSHAKE_ATTRIBUTE, id);
  else natives.removeAttribute.call(root, HANDSHAKE_ATTRIBUTE);

  const other: ChannelSide = side === "main" ? "isolated" : "main";
  const outgoing = `${id}:${side}`;
  const incoming = `${id}:${other}`;
  const listeners = new Set<(message: PageMessage, target: EventTarget | null) => void>();
  // The creator cannot know whether the other side listens yet; it queues until hello.
  let connected = !creator;
  const queue: Array<[PageMessage, EventTarget]> = [];

  const send = (envelope: Envelope, target: EventTarget): void => {
    const event = new natives.CustomEvent(outgoing, { detail: natives.stringify(envelope), bubbles: true, composed: true });
    natives.dispatchEvent.call(target, event);
  };

  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    let envelope: Envelope;
    try {
      envelope = natives.parse(detail) as Envelope;
    } catch {
      return;
    }
    if (envelope.hello) {
      connected = true;
      for (const [message, target] of queue.splice(0)) send({ message }, target);
      return;
    }
    if (envelope.message) {
      // composedPath()[0]: the node the event was dispatched on, even inside an open shadow root
      // (event.target is retargeted to the shadow host for this document-level listener).
      const path = natives.composedPath ? (natives.apply(natives.composedPath, event, []) as EventTarget[]) : [];
      const target = path[0] ?? event.target;
      for (const listener of listeners) listener(envelope.message, target);
    }
  };
  // Capture on the document: sees events dispatched on any node in it, before the target.
  natives.addEventListener.call(doc, incoming, handler, true);

  // The consumer says hello once it can receive, so the creator's queued messages are not lost.
  let greeted = creator;

  return {
    id,
    post(message, target = doc) {
      if (connected) send({ message }, target);
      else queue.push([message, target]);
    },
    onMessage(listener) {
      listeners.add(listener);
      if (!greeted) {
        greeted = true;
        send({ hello: true }, doc);
      }
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      natives.removeEventListener.call(doc, incoming, handler, true);
    },
  };
}
