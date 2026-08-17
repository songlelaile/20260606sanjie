# 达摩盘报告表格版 XLSX 隐藏导出契约

该能力只面向数据库当前有效的平台管理员，并且账号必须仍处于达摩盘 30 天授权有效期内。普通租户不展示入口；Capability 只用于界面显示，不能替代点击导出时的服务端实时校验。

## 1. 显示入口

插件沿用现有跨域登录校验：

```http
GET /api/auth/me
x-sanjie-session: <signed session cookie value>
```

只有同时满足以下条件时，响应中的 `data.capabilities.dmpReportExport` 才为 `true`：

- 会话签名与有效期正确；
- 数据库账号存在、未禁用，且租户和登录角色仍与会话一致；
- 数据库 `authRole` 为 `admin`；
- `dmp-automation` entitlement 为 active 且尚未到期。

既有 `dmpJsonImport` 字段保持不变，不可用它代替 XLSX 导出 capability。

## 2. 点击时实时授权并写审计

插件先保证报告已经成功归档并取得 `reportId`，再发送：

```http
POST /api/dmp-report-exports
Content-Type: application/json
x-sanjie-session: <signed session cookie value>

{
  "reportId": "<archived report id>",
  "reportType": "growth",
  "format": "xlsx",
  "clientVersion": "2.1.3"
}
```

`reportType` 仅允许 `growth` 或 `competition`；`format` 固定为 `xlsx`。请求严格只允许 `reportId/reportType/format/clientVersion` 四个字段，携带报告 JSON、表格、单元格或其它额外字段会返回 400。

成功响应：

```json
{
  "data": {
    "authorization": {
      "authorized": true,
      "auditId": "<audit id>",
      "authorizedAt": "2026-08-17T08:30:00.000Z"
    }
  }
}
```

插件必须同时确认 HTTP 201 和 `data.authorization.authorized === true`，之后才能在本地生成 XLSX。其它响应均不得继续导出：

- 400：字段、报告类型或固定格式无效；
- 401：会话无效，或 DMP 授权未开通、已撤销、已过期；
- 403：数据库有效账号不是平台管理员；
- 404：报告不存在，或不属于当前管理员账号与租户；
- 409：请求声明的报告类型与已归档报告实际类型不一致；
- 503：实时校验或审计落库不可用。

## 3. 审计边界

成功授权与审计写入位于同一数据库事务中。`DmpReportExportAudit` 只保存：

- `adminId`
- `reportId`
- `reportType`
- `format`（固定 `xlsx`）
- `clientVersion`
- `exportedAt`

审计表不保存报告 JSON、业务单元格、商品数据、文件名或导出文件。审计记录故意不设账号/报告的级联删除外键，避免账号或报告删除后历史审计一并消失。
