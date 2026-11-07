// The agent's tools. Each one validates its input with zod, acts on the
// session through the pure cart functions or the checkout service, and returns
// a short text for the model. None of them can set a price, change a total,
// create a PayPal order or capture money: those are the server's job.

import { z } from "zod";
import { addItem, missingForCheckout, priceCart, updateLine, type PricedCart } from "../cart";
import type { Store } from "../catalog";
import { cancelCheckout, createQuote, invalidateQuote } from "../checkout";
import { formatMoneyWithCurrency } from "../money";
import { cartEditable } from "../session/machine";
import { pushFeed, pushTrace } from "../session/store";
import type { Session } from "../session/types";

export interface ToolContext {
  session: Session;
  shop: Store;
  now: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model reads back. */
  text: string;
}

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => ToolOutcome;
}

function tool<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const money = (cents: number, shop: Store) => formatMoneyWithCurrency(cents, shop.currency);

export function describeCart(p: PricedCart, shop: Store): string {
  if (p.lines.length === 0) return "The cart is empty.";
  const lines = p.lines.map((l) => `${l.lineId}: ${l.quantity} × ${l.name}${l.notes ? ` (${l.notes})` : ""} = ${money(l.lineCents, shop)}`);
  const extra = p.deliveryCents ? [`Delivery: ${money(p.deliveryCents, shop)}`] : [];
  return [...lines, `Subtotal: ${money(p.subtotalCents, shop)}`, ...extra, `Total: ${money(p.totalCents, shop)}`].join("\n");
}

function lockedText(s: Session): ToolOutcome {
  return { ok: false, text: `The cart cannot change while the order is ${s.stage}. If the customer wants changes, use cancel_checkout first (only before paying).` };
}

function afterCartChange(ctx: ToolContext): string {
  const { session: s, shop, now } = ctx;
  invalidateQuote(s);
  const priced = priceCart(s.cart, s.details, shop);
  pushFeed(s, { kind: "cart", priced }, now);
  return describeCart(priced, shop);
}

