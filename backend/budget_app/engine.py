"""engine.py — 核心计算引擎（后端镜像实现）。

与 packages/core/src/engine.ts 逐函数镜像，用于：
  1. **对账**：端侧离线算出的数字上报后端后，后端独立重算并比对（差异即上报埋点）。
  2. **月度结算**：跨月结转、账单入账、报表生成这些只有服务端能做的事。
  3. **服务端渲染**：通知、邮件、Widget 快照服务。

两端的数字必须完全一致，由 fixtures/golden_cases.json + tests/test_engine.py 保证。
公式链与 TS 完全相同，见 docs/architecture.md。
"""

from __future__ import annotations

import calendar
import datetime as _dt
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from .models import (
    DailyTransaction,
    EngineConfig,
    FixedExpense,
    MonthlyBudget,
    SavingsGoal,
    SnapshotInput,
)
from .money import Cents, allocate, floor_div, round_half_away_from_zero, sum_cents

# ---------------------------------------------------------------------------
# 日历工具（与 calendar.ts 镜像；全部以「本地自然日字符串」为键，ADR-002）
# ---------------------------------------------------------------------------


def parse_month(month: str) -> tuple[int, int]:
    year_text, month_text = month.split("-")
    return int(year_text), int(month_text)


def days_in_month(month: str) -> int:
    year, month_number = parse_month(month)
    return calendar.monthrange(year, month_number)[1]


def month_of(date: str) -> str:
    return date[:7]


def day_of_month(date: str) -> int:
    return int(date[8:10])


def _to_date(date: str) -> _dt.date:
    year, month_number, day = (int(part) for part in date.split("-"))
    return _dt.date(year, month_number, day)


def _to_iso(value: _dt.date) -> str:
    return value.isoformat()


def diff_days(start: str, end: str) -> int:
    """end - start，单位天。"""
    return (_to_date(end) - _to_date(start)).days


def add_days(date: str, days: int) -> str:
    return _to_iso(_to_date(date) + _dt.timedelta(days=days))


def days_left_inclusive(month: str, today: str) -> int:
    """本月剩余天数（含今天）—— DailySafeToSpend 的分母。"""
    left = days_in_month(month) - day_of_month(today) + 1
    return max(left, 0)


def resolve_due_day(month: str, due_day) -> str:
    """把 1-31 / 'month_end' 解析成具体日期；2 月 31 号会被夹到 2/28 或 2/29。"""
    total = days_in_month(month)
    if due_day == "month_end":
        day = total
    else:
        day = min(max(int(due_day), 1), total)
    return f"{month}-{day:02d}"


def clamp_iso(value: str, low: str, high: str) -> str:
    return min(max(value, low), high)


# ---------------------------------------------------------------------------
# 结果结构
# ---------------------------------------------------------------------------


@dataclass
class FixedBreakdown:
    paid_cents: Cents = 0
    reserved_cents: Cents = 0
    skipped_cents: Cents = 0
    due_soon: List[Dict[str, object]] = field(default_factory=list)


@dataclass
class SpendingBreakdown:
    flex_spent_cents: Cents = 0
    necessary_cents: Cents = 0
    optional_cents: Cents = 0
    unclassified_cents: Cents = 0
    refund_cents: Cents = 0
    off_budget_cents: Cents = 0
    pending_cents: Cents = 0
    future_scheduled_cents: Cents = 0
    today_spent_cents: Cents = 0
    pace_spent_cents: Cents = 0
    big_ticket_count: int = 0


@dataclass
class AmortizationEntry:
    transaction_id: str
    amount_cents: Cents
    purchase_date: str
    spread_days: int
    daily_drag_cents: Cents
    charged_so_far_cents: Cents
    pending_amortization_cents: Cents


