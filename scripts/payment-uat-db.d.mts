export function createPaymentUatDatabase(): Promise<{
  schemaName: string;
  url: string;
  cleanup: () => Promise<void>;
}>;
