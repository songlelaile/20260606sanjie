"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Camera,
  ChevronRight,
  Clapperboard,
  CopyPlus,
  Maximize2,
  Palette,
  Image as ImageIcon,
  Layers3,
  LayoutPanelTop,
  Plus,
  ScanLine,
  Shirt,
  WandSparkles
} from "lucide-react";
import styles from "./CreativeStudio.module.css";
import { CreativeCredits } from "./CreativeCredits";
import { CREATIVE_VIRAL_SURFACES, isDedicatedViralSurface } from "@/lib/creative-viral-surfaces";
import { openCreativeHistory } from "@/lib/creative-history-entry";
import { openCreativeApiConfig } from "@/lib/creative-api-entry";

interface NavigationPermission { allowed: boolean; reason?: string }

interface DeactivationBridge {
  canDeactivate(): NavigationPermission | Promise<NavigationPermission>;
}

interface WorkflowBridge extends DeactivationBridge {
  activate(): Promise<{ ok: boolean; error?: string }>;
}

interface PromptTaskState {
  ready: boolean;
  busy: boolean;
  activeCount: number;
  pendingReceiptCount: number;
  summary?: string;
}

interface PromptTaskBridge extends WorkflowBridge {
  getTaskState(): PromptTaskState;
}

interface BackgroundTaskNotice { id: string; activeCount: number; pendingReceiptCount: number; summary: string }

class PromptTaskBridgeTimeout extends Error {}

async function waitForPromptTaskBridge<T>(operation: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PromptTaskBridgeTimeout()), 15_000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface CreativeToolsBridge extends DeactivationBridge {
  getState(): { ready: boolean; startupFailed?: boolean; busy: boolean };
}

const VIRAL_ICONS = [CopyPlus, Palette, Maximize2];

const IMAGE_SURFACES = [
  {
    id: "main",
    label: "主图",
    icon: ImageIcon,
    src: "/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1"
  },
  {
    id: "detail",
    label: "详情",
    icon: LayoutPanelTop,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=link&source=web&studio=1"
  },
  {
    id: "ad",
    label: "广告图",
    icon: WandSparkles,
    src: "/creative/labs/image-prompt-lab/promptlab.html?type=ad&source=web&studio=1"
  },
  {
    id: "list-main",
    label: "链接成图",
    icon: ImageIcon,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=link-image&source=web"
  },
  {
    id: "mirror",
    label: "爆款复刻",
    icon: ScanLine,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=mirror&source=web"
  },
  ...CREATIVE_VIRAL_SURFACES.map((item, index) => ({ ...item, icon: VIRAL_ICONS[index] })),
  {
    id: "clothing",
    label: "DIY成图",
    icon: Shirt,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=creative&tool=clothing&source=web"
  },
  {
    id: "buyer",
    label: "买家秀",
    icon: Camera,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=creative&tool=buyer&source=web"
  },
  {
    id: "refinement",
    label: "产品精修",
    icon: WandSparkles,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=creative&tool=refinement&source=web"
  }
];

