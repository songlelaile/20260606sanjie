"use client";

import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const VISITOR_STORAGE_KEY = "dmp-share-anonymous-visitor-v1";
const ENGAGEMENT_INTERVAL_MS = 15_000;
const MAX_ACTIVE_MS = 6 * 60 * 60 * 1_000;

interface PendingClick {
  sectionKey: string;
  elementKey: string;
  x: number;
  y: number;
}

export function DmpSharedReportClient({ token, showCopyButton = true }: { token: string; showCopyButton?: boolean }) {
  const [copied, setCopied] = useState(false);
  const viewGate = useRef<{ token: string; ready: Promise<boolean> } | null>(null);

  useEffect(() => {
    const endpoint = `/api/shared/dmp-reports/${encodeURIComponent(token)}`;
    const visitorId = browserStorageId("localStorage", VISITOR_STORAGE_KEY);
    const sessionId = browserStorageId("sessionStorage", `dmp-share-session:${token}`);
    const activeStorageKey = `dmp-share-active:${token}:${sessionId}`;
    const attribution = readAttribution();
    const queue: PendingClick[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeMs = readPersistedActiveMs(activeStorageKey);
    let visibleSince = document.visibilityState === "visible" ? performance.now() : null;
    let maxScrollDepth = currentScrollDepth();
    let sentActiveSeconds = -1;
    let sentScrollDepth = -1;

    const post = async (payload: unknown) => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
          keepalive: true
        });
        // view 的响应返回时，服务端事务已提交；accepted=0 只表示同一事件重试，
        // 其会话也已存在，因此 2xx 都可以打开后续事件闸门。
        return response.ok;
      } catch {
        return false;
      }
    };

    const send = (payload: unknown, beacon = false) => {
      const body = JSON.stringify(payload);
      if (beacon && navigator.sendBeacon) {
        try {
          const accepted = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
          if (accepted) return;
        } catch {
          // 浏览器拒绝 beacon 时继续使用 keepalive fetch。
        }
      }
      void post(payload);
    };

    const eventEnvelope = () => ({
      eventId: randomId(),
      visitorId,
      sessionId
    });

    const ready = viewGate.current?.token === token
      ? viewGate.current.ready
      : post({ type: "view", ...eventEnvelope(), ...attribution });
    if (viewGate.current?.token !== token) viewGate.current = { token, ready };
    let viewReady = false;
    void ready.then((accepted) => {
      viewReady = accepted;
    });

    const sendAfterView = (payload: unknown, beacon = false) => {
      if (viewReady) {
        send(payload, beacon);
        return;
      }
      // pagehide/卸载阶段不能可靠等待异步 view；尚未建会话时宁可放弃，
      // 不让 click/engagement 绕过服务端的“先 view”约束。
      if (beacon) return;
      void ready.then((accepted) => {
        if (accepted) send(payload);
      });
    };

    const flush = (beacon = false) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!queue.length) return;
      sendAfterView({ type: "click", ...eventEnvelope(), events: queue.splice(0, 50) }, beacon);
      if (queue.length && !beacon) timer = setTimeout(() => flush(), 450);
    };

    const syncActiveTime = () => {
      if (visibleSince === null) return;
      const now = performance.now();
      activeMs = Math.min(MAX_ACTIVE_MS, activeMs + Math.max(0, now - visibleSince));
      visibleSince = now;
      persistActiveMs(activeStorageKey, activeMs);
    };

    const flushEngagement = (beacon = false) => {
      syncActiveTime();
      maxScrollDepth = Math.max(maxScrollDepth, currentScrollDepth());
      const activeSeconds = Math.max(0, Math.floor(activeMs / 1_000));
      if (activeSeconds === sentActiveSeconds && maxScrollDepth === sentScrollDepth) return;
      sentActiveSeconds = activeSeconds;
      sentScrollDepth = maxScrollDepth;
      sendAfterView({
        type: "engagement",
        ...eventEnvelope(),
        activeSeconds,
        maxScrollDepth,
        ...attribution
      }, beacon);
    };

    const onClick = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const section = target.closest<HTMLElement>("[data-track-section]") ?? document.querySelector<HTMLElement>("[data-track-section='report']");
      if (!section) return;
      const rect = section.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const tracked = target.closest<HTMLElement>("[data-track]");
      queue.push({
        sectionKey: section.dataset.trackSection || "report",
        elementKey: tracked?.dataset.track || target.tagName.toLowerCase(),
        x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
      });
      if (queue.length >= 20) flush();
      else if (!timer) timer = setTimeout(() => flush(), 450);
    };

    const onScroll = () => {
      maxScrollDepth = Math.max(maxScrollDepth, currentScrollDepth());
    };
    const onVisibilityChange = () => {
      syncActiveTime();
      if (document.visibilityState === "visible") {
        visibleSince = performance.now();
      } else {
        visibleSince = null;
        flushEngagement(true);
      }
    };
    const onPageHide = () => {
      flush(true);
      flushEngagement(true);
    };
    const engagementTimer = window.setInterval(() => flushEngagement(), ENGAGEMENT_INTERVAL_MS);
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(engagementTimer);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
      flushEngagement(true);
    };
  }, [token]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      window.prompt("复制此分享链接", window.location.href);
    }
  }

  return showCopyButton ? (
    <div className="dmp-shared-actions" data-track-section="hero-actions">
      <button type="button" data-track="copy-link" onClick={() => void copyLink()}>
        <Copy size={15} /> {copied ? "已复制" : "复制链接"}
      </button>
    </div>
  ) : null;
}

function browserStorageId(kind: "localStorage" | "sessionStorage", key: string) {
  try {
    const storage = window[kind];
    const current = storage.getItem(key)?.trim() ?? "";
    if (/^[a-z0-9-]{16,80}$/i.test(current)) return current;
    const next = randomId();
    storage.setItem(key, next);
    return next;
  } catch {
    return randomId();
  }
}

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readPersistedActiveMs(key: string) {
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(MAX_ACTIVE_MS, Math.max(0, Math.floor(value))) : 0;
  } catch {
    return 0;
  }
}

function persistActiveMs(key: string, value: number) {
  try {
    window.sessionStorage.setItem(key, String(Math.min(MAX_ACTIVE_MS, Math.max(0, Math.floor(value)))));
  } catch {
    // 禁用会话存储时仍可统计当前页面生命周期内的活跃时长。
  }
}

function currentScrollDepth() {
  const root = document.documentElement;
  const height = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
  if (height <= 0) return 0;
  const viewportBottom = window.scrollY + window.innerHeight;
  return Math.max(0, Math.min(100, Math.round(viewportBottom / height * 100)));
}

function readAttribution() {
  const query = new URLSearchParams(window.location.search);
  let sourceDomain = "";
  if (document.referrer) {
    try {
      sourceDomain = cleanText(new URL(document.referrer).hostname, 253);
    } catch {
      sourceDomain = "";
    }
  }
  return {
    sourceDomain,
    utmSource: cleanText(query.get("utm_source"), 64),
    utmMedium: cleanText(query.get("utm_medium"), 64),
    utmCampaign: cleanText(query.get("utm_campaign"), 96)
  };
}

function cleanText(value: string | null, maxLength: number) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
