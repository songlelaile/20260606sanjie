"use client";

import { BookOpen, Code2, Coins, CreditCard, History, LogOut, Settings2, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./AccountMenu.module.css";

export function AccountMenu({ userName, email, onLogout }: {
  userName: string;
  email?: string;
  onLogout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    async function refresh() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const response = await fetch("/api/creative/credits", { cache: "no-store", signal: current.signal });
        const json = await response.json();
        const value = json?.data?.wallet?.availablePoints ?? json?.data?.wallet?.balancePoints;
        if (!response.ok || typeof value !== "number" || !Number.isFinite(value)) throw new Error("unavailable");
        if (!disposed && !current.signal.aborted) { setBalance(value); setBalanceError(false); }
      } catch {
        if (!disposed && !current.signal.aborted) { setBalance(null); setBalanceError(true); }
      }
    }
    void refresh();
    window.addEventListener("sanjie:payment-paid", refresh);
    window.addEventListener("sanjie:credits-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      window.removeEventListener("sanjie:payment-paid", refresh);
      window.removeEventListener("sanjie:credits-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [pathname, email, open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div className={styles.bar}>
    <Link href="/models" prefetch={false} className={styles.pricing}><CreditCard size={15} />套餐价格</Link>
    <div className={styles.account} ref={container} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button ref={trigger} type="button" className={styles.avatar} aria-label="账户菜单"
        aria-expanded={open} aria-controls="personal-account-menu" onClick={() => setOpen(value => !value)}>
        <UserRound size={18} />
      </button>
      {open ? <div id="personal-account-menu" className={styles.dropdown}>
        <div className={styles.identity}><strong>{email || userName}</strong>{email ? <small>{userName}</small> : null}</div>
        <nav aria-label="个人账户" onClick={() => setOpen(false)}>
          <Link href="/profile" prefetch={false}><UserRound size={15} />个人中心</Link>
          <Link href="/profile?tab=credits" prefetch={false}><Coins size={15} />{balance !== null ? `${balance.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 积分` : balanceError ? "积分暂不可用" : "积分读取中…"}</Link>
          <Link href="/profile?tab=tutorials" prefetch={false}><BookOpen size={15} />使用教程</Link>
          <Link href="/dashboards/operating-network?history=1" prefetch={false}><History size={15} />生图历史</Link>
          <Link href={`${pathname === "/dashboards/operating-network/video" ? pathname : "/dashboards/operating-network"}?apiConfig=1`} prefetch={false}><Settings2 size={15} />自定义配置 API</Link>
          <Link href="/models?tab=api" prefetch={false}><Code2 size={15} />API 接入与调用记录</Link>
        </nav>
        <button type="button" className={styles.logout} onClick={() => { setOpen(false); void onLogout(); }}><LogOut size={15} />退出登录</button>
      </div> : null}
    </div>
  </div>;
}
