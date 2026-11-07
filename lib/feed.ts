// What the chat shows. The session feed keeps every event; the UI hides the
// cart cards that a later cart card in the same stretch already supersedes.

import type { FeedItem } from "./session/types";

/** Feed kinds that end a stretch of cart updates: the customer spoke, or a checkout card appeared. */
const STRETCH_END: ReadonlySet<FeedItem["kind"]> = new Set(["customer", "quote", "pay", "receipt"]);

/**
 * One chat turn can change the cart several times (add, add, set details…), and
 * each change pushes a cart card. Show only the latest cart card before the
 * customer's next message or the next checkout card (summary, payment, receipt).
 */
export function collapseCartCards<T extends { kind: FeedItem["kind"] }>(feed: readonly T[]): T[] {
  const kept: T[] = [];
  let laterCartInStretch = false;
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i]!;
    if (STRETCH_END.has(f.kind)) laterCartInStretch = false;
    if (f.kind === "cart") {
      if (laterCartInStretch) continue;
      laterCartInStretch = true;
    }
    kept.push(f);
  }
  return kept.reverse();
}
