export const dynamic = "force-dynamic";
// The browser redirect is never certification evidence. The authenticated
// originating session queries the supplier result with its server-held token.
export function GET() {
  return new Response(null, { status: 303, headers: { Location: "/dashboards/operating-network/video", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}
