export interface WebsiteVideoHandlerOptions {
  prisma: unknown;
  verifySessionToken: (value: string) => Promise<unknown>;
  lookupUser: (username: string) => Promise<unknown>;
}
export function createWebsiteHandler(options: WebsiteVideoHandlerOptions): (request: Request) => Promise<Response>;
