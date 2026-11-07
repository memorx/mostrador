import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelCheckout, confirmQuote } from "@/lib/checkout";
import { checkoutDeps, originOf, snapshot } from "@/lib/runtime";
import { SessionNotFoundError } from "@/lib/session/store";

export const dynamic = "force-dynamic";

// The customer's own click. This is the only path that creates a PayPal order.
const Body = z.object({ sessionId: z.string().uuid(), quoteId: z.string().min(1).max(40), action: z.enum(["confirm", "cancel"]).default("confirm") });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const d = checkoutDeps(originOf(req));
  const { sessionId, quoteId, action } = parsed.data;
  try {
    if (action === "cancel") {
      await d.sessions.withLock(sessionId, (s) => {
        const r = cancelCheckout(s);
        if (r.ok) s.pendingEvents.push("The customer cancelled the summary to change the order.");
      });
      return NextResponse.json({ ok: true, session: snapshot(d.sessions.get(sessionId)!) });
    }
    const r = await confirmQuote(d, sessionId, quoteId);
    const s = d.sessions.get(sessionId)!;
    return NextResponse.json(r.ok ? { ok: true, approveUrl: r.value.approveUrl, session: snapshot(s) } : { ok: false, reason: r.reason, session: snapshot(s) });
  } catch (err) {
    if (err instanceof SessionNotFoundError) return NextResponse.json({ error: "session not found" }, { status: 404 });
    throw err;
  }
}
