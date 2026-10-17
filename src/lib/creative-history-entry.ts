interface HistoryBridge {
  archiveContext(): { accountKey?: string };
  getAccountKey(): Promise<string>;
  openHistory(trigger?: HTMLElement | null): Promise<{ ok?: boolean } | void> | { ok?: boolean } | void;
}

type HistoryWindow = Window & { SZ_CREATIVE_TOOLS_BRIDGE?: HistoryBridge };
type HistoryFrame = Pick<HTMLIFrameElement, "contentWindow" | "contentDocument">;

/** Open the existing account-scoped dialog, without changing a draft or API configuration. */
export function openCreativeHistory(
  currentFrame: () => HistoryFrame | null | undefined,
  signal: AbortSignal,
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
    const cancel = () => finish(new Error("已取消打开生成记录。"));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    timers.deadline = setTimeout(() => finish(new Error("生成记录暂未就绪，请稍后重新点击“生图历史”。")), timeoutMs);

    const attempt = async () => {
      if (settled || checking) return;
      try {
        const frame = currentFrame();
        const document = frame?.contentDocument;
        if (document?.documentElement.dataset.labStartup === "error") {
          finish(new Error("创作工作台加载失败，请重新打开后查看生图历史。"));
          return;
        }
        const bridge = (frame?.contentWindow as HistoryWindow | null)?.SZ_CREATIVE_TOOLS_BRIDGE;
        const account = bridge?.archiveContext().accountKey;
        // Bridge.ready() only settles on the legacy creative route. All routes
        // bind their real account before exposing an account-scoped archive.
        if (!frame || !bridge || !account || account === "local" || !document?.getElementById("archiveHistoryModal")) return;
        checking = true;
        const identity = await bridge.getAccountKey();
        if (settled) return;
        const sameContext = () => currentFrame() === frame && frame.contentDocument === document
          && (frame.contentWindow as HistoryWindow | null)?.SZ_CREATIVE_TOOLS_BRIDGE === bridge;
        if (!sameContext()) {
          finish(new Error("创作页面已切换，请重新点击“生图历史”。"));
          return;
        }
        if (identity !== account || bridge.archiveContext().accountKey !== account) {
          finish(new Error("登录账号已变化，请重新打开工作台后查看生图历史。"));
          return;
        }
        const result = await bridge.openHistory(document.getElementById("openArchiveBtn"));
        if (settled) return;
        if (!sameContext()) {
          finish(new Error("创作页面已切换，请重新点击“生图历史”。"));
          return;
        }
        if (bridge.archiveContext().accountKey !== account) {
          finish(new Error("登录账号已变化，请重新打开工作台后查看生图历史。"));
          return;
        }
        finish(result?.ok === false ? new Error("生成记录读取失败，请稍后重新点击“生图历史”。") : undefined);
      } catch {
        finish(new Error("生成记录暂不可用，请检查登录状态后重试。"));
      }
    };
    timers.poll = setInterval(() => { void attempt(); }, 100);
    void attempt();
  });
}
