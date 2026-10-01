"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const IMAGE_SURFACES = [
  {
    id: "main",
    label: "主图",
    hint: "参考图提词、链接清单主图、主体图生图和批量下载。",
    src: "/creative/labs/image-prompt-lab/promptlab.html?source=web"
  },
  {
    id: "detail",
    label: "详情",
    hint: "按链接编号生成连续详情分屏，单屏失败不会拖住整批。",
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=link&source=web"
  },
  {
    id: "reference",
    label: "参考成详",
    hint: "只用已授权商品页结构重建详情，不接收单张竞品图。",
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=reference&source=detail-reference"
  },
  {
    id: "sku",
    label: "批量 SKU",
    hint: "只替换商品主体，画布、文字和背景保持原样。",
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=sku&source=web"
  },
  {
    id: "viral",
    label: "爆款裂变",
    hint: "保留自家商品，重做一张高端详情单屏。",
    src: "/creative/labs/image-prompt-lab/promptlab.html?mode=viral&source=web"
  }
];

const VIDEO_SRC = "/creative/labs/ecommerce-video-studio/video-studio.html";

export function CreativeStudio({
  kind,
  initialSurface = "main"
}: {
  kind: "image" | "video";
  initialSurface?: string;
}) {
  const router = useRouter();
  const [surface, setSurface] = useState(
    IMAGE_SURFACES.some((item) => item.id === initialSurface) ? initialSurface : "main"
  );
  const current = useMemo(
    () => IMAGE_SURFACES.find((item) => item.id === surface) || IMAGE_SURFACES[0],
    [surface]
  );
  const src = kind === "video" ? VIDEO_SRC : current.src;

  function openImage(id: string) {
    if (kind !== "image") {
      router.push(id === "main" ? "/dashboards/operating-network" : `/dashboards/operating-network?surface=${id}`);
      return;
    }
    setSurface(id);
  }

  return (
    <section className="creative-studio" aria-label={kind === "video" ? "生成视频" : "作图工作台"}>
      <div className="creative-studio-bar">
        <div>
          <p className="creative-studio-kicker">{kind === "video" ? "VIDEO" : "IMAGE"}</p>
          <h1>{kind === "video" ? "生成视频" : "作图工作台"}</h1>
        </div>
        <div className="creative-studio-switch" role="tablist" aria-label="创作工作台">
          {IMAGE_SURFACES.map((item) => {
            const selected = kind === "image" && surface === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={selected ? "is-active" : ""}
                onClick={() => openImage(item.id)}
              >
                {item.label}
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={kind === "video"}
            className={kind === "video" ? "is-active" : ""}
            onClick={() => router.push("/dashboards/operating-network/video")}
          >
            生成视频
          </button>
        </div>
      </div>
      <p className="creative-studio-note">
        {kind === "video"
          ? "先选创作路线和视觉风格，再提交真实视频任务。点「配置视频 API」保存豆包密钥；密钥只留在当前浏览器，请求由本站转发。"
          : `${current.hint}点右上角「统一 API 设置」会打开本页的独立版配置，密钥按当前登录账号留在这台浏览器。`}
      </p>
      <div className="creative-studio-frame">
        <iframe key={src} title={kind === "video" ? "生成视频工作台" : current.label} src={src} />
      </div>
    </section>
  );
}
