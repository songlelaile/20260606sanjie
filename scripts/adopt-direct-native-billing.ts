import { prisma } from "../src/lib/db";
import { adoptDirectNativeBillingHold, getGatewayAvailableBalance } from "../src/lib/model-gateway/billing-hold";

const userId = "cmq8dzkut000278n6u8s0hb8v";
const eventId = "native-video:a4d11726-8e0e-4e9e-a1e5-f58cf55925f4";

async function main() {
  try {
    const before = await getGatewayAvailableBalance(prisma, userId);
    const result = await adoptDirectNativeBillingHold({ userId, eventId, expectedHeldCents: 1000 });
    const after = await getGatewayAvailableBalance(prisma, userId);
    const history = await prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::BIGINT AS "count"
      FROM "GatewayBillingLedger" WHERE "billingEventId" = ${eventId}`;
    if (result.hold.status !== "unknown" || result.hold.heldCents !== 0 || result.hold.quoteCents !== 1000 ||
        history[0]?.count !== 0n) throw new Error("DIRECT_BILLING_POLICY_VERIFICATION_FAILED");
    process.stdout.write(JSON.stringify({ schema: "SANJIE_DIRECT_BILLING_POLICY_V1", replayed: result.replayed,
      before, after, originalQuoteCents: result.hold.quoteCents, taskRemainsUnknown: true,
      actualUsageCreated: false, refundCreated: false }) + "\n");
  } catch {
    process.stderr.write("DIRECT_BILLING_POLICY_FAILED\n");
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
void main();
