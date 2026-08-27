export type ToolTutorial = {
  slug: string;
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
};

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
  const videoSrc = normalizeMediaUrl(
    environment.NEXT_PUBLIC_TUTORIAL_VIDEO_URL
  );
  if (!videoSrc) return [];

  const posterSrc = normalizeMediaUrl(environment.POSTER_URL);

  return [
    {
      slug: "shaozhuang-ai-automation-tutorial",
      title: "少壮AI自动化教程",
      summary: "从生意参谋数据采集、参数配置、任务启动到文件归档，完整演示少壮AI自动化的操作流程。",
      category: "数据采集",
      duration: "04:04",
      publishedAt: "2026-08-27",
      videoSrc,
      ...(posterSrc ? { posterSrc } : {})
    }
  ];
}

// 没有正式视频 URL 时保持为空，教程页不会渲染占位或伪视频播放器。
export const TOOL_TUTORIALS = buildToolTutorials({
  NEXT_PUBLIC_TUTORIAL_VIDEO_URL:
    process.env.NEXT_PUBLIC_TUTORIAL_VIDEO_URL,
  POSTER_URL: process.env.POSTER_URL
});
