import { describe, expect, it } from "vitest";
import { runTurn, unknownAmounts, type ClaudeClient } from "../lib/agent/run";
import { runTool } from "../lib/agent/tools";
import { addItem, emptyCart, emptyDetails, priceCart } from "../lib/cart";
import { STORE } from "../lib/catalog";
import { captureReturn, cancelReturn, confirmQuote, QUOTE_TTL_MS } from "../lib/checkout";
import { BASE, scripted, setup, text, tools } from "./support/harness";

describe("cart and prices", () => {
  it("prices come from the catalog and delivery adds the fee", () => {
    const r = addItem(emptyCart(), STORE, "latte", 2);
    expect(r.ok).toBe(true);
    const cart = r.ok ? r.cart : emptyCart();
    expect(priceCart(cart, emptyDetails(), STORE).totalCents).toBe(11000);
    expect(priceCart(cart, { customerName: "Ana", fulfillment: "delivery", deliveryAddress: "Centro" }, STORE).totalCents).toBe(11000 + STORE.deliveryFeeCents);
  });
  it("cannot sell a sold-out product", () => {
    const r = addItem(emptyCart(), STORE, "UCHEPOS", 1);
    expect(r.ok).toBe(false);
  });
});

describe("tools", () => {
  it("reject invalid input and unknown tools without throwing", () => {
    const { sessions } = setup();
    const s = sessions.create();
    expect(runTool("add_to_cart", { sku: "LATTE", quantity: -3 }, { session: s, shop: STORE, now: 1 }).ok).toBe(false);
    expect(runTool("capture_payment", {}, { session: s, shop: STORE, now: 1 }).ok).toBe(false);
    expect(runTool("add_to_cart", { sku: "LATTE", quantity: 1, price: 1 }, { session: s, shop: STORE, now: 1 }).ok).toBe(false);
  });
  it("request_checkout needs name and fulfillment", () => {
    const { sessions } = setup();
    const s = sessions.create();
    runTool("add_to_cart", { sku: "LATTE", quantity: 1 }, { session: s, shop: STORE, now: 1 });
    const r = runTool("request_checkout", {}, { session: s, shop: STORE, now: 1 });
    expect(r.ok).toBe(false);
    expect(s.stage).toBe("browsing");
  });
});

describe("price guard", () => {
  it("lets through amounts computed by the shop and blocks invented ones", () => {
    const { sessions } = setup();
    const s = sessions.create();
    runTool("add_to_cart", { sku: "LATTE", quantity: 2 }, { session: s, shop: STORE, now: 1 });
    expect(unknownAmounts("Your total is $110.00 MXN", s, STORE)).toEqual([]);
    expect(unknownAmounts("A latte is $55", s, STORE)).toEqual([]);
    expect(unknownAmounts("With the discount it's $99.00", s, STORE)).toHaveLength(1);
  });
  it("replaces a reply with an invented total by the cart card", async () => {
    const { sessions } = setup();
    const s = sessions.create();
    const claude = scripted([tools(["add_to_cart", { sku: "LATTE", quantity: 2 }]), text("Done! Special price just for you: $80.00")]);
    await runTurn({ sessions, shop: STORE, claude }, s.id, "two lattes");
    const agentTexts = s.feed.filter((f) => f.kind === "agent").map((f) => (f.kind === "agent" ? f.text : ""));
    expect(agentTexts.join(" ")).not.toContain("$80.00");
    expect(s.trace.some((t) => t.name === "price_guard" && !t.ok)).toBe(true);
  });
});

