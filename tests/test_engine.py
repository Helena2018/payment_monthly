"""test_engine.py — 后端镜像实现的测试。

两类测试：
  1) **跨语言一致性（parity）**：读取与 TS 侧完全相同的 fixtures/golden_cases.json，
     断言后端算出的数字与端侧逐位一致 —— 这是「端侧离线算 + 后端对账」架构成立的前提。
  2) 单元测试：整数分运算、日历边界、大额摊销、超支重排与不动点求解。

运行：.venv/bin/python -m pytest tests -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from budget_app import (  # noqa: E402
    DailyTransaction,
    FixedExpense,
    MonthlyBudget,
    SavingsGoal,
    SnapshotInput,
    allocate,
    compute_borrow_to_exit_floor,
    compute_snapshot,
    days_in_month,
    days_left_inclusive,
    floor_div,
    plan_overspend_recovery,
    resolve_due_day,
    reschedule_daily_allowances,
    round_half_away_from_zero,
)
from budget_app.engine import (  # noqa: E402
    amortized_charge_cents,
    build_gentle_message_facts,
    classify_overspend_level,
    next_month_carryover_from_snapshot,
    projected_carryover_cents,
    projected_carryover_cents as _projected,
    with_savings_reduced,
)

NOW = "2026-09-01T00:00:00.000Z"
FIXTURES = ROOT / "fixtures" / "golden_cases.json"


def expand_case(case: dict) -> SnapshotInput:
    """把紧凑的 fixture 展开成完整实体（默认值与 TS 侧 expandCase 保持一致）。"""
    budget_raw = case["budget"]
    budget = MonthlyBudget(
        id=budget_raw["id"],
        month=budget_raw["month"],
        income_cents=budget_raw["incomeCents"],
        payday=budget_raw.get("payday", "month_end"),
        carryover_cents=budget_raw.get("carryoverCents", 0),
        created_at=NOW,
        updated_at=NOW,
    )

    fixed = [
        FixedExpense(
            id=item["id"],
            budget_id=budget.id,
            name=item["name"],
            kind=item.get("kind", "bill"),
            estimated_cents=item["estimatedCents"],
            actual_cents=item.get("actualCents"),
            due_day=item.get("dueDay", "month_end"),
            auto_debit=item.get("autoDebit", False),
            status=item.get("status", "reserved"),
            reserved_at="2026-09-01",
            active=item.get("active", True),
        )
        for item in case.get("fixedExpenses", [])
    ]

    goals = [
        SavingsGoal(
            id=item["id"],
            budget_id=budget.id,
            name=item.get("name", "月度储蓄"),
            method=item.get("method", "fixed"),
            target_cents=item.get("targetCents", 0),
            percent=item.get("percent"),
            status=item.get("status", "planned"),
        )
        for item in case.get("savingsGoals", [])
    ]

    transactions = [
        DailyTransaction(
            id=item["id"],
            budget_id=budget.id,
            amount_cents=item["amountCents"],
            occurred_at=NOW,
            local_date=item["localDate"],
            necessity=item.get("necessity", "unclassified"),
            tags=item.get("tags", []),
            note=item.get("note"),
            scope=item.get("scope", "flex"),
            status=item.get("status", "settled"),
            is_big_ticket=item.get("isBigTicket", False),
            amortize=item.get("amortize", True),
            off_budget_reason=item.get("offBudgetReason"),
            idempotency_key=item.get("idempotencyKey", item["id"]),
            version=1,
            created_at=NOW,
            updated_at=NOW,
        )
        for item in case.get("transactions", [])
    ]

    return SnapshotInput(
        budget=budget,
        fixed_expenses=fixed,
        savings_goals=goals,
        transactions=transactions,
        today=case["today"],
    )


def assertable_view(snapshot_input: SnapshotInput) -> dict:
    """摊平成 camelCase 键，与 TS 侧 assertableView 一一对应。"""
    snapshot = compute_snapshot(snapshot_input)
    entries = snapshot.amortization
    return {
        "totalDays": snapshot.total_days,
        "elapsedDays": snapshot.elapsed_days,
        "daysLeft": snapshot.days_left,
        "fixedSkippedCents": snapshot.fixed.skipped_cents,
        "hardExpenseCents": snapshot.hard_expense_cents,
        "savingsCents": snapshot.savings_cents,
        "committedCents": snapshot.committed_cents,
        "discretionaryCents": snapshot.discretionary_cents,
        "baselineCents": snapshot.baseline_cents,
        "floorCents": snapshot.floor_cents,
        "spentCents": snapshot.spent_cents,
        "remainingCents": snapshot.remaining_cents,
        "liveBaselineCents": snapshot.live_baseline_cents,
        "safeToSpendCents": snapshot.safe_to_spend_cents,
        "todaySpentCents": snapshot.today_spent_cents,
        "todayRemainingCents": snapshot.today_remaining_cents,
        "monthEndAdjustmentCents": snapshot.month_end_adjustment_cents,
        "paceSpentCents": snapshot.pace_spent_cents,
        "paceGapBp": round_half_away_from_zero(snapshot.pace_gap * 10000),
        "projectedMonthEndRemainingCents": snapshot.projected_month_end_remaining_cents,
        "amortizedCount": len(entries),
        "amortizedSpreadDays": entries[0].spread_days if entries else 0,
        "amortizedDailyDragCents": entries[0].daily_drag_cents if entries else 0,
        "state": snapshot.state,
    }


def load_cases() -> list[dict]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]


CASES = load_cases()


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_golden_parity_with_typescript_engine(case: dict) -> None:
    actual = assertable_view(expand_case(case))
    for key, expected in case["expectSnapshot"].items():
        assert actual[key] == expected, f"[{case['name']}] {key}: 期望 {expected}，实际 {actual[key]}"


# ---------------------------------------------------------------------------
# 单元测试：整数分与日历
# ---------------------------------------------------------------------------


def test_allocate_keeps_total_exact_and_puts_remainder_first() -> None:
    assert allocate(100, 3) == [34, 33, 33]
    assert sum(allocate(300000, 11)) == 300000
    assert allocate(300000, 11)[0] == 27273
    assert allocate(-100, 3) == [-34, -33, -33]
    assert sum(allocate(-100, 3)) == -100
    with pytest.raises(Exception):
        allocate(100, 0)


def test_floor_div_and_rounding_match_typescript() -> None:
    assert floor_div(7, 2) == 3
    assert floor_div(-7, 2) == -4  # 向 -Infinity，与 JS Math.floor 一致
    assert round_half_away_from_zero(2.5) == 3  # Python 内置 round(2.5)==2，必须显式约定
    assert round_half_away_from_zero(-2.5) == -3
    assert round_half_away_from_zero(-3212.116) == -3212


def test_calendar_boundaries() -> None:
    assert days_in_month("2026-02") == 28
    assert days_in_month("2028-02") == 29
    assert resolve_due_day("2026-02", 31) == "2026-02-28"
    assert resolve_due_day("2028-02", 31) == "2028-02-29"
    assert resolve_due_day("2026-02", "month_end") == "2026-02-28"
    assert resolve_due_day("2026-09", 0) == "2026-09-01"
    assert days_left_inclusive("2026-09", "2026-09-01") == 30
    assert days_left_inclusive("2026-09", "2026-09-30") == 1


# ---------------------------------------------------------------------------
# 场景：与 TS 侧 reschedule.test.ts 完全相同的「月末买电脑」场景
# ---------------------------------------------------------------------------


def severe_input() -> SnapshotInput:
    budget = MonthlyBudget(
        id="b", month="2026-09", income_cents=1_000_000, created_at=NOW, updated_at=NOW
    )
    fixed = [
        FixedExpense(
            id="f1",
            budget_id="b",
            name="房租",
            estimated_cents=200000,
            due_day=1,
            status="paid",
            reserved_at="2026-09-01",
        ),
        FixedExpense(
            id="f2",
            budget_id="b",
            name="电费",
            estimated_cents=20000,
            due_day=25,
            status="reserved",
            reserved_at="2026-09-01",
        ),
        FixedExpense(
            id="f3",
            budget_id="b",
            name="宽带",
            estimated_cents=15000,
            due_day=10,
            status="paid",
            reserved_at="2026-09-01",
        ),
        FixedExpense(
            id="f4",
            budget_id="b",
            name="保险",
            estimated_cents=15000,
            due_day=15,
            status="paid",
            reserved_at="2026-09-01",
        ),
    ]
    days = ["2026-09-03", "2026-09-06", "2026-09-09", "2026-09-12", "2026-09-15", "2026-09-18"]
    transactions = [
        DailyTransaction(
            id=f"t{i}",
            budget_id="b",
            amount_cents=30000,
            occurred_at=NOW,
            local_date=day,
            idempotency_key=f"t{i}",
            created_at=NOW,
            updated_at=NOW,
        )
        for i, day in enumerate(days)
    ]
    transactions.append(
        DailyTransaction(
            id="big",
            budget_id="b",
            amount_cents=300000,
            occurred_at=NOW,
            local_date="2026-09-20",
            note="笔记本电脑",
            idempotency_key="big",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    return SnapshotInput(
        budget=budget,
        fixed_expenses=fixed,
        savings_goals=[SavingsGoal(id="g1", budget_id="b", target_cents=150000)],
        transactions=transactions,
        today="2026-09-20",
    )


def test_severe_scenario_uses_floor_and_records_gap() -> None:
    snapshot = compute_snapshot(severe_input())
    assert snapshot.discretionary_cents == 600000
    assert snapshot.remaining_cents == 120000
    assert snapshot.live_baseline_cents == 10909  # 真值日均
    assert snapshot.safe_to_spend_cents == 12000  # 展示口径（保底）
    assert snapshot.month_end_adjustment_cents == -12000
    assert snapshot.state == "smoothed"
    assert classify_overspend_level(snapshot) == "severe"


def test_amortization_charge_boundaries() -> None:
    input_ = severe_input()
    big = next(tx for tx in input_.transactions if tx.id == "big")
    assert amortized_charge_cents(big, "2026-09", "2026-09-20") == 27273
    assert amortized_charge_cents(big, "2026-09", "2026-09-30") == 300000
    assert amortized_charge_cents(big, "2026-09", "2026-09-19") == 0


def test_schedule_floor_mode_accumulates_exact_gap() -> None:
    snapshot = compute_snapshot(severe_input())
    schedule = reschedule_daily_allowances(snapshot, 11)
    assert all(item.allowance_cents == 12000 and item.floor_protected for item in schedule)
    assert schedule[-1].remaining_after_cents == snapshot.month_end_adjustment_cents == -12000


def test_schedule_normal_mode_sums_to_remaining() -> None:
    healthy = severe_input().model_copy(update={"today": "2026-09-05"})
    snapshot = compute_snapshot(healthy)
    full = reschedule_daily_allowances(snapshot, snapshot.days_left)
    assert sum(item.allowance_cents for item in full) == snapshot.remaining_cents


def test_borrow_requires_solving_fixed_point() -> None:
    input_ = severe_input()
    required = compute_borrow_to_exit_floor(input_)
    # 借入会抬高 F → 抬高日基线 → 抬高 floor，所以必须多于朴素缺口（floor×D − R = 12000）
    assert required == 15377
    assert required > 12000

    after = compute_snapshot(with_savings_reduced(input_, required))
    assert after.state != "smoothed"
    assert after.safe_to_spend_cents == after.floor_cents == 12307

    just_below = compute_snapshot(with_savings_reduced(input_, required - 1))
    assert just_below.state == "smoothed"  # 少借 1 分就不够 → 返回的是最小量级

    healthy = severe_input().model_copy(update={"today": "2026-09-05"})
    assert compute_borrow_to_exit_floor(healthy) == 0


def test_overspend_options_mirror_typescript() -> None:
    input_ = severe_input()
    plan = plan_overspend_recovery(
        input_,
        trigger_transaction_id="big",
        savings_borrowable_cents=50000,
        skippable_fixed_ids=["f2"],
    )
    assert plan.level == "severe"
    assert plan.shortfall_cents == 12000

    by_code = {option.code: option for option in plan.options}
    assert by_code["accept_smoothed"].viable
    assert by_code["accept_smoothed"].resulting_daily_cents == 12000
    assert by_code["accept_smoothed"].resulting_next_month_carryover_cents == -12000

    assert by_code["borrow_from_savings"].viable
    assert by_code["borrow_from_savings"].cost_facts["borrow_cents"] == 15377

    assert by_code["mark_off_budget"].viable
    assert by_code["mark_off_budget"].resulting_daily_cents == 38181  # 420000 / 11
    assert by_code["mark_off_budget"].resulting_remaining_cents == 420000

    assert by_code["rebalance_fixed"].viable
    assert by_code["rebalance_fixed"].cost_facts["released_cents"] == 20000
    assert by_code["rebalance_fixed"].resulting_daily_cents == 12727  # 140000 / 11


def test_carryover_policies() -> None:
    deficit = compute_snapshot(severe_input())
    assert projected_carryover_cents(deficit) == -12000  # 保底模式用月末调节项
    assert next_month_carryover_from_snapshot(deficit) == 120000
    assert _projected(deficit) == -12000


def test_gentle_message_facts_come_from_engine() -> None:
    input_ = severe_input()
    plan = plan_overspend_recovery(input_, trigger_transaction_id="big")
    facts = build_gentle_message_facts(compute_snapshot(input_), plan)
    assert facts["over_by_today_cents"] == 300000 - 12000
    assert facts["days_left"] == 11
    assert facts["tomorrow_daily_cents"] == 10909
    assert facts["projected_gap_cents"] == 144000
    assert facts["per_day_cut_cents"] == 13091  # ceil(144000 / 11)
    assert facts["daily_drag_cents"] == 27273
    assert facts["carryover_cents"] == -12000


def test_idempotency_dedupe() -> None:
    input_ = severe_input()
    duplicate = input_.transactions[0].model_copy(update={"id": "dup"})  # 同一 idempotency_key
    with_dup = input_.model_copy(update={"transactions": [*input_.transactions, duplicate]})
    assert compute_snapshot(with_dup).spent_cents == compute_snapshot(input_).spent_cents


def test_model_validation_rules() -> None:
    from pydantic import ValidationError as PydanticValidationError

    with pytest.raises(PydanticValidationError):
        DailyTransaction(
            id="x",
            budget_id="b",
            amount_cents=100,
            occurred_at=NOW,
            local_date="2026-09-01",
            scope="off_budget",  # 缺少 off_budget_reason
            idempotency_key="x",
            created_at=NOW,
            updated_at=NOW,
        )
    with pytest.raises(PydanticValidationError):
        SavingsGoal(id="g", budget_id="b", method="percent")  # 缺少 percent
    with pytest.raises(PydanticValidationError):
        MonthlyBudget(id="b", month="2026-13", income_cents=0, created_at=NOW, updated_at=NOW)
