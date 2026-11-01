/**
 * The placeholder tab a popped-out video leaves in its place (docs/ARCHITECTURE.md §5). Its query carries the
 * page's title and URL (the service worker has no "tabs" permission to read them); "Bring it back" asks the
 * service worker to pop the video back in, which puts it where this tab is now and closes this tab.
 */

import type { ServiceWorkerReplies, ToServiceWorker } from "../shared/messages";
import { byId, placeholderTitle } from "./common";

document.title = placeholderTitle(location.search);

const button = byId<HTMLButtonElement>("bring-back");
button.addEventListener("click", () => {
  button.disabled = true;
  void chrome.runtime
    .sendMessage({ type: "pop-out-return" } satisfies ToServiceWorker)
    .then((reply: ServiceWorkerReplies["pop-out-return"] | undefined) => {
      // On success this tab closes; otherwise let the user try again.
      if (!reply?.ok || !reply.returned) button.disabled = false;
    })
    .catch(() => {
      button.disabled = false;
    });
});
