interface ConfigResult { ok?: boolean; error?: string }
interface ImageConfigBridge {
  archiveContext(): { accountKey?: string };
  getAccountKey(): Promise<string>;
  openConfig(): ConfigResult;
}
interface VideoConfigBridge {
  ready(): boolean;
  openConfig(): ConfigResult;
}
type ConfigWindow = Window & {
  SZ_CREATIVE_TOOLS_BRIDGE?: ImageConfigBridge;
  SanjieVideoSettingsBridge?: VideoConfigBridge;
};
type ConfigFrame = Pick<HTMLIFrameElement, "contentWindow" | "contentDocument">;

/** Reuse the visible workbench's settings dialog without replacing its draft. */
export function openCreativeApiConfig(
  currentFrame: () => ConfigFrame | null | undefined,
  signal: AbortSignal,
  kind: "image" | "video" = "image",
  timeoutMs = 12_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    const timers: { poll?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout> } = {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timers.poll);
      clearTimeout(timers.deadline);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new Error("已取消打开自定义配置 API。"));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    timers.deadline = setTimeout(() => finish(new Error("配置暂未就绪，请稍后重新点击“自定义配置 API”。")), timeoutMs);

    const attempt = async () => {
      if (settled || checking) return;
      try {
        const frame = currentFrame();
        const document = frame?.contentDocument;
        const frameWindow = frame?.contentWindow as ConfigWindow | null;
        if (document?.documentElement.dataset.labStartup === "error") {
          finish(new Error("创作工作台加载失败，请重新打开后配置 API。"));
          return;
        }
        if (!frame || !document || !frameWindow) return;
        if (document.documentElement.dataset.labStartup === "pending") return;
        if (kind === "video") {
          const bridge = frameWindow.SanjieVideoSettingsBridge;
          if (!bridge?.ready()) return;
          // The original video opener validates the logged-in account itself.
          const result = bridge.openConfig();
          finish(result?.ok === false ? new Error(result.error || "配置暂不可用，请稍后重试。") : undefined);
          return;
        }
        const bridge = frameWindow.SZ_CREATIVE_TOOLS_BRIDGE;
        const account = bridge?.archiveContext().accountKey;
        if (!bridge || !account || account === "local" || !document.getElementById("configModal")) return;
        const configControl = () => document.querySelector<HTMLButtonElement>('[data-action="config"], [data-action="open-config"]');
        if (document.documentElement.classList.contains("studio-genesis-page") && !configControl()) return;
        checking = true;
        const identity = await bridge.getAccountKey();
        if (settled) return;
        if (currentFrame() !== frame || (frame.contentWindow as ConfigWindow | null)?.SZ_CREATIVE_TOOLS_BRIDGE !== bridge) {
          finish(new Error("创作页面已切换，请重新点击“自定义配置 API”。"));
          return;
        }
        if (identity !== account || bridge.archiveContext().accountKey !== account) {
          finish(new Error("登录账号已变化，请重新打开工作台后配置 API。"));
          return;
        }
        if (configControl()?.disabled) {
          finish(new Error("请等待当前任务结束后配置 API。"));
          return;
        }
        const result = bridge.openConfig();
        finish(result?.ok === false ? new Error(result.error || "配置暂不可用，请稍后重试。") : undefined);
      } catch {
        finish(new Error("配置暂不可用，请检查登录状态后重试。"));
      }
    };
    timers.poll = setInterval(() => { void attempt(); }, 100);
    void attempt();
  });
}
