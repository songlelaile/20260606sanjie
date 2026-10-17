import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("runs the native image provider rejection and selected-model regression cases without skips", () => {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", resolve("scripts/image-prompt-lab-tenant-errors.node-test.mjs")], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000
  });
  const output = result.stdout + result.stderr;
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/^# tests 11$/m);
  expect(output).toMatch(/^# pass 11$/m);
  expect(output).toMatch(/^# fail 0$/m);
  expect(output).toMatch(/^# skipped 0$/m);
  expect(output).toMatch(/^# cancelled 0$/m);
  expect(output).toContain("model_not_found preserves the selected hosted or own-API model without fallback or saved-config mutation");
});

it("retains the native video analysis personal-Key and account-isolation regression cases without skips", () => {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", resolve("scripts/video-analysis-api-followup.node-test.cjs")], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000
  });
  const output = result.stdout + result.stderr;
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/^# tests 51$/m);
  expect(output).toMatch(/^# pass 51$/m);
  expect(output).toMatch(/^# fail 0$/m);
  expect(output).toMatch(/^# skipped 0$/m);
  expect(output).toMatch(/^# cancelled 0$/m);
});
