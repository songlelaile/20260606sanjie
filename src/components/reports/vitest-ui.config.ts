import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Match Next.js JSX output with the isolated server-rendered UI checks.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
  test: {
    environment: "node",
    globals: true,
    include: ["src/components/reports/*.ui-test.ts"]
  }
});