const TOOLS = [
  tool({
    name: "show_menu",
    description: "List today's menu with SKUs, prices (computed by the shop) and availability. Use it before suggesting products.",
    schema: z.object({}).strict(),
    run: (_i, { shop }) => ({
      ok: true,
      text: shop.products
        .map((p) => `${p.sku} | ${p.name} | ${p.description} | ${money(p.priceCents, shop)}${p.available ? "" : " | SOLD OUT today"}`)
        .join("\n"),
    }),
  }),
  tool({
    name: "add_to_cart",
    description: "Add a product to the cart by SKU. Notes are preparation preferences and never change the price.",
    schema: z.object({ sku: z.string().min(1).max(40), quantity: z.number().int().min(1).max(50), notes: z.string().max(200).optional() }).strict(),
    run: (i, ctx) => {
      if (!cartEditable(ctx.session.stage)) return lockedText(ctx.session);
      const r = addItem(ctx.session.cart, ctx.shop, i.sku, i.quantity, i.notes);
      if (!r.ok) return { ok: false, text: r.error.message };
      ctx.session.cart = r.cart;
      return { ok: true, text: `Added. Cart now:\n${afterCartChange(ctx)}` };
    },
  }),
  tool({
    name: "update_line",
    description: "Change the quantity of a cart line (0 removes it) or its notes. Use the line id (L1, L2…) from the cart.",
    schema: z.object({ line_id: z.string().min(1).max(10), quantity: z.number().int().min(0).max(50), notes: z.string().max(200).nullable().optional() }).strict(),
    run: (i, ctx) => {
      if (!cartEditable(ctx.session.stage)) return lockedText(ctx.session);
      const r = updateLine(ctx.session.cart, ctx.shop, i.line_id, i.quantity, i.notes);
      if (!r.ok) return { ok: false, text: r.error.message };
      ctx.session.cart = r.cart;
      return { ok: true, text: `Updated. Cart now:\n${afterCartChange(ctx)}` };
    },
  }),
  tool({
    name: "set_order_details",
    description: "Save the customer's name and whether it is pickup or delivery (and the address for delivery). Only send fields the customer actually gave.",
    schema: z
      .object({
        customer_name: z.string().min(1).max(60).optional(),
        fulfillment: z.enum(["pickup", "delivery"]).optional(),
        delivery_address: z.string().min(5).max(200).optional(),
      })
      .strict(),
    run: (i, ctx) => {
      const s = ctx.session;
      if (!cartEditable(s.stage)) return lockedText(s);
      if (i.customer_name) s.details.customerName = i.customer_name.trim();
      if (i.fulfillment) s.details.fulfillment = i.fulfillment;
      if (i.delivery_address) s.details.deliveryAddress = i.delivery_address.trim();
      if (s.details.fulfillment === "pickup") s.details.deliveryAddress = null;
      const cartText = afterCartChange(ctx);
      const missing = missingForCheckout(s.cart, s.details);
      const area = s.details.fulfillment === "delivery" ? ` Delivery only covers: ${ctx.shop.deliveryArea}.` : "";
      return { ok: true, text: `Saved.${area}\n${cartText}\n${missing.length ? `Still missing: ${missing.join(", ")}.` : "Ready for checkout."}` };
    },
  }),
  tool({
    name: "view_cart",
    description: "Read the current cart, totals and what is still missing for checkout.",
    schema: z.object({}).strict(),
    run: (_i, ctx) => {
      const s = ctx.session;
      const missing = missingForCheckout(s.cart, s.details);
      return { ok: true, text: `Stage: ${s.stage}\n${describeCart(priceCart(s.cart, s.details, ctx.shop), ctx.shop)}\n${missing.length ? `Still missing: ${missing.join(", ")}.` : "Ready for checkout."}` };
    },
  }),
  tool({
    name: "request_checkout",
    description:
      "When the cart and details are complete and the customer wants to pay, show them an order summary with a 'Confirm & pay with PayPal' button. You cannot press it: only the customer can.",
    schema: z.object({}).strict(),
    run: (_i, ctx) => {
      const r = createQuote(ctx.session, ctx.shop, ctx.now);
      if (!r.ok) return { ok: false, text: r.reason };
      return {
        ok: true,
        text: `Summary ${r.value.id} is on the customer's screen with total ${money(r.value.priced.totalCents, ctx.shop)}. Ask them to review it and press "Confirm & pay with PayPal". Do not repeat the line items.`,
      };
    },
  }),
  tool({
    name: "cancel_checkout",
    description: "Withdraw the summary or the unpaid PayPal order so the customer can change the cart. Never after payment.",
    schema: z.object({}).strict(),
    run: (_i, ctx) => {
      const r = cancelCheckout(ctx.session);
      return r.ok ? { ok: true, text: "Checkout cancelled; the cart can be edited again." } : { ok: false, text: r.reason };
    },
  }),
  tool({
    name: "handoff_to_human",
    description: "Ask a person from the shop to take over: complaints, refunds, allergies or anything you are not sure about.",
    schema: z.object({ reason: z.string().min(3).max(200) }).strict(),
    run: (i, ctx) => {
      ctx.session.handoff = true;
      pushFeed(ctx.session, { kind: "notice", tone: "info", text: "A person from the shop will join this chat." }, ctx.now);
      return { ok: true, text: `Handoff requested (${i.reason}). Tell the customer a person from the shop will reply here.` };
    },
  }),
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Tool definitions in the Anthropic Messages API format. */
export function toolDefinitions() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema) as Record<string, unknown> & { type: "object" } }));
}

/**
 * Runs one tool call. Unknown tools and invalid input come back as errors for the model, never as exceptions.
 * Every call, refused or not, is traced for the "Under the hood" panel.
 */
export function runTool(name: string, rawInput: unknown, ctx: ToolContext): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  let out: ToolOutcome;
  if (!tool) {
    out = { ok: false, text: `Unknown tool "${name.slice(0, 60)}". Only these exist: ${TOOL_NAMES.join(", ")}.` };
  } else {
    const parsed = (tool.schema as z.ZodTypeAny).safeParse(rawInput ?? {});
    out = parsed.success
      ? (tool.run as (i: unknown, c: ToolContext) => ToolOutcome)(parsed.data, ctx)
      : { ok: false, text: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}` };
  }
  pushTrace(ctx.session, { kind: "tool", name: name.slice(0, 60), ok: out.ok, input: rawInput, summary: out.text.split("\n")[0]!.slice(0, 140) }, ctx.now);
  return out;
}
