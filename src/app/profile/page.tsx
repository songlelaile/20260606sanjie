import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileCenter, type ProfileTab } from "@/components/profile/ProfileCenter";
import { getCreativeCredits } from "@/lib/creative-credit";
import { getCurrentUser } from "@/lib/server-session";

export const metadata: Metadata = { title: "个人中心 · 三阶引擎" };
export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") redirect("/login");
  const params = await searchParams;
  const initialTab: ProfileTab = params.tab === "credits" || params.tab === "orders" || params.tab === "tutorials" ? params.tab : "account";
  const credits = await getCreativeCredits(user.id).catch(() => null);
  return <ProfileCenter key={user.id} account={{
    username: user.username, name: user.name, email: user.email,
    shopName: user.shopName,
    createdAt: user.createdAt.toISOString()
  }} initialTab={initialTab} initialCredits={credits} />;
}
