# 重构 v2：分日数据 + 优化动作前后对比（设计文档）

> 目标：① 源数据从「汇总多天」升级为「分日明细」；② 管理视角能看出"优化调整动作"之后的数据对比变化。
> 决策：较大重构、时序为中心；优化动作由运营手动标记；对比三种口径都做（真实经营 / 计划vs实际 / 整店趋势）。

---

## 1. 现状约束（为什么要改）

1. **算法无视日期**：`buildInvestmentResults` 用 `new Map(rows.map(r => [productId, r]))`，每商品只留最后一行。现在靠"运营上传已汇总成每商品一行"的报表绕过。
2. **数据全在一个 JSON blob**：`Workspace.data` 一个字段装下 imports / uploadedSources / prefillItems / calcRun / versions / history。时序明细放进 blob 会膨胀且无法按日期查询。
3. **保留策略冲突**：当前"租户只留最新 1 次，更新即清旧"。前后对比必须留存历史每日数据。
4. **达摩盘表无日期字段**；人群表用 `dateRange` 区间而非单日。
5. **无图表库**：三口径里的趋势曲线需要引入轻量图表。

---

## 2. 数据模型（新增 Prisma 关系表，时序落库）

把**时序源数据**从 blob 迁到独立关系表，按 `(tenantId, 业务键, date)` 唯一。`prefillItems / growthProfitConfig / calcRun` 仍留 blob（是配置/结果，量小）。

```prisma
model DailyProductMetric {           // 商品源数据（分日）
  id          String   @id @default(cuid())
  tenantId    String
  productId   String
  date        DateTime @db.Date
  visitors    Int      @default(0)
  views       Int      @default(0)
  paymentAmount  Decimal @default(0)
  refundAmount   Decimal @default(0)
  paymentBuyers  Int     @default(0)
  // …ProductSourceRow 其余可加和/可重算字段
  @@unique([tenantId, productId, date])
  @@index([tenantId, date])
}

model DailyPromotionMetric {         // 推广宝贝（分日）
  // (tenantId, subjectId, date) + impressions/clicks/cost/roi…
  @@unique([tenantId, subjectId, date])
}

model DailyAudienceMetric {          // 人群（分日，取代 dateRange）
  // (tenantId, date, planId, audienceName, subjectId) + clicks/roi/guided…
}

model DailyDamoMetric {              // 达摩盘（新增 date 维度）
  // (tenantId, productId, date) + growthStage/ipv/marketingSpend…
  @@unique([tenantId, productId, date])
}

model Intervention {                 // 运营标记的"优化动作"（对比锚点）
  id          String   @id @default(cuid())
  tenantId    String
  date        DateTime @db.Date      // 动作发生日（分界点）
  title       String
  note        String   @default("")
  category    String   @default("")  // 预算/主图/价格/人群/详情… 可选
  productIds  Json                   // 受影响商品 id 数组（空=整店）
  createdBy   String
  createdAt   DateTime @default(now())
  @@index([tenantId, date])
}
```

可加和字段（金额/访客/点击/花费）按 SUM 聚合；比率字段（转化率/ROI/退款率）由聚合后的分子分母**重算**，不能直接平均；快照字段（growthStage）取窗口内最新值。

---

## 3. 导入升级

- 每次上传 = 多条分日记录 → **按 (业务键, date) upsert** 进对应日表（重传某区间只覆盖那些天，不清全部）→ 天然解决保留冲突。
- 达摩盘表加"日期"列识别；人群表从 `dateRange` 拆成单日。
- 校验沿用现有契约，额外提示识别到的日期范围（已有 `dateValues` 基础）。

## 4. 聚合层（分日 → 周期，喂现有算法）

新增 `aggregateForCycle(tenantId, startDate, endDate)`：把窗口内分日数据按商品聚合成"每商品一行"的快照（结构同现 `ProductSourceRow`/`DamoProductRow`），喂给**基本不动的**三阶算法。
→ 算法只改"输入从哪来"，核心逻辑保留。预填/利润配置不变。

---

## 5. 优化动作（运营手动标记）

- 运营在「数据导入」或新「经营复盘」页点"标记调整"：填**日期 + 标题 + 备注 + 受影响商品（可整店）+ 类别（可选）**。
- 落 `Intervention` 表。它就是前后对比的分界点，也作为管理视角的"动作时间轴"。
- 与现有「版本留痕」并存：版本=系统自动审计；干预=人工业务标注。

## 6. 对比引擎（三口径，可切换）

给定干预点日期 D、前窗 `[D-N, D-1]`、后窗 `[D+1, D+M]`（N/M 可调，默认 7）：

| 口径 | 内容 | 数据来源 |
|---|---|---|
| **A 真实经营 before/after** | 受影响商品在前后窗的：GMV、ROI、转化率、退款率、点击成本 等 delta 与百分比 | 分日表聚合两窗 |
| **B 计划 vs 实际** | 当时预填计划（预期GSV/预留毛利/可投费用）vs 动作后真实达成，看计划准度 | prefillItems/calcRun + 分日实际 |
| **C 整店汇总趋势** | 全店按天曲线（销额/ROI/转化），D 处标注动作竖线，看拐点 | 分日表按天 SUM |

UI：管理「经营复盘」页 = 干预时间轴 + 选中某动作 → 三口径切换视图（卡片 delta + 表 + 曲线）。

## 7. 页面 / UX

- **管理 → 新增「经营复盘」Tab**：动作时间轴；选动作看 A/B/C 三口径；整店每日趋势图。
- **数据导入**：支持多天文件（基本透明）+ "标记调整"入口。
- **看板**：可选加每日趋势迷你图。
- 预填/利润配置：不变。

## 8. 图表方案

引入轻量库 **Recharts**（React 友好、体积适中）；或纯 SVG 自绘折线（零依赖，省体积）。建议 Recharts 起步，趋势/对比柱线统一。

---

## 9. 分阶段计划（可逐段上线、各自可验证）

- **阶段 1 · 分日底座**：Prisma 加 4 张日表 + 迁移；导入改 upsert 分日；聚合层喂算法。验收：上传分日文件，三阶看板照常出数。
- **阶段 2 · 优化动作**：Intervention 表 + 标记 UI + 动作时间轴。验收：能标记/编辑/删除动作。
- **阶段 3 · 对比引擎**：A/B/C 三口径计算 + 「经营复盘」页。验收：选动作出三口径对比。
- **阶段 4 · 趋势图 + 打磨**：整店/单品每日曲线、Recharts 接入、性能与保留策略。

## 10. 迁移

- 现有 blob 里的 `uploadedSources`（已汇总单快照）→ 作为"周期最后一天"灌入日表，旧数据不丢、看板不断。
- 或标记为 legacy，下次上传起走新分日链路。二选一，建议前者平滑。

## 11. 容量复核（对上之前评估）

100 租户 × ~500 商品 × 保留 90 天 ≈ 450 万行/表，Postgres 按 `(tenant,product,date)` 索引轻松应对。配合"按租户保留 N 天/月"清理。4C/8G + 同机 Postgres 仍够。

---

## 待你确认的细节（动手前）
- 前后窗默认天数（建议各 7 天，可调）？
- 图表库用 Recharts 还是纯 SVG 自绘？
- 阶段 1 先做哪一类源数据的分日（建议先商品源，跑通再扩推广/人群/达摩）？
