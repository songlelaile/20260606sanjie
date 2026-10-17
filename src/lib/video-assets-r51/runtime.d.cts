export type AssetScope = { tenantId: string; userId: string; providerAccountId: string; projectName: string };
export type AssetIdentity = { tenantId: string; userId: string; accountKey: string };
export type ProviderSelection = { provider: string; apiOrigin: string; credentialFingerprint: string };
export interface AssetRuntime {
  handler(request: Request): Promise<Response>;
  requestResolver: { resolve(identity: AssetIdentity, selection: ProviderSelection, options?: { requirePlatform?: boolean }): Promise<AssetScope> };
  bindingResolver: { resolve(scope: AssetScope): Promise<unknown> };
  assetService: {
    ingest(scope: AssetScope, input: unknown): Promise<unknown>;
    list(scope: AssetScope): Promise<unknown>;
    capabilities(scope: AssetScope): Promise<{ portraitAvailable: boolean }>;
    refresh(scope: AssetScope, id: string): Promise<unknown>;
    createValidation(scope: AssetScope, input: { idempotencyKey: string }): Promise<unknown>;
    getValidation(scope: AssetScope, id: string): Promise<unknown>;
    verifyValidation(scope: AssetScope, id: string): Promise<unknown>;
    resolveReferences(scope: AssetScope, assetIds: string[]): Promise<Array<{ id: string; url: string }>>;
    acquireLease(scope: AssetScope, input: { taskId: string; assetIds: string[] }): Promise<{ taskId: string; references: Array<{ id: string; url: string }> }>;
    releaseLease(scope: AssetScope, input: { taskId: string; terminalStatus: string }): Promise<unknown>;
  };
  taskService: unknown;
  sourceStore: unknown;
  configurationRevision: string;
}
export function createRuntime(options: Record<string, unknown>): Promise<AssetRuntime>;
