"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

interface PendingClick {
  sectionKey: string;
  elementKey: string;
  x: number;
  y: number;
}

export function DmpSharedReportClient({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const endpoint = `/api/shared/dmp-reports/${encodeURIComponent(token)}`;
    const queue: PendingClick[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const send = (payload: unknown, beacon = false) => {
      const body = JSON.stringify(payload);
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        keepalive: true
      }).catch(() => {});
    };

    const flush = (beacon = false) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!queue.length) return;
      send({ type: "click", events: queue.splice(0, 50) }, beacon);
      if (queue.length && !beacon) timer = setTimeout(() => flush(), 450);
    };

    try {
      const viewKey = `dmp-share-view:${token}`;
      if (!sessionStorage.getItem(viewKey)) {
        sessionStorage.setItem(viewKey, "1");
        send({ type: "view" });
      }
    } catch {
      send({ type: "view" });
    }

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

    const onPageHide = () => flush(true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
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

  return (
    <div className="dmp-shared-actions" data-track-section="hero-actions">
      <button type="button" data-track="copy-link" onClick={() => void copyLink()}>
        <Copy size={15} /> {copied ? "已复制" : "复制链接"}
      </button>
      <span className="dmp-shared-online-only">仅限官网在线查看</span>
    </div>
  );
}
