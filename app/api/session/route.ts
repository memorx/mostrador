import { NextResponse } from "next/server";
import { originOf, runtime, snapshot } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** POST: new chat session. GET ?id=: current state. */
export async function POST(req: Request) {
  const s = runtime(originOf(req)).sessions.create();
  return NextResponse.json(snapshot(s));
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const s = runtime(originOf(req)).sessions.get(id);
  if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json(snapshot(s));
}
