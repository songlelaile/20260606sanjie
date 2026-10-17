import "server-only";
import { parseSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createWebsiteHandler } from "./video-assets-r51/site-adapter.cjs";

// No credentials or tenant defaults are compiled into the client or route.
export const handleVideoAssets = createWebsiteHandler({
  prisma,
  verifySessionToken: parseSession,
  lookupUser: (username: string) => prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, tenantId: true, authRole: true, status: true }
  })
});
