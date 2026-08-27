export type ToolTutorial = {
  slug: string;
  trackNo: string;
  title: string;
  summary: string;
  category: string;
  duration: string;
  publishedAt: string;
  videoSrc: string;
  posterSrc?: string;
};

export type ToolTutorialEnvironment = {
  NEXT_PUBLIC_TUTORIAL_VIDEO_URL?: string;
  POSTER_URL?: string;
  NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL?: string;
  NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL?: string;
};

type ToolTutorialDefinition = Omit<
  ToolTutorial,
  "videoSrc" | "posterSrc"
> & {
  videoEnvironmentKey: keyof ToolTutorialEnvironment;
  posterEnvironmentKey: keyof ToolTutorialEnvironment;
};

const TOOL_TUTORIAL_DEFINITIONS = [
  {
    slug: "configure-doubao-api",
    trackNo: "01",
    title: "配置豆包API",
    summary: "完成豆包 API 的基础配置，跑通少壮 AI 自动化所需的模型接入流程。",
    category: "模型配置",
    duration: "04:25",
    publishedAt: "2026-08-27",
    videoEnvironmentKey: "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL",
    posterEnvironmentKey: "NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL"
  },
  {
    slug: "shaozhuang-ai-automation-tutorial",
    trackNo: "02",
    title: "少壮AI自动化教程",
    summary: "从生意参谋数据采集、参数配置、任务启动到文件归档，完整演示少壮AI自动化的操作流程。",
    category: "数据采集",
    duration: "04:04",
    publishedAt: "2026-08-27",
    videoEnvironmentKey: "NEXT_PUBLIC_TUTORIAL_VIDEO_URL",
    posterEnvironmentKey: "POSTER_URL"
  }
] as const satisfies readonly ToolTutorialDefinition[];

function normalizeMediaUrl(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value) return undefined;

  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function buildToolTutorials(
  environment: ToolTutorialEnvironment
): readonly ToolTutorial[] {
  return TOOL_TUTORIAL_DEFINITIONS.flatMap<ToolTutorial>((definition) => {
    const {
      videoEnvironmentKey,
      posterEnvironmentKey,
      ...tutorialMetadata
    } = definition;
    const videoSrc = normalizeMediaUrl(environment[videoEnvironmentKey]);
    if (!videoSrc) return [];

    const posterSrc = normalizeMediaUrl(environment[posterEnvironmentKey]);

    return [
      {
        ...tutorialMetadata,
        videoSrc,
        ...(posterSrc ? { posterSrc } : {})
      }
    ];
  });
}

// 没有正式视频 URL 时保持为空，教程页不会渲染占位或伪视频播放器。
export const TOOL_TUTORIALS = buildToolTutorials({
  NEXT_PUBLIC_TUTORIAL_VIDEO_URL:
    process.env.NEXT_PUBLIC_TUTORIAL_VIDEO_URL,
  POSTER_URL: process.env.POSTER_URL,
  NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL:
    process.env.NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL,
  NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL:
    process.env.NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL
});