@dataclass
class BudgetSnapshot:
    month: str
    today: str
    total_days: int
    elapsed_days: int
    days_left: int
    income_cents: Cents
    carryover_cents: Cents
    fixed: FixedBreakdown
    hard_expense_cents: Cents
    savings_cents: Cents
    committed_cents: Cents
    discretionary_cents: Cents
    spent_cents: Cents
    remaining_cents: Cents
    baseline_cents: Cents
    live_baseline_cents: Cents
    floor_cents: Cents
    safe_to_spend_cents: Cents
    today_spent_cents: Cents
    today_remaining_cents: Cents
    month_end_adjustment_cents: Cents
    pace_ratio: float
    time_ratio: float
    pace_gap: float
    pace_spent_cents: Cents
    projected_month_end_remaining_cents: Cents
    state: str
    spending: SpendingBreakdown
    amortization: List[AmortizationEntry] = field(default_factory=list)

    # TS 侧字段名 today（复盘时被夹到月末），保持一致
    @property
    def days_in_month(self) -> int:
        return self.total_days


# ---------------------------------------------------------------------------
# 固定开销与存款
# ---------------------------------------------------------------------------


def effective_fixed_cents(expense: FixedExpense) -> Cents:
    """预留/实付/跳过三态口径：跳过或停用 → 0（钱释放回可支配）。"""
    if not expense.active or expense.status == "skipped":
        return 0
    return expense.actual_cents if expense.actual_cents is not None else expense.estimated_cents


def sum_hard_expenses(expenses: Sequence[FixedExpense]) -> Cents:
    return sum_cents([effective_fixed_cents(e) for e in expenses])


def resolve_savings_target_cents(goal: SavingsGoal, income_cents: Cents) -> Cents:
    if goal.status == "skipped":
        return 0
    if goal.method == "percent":
        return floor_div(int(income_cents * float(goal.percent or 0)), 100)
    return goal.target_cents


def sum_savings_cents(goals: Sequence[SavingsGoal], income_cents: Cents) -> Cents:
    return sum_cents([resolve_savings_target_cents(g, income_cents) for g in goals])


def find_fixed_due_soon(
    expenses: Sequence[FixedExpense], month: str, today: str, within_days: int = 3
) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    for expense in expenses:
        if not expense.active or expense.status != "reserved":
            continue
        due_date = resolve_due_day(month, expense.due_day)
        delta = diff_days(today, due_date)
        if 0 <= delta <= within_days:
            out.append(
                {
                    "id": expense.id,
                    "name": expense.name,
                    "amount_cents": effective_fixed_cents(expense),
                    "due_date": due_date,
                }
            )
    return sorted(out, key=lambda item: str(item["due_date"]))


def big_ticket_threshold_cents(baseline_cents: Cents, config: EngineConfig) -> Cents:
    """单笔 ≥ big_ticket_ratio × 日基线即视为大额。基线为 0 时返回哨兵，避免全部命中。"""
    if baseline_cents <= 0:
        return 2**53 - 1
    return int(baseline_cents * config.big_ticket_ratio)


def is_big_ticket(tx: DailyTransaction, threshold_cents: Cents) -> bool:
    if tx.amount_cents <= 0:
        return False
    return bool(tx.is_big_ticket) or tx.amount_cents >= threshold_cents


# ---------------------------------------------------------------------------
# 大额摊销（ADR-006）：真实余额立刻扣，节奏口径按日摊
# ---------------------------------------------------------------------------


def amortized_charge_cents(tx: DailyTransaction, month: str, today: str) -> Cents:
    if month_of(tx.local_date) != month:
        return tx.amount_cents
    spread_days = days_left_inclusive(month, tx.local_date)
    if spread_days <= 0:
        return tx.amount_cents
    elapsed = diff_days(tx.local_date, today)
    if elapsed < 0:
        return 0
    taken = min(spread_days, elapsed + 1)
    shares = allocate(tx.amount_cents, spread_days)
    return sum_cents(shares[:taken])


def build_amortization_plan(
    transactions: Sequence[DailyTransaction], month: str, today: str, threshold_cents: Cents
) -> List[AmortizationEntry]:
    entries: List[AmortizationEntry] = []
    for tx in transactions:
        if not is_big_ticket(tx, threshold_cents) or not tx.amortize:
            continue
        if tx.status != "settled" or tx.deleted_at:
            continue
        if tx.scope != "flex":  # 预算外交易不进弹性池，也不参与摊销
            continue
        if month_of(tx.local_date) != month:
            continue
        if tx.local_date > today:  # 未来日期不作为「已发生的大额」
            continue
        spread_days = max(days_left_inclusive(month, tx.local_date), 1)
        shares = allocate(tx.amount_cents, spread_days)
        charged = amortized_charge_cents(tx, month, today)
        entries.append(
            AmortizationEntry(
                transaction_id=tx.id,
                amount_cents=tx.amount_cents,
                purchase_date=tx.local_date,
                spread_days=spread_days,
                daily_drag_cents=shares[0],
                charged_so_far_cents=charged,
                pending_amortization_cents=tx.amount_cents - charged,
            )
        )
    return sorted(entries, key=lambda entry: entry.purchase_date)