// Existing bookmarks and tasks retain their original engine and saved state.
// They remain reachable through direct links and background-task recovery.
const LEGACY_PROMPT_SURFACES = [
  { id: "list-legacy", label: "旧链接任务", icon: ImageIcon,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&layout=1" },
  { id: "reference", label: "清单成详", icon: ScanLine,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=reference&source=detail-reference&layout=1" },
  { id: "sku", label: "批量 SKU", icon: Layers3,
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=sku&source=web&layout=1" }
];
const LEGACY_VIRAL_SURFACE = {
  id: "viral", label: "爆款裂变", icon: CopyPlus,
  src: "/creative/labs/image-prompt-lab/promptlab.html?mode=viral&source=web&layout=1"
};
const ALL_IMAGE_SURFACES = [...IMAGE_SURFACES, ...LEGACY_PROMPT_SURFACES, LEGACY_VIRAL_SURFACE];
const VIDEO_SRC = "/creative/labs/ecommerce-video-studio/video-studio.html";
const BATCH_SRC = "/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&batch=1";
const STUDIO_SURFACES = new Set(["main", "detail", "ad"]);
const CREATIVE_TOOL_SURFACES = new Set(["refinement", "clothing", "buyer"]);
const BATCH_FRAME_ID = "__studio_batch__";
const CACHED_PROMPT_SURFACES = new Set(["mirror", "list-main", "list-legacy", "reference", "sku"]);
const isTaskSurface = (id: string) => STUDIO_SURFACES.has(id) || id === BATCH_FRAME_ID || CACHED_PROMPT_SURFACES.has(id);
const isCachedSurface = (id: string) => isTaskSurface(id) || isDedicatedViralSurface(id);
const CACHED_IMAGE_SURFACES = [...ALL_IMAGE_SURFACES.filter(item => isCachedSurface(item.id)),
  { id: BATCH_FRAME_ID, label: "批量任务", src: BATCH_SRC }];
const taskLabel = (id: string) => CACHED_IMAGE_SURFACES.find(item => item.id === id)?.label || "创作任务";
const taskCounts = (task: BackgroundTaskNotice) => [
  task.activeCount > 0 ? `${task.activeCount} 个执行中` : "",
  task.pendingReceiptCount > 0 ? `${task.pendingReceiptCount} 个回执待确认` : ""
].filter(Boolean).join(" · ") || task.summary;

export function CreativeStudio({
  kind,
  initialSurface = "main",
  initialBatch = false,
  initialHistory = false,
  initialApiConfig = false
}: {
  kind: "image" | "video";
  initialSurface?: string;
  initialBatch?: boolean;
  initialHistory?: boolean;
  initialApiConfig?: boolean;
}) {
  const router = useRouter();
  const [batch, setBatch] = useState(initialBatch);
  const requestedSurface = ALL_IMAGE_SURFACES.some((item) => item.id === initialSurface) ? initialSurface : "main";
  const [surface, setSurface] = useState(requestedSurface);
  const [visitedWorkflows, setVisitedWorkflows] = useState<string[]>(
    kind === "image" && initialBatch ? [BATCH_FRAME_ID]
      : kind === "image" && isCachedSurface(requestedSurface) ? [requestedSurface] : []
  );
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const navigating = useRef(false);
  const mounted = useRef(true);
  const navigationEpoch = useRef(0);
  const activeView = useRef({ kind, surface, batch });
  activeView.current = { kind, surface, batch };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; navigationEpoch.current++; };
  }, []);
  const [navigationNotice, setNavigationNotice] = useState("");
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskNotice[]>([]);
  const [navigationPending, setNavigationPending] = useState(false);
  // The destination of the switch in progress, shown from the click until its guards finish.
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState("");
  const [apiConfigNotice, setApiConfigNotice] = useState("");

  function bridgeFor(id: string): WorkflowBridge | undefined {
    return (frames.current[id]?.contentWindow as (Window & { SanjieViralWorkflowBridge?: WorkflowBridge }) | null)?.SanjieViralWorkflowBridge;
  }

  function studioBridgeFor(id: string): PromptTaskBridge | undefined {
    return (frames.current[id]?.contentWindow as (Window & { SanjieStudioGenesisBridge?: PromptTaskBridge }) | null)?.SanjieStudioGenesisBridge;
  }

  function creativeToolsBridgeFor(id: string): CreativeToolsBridge | undefined {
    const bridge = (frames.current[id]?.contentWindow as (Window & { SZ_CREATIVE_TOOLS_UI?: CreativeToolsBridge }) | null)?.SZ_CREATIVE_TOOLS_UI;
    return typeof bridge?.canDeactivate === "function" && typeof bridge.getState === "function" ? bridge : undefined;
  }

  function promptTaskBridgeFor(id: string): PromptTaskBridge | undefined {
    const frameWindow = frames.current[id]?.contentWindow as (Window & {
      SanjiePromptLabTaskBridge?: PromptTaskBridge;
      SanjieAestheticMirrorBridge?: PromptTaskBridge;
      SanjieLinkImageBridge?: PromptTaskBridge;
    }) | null;
    const bridge = id === "mirror" ? frameWindow?.SanjieAestheticMirrorBridge
      : id === "list-main" ? frameWindow?.SanjieLinkImageBridge : frameWindow?.SanjiePromptLabTaskBridge;
    return typeof bridge?.canDeactivate === "function" && typeof bridge.activate === "function"
      && typeof bridge.getTaskState === "function" ? bridge : undefined;
  }

  function taskBridgeFor(id: string): PromptTaskBridge | undefined {
    return STUDIO_SURFACES.has(id) || id === BATCH_FRAME_ID ? studioBridgeFor(id) : promptTaskBridgeFor(id);
  }

  async function cachedPromptUnmountPermission(): Promise<NavigationPermission> {
    for (const item of CACHED_IMAGE_SURFACES) {
      if (!isTaskSurface(item.id) || !frames.current[item.id]) continue;
      const bridge = taskBridgeFor(item.id);
      if (!bridge) {
        if (frames.current[item.id]?.contentDocument?.documentElement.dataset.labStartup === "error") continue;
        return { allowed: false, reason: `${item.label}正在打开，请稍后再离开工作台。` };
      }
      const permission = await waitForPromptTaskBridge(bridge.canDeactivate());
      if (!permission.allowed) return { allowed: false, reason: `${item.label}：${permission.reason || "任务仍在进行，请返回原任务查看或结束等待。"}` };
    }
    return { allowed: true };
  }

  useEffect(() => {
    if (kind !== "image" || typeof window === "undefined" || !visitedWorkflows.some(isTaskSurface)) return;
    let active = true;
    let timer: number | undefined;
    const readTasks = () => {
      if (!active || document.visibilityState === "hidden") return;
      const next: BackgroundTaskNotice[] = [];
      for (const id of visitedWorkflows) {
        if (!isTaskSurface(id)) continue;
        try {
          const state = taskBridgeFor(id)?.getTaskState();
          if (state && (state.busy || state.activeCount > 0 || state.pendingReceiptCount > 0)) {
            next.push({ id, activeCount: Math.max(state.activeCount, state.busy ? 1 : 0), pendingReceiptCount: state.pendingReceiptCount,
              summary: state.summary || (state.busy ? "任务进行中" : "有待确认的请求回执") });
          }
        } catch { /* An initializing iframe is protected by its startup guard. */ }
      }
      setBackgroundTasks(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const busyCachedLabel = () => {
      for (const id of visitedWorkflows) {
        if (!isTaskSurface(id)) continue;
        try {
          const state = taskBridgeFor(id)?.getTaskState();
          if (state?.busy || (state?.activeCount || 0) > 0) return taskLabel(id);
        } catch { return "创作工作台"; }
      }
      return undefined;
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!busyCachedLabel()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const protectOuterNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin === window.location.origin && target.pathname === "/dashboards/operating-network") return;
      const label = busyCachedLabel();
      if (!label) return;
      event.preventDefault();
      event.stopPropagation();
      setNavigationNotice(`${label}有任务正在后台进行，请返回原任务查看进度或结束等待后再离开。`);
    };
    const stopPolling = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const syncPolling = () => {
      if (!active) return;
      if (document.visibilityState === "hidden") { stopPolling(); return; }
      if (timer !== undefined) return;
      readTasks();
      timer = window.setInterval(readTasks, 1000);
    };
    syncPolling();
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", protectOuterNavigation, true);
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      active = false;
      stopPolling();
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", protectOuterNavigation, true);
      document.removeEventListener("visibilitychange", syncPolling);
    };
    // Cached frames retain task callbacks; each bridge owns its account check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, visitedWorkflows]);

  async function prepareNavigation(nextSurface?: string, preserveCached = false) {
    if (navigating.current) return false;
    navigating.current = true;
    const epoch = ++navigationEpoch.current;
    const view = activeView.current;
    const stillCurrent = () => mounted.current && navigationEpoch.current === epoch
      && activeView.current.surface === view.surface && activeView.current.batch === view.batch
      && activeView.current.kind === view.kind;
    setNavigationPending(true);
    setPendingTarget(nextSurface || "video");
    setNavigationNotice("");
    try {
      const studio = view.kind === "image" && (view.batch || STUDIO_SURFACES.has(view.surface));
      const creativeTool = view.kind === "image" && !view.batch && CREATIVE_TOOL_SURFACES.has(view.surface);
      const currentFrameId = view.batch ? BATCH_FRAME_ID : view.surface;
      const promptTask = view.kind === "image" && !view.batch && CACHED_PROMPT_SURFACES.has(view.surface);
      // Only these independent iframe instances survive an internal switch.
      const currentPreserved = view.kind === "image" && isTaskSurface(currentFrameId) && preserveCached;
      const currentBridge = studio ? studioBridgeFor(currentFrameId)
        : creativeTool ? creativeToolsBridgeFor(currentFrameId)
        : promptTask ? promptTaskBridgeFor(currentFrameId)
        : !view.batch && view.kind === "image" ? bridgeFor(view.surface) : undefined;
      if (!currentBridge && !currentPreserved && view.kind === "image" && (studio || creativeTool || promptTask || isDedicatedViralSurface(view.surface))
        && frames.current[currentFrameId]?.contentDocument?.documentElement.dataset.labStartup !== "error") {
        setNavigationNotice("工作台正在打开，请稍后再切换。");
        return false;
      }
      // Read the live UI state as well as its asynchronous save/identity guard.
      // This covers preparation and uploads that do not set controller.busy.
      const tools = creativeTool ? currentBridge as CreativeToolsBridge | undefined : undefined;
      const toolsActive = () => {
        const state = tools?.getState();
        return state && (state.busy || (!state.ready && !state.startupFailed));
      };
      if (toolsActive()) {
        setNavigationNotice("当前创作工具正在处理，请等待完成或停止后续生成，再切换入口。");
        return false;
      }
      const currentPermission = () => (studio || promptTask) && currentBridge
        ? waitForPromptTaskBridge(currentBridge.canDeactivate()) : currentBridge?.canDeactivate();
      const permission = currentPreserved ? undefined : await currentPermission();
      if (!stillCurrent()) return false;
      if (permission && !permission.allowed) {
        setNavigationNotice(permission.reason || "当前任务正在执行，请等待完成或先停止任务。");
        return false;
      }
      if (!preserveCached && view.kind === "image") {
        const permission = await cachedPromptUnmountPermission();
        if (!stillCurrent()) return false;
        if (!permission.allowed) { setNavigationNotice(permission.reason || "后台任务尚未结束。"); return false; }
      }
      if (nextSurface && nextSurface !== currentFrameId) {
        const target = isTaskSurface(nextSurface) ? taskBridgeFor(nextSurface) : bridgeFor(nextSurface);
        if (isTaskSurface(nextSurface) && frames.current[nextSurface] && !target) {
          setNavigationNotice("工作台正在打开，请稍后再切换。");
          return false;
        }
        if (target) {
          const result = isTaskSurface(nextSurface)
            ? await waitForPromptTaskBridge(target.activate()) : await target.activate();
          if (!stillCurrent()) return false;
          if (!result.ok) {
            setNavigationNotice(result.error || "当前账号与 API 配置暂未就绪，请重试。");
            return false;
          }
        }
      }
      if (!stillCurrent()) return false;
      // An existing task can become busy while the target configuration loads.
      const finalPermission = currentPreserved ? undefined : await currentPermission();
      if (!stillCurrent()) return false;
      if (toolsActive() || (finalPermission && !finalPermission.allowed)) {
        setNavigationNotice(finalPermission?.reason || "当前任务正在执行，请等待完成或先停止任务。");
        return false;
      }
      if (!preserveCached && view.kind === "image") {
        const permission = await cachedPromptUnmountPermission();
        if (!stillCurrent()) return false;
        if (!permission.allowed) { setNavigationNotice(permission.reason || "后台任务尚未结束。"); return false; }
      }
      return true;
    } catch (error) {
      if (!stillCurrent()) return false;
      setNavigationNotice(error instanceof PromptTaskBridgeTimeout
        ? "工作台状态确认超时，请重试；原任务仍保留。" : "工作台暂未就绪，请稍后重试。");
      return false;
    } finally {
      if (mounted.current && navigationEpoch.current === epoch) {
        navigating.current = false;
        setNavigationPending(false);
        setPendingTarget(null);
      }
    }
  }

  function rememberWorkflow(id: string) {
    if (isCachedSurface(id)) setVisitedWorkflows((previous) => previous.includes(id) ? previous : [...previous, id]);
  }

  useEffect(() => {
    // A history link opens the visible workbench; it must not replace an active
    // detail, batch or cached workflow just because the link omits its surface.
    if (initialHistory || initialApiConfig) return;
    // Every URL revision supersedes any unfinished click, even when the prior
    // URL already matched the view and its effect had no cleanup to run.
    navigationEpoch.current++;
    navigating.current = false;
    setNavigationPending(false);
    setPendingTarget(null);
    const next = ALL_IMAGE_SURFACES.some((item) => item.id === initialSurface) ? initialSurface : "main";
    if (next === surface && initialBatch === batch) return;
    let disposed = false;
    void prepareNavigation(initialBatch ? BATCH_FRAME_ID : next, kind === "image").then((allowed) => {
      if (disposed) return;
      if (!allowed) {
        router.replace(`/dashboards/operating-network?surface=${surface}${batch ? "&batch=1" : ""}`, { scroll: false });
        return;
      }
      rememberWorkflow(initialBatch ? BATCH_FRAME_ID : next);
      setSurface(next);
      setBatch(initialBatch);
    });
    return () => {
      disposed = true;
      navigationEpoch.current++;
      navigating.current = false;
      if (mounted.current) { setNavigationPending(false); setPendingTarget(null); }
    };
    // URL changes (including back/forward) use the same task-state gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSurface, initialBatch, initialHistory, initialApiConfig]);

  useEffect(() => {
    if (!initialHistory || kind !== "image") {
      setHistoryNotice(previous => previous === "正在打开生图历史…" ? "" : previous);
      return;
    }
    if (navigationPending) return;
    const abort = new AbortController();
    const frameId = batch ? BATCH_FRAME_ID : surface;
    setHistoryNotice("正在打开生图历史…");
    void openCreativeHistory(() => frames.current[frameId], abort.signal)
      .then(() => { if (!abort.signal.aborted) setHistoryNotice(""); })
      .catch((error: Error) => { if (!abort.signal.aborted) setHistoryNotice(error.message); })
      .finally(() => {
        if (abort.signal.aborted) return;
        // Consume the request so another click on the same menu link reopens it.
        const query = batch ? `?surface=${surface}&batch=1` : surface === "main" ? "" : `?surface=${surface}`;
        router.replace(`/dashboards/operating-network${query}`, { scroll: false });
      });
    return () => abort.abort();
  }, [initialHistory, kind, surface, batch, navigationPending, router]);

  useEffect(() => {
    if (!initialApiConfig) {
      setApiConfigNotice(previous => previous === "正在打开自定义配置 API…" ? "" : previous);
      return;
    }
    if (navigationPending) return;
    const abort = new AbortController();
    const frameId = batch ? BATCH_FRAME_ID : surface;
    setApiConfigNotice("正在打开自定义配置 API…");
    void openCreativeApiConfig(() => frames.current[frameId], abort.signal, kind)
      .then(() => { if (!abort.signal.aborted) setApiConfigNotice(""); })
      .catch((error: Error) => { if (!abort.signal.aborted) setApiConfigNotice(error.message); })
      .finally(() => {
        if (abort.signal.aborted) return;
        const path = kind === "video" ? "/dashboards/operating-network/video" : "/dashboards/operating-network";
        const query = kind === "video" ? "" : batch ? `?surface=${surface}&batch=1` : surface === "main" ? "" : `?surface=${surface}`;
        router.replace(`${path}${query}`, { scroll: false });
      });
    return () => abort.abort();
  }, [initialApiConfig, kind, surface, batch, navigationPending, router]);
  const current = useMemo(
    () => ALL_IMAGE_SURFACES.find((item) => item.id === surface) || IMAGE_SURFACES[0],
    [surface]
  );
  const src = batch ? BATCH_SRC : kind === "video" ? VIDEO_SRC : current.src;
  const currentLabel = batch
    ? "批量任务"
    : kind === "video"
      ? "生成视频"
      : current.label;
  const currentFrameId = batch ? BATCH_FRAME_ID : surface;
  const pendingLabel = !pendingTarget || pendingTarget === currentFrameId ? ""
    : pendingTarget === "video" ? "生成视频" : pendingTarget === BATCH_FRAME_ID ? "批量任务"
      : ALL_IMAGE_SURFACES.find(item => item.id === pendingTarget)?.label || "创作入口";
  const taskTotals = backgroundTasks.reduce((total, task) => ({
    activeCount: total.activeCount + task.activeCount,
    pendingReceiptCount: total.pendingReceiptCount + task.pendingReceiptCount
  }), { activeCount: 0, pendingReceiptCount: 0 });

  async function openImage(id: string) {
    if (!await prepareNavigation(id, kind === "image")) return;
    if (kind !== "image") {
      router.push(id === "main" ? "/dashboards/operating-network" : `/dashboards/operating-network?surface=${id}`);
      return;
    }
    rememberWorkflow(id);
    setBatch(false);
    setSurface(id);
    router.replace(id === "main" ? "/dashboards/operating-network" : `/dashboards/operating-network?surface=${id}`, { scroll: false });
  }

  async function openBatch() {
    if (!await prepareNavigation(BATCH_FRAME_ID, kind === "image")) return;
    if (kind !== "image") {
      router.push("/dashboards/operating-network?surface=main&batch=1");
      return;
    }
    rememberWorkflow(BATCH_FRAME_ID);
    setSurface("main");
    setBatch(true);
    router.replace("/dashboards/operating-network?surface=main&batch=1", { scroll: false });
  }

  async function returnToSingle() {
    if (!await prepareNavigation("main", kind === "image")) return;
    rememberWorkflow("main");
    setBatch(false);
    setSurface("main");
    router.replace("/dashboards/operating-network", { scroll: false });
  }

  return (
    <section className={`creative-studio ${styles.studio}`} aria-label="创作工作台">
      <aside className={styles.rail} aria-label="创作功能">
        <p className={styles.railTitle}>图像创作</p>
        <nav className={styles.navigation} aria-label="图像创作导航">
          {IMAGE_SURFACES.map((item) => {
            const selected = kind === "image" && !batch && surface === item.id;
            const task = backgroundTasks.find(task => task.id === item.id);
            const switching = !!pendingLabel && pendingTarget === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-current={selected ? "page" : undefined}
                aria-busy={switching || undefined}
                className={`${styles.navItem} ${selected ? styles.active : ""} ${switching ? styles.switching : ""}`}
                disabled={navigationPending}
                onClick={() => void openImage(item.id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span className={styles.navLabel}><span>{item.label}</span>{switching ? <small>正在切换…</small> : task ? <small>{taskCounts(task)}</small> : null}</span>
              </button>
            );
          })}
        </nav>
        <p className={styles.railTitle}>视频创作</p>
        <nav className={styles.navigation} aria-label="视频创作导航">
          <button
            type="button"
            aria-label="生成视频"
            aria-current={kind === "video" && !batch ? "page" : undefined}
            aria-busy={pendingTarget === "video" && !!pendingLabel || undefined}
            className={`${styles.navItem} ${kind === "video" && !batch ? styles.active : ""} ${pendingTarget === "video" && pendingLabel ? styles.switching : ""}`}
            disabled={navigationPending}
            onClick={() => { void prepareNavigation().then((allowed) => { if (allowed) router.push("/dashboards/operating-network/video"); }); }}
          >
            <Clapperboard size={17} aria-hidden="true" />
            <span className={styles.navLabel}><span>生成视频</span>{pendingTarget === "video" && pendingLabel ? <small>正在切换…</small> : null}</span>
          </button>
        </nav>
        <button
          type="button"
          aria-label="批量任务"
          className={`${styles.batchNav} ${batch ? styles.batchActive : ""} ${pendingTarget === BATCH_FRAME_ID && pendingLabel ? styles.switching : ""}`}
          aria-current={batch ? "page" : undefined}
          aria-busy={pendingTarget === BATCH_FRAME_ID && !!pendingLabel || undefined}
          disabled={navigationPending}
          onClick={() => void openBatch()}
        >
          <Layers3 size={17} aria-hidden="true" />
          <span className={styles.navLabel}><span>批量任务</span>
            {pendingTarget === BATCH_FRAME_ID && pendingLabel ? <small>正在切换…</small> : backgroundTasks.find(task => task.id === BATCH_FRAME_ID) ?
              <small>{taskCounts(backgroundTasks.find(task => task.id === BATCH_FRAME_ID)!)}</small> : null}
          </span>
        </button>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.toolbar}>
          <div className={styles.breadcrumb}>
            <span>创作工作台</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong>{currentLabel}</strong>
            {pendingLabel ? <span role="status" className={styles.switchingStatus}>正在打开{pendingLabel}…</span> : null}
          </div>
          <button
            type="button"
            className={styles.batchButton}
            disabled={navigationPending}
            onClick={() => { void (batch ? returnToSingle() : openBatch()); }}
          >
            {batch ? <ArrowLeft size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            {batch ? "返回单个创作" : "创建批量任务"}
          </button>
        </header>
        <CreativeCredits />
        {navigationNotice ? <p role="alert" className={styles.navigationNotice}>{navigationNotice}</p> : null}
        {historyNotice ? <p role={historyNotice === "正在打开生图历史…" ? "status" : "alert"} className={styles.navigationNotice}>{historyNotice}</p> : null}
        {apiConfigNotice ? <p role={apiConfigNotice === "正在打开自定义配置 API…" ? "status" : "alert"} className={styles.navigationNotice}>{apiConfigNotice}</p> : null}
        {backgroundTasks.length > 0 ? <aside className={styles.backgroundTasks} aria-label="创作任务状态">
          <p className={styles.taskOverview}>执行中 {taskTotals.activeCount} · 回执待确认 {taskTotals.pendingReceiptCount}</p>
          {backgroundTasks.map(task => {
            const label = taskLabel(task.id);
            const active = currentFrameId === task.id;
            return <div key={task.id} className={styles.backgroundTask}>
              <p role="status"><strong>{label}</strong> · {task.summary}</p>
              {active ? <span className={styles.currentTask}>当前工作台</span>
                : <button type="button" className={styles.backgroundTaskButton} disabled={navigationPending}
                  aria-label={`${label}：返回原任务`} onClick={() => void (task.id === BATCH_FRAME_ID ? openBatch() : openImage(task.id))}>返回原任务</button>}
            </div>;
          })}
        </aside> : null}
        <div className={styles.frame}>
          {kind === "image" ? CACHED_IMAGE_SURFACES.filter((item) => visitedWorkflows.includes(item.id)).map((item) => {
            const hidden = currentFrameId !== item.id;
            return <div key={item.id} className={styles.cachedFrame} hidden={hidden} inert={navigationPending && !hidden}>
              <iframe ref={(frame) => { frames.current[item.id] = frame; }} title={item.label} src={item.src} loading="lazy" tabIndex={hidden ? -1 : undefined} />
            </div>;
          }) : null}
          {kind === "video" || (!batch && !isCachedSurface(surface)) ?
            <iframe ref={(frame) => { frames.current[batch ? BATCH_FRAME_ID : surface] = frame; }} key={src}
              title={batch ? "批量任务工作台" : kind === "video" ? "生成视频工作台" : current.label} src={src} loading={kind === "image" ? "lazy" : undefined}
              inert={navigationPending} /> : null}
        </div>
      </div>
    </section>
  );
}
