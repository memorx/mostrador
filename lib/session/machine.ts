// The order state machine. The model never sets a stage directly: tools and
// payment events ask for a transition and this table decides.

import type { Stage } from "./types";

export type Transition =
  | "request_checkout"
  | "cart_changed"
  | "customer_confirmed"
  | "cancel_checkout"
  | "payment_completed"
  | "payment_needs_review"
  | "payment_cancelled"
  | "start_new_order";

const TABLE: Record<Transition, { from: readonly Stage[]; to: Stage }> = {
  request_checkout: { from: ["browsing", "awaiting_confirmation"], to: "awaiting_confirmation" },
  cart_changed: { from: ["browsing", "awaiting_confirmation"], to: "browsing" },
  // Only reachable from the confirm button (a customer click), never from a tool.
  customer_confirmed: { from: ["awaiting_confirmation"], to: "awaiting_payment" },
  cancel_checkout: { from: ["awaiting_confirmation", "awaiting_payment"], to: "browsing" },
  payment_completed: { from: ["awaiting_payment"], to: "paid" },
  payment_needs_review: { from: ["awaiting_payment"], to: "payment_review" },
  payment_cancelled: { from: ["awaiting_payment"], to: "browsing" },
  start_new_order: { from: ["paid", "payment_review"], to: "browsing" },
};

export function canApply(stage: Stage, t: Transition): boolean {
  return TABLE[t].from.includes(stage);
}

export class TransitionError extends Error {
  constructor(
    readonly stage: Stage,
    readonly transition: Transition,
  ) {
    super(`transition ${transition} is not allowed from stage ${stage}`);
    this.name = "TransitionError";
  }
}

/** The stage after `t`, or throws TransitionError. */
export function nextStage(stage: Stage, t: Transition): Stage {
  if (!canApply(stage, t)) throw new TransitionError(stage, t);
  return TABLE[t].to;
}

/** Stages in which the cart can still be edited. */
export function cartEditable(stage: Stage): boolean {
  return stage === "browsing" || stage === "awaiting_confirmation";
}