describe("end to end: chat → summary → customer confirms → PayPal approve → capture", () => {
  it("only the customer's confirm creates the order, and the capture is verified", async () => {
    const { sessions, gateway, d } = setup();
    const s = sessions.create();
    const claude = scripted([
      tools(["add_to_cart", { sku: "LATTE", quantity: 2 }], ["add_to_cart", { sku: "CONCHA", quantity: 1, notes: "chocolate" }], ["set_order_details", { customer_name: "Ana", fulfillment: "pickup" }]),
      tools(["request_checkout", {}]),
      text("I'm the shop's AI assistant. Please review your summary and tap Confirm & pay with PayPal."),
      text("¡Gracias, Ana! Tu pedido estará listo en unos 15 minutos."),
    ]);
    await runTurn({ sessions, shop: STORE, claude }, s.id, "2 lattes y una concha de chocolate para recoger, soy Ana");
    expect(s.stage).toBe("awaiting_confirmation");
    expect(gateway.calls.create).toBe(0); // the agent cannot create a PayPal order
    const quote = s.quotes.find((q) => q.status === "open")!;
    expect(quote.priced.totalCents).toBe(5500 * 2 + 2200);

    const c = await confirmQuote(d, s.id, quote.id);
    expect(c.ok).toBe(true);
    expect(s.stage).toBe("awaiting_payment");
    const orderId = s.payments[0]!.orderId;

    // Capture before approval fails and keeps waiting.
    expect((await captureReturn(d, orderId)).ok).toBe(false);
    expect(s.stage).toBe("awaiting_payment");

    gateway.approve(orderId);
    expect((await captureReturn(d, orderId)).ok).toBe(true);
    expect(s.stage).toBe("paid");
    expect(s.orderNumber).toBeTruthy();
    // A second return (refresh) does not capture twice.
    expect((await captureReturn(d, orderId)).ok).toBe(true);
    expect(gateway.calls.capture).toBe(2);

    await runTurn({ sessions, shop: STORE, claude }, s.id, "");
    expect(s.history.some((m) => typeof m.content === "string" && m.content.includes("[shop event] PayPal payment completed"))).toBe(true);
  });

  it("a cart change after the summary invalidates it", async () => {
    const { sessions, d } = setup();
    const s = sessions.create();
    const ctx = () => ({ session: s, shop: STORE, now: 1 });
    runTool("add_to_cart", { sku: "LATTE", quantity: 1 }, ctx());
    runTool("set_order_details", { customer_name: "Ana", fulfillment: "pickup" }, ctx());
    runTool("request_checkout", {}, ctx());
    const q = s.quotes[0]!;
    runTool("add_to_cart", { sku: "CONCHA", quantity: 1 }, ctx());
    expect(s.stage).toBe("browsing");
    expect((await confirmQuote(d, s.id, q.id)).ok).toBe(false);
  });

  it("an expired summary cannot be confirmed", async () => {
    const { sessions, d, advance, clock } = setup();
    const s = sessions.create();
    const ctx = () => ({ session: s, shop: STORE, now: clock() });
    runTool("add_to_cart", { sku: "LATTE", quantity: 1 }, ctx());
    runTool("set_order_details", { customer_name: "Ana", fulfillment: "pickup" }, ctx());
    runTool("request_checkout", {}, ctx());
    advance(QUOTE_TTL_MS + 1);
    expect((await confirmQuote(d, s.id, s.quotes[0]!.id)).ok).toBe(false);
  });

  it("an amount mismatch goes to review, not paid", async () => {
    const { sessions, gateway, d } = setup({ baseUrl: BASE, captureAmountDeltaCents: -100 });
    const s = sessions.create();
    const ctx = () => ({ session: s, shop: STORE, now: 1 });
    runTool("add_to_cart", { sku: "LATTE", quantity: 1 }, ctx());
    runTool("set_order_details", { customer_name: "Ana", fulfillment: "pickup" }, ctx());
    runTool("request_checkout", {}, ctx());
    await confirmQuote(d, s.id, s.quotes[0]!.id);
    const orderId = s.payments[0]!.orderId;
    gateway.approve(orderId);
    await captureReturn(d, orderId);
    expect(s.stage).toBe("payment_review");
    expect(s.handoff).toBe(true);
  });

  it("cancelling in PayPal returns to browsing with the cart intact", async () => {
    const { sessions, d } = setup();
    const s = sessions.create();
    const ctx = () => ({ session: s, shop: STORE, now: 1 });
    runTool("add_to_cart", { sku: "LATTE", quantity: 1 }, ctx());
    runTool("set_order_details", { customer_name: "Ana", fulfillment: "pickup" }, ctx());
    runTool("request_checkout", {}, ctx());
    await confirmQuote(d, s.id, s.quotes[0]!.id);
    await cancelReturn(d, s.payments[0]!.orderId);
    expect(s.stage).toBe("browsing");
    expect(s.cart.lines).toHaveLength(1);
  });

  it("a Claude outage leaves a notice and no broken state", async () => {
    const { sessions } = setup();
    const s = sessions.create();
    const claude: ClaudeClient = { create: async () => { throw new Error("overloaded"); } };
    await runTurn({ sessions, shop: STORE, claude }, s.id, "hola");
    expect(s.feed.some((f) => f.kind === "notice")).toBe(true);
    expect(s.stage).toBe("browsing");
  });
});