# ---------------------------------------------------------------------------
# 消费归集
# ---------------------------------------------------------------------------


def dedupe_by_idempotency_key(
    transactions: Sequence[DailyTransaction],
) -> List[DailyTransaction]:
    """离线补传去重：同一幂等键只保留第一次出现的记录。"""
    seen: set[str] = set()
    out: List[DailyTransaction] = []
    for tx in transactions:
        if tx.idempotency_key in seen:
            continue
        seen.add(tx.idempotency_key)
        out.append(tx)
    return out


def collect_spending(
    transactions: Sequence[DailyTransaction],
    month: str,
    effective_today: str,
    threshold_cents: Cents,
) -> SpendingBreakdown:
    all_tx = dedupe_by_idempotency_key(transactions)
    live = [
        tx
        for tx in all_tx
        if month_of(tx.local_date) == month and tx.status == "settled" and not tx.deleted_at
    ]

    breakdown = SpendingBreakdown()
    for tx in live:
        # 时点语义：日期晚于 today 的交易不计入已花（保证历史可重放一致）
        if tx.local_date > effective_today:
            breakdown.future_scheduled_cents += tx.amount_cents
            continue
        if tx.scope == "off_budget":
            breakdown.off_budget_cents += tx.amount_cents
            continue

        breakdown.flex_spent_cents += tx.amount_cents
        if tx.amount_cents < 0:
            breakdown.refund_cents += -tx.amount_cents
        if tx.necessity == "necessary":
            breakdown.necessary_cents += tx.amount_cents
        elif tx.necessity == "optional":
            breakdown.optional_cents += tx.amount_cents
        else:
            breakdown.unclassified_cents += tx.amount_cents

        if tx.local_date == effective_today:
            breakdown.today_spent_cents += tx.amount_cents

        if is_big_ticket(tx, threshold_cents) and tx.amortize:
            breakdown.big_ticket_count += 1
            breakdown.pace_spent_cents += amortized_charge_cents(tx, month, effective_today)
        else:
            breakdown.pace_spent_cents += tx.amount_cents

    breakdown.pending_cents = sum(
        tx.amount_cents
        for tx in all_tx
        if month_of(tx.local_date) == month and tx.status == "pending" and not tx.deleted_at
    )
    return breakdown


def resolve_config(config: Optional[EngineConfig]) -> EngineConfig:
    return config if config is not None else EngineConfig()


