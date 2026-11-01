import { readFileSync } from "node:fs";

/** Converts CRLF (and lone CR) line endings to LF, so text parses the same on a Windows checkout. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Reads a text file as UTF-8 with LF line endings, whatever the checkout's line endings are. */
export function readText(path: string): string {
  return toLf(readFileSync(path, "utf8"));
}
