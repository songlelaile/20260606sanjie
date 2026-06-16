"use client";

import { CalendarRange, Save } from "lucide-react";
import { useState } from "react";

interface DailyRange {
  start: string;
  end: string;
  days: number;
}

export function DailyDataPanel({
  initialRange,
  initialRetentionDays
}: {
  initialRange: DailyRange | null;
  initialRetentionDays: number;
}) {
  const [range, setRange] = useState<DailyRange | null>(initialRange);
  const [days, setDays] = useState(initialRetentionDays);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/daily-retention", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days })
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { range: DailyRange | null; retentionDays: number; pruned: number }; error?: string }
      | null;
    setBusy(false);
    if (!response.ok || !payload?.data) {
      setMessage(payload?.error ?? "保存失败");
      return;
    }
    setRange(payload.data.range);
    setDays(payload.data.retentionDays);
    setMessage(
      payload.data.pruned > 0
        ? `已保存，按新策略清理了 ${payload.data.pruned} 行过旧明细`
        : "保留策略已保存"
    );
  }

  return (
    <section className="daily-data-panel">
      <div className="daily-data-head">
        <CalendarRange size={17} />
        <div>
          <strong>分日数据底座</strong>
          <span>
            {range
              ? `已收录 ${range.days} 天（${range.start} ~ ${range.end}）`
              : "暂无分日商品数据，上传商品源报表后在此累积"}
          </span>
        </div>
      </div>
      <div className="daily-data-retention">
        <label>
          保留最近
          <input
            type="number"
            min={0}
            max={3650}
            value={days}
            onChange={(event) => setDays(Math.max(0, Math.min(3650, Number(event.target.value) || 0)))}
          />
          天
        </label>
        <span className="daily-data-hint">0 = 永久保留；超出的更早明细在上传时自动清理</span>
        <button type="button" onClick={save} disabled={busy}>
          <Save size={15} />
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
      {message ? <p className="form-message">{message}</p> : null}
    </section>
  );
}