def compute_snapshot(snapshot_input: SnapshotInput) -> BudgetSnapshot:
    config = resolve_config(snapshot_input.config)
    budget = snapshot_input.budget
    month = budget.month

    total_days = days_in_month(month)
    first_day = f"{month}-01"
    last_day = resolve_due_day(month, "month_end")

    # 「今天」夹在本月内：月初前→按月初；月末后（对账/复盘）→按月末。days_left 恒 ≥ 1。
    effective_today = clamp_iso(snapshot_input.today, first_day, last_day)
    elapsed_days = min(max(diff_days(first_day, effective_today) + 1, 1), total_days)
    days_left = total_days - elapsed_days + 1

    active_fixed = [e for e in snapshot_input.fixed_expenses if e.active]
    hard_expense_cents = sum_hard_expenses(active_fixed)
    fixed = FixedBreakdown(
        paid_cents=sum_cents(
            [effective_fixed_cents(e) for e in active_fixed if e.status == "paid"]
        ),
        reserved_cents=sum_cents(
            [effective_fixed_cents(e) for e in active_fixed if e.status == "reserved"]
        ),
        skipped_cents=sum_cents(
            [
                e.actual_cents if e.actual_cents is not None else e.estimated_cents
                for e in snapshot_input.fixed_expenses
                if (not e.active) or e.status == "skipped"
            ]
        ),
        due_soon=find_fixed_due_soon(active_fixed, month, effective_today),
    )

    savings_cents = sum_savings_cents(snapshot_input.savings_goals, budget.income_cents)

    committed_cents = hard_expense_cents + savings_cents
    discretionary_cents = budget.income_cents + budget.carryover_cents - committed_cents

    baseline_cents = floor_div(discretionary_cents, total_days) if discretionary_cents > 0 else 0
    floor_cents = int(baseline_cents * config.floor_ratio)
    threshold_cents = big_ticket_threshold_cents(baseline_cents, config)

    spending = collect_spending(
        snapshot_input.transactions, month, effective_today, threshold_cents
    )
    spent_cents = spending.flex_spent_cents
    remaining_cents = discretionary_cents - spent_cents

    live_baseline_cents = floor_div(remaining_cents, days_left) if remaining_cents > 0 else 0
    pace_ratio = (
        spending.pace_spent_cents / discretionary_cents if discretionary_cents > 0 else 0.0
    )
    time_ratio = elapsed_days / total_days
    pace_gap = pace_ratio - time_ratio

    safe_to_spend_cents = 0
    month_end_adjustment_cents = 0

    if discretionary_cents <= 0 and spent_cents <= 0:
        state = "onboarding"
    elif remaining_cents <= 0:
        state = "overdrawn"
    elif floor_cents <= 0 or live_baseline_cents >= floor_cents:
        safe_to_spend_cents = live_baseline_cents
        state = "watch" if pace_gap > config.pace_tolerance else "healthy"
    else:
        # 保底模式：展示 floor 维持行动力，缺口显式账单化到下月
        safe_to_spend_cents = floor_cents
        month_end_adjustment_cents = remaining_cents - floor_cents * days_left
        state = "smoothed"

    avg_daily_spend_rate = floor_div(max(spent_cents, 0), elapsed_days)
    projected = remaining_cents - avg_daily_spend_rate * days_left

    return BudgetSnapshot(
        month=month,
        today=effective_today,
        total_days=total_days,
        elapsed_days=elapsed_days,
        days_left=days_left,
        income_cents=budget.income_cents,
        carryover_cents=budget.carryover_cents,
        fixed=fixed,
        hard_expense_cents=hard_expense_cents,
        savings_cents=savings_cents,
        committed_cents=committed_cents,
        discretionary_cents=discretionary_cents,
        spent_cents=spent_cents,
        remaining_cents=remaining_cents,
        baseline_cents=baseline_cents,
        live_baseline_cents=live_baseline_cents,
        floor_cents=floor_cents,
        safe_to_spend_cents=safe_to_spend_cents,
        today_spent_cents=spending.today_spent_cents,
        today_remaining_cents=safe_to_spend_cents - spending.today_spent_cents,
        month_end_adjustment_cents=month_end_adjustment_cents,
        pace_ratio=pace_ratio,
        time_ratio=time_ratio,
        pace_gap=pace_gap,
        pace_spent_cents=spending.pace_spent_cents,
        projected_month_end_remaining_cents=projected,
        state=state,
        spending=spending,
        amortization=build_amortization_plan(
            snapshot_input.transactions, month, effective_today, threshold_cents
        ),
    )


# ---------------------------------------------------------------------------
# 异常处理：额度重排、补救方案、跨月结转
# ---------------------------------------------------------------------------


@dataclass
class DailyAllowancePlan:
    date: str
    allowance_cents: Cents
    remaining_after_cents: Cents
    floor_protected: bool


@dataclass
class OverspendOption:
    code: str
    viable: bool
    label_key: str
    resulting_daily_cents: Cents
    resulting_remaining_cents: Cents
    resulting_next_month_carryover_cents: Cents
    cost_key: str
    cost_facts: Dict[str, object] = field(default_factory=dict)


@dataclass
class OverspendPlan:
    level: str
    state: str
    days_left: int
    remaining_cents: Cents
    current_daily_cents: Cents
    required_daily_cents: Cents
    pace_ratio_pct: int
    time_ratio_pct: int
    month_end_adjustment_cents: Cents
    shortfall_cents: Cents
    schedule: List[DailyAllowancePlan]
    options: List[OverspendOption]


