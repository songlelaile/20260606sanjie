"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, CheckCircle2, Coins, CreditCard, History, ImageIcon, RefreshCw, UserRound, Wallet } from "lucide-react";
import { centsToPoints } from "@/lib/model-gateway/billing-contract";
import { AWAITING_CREDIT_ALLOCATION_LABEL, gatewayOrderDisplayStatus, isGatewayOrderAwaitingCapacity } from "@/lib/model-gateway/scan-payment-contract";
import type { CreativeCreditsData, CreativeCreditLedgerData } from "@/lib/creative-credit-contract";
import styles from "./ProfileCenter.module.css";

export type ProfileTab = "account" | "credits" | "orders" | "tutorials";
// Older credit responses omit hold fields; use the balance only in that case.
type ProfileCreditsData = CreativeCreditsData & {
  wallet: CreativeCreditsData["wallet"] & { availableCents?: number; reservedCents?: number };
};
export type ProfileAccount = {
  username: string; name: string; email: string;
  shopName: string; createdAt: string;
};
type ProfileOrder = {
  id: string; planName: string; amountCents: number; creditCents: number;
  status: string; creditAllocationState?: string; paymentProvider: string; createdAt: string; paidAt: string | null;
};
type OrderPage = { items: ProfileOrder[]; total: number; page: number; pageSize: number };
const HISTORY_URL = "/dashboards/operating-network?history=1";
const TABS = [
  { id: "account", label: "账户信息", icon: UserRound },
  { id: "credits", label: "积分明细", icon: Coins },
  { id: "orders", label: "充值订单", icon: CreditCard },
  { id: "tutorials", label: "使用教程", icon: BookOpen }
] as const;
const kindLabels: Record<string, string> = { opening: "期初余额", recharge: "积分充值", gift: "管理员赠送", debit: "模型消费", error: "请求异常" };
const ledgerStatuses: Record<string, string> = { ok: "已完成", error: "失败", preflight_rejected: "余额不足，未提交", settlement_rejected: "结算拒绝", settlement_failed: "结算异常" };
const orderStatuses: Record<string, string> = { paid: "已支付 · 已到账", pending: "待支付确认", awaiting_capacity: AWAITING_CREDIT_ALLOCATION_LABEL, expired: "已过期", closed: "已关闭", failed: "支付失败" };
const points = (cents: number) => Number.isSafeInteger(cents) ? centsToPoints(cents).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "—";
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};

async function readData<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) throw new Error("读取失败");
  return body.data as T;
}

function Pagination({ data, loading, onPage }: {
  data: { page: number; pageSize: number; total: number } | null;
  loading: boolean; onPage: (page: number) => void;
}) {
  if (!data || data.total <= data.pageSize) return null;
  return <div className={styles.pagination}>
    <span>共 {data.total} 条 · 第 {data.page} / {Math.ceil(data.total / data.pageSize)} 页</span>
    <button type="button" disabled={loading || data.page <= 1} onClick={() => onPage(data.page - 1)}>上一页</button>
    <button type="button" disabled={loading || data.page * data.pageSize >= data.total} onClick={() => onPage(data.page + 1)}>下一页</button>
  </div>;
}

export function ProfileRechargeOrder({ order }: { order: ProfileOrder }) {
  const awaiting = isGatewayOrderAwaitingCapacity(order);
  return <article className={styles.order}>
    <div className={styles.orderTop}><div><h3>{order.planName}</h3><span className={`${styles.orderStatus} ${order.status === "paid" && !awaiting ? styles.paid : ""}`}>{orderStatuses[gatewayOrderDisplayStatus(order)] || order.status}</span></div><strong>¥{(order.amountCents / 100).toFixed(2)}</strong></div>
    <div className={styles.orderMeta}><span>{points(order.creditCents)} 积分</span><span>{({ alipay: "支付宝", wechat: "微信支付", manual: "人工充值" } as Record<string, string>)[order.paymentProvider] || "其他支付方式"}</span><span>{time(order.createdAt)}</span></div>
    <div className={styles.orderBottom}><span>订单号：{order.id}{order.paidAt && !awaiting ? <small>到账时间：{time(order.paidAt)}</small> : null}</span>{["alipay", "wechat"].includes(order.paymentProvider) && (order.status === "pending" || awaiting) ? <Link href={`/models?recharge=1&orderId=${encodeURIComponent(order.id)}`}>{awaiting ? "查看分配状态" : "继续付款"} <ArrowRight size={14} aria-hidden="true" /></Link> : null}</div>
  </article>;
}

