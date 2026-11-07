// The payment gateway contract. Two implementations:
//   - PayPalGateway (lib/payments/paypal.ts): the official PayPal Server SDK, sandbox.
//   - SimulatedGateway (lib/payments/simulated.ts): same behavior, in memory, no network.
// The checkout service only talks to this interface.

import type { Store } from "../catalog";
import type { Cents } from "../money";
import type { PaymentProvider, Quote } from "../session/types";

export interface CreateOrderInput {
  quote: Quote;
  store: Store;
  /** PayPal sends the buyer here after approval (it appends ?token=<order id>&PayerID=…). */
  returnUrl: string;
  cancelUrl: string;
  /** PayPal-Request-Id: the same id twice returns the same order instead of creating another. */
  requestId: string;
  /** Unique per order on the merchant account (we use the quote id). */
  invoiceId: string;
  /** Our session id, so a PayPal order can be traced back to its chat. */
  customId: string;
}

export interface GatewayCapture {
  captureId: string | null;
  /** COMPLETED | PENDING | DECLINED | FAILED | … */
  status: string | null;
  amountCents: Cents | null;
  currency: string | null;
  /** e.g. PayPal's status_details.reason for a PENDING capture. */
  statusDetail: string | null;
}

export interface GatewayOrder {
  id: string;
  /** CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED */
  status: string;
  approveUrl: string | null;
  amountCents: Cents | null;
  currency: string | null;
  /** Present once the order has been captured. */
  capture: GatewayCapture | null;
}

export type GatewayErrorCode =
  | "not_configured"
  | "unauthorized"
  | "invalid_request"
  | "order_not_approved"
  | "order_already_captured"
  | "not_found"
  | "unprocessable"
  | "network"
  | "unknown";

export class PaymentGatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly httpStatus: number | null = null,
    /** PayPal's debug_id, useful when asking PayPal support. */
    readonly debugId: string | null = null,
  ) {
    super(message);
    this.name = "PaymentGatewayError";
  }
}

export interface PaymentGateway {
  readonly provider: PaymentProvider;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Read-only. */
  getOrder(orderId: string): Promise<GatewayOrder>;
  /** Captures an APPROVED order. `requestId` makes retries safe (PayPal-Request-Id). */
  captureOrder(orderId: string, requestId: string): Promise<GatewayOrder>;
}
