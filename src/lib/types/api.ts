import type {
  AudiencePlanItem,
  CalcRun,
  ImportBatch,
  ManagementDashboard,
  PrefillItem,
  ProductBreakthroughResult,
  VersionSnapshot
} from "./domain";

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ImportBatchListResponse {
  batches: ImportBatch[];
}

export interface PrefillItemsResponse {
  items: PrefillItem[];
}

export interface CalcRunResponse {
  run: CalcRun;
}

export interface ManagementDashboardResponse {
  dashboard: ManagementDashboard;
}

export interface ProductBreakthroughDashboardResponse {
  items: ProductBreakthroughResult[];
}

export interface AudiencePlanDashboardResponse {
  items: AudiencePlanItem[];
}

export interface VersionListResponse {
  versions: VersionSnapshot[];
}
