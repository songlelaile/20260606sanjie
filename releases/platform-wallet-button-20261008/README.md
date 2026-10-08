# 平台积分生图按钮修复：可重放生产补丁

平台积分模式不再要求浏览器保存个人 API Key。四个 JavaScript 文件保留账号、权限、原图、配置、供应商回执和重试保护，并以登录会话调用本站代理；一个 HTML 文件仅更新四个脚本的缓存版本参数。个人自有 API 模式仍要求有效 Key。

本目录绑定经过 SHA 验证的线上 `image-repair-20261007` 基线。仓库 HEAD `b59de14` 的历史基线尚未同步，缺少此前已上线的部分创作合同和界面；这份窄补丁不能直接应用到 HEAD。工作区当前运行文件也包含其他未提交修改，不能替代本目录的 before/after 指纹。这里提交受指纹约束的补丁、回归测试和公开回执，不把已有线上功能或其他工作混入本次修复。

生产静态补丁已于 2026-10-08 17:44:28（北京时间）发布，五个 after SHA 和五份 before 备份已核验，服务和 Nginx 身份保持不变。已登录原账号，保留原店铺。网页恢复的是两张浅色西装草稿，与最初截图的单张深色西装不同；用户随后授权先跑通当前任务。点击可用的“重试此图”一次（gpt-image-2、1:1、1K、1张，预计5积分），收到新的“供应订阅未配置，本次未提交生图”回执，界面仍为 **0/1 已完成**。未抓取原始网络响应；`CREATIVE_SUPPLY_NOT_CONFIGURED`、`providerSubmitted=false`、`definitiveFailure=true` 是该明确未提交文字对应的已核源代码合同。读取积分记录后余额仍为 **1,182.1积分**，没有新增扣分记录；打开生成记录仍为 **0张**。没有生成图片或历史原件。服务端供应凭据未配置仍是端到端生成阻塞，本次修复没有更改供应配置。发布成功不等于真实生图完成。

## 文件与范围

- `wallet-button.patch`：仅五个生产文件相对已验证基线的真实差异。
- `.gitattributes`：仅对补丁文件保留 unified diff 的空白上下文行；其前导空格是可重放格式的一部分。
- `manifest.json`：补丁自身 SHA、五个 before/after SHA，以及隔离回归测试需要的 17 个公开脚本/HTML 的基线 SHA。
- `replay.mjs`：先验证所有指纹和补丁上下文，再将白名单公开资产复制到一个全新的本机目录并重放补丁；不会改输入基线，不连接网络，不调用供应商。
- `tests/creative-platform-wallet.test.ts`、`tests/creative-config-profiles.test.ts`、`vitest.config.ts`：独立的 22 项回归测试与配置；测试来自本轮修复，使用合成账号、图片、Key 和代理响应，不生成真实素材。
- `deployment-receipt.json`：必要公开时间、进程/路由指纹和 UI 结果；不含账号表、密钥、密码、源图或截图中的个人信息。

## 隔离重放和测试

需要 Node.js 和本仓库已经安装的 Vitest。输入为完整、可信的项目基线根目录，内部包含 `public/creative/`，且匹配 manifest 中的 SHA。不能使用旧 HEAD 或混有其他修改的工作区作为基线。

在仓库根目录执行，替换两个路径；输出路径必须不存在，且位于基线之外：

```sh
node releases/platform-wallet-button-20261008/replay.mjs \
  --baseline /absolute/path/to/verified-image-repair-project \
  --output /absolute/path/to/new-wallet-button-fixture

CREATIVE_ASSET_TEST_ROOT=/absolute/path/to/new-wallet-button-fixture/public/creative \
  ./node_modules/.bin/vitest run \
  --config releases/platform-wallet-button-20261008/vitest.config.ts
```

本次本机基线存放在 `.codex-deploy/image-repair-20261007/candidate`，属于被 Git 忽略的历史生产证据，其他机器须独立取得对应可信基线。`replay.mjs` 会拒绝任何指纹不符或已有输出目录。测试显式要求 `CREATIVE_ASSET_TEST_ROOT`，没有默认工作区回退；独立配置不会把这些依赖旧生产基线的测试加入仓库 HEAD 的默认测试集合。

测试覆盖规范供应地址、无浏览器 Key 的平台分析与两种生图协议、参考图合同、原配置保留、账号切换、登录/权限限制、自有 API 仍需 Key，以及供应未配置的确定未提交回执。本目录的22项测试使用实际发布版本的冻结断言；此前另有5项针对性界面runtime验收通过。测试只证明代码合同；真实图片、供应调用、扣积分与历史交付须另行以真实回执验收。

本目录不是自动线上发布入口。上线仍需本次适用的共享锁、现场进程/Nginx 指纹、新鲜 seal、逐文件 CAS 和回滚备份。不能使用这里的旧公开回执代替未来发布前的现场检查。
