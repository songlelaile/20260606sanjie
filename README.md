# 三阶引擎 V9 标准 SaaS

把 Excel 决策工具重建为标准多租户 SaaS 的 v0.1 工程骨架。

## 已实现

- Next.js + TypeScript 管理端页面：管理后台、数据导入、预填写表、综合看板、单品突破、人群计划、版本留痕。
- API 闭环：导入批次、导入校验、预填写更新、算法运行、三个看板、版本列表。
- 三阶算法：店为品投资、品为店贡献、人群投放计划。
- Postgres/Prisma 数据模型：tenant、user、shop、analysis cycle、import batch、prefill item、calc run、version snapshot。
- 黄金样例测试：对齐 V9 工作簿核心 KPI。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000/admin`。

## 验证

```bash
npm run typecheck
npm run test
npm run build
```

## 数据库

v0.1 页面和 API 使用内置黄金样例运行，便于在没有 Postgres 的环境中验证产品闭环。生产接入时使用 `prisma/schema.prisma`：

```bash
cp .env.example .env
npx prisma migrate dev --name init
```