def classify_overspend_level(snapshot: BudgetSnapshot, config: Optional[EngineConfig] = None) -> str:
    cfg = resolve_config(config)
    if snapshot.state == "onboarding":
        return "none"
    if snapshot.remaining_cents <= 0:
        return "critical"
    if snapshot.state == "smoothed":
        return "severe"
    if snapshot.pace_gap > cfg.pace_tolerance:
        return "minor"
    if snapshot.safe_to_spend_cents > 0 and snapshot.today_spent_cents > snapshot.safe_to_spend_cents:
        return "minor"
    return "none"


def reschedule_daily_allowances(
    snapshot: BudgetSnapshot, horizon_days: int = 7
) -> List[DailyAllowancePlan]:
    """把剩余额度均摊到未来每一天；保底模式下每天固定给 floor，代价是累计缺口。"""
    horizon = max(1, min(horizon_days, snapshot.days_left))
    available = max(snapshot.remaining_cents, 0)

    if snapshot.state in ("onboarding", "overdrawn"):
        return [
            DailyAllowancePlan(
                date=add_days(snapshot.today, i),
                allowance_cents=0,
                remaining_after_cents=snapshot.remaining_cents,
                floor_protected=False,
            )
            for i in range(horizon)
        ]

    floor_protected = snapshot.state == "smoothed" and snapshot.floor_cents > 0
    if floor_protected:
        shares = [snapshot.floor_cents] * snapshot.days_left
    else:
        shares = allocate(available, snapshot.days_left)

    out: List[DailyAllowancePlan] = []
    cumulative = 0
    for i in range(horizon):
        cumulative += shares[i]
        out.append(
            DailyAllowancePlan(
                date=add_days(snapshot.today, i),
                allowance_cents=shares[i],
                remaining_after_cents=available - cumulative,
                floor_protected=floor_protected,
            )
        )
    return out


def next_month_carryover_from_snapshot(
    snapshot: BudgetSnapshot, config: Optional[EngineConfig] = None
) -> Cents:
    cfg = resolve_config(config)
    remaining = snapshot.remaining_cents
    if remaining > 0:
        return remaining if cfg.carryover_policy == "carry" else 0
    if remaining < 0:
        return 0 if cfg.carryover_policy == "reset" else remaining
    return 0


def projected_carryover_cents(
    snapshot: BudgetSnapshot, config: Optional[EngineConfig] = None
) -> Cents:
    if snapshot.state == "smoothed":
        return snapshot.month_end_adjustment_cents
    plan = next_month_carryover_from_snapshot(snapshot, config)
    return min(plan, snapshot.projected_month_end_remaining_cents)


# ---------------------------------------------------------------------------
# 输入变形工具（不可变，返回新对象）
# ---------------------------------------------------------------------------


def with_transaction_scope(
    snapshot_input: SnapshotInput,
    transaction_id: str,
    scope: str,
    off_budget_reason: Optional[str] = None,
) -> SnapshotInput:
    transactions = []
    for tx in snapshot_input.transactions:
        if tx.id == transaction_id:
            transactions.append(
                tx.model_copy(
                    update={
                        "scope": scope,
                        "off_budget_reason": (
                            off_budget_reason or tx.off_budget_reason
                            if scope == "off_budget"
                            else None
                        ),
                    }
                )
            )
        else:
            transactions.append(tx)
    return snapshot_input.model_copy(update={"transactions": transactions})


def with_fixed_skipped(snapshot_input: SnapshotInput, ids: Sequence[str]) -> SnapshotInput:
    target = set(ids)
    expenses = [
        e.model_copy(update={"status": "skipped"}) if e.id in target else e
        for e in snapshot_input.fixed_expenses
    ]
    return snapshot_input.model_copy(update={"fixed_expenses": expenses})


def with_savings_reduced(snapshot_input: SnapshotInput, borrow_cents: Cents) -> SnapshotInput:
    """按顺序从各存款目标中削减 borrow_cents（等价于「先向储蓄借，下月归还」）。"""
    left = borrow_cents
    goals: List[SavingsGoal] = []
    for goal in snapshot_input.savings_goals:
        target = resolve_savings_target_cents(goal, snapshot_input.budget.income_cents)
        if left <= 0 or target <= 0 or goal.status == "skipped":
            goals.append(goal)
            continue
        cut = min(target, left)
        left -= cut
        goals.append(
            goal.model_copy(
                update={"method": "fixed", "percent": None, "target_cents": target - cut}
            )
        )
    return snapshot_input.model_copy(update={"savings_goals": goals})


