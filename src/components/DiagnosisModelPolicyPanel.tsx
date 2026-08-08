import { BadgeCheck, CircleDashed, FlaskConical, ShieldOff } from "lucide-react";
import type { ModelAdmissionDecision } from "@/lib/model-admission/evaluate";

const MODE_LABEL: Record<ModelAdmissionDecision["mode"], string> = {
  direct: "直接证据",
  proxy: "代理候选",
  qualitative: "结构化归纳",
  disabled: "未准入"
};

export function DiagnosisModelPolicyPanel({
  decisions,
  title = "诊断模型准入",
  description = "模型先过证据门槛再输出；代理信号只能排序和设计验证，不能直接释放预算。"
}: {
  decisions: ModelAdmissionDecision[];
  title?: string;
  description?: string;
}) {
  const defaultModels = decisions.filter(
    (item) => item.portfolio !== "conditional" && item.portfolio !== "retire"
  );
  const conditionalModels = decisions.filter((item) => item.portfolio === "conditional");
  const retiredModels = decisions.filter((item) => item.portfolio === "retire");

  return (
    <section className="diagnosis-policy-panel">
      <header className="diagnosis-policy-heading">
        <div>
          <strong><BadgeCheck size={17} /> {title}</strong>
          <span>{description}</span>
        </div>
        <div className="diagnosis-policy-counts">
          <span>{defaultModels.filter((item) => item.mode !== "disabled").length} 个已运行</span>
          <span>{conditionalModels.filter((item) => item.mode === "disabled").length} 个待解锁</span>
        </div>
      </header>

      <div className="diagnosis-policy-grid">
        {defaultModels.map((item) => (
          <ModelDecisionCard decision={item} key={item.modelId} />
        ))}
      </div>

      <details className="diagnosis-policy-conditional">
        <summary>
          <FlaskConical size={16} /> 条件模型包
          <span>有直接数据才解锁，不再用经营代理指标自动评分</span>
        </summary>
        <div className="diagnosis-policy-grid is-conditional">
          {conditionalModels.map((item) => (
            <ModelDecisionCard decision={item} key={item.modelId} />
          ))}
        </div>
      </details>

      {retiredModels.length > 0 ? (
        <div className="diagnosis-policy-retired">
          <ShieldOff size={15} />
          <div>
            <strong>已停用的自动推断</strong>
            <span>{retiredModels.map((item) => item.displayName).join("、")}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ModelDecisionCard({ decision }: { decision: ModelAdmissionDecision }) {
  const missing = decision.requiredData.slice(0, 3);
  return (
    <article className={`diagnosis-policy-card is-${decision.mode}`}>
      <header>
        <strong>{decision.displayName}</strong>
        <span>{MODE_LABEL[decision.mode]} · {decision.confidence.score}%</span>
      </header>
      <p>{decision.summary}</p>
      {decision.mode === "disabled" ? (
        <div className="diagnosis-policy-missing">
          <CircleDashed size={14} />
          <span>{missing.length > 0 ? `待补：${missing.join("、")}` : "当前实现已退出默认诊断"}</span>
        </div>
      ) : (
        <div className="diagnosis-policy-boundary">
          <span>能证明：{decision.canProve[0] ?? "仅做结构化提示"}</span>
          <span>不能证明：{decision.cannotProve[0] ?? "不扩展证据等级"}</span>
        </div>
      )}
    </article>
  );
}

