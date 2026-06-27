/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "隐私政策 · 生意参谋采集助手",
  description: "生意参谋采集助手浏览器扩展的隐私政策"
};

// 公开页（中间件已放行 /privacy）：给 Chrome 应用商店上架用的隐私政策 URL。
// 自带样式、不依赖登录态，未登录也能访问。
export default function PrivacyPage() {
  const updated = "2026-06-26";
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "48px 24px 80px",
        color: "#1f2329",
        fontSize: 15,
        lineHeight: 1.8,
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
      }}
    >
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>
        隐私政策
      </h1>
      <p style={{ color: "#667084", marginTop: 0 }}>
        生意参谋采集助手（浏览器扩展） · 最后更新：{updated}
      </p>

      <p>
        本政策说明「生意参谋采集助手」浏览器扩展（下称"本扩展"）如何处理你的数据。
        核心原则：<strong>本扩展只在你本机运行，不向开发者或任何第三方收集、上传你的个人数据。</strong>
      </p>

      <Section title="一、本扩展会处理哪些数据">
        <ol>
          <li>
            <strong>你在生意参谋页面上、你自己账号可见的业务数据</strong>
            （关键词、商品、店铺等指标）：仅在你<strong>主动点击"采集"</strong>时，
            从你已登录的生意参谋页面读取，保存到<strong>你本机浏览器的本地存储</strong>
            （chrome.storage.local）。这些数据只属于你、只存在你电脑上，由你自己导出使用。
          </li>
          <li>
            <strong>shaozhuangai.com 的登录状态（会话 Cookie）</strong>：本扩展为"邀请制"，
            需校验你是否已登录、是否有使用权限。为此本扩展会读取 shaozhuangai.com 的会话凭证，
            发送给 shaozhuangai.com 自己的接口做校验。<strong>仅用于判断登录态、用后即弃，不存储、不转发给任何其他方。</strong>
          </li>
          <li>
            <strong>你填写的 AI 接口 Key 与端点</strong>（可选功能）：仅保存在你本机。
            当你启用"AI 拆词根"时，本扩展会把<strong>词根文本</strong>发送到
            <strong>你自己配置的 AI 服务</strong>（默认 DeepSeek，或你填写的端点）。
            我们不接触、不保存你的 Key，也不经手这部分请求。
          </li>
        </ol>
      </Section>

      <Section title="二、本扩展不会做什么">
        <ul>
          <li>不收集你的姓名、手机号、身份证等个人身份信息；</li>
          <li>不把你采集的数据上传给本扩展开发者，或出售给任何第三方；</li>
          <li>不追踪你在其它网站的浏览行为，不做广告画像；</li>
          <li>除"你自己配置的 AI 端点"和"你自己的 shaozhuangai.com 账号"外，不向任何外部服务发送你的数据。</li>
        </ul>
      </Section>

      <Section title="三、数据存储与删除">
        <p>
          所有采集结果都保存在<strong>你本机浏览器的本地存储</strong>中。你可以随时：
        </p>
        <ul>
          <li>在扩展弹窗里点"清空"删除采集数据；</li>
          <li>在浏览器扩展管理页移除本扩展，相关本地数据随之清除。</li>
        </ul>
      </Section>

      <Section title="四、为什么需要这些权限">
        <ul>
          <li><strong>访问 sycm.taobao.com / sycm.tmall.com / dmp.taobao.com / one.alimama.com</strong>：在你打开并登录的这些页面上读取你自己可见的数据，这是本扩展的核心功能。</li>
          <li><strong>cookies + 访问 shaozhuangai.com</strong>：校验你的登录态以解锁邀请制功能。</li>
          <li><strong>访问 api.deepseek.com（及你自定义的 AI 端点）</strong>：可选的 AI 拆词功能，用你自己的 Key。</li>
          <li><strong>downloads</strong>：把采集结果导出为 Excel/CSV 文件保存到你电脑。</li>
          <li><strong>storage / unlimitedStorage</strong>：在本机保存采集数据与你的设置。</li>
          <li><strong>scripting / debugger / notifications / alarms</strong>：在页面上自动翻页采集、模拟点击翻页控件、采集完成时弹通知、长任务后台保活。</li>
        </ul>
      </Section>

      <Section title="五、联系方式">
        <p>
          如对本政策有任何疑问，请联系：
          <a href="mailto:songlelaile@gmail.com" style={{ color: "#0f766e" }}>
            songlelaile@gmail.com
          </a>
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{title}</h2>
      {children}
    </section>
  );
}
