// Test doubles shared by the test files: a scripted Claude and a session store
// wired to the payment simulator with a controllable clock.

import type { ClaudeClient, ClaudeReply } from "../../lib/agent/run";
import { STORE } from "../../lib/catalog";
import type { CheckoutDeps } from "../../lib/checkout";
import { SimulatedGateway } from "../../lib/payments/simulated";
import { MemorySessionStore } from "../../lib/session/store";

export const BASE = "http://localhost:3000";

/** A scripted Claude: each call returns the next reply. */
export function scripted(replies: ClaudeReply[]): ClaudeClient & { calls: number } {
  const c = {
    calls: 0,
    async create() {
      const r = replies[c.calls];
      c.calls += 1;
      if (!r) throw new Error("no more scripted replies");
      return r;
    },
  };
  return c;
}

export const text = (t: string): ClaudeReply => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

export const tools = (...calls: Array<[string, unknown]>): ClaudeReply => ({
  stop_reason: "tool_use",
  content: calls.map(([name, input], i) => ({ type: "tool_use", id: `tu_${name}_${i}`, name, input })),
});

export function setup(gwOpts: ConstructorParameters<typeof SimulatedGateway>[0] = { baseUrl: BASE }) {
  let t = 1_000_000;
  const clock = () => t;
  const sessions = new MemorySessionStore(clock);
  const gateway = new SimulatedGateway(gwOpts);
  const d: CheckoutDeps = { sessions, gateway, shop: STORE, baseUrl: BASE, clock };
  return { sessions, gateway, d, advance: (ms: number) => (t += ms), clock };
}
