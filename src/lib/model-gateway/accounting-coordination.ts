import "server-only";
import { Prisma } from "@prisma/client";

/** All balance/hold/adoption writers acquire this before any row lock.
 * It fences even an absent pool and prevents wallet creation phantoms at adoption.
 * Transaction scoped, with a fixed application namespace; never a session lock.
 */
export async function lockGatewayAccounting(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(1935765098, 1129466192)::text`;
}

export async function lockGatewayAccountingIdentities(tx: Prisma.TransactionClient, userIds: string[]) {
  await lockGatewayAccounting(tx);
  const ids = [...new Set(userIds)].sort();
  if (ids.length) await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
}

/** Fixed order: coordination -> sorted User SHARE -> total pool -> wallet -> order. */
export async function lockGatewayAccountingPool(tx: Prisma.TransactionClient) {
  await lockGatewayAccounting(tx);
  await tx.$queryRaw`SELECT "id" FROM "GatewayCreditPool" WHERE "id" = 'total' FOR UPDATE`;
  return tx.gatewayCreditPool.findUnique({ where: { id: "total" } });
}
