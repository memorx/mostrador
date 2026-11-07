// Process-wide singletons for the Next.js routes. The demo is one long-lived
// Node process (next start or a Render web service), so memory state is fine.

import { anthropicClient, type ClaudeClient } from "./agent/run";
import { priceCart } from "./cart";
import { STORE } from "./catalog";
import type { CheckoutDeps } from "./checkout";
import { PayPalGateway } from "./payments/paypal";
import { SimulatedGateway } from "./payments/simulated";
import type { PaymentGateway } from "./payments/types";
import { MemorySessionStore, type SessionStore } from "./session/store";
import type { Session } from "./session/types";

interface Runtime {
  sessions: SessionStore;
  gateway: PaymentGateway;
  claude: ClaudeClient | null;
}

const g = globalThis as unknown as { __mostrador?: Runtime };

export function runtime(baseUrl: string): Runtime {
  if (!g.__mostrador) {
    const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_EFFORT } = process.env;
    const gateway: PaymentGateway =
      PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
        ? new PayPalGateway({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET })
        : new SimulatedGateway({ baseUrl });
    const cap = Number(process.env.DEMO_MAX_CLAUDE_CALLS_PER_DAY ?? 300);
    g.__mostrador = {
      sessions: new MemorySessionStore(),
      gateway,
      claude: ANTHROPIC_API_KEY ? withDailyCap(anthropicClient({ apiKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL, effort: CLAUDE_EFFORT }), cap) : null,
    };
  }
  return g.__mostrador;
}

/** Public demo safety: at most `cap` Claude calls per UTC day per process. Over the cap the turn shows a notice. */
export function withDailyCap(inner: ClaudeClient, cap: number, clock: () => number = Date.now): ClaudeClient {
  let day = "";
  let used = 0;
  return {
    async create(params) {
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        used = 0;
      }
      if (used >= cap) throw new Error("daily demo limit reached");
      used += 1;
      return inner.create(params);
    },
  };
}

export function checkoutDeps(baseUrl: string): CheckoutDeps {
  const r = runtime(baseUrl);
  return { sessions: r.sessions, gateway: r.gateway, shop: STORE, baseUrl };
}

/** What the browser gets. Never includes the Claude transcript or secrets. */
export function snapshot(s: Session) {
  return {
    id: s.id,
    stage: s.stage,
    shop: { name: STORE.name, disclaimer: STORE.disclaimer, city: STORE.city, currency: STORE.currency },
    feed: s.feed,
    cart: priceCart(s.cart, s.details, STORE),
    details: s.details,
    quotes: s.quotes.map((q) => ({ id: q.id, status: q.status, priced: q.priced, details: q.details, expiresAt: q.expiresAt })),
    payments: s.payments.map((p) => ({ provider: p.provider, orderId: p.orderId, approveUrl: p.approveUrl, status: p.status, amountCents: p.amountCents, currency: p.currency, captureId: p.captureId })),
    orderNumber: s.orderNumber,
    handoff: s.handoff,
    trace: s.trace.slice(-60),
    claudeCalls: s.claudeCalls,
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

/**
 * Public base URL for PayPal's return and cancel links: APP_BASE_URL, else the
 * URL Render gives every web service (RENDER_EXTERNAL_URL), else the request's
 * own origin (local dev). An empty variable counts as unset.
 */
export function originOf(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : new URL(req.url).origin;
}
