"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * 复制一段文本（如 chrome://extensions/ 地址）。
 * chrome:// 地址无法做成可点击链接（网页禁止跳转 chrome://），所以用「代码 + 复制」呈现。
 */
export function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function flash() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function legacyCopy() {
    // 异步剪贴板 API 不可用时（非安全上下文/无权限）的兜底：临时 textarea + execCommand。
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) {
        flash();
      }
    } catch {
      // 仍失败则放弃，用户可手动选中复制
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
    <span className="tool-code">
      <code>{value}</code>
      <button
        type="button"
        className="tool-code-copy"
        onClick={copy}
        aria-label={copied ? `已复制 ${value}` : `复制 ${value}`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}