def compute_borrow_to_exit_floor(snapshot_input: SnapshotInput, max_iterations: int = 12) -> Cents:
    """求解让真值日均回到 floor 之上所需的最小借入额。

    这是**不动点问题**：借入 X → F'=F+X → 日基线 B'=F'/N 变大 → floor' 也变大。
    例：F=¥6,000、已花 ¥4,800、剩 11 天 → 朴素缺口 ¥120，实际需要借 ¥153.77。
    """
    borrow = 0
    for _ in range(max_iterations):
        candidate = (
            snapshot_input if borrow == 0 else with_savings_reduced(snapshot_input, borrow)
        )
        after = compute_snapshot(candidate)
        if after.state != "smoothed":
            return borrow
        gap = max(after.floor_cents * after.days_left - max(after.remaining_cents, 0), 0)
        if gap <= 0:
            return borrow
        borrow += gap
    return borrow


def plan_overspend_recovery(
    snapshot_input: SnapshotInput,
    trigger_transaction_id: Optional[str] = None,
    savings_borrowable_cents: Cents = 0,
    skippable_fixed_ids: Sequence[str] = (),
    horizon_days: int = 7,
) -> OverspendPlan:
    """超支重排总入口：产出「重建后的健康额度」+ 给用户的 3 个可执行选择。"""
    config = resolve_config(snapshot_input.config)
    snapshot = compute_snapshot(snapshot_input)
    level = classify_overspend_level(snapshot, config)

    available = max(snapshot.remaining_cents, 0)
    shortfall_cents = max(snapshot.floor_cents * snapshot.days_left - available, 0)

    smooth_carry = (
        snapshot.month_end_adjustment_cents
        if snapshot.state == "smoothed"
        else projected_carryover_cents(snapshot, config)
    )

    # 选项 ①：接受保底模式（默认推荐）
    options: List[OverspendOption] = [
        OverspendOption(
            code="accept_smoothed",
            viable=True,
            label_key="option.accept_smoothed",
            resulting_daily_cents=snapshot.safe_to_spend_cents,
            resulting_remaining_cents=snapshot.remaining_cents,
            resulting_next_month_carryover_cents=smooth_carry,
            cost_key="cost.carryover_next_month" if smooth_carry < 0 else "cost.no_cost",
            cost_facts={
                "carryover_cents": smooth_carry,
                "days_left": snapshot.days_left,
                "daily_cents": snapshot.safe_to_spend_cents,
            },
        )
    ]

    # 选项 ②：向储蓄借（下月自动归还）。借入额解不动点，不能直接用朴素缺口。
    borrow_required = compute_borrow_to_exit_floor(snapshot_input)
    if borrow_required > 0 and savings_borrowable_cents >= borrow_required:
        after = compute_snapshot(with_savings_reduced(snapshot_input, borrow_required))
        options.append(
            OverspendOption(
                code="borrow_from_savings",
                viable=True,
                label_key="option.borrow_from_savings",
                resulting_daily_cents=after.safe_to_spend_cents,
                resulting_remaining_cents=after.remaining_cents,
                resulting_next_month_carryover_cents=-borrow_required,
                cost_key="cost.savings_repay_next_month",
                cost_facts={
                    "borrow_cents": borrow_required,
                    "naive_shortfall_cents": shortfall_cents,
                    "repay_months": 1,
                },
            )
        )
    else:
        options.append(
            OverspendOption(
                code="borrow_from_savings",
                viable=False,
                label_key="option.borrow_from_savings",
                resulting_daily_cents=snapshot.safe_to_spend_cents,
                resulting_remaining_cents=snapshot.remaining_cents,
                resulting_next_month_carryover_cents=smooth_carry,
                cost_key="cost.savings_not_enough",
                cost_facts={
                    "borrowable_cents": savings_borrowable_cents,
                    "shortfall_cents": shortfall_cents,
                    "borrow_required_cents": borrow_required,
                },
            )
        )

    # 选项 ③：把这笔大额标记为「预算外」
    trigger = next(
        (tx for tx in snapshot_input.transactions if tx.id == trigger_transaction_id), None
    )
    if trigger is not None and trigger.scope == "flex":
        after = compute_snapshot(
            with_transaction_scope(snapshot_input, trigger.id, "off_budget", "overspend_recovery")
        )
        options.append(
            OverspendOption(
                code="mark_off_budget",
                viable=True,
                label_key="option.mark_off_budget",
                resulting_daily_cents=after.safe_to_spend_cents,
                resulting_remaining_cents=after.remaining_cents,
                resulting_next_month_carryover_cents=projected_carryover_cents(after, config),
                cost_key="cost.off_budget_recorded",
                cost_facts={"amount_cents": trigger.amount_cents},
            )
        )
    else:
        options.append(
            OverspendOption(
                code="mark_off_budget",
                viable=False,
                label_key="option.mark_off_budget",
                resulting_daily_cents=snapshot.safe_to_spend_cents,
                resulting_remaining_cents=snapshot.remaining_cents,
                resulting_next_month_carryover_cents=smooth_carry,
                cost_key="cost.no_trigger_transaction",
            )
        )

    # 选项 ④：重排固定项（停掉可跳过的订阅一个月）
    skippable = [
        fid
        for fid in skippable_fixed_ids
        if any(
            e.id == fid and e.active and e.status != "skipped"
            for e in snapshot_input.fixed_expenses
        )
    ]
    if skippable:
        after = compute_snapshot(with_fixed_skipped(snapshot_input, skippable))
        options.append(
            OverspendOption(
                code="rebalance_fixed",
                viable=True,
                label_key="option.rebalance_fixed",
                resulting_daily_cents=after.safe_to_spend_cents,
                resulting_remaining_cents=after.remaining_cents,
                resulting_next_month_carryover_cents=projected_carryover_cents(after, config),
                cost_key="cost.fixed_skipped",
                cost_facts={
                    "skipped_count": len(skippable),
                    "released_cents": after.discretionary_cents - snapshot.discretionary_cents,
                    "freed_daily_cents": after.safe_to_spend_cents - snapshot.safe_to_spend_cents,
                },
            )
        )
    else:
        options.append(
            OverspendOption(
                code="rebalance_fixed",
                viable=False,
                label_key="option.rebalance_fixed",
                resulting_daily_cents=snapshot.safe_to_spend_cents,
                resulting_remaining_cents=snapshot.remaining_cents,
                resulting_next_month_carryover_cents=smooth_carry,
                cost_key="cost.no_skippable_fixed",
            )
        )

    return OverspendPlan(
        level=level,
        state=snapshot.state,
        days_left=snapshot.days_left,
        remaining_cents=snapshot.remaining_cents,
        current_daily_cents=snapshot.safe_to_spend_cents,
        required_daily_cents=snapshot.live_baseline_cents,
        pace_ratio_pct=round_half_away_from_zero(snapshot.pace_ratio * 100),
        time_ratio_pct=round_half_away_from_zero(snapshot.time_ratio * 100),
        month_end_adjustment_cents=snapshot.month_end_adjustment_cents,
        shortfall_cents=shortfall_cents,
        schedule=reschedule_daily_allowances(snapshot, horizon_days),
        options=options,
    )


def build_gentle_message_facts(
    snapshot: BudgetSnapshot, plan: OverspendPlan
) -> Dict[str, Cents]:
    """温和提醒所需的全部事实值（不含文案）。文案层只允许引用这里的数字。"""
    projected_gap = max(-snapshot.projected_month_end_remaining_cents, 0)
    daily_drag = sum(
        entry.daily_drag_cents
        for entry in snapshot.amortization
        if entry.purchase_date == snapshot.today
    )
    return {
        "over_by_today_cents": max(snapshot.today_spent_cents - snapshot.safe_to_spend_cents, 0),
        "days_left": snapshot.days_left,
        "tomorrow_daily_cents": max(snapshot.live_baseline_cents, 0),
        "projected_gap_cents": projected_gap,
        "per_day_cut_cents": (
            -(-projected_gap // snapshot.days_left) if snapshot.days_left > 0 else 0
        ),
        "daily_drag_cents": daily_drag,
        "carryover_cents": plan.options[0].resulting_next_month_carryover_cents,
    }
