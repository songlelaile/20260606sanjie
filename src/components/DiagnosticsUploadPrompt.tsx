import Link from "next/link";
import { UploadCloud } from "lucide-react";

export function DiagnosticsUploadPrompt({
  title = "暂无诊断数据",
  description = "上传并计算源表后，系统会展示诊断模型和优化策略。"
}: {
  title?: string;
  description?: string;
}) {
  return (
    <section className="diagnostics-empty-prompt">
      <div>
        <strong>
          <UploadCloud size={18} />
          {title}
        </strong>
        <span>{description}</span>
      </div>
      <Link href="/imports" prefetch={false}>
        上传数据
      </Link>
    </section>
  );
}

