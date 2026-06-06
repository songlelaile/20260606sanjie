#!/usr/bin/env python3
"""Three-stage engine worker boundary.

The Next.js app runs the TypeScript implementation for the v0.1 demo. This
worker mirrors the service boundary expected by production: JSON in, JSON out,
so it can be attached to a queue when Postgres and background jobs are enabled.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any


MARGIN_MATRIX = {
    "S": {"冷启期": -0.2, "新品成长期": -0.15, "成长期": -0.1, "新品打爆期": 0.05, "爆品期": 0.1, "平销期": 0.15},
    "A": {"冷启期": -0.15, "新品成长期": -0.1, "成长期": -0.05, "新品打爆期": 0.05, "爆品期": 0.1, "平销期": 0.15},
    "B": {"冷启期": -0.05, "新品成长期": 0, "成长期": 0.05, "新品打爆期": 0.1, "爆品期": 0.15, "平销期": 0.2},
    "C": {"冷启期": 0, "新品成长期": 0.05, "成长期": 0.1, "新品打爆期": 0.1, "爆品期": 0.15, "平销期": 0.2},
}


@dataclass
class WorkerResult:
    product_count: int
    monthly_net_sales: float
    monthly_profit_estimate: float
    monthly_gsv_opportunity: float
    available_ad_budget: float


def safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def run(payload: dict[str, Any]) -> WorkerResult:
    products = {row["productId"]: row for row in payload.get("productSourceRows", [])}
    damo = {row["productId"]: row for row in payload.get("damoProductRows", [])}
    prefill = payload.get("prefillItems", [])

    monthly_net_sales = 0.0
    monthly_profit_estimate = 0.0
    monthly_gsv_opportunity = 0.0
    available_ad_budget = 0.0

    for item in prefill:
        product = products.get(item["productId"], {})
        damo_row = damo.get(item["productId"], {})
        lifecycle = damo_row.get("growthStage", "冷启期")
        grade = item.get("grade", "C")
        attack_margin = MARGIN_MATRIX.get(grade, MARGIN_MATRIX["C"]).get(lifecycle, 0)
        net_sales = float(product.get("paymentAmount", 0) or 0) - float(product.get("refundAmount", 0) or 0)
        historical_profit = net_sales * float(item.get("grossMarginRate", 0) or 0) - float(damo_row.get("marketingSpend", 0) or 0)
        available_ad_budget += historical_profit - attack_margin * net_sales
        monthly_net_sales += net_sales
        monthly_profit_estimate += historical_profit
        monthly_gsv_opportunity += float(item.get("monthlyGsvOpportunity", 0) or 0)

    return WorkerResult(
        product_count=len(prefill),
        monthly_net_sales=monthly_net_sales,
        monthly_profit_estimate=monthly_profit_estimate,
        monthly_gsv_opportunity=monthly_gsv_opportunity,
        available_ad_budget=available_ad_budget,
    )


def main() -> None:
    payload = json.load(sys.stdin)
    result = run(payload)
    json.dump(result.__dict__, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
