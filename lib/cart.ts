// The cart: pure functions, no I/O. Every change returns a new cart with a
// higher `version`, so a confirmation made against an old version can be
// detected and rejected. Totals are integer sums of catalog prices.

import { findProduct, type Store } from "./catalog";
import type { Cents } from "./money";

export interface CartLine {
  lineId: string;
  sku: string;
  quantity: number;
  /** Free-text preparation notes ("oat milk", "no sugar"). They never change the price. */
  notes: string | null;
}

export interface Cart {
  version: number;
  lines: CartLine[];
  /** Next number for a line id (L1, L2…). Ids are never reused within a cart. */
  nextLine: number;
}

export type Fulfillment = "pickup" | "delivery";

export interface OrderDetails {
  customerName: string | null;
  fulfillment: Fulfillment | null;
  deliveryAddress: string | null;
}

export interface PricedLine {
  lineId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCents: Cents;
  lineCents: Cents;
  notes: string | null;
}

export interface PricedCart {
  cartVersion: number;
  currency: string;
  lines: PricedLine[];
  itemCount: number;
  subtotalCents: Cents;
  deliveryCents: Cents;
  totalCents: Cents;
}

export type CartErrorCode =
  | "unknown_sku"
  | "sold_out"
  | "invalid_quantity"
  | "too_many_lines"
  | "line_not_found"
  | "order_too_large"
  | "notes_too_long";

export interface CartError {
  code: CartErrorCode;
  message: string;
}

export type CartResult = { ok: true; cart: Cart } | { ok: false; error: CartError };

export const MAX_NOTES_LENGTH = 120;

export function emptyCart(): Cart {
  return { version: 0, lines: [], nextLine: 1 };
}

export function emptyDetails(): OrderDetails {
  return { customerName: null, fulfillment: null, deliveryAddress: null };
}

function fail(code: CartErrorCode, message: string): CartResult {
  return { ok: false, error: { code, message } };
}

function cleanNotes(notes: string | null | undefined): string | null {
  const t = (notes ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

function sameNotes(a: string | null, b: string | null): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/** Prices a cart against the catalog. Unknown SKUs (catalog changed) are dropped from the priced view. */
export function priceCart(cart: Cart, details: OrderDetails, store: Store): PricedCart {
  const lines: PricedLine[] = [];
  for (const l of cart.lines) {
    const p = findProduct(store, l.sku);
    if (!p) continue;
    lines.push({
      lineId: l.lineId,
      sku: p.sku,
      name: p.name,
      quantity: l.quantity,
      unitCents: p.priceCents,
      lineCents: p.priceCents * l.quantity,
      notes: l.notes,
    });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const deliveryCents = details.fulfillment === "delivery" && lines.length > 0 ? store.deliveryFeeCents : 0;
  return {
    cartVersion: cart.version,
    currency: store.currency,
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotalCents,
    deliveryCents,
    totalCents: subtotalCents + deliveryCents,
  };
}

function checkQuantity(quantity: number, store: Store, allowZero: boolean): CartError | null {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(quantity) || quantity < min || quantity > store.maxQuantityPerLine) {
    return {
      code: "invalid_quantity",
      message: `Quantity must be a whole number from ${min} to ${store.maxQuantityPerLine}.`,
    };
  }
  return null;
}

function checkTotal(cart: Cart, store: Store): CartResult {
  const priced = priceCart(cart, { customerName: null, fulfillment: null, deliveryAddress: null }, store);
  if (priced.subtotalCents > store.maxOrderCents) {
    return fail("order_too_large", "That order is larger than this shop accepts in one chat order.");
  }
  return { ok: true, cart };
}

/** Adds a product. Same SKU with the same notes merges into the existing line. */
export function addItem(cart: Cart, store: Store, sku: string, quantity: number, notes?: string | null): CartResult {
  const product = findProduct(store, sku);
  if (!product) return fail("unknown_sku", `There is no product with SKU "${sku}" on the menu.`);
  if (!product.available) return fail("sold_out", `${product.name} is sold out today.`);
  const qErr = checkQuantity(quantity, store, false);
  if (qErr) return { ok: false, error: qErr };
  const cleaned = cleanNotes(notes);
  if (cleaned && cleaned.length > MAX_NOTES_LENGTH) return fail("notes_too_long", `Notes can have up to ${MAX_NOTES_LENGTH} characters.`);

  const existing = cart.lines.find((l) => l.sku === product.sku && sameNotes(l.notes, cleaned));
  if (existing) {
    const merged = existing.quantity + quantity;
    const mErr = checkQuantity(merged, store, false);
    if (mErr) return { ok: false, error: mErr };
    const lines = cart.lines.map((l) => (l === existing ? { ...l, quantity: merged } : l));
    return checkTotal({ ...cart, version: cart.version + 1, lines }, store);
  }

  if (cart.lines.length >= store.maxLines) return fail("too_many_lines", `An order can have up to ${store.maxLines} different lines.`);
  const line: CartLine = { lineId: `L${cart.nextLine}`, sku: product.sku, quantity, notes: cleaned };
  return checkTotal({ version: cart.version + 1, lines: [...cart.lines, line], nextLine: cart.nextLine + 1 }, store);
}

/**
 * Changes a line's quantity (0 removes it) and, if `notes` is a string or
 * null, its notes. `notes: undefined` keeps the current notes.
 */
export function updateLine(cart: Cart, store: Store, lineId: string, quantity: number, notes?: string | null): CartResult {
  const line = cart.lines.find((l) => l.lineId === lineId.trim().toUpperCase());
  if (!line) return fail("line_not_found", `There is no line "${lineId}" in the cart.`);
  const qErr = checkQuantity(quantity, store, true);
  if (qErr) return { ok: false, error: qErr };
  if (quantity === 0) {
    return { ok: true, cart: { ...cart, version: cart.version + 1, lines: cart.lines.filter((l) => l !== line) } };
  }
  const newNotes = notes === undefined ? line.notes : cleanNotes(notes);
  if (newNotes && newNotes.length > MAX_NOTES_LENGTH) return fail("notes_too_long", `Notes can have up to ${MAX_NOTES_LENGTH} characters.`);
  const lines = cart.lines.map((l) => (l === line ? { ...l, quantity, notes: newNotes } : l));
  return checkTotal({ ...cart, version: cart.version + 1, lines }, store);
}

/** What is still missing before checkout. Empty array = ready. */
export function missingForCheckout(cart: Cart, details: OrderDetails): string[] {
  const missing: string[] = [];
  if (cart.lines.length === 0) missing.push("at least one item in the cart");
  if (!details.customerName) missing.push("the customer's name");
  if (!details.fulfillment) missing.push("pickup or delivery");
  if (details.fulfillment === "delivery" && !details.deliveryAddress) missing.push("the delivery address");
  return missing;
}
