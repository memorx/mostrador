import { NextResponse } from "next/server";
import { cancelReturn } from "@/lib/checkout";
import { checkoutDeps, originOf } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const base = originOf(req);
  const orderId = new URL(req.url).searchParams.get("token") ?? "";
  const d = checkoutDeps(base);
  await cancelReturn(d, orderId);
  const session = d.sessions.findByOrderId(orderId);
  const target = new URL("/", base);
  if (session) target.searchParams.set("s", session.id);
  return NextResponse.redirect(target, 303);
}
