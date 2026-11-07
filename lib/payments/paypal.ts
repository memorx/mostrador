// PayPal Orders API v2 through the official PayPal Server SDK
// (@paypal/paypal-server-sdk), sandbox environment only.
//
// Flow: createOrder (intent CAPTURE, every amount from the server-computed
// quote) → the buyer approves in PayPal → captureOrder. Both writes carry a
// PayPal-Request-Id, so a retried call returns the original result instead of
// charging twice.

import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  ItemCategory,
  OrdersController,
  PaypalExperienceLandingPage,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type ItemRequest,
  type Order,
  type OrderRequest,
} from "@paypal/paypal-server-sdk";
import { parsePayPalValue, toPayPalValue } from "../money";
import { PaymentGatewayError, type CreateOrderInput, type GatewayCapture, type GatewayOrder, type PaymentGateway } from "./types";

/** PayPal field limits we have to respect. */
const MAX_NAME = 127;
const MAX_DESCRIPTION = 127;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Builds the Orders v2 request from a quote. Pure: no I/O, easy to test.
 * Invariants PayPal checks and we guarantee: Σ(unit × qty) = item_total and
 * item_total + shipping = amount.value, all in the quote's currency.
 */
export function buildOrderRequest(input: Omit<CreateOrderInput, "requestId">): OrderRequest {
  const { quote, store } = input;
  const p = quote.priced;
  const money = (cents: number) => ({ currencyCode: p.currency, value: toPayPalValue(cents) });

  const items: ItemRequest[] = p.lines.map((l) => ({
    name: clip(l.name, MAX_NAME),
    unitAmount: money(l.unitCents),
    quantity: String(l.quantity),
    sku: l.sku,
    category: ItemCategory.PhysicalGoods,
    ...(l.notes ? { description: clip(l.notes, MAX_DESCRIPTION) } : {}),
  }));

  const breakdown = {
    itemTotal: money(p.subtotalCents),
    ...(p.deliveryCents > 0 ? { shipping: money(p.deliveryCents) } : {}),
  };

  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: "default",
        description: clip(`${store.name} · chat order ${quote.id}`, MAX_DESCRIPTION),
        customId: input.customId,
        invoiceId: input.invoiceId,
        amount: { currencyCode: p.currency, value: toPayPalValue(p.totalCents), breakdown },
        items,
      },
    ],
    paymentSource: {
      paypal: {
        experienceContext: {
          brandName: clip(store.name, MAX_NAME),
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          userAction: PaypalExperienceUserAction.PayNow,
          landingPage: PaypalExperienceLandingPage.NoPreference,
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
        },
      },
    },
  };
}

/** From the SDK's Order to our GatewayOrder. Amounts are parsed from strings, never via floats. */
export function toGatewayOrder(order: Order): GatewayOrder {
  const unit = order.purchaseUnits?.[0];
  const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  const c = unit?.payments?.captures?.[0];
  const capture: GatewayCapture | null = c
    ? {
        captureId: c.id ?? null,
        status: c.status ?? null,
        amountCents: c.amount ? parsePayPalValue(c.amount.value) : null,
        currency: c.amount?.currencyCode ?? null,
        statusDetail: c.statusDetails?.reason ?? null,
      }
    : null;
  return {
    id: order.id ?? "",
    status: order.status ?? "UNKNOWN",
    approveUrl: approve?.href ?? null,
    amountCents: unit?.amount ? parsePayPalValue(unit.amount.value) : null,
    currency: unit?.amount?.currencyCode ?? null,
    capture,
  };
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { issue?: string }[];
}

/** Maps an SDK error to a PaymentGatewayError with a stable code. Never includes credentials. */
export function mapPayPalError(err: unknown): PaymentGatewayError {
  if (err instanceof PaymentGatewayError) return err;
  if (err instanceof ApiError) {
    const body = (err.result ?? {}) as PayPalErrorBody;
    const issues = (body.details ?? []).map((d) => d.issue ?? "").filter(Boolean);
    const issue = issues[0] ?? body.name ?? "";
    const status = err.statusCode;
    const debugId = body.debug_id ?? null;
    const msg = `PayPal ${status}${issue ? ` ${issue}` : ""}`;
    if (status === 401 || status === 403) return new PaymentGatewayError("unauthorized", msg, status, debugId);
    if (status === 404) return new PaymentGatewayError("not_found", msg, status, debugId);
    if (issues.includes("ORDER_NOT_APPROVED")) return new PaymentGatewayError("order_not_approved", msg, status, debugId);
    if (issues.includes("ORDER_ALREADY_CAPTURED")) return new PaymentGatewayError("order_already_captured", msg, status, debugId);
    if (status === 400) return new PaymentGatewayError("invalid_request", msg, status, debugId);
    if (status === 422) return new PaymentGatewayError("unprocessable", msg, status, debugId);
    return new PaymentGatewayError("unknown", msg, status, debugId);
  }
  const name = err instanceof Error ? err.name : typeof err;
  return new PaymentGatewayError("network", `PayPal request failed (${name})`);
}

/** The subset of the SDK's OrdersController we use (tests pass a fake). */
export type OrdersApi = Pick<OrdersController, "createOrder" | "getOrder" | "captureOrder">;

export interface PayPalGatewayOptions {
  clientId?: string;
  clientSecret?: string;
  /** Inject a ready controller (tests). */
  orders?: OrdersApi;
  timeoutMs?: number;
}

export class PayPalGateway implements PaymentGateway {
  readonly provider = "paypal-sandbox" as const;
  private readonly orders: OrdersApi;

  constructor(opts: PayPalGatewayOptions) {
    if (opts.orders) {
      this.orders = opts.orders;
    } else {
      if (!opts.clientId || !opts.clientSecret) {
        throw new PaymentGatewayError("not_configured", "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
      }
      const client = new Client({
        clientCredentialsAuthCredentials: { oAuthClientId: opts.clientId, oAuthClientSecret: opts.clientSecret },
        // This demo never talks to the live environment.
        environment: Environment.Sandbox,
        timeout: opts.timeoutMs ?? 20_000,
      });
      this.orders = new OrdersController(client);
    }
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    try {
      const { result } = await this.orders.createOrder({
        body: buildOrderRequest(input),
        paypalRequestId: input.requestId,
        prefer: "return=representation",
      });
      return toGatewayOrder(result);
    } catch (err) {
      throw mapPayPalError(err);
    }
  }

  async getOrder(orderId: string): Promise<GatewayOrder> {
    try {
      const { result } = await this.orders.getOrder({ id: orderId });
      return toGatewayOrder(result);
    } catch (err) {
      throw mapPayPalError(err);
    }
  }

  async captureOrder(orderId: string, requestId: string): Promise<GatewayOrder> {
    try {
      const { result } = await this.orders.captureOrder({
        id: orderId,
        paypalRequestId: requestId,
        prefer: "return=representation",
      });
      return toGatewayOrder(result);
    } catch (err) {
      throw mapPayPalError(err);
    }
  }
}
