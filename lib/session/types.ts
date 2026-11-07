// One chat session = one customer conversation with the shop.

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Cart, OrderDetails, PricedCart } from "../cart";
import type { Cents } from "../money";

/**
 * browsing              → the customer is building the cart
 * awaiting_confirmation → a server-computed summary (quote) is on screen; only the customer can confirm it
 * awaiting_payment      → a PayPal order exists; waiting for the buyer to approve it in PayPal
 * paid                  → the capture completed and its amount matched the quote
 * payment_review        → PayPal returned something that needs a human (pending capture, amount mismatch…)
 */
export type Stage = "browsing" | "awaiting_confirmation" | "awaiting_payment" | "paid" | "payment_review";

export interface Quote {
  id: string;
  cartVersion: number;
  priced: PricedCart;
  details: OrderDetails;
  createdAt: number;
  expiresAt: number;
  status: "open" | "confirmed" | "superseded" | "cancelled" | "expired";
}

export type PaymentProvider = "paypal-sandbox" | "simulated";

export type PaymentStatus = "created" | "completed" | "pending" | "failed" | "voided";

export interface Payment {
  provider: PaymentProvider;
  quoteId: string;
  /** PayPal order id. */
  orderId: string;
  approveUrl: string;
  status: PaymentStatus;
  amountCents: Cents;
  currency: string;
  captureId: string | null;
  createdAt: number;
  completedAt: number | null;
  /** Short reason for failed / pending / review. Never contains customer text. */
  detail: string | null;
}

export type FeedItem =
  | { id: string; at: number; kind: "customer"; text: string }
  | { id: string; at: number; kind: "agent"; text: string }
  | { id: string; at: number; kind: "cart"; priced: PricedCart }
  | { id: string; at: number; kind: "quote"; quoteId: string }
  | { id: string; at: number; kind: "pay"; orderId: string }
  | { id: string; at: number; kind: "receipt"; orderId: string }
  | { id: string; at: number; kind: "notice"; tone: "info" | "warn"; text: string };

/** What the agent did, for the "under the hood" panel. Inputs are tool arguments, never secrets. */
export interface TraceEntry {
  id: string;
  at: number;
  turn: number;
  kind: "tool" | "guard" | "model" | "payment";
  name: string;
  ok: boolean;
  input?: unknown;
  summary: string;
}

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: Stage;
  cart: Cart;
  details: OrderDetails;
  quotes: Quote[];
  payments: Payment[];
  /** The Claude transcript. Append-only (thinking blocks are kept exactly as returned). */
  history: BetaMessageParam[];
  /** What the customer sees. */
  feed: FeedItem[];
  /** Things that happened outside the chat (confirm click, PayPal return…), told to the agent on its next turn. */
  pendingEvents: string[];
  trace: TraceEntry[];
  turns: number;
  claudeCalls: number;
  /** A person from the shop was asked to step in. */
  handoff: boolean;
  /** Short order number shown to the customer and the shop once paid. */
  orderNumber: string | null;
}
