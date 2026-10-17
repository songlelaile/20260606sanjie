export interface WebsiteVideoHandlerOptions {
  prisma: unknown;
  verifySessionToken: (value: string) => Promise<unknown>;
  lookupUser: (username: string) => Promise<unknown>;
}
export function createWebsiteHandler(options: WebsiteVideoHandlerOptions): (request: Request) => Promise<Response>;
export function readConfiguration(env?: Record<string, string | undefined>): Promise<Record<string, unknown> | null>;
export function readSecret(name: string, env?: Record<string, string | undefined>): string;
