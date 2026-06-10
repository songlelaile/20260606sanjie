"use client";

import { RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  gradeRows,
  lifecycleColumns,
  marginMatrix
} from "@/lib/algorithm/three-stage";
import { decimalToPercentInput, percentInputToDecimal } from "@/lib/percent-input";
import type { GrowthProfitConfigRow, Lifecycle } from "@/lib/types/domain";

export function GrowthProfitConfigEditor({
  cycleId,
  initialConfig
}: {
  cycleId: string;
  initialConfig: GrowthProfitConfigRow[];
}) {
  const router = useRouter();
  const [config, setConfig] = useState(() => cloneConfig(initialConfig));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function updateValue(grade: GrowthProfitConfigRow["grade"], lifecycle: Lifecycle, value: number) {
    setConfig((current) =>
      current.map((row) =>
        row.grade === grade
          ? {
              ...row,
              values: {
                ...row.values,
                [lifecycle]: value
              }
            }
          : row
      )
    );
  }

  function resetToV9Default() {
    setConfig(buildDefaultConfig());
    setMessage("已恢复 V9 表格默认值，保存后生效");
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/growth-profit-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycleId, config })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(payload?.error ?? "保存失败");
        return;
      }
      // 保存后立即重算，让新的利润率矩阵进入看板口径
      await fetch("/api/calc-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycleId })
      });
      router.refresh();
      setMessage("已保存并重算，切换到看板即可看到按新利润率计算的结果。");
    } catch {
      setMessage("保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="table-panel growth-config-panel">
      <div className="panel-toolbar">
        <div>
          <strong>V9 增长利润配置</strong>
          <span>默认来自“盈利增长利润率对照表”，数字可调整，保存后用于三阶评估算法。</span>
        </div>
        <div className="panel-actions">
          <button type="button" className="ghost-button" onClick={resetToV9Default}>
            <RotateCcw size={16} />
            恢复默认
          </button>
          <button type="button" onClick={save} disabled={saving}>
            <Save size={16} />
            {saving ? "保存利润配置中" : "保存利润配置并重算"}
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="growth-config-table">
          <thead>
            <tr>
              <th>等级</th>
              {lifecycleColumns.map((lifecycle) => (
                <th key={lifecycle}>{lifecycle}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.map((row) => (
              <tr key={row.grade}>
                <td>
                  <strong>{row.grade}</strong>
                  <span>SAB 分层</span>
                </td>
                {lifecycleColumns.map((lifecycle) => (
                  <td key={lifecycle}>
                    <label className="percent-field">
                      <input
                        type="number"
                        step="0.1"
                        value={decimalToPercentInput(row.values[lifecycle])}
                        onChange={(event) =>
                          updateValue(row.grade, lifecycle, percentInputToDecimal(event.target.value))
                        }
                        aria-label={`${row.grade}级 ${lifecycle} 增长利润率`}
                      />
                      <span>%</span>
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className="form-message success">{message}</p> : null}
    </section>
  );
}

function buildDefaultConfig() {
  return gradeRows.map((grade) => ({
    grade,
    values: Object.fromEntries(
      lifecycleColumns.map((lifecycle) => [lifecycle, marginMatrix[grade][lifecycle]])
    ) as GrowthProfitConfigRow["values"]
  }));
}

function cloneConfig(config: GrowthProfitConfigRow[]) {
  return config.map((row) => ({
    grade: row.grade,
    values: { ...row.values }
  }));
}
