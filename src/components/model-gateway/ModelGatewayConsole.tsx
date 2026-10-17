"use client";

import { ArrowLeft, ArrowRight, Check, Copy, ImagePlus, Layers3, Plus, RefreshCw, Sparkles, Video, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { RelaySettingsPanel } from "./RelaySettingsPanel";
import { UserSupplyPanel } from "./UserSupplyPanel";
import { ScanPaymentDialog } from "../creative/ScanPaymentDialog";
import { AWAITING_CREDIT_ALLOCATION_LABEL, gatewayOrderDisplayStatus, isGatewayOrderAwaitingCapacity } from "@/lib/model-gateway/scan-payment-contract";

type GatewayPlan = {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  creditCents: number;
  badge: string;
  features: string[];
  recommended?: boolean;
};

type GatewayKey = {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string;
  lastUsedAt?: string | null;
};

type GatewayOrder = {
  id: string;
  planCode: string;
  planName: string;
  amountCents: number;
  creditCents: number;
  status: string;
  creditAllocationState?: string;
  paymentProvider: string;
  paymentUrl: string;
  createdAt: string;
};

type GatewayUsage = {
  id: string;
  endpoint: string;
  provider: string;
  model: string;
  totalTokens: number;
  imageCount: number;
  costCents: number;
  status: string;
  createdAt: string;
};

type GatewayWallet = {
  balanceCents: number;
  availableCents?: number;
  reservedCents?: number;
  monthlyQuotaCents: number;
  planCode: string;
  planName: string;
  periodEnd: string;
};

type GatewayModelView = {
  id: string;
  label: string;
  provider: string;
  providerLabel?: string;
  kind: string;
  endpoint: string;
};

type Overview = {
  wallet: GatewayWallet;
  keys: GatewayKey[];
  orders: GatewayOrder[];
  usages: GatewayUsage[];
  models?: GatewayModelView[];
  modelCatalogError?: string | null;
};

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

function points(cents: number) {
  return `${(cents / 10).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 积分`;
}

function dateText(value?: string | null) {
  if (!value) return "未使用";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function ModelGatewayConsole({
  initialOverview,
  plans,
  models: initialModels,
  modelCatalogError = null,
  canManageRelay = false,
  view = "pricing"
}: {
  initialOverview: Overview;
  plans: GatewayPlan[];
  models: GatewayModelView[];
  modelCatalogError?: string | null;
  canManageRelay?: boolean;
  view?: "pricing" | "api";
}) {
  const [overview, setOverview] = useState<Overview>(initialOverview);
  const [models, setModels] = useState<GatewayModelView[]>(initialModels);
  const [catalogError, setCatalogError] = useState<string | null>(modelCatalogError);
  const [busy, setBusy] = useState("");
  const defaultMessage = view === "api" ? "管理当前账户的 API Key 与调用记录。" : "选择适合你的积分套餐，支付确认后自动到账。";
  const [message, setMessage] = useState(defaultMessage);
  useEffect(() => { setMessage(defaultMessage); }, [defaultMessage]);
  const [plainKey, setPlainKey] = useState("");
  const [keyName, setKeyName] = useState("默认业务 Key");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentPlan, setPaymentPlan] = useState<string | undefined>();
  const [resumeOrderId, setResumeOrderId] = useState<string | undefined>();

  const [baseUrl, setBaseUrl] = useState("https://shaozhuangai.com");
  useEffect(() => {
    setBaseUrl(window.location.origin);
    const params = new URLSearchParams(window.location.search);
    if (params.getAll("recharge").length === 1 && params.get("recharge") === "1") {
      const orderId = params.get("orderId");
      if (orderId !== null) {
        if (params.getAll("orderId").length !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) return;
        setResumeOrderId(orderId);
      }
      setPaymentOpen(true);
    }
  }, []);

  async function refresh(signal?: AbortSignal) {
    const resp = await fetch("/api/model-gateway/overview", { cache: "no-store", ...(signal ? { signal } : {}) });
    const json = await resp.json().catch(() => null);
    if (signal?.aborted) throw new Error("账户刷新已取消。");
    if (!resp.ok || !json?.data) throw new Error(json?.error || `刷新失败（HTTP ${resp.status}）。`);
    setOverview(json.data);
    if (Array.isArray(json.data.models)) setModels(json.data.models);
    setCatalogError(typeof json.data.modelCatalogError === "string" ? json.data.modelCatalogError : null);
  }

  function showError(error: unknown) {
    setMessage(error instanceof Error ? error.message : "网络连接失败，请重试。");
  }

  async function handleRefresh() {
    setBusy("refresh");
    try {
      await refresh();
      setMessage("账户和模型目录已刷新。");
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  function buy(planCode: string) {
    setPaymentPlan(planCode); setResumeOrderId(undefined); setPaymentOpen(true);
  }

  function closePayment() {
    setPaymentOpen(false);
    const url = new URL(window.location.href);
    if (url.pathname === "/models" && url.searchParams.get("recharge") === "1") {
      url.searchParams.delete("recharge"); url.searchParams.delete("orderId");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    void refresh().catch(showError);
  }

  async function createKey() {
    setBusy("key");
    setMessage("正在创建 API Key...");
    try {
      const resp = await fetch("/api/model-gateway/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName })
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.data?.key) throw new Error(json?.error || "创建失败，请重试。");
      setPlainKey(json.data.key);
      setMessage("API Key 已生成，只展示这一次。");
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function copyText(text: string, okText: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(okText);
    } catch {
      setMessage("复制失败，请手动选择文本复制。");
    }
  }

  async function disableKey(id: string) {
    setBusy(`delete-${id}`);
    try {
      const resp = await fetch(`/api/model-gateway/keys/${id}`, { method: "DELETE" });
      if (!resp.ok) {
        const json = await resp.json().catch(() => null);
        throw new Error(json?.error || "停用失败，请重试。");
      }
      setMessage("API Key 已停用。");
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  function example(path: string, body: Record<string, unknown>) {
    const json = JSON.stringify(body).replace(/'/g, "'\\''");
    return [
      "curl " + `${baseUrl}${path} \\`,
      "  -H \"Content-Type: application/json\" \\",
      "  -H \"Authorization: Bearer sk-sz-你的Key\" \\",
      `  -d '${json}'`
    ].join("\n");
  }
  const chatModel = models.find((model) => model.kind === "chat");
  const imageModel = models.find((model) => model.kind === "image");
  const videoModel = models.find((model) => model.kind === "video");
  const chatExample = chatModel ? example("/v1/chat/completions", { model: chatModel.id, messages: [{ role: "user", content: "帮我写一个电商主图提示词" }] }) : "";
  const imageExample = imageModel ? example("/v1/images/generations", { model: imageModel.id, prompt: "白底商品主图，干净棚拍光", n: 1, size: "1024x1024" }) : "";
  const videoExample = videoModel ? example("/api/v1/videos", { model: videoModel.id, prompt: "商品在柔和棚拍光下缓慢旋转" }) : "";

  const shaozhuangModels = models.filter((model) => model.provider === "shaozhuang");
  const directModels = models.filter((model) => model.provider !== "shaozhuang");
  const accountStatus = <section className="modelgw-message pricing-message" aria-live="polite">
    <span>{message}</span>
    <button type="button" onClick={handleRefresh} disabled={!!busy}><RefreshCw size={15} />{view === "api" ? "刷新账户" : "刷新余额"}</button>
  </section>;

  return (
    <div className="modelgw pricing-page">
      {view === "pricing" ? <>
      <section className="pricing-hero" aria-labelledby="pricing-title">
        <a className="pricing-back" href="/profile"><ArrowLeft size={15} /> 个人中心</a>
        <div className="pricing-eyebrow"><Sparkles size={15} /> 三阶引擎 · 积分套餐</div>
        <h1 id="pricing-title">赋能您的<span>电商视觉</span></h1>
        <p>用 GPT 开启商品主图、详情素材与创意文案创作。<br />选择适合你的积分套餐，让每一个商品创意都有施展空间。</p>
        <a className="pricing-balance" href="/profile?tab=credits">
          <WalletCards size={17} /><span>可用积分</span><strong>{points(overview.wallet.availableCents ?? overview.wallet.balanceCents)}</strong><ArrowRight size={14} />
        </a>
        {Number(overview.wallet.reservedCents) > 0 ? <p className="pricing-reserved">冻结 {points(overview.wallet.reservedCents!)} · 任务结算后更新</p> : null}
      </section>

      <section className="pricing-plans" aria-labelledby="pricing-plans-title">
        <div className="pricing-section-heading">
          <h2 id="pricing-plans-title">选择套餐</h2>
          <p>按需购买积分，灵活安排你的创作计划</p>
        </div>
        <div className="pricing-plan-grid">
          {plans.map((plan) => (
            <article key={plan.code} className={`pricing-plan${plan.recommended ? " is-recommended" : ""}`}>
              {plan.recommended ? <div className="pricing-recommended"><Sparkles size={13} /> 推荐套餐</div> : null}
              <div className="pricing-plan-heading">
                <span className="pricing-plan-label">{plan.badge}</span>
                <h3>{plan.name}</h3>
                <p>{plan.code === "starter" ? "从一个商品创意开始，体验电商 AI 创作" : plan.code === "growth" ? "满足店铺日常上新，持续打磨商品视觉" : plan.code === "business" ? "为更多商品备足积分，从容安排创作任务" : "按需补充积分，开启你的商品创作"}</p>
              </div>
              <div className="pricing-plan-price"><strong>{yuan(plan.priceCents)}</strong><span>一次购买</span></div>
              <div className="pricing-plan-credits"><WalletCards size={19} /><strong>{points(plan.creditCents)}</strong><span>充值到账</span></div>
              <div className="pricing-plan-capabilities">
                <h4><ImagePlus size={16} /> GPT 图片创作</h4>
                <ul><li><Check size={14} /> 商品主图与场景创意</li><li><Check size={14} /> 多图参考与图片素材</li></ul>
                <h4><Layers3 size={16} /> 详情页创作</h4>
                <ul><li><Check size={14} /> 商品卖点与详情文案</li><li><Check size={14} /> 详情页配图与视觉素材</li></ul>
              </div>
              <button type="button" className="pricing-select" onClick={() => buy(plan.code)} disabled={!!busy} aria-label={`选择${plan.name}，${yuan(plan.priceCents)}`}>
                立即选择<ArrowRight size={16} />
              </button>
              <span className="pricing-plan-footnote">实际扣费以创作时所选模型为准</span>
            </article>
          ))}
        </div>
        <p className="pricing-payment-note">支持已开通的支付宝或微信支付，支付确认后积分自动到账。</p>
      </section>

      <section className="pricing-model-section" aria-labelledby="pricing-models-title">
        <div className="pricing-section-heading"><h2 id="pricing-models-title">为不同创意，选择合适的能力</h2><p>从图片、文案到视频，串联商品内容创作</p></div>
        <div className="pricing-model-grid">
          <article className="pricing-model-card"><span className="pricing-feature-icon"><ImagePlus size={22} /></span><div><h3>GPT 图片创作</h3><p>围绕商品主图、详情素材与多图参考，展开你的图片创意。</p><span className="pricing-availability">{imageModel ? "已开放图片模型" : "图片模型待启用"}</span></div></article>
          <article className="pricing-model-card"><span className="pricing-feature-icon is-purple"><Sparkles size={22} /></span><div><h3>GPT 创意文案</h3><p>梳理商品卖点、撰写创作提示词，让视觉表达更有方向。</p><span className="pricing-availability">{chatModel ? "已开放文本模型" : "文本模型待启用"}</span></div></article>
          <article className="pricing-model-card"><span className="pricing-feature-icon is-rose"><Video size={22} /></span><div><h3>视频创作</h3><p>将商品卖点延展为视频创意，按已开放的视频模型发起任务。</p><span className="pricing-availability">{videoModel ? "已开放视频模型" : "当前未启用视频模型"}</span></div></article>
        </div>
        {catalogError ? <p className="pricing-catalog-notice" role="alert">模型目录暂不可用，请刷新后查看当前可用模型。</p> : null}
      </section>

      <section className="pricing-included" aria-labelledby="pricing-included-title">
        <div className="pricing-section-heading"><h2 id="pricing-included-title">所有套餐均可使用</h2><p>购买不同积分额度，使用同一个创作工作台</p></div>
        <div className="pricing-included-grid">
          <div><Check size={16} /><span>商品主图创作</span></div><div><Check size={16} /><span>详情素材创作</span></div>
          <div><Check size={16} /><span>多图参考创作</span></div><div><Check size={16} /><span>创意文案与提示词</span></div>
          <div><Check size={16} /><span>个人积分与流水</span></div><div><Check size={16} /><span>订单记录随时查看</span></div>
        </div>
        <p>具体模型以创作页可选项为准；不同模型、尺寸和任务的积分消耗可能不同。</p>
      </section>

      {accountStatus}

      <section className="modelgw-panel">
        <div className="modelgw-panel-head compact">
          <div>
            <h2>购买记录</h2>
            <p>查看订单付款状态与充值结果。未完成的扫码订单可继续付款。</p>
          </div>
        </div>
        <div className="modelgw-list">
          {overview.orders.length ? overview.orders.map((order) => (
            <div key={order.id} className="modelgw-row">
              <div>
                <strong>{order.planName} · {yuan(order.amountCents)}</strong>
                <span>{({ paid: "已支付", pending: "待付款确认", awaiting_capacity: AWAITING_CREDIT_ALLOCATION_LABEL, expired: "已过期", closed: "已关闭", failed: "支付失败" } as Record<string, string>)[gatewayOrderDisplayStatus(order)] || order.status} · 充值 {points(order.creditCents)} · {dateText(order.createdAt)}</span>
              </div>
              {isGatewayOrderAwaitingCapacity(order) ? (order.paymentProvider === "alipay" || order.paymentProvider === "wechat") ? <button type="button" onClick={() => { setPaymentPlan(order.planCode); setResumeOrderId(order.id); setPaymentOpen(true); }}>查看分配状态</button> : <em>积分待分配</em> : order.status === "pending" && (order.paymentProvider === "alipay" || order.paymentProvider === "wechat") ? <button type="button" onClick={() => { setPaymentPlan(order.planCode); setResumeOrderId(order.id); setPaymentOpen(true); }}>继续付款</button> : order.status === "pending" && /^https:\/\//i.test(order.paymentUrl) ? <a href={order.paymentUrl} target="_blank" rel="noopener noreferrer">去付款</a> : <em>{order.status === "paid" ? "已到账" : order.paymentProvider === "manual" ? "人工确认" : "—"}</em>}
            </div>
          )) : <div className="modelgw-empty">还没有购买记录。</div>}
        </div>
      </section>
      </> : <>
        <section className="pricing-hero" aria-labelledby="api-access-title">
          <a className="pricing-back" href="/profile"><ArrowLeft size={15} /> 个人中心</a>
          <h1 id="api-access-title">API 接入与调用记录</h1>
          <p>管理 API Key、查看模型目录和技术接入说明</p>
        </section>
        {accountStatus}
        {catalogError ? <p className="pricing-catalog-notice" role="alert">模型目录暂不可用，请刷新后查看当前可用模型。</p> : null}
        <div className="pricing-developer-content">
      <section className="modelgw-panel">
        <div className="modelgw-panel-head compact">
          <div>
            <h2>上游与接入说明</h2>
            <p>使用本网关 API Key 调用已启用的模型，平台按模型目录路由到对应上游。</p>
          </div>
        </div>
        <div className="modelgw-notes">
          <div className="modelgw-note">
            <strong>少壮中转站</strong>
            <span>
              支持接入 <code>sub.shaozhuangai.com</code> 等兼容中转站。管理员可管理上游地址、Key、调用模型名和上游模型名；凭据仅保存在服务端。下方目录展示当前启用的路由。
            </span>
          </div>
          <div className="modelgw-note">
            <strong>直连厂商</strong>
            <span>仍保留 OpenAI、DeepSeek、通义、豆包、智谱直连；未配置对应上游 Key 时该上游调用会失败关闭（503）。</span>
          </div>
          <div className="modelgw-note">
            <strong>兼容路径与测试版能力</strong>
            <span>
              保留 <code>/v1/chat/completions</code> 与 <code>/v1/images/generations</code>；新增 <code>/api/v1/models</code>、聊天、生图和 <code>/api/v1/images/edits</code>（JSON 或 multipart）。聊天为非流式，
              <code>stream=true</code>
              {" "}
              会被拒绝。视频任务使用 <code>POST /api/v1/videos</code> 创建，<code>GET /api/v1/videos/:id</code> 查询状态，<code>GET /api/v1/videos/:id/content</code> 读取结果。只有管理员明确登记、设置费率并启用的视频模型可创建任务。
              视频在上游成功接受创建任务时扣费，任务随后失败暂不自动退款。
            </span>
          </div>
          <div className="modelgw-note">
            <strong>接入状态</strong>
            <span><code>/api/v1</code> 兼容接口已上线。平台供应调用需管理员配置平台 Key；美元费用使用每日参考汇率换算，每笔调用固定自己的汇率快照。</span>
          </div>
        </div>
      </section>

      {canManageRelay ? <RelaySettingsPanel onCatalogChange={refresh} /> : null}
      {canManageRelay ? <UserSupplyPanel /> : null}

      <section className="modelgw-grid">
        <div className="modelgw-panel">
          <div className="modelgw-panel-head compact">
            <div>
              <h2>API Key</h2>
              <p>Key 只展示一次，平台仅保存哈希。</p>
            </div>
          </div>
          <div className="modelgw-key-maker">
            <input value={keyName} onChange={(event) => setKeyName(event.target.value)} />
            <button type="button" onClick={createKey} disabled={!!busy}>
              <Plus size={15} />
              生成 Key
            </button>
          </div>
          {plainKey ? (
            <div className="modelgw-secret">
              <code>{plainKey}</code>
              <button type="button" onClick={() => copyText(plainKey, "API Key 已复制。")}>
                <Copy size={15} />
                复制
              </button>
            </div>
          ) : null}
          <div className="modelgw-list">
            {overview.keys.length ? overview.keys.map((key) => (
              <div key={key.id} className="modelgw-row">
                <div>
                  <strong>{key.name}</strong>
                  <span>{key.keyPrefix} · {key.status === "active" ? "启用" : "停用"} · {dateText(key.lastUsedAt)}</span>
                </div>
                {key.status === "active" ? (
                  <button type="button" onClick={() => disableKey(key.id)} disabled={busy === `delete-${key.id}`}>
                    停用
                  </button>
                ) : null}
              </div>
            )) : <div className="modelgw-empty">还没有 API Key。</div>}
          </div>
        </div>

        <div className="modelgw-panel">
          <div className="modelgw-panel-head compact">
            <div>
              <h2>调用示例</h2>
              <p>示例使用当前模型目录中的调用模型名。聊天勿传 stream=true；视频通过任务 ID 异步查询。</p>
            </div>
          </div>
          {chatExample ? <><pre className="modelgw-code">{chatExample}</pre><button type="button" onClick={() => copyText(chatExample, "聊天示例已复制。")}><Copy size={15} />复制聊天示例</button></> : <div className="modelgw-empty">当前没有启用的聊天模型。</div>}
          {imageExample ? <><pre className="modelgw-code">{imageExample}</pre><button type="button" onClick={() => copyText(imageExample, "生图示例已复制。")}><Copy size={15} />复制生图示例</button></> : <div className="modelgw-empty">当前没有启用的图片模型。</div>}
          {videoExample ? <><pre className="modelgw-code">{videoExample}</pre><button type="button" onClick={() => copyText(videoExample, "视频示例已复制。")}><Copy size={15} />复制视频示例</button></> : <div className="modelgw-empty">当前未启用视频模型。管理员需确认上游支持的视频模型名和费率后开启。</div>}
        </div>
      </section>

      <section className="modelgw-grid">
        <div className="modelgw-panel">
          <div className="modelgw-panel-head compact">
            <div>
              <h2>模型目录</h2>
              <p>已启用的模型名可填到请求体 model 字段；停用和待分类的模型不对客户端开放。</p>
            </div>
          </div>
          <div className="modelgw-models">
            {catalogError ? <div className="modelgw-empty" role="alert">{catalogError}</div> : null}
            {[...shaozhuangModels, ...directModels].map((model) => (
              <div key={`${model.endpoint}-${model.id}`} className="modelgw-model">
                <strong>{model.id}</strong>
                <span>
                  {model.label} · {model.providerLabel || model.provider} · {model.kind === "video" ? "视频" : model.kind === "image" ? "生图" : "文本"} · {model.endpoint}
                </span>
              </div>
            ))}
            {!models.length ? <div className="modelgw-empty">当前没有启用的模型。</div> : null}
          </div>
        </div>

        <div className="modelgw-panel">
          <div className="modelgw-panel-head compact">
            <div>
              <h2>最近流水</h2>
              <p>展示最近 12 次调用扣费。</p>
            </div>
          </div>
          <div className="modelgw-list">
            {overview.usages.length ? overview.usages.map((usage) => (
              <div key={usage.id} className="modelgw-row">
                <div>
                  <strong>{usage.model}</strong>
                  <span>{usage.endpoint} · {usage.provider} · {dateText(usage.createdAt)}</span>
                </div>
                <em>{usage.status === "ok" ? yuan(usage.costCents) : "失败"}</em>
              </div>
            )) : <div className="modelgw-empty">还没有调用记录。</div>}
          </div>
        </div>
      </section>

        </div>
      </>}
      <ScanPaymentDialog open={paymentOpen} plans={plans} initialPlanCode={paymentPlan} resumeOrderId={resumeOrderId} onClose={closePayment} onPaid={async (_order, signal) => { await refresh(signal); setMessage("支付成功，套餐与积分已到账。"); }} />
    </div>
  );
}
