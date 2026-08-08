import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { SESSION_COOKIE, parseSession } from "@/lib/auth";
import { getShopSwitcherData } from "@/lib/store/runtime-store";
import "./globals.css";

export const metadata: Metadata = {
  title: "三阶引擎 SaaS",
  description: "基于三阶引擎 V9 的多租户管理决策系统"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const session = await parseSession(store.get(SESSION_COOKIE)?.value);
  // 旧会话对应的账号被停用、删除或迁移租户时，登录页仍必须可以打开并覆盖旧 cookie。
  const shopSwitcher = session ? await getShopSwitcherData().catch(() => null) : null;

  return (
    <html lang="zh-CN">
      <body>
        {session && shopSwitcher ? (
          <AppShell role={session.role} userName={session.name} shopSwitcher={shopSwitcher}>
            {children}
          </AppShell>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
