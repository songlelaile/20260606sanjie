// Run once with the existing application's environment:
// node --conditions=react-server --import tsx scripts/reconcile-native-video.ts
import { prisma } from "../src/lib/db";
import { reconcileNativeVideoJobs, type NativeVideoReconcileOptions } from "../src/lib/model-gateway/native-video-reconcile";

async function main() {
 const options: NativeVideoReconcileOptions = {};
 const names = { "--limit": "limit", "--concurrency": "concurrency", "--min-age-ms": "minAgeMs" } as const;
 const argumentsList = process.argv.slice(2);
 try {
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index] as keyof typeof names;
    const value = argumentsList[index + 1];
    if (!Object.hasOwn(names, name) || !value || !/^[1-9]\d*$/.test(value) || options[names[name]] !== undefined) throw new Error("Invalid arguments");
    options[names[name]] = Number(value);
  }
  const result = await reconcileNativeVideoJobs(options);
  process.stdout.write(JSON.stringify({ schema: "SANJIE_NATIVE_VIDEO_RECONCILE_V1", ...result }) + "\n");
  if (result.errors) process.exitCode = 1;
 } catch (error) {
  const invalid = error instanceof Error && /^Invalid (arguments|limit|concurrency|minAgeMs)$/.test(error.message);
  process.stderr.write((invalid ? "NATIVE_VIDEO_RECONCILE_INVALID_ARGUMENTS" : "NATIVE_VIDEO_RECONCILE_FAILED") + "\n");
  process.exitCode = 1;
 } finally {
  await prisma.$disconnect();
 }
}
void main();
