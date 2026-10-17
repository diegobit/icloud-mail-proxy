import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Installs crypto.subtle.timingSafeEqual under Node (Workers has it).
    setupFiles: ["test/support/workers-crypto.ts"],
  },
});
