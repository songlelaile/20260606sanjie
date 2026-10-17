"use client";

import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, Sprout } from "lucide-react";
import styles from "./SowerWorkStudio.module.css";

const APP_PATH = "/sower-work/app/";

export function SowerWorkStudio() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"connecting" | "ready" | "unavailable">("connecting");

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setStatus("connecting");
    void fetch(`${APP_PATH}api/sower/health`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("unavailable");
      const body = await response.json();
      if (body?.data?.product !== "Sower Work" || body?.data?.ready !== true) throw new Error("unavailable");
      if (mounted) setStatus("ready");
    }).catch(() => {
      if (mounted) setStatus("unavailable");
    }).finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      mounted = false;
      controller.abort();
    };
  }, [attempt]);

  return (
    <section className={`sower-work-workspace ${styles.studio}`} aria-label="Sower Work 网页工作台">
      <header className={styles.toolbar}>
        <div className={styles.title}>
          <Sprout size={20} aria-hidden="true" />
          <h1>Sower Work</h1>
          <span className={styles.badge}>网页版</span>
          <span className={styles.access}>管理账号专属</span>
        </div>
        {status === "ready" ? (
          <a className={styles.open} href={APP_PATH} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} aria-hidden="true" /> 独立窗口
          </a>
        ) : null}
      </header>
      {status === "ready" ? (
        <iframe className={styles.frame} src={APP_PATH} title="Sower Work 网页版" allow="clipboard-read; clipboard-write" />
      ) : (
        <div className={styles.state} role="status" aria-live="polite">
          {status === "connecting" ? (
            <>
              <LoaderCircle className={styles.spinner} size={28} aria-hidden="true" />
              <p>正在打开 Sower Work…</p>
            </>
          ) : (
            <>
              <Sprout size={32} aria-hidden="true" />
              <h2>Sower Work 暂时无法连接</h2>
              <p>请稍后重试。</p>
              <button className={styles.retry} type="button" onClick={() => setAttempt((value) => value + 1)}>
                <RefreshCw size={16} aria-hidden="true" /> 重新连接
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
