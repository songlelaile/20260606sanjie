import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { SESSION_COOKIE, parseSession } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "三阶引擎 SaaS",
  description: "基于三阶引擎 V9 的多租户管理决策系统"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const session = parseSession(store.get(SESSION_COOKIE)?.value);

  return (
    <html lang="zh-CN">
      <body>
        {session ? (
          <AppShell role={session.role} userName={session.name}>
            {children}
          </AppShell>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
