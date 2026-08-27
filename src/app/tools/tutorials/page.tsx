import {
  ArrowLeft,
  CirclePlay,
  Clock3,
  Layers3,
  Sparkles
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ToolsSubnav } from "@/components/tools/ToolsSubnav";
import { TOOL_TUTORIALS } from "@/lib/tool-tutorials";

export const metadata: Metadata = {
  title: "视频教程 · AI 自动化工具 · 三阶引擎",
  description: "少壮 AI 自动化工具的视频学习专区，按真实任务组织安装、采集、企划、视觉生产与经营复盘教程。"
};

const TUTORIAL_TRACKS = [
  {
    no: "01",
    title: "安装与更新",
    description: "浏览器插件安装、登录解锁、模型 API 配置、版本更新与常见问题。"
  },
  {
    no: "02",
    title: "数据采集",
    description: "关键词、相关词、市场商品榜与分日数据的完整采集路径。"
  },
  {
    no: "03",
    title: "词根与链接企划",
    description: "从需求分析、业务知识到链接清单与标题策略。"
  },
  {
    no: "04",
    title: "AI 视觉生产",
    description: "主图、详情、SKU、爆款裂变、修复与成果归档。"
  },
  {
    no: "05",
    title: "达摩盘与经营复盘",
    description: "商品对标、报告中心、预算安排与投放场景复盘。"
  }
] as const;

export default function ToolTutorialsPage() {
  const tutorialCount = TOOL_TUTORIALS.length;
  const hasPublishedTutorial = TOOL_TUTORIALS.length > 0;
  const tutorialCountByTrack = TOOL_TUTORIALS.reduce<Record<string, number>>(
    (counts, tutorial) => {
      counts[tutorial.trackNo] = (counts[tutorial.trackNo] ?? 0) + 1;
      return counts;
    },
    {}
  );

  return (
    <>
      <PageHeader
        eyebrow="AI Toolbox · Learning Center"
        title="视频教程专区"
        description="把复杂功能拆成可直接照做的任务路径，从第一次安装到完成一次经营闭环，按需观看，不必从头学起。"
      />

      <ToolsSubnav active="tutorials" />

      <section className="tool-tutorial-hero">
        <div className="tool-tutorial-hero-copy">
          <span className="tool-tutorial-status">
            <Sparkles size={15} />
            {hasPublishedTutorial ? `${tutorialCount} 条教程已上线` : "视频地址待配置"}
          </span>
          <h2>跟着真实任务，边看边完成</h2>
          <p>
            每条教程对应一个明确结果：装好插件、采完一张表、完成一组链接企划，或跑通一次主图与详情生产。可从当前任务直接开始。
          </p>
          <div className="tool-tutorial-meta" aria-label="教程规划">
            <span><Layers3 size={16} /> 5 类学习路径</span>
            <span><Clock3 size={16} /> 短视频分步讲解</span>
          </div>
        </div>
        <div className="tool-tutorial-hero-mark" aria-hidden="true">
          <span><CirclePlay size={52} /></span>
          <strong>视频教程</strong>
          <small>{hasPublishedTutorial ? `${tutorialCount} 条教程 · 持续更新` : "配置正式地址后展示"}</small>
        </div>
      </section>

      <section className="tool-tutorial-section" aria-labelledby="tutorial-tracks-title">
        <header className="tool-tutorial-section-head">
          <div>
            <span>LEARNING PATHS</span>
            <h2 id="tutorial-tracks-title">按任务找到对应教程</h2>
          </div>
          <small>5 个主题持续更新</small>
        </header>

        <div className="tool-tutorial-track-grid">
          {TUTORIAL_TRACKS.map((track) => {
            const trackTutorialCount = tutorialCountByTrack[track.no] ?? 0;

            return (
              <article key={track.no} className="tool-tutorial-track">
                <span>{track.no}</span>
                <div>
                  <strong>{track.title}</strong>
                  <p>{track.description}</p>
                </div>
                <small>
                  {trackTutorialCount > 0
                    ? `已上线 ${trackTutorialCount} 条`
                    : "持续更新"}
                </small>
              </article>
            );
          })}
        </div>
      </section>

      {hasPublishedTutorial ? (
        <section className="tool-tutorial-library" aria-labelledby="tutorial-library-title">
          <header className="tool-tutorial-section-head">
            <div>
              <span>VIDEO LIBRARY</span>
              <h2 id="tutorial-library-title">最新视频教程</h2>
            </div>
            <small>{tutorialCount} 条教程</small>
          </header>
          <div className="tool-tutorial-video-grid">
            {TOOL_TUTORIALS.map((tutorial) => (
              <article key={tutorial.slug} className="tool-tutorial-video-card">
                <div className="tool-tutorial-player">
                  <video
                    aria-label={tutorial.title}
                    controls
                    playsInline
                    preload="metadata"
                    poster={tutorial.posterSrc}
                    src={tutorial.videoSrc}
                  >
                    当前浏览器不支持视频播放。
                  </video>
                </div>
                <div className="tool-tutorial-video-body">
                  <div className="tool-tutorial-video-meta">
                    <span>{tutorial.category}</span>
                    <small>{tutorial.duration}</small>
                  </div>
                  <h3>{tutorial.title}</h3>
                  <p>{tutorial.summary}</p>
                  <footer>
                    <time dateTime={tutorial.publishedAt}>{tutorial.publishedAt}</time>
                  </footer>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="tool-tutorial-empty" aria-labelledby="tutorial-empty-title">
          <span className="tool-tutorial-empty-icon" aria-hidden="true">
            <CirclePlay size={28} />
          </span>
          <div>
            <small>VIDEO URL REQUIRED</small>
            <h2 id="tutorial-empty-title">教程视频尚未发布</h2>
            <p>配置正式视频地址后，这里才会展示播放器、封面、时长与发布日期，不使用占位视频。</p>
          </div>
          <Link className="tool-tutorial-back" href="/tools" prefetch={false}>
            <ArrowLeft size={16} /> 返回工具总览
          </Link>
        </section>
      )}
    </>
  );
}
