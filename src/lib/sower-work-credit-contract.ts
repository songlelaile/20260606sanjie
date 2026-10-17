import type { CreativeCreditsData, CreativeCreditLedgerData } from "@/lib/creative-credit-contract";

export const SOWER_WORK_CREDITS_URL = "/api/sower-work/credits";
export const SOWER_WORK_CREDIT_LEDGER_URL = "/api/sower-work/credits/ledger";
export const SOWER_WORK_PACKAGE_URL = "/models";

/** The SaaS wallet is displayed here; Sower tasks do not yet settle against it. */
export const SOWER_WORK_CREDIT_META = {
  source: "sanjie_gateway",
  mode: "read_only",
  sowerTaskBilling: "not_integrated"
} as const;

export type SowerWorkCreditsResponse = { data: CreativeCreditsData; meta: typeof SOWER_WORK_CREDIT_META };
export type SowerWorkCreditLedgerResponse = { data: CreativeCreditLedgerData; meta: typeof SOWER_WORK_CREDIT_META };
