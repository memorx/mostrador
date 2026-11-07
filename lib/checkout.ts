// The checkout service: the only code that creates quotes, PayPal orders and
// captures. The agent can *ask* for a quote (request_checkout) but only the
// customer's click on "Confirm & pay" (POST /api/confirm) creates a PayPal
// order, and only PayPal's return (GET /paypal/return) captures it.
//
// Amounts always come from priceCart() over the catalog. After capture the
// captured amount and currency are compared with the quote; any mismatch goes
// to payment_review instead of "paid".

import { missingForCheckout, priceCart } from "./cart";
import type { Store } from "./catalog";
import { formatMoneyWithCurrency } from "./money";
import { PaymentGatewayError, type PaymentGateway } from "./payments/types";
import { nextStage } from "./session/machine";
import { pushFeed, pushTrace, shortId, type SessionStore } from "./session/store";
import type { Payment, Quote, Session } from "./session/types";

export const QUOTE_TTL_MS = 30 * 60 * 1000;

export interface CheckoutDeps {
  sessions: SessionStore;
  gateway: PaymentGateway;
  shop: Store;
  /** Public base URL of the app, for PayPal's return and cancel URLs. */
  baseUrl: string;
  clock?: () => number;
}

export type CheckoutResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const now = (d: Pick<CheckoutDeps, "clock">) => (d.clock ?? Date.now)();

function openQuote(s: Session): Quote | undefined {
  return s.quotes.find((q) => q.status === "open");
}

/** Called by the request_checkout tool. Runs inside the session lock. */
export function createQuote(s: Session, shop: Store, at: number): CheckoutResult<Quote> {
  const missing = missingForCheckout(s.cart, s.details);
  if (missing.length) return { ok: false, reason: `Missing: ${missing.join(", ")}.` };
  if (s.stage !== "browsing" && s.stage !== "awaiting_confirmation") {
    return { ok: false, reason: `Cannot quote while the order is ${s.stage}.` };
  }
  for (const q of s.quotes) if (q.status === "open") q.status = "superseded";
  const quote: Quote = {
    id: shortId("Q"),
    cartVersion: s.cart.version,
    priced: priceCart(s.cart, s.details, shop),
    details: { ...s.details },
    createdAt: at,
    expiresAt: at + QUOTE_TTL_MS,
    status: "open",
  };
  s.quotes.push(quote);
  s.stage = nextStage(s.stage, "request_checkout");
  pushFeed(s, { kind: "quote", quoteId: quote.id }, at);
  return { ok: true, value: quote };
}

/** Any cart or details change invalidates an open quote. Runs inside the session lock. */
export function invalidateQuote(s: Session): void {
  const q = openQuote(s);
  if (q) q.status = "superseded";
  if (s.stage === "awaiting_confirmation") s.stage = nextStage(s.stage, "cart_changed");
}

/** Called by the cancel_checkout tool or the customer's cancel button, before paying. */
export function cancelCheckout(s: Session): CheckoutResult<null> {
  if (s.stage !== "awaiting_confirmation" && s.stage !== "awaiting_payment") return { ok: false, reason: "Nothing to cancel." };
  const q = openQuote(s);
  if (q) q.status = "cancelled";
  for (const p of s.payments) if (p.status === "created") p.status = "voided";
  s.stage = nextStage(s.stage, "cancel_checkout");
  return { ok: true, value: null };
}

/** POST /api/confirm: the customer's click. Creates the PayPal order for the open quote. */
export async function confirmQuote(d: CheckoutDeps, sessionId: string, quoteId: string): Promise<CheckoutResult<Payment>> {
  return d.sessions.withLock(sessionId, async (s) => {
    const at = now(d);
    const q = s.quotes.find((x) => x.id === quoteId);
    if (!q || q.status !== "open") return { ok: false, reason: "That summary is no longer valid. Ask for a new one." };
    if (q.cartVersion !== s.cart.version) {
      q.status = "superseded";
      return { ok: false, reason: "The cart changed after this summary. Ask for a new one." };
    }
    if (at > q.expiresAt) {
      q.status = "expired";
      return { ok: false, reason: "This summary expired. Ask for a new one." };
    }
    if (s.stage !== "awaiting_confirmation") return { ok: false, reason: `Cannot confirm while the order is ${s.stage}.` };

    try {
      const order = await d.gateway.createOrder({
        quote: q,
        store: d.shop,
        returnUrl: `${d.baseUrl}/paypal/return`,
        cancelUrl: `${d.baseUrl}/paypal/cancel`,
        requestId: `create-${q.id}`,
        invoiceId: q.id,
        customId: s.id,
      });
      if (!order.approveUrl) throw new PaymentGatewayError("unprocessable", "PayPal did not return an approval link");
      const payment: Payment = {
        provider: d.gateway.provider,
        quoteId: q.id,
        orderId: order.id,
        approveUrl: order.approveUrl,
        status: "created",
        amountCents: q.priced.totalCents,
        currency: q.priced.currency,
        captureId: null,
        createdAt: at,
        completedAt: null,
        detail: null,
      };
      q.status = "confirmed";
      s.payments.push(payment);
      s.stage = nextStage(s.stage, "customer_confirmed");
      pushFeed(s, { kind: "pay", orderId: order.id }, at);
      pushTrace(s, { kind: "payment", name: "paypal.orders.create", ok: true, summary: `order ${order.id} for ${formatMoneyWithCurrency(q.priced.totalCents, q.priced.currency)}` }, at);
      s.pendingEvents.push(`The customer confirmed summary ${q.id} and a PayPal order was created. They now approve it in PayPal.`);
      s.updatedAt = at;
      return { ok: true, value: payment };
    } catch (err) {
      const e = err instanceof PaymentGatewayError ? err : new PaymentGatewayError("unknown", String(err));
      pushTrace(s, { kind: "payment", name: "paypal.orders.create", ok: false, summary: `${e.code}${e.debugId ? ` (debug ${e.debugId})` : ""}` }, at);
      return { ok: false, reason: "PayPal is not answering right now. Please try again in a minute." };
    }
  });
}

