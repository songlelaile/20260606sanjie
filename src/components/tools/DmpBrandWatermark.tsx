import { DMP_AUTOMATION_BRAND } from "@/lib/dmp-product";

const WATERMARKS = Array.from({ length: 48 }, (_, index) => index);

export function DmpBrandWatermark() {
  return (
    <div className="dmp-brand-watermark" aria-hidden="true">
      {WATERMARKS.map((index) => <span key={index}>{DMP_AUTOMATION_BRAND}</span>)}
    </div>
  );
}
