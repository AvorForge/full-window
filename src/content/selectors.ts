/**
 * Selector rewriting for the fake fullscreen state (docs/ARCHITECTURE.md §2, §3).
 *
 * While an element is fake-fullscreen it carries attribute markers instead of
 * matching :fullscreen. These pure helpers rewrite selector text so the
 * fullscreen pseudo-classes target the markers, without touching strings,
 * attribute selectors or escapes.
 */

export const FULLSCREEN_ATTRIBUTE = "data-cfs-fullscreen";
export const ANCESTOR_ATTRIBUTE = "data-cfs-fullscreen-ancestor";
export const BACKDROP_ATTRIBUTE = "data-cfs-backdrop";

/** Pseudo-classes (lower case, without the colon) and the attribute selector that replaces each. */
const PSEUDO_CLASS_MARKERS: Readonly<Record<string, string>> = {
  fullscreen: `[${FULLSCREEN_ATTRIBUTE}]`,
  "-webkit-full-screen": `[${FULLSCREEN_ATTRIBUTE}]`,
  "-moz-full-screen": `[${FULLSCREEN_ATTRIBUTE}]`,
  "-webkit-full-screen-ancestor": `[${ANCESTOR_ATTRIBUTE}]`,
};

/** Cheap pre-check: can `text` contain a fullscreen pseudo-class or ::backdrop at all? */
export function mayContainFullscreen(text: string): boolean {
  return /full-?screen|backdrop/i.test(text);
}

const IDENT_CHAR = /[-\w\u0080-\uffff]/;

/** Index after the quoted string starting at `start` (the quote), honouring escapes. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/** Index after the attribute selector starting at `start` (the "["). */
function skipAttribute(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== "]") {
    if (text[i] === '"' || text[i] === "'") i = skipString(text, i);
    else i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

export interface RewriteResult {
  text: string;
  /** A fullscreen pseudo-class was replaced. */
  changed: boolean;
  /** Offset of the first `::backdrop` in `text`, or -1. */
  backdropAt: number;
}

/**
 * Replaces :fullscreen, :-webkit-full-screen, :-moz-full-screen and
 * :-webkit-full-screen-ancestor with their attribute markers. Functional
 * pseudo-classes such as :not(...) are walked into, so `:not(:fullscreen)`
 * becomes `:not([data-cfs-fullscreen])`.
 */
export function rewritePseudoClasses(text: string): RewriteResult {
  let out = "";
  let changed = false;
  let backdropAt = -1;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (c === '"' || c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "[") {
      const end = skipAttribute(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === ":") {
      const colons = text[i + 1] === ":" ? 2 : 1;
      let j = i + colons;
      while (j < text.length && IDENT_CHAR.test(text[j] as string)) j++;
      const name = text.slice(i + colons, j).toLowerCase();
      const marker = PSEUDO_CLASS_MARKERS[name];
      if (colons === 1 && marker !== undefined && text[j] !== "(") {
        out += marker;
        changed = true;
      } else {
        if (colons === 2 && name === "backdrop" && backdropAt < 0) backdropAt = out.length;
        out += text.slice(i, j);
      }
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, changed, backdropAt };
}

/**
 * The in-place rewrite of a page rule whose selector has a fullscreen pseudo-class inside a negation, as
 * `.player:not(:fullscreen) .bar` (Loom hides its fullscreen-only controls so): each such pseudo-class becomes
 * `:is(<pseudo-class>, <marker>)`, so the rule stops matching a fake-fullscreen element as it does a really
 * fullscreen one, and still matches every other element as before. A mirrored rule cannot do that: it can only
 * add rules, never stop the original from matching. Returns null when no fullscreen pseudo-class is negated.
 * `:has()` and `:is()` arguments outside a `:not()` need nothing: the mirrored rule matches the marker there.
 */
export function rewriteNegatedFullscreen(text: string): string | null {
  if (!mayContainFullscreen(text)) return null;
  let out = "";
  let changed = false;
  /** Per open parenthesis: whether it is the argument of a :not(). */
  const negations: boolean[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (c === '"' || c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "[") {
      const end = skipAttribute(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === ":") {
      const colons = text[i + 1] === ":" ? 2 : 1;
      let j = i + colons;
      while (j < text.length && IDENT_CHAR.test(text[j] as string)) j++;
      const name = text.slice(i + colons, j).toLowerCase();
      const marker = PSEUDO_CLASS_MARKERS[name];
      if (text[j] === "(") {
        negations.push(colons === 1 && name === "not");
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (colons === 1 && marker !== undefined && negations.includes(true)) {
        out += `:is(${text.slice(i, j)}, ${marker})`;
        changed = true;
      } else {
        out += text.slice(i, j);
      }
      i = j;
    } else {
      if (c === "(") negations.push(false);
      else if (c === ")") negations.pop();
      out += c;
      i++;
    }
  }
  return changed ? out : null;
}

/** Splits a selector list on top-level commas (not inside (), [] or strings). */
export function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === "[") {
      i = skipAttribute(text, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/** Rewrites a selector argument of matches()/closest()/querySelector(All) while a fake element exists. */
export function rewriteSelectorArgument(selectors: string): string {
  return mayContainFullscreen(selectors) ? rewritePseudoClasses(selectors).text : selectors;
}

export interface MirroredSelector {
  selector: string;
  /** The selector targets the backdrop div (it lives in the document, whatever root the rule came from). */
  backdrop: boolean;
}

/**
 * Turns one complex selector from a page rule into the selector of its mirrored
 * rule, or null when it does not involve fullscreen. `X::backdrop` becomes the
 * backdrop marker only when `subjectMatches(X')` says the fake element matches
 * the rewritten subject X' (so `dialog::backdrop` does not restyle our backdrop).
 */
export function mirrorSelector(selector: string, subjectMatches: (subject: string) => boolean): MirroredSelector | null {
  if (!mayContainFullscreen(selector)) return null;
  const { text, changed, backdropAt } = rewritePseudoClasses(selector);
  if (backdropAt >= 0) {
    const rest = text.slice(backdropAt + "::backdrop".length).trim();
    if (rest !== "") return null;
    const prefix = text.slice(0, backdropAt);
    const subject = prefix.trim() === "" || /[\s>+~]$/.test(prefix) ? `${prefix}*` : prefix;
    return subjectMatches(subject.trim()) ? { selector: `[${BACKDROP_ATTRIBUTE}]`, backdrop: true } : null;
  }
  return changed ? { selector: text, backdrop: false } : null;
}
