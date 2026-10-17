import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Next.js preserves JSX; the isolated UI checks transform it for server rendering.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
  test: { environment: "node", globals: true, include: ["src/components/model-gateway/*.ui-test.ts", "src/components/model-gateway/relay-form.test.ts"] }
});
