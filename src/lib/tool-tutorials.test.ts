import { describe, expect, it } from "vitest";
import { buildToolTutorials } from "@/lib/tool-tutorials";

describe("tool tutorial environment configuration", () => {
  it("renders no fake tutorial when the formal video URL is absent", () => {
    expect(buildToolTutorials({})).toEqual([]);
    expect(buildToolTutorials({ POSTER_URL: "https://cdn.example.com/poster.jpg" })).toEqual([]);
    expect(buildToolTutorials({ NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "   " })).toEqual([]);
  });

  it("builds the published tutorial with the fixed business metadata", () => {
    expect(buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "https://cdn.example.com/tutorial.mp4",
      POSTER_URL: "https://cdn.example.com/tutorial.jpg"
    })).toEqual([
      {
        slug: "shaozhuang-ai-automation-tutorial",
        title: "少壮AI自动化教程",
        summary: "从生意参谋数据采集、参数配置、任务启动到文件归档，完整演示少壮AI自动化的操作流程。",
        category: "数据采集",
        duration: "04:04",
        publishedAt: "2026-08-27",
        videoSrc: "https://cdn.example.com/tutorial.mp4",
        posterSrc: "https://cdn.example.com/tutorial.jpg"
      }
    ]);
  });

  it("accepts same-site media paths and rejects unsafe or insecure schemes", () => {
    expect(buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: " /tutorials/first.mp4 ",
      POSTER_URL: "/tutorials/first.jpg"
    })[0]).toMatchObject({
      videoSrc: "/tutorials/first.mp4",
      posterSrc: "/tutorials/first.jpg"
    });

    expect(buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "javascript:alert(1)"
    })).toEqual([]);
    expect(buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "http://cdn.example.com/tutorial.mp4"
    })).toEqual([]);
    expect(buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "//cdn.example.com/tutorial.mp4"
    })).toEqual([]);
  });
});
