import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  preview: { port: 4174 },
  build: { target: "es2022" },
  test: { environment: "jsdom", include: ["test/**/*.test.{ts,tsx}"] },
});
