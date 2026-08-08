"use client";

import { Link2, X } from "lucide-react";
import { useState } from "react";
import type { DashboardShareInfo, DashboardShareSection } from "@/lib/types/domain";

const ALL_SECTIONS: DashboardShareSection[] = ["management", "breakthrough", "audience", "prefill"];

const SECTION_LABEL: Record<DashboardShareSection, string> = {
  management: "综合看板",
  breakthrough: "单品突破",
  audience: "人群计划",
  prefill: "预填写表"
};

export function DashboardShareButton({
  currentSection = "management"
}: {
  currentSection?: DashboardShareSection;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  async function copyToClipboard(url: string) {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  async function share(sections: DashboardShareSection[]) {
    setBusy(true);
    setMessage("");
    setShareUrl("");
    try {
      const response = await fetch("/api/dashboard-shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sections })
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { share: DashboardShareInfo }; error?: string }
        | null;
      if (!response.ok || !payload?.data?.share) {
        setMessage(payload?.error ?? "创建分享失败");
        return;
      }
      const url = new URL(payload.data.share.url, window.location.origin).toString();
      setShareUrl(url);
      const copied = await copyToClipboard(url);
      setMessage(copied ? "分享链接已复制" : "链接已生成，请手动复制");
      if (copied) {
        setOpen(false);
      }
    } catch {
      setMessage("创建分享失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="share-action-wrap">
      <button type="button" className="button-link" onClick={() => setOpen(true)} disabled={busy}>
        <Link2 size={17} />
        {busy ? "生成中" : "分享看板"}
      </button>
      {message ? <small>{message}</small> : null}
      {open ? (
        <div className="share-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="share-modal"
            role="dialog"
            aria-modal="true"
            aria-label="选择分享范围"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="share-modal-head">
              <div>
                <strong>选择分享范围</strong>
                <span>链接生成时会固定当前数据版本，被分享者只读。</span>
              </div>
              <button type="button" className="share-modal-close" onClick={() => setOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="share-modal-options">
              <button
                type="button"
                className="share-choice"
                disabled={busy}
                onClick={() => void share([currentSection])}
              >
                <strong>仅分享当前模块</strong>
                <span>{SECTION_LABEL[currentSection]} · 固定快照</span>
              </button>
              <button
                type="button"
                className="share-choice primary"
                disabled={busy}
                onClick={() => void share(ALL_SECTIONS)}
              >
                <strong>一起分享四个模块</strong>
                <span>综合看板、单品突破、人群计划、预填写表</span>
              </button>
            </div>
            {shareUrl ? (
              <div className="share-url-field">
                <input
                  readOnly
                  value={shareUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="分享链接"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => setMessage((await copyToClipboard(shareUrl)) ? "分享链接已复制" : "请手动复制链接")}
                >
                  复制
                </button>
              </div>
            ) : null}
            {message ? <p className="form-message">{message}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
