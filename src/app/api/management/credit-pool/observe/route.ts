import { observeCreditPool } from "@/lib/model-gateway/credit-pool-observation";
import { creditPoolRead } from "../_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() { return creditPoolRead(() => observeCreditPool()); }
