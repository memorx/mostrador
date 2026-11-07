import { NextResponse } from "next/server";
import { SimulatedGateway } from "@/lib/payments/simulated";
import { originOf, runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// The simulator's buttons: approve (then PayPal-style redirect to the return URL) or cancel.
export async function POST(req: Request) {
  const base = originOf(req);
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const gw = runtime(base).gateway;
  if (!(gw instanceof SimulatedGateway)) return NextResponse.json({ error: "simulator disabled" }, { status: 404 });
  const order = gw.find(token);
  if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
  if (form.get("do") === "approve") {
    gw.approve(token);
    return NextResponse.redirect(`${order.returnUrl}?token=${encodeURIComponent(token)}&PayerID=SIMULATED`, 303);
  }
  return NextResponse.redirect(`${order.cancelUrl}?token=${encodeURIComponent(token)}`, 303);
}
