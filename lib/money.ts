// Money is always an integer number of cents. Floats never touch an amount:
// prices come from the catalog in cents, totals are integer sums, and the
// strings PayPal needs ("55.00") are built and parsed digit by digit.

export type Cents = number;

export function isCents(n: unknown): n is Cents {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function assertCents(n: number, label = "amount"): Cents {
  if (!isCents(n)) throw new Error(`${label} must be a non-negative integer number of cents`);
  return n;
}

/** 5500 → "55.00" (the `value` format of the PayPal Orders API). */
export function toPayPalValue(cents: Cents): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** "55.00" | "55.5" | "55" → 5500 | 5550 | 5500. Returns null if it is not a plain positive decimal. */
export function parsePayPalValue(value: string): Cents | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const fraction = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 123450 → "$1,234.50" (prices on this demo are in Mexican pesos). */
export function formatMoney(cents: Cents): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

/** 123450, "MXN" → "$1,234.50 MXN". */
export function formatMoneyWithCurrency(cents: Cents, currency: string): string {
  return `${formatMoney(cents)} ${currency}`;
}
