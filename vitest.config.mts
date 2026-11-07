import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests never reach the network: Claude and PayPal are always test doubles.
    setupFiles: ["tests/support/env.ts"],
    environment: "node",
  },
});
