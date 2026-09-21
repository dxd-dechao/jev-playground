import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Unit tests cover the pure logic in lib/. Browser behaviour is covered by
    // Playwright in tests/playground.spec.ts, which vitest must not pick up.
    include: ["tests/**/*.test.ts"],
  },
});
