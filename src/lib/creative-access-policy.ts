/** Production compatibility DTO. Current production allows every valid signed-in account.
 * The separate development checkout's payment/invitation resolver is deliberately absent. */
export type CreativeAccess = {
  allowed: boolean;
  reason: "admin" | "authenticated" | "invalid_account" | "unavailable";
  expiresAt: string | null;
};