/** GET /paypal/return: the buyer approved in PayPal. Captures and verifies. Safe to call twice. */
export async function captureReturn(d: CheckoutDeps, orderId: string): Promise<CheckoutResult<Session>> {
  const found = d.sessions.findByOrderId(orderId);
  if (!found) return { ok: false, reason: "Unknown order." };
  return d.sessions.withLock(found.id, async (s) => {
    const at = now(d);
    const p = s.payments.find((x) => x.orderId === orderId);
    if (!p) return { ok: false, reason: "Unknown order." };
    if (p.status === "completed" || p.status === "pending") return { ok: true, value: s };
    if (s.stage !== "awaiting_payment") return { ok: false, reason: `Cannot capture while the order is ${s.stage}.` };

    try {
      const order = await d.gateway.captureOrder(orderId, `capture-${orderId}`);
      const cap = order.capture;
      const sameAmount = cap?.amountCents === p.amountCents && cap?.currency === p.currency;
      p.captureId = cap?.captureId ?? null;
      if (cap?.status === "COMPLETED" && sameAmount) {
        p.status = "completed";
        p.completedAt = at;
        s.stage = nextStage(s.stage, "payment_completed");
        s.orderNumber = d.sessions.nextOrderNumber();
        pushFeed(s, { kind: "receipt", orderId }, at);
        s.pendingEvents.push(`PayPal payment completed for order ${s.orderNumber}. Thank the customer and tell them what happens next (pickup time or delivery).`);
      } else {
        p.status = cap?.status === "COMPLETED" ? "completed" : "pending";
        p.detail = !sameAmount ? "captured amount does not match the summary" : (cap?.statusDetail ?? cap?.status ?? "unknown");
        s.stage = nextStage(s.stage, "payment_needs_review");
        s.handoff = true;
        pushFeed(s, { kind: "notice", tone: "warn", text: "Your payment needs a quick check by the shop. A person will follow up here." }, at);
        s.pendingEvents.push("The PayPal payment needs review by a person from the shop. Do not promise anything about it.");
      }
      pushTrace(s, { kind: "payment", name: "paypal.orders.capture", ok: p.status === "completed" && sameAmount, summary: `${cap?.status ?? "no capture"}${sameAmount ? "" : " (amount mismatch)"}` }, at);
      s.updatedAt = at;
      return { ok: true, value: s };
    } catch (err) {
      const e = err instanceof PaymentGatewayError ? err : new PaymentGatewayError("unknown", String(err));
      pushTrace(s, { kind: "payment", name: "paypal.orders.capture", ok: false, summary: e.code }, at);
      if (e.code === "order_already_captured") {
        // Someone captured it with another request id: read the truth from PayPal.
        const o = await d.gateway.getOrder(orderId).catch(() => null);
        if (o?.status === "COMPLETED" && o.capture?.amountCents === p.amountCents) {
          p.status = "completed";
          p.completedAt = at;
          s.stage = nextStage(s.stage, "payment_completed");
          s.orderNumber = s.orderNumber ?? d.sessions.nextOrderNumber();
          pushFeed(s, { kind: "receipt", orderId }, at);
          return { ok: true, value: s };
        }
      }
      return { ok: false, reason: e.code === "order_not_approved" ? "The payment was not approved in PayPal yet." : "We could not confirm the payment. Please try again." };
    }
  });
}

/** GET /paypal/cancel: the buyer closed PayPal without paying. */
export async function cancelReturn(d: CheckoutDeps, orderId: string): Promise<CheckoutResult<Session>> {
  const found = d.sessions.findByOrderId(orderId);
  if (!found) return { ok: false, reason: "Unknown order." };
  return d.sessions.withLock(found.id, (s) => {
    const p = s.payments.find((x) => x.orderId === orderId);
    if (!p || p.status !== "created" || s.stage !== "awaiting_payment") return { ok: true, value: s };
    p.status = "voided";
    s.stage = nextStage(s.stage, "payment_cancelled");
    pushFeed(s, { kind: "notice", tone: "info", text: "Payment cancelled. Your cart is still here." }, now(d));
    s.pendingEvents.push("The customer cancelled in PayPal. The cart is unchanged; offer to adjust it or try again.");
    return { ok: true, value: s };
  });
}
