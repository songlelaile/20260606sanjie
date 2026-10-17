import { handleVideoAssets } from "@/lib/video-assets-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleVideoAssets;
export const HEAD = handleVideoAssets;
export const POST = handleVideoAssets;
export const PATCH = handleVideoAssets;
export const DELETE = handleVideoAssets;
export const OPTIONS = handleVideoAssets;
