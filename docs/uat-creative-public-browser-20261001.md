# 公网作图视频浏览器验收

入口：https://shaozhuangai.com/uat/creative-20261001；退出：https://shaozhuangai.com/uat/creative-exit。使用实际 Google Chrome 与公网 HTTPS，专门隔离浏览器 context；未接触用户原浏览器配置与历史。

## 已完成检查

- 自主注册与未受邀流程：23 项全部通过，实际注册一个专门 QA 账号。确认开通门禁、HTML/代理 402、管理员接口 403、普通账号不能自行确认入账、下单与本人查单、退出清测试 Cookie、保留正式 Cookie，旧测试标签页被 Nginx 409 拦截。
- 受邀流程：一次性 QA 邀请码注册成功；最终复验使用该账号重新登录。五个作图入口（主图、详情、参考成详、批量 SKU、爆款裂变）与视频 iframe 均返回 HTML 200，环境标记保持。
- 视频模式复验在生成能力初始检查结束后逐一点击脚本帮写、爆款复刻、脚本直出，并等待对应 `aria-selected=true` 且唯一活动项，避免把仅可点击当成实际切换成功。
- 公网受邀最终 23 项全部通过，与未受邀 23 项合计 46 项，页面错误均为 0。正常取消视频 API 对话框已精准修复；实际公网中性提示、原配置存储完全不变、没有错误 toast 的新增检查通过。旧版 22 项结果留存为 `public-invited-browser-acceptance-v1.json`。

付款全部为 QA 下单或独立本机库模拟到账。未通过公网管理员确认真实钱款，也没有供应商生成、真实付费中转请求或原用户浏览器迁移。

两个修复脚本另经真实测试账号认证的公网 HTTPS 请求验证：HTTP 200、SHA 与新冻结包一致，结果位于 `docs/uat-creative-evidence-20261001/public-static-hashes.json`。匿名直接请求会按登录门禁跳回登录页。

## 留存证据

证据均在包外目录 `/Users/shaozhuang/20260606sanjie/.codex-deploy/creative-uat-20261001/browser/`：

- `public-browser-acceptance.json`：自主注册流程结果。
- `public-invited-browser-acceptance.json`：受邀账号最终复验结果。
- `12-public-unpaid-order.png`：未付费下单界面。
- `13-public-invited-image.png`：作图工作台。
- `14-public-invited-video.png`：视频工作台。

QA 口令与一次性邀请码只保存在 Git 忽略的 0600 私有文件中，未包含在源码包或本报告。
