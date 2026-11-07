// The demo store. It is FICTIONAL: the name, menu and prices are made up for
// this demo. Prices are in Mexican pesos (MXN), in cents, VAT included (in
// Mexico consumer prices include IVA, so there is no separate tax line).
//
// This file is the only source of prices. The agent reads the menu, but every
// amount that reaches the customer or PayPal is computed by lib/cart.ts from
// these numbers.

import type { Cents } from "./money";

export type Category = "coffee" | "chocolate" | "bakery" | "sweets" | "beans";

export interface Product {
  /** Stable id the agent uses in tool calls. */
  sku: string;
  /** Name as it appears on the menu (Spanish, as in the shop). */
  name: string;
  /** Short English description (the agent translates as needed). */
  description: string;
  category: Category;
  priceCents: Cents;
  /** false = sold out today. The agent can mention it but cannot sell it. */
  available: boolean;
}

export interface Store {
  name: string;
  /** Always shown next to the name in the UI. */
  disclaimer: string;
  city: string;
  timezone: string;
  currency: "MXN";
  pickupLeadMinutes: number;
  deliveryFeeCents: Cents;
  deliveryArea: string;
  maxQuantityPerLine: number;
  maxLines: number;
  maxOrderCents: Cents;
  products: readonly Product[];
}

export const STORE: Store = {
  name: "Café Tres Campanas",
  disclaimer: "Fictional demo shop",
  city: "Morelia, Michoacán, Mexico",
  timezone: "America/Mexico_City",
  currency: "MXN",
  pickupLeadMinutes: 15,
  deliveryFeeCents: 3500,
  deliveryArea: "Centro Histórico of Morelia only",
  maxQuantityPerLine: 20,
  maxLines: 15,
  maxOrderCents: 500000,
  products: [
    { sku: "CAFE-OLLA", name: "Café de olla", description: "Clay-pot coffee with cinnamon and piloncillo, 12 oz", category: "coffee", priceCents: 4500, available: true },
    { sku: "AMERICANO", name: "Americano", description: "Black coffee, 12 oz", category: "coffee", priceCents: 4000, available: true },
    { sku: "LATTE", name: "Latte", description: "Espresso with steamed milk, 12 oz", category: "coffee", priceCents: 5500, available: true },
    { sku: "CAPUCHINO", name: "Capuchino", description: "Espresso, steamed milk and foam, 12 oz", category: "coffee", priceCents: 5500, available: true },
    { sku: "CHOCOLATE", name: "Chocolate de metate", description: "Stone-ground Michoacán hot chocolate, 12 oz", category: "chocolate", priceCents: 6000, available: true },
    { sku: "CONCHA", name: "Concha", description: "Classic sweet bread with a vanilla or chocolate shell", category: "bakery", priceCents: 2200, available: true },
    { sku: "PAN-MUERTO", name: "Pan de muerto", description: "Seasonal orange-blossom sweet bread", category: "bakery", priceCents: 3800, available: true },
    { sku: "UCHEPOS", name: "Uchepos con crema", description: "Two sweet fresh-corn tamales with cream", category: "bakery", priceCents: 5800, available: false },
    { sku: "ATE-250", name: "Ate moreliano", description: "Guava and quince fruit paste, 250 g box", category: "sweets", priceCents: 8500, available: true },
    { sku: "CAFE-URUAPAN", name: "Café de Uruapan en grano", description: "Whole-bean coffee from Uruapan, Michoacán, 250 g bag", category: "beans", priceCents: 18000, available: true },
  ],
};

export function findProduct(store: Store, sku: string): Product | undefined {
  const wanted = sku.trim().toUpperCase();
  return store.products.find((p) => p.sku === wanted);
}
