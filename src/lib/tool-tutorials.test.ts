import { describe, expect, it } from "vitest";
import { buildToolTutorials } from "@/lib/tool-tutorials";

describe("tool tutorial environment configuration", () => {
  it("renders no fake tutorial when every formal video URL is absent", () => {
    expect(buildToolTutorials({})).toEqual([]);
    expect(
      buildToolTutorials({
        POSTER_URL: "https://cdn.example.com/poster.jpg",
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL:
          "https://cdn.example.com/doubao.jpg"
      })
    ).toEqual([]);
    expect(
      buildToolTutorials({ NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "   " })
    ).toEqual([]);
  });

  it("builds the original tutorial with its fixed business metadata", () => {
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL:
          "https://cdn.example.com/tutorial.mp4",
        POSTER_URL: "https://cdn.example.com/tutorial.jpg"
      })
    ).toEqual([
      {
        slug: "shaozhuang-ai-automation-tutorial",
        trackNo: "02",
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

  it("publishes the Doubao API tutorial independently", () => {
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL:
          "https://cdn.example.com/configure-doubao-api.mp4",
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL:
          "https://cdn.example.com/configure-doubao-api.jpg"
      })
    ).toEqual([
      {
        slug: "configure-doubao-api",
        trackNo: "01",
        title: "配置豆包API",
        summary: "完成豆包 API 的基础配置，跑通少壮 AI 自动化所需的模型接入流程。",
        category: "模型配置",
        duration: "04:25",
        publishedAt: "2026-08-27",
        videoSrc: "https://cdn.example.com/configure-doubao-api.mp4",
        posterSrc: "https://cdn.example.com/configure-doubao-api.jpg"
      }
    ]);
  });

  it("keeps learning-path order and unique slugs when both tutorials are live", () => {
    const tutorials = buildToolTutorials({
      NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "/media/tutorials/automation.mp4",
      NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL:
        "/media/tutorials/configure-doubao-api.mp4"
    });

    expect(tutorials.map((tutorial) => tutorial.slug)).toEqual([
      "configure-doubao-api",
      "shaozhuang-ai-automation-tutorial"
    ]);
    expect(new Set(tutorials.map((tutorial) => tutorial.slug)).size).toBe(
      tutorials.length
    );
  });

  it("does not suppress a valid tutorial when the other URL is invalid", () => {
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "http://cdn.example.com/unsafe.mp4",
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL:
          "https://cdn.example.com/configure-doubao-api.mp4"
      }).map((tutorial) => tutorial.slug)
    ).toEqual(["configure-doubao-api"]);

    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL:
          "https://cdn.example.com/automation.mp4",
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL: "javascript:alert(1)"
      }).map((tutorial) => tutorial.slug)
    ).toEqual(["shaozhuang-ai-automation-tutorial"]);
  });

  it("accepts same-site media paths and rejects unsafe or insecure schemes", () => {
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL: " /tutorials/first.mp4 ",
        POSTER_URL: "/tutorials/first.jpg"
      })[0]
    ).toMatchObject({
      videoSrc: "/tutorials/first.mp4",
      posterSrc: "/tutorials/first.jpg"
    });

    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "javascript:alert(1)"
      })
    ).toEqual([]);
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "http://cdn.example.com/tutorial.mp4"
      })
    ).toEqual([]);
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_VIDEO_URL: "//cdn.example.com/tutorial.mp4"
      })
    ).toEqual([]);
  });

  it("omits only an unsafe poster while preserving its valid video", () => {
    expect(
      buildToolTutorials({
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_VIDEO_URL:
          "https://cdn.example.com/configure-doubao-api.mp4",
        NEXT_PUBLIC_TUTORIAL_DOUBAO_API_POSTER_URL:
          "http://cdn.example.com/configure-doubao-api.jpg"
      })[0]
    ).toEqual({
      slug: "configure-doubao-api",
      trackNo: "01",
      title: "配置豆包API",
      summary: "完成豆包 API 的基础配置，跑通少壮 AI 自动化所需的模型接入流程。",
      category: "模型配置",
      duration: "04:25",
      publishedAt: "2026-08-27",
      videoSrc: "https://cdn.example.com/configure-doubao-api.mp4"
    });
  });
});
