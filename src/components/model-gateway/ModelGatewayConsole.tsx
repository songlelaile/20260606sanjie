"use client";

import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";

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
  monthlyQuotaCents: number;
  planCode: string;
  planName: string;
  periodEnd: string;
};

type GatewayModelView = {
  id: string;
  label: string;
  provider: string;
  kind: string;
  endpoint: string;
};

type Overview = {
  wallet: GatewayWallet;
  keys: GatewayKey[];
  orders: GatewayOrder[];
  usages: GatewayUsage[];
};

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

function dateText(value?: string | null) {
  if (!value) return "未使用";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function ModelGatewayConsole({
  initialOverview,
  plans,
  models
}: {
  initialOverview: Overview;
  plans: GatewayPlan[];
  models: GatewayModelView[];
}) {
  const [overview, setOverview] = useState<Overview>(initialOverview);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("购买套餐后，用户即可用自己的 API Key 调用统一网关。");
  const [plainKey, setPlainKey] = useState("");
  const [keyName, setKeyName] = useState("默认业务 Key");

  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return "https://shaozhuangai.com";
    return window.location.origin;
  }, []);

  async function refresh() {
    const resp = await fetch("/api/model-gateway/overview", { cache: "no-store" });
    const json = await resp.json();
    if (resp.ok) setOverview(json.data);
  }

  async function buy(planCode: string) {
    setBusy(`buy-${planCode}`);
    setMessage("正在生成订单...");
    const resp = await fetch("/api/model-gateway/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planCode })
    });
    const json = await resp.json();
    setBusy("");
    if (!resp.ok) {
      setMessage(json.error || "下单失败");
      return;
    }
    await refresh();
    const order = json.data.order as GatewayOrder;
    setMessage(order.status === "paid" ? "套餐已开通，额度已到账。" : "订单已创建，等待人工或支付回调确认。");
  }

  async function createKey() {
    setBusy("key");
    setMessage("正在创建 API Key...");
    const resp = await fetch("/api/model-gateway/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: keyName })
    });
    const json = await resp.json();
    setBusy("");
    if (!resp.ok) {
      setMessage(json.error || "创建失败");
      return;
    }
    setPlainKey(json.data.key);
    setMessage("API Key 已生成，只展示这一次。");
    await refresh();
  }

  async function copyText(text: string, okText: string) {
    await navigator.clipboard.writeText(text);
    setMessage(okText);
  }

  async function disableKey(id: string) {
    setBusy(`delete-${id}`);
    const resp = await fetch(`/api/model-gateway/keys/${id}`, { method: "DELETE" });
    setBusy("");
    if (!resp.ok) {
      const json = await resp.json().catch(() => null);
      setMessage(json?.error || "停用失败");
      return;
    }
    setMessage("API Key 已停用。");
    await refresh();
  }

  const chatExample = [
    "curl " + `${baseUrl}/v1/chat/completions \\`,
    "  -H \"Content-Type: application/json\" \\",
    "  -H \"Authorization: Bearer sk-sz-你的Key\" \\",
    "  -d '{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"帮我写一个电商主图提示词\"}]}'"
  ].join("\n");

  return (
    <div className="modelgw">
      <section className="modelgw-hero">
        <div className="modelgw-stat">
          <WalletCards size={22} />
          <span>当前余额</span>
          <strong>{yuan(overview.wallet.balanceCents)}</strong>
        </div>
        <div className="modelgw-stat">
          <ShieldCheck size={22} />
          <span>当前套餐</span>
          <strong>{overview.wallet.planName}</strong>
        </div>
        <div className="modelgw-stat">
          <KeyRound size={22} />
          <span>API 地址</span>
          <strong>/v1</strong>
        </div>
      </section>

      <section className="modelgw-message">
        <span>{message}</span>
        <button type="button" onClick={refresh} disabled={!!busy}>
          <RefreshCw size={15} />
          刷新
        </button>
      </section>

      <section className="modelgw-panel">
        <div className="modelgw-panel-head">
          <div>
            <h2>选择套餐</h2>
            <p>这里先走人工/回调确认，接入支付宝或微信后会自动把订单置为已支付并充值余额。</p>
          </div>
        </div>
        <div className="modelgw-plan-grid">
          {plans.map((plan) => (
            <article key={plan.code} className={plan.recommended ? "modelgw-plan hot" : "modelgw-plan"}>
              <div className="modelgw-plan-badge">{plan.badge}</div>
              <h3>{plan.name}</h3>
              <strong>{yuan(plan.priceCents)}</strong>
              <p>{plan.description}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={14} />
                    {feature}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => buy(plan.code)} disabled={!!busy}>
                {busy === `buy-${plan.code}` ? "生成中..." : "购买套餐"}
              </button>
            </article>
          ))}
        </div>
      </section>

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
              <p>兼容 OpenAI chat/completions 路径。</p>
            </div>
          </div>
          <pre className="modelgw-code">{chatExample}</pre>
          <button type="button" onClick={() => copyText(chatExample, "调用示例已复制。")}>
            <Copy size={15} />
            复制示例
          </button>
        </div>
      </section>

      <section className="modelgw-grid">
        <div className="modelgw-panel">
          <div className="modelgw-panel-head compact">
            <div>
              <h2>模型目录</h2>
              <p>模型名可直接填到请求体 model 字段。</p>
            </div>
          </div>
          <div className="modelgw-models">
            {models.map((model) => (
              <div key={`${model.endpoint}-${model.id}`} className="modelgw-model">
                <strong>{model.id}</strong>
                <span>{model.label} · {model.provider} · {model.kind === "image" ? "生图" : "文本"}</span>
              </div>
            ))}
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

      <section className="modelgw-panel">
        <div className="modelgw-panel-head compact">
          <div>
            <h2>购买记录</h2>
            <p>真实支付接入后，这里会显示付款状态和充值结果。</p>
          </div>
        </div>
        <div className="modelgw-list">
          {overview.orders.length ? overview.orders.map((order) => (
            <div key={order.id} className="modelgw-row">
              <div>
                <strong>{order.planName} · {yuan(order.amountCents)}</strong>
                <span>{order.status === "paid" ? "已支付" : "待确认"} · 充值 {yuan(order.creditCents)} · {dateText(order.createdAt)}</span>
              </div>
              {order.paymentUrl ? <a href={order.paymentUrl} target="_blank" rel="noreferrer">去付款</a> : <em>人工确认</em>}
            </div>
          )) : <div className="modelgw-empty">还没有购买记录。</div>}
        </div>
      </section>
    </div>
  );
}
