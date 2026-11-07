// Stand-in for PayPal's approval page when no sandbox credentials are set.
// Clearly labeled as a simulator; with PAYPAL_CLIENT_ID/SECRET the buyer goes to the real PayPal sandbox.
import { headers } from "next/headers";
import { formatMoneyWithCurrency } from "@/lib/money";
import { SimulatedGateway } from "@/lib/payments/simulated";
import { runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function SimulatorApprove({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const h = await headers();
  const base = process.env.APP_BASE_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const gw = runtime(base).gateway;
  const order = gw instanceof SimulatedGateway ? gw.find(token) : undefined;

  return (
    <main className="sim">
      <div className="sim-card">
        <p className="sim-tag">PAYMENT SIMULATOR · not PayPal · no money moves</p>
        {!order ? (
          <p>Order not found.</p>
        ) : (
          <>
            <h1>{order.brandName}</h1>
            <ul>
              {order.summary.map((l, i) => (
                <li key={i}>
                  <span>{l.quantity} × {l.name}</span>
                  <span>{l.unit}</span>
                </li>
              ))}
            </ul>
            <p className="sim-total">Total {formatMoneyWithCurrency(order.amountCents, order.currency)}</p>
            <form action="/simulator/act" method="post" className="sim-actions">
              <input type="hidden" name="token" value={order.id} />
              <button name="do" value="approve" className="btn primary">Approve payment</button>
              <button name="do" value="cancel" className="btn">Cancel and return</button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
