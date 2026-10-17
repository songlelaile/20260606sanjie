"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, Sprout } from "lucide-react";
import { isSowerFrameReady, SOWER_SURFACES, type SowerSurface } from "./frame-status";
import { SowerWallet } from "./SowerWallet";
import styles from "./SowerWorkStudio.module.css";

const APP_PATH = "/sower-work/app/";

export function SowerWorkStudio() {
  const [attempt, setAttempt] = useState(0);
  const [surface, setSurface] = useState<SowerSurface>("conversation");
  const [frameToken, setFrameToken] = useState("");
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<"connecting" | "loading" | "ready" | "blocked" | "unavailable">("connecting");
  const frame = useRef<HTMLIFrameElement>(null);
  const selected = SOWER_SURFACES.find((item) => item.id === surface)!;
  const frameUrl = frameToken ? `${selected.path}?_frameToken=${encodeURIComponent(frameToken)}` : selected.path;

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setStatus("connecting");
    setFrameToken(crypto.randomUUID());
    void fetch(`${APP_PATH}api/sower/health`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("unavailable");
      const body = await response.json();
      if (body?.data?.product !== "Sower Work" || body?.data?.ready !== true) throw new Error("unavailable");
      if (mounted) { setCapabilities(body.data.capabilities || {}); setStatus("loading"); }
    }).catch(() => {
      if (mounted) setStatus("unavailable");
    }).finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      mounted = false;
      controller.abort();
    };
  }, [attempt, surface]);

  useEffect(() => {
    if (status !== "loading" || !frameToken) return;
    const receive = (event: MessageEvent) => {
      if (isSowerFrameReady(event, { origin: window.location.origin, source: frame.current?.contentWindow ?? null, token: frameToken })) setStatus("ready");
    };
    const timer = setTimeout(() => setStatus((value) => value === "loading" ? "blocked" : value), 25_000);
    window.addEventListener("message", receive);
    return () => { clearTimeout(timer); window.removeEventListener("message", receive); };
  }, [status, frameToken]);

  return (
    <section className={`sower-work-workspace ${styles.studio}`} aria-label="Sower Work 网页工作台">
      <header className={styles.toolbar}>
        <div className={styles.title}>
          <Sprout size={20} aria-hidden="true" />
          <h1>Sower Work</h1>
          <span className={styles.badge}>网页版</span>
          <span className={styles.access}>管理账号专属</span>
        </div>
        {status === "ready" || status === "loading" || status === "blocked" ? (
          <a className={styles.open} href={selected.path} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} aria-hidden="true" /> 独立窗口
          </a>
        ) : null}
      </header>
      <SowerWallet />
      <nav className={styles.surfaces} aria-label="Sower Work 功能">
        {SOWER_SURFACES.map((item) => <button key={item.id} type="button" className={styles.surface} aria-current={surface === item.id ? "page" : undefined}
          disabled={item.id === "detail" ? !capabilities.cloudDetailEditor : item.id === "workbench" ? !capabilities.cloudKeywordWorkbench : false}
          onClick={() => setSurface(item.id)}>{item.label}</button>)}
      </nav>
      {(status === "ready" || status === "loading") && frameToken ? (
        <div className={styles.frameArea}>
          <iframe ref={frame} className={`${styles.frame} ${status === "loading" ? styles.frameLoading : ""}`} src={frameUrl} title={`Sower Work · ${selected.label}`} allow="clipboard-read; clipboard-write" />
          {status === "loading" ? <div className={`${styles.state} ${styles.frameWait}`} role="status"><LoaderCircle className={styles.spinner} size={28} /><p>正在加载网页工作区…</p></div> : null}
        </div>
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
              <h2>{status === "blocked" ? "网页工作区未能加载" : "Sower Work 暂时无法连接"}</h2>
              <p>{status === "blocked" ? "服务已连接，网页内容尚未加载。可重试或打开独立窗口查看浏览器提示。" : "请稍后重试。"}</p>
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
