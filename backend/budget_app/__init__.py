"""budget_app — 月度预算后端对账/结算包。

模块职责：
  money.py   整数分运算（与 TS 侧逐函数镜像）
  models.py  Pydantic v2 数据模型（与 TS 类型镜像）
  engine.py  核心计算引擎（与 TS engine.ts/reschedule.ts 镜像）
"""

from .engine import (  # noqa: F401
    BudgetSnapshot,
    DailyAllowancePlan,
    OverspendOption,
    OverspendPlan,
    build_gentle_message_facts,
    classify_overspend_level,
    compute_borrow_to_exit_floor,
    compute_snapshot,
    days_in_month,
    days_left_inclusive,
    plan_overspend_recovery,
    projected_carryover_cents,
    resolve_due_day,
    reschedule_daily_allowances,
)
from .models import (  # noqa: F401
    DailyTransaction,
    EngineConfig,
    FixedExpense,
    MonthlyBudget,
    SavingsGoal,
    SnapshotInput,
)
from .money import allocate, floor_div, format_display, round_half_away_from_zero  # noqa: F401

__all__ = [
    "BudgetSnapshot",
    "DailyAllowancePlan",
    "OverspendOption",
    "OverspendPlan",
    "build_gentle_message_facts",
    "classify_overspend_level",
    "compute_borrow_to_exit_floor",
    "compute_snapshot",
    "days_in_month",
    "days_left_inclusive",
    "plan_overspend_recovery",
    "projected_carryover_cents",
    "resolve_due_day",
    "reschedule_daily_allowances",
    "DailyTransaction",
    "EngineConfig",
    "FixedExpense",
    "MonthlyBudget",
    "SavingsGoal",
    "SnapshotInput",
    "allocate",
    "floor_div",
    "format_display",
    "round_half_away_from_zero",
]
