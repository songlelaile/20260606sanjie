# 生成视频工作台

入口为 `video-studio.html`。页面管理创作路线、视觉风格、素材、草稿、人工审稿和任务历史；模型调用、账号凭据与供应商状态由扩展后台处理。缺少后台、账号配置、模型映射或真实任务回执时，页面会失败关闭，不模拟成功。

内部目录名保留 `ecommerce-video-studio` 以兼容已有构建、淘宝主图/视频导入和消息协议。

## 四层请求结构

```text
模式 direct / assist / remix
  × creativeRoute 六选一
  × styleProfile 八选一
  × Seedance 逐模型硬能力
```

创作路线：

- `free_direct`：一句话生成，可无素材。
- `hero_product`：商品图成片，至少 1 张商品图。
- `elements_compose`：多素材导演，至少 2 个视觉素材。
- `storyboard_direct`：分镜成片，可无素材。
- `reference_rebuild`：参考重构，仅 `remix`；当前只分析本地均匀抽取的 5 帧。
- `audio_visual`：音画成片，至少 1 个音频；2.0 还需视觉素材。

视觉风格：`commerce_studio`、`lifestyle_social`、`ugc_mobile`、`cinematic_brand`、`viral_fastcut`、`animation_ip`、`mixed_motion`、`surreal_vfx`。

路线、风格和素材用途会进入规范请求、草稿、确认指纹、历史和 Ark Prompt，不是装饰控件。

## 模型兼容子集

| 项目 | Seedance 2.0 | Seedance 2.5 |
| --- | --- | --- |
| Model ID | `doubao-seedance-2-0-260128` | `doubao-seedance-2-5-260628` |
| 时长 | 4–15 秒 | 4–30 秒 |
| UI 分辨率 | 480p / 720p / 1080p / 4k | 480p / 720p / 1080p |
| 比例 | 六种固定比例 + adaptive | 同左 |
| 图 / 视频 / 音频 | 9 / 3 / 3 | 30 / 10 / 10 |
| 素材总数 | 15 | 50 |

2.5 专项教程明确把 480p / 720p / 1080p 列为输出规格；同页的 480p / 720p 限制描述的是参考视频输入。2.0 的标准模型正式支持 4K。2.5 的 1080p 与 2.0 的 4K 均可能采用 10-bit H.265，因此结果预览失败时保留打开/下载入口并提示使用兼容播放器，不能把播放兼容性误判为生成失败。

工作台不另存 API Key。“配置视频 API”只打开当前账号的统一 API 设置并定向选择豆包 / 火山方舟；保存后返回本页会自动刷新一次能力。后台的 READY 仅表示已读取配置，Seedance 模型权限仍在真实提交时由供应商验证。

## Ark 适配

- `content` 始终先放文本，再按稳定顺序放图片、视频、音频。
- Prompt 用“图片 1 / 视频 1 / 音频 1”绑定 UI 素材用途。
- 供应商 `role` 使用 `reference_image/reference_video/reference_audio`。
- 2.5 有参考素材时显式传 `omni_reference_task_type: reference` 和 `output_format: mp4`。
- 2.0 必须省略这两个专属字段。
- 默认 Ark 可把本地图片和音频转 Data URL；本地视频没有官方 Base64 链路，因此 UI 禁用该入口，只接受 HTTPS / `asset://` 视频。
- Create 必须有 task ID；Get 的成功状态必须有结果 URL；Delete 只在供应商支持的状态展示。

## 声音

- `silent` → `generate_audio:false`。
- `sound_only` → `generate_audio:true` + Prompt 软约束，UI 显示“尽量无口播”。
- `narration` → `generate_audio:true` + 语言和台词提示，不承诺精确口型或音色。

## 数据与权利

素材 Blob、分模式草稿和页面历史保存在模块自己的 IndexedDB。消息只发送 `remoteUrl` 或 `storageRef`，不内嵌 File/Blob。API Key 由统一账号配置解析器提供，不写入草稿或公开任务字段。

有任何素材时，`submit` 合同要求：

```js
rights: {
  confirmed: true,
  confirmedAt: 'ISO-8601',
  assetFingerprint: 'rights_...',
  statementVersion: 'ASSET_RIGHTS_V2'
}
```

素材变化会令指纹失效。无素材的文本生成无需勾选空权利声明。真人参考必须使用供应商已认证的可信素材。

## 已知边界

- `reference_rebuild` 只看 5 帧，不声称理解精确运镜、剪辑点或原音轨。
- 没有 `seed`、帧级时间线、精确口型、局部蒙版、无缝续写或固定摄像机控件。
- Provider 没有真实进度百分比时，页面只显示真实状态，不制造平滑进度。
- 结果 URL 是短期地址，成功后应尽快下载或转存。
- 时长滑杆保留逐秒选择，并提供 4 / 5 / 10 / 15 / 20 / 30 秒快捷按钮；超过当前模型上限的按钮会禁用。

完整设计、模型证据与“不做清单”见 `../../docs/ECOMMERCE_VIDEO_STUDIO_V1.md`。

## 自检

```sh
node --check video-studio-contract.js
node --check video-studio-store.js
node --check video-studio.js
node --test ../../tests/ecommerce-video-*.test.js
```

其中 `ecommerce-video-settings-100-rounds.test.js` 固定执行 100 个不重复场景，并核对状态、草稿恢复、最终请求与模型能力矩阵。

直接以 `file://` 或普通 HTTP 打开时没有 `chrome.runtime`，页面应显示“生成能力未接入”并阻止提交；这不属于供应商出片验证。
