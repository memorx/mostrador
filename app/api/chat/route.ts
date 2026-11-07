import { NextResponse } from "next/server";
import { z } from "zod";
import { runTurn } from "@/lib/agent/run";
import { STORE } from "@/lib/catalog";
import { originOf, runtime, snapshot } from "@/lib/runtime";
import { SessionNotFoundError } from "@/lib/session/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({ sessionId: z.string().uuid(), text: z.string().max(2000) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const rt = runtime(originOf(req));
  if (!rt.claude) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 503 });
  try {
    const s = await runTurn({ sessions: rt.sessions, shop: STORE, claude: rt.claude }, parsed.data.sessionId, parsed.data.text);
    return NextResponse.json(snapshot(s));
  } catch (err) {
    if (err instanceof SessionNotFoundError) return NextResponse.json({ error: "session not found" }, { status: 404 });
    throw err;
  }
}
