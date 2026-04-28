import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{js,ts}"],
    environment: "node",
    setupFiles: ["src/web/__tests__/setup.js"],
  },
});
