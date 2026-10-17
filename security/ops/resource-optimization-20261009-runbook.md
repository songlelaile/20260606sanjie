# 服务器资源保护与历史版本恢复

范围：47.111.2.10 上的 shaozhuangai.com。该文档不包含凭据。

## 已配置的日常保护

- `sanjie-resource-watch.timer`：每 5 分钟检查云盘、inode、MemAvailable。记录状态变化到服务器系统日志，没有配置手机、短信或外部通知。
- `sanjie-build-retention.timer`：北京时间每日 04:30 加最多 10 分钟随机延迟。仅清理超过 7 天、未运行且未被引用的旧版本 `node_modules` 和 `.next`，每日最多 10 GiB。源码、配置、数据库、素材不在清理范围。
- 保护当前 PM2 版本、进程打开文件、Nginx 路径与端口、跨版本符号链接依赖、最近两个日期版本、指定回滚版本和挂载点。无法取得必要保护信息时，非零退出，不继续删除。
- 日志每小时检查轮转；`maxsize 20M` 是检查触发阈值，不是瞬时硬上限。系统 journal 上限 256M，保留最多 30 天。

## 一次性下载包去重

只选择停用版本中明确命名的公开软件 ZIP，按 SHA256 和大小合并完全一致的内容。当前版本、回滚版本及依赖提供目录的文件保持原样。历史文件路径改为指向 `/var/lib/sanjie-release-assets/sha256/` 的链接，规范副本只读且没有自动删除任务。

私有记录在服务器 `/root/sanjie-resource-optimization-20261009/phase2/`。`download-dedupe-manifest.jsonl` 包含原路径、内容哈希、权限、所有者、时间和目录身份；已提交和发生中断的替换均可由恢复工具校验。

恢复工具读取 SHA256 校验一致的清单副本 `/var/lib/sanjie-resource-watch/download-restore-20261009/download-dedupe-manifest.jsonl`，并将结果写入同目录的 `download-restore-result.json`。该专用目录及祖先由 root 所有，目录权限 0700，清单权限 0600；原始审计记录保留。首次恢复预览因 `/root` 的现有所有者不是 root 而拒绝，迁移清单后通过，原目录所有权与严格权限检查均保持原样。

历史版本重新启用前，先恢复该版本的下载包为普通文件，再重新安装依赖和构建。网站的受保护下载接口要求文件位于该版本的下载目录内，因此不要直接运行已经去重的旧版本。

```sh
python3 /root/sanjie-resource-optimization-20261009/phase2/release-download-restore-20261009.py --release /opt/sanjie-releases/具体历史版本
# 预览成功、确认该版本仍停用后恢复：
python3 /root/sanjie-resource-optimization-20261009/phase2/release-download-restore-20261009.py --release /opt/sanjie-releases/具体历史版本 --apply
```

恢复工具单次上限 8 GiB，并保留至少 2 GiB 可用空间；在线、指定回滚和被依赖的版本会被保护。不要手工删除规范副本仓库，或将整个旧版本目录一并删除。

## 运行验收

优化前后的私有指纹记录为 `runtime-before.json` 和 `runtime-after.json`，比较 PM2 PID/重启计数、Docker ID/启动时间、Nginx 配置、当前及回滚版本的软件包与构建标识 SHA256、应用链接。1252 个历史下载路径及 24 组规范副本已全量校验；服务器恢复预览验证一个历史版本的 6 个文件，没有将重复文件实际恢复占盘。最终结果见本目录的 `resource-deep-optimization-20261009.json`。

一次性 `resource-phase2-finish.py` 已执行 QA 清理，不应重跑其要求清理前仍有 3 个目标的预览步骤。首次恢复预览拒绝及修复保留在审计中；后续 `resource-phase2-closeout.py` 核对既有成功结果、私有清单副本、恢复预览与新版每日清理实跑后生成最终完成收据。