export function ProfileCenter({ account, initialTab = "account", initialCredits }: {
  account: ProfileAccount; initialTab?: ProfileTab; initialCredits: ProfileCreditsData | null;
}) {
  const [tab, setTab] = useState(initialTab);
  const [credits, setCredits] = useState(initialCredits);
  const [creditError, setCreditError] = useState(initialCredits ? "" : "积分信息暂不可用，请刷新重试");
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [ledger, setLedger] = useState<CreativeCreditLedgerData | null>(null);
  const [orders, setOrders] = useState<OrderPage | null>(null);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [orderPage, setOrderPage] = useState(1);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState("");

  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    const abort = new AbortController();
    setRefreshing(true);
    readData<ProfileCreditsData>("/api/creative/credits", abort.signal)
      .then(data => { if (!abort.signal.aborted) { setCredits(data); setCreditError(""); } })
      .catch(() => { if (!abort.signal.aborted) { setCredits(null); setCreditError("积分信息暂不可用，请刷新重试"); } })
      .finally(() => { if (!abort.signal.aborted) setRefreshing(false); });
    return () => abort.abort();
  }, [revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("sanjie:payment-paid", refresh);
    return () => window.removeEventListener("sanjie:payment-paid", refresh);
  }, []);
  useEffect(() => {
    if (tab !== "credits" && tab !== "orders") return;
    const abort = new AbortController();
    setRecordLoading(true); setRecordError("");
    if (tab === "credits") {
      setLedger(null);
      readData<CreativeCreditLedgerData>(`/api/creative/credits/ledger?page=${ledgerPage}`, abort.signal)
        .then(data => { if (!abort.signal.aborted) setLedger(data); })
        .catch(() => { if (!abort.signal.aborted) setRecordError("积分明细读取失败，请刷新重试"); })
        .finally(() => { if (!abort.signal.aborted) setRecordLoading(false); });
    } else {
      setOrders(null);
      readData<OrderPage>(`/api/profile/orders?page=${orderPage}`, abort.signal)
        .then(data => { if (!abort.signal.aborted) setOrders(data); })
        .catch(() => { if (!abort.signal.aborted) setRecordError("充值订单读取失败，请刷新重试"); })
        .finally(() => { if (!abort.signal.aborted) setRecordLoading(false); });
    }
    return () => abort.abort();
  }, [tab, ledgerPage, orderPage, revision]);

  const displayName = account.name.trim() || account.username;
  const refreshButton = <button type="button" className={styles.refresh} disabled={refreshing || recordLoading}
    onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新</button>;

  return <div className={styles.center}>
    <header className={styles.heading}>
      <div><span className={styles.eyebrow}>MY ACCOUNT</span><h1>个人中心</h1><p>管理你的账户、积分与充值记录。</p></div>
      <Link className={styles.backLink} href="/dashboards/operating-network">进入创作工作台 <ArrowRight size={15} aria-hidden="true" /></Link>
    </header>

    <section className={styles.overview} aria-label="账户概览">
      <div className={styles.identity}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(displayName)[0]}</span>
        <div><h2>{displayName}</h2><p>{account.email || account.username}</p><span className={styles.accountBadge}><CheckCircle2 size={13} aria-hidden="true" />已登录</span></div>
      </div>
      <div className={styles.balance}>
        <span className={styles.statLabel}><Wallet size={16} aria-hidden="true" />可用积分</span>
        <strong>{credits && credits.wallet.exists ? points(credits.wallet.availableCents ?? credits.wallet.balanceCents) : "—"}<small>积分</small></strong>
        {credits?.wallet.exists && Number(credits.wallet.reservedCents) > 0 ? <p>冻结 {points(credits.wallet.reservedCents!)} 积分 · 任务结算后更新</p> : null}
        <p>{credits ? credits.wallet.exists ? "每一次创作，清楚掌握积分变化" : "尚未开通积分钱包" : creditError}</p>
      </div>
      <div className={styles.plan}>
        <span className={styles.statLabel}>当前套餐</span>
        <strong>{credits ? credits.plan.name : "暂不可用"}</strong>
        <Link href="/models" className={styles.buyButton}>购买积分 <ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
    </section>

    <nav className={styles.tabs} aria-label="个人中心导航">
      {TABS.map(({ id, label, icon: Icon }) => <Link key={id} href={id === "account" ? "/profile" : `/profile?tab=${id}`}
        aria-current={tab === id ? "page" : undefined} className={tab === id ? styles.activeTab : ""}>
        <Icon size={16} aria-hidden="true" />{label}
      </Link>)}
    </nav>

    {tab === "account" ? <div className={styles.accountGrid}>
      <section className={styles.panel} aria-labelledby="profile-details-title">
        <div className={styles.panelHeading}><div><h2 id="profile-details-title">账户信息</h2><p>当前登录账户的个人资料</p></div>{refreshButton}</div>
        <dl className={styles.details}>
          <div><dt>昵称</dt><dd>{displayName}</dd></div>
          <div><dt>登录账号</dt><dd>{account.username}</dd></div>
          <div><dt>电子邮箱</dt><dd>{account.email || "未填写"}</dd></div>
          <div><dt>店铺名称</dt><dd>{account.shopName || "未填写"}</dd></div>
          <div><dt>注册时间</dt><dd>{time(account.createdAt)}</dd></div>
        </dl>
      </section>
      <section className={styles.panel} aria-labelledby="profile-quick-title">
        <div className={styles.panelHeading}><div><h2 id="profile-quick-title">常用功能</h2><p>继续你的创作</p></div></div>
        <div className={styles.quickLinks}>
          <Link href={HISTORY_URL}><span className={styles.quickIcon}><History size={20} aria-hidden="true" /></span><span><b>生图历史</b><small>查看当前浏览器保存的生成记录</small></span><ArrowRight size={16} aria-hidden="true" /></Link>
          <Link href="/profile?tab=orders"><span className={styles.quickIcon}><CreditCard size={20} aria-hidden="true" /></span><span><b>充值订单</b><small>查看付款状态与积分到账记录</small></span><ArrowRight size={16} aria-hidden="true" /></Link>
          <Link href="/profile?tab=tutorials"><span className={styles.quickIcon}><BookOpen size={20} aria-hidden="true" /></span><span><b>使用教程</b><small>从购买积分到完成第一张作品</small></span><ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>
    </div> : null}

    {tab === "credits" || tab === "orders" ? <section className={styles.panel} aria-labelledby="profile-records-title">
      <div className={styles.panelHeading}><div><h2 id="profile-records-title">{tab === "credits" ? "积分明细" : "充值订单"}</h2><p>{tab === "credits" ? "查看本账户的充值、消费与余额变化。" : "支付状态以核验结果为准，待支付订单尚未计入余额。"}</p></div>{refreshButton}</div>
      {recordError ? <div className={styles.empty} role="alert"><p>{recordError}</p><button type="button" onClick={() => setRevision(value => value + 1)}>重新加载</button></div>
        : recordLoading || (tab === "credits" ? !ledger : !orders) ? <div className={styles.empty} role="status">正在读取{tab === "credits" ? "积分明细" : "充值订单"}…</div>
          : tab === "credits" ? <>
            {ledger?.items.length ? <div className={styles.records}>{ledger.items.map(row => <details key={row.id} className={styles.record}>
              <summary><span className={styles.recordIcon}><Coins size={19} aria-hidden="true" /></span><span className={styles.recordMain}><b>{kindLabels[row.kind] || row.kind}{row.model ? ` · ${row.model}` : ""}</b><small>{time(row.createdAt)} · {ledgerStatuses[row.status] || row.status}</small></span><span className={`${styles.recordAmount} ${row.deltaCents > 0 ? styles.positive : ""}`}><b>{row.deltaCents > 0 ? "+" : row.deltaCents < 0 ? "−" : ""}{points(Math.abs(row.deltaCents))} 积分</b><small>余额 {points(row.balanceAfterCents)}</small></span></summary>
              <dl className={styles.recordDetails}><dt>余额变化</dt><dd>{points(row.balanceBeforeCents)} → {points(row.balanceAfterCents)} 积分</dd><dt>当前记录套餐</dt><dd>{row.planName || "—"}</dd><dt>记录编号</dt><dd>{row.billingEventId}</dd>{row.requestId ? <><dt>请求编号</dt><dd>{row.requestId}</dd></> : null}</dl>
            </details>)}</div> : <div className={styles.empty}><Coins size={28} aria-hidden="true" /><h3>暂无积分明细</h3><p>充值和本站积分消费完成后，会显示在这里。</p></div>}
            <Pagination data={ledger} loading={recordLoading} onPage={setLedgerPage} />
            <p className={styles.footnote}>使用自有 API 的费用由对应服务商计收；图片作品请前往<Link href={HISTORY_URL}>生图历史</Link>查看。</p>
          </> : <>
            {orders?.items.length ? <div className={styles.records}>{orders.items.map(order => <ProfileRechargeOrder key={order.id} order={order} />)}</div> : <div className={styles.empty}><CreditCard size={28} aria-hidden="true" /><h3>暂无充值订单</h3><p>选择适合你的积分套餐，开启下一次创作。</p><Link className={styles.buyButton} href="/models">购买积分</Link></div>}
            <Pagination data={orders} loading={recordLoading} onPage={setOrderPage} />
          </>}
    </section> : null}

    {tab === "tutorials" ? <section className={styles.panel} aria-labelledby="profile-tutorials-title">
      <div className={styles.panelHeading}><div><h2 id="profile-tutorials-title">使用教程</h2><p>三个步骤，开始你的第一张创作。</p></div></div>
      <div className={styles.tutorials}>
        <article><span className={styles.step}>01</span><Coins size={25} aria-hidden="true" /><h3>购买积分</h3><p>在购买积分页面选择套餐，按页面提供的支付方式完成付款。付款核验成功后，在个人中心查看到账积分。</p><Link href="/models">查看积分套餐 <ArrowRight size={14} aria-hidden="true" /></Link></article>
        <article><span className={styles.step}>02</span><ImageIcon size={25} aria-hidden="true" /><h3>开始创作</h3><p>进入创作工作台，选择主图、详情或其他功能，上传参考图片并填写需求。提交前查看所选模型与费用提示。</p><Link href="/dashboards/operating-network">进入创作工作台 <ArrowRight size={14} aria-hidden="true" /></Link></article>
        <article><span className={styles.step}>03</span><History size={25} aria-hidden="true" /><h3>查看和保存作品</h3><p>打开工作台中的生成记录，预览并下载作品。记录保存在当前浏览器，建议及时下载需要保留的原图。</p><Link href={HISTORY_URL}>查看生图历史 <ArrowRight size={14} aria-hidden="true" /></Link></article>
      </div>
      <div className={styles.help}><h3>常见问题</h3><details><summary>在哪里查看积分消费？</summary><p>在个人中心的“积分明细”中查看充值和模型消费，展开记录可查看扣分前后的余额。</p></details><details><summary>支付完成后积分没有更新？</summary><p>先刷新个人中心并查看“充值订单”的支付状态。如果仍显示待支付确认，请保存订单号与付款凭证，联系管理员核实。</p></details><details><summary>为什么换一台电脑看不到生图历史？</summary><p>生图历史读取当前浏览器保存的作品记录。请在原浏览器中查看并下载作品；清除浏览器数据可能使本地记录无法恢复。</p></details></div>
    </section> : null}
  </div>;
}
