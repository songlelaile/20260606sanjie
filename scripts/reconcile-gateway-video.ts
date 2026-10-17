// node --conditions=react-server --import tsx scripts/reconcile-gateway-video.ts
import { prisma } from "../src/lib/db";
import { reconcileGatewayVideoJobs, type GatewayVideoReconcileOptions } from "../src/lib/model-gateway/gateway-video-reconcile";
async function main() {
  const options: GatewayVideoReconcileOptions = {};
  const names = { "--limit": "limit", "--concurrency": "concurrency", "--min-age-ms": "minAgeMs" } as const;
  try {
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index] as keyof typeof names; const value = args[index + 1];
      if (!Object.hasOwn(names, name) || !value || !/^[1-9]\d*$/.test(value) || options[names[name]] !== undefined) throw new Error("Invalid arguments");
      options[names[name]] = Number(value);
    }
    const result = await reconcileGatewayVideoJobs(options);
    process.stdout.write(JSON.stringify({ schema: "SANJIE_GATEWAY_VIDEO_RECONCILE_V1", ...result }) + "\n");
    if (result.errors) process.exitCode = 1;
  } catch {
    process.stderr.write("GATEWAY_VIDEO_RECONCILE_FAILED\n"); process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
void main();
