import { describe, expect, it } from "vitest";
import { runTurn } from "../lib/agent/run";
import { STORE } from "../lib/catalog";
import { collapseCartCards } from "../lib/feed";
import type { FeedItem } from "../lib/session/types";
import { scripted, setup, text, tools } from "./support/harness";

const kinds = (feed: readonly { kind: string; id?: string }[]) => feed.map((f) => f.kind);

describe("chat feed: one cart card per stretch", () => {
  it("keeps only the last cart card before the next customer message or checkout card", () => {
    const feed = [
      { id: "1", kind: "customer" },
      { id: "2", kind: "cart" },
      { id: "3", kind: "cart" },
      { id: "4", kind: "agent" },
      { id: "5", kind: "cart" },
      { id: "6", kind: "customer" },
      { id: "7", kind: "cart" },
      { id: "8", kind: "quote" },
      { id: "9", kind: "cart" },
      { id: "10", kind: "notice" },
      { id: "11", kind: "cart" },
    ] as const satisfies readonly { id: string; kind: FeedItem["kind"] }[];
    expect(collapseCartCards(feed).map((f) => f.id)).toEqual(["1", "4", "5", "6", "7", "8", "10", "11"]);
  });

  it("leaves a feed without repeated cart cards untouched", () => {
    const feed = [{ kind: "customer" }, { kind: "agent" }, { kind: "cart" }, { kind: "customer" }, { kind: "cart" }] as const;
    expect(collapseCartCards(feed)).toEqual(feed);
    expect(collapseCartCards([])).toEqual([]);
  });

  it("a real turn with three cart changes shows one card, with the final cart", async () => {
    const { sessions } = setup();
    const s = sessions.create();
    const claude = scripted([
      tools(["add_to_cart", { sku: "LATTE", quantity: 2 }], ["add_to_cart", { sku: "CONCHA", quantity: 1 }], ["set_order_details", { customer_name: "Ana", fulfillment: "pickup" }]),
      text("Listo, Ana: 2 lattes y una concha para recoger."),
      tools(["update_line", { line_id: "L1", quantity: 3 }]),
      text("Ahora son 3 lattes."),
    ]);
    await runTurn({ sessions, shop: STORE, claude }, s.id, "2 lattes y una concha para recoger, soy Ana");
    expect(s.feed.filter((f) => f.kind === "cart")).toHaveLength(3);
    const first = collapseCartCards(s.feed);
    expect(kinds(first)).toEqual(["customer", "cart", "agent"]);
    const card = first[1]!;
    expect(card.kind === "cart" && card.priced.lines.map((l) => [l.sku, l.quantity])).toEqual([["LATTE", 2], ["CONCHA", 1]]);
    expect(card.kind === "cart" && card.priced.totalCents).toBe(5500 * 2 + 2200);

    // The next turn starts a new stretch: its cart card shows too, and the first one stays.
    await runTurn({ sessions, shop: STORE, claude }, s.id, "mejor 3 lattes");
    expect(kinds(collapseCartCards(s.feed))).toEqual(["customer", "cart", "agent", "customer", "cart", "agent"]);
  });
});
