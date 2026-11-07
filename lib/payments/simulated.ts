// A PayPal stand-in for running the demo with no credentials and for tests.
// It mirrors the Orders v2 behaviors the app relies on:
//   - PayPal-Request-Id idempotency on create and capture;
//   - capture fails with ORDER_NOT_APPROVED until the buyer approves;
//   - a second capture with a different request id fails with ORDER_ALREADY_CAPTURED.
// The approval page lives at /simulator/approve and is clearly labeled as a simulator.

import { randomBytes } from "node:crypto";
import { buildOrderRequest } from "./paypal";
import { parsePayPalValue } from "../money";
import { PaymentGatewayError, type CreateOrderInput, type GatewayOrder, type PaymentGateway } from "./types";

export interface SimulatedOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED" | "VOIDED";
  amountCents: number;
  currency: string;
  /** What the buyer sees on the simulator page. */
  summary: { name: string; quantity: string; unit: string }[];
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
  captureId: string | null;
  captureRequestId: string | null;
}

export interface SimulatedGatewayOptions {
  /** Base URL of the app, for the approve link. */
  baseUrl: string;
  /** Force the capture result (tests): COMPLETED by default. */
  captureStatus?: "COMPLETED" | "PENDING" | "DECLINED";
  /** Report a different captured amount (tests for the amount check). */
  captureAmountDeltaCents?: number;
  /** Fail the next calls with this error (tests). */
  failWith?: PaymentGatewayError;
}

function simId(prefix: string): string {
  return `${prefix}${randomBytes(8).toString("hex").toUpperCase()}`.slice(0, 17);
}

export class SimulatedGateway implements PaymentGateway {
  readonly provider = "simulated" as const;
  readonly orders = new Map<string, SimulatedOrder>();
  private readonly byRequestId = new Map<string, string>();
  calls = { create: 0, get: 0, capture: 0 };

  constructor(private readonly opts: SimulatedGatewayOptions) {}

  setOptions(patch: Partial<SimulatedGatewayOptions>): void {
    Object.assign(this.opts, patch);
  }

  private view(o: SimulatedOrder): GatewayOrder {
    const captured = o.status === "COMPLETED";
    const captureStatus = this.opts.captureStatus ?? "COMPLETED";
    return {
      id: o.id,
      status: o.status,
      approveUrl: `${this.opts.baseUrl}/simulator/approve?token=${encodeURIComponent(o.id)}`,
      amountCents: o.amountCents,
      currency: o.currency,
      capture: captured
        ? {
            captureId: o.captureId,
            status: captureStatus,
            amountCents: o.amountCents + (this.opts.captureAmountDeltaCents ?? 0),
            currency: o.currency,
            statusDetail: captureStatus === "PENDING" ? "PENDING_REVIEW" : null,
          }
        : null,
    };
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    this.calls.create += 1;
    if (this.opts.failWith) throw this.opts.failWith;
    const existing = this.byRequestId.get(input.requestId);
    if (existing) return this.view(this.orders.get(existing)!);

    // Build the same request the real gateway sends, so the simulator exercises that code too.
    const req = buildOrderRequest(input);
    const unit = req.purchaseUnits[0]!;
    const amountCents = parsePayPalValue(unit.amount.value);
    if (amountCents === null) throw new PaymentGatewayError("invalid_request", "bad amount");
    const order: SimulatedOrder = {
      id: simId("SIM"),
      status: "CREATED",
      amountCents,
      currency: unit.amount.currencyCode,
      summary: (unit.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unitAmount.value })),
      brandName: req.paymentSource?.paypal?.experienceContext?.brandName ?? "",
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      captureId: null,
      captureRequestId: null,
    };
    this.orders.set(order.id, order);
    this.byRequestId.set(input.requestId, order.id);
    return this.view(order);
  }

  async getOrder(orderId: string): Promise<GatewayOrder> {
    this.calls.get += 1;
    const o = this.orders.get(orderId);
    if (!o) throw new PaymentGatewayError("not_found", "PayPal 404 RESOURCE_NOT_FOUND", 404);
    return this.view(o);
  }

  async captureOrder(orderId: string, requestId: string): Promise<GatewayOrder> {
    this.calls.capture += 1;
    if (this.opts.failWith) throw this.opts.failWith;
    const o = this.orders.get(orderId);
    if (!o) throw new PaymentGatewayError("not_found", "PayPal 404 RESOURCE_NOT_FOUND", 404);
    if (o.status === "COMPLETED") {
      if (o.captureRequestId === requestId) return this.view(o);
      throw new PaymentGatewayError("order_already_captured", "PayPal 422 ORDER_ALREADY_CAPTURED", 422);
    }
    if (o.status !== "APPROVED") throw new PaymentGatewayError("order_not_approved", "PayPal 422 ORDER_NOT_APPROVED", 422);
    if (this.opts.captureStatus === "DECLINED") {
      throw new PaymentGatewayError("unprocessable", "PayPal 422 INSTRUMENT_DECLINED", 422);
    }
    o.status = "COMPLETED";
    o.captureId = simId("CAP");
    o.captureRequestId = requestId;
    return this.view(o);
  }

  // ─── Buyer actions (only the simulator page calls these) ───────────────

  approve(orderId: string): SimulatedOrder | undefined {
    const o = this.orders.get(orderId);
    if (o && o.status === "CREATED") o.status = "APPROVED";
    return o;
  }

  find(orderId: string): SimulatedOrder | undefined {
    return this.orders.get(orderId);
  }
}
