// Local, in-memory UI acceptance harness. Never calls a payment provider or database.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import QRCode from "qrcode";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".codex-deploy/scan-payment-preview");
await mkdir(output, { recursive: true });
const qr = await QRCode.toDataURL("三阶引擎：本地交互验收二维码，不能用于付款", { width: 240, margin: 2 });
await writeFile(path.join(output, "entry.jsx"), `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ScanPaymentDialog} from '../../src/components/creative/ScanPaymentDialog';
const scenario = new URLSearchParams(location.search).get('scenario') || 'pending';
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init={}) => originalFetch(input, {...init, headers:{...init.headers,'x-preview-scenario':scenario}});
const plans = [
 {code:'starter',name:'体验版',priceCents:9900,creditCents:12000},
 {code:'growth',name:'增长版',priceCents:29900,creditCents:38000},
 {code:'business',name:'团队版',priceCents:89900,creditCents:120000}
];
function App(){const [open,setOpen]=useState(false),[selected,setSelected]=useState('growth'),[paid,setPaid]=useState(false);
return <main><aside>本地交互验收 · 演示二维码不能付款 · 场景：{scenario}</aside><nav>三阶引擎 <small>创作工作台 / 积分充值</small></nav>
<header><span>为每一次创作，补充灵感</span><h1>选择你的创作套餐</h1><p>使用现有套餐价格与积分规则。</p></header>
<section className="plans">{plans.map(p=><article key={p.code}><h2>{p.name}</h2><strong>¥{p.priceCents/100}</strong><p>{p.creditCents/10} 积分</p><p>30 天工作台权限</p><button onClick={()=>{setSelected(p.code);setOpen(true)}}>选择{p.name}</button></article>)}</section>
{paid && <p role="status">演示订单已确认，余额刷新回调已触发（没有真实入账）。</p>}
<footer>演示场景：<a href="/?scenario=pending">待支付</a> · <a href="/?scenario=unavailable">未配置</a> · <a href="/?scenario=paid">自动到账</a> · <a href="/?scenario=expired">二维码过期</a> · <a href="/?scenario=error">下单失败</a></footer>
<ScanPaymentDialog open={open} plans={plans} initialPlanCode={selected} onClose={()=>setOpen(false)} onPaid={()=>setPaid(true)}/></main>}
createRoot(document.getElementById('root')).render(<App/>);
`);
await build({ entryPoints: [path.join(output, "entry.jsx")], outfile: path.join(output, "app.js"), bundle: true, platform: "browser", jsx: "automatic", alias: { "@": path.join(root, "src") }, define: { "process.env.NODE_ENV": '"development"' } });
const shell = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三阶引擎 · 扫码充值本地验收</title><link rel="stylesheet" href="/app.css"><style>*{box-sizing:border-box}body{margin:0;background:#f7f9fc;color:#142033;font:15px system-ui,-apple-system,sans-serif}aside{position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;text-align:center;background:#fff1c2;color:#71440c;font-size:13px}nav{padding:28px 8%;font-size:23px;font-weight:700}nav small{float:right;font-size:14px;font-weight:400;color:#64748b}header{text-align:center;padding:50px 20px 20px}header span{font-size:13px;color:#64748b}h1{font-size:34px;margin:14px}header p{color:#64748b}.plans{max-width:1000px;margin:32px auto 60px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.plans article{background:white;border:1px solid #e2e8f0;border-radius:18px;padding:30px}.plans article:nth-child(2){border:2px solid #6279e4;box-shadow:0 10px 40px #6176dc16}.plans strong{font-size:38px}.plans p{color:#64748b}.plans button{width:100%;padding:12px;background:#335cdd;border:0;border-radius:9px;color:white;cursor:pointer;font-size:15px}footer{text-align:center;color:#64748b}a{color:#335cdd}main>p{text-align:center}@media(max-width:700px){.plans{grid-template-columns:1fr;margin:20px}.plans article{padding:20px}nav small{float:none;display:block;margin-top:8px}header{padding-top:15px}}</style><div id="root"></div><script src="/app.js"></script></html>`;
const orders = new Map();
const planMap = { starter: ["体验版", 9900, 12000], growth: ["增长版", 29900, 38000], business: ["团队版", 89900, 120000] };
let counter = 0;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:18813");
  const scenario = req.headers["x-preview-scenario"] || "pending";
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(shell); return; }
    if (["/app.js", "/app.css"].includes(url.pathname)) { res.setHeader("content-type", url.pathname.endsWith("css") ? "text/css" : "text/javascript"); res.end(await readFile(path.join(output, url.pathname.slice(1)))); return; }
    if (url.pathname === "/api/model-gateway/checkout" && req.method === "GET") { json({data:{providers:["alipay","wechat"].map(provider=>({provider,available:scenario!=="unavailable"}))}}); return; }
    if (["/api/model-gateway/checkout", "/api/model-gateway/orders"].includes(url.pathname) && req.method === "POST") {
      if (scenario === "error") { json({error:"演示：支付渠道暂时不可用，请稍后重试"},503); return; }
      let raw = ""; for await (const part of req) raw += part;
      const input = JSON.parse(raw); const plan = planMap[input.planCode];
      if (!plan) { json({error:"套餐不存在"},400); return; }
      const manual = url.pathname.endsWith("/orders");
      const order={id:"preview-"+(++counter),planCode:input.planCode,planName:plan[0],amountCents:plan[1],creditCents:plan[2],paymentProvider:manual?"manual":input.provider,status:"pending",paymentUrl:"",qrCodeDataUrl:manual?null:qr,createdAt:new Date().toISOString(),expiresAt:manual?null:new Date(Date.now()+(scenario==="expired"?2000:900000)).toISOString(),paidAt:null};
      orders.set(order.id,{order,queries:0});json({data:{order}},201);return;
    }
    if (/^\/api\/model-gateway\/(checkout|orders)\//.test(url.pathname)) {
      const record=orders.get(url.pathname.split("/").pop());if(!record){json({error:"订单不存在"},404);return;}
      record.queries++;
      if(scenario==="paid"){record.order.status="paid";record.order.paidAt=new Date().toISOString();}
      if(scenario==="expired"){record.order.status="expired";record.order.qrCodeDataUrl=null;}
      json({data:{order:record.order}});return;
    }
    json({error:"仅本地演示，无此接口"},404);
  } catch { json({error:"演示服务异常"},500); }
}).listen(18813,"127.0.0.1",()=>console.log("Local payment UI fixture: http://127.0.0.1:18813 (no real payments)"));
