"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyIdentifier({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  function flash() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function legacyCopy() {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (ok) flash();
    } catch {
      // 用户仍可手动选中文本复制。
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      flash();
    } catch {
      legacyCopy();
    }
  }

  return (
    <span className="copy-id-chip">
      <span className="copy-id-chip-value">
        <b className="copy-id-chip-label">{label}</b>
        <code>{value}</code>
      </span>
      <button type="button" onClick={copy} aria-label={copied ? `已复制 ${value}` : `复制 ${label} ${value}`}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}
