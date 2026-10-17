import type { Lifecycle, ProductGrade, ProfitMarginMatrix } from "@/lib/types/domain";

/** Public labels and editable default margins shared by the configuration UI and server. */
export const lifecycleColumns: Lifecycle[] = [
  "冷启期",
  "新品成长期",
  "成长期",
  "新品打爆期",
  "爆品期",
  "平销期"
];

export const gradeRows: ProductGrade[] = ["S", "A", "B", "C"];

export const marginMatrix: ProfitMarginMatrix = {
  S: {
    冷启期: -0.2,
    新品成长期: -0.15,
    成长期: -0.1,
    新品打爆期: 0.05,
    爆品期: 0.1,
    平销期: 0.15
  },
  A: {
    冷启期: -0.15,
    新品成长期: -0.1,
    成长期: -0.05,
    新品打爆期: 0.05,
    爆品期: 0.1,
    平销期: 0.15
  },
  B: {
    冷启期: -0.05,
    新品成长期: 0,
    成长期: 0.05,
    新品打爆期: 0.1,
    爆品期: 0.15,
    平销期: 0.2
  },
  C: {
    冷启期: 0,
    新品成长期: 0.05,
    成长期: 0.1,
    新品打爆期: 0.1,
    爆品期: 0.15,
    平销期: 0.2
  }
};
