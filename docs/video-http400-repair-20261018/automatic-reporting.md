# 视频素材自动报备与安全配置

2026-10-18：用户确认 AK/SK 尚未配置，要求先做好功能和安全配置入口。本次为候选代码，不执行生产迁移、密钥配置、平台通配授权或供应商送审。此前 HTTP 400 提示修复仍独立在线。

## 用户流程

每张参考图明确选择普通商品/景物、AI 虚拟人像或真人人像；不会把未分类图片或真实人物默认为虚拟人物。普通图片沿用生成接口；虚拟人像自动 `CreateAsset` 入库；真人先从本站创建官方 H5 本人认证链接，由本人完成活体/授权，服务器查询结果并核验 `LivenessFace` 组后自动上传。`Processing` 等待原记录，`Active` 才生成，失败或未知状态停止。分析、预览与本地合成保留原图。

每次新生成前重新查询素材状态；服务器在转换 `library://va_…` 前再次核验所属用户、项目和审核状态，视频任务持有持久素材租约。结果未知只查询原幂等记录，不重新提交。本人认证回调只清理 URL 并返回工作台，浏览器的成功参数不构成认证证据。

## 管理员入口

候选版本新增 `/management/video-materials`，仅当前有效平台管理员可进入。展示配置就绪布尔值和计数，不接收、返回或显示 AK/SK/API Key。管理页提供入口；视频工作台缺配置提示指向此页。普通租户不能通过页面创建平台授权。

1. 使用火山官方 AK/SK 管理入口准备素材管理凭据，并核对同账号、同项目的视频 API Key。不要把密钥放入聊天、源码、浏览器本地存储或命令行参数。
2. 复制 `src/lib/video-assets-r51/configuration.example.json` 至服务器私密目录，文件由 root 所有、0600、单硬链接；祖先目录由 root 所有且组/其他用户不可写。模板全部禁用，配额为 `null`，不会自行生效。
3. 配置 `VIDEO_ASSET_CONFIG_FILE` 指向该文件；`VIDEO_ASSET_SOURCE_DIRECTORY` 指向独立持久缓存目录（root:0700）；将模板中的密钥引用名通过现有服务器受保护的环境配置提供给服务进程。素材源链接签名密钥至少 32 字节。
4. 核实物理方舟账号 ID、ProjectName、模型映射、实际云素材配额和外部占用，填写同一供应商绑定；不要根据网站套餐推测云配额。
5. 在部署窗口执行仓库 Prisma migration（本版本增加 `video_asset_binding_state` 表），再运行 `node scripts/check-video-assets-config.cjs`。预检只检查本地状态，不调用方舟。进程轮换后在管理员入口重新检查。
6. 先为指定测试用户显式启用，完成真实入库、审核、成片验证后再扩大使用范围。

平台统一供应可明确配置 `mode: "platform"` 及 `platformGrantEnabled: true` 的租户/用户通配 grant。只有管理员显式配置才生效；更具体的禁用 grant 覆盖通配授权。每份素材继续以真实 tenantId/userId 隔离。租户 BYOK 禁止通配，必须逐个匹配相同 API Key 指纹和项目。真人素材组不能随通配 grant 跨用户复用。

## 上线验收边界

本地自动化测试和构建不代表供应商权限、账号项目归属、真人授权及实际视频生成已验收。AK/SK 配置完成后仍需至少两个租户验证隔离：A 上传的 library ID 在 B 下不可查/不可生成；更换生成 API Key 后旧绑定失效；审核失败/授权撤销/未知状态不得触发视频 POST；成功成片需核对实际视频、音轨与积分回执。

官方依据：

- https://docs.volcengine.com/docs/ark/guide-preview?lang=zh
- https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh

不得将真人送入 AIGC 组绕过核验；真人首次活体/授权必须由本人完成。H5 链接和 BytedToken 均为私密会话信息，不写入通用日志。部署应为核验回调采用不记录 query 的访问日志格式，避免供应商附带的认证参数进入日志。
