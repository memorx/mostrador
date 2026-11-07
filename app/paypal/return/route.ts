import { NextResponse } from "next/server";
import { runTurn } from "@/lib/agent/run";
import { STORE } from "@/lib/catalog";
import { captureReturn } from "@/lib/checkout";
import { checkoutDeps, originOf, runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// PayPal sends the buyer here after approval: ?token=<order id>&PayerID=…
// We capture, verify the amount, and let the agent say thanks.
export async function GET(req: Request) {
  const base = originOf(req);
  const orderId = new URL(req.url).searchParams.get("token") ?? "";
  const d = checkoutDeps(base);
  const r = await captureReturn(d, orderId);
  const session = d.sessions.findByOrderId(orderId);
  const rt = runtime(base);
  if (r.ok && session && rt.claude) {
    await runTurn({ sessions: rt.sessions, shop: STORE, claude: rt.claude }, session.id, "").catch(() => undefined);
  }
  const target = new URL("/", base);
  if (session) target.searchParams.set("s", session.id);
  if (!r.ok) target.searchParams.set("payment", "error");
  return NextResponse.redirect(target, 303);
}
