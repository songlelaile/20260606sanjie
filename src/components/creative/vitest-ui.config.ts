import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Next.js preserves JSX; these entry checks render the real page and rail.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
  test: { environment: "node", include: ["src/lib/creative-list-entry.ui-test.ts"] }
});
