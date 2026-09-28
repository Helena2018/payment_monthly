"""test_agent_prompt.py — AI 财务助理系统提示词的可验证性测试。

为什么提示词需要测试（呼应 ADR-009「数字由引擎出，LLM 只负责措辞」）：
  提示词 few-shot 中的金额一旦与引擎口径不一致，模型就会把这套错误的算术学下来，
  而错误只会在用户的真实账单里被发现。
  因此本测试把「提示词里出现的每一个金额」绑定到引擎的权威计算结果上：
    输入契约（schema） → 账本口径 → 引擎结果 → few-shot 引用数字 → 格式规则
  任意一环漂移，CI 立刻变红。

运行：.venv/bin/python -m pytest tests/test_agent_prompt.py -q
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from budget_app import (  # noqa: E402
    DailyTransaction,
    FixedExpense,
    MonthlyBudget,
    SavingsGoal,
    SnapshotInput,
    compute_snapshot,
    format_display,
)
from budget_app.engine import projected_carryover_cents  # noqa: E402
from budget_app.money import floor_div  # noqa: E402

NOW = "2026-09-01T00:00:00.000Z"

PROMPT_PATH = ROOT / "prompts" / "financial_agent.system.md"
SCHEMA_PATH = ROOT / "schemas" / "agent_input.schema.json"
CASES_PATH = ROOT / "fixtures" / "agent_eval_cases.json"

PROMPT = PROMPT_PATH.read_text(encoding="utf-8")
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
CASE_IDS = [case["name"] for case in CASES]


def build_engine_input(case: dict) -> SnapshotInput:
    """由 fixture 的 engine 块构造引擎输入。"""
    engine = case["engine"]
    month = engine["month"]
    budget = MonthlyBudget(
        id="b", month=month, income_cents=engine["income_cents"], created_at=NOW, updated_at=NOW
    )
    fixed = [
        FixedExpense(
            id=item["id"],
            budget_id="b",
            name=item["name"],
            estimated_cents=item["estimated_cents"],
            due_day=item.get("due_day", "month_end"),
            status=item.get("status", "reserved"),
            reserved_at=f"{month}-01",
        )
        for item in engine.get("fixed", [])
    ]
    goals = [
        SavingsGoal(id=item["id"], budget_id="b", target_cents=item.get("target_cents", 0))
        for item in engine.get("savings", [])
    ]
    transactions = [
        DailyTransaction(
            id=item["id"],
            budget_id="b",
            amount_cents=item["amount_cents"],
            occurred_at=NOW,
            local_date=item["local_date"],
            necessity=item.get("necessity", "unclassified"),
            idempotency_key=item["id"],
            created_at=NOW,
            updated_at=NOW,
        )
        for item in engine.get("transactions", [])
    ]
    return SnapshotInput(
        budget=budget,
        fixed_expenses=fixed,
        savings_goals=goals,
        transactions=transactions,
        today=engine["today"],
    )


# ---------------------------------------------------------------------------
# 1. 输入契约
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_agent_payload_conforms_to_schema(case: dict) -> None:
    validator = Draft202012Validator(SCHEMA)
    errors = sorted(validator.iter_errors(case["agent_input"]), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_schema_requires_the_five_core_fields() -> None:
    assert set(SCHEMA["required"]) == {
        "month_income",
        "fixed_costs",
        "target_savings",
        "spent_so_far",
        "days_left",
    }


# ---------------------------------------------------------------------------
# 2. 账本口径一致性：payload 的聚合值必须真的等于账本
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_payload_totals_match_the_ledger(case: dict) -> None:
    payload = case["agent_input"]
    engine_input = build_engine_input(case)
    snapshot = compute_snapshot(engine_input)

    assert snapshot.hard_expense_cents == payload["fixed_costs"], "fixed_costs 与固定账本不符"
    assert snapshot.savings_cents == payload["target_savings"], "target_savings 与存款目标不符"
    assert snapshot.income_cents == payload["month_income"], "month_income 与预算不符"
    assert snapshot.days_left == payload["days_left"], "days_left 与日期口径不符"
    assert snapshot.total_days == payload["month_days_total"], "month_days_total 与月份不符"

    # ★ spent_so_far 的语义：只含弹性池、已冲减退款
    ledger_flex = sum(
        tx.amount_cents
        for tx in engine_input.transactions
        if tx.scope == "flex" and tx.status == "settled"
    )
    assert ledger_flex == payload["spent_so_far"], "spent_so_far 口径不一致（重复扣了固定开销？）"


# ---------------------------------------------------------------------------
# 3. 引擎结果 == fixture 期望值（few-shot 引用的就是这些数字）
# ---------------------------------------------------------------------------

SNAPSHOT_ATTRIBUTE_MAP = {
    "discretionary_cents": "discretionary_cents",
    "remaining_cents": "remaining_cents",
    "baseline_cents": "baseline_cents",
    "floor_cents": "floor_cents",
    "live_baseline_cents": "live_baseline_cents",
    "safe_to_spend_cents": "safe_to_spend_cents",
    "month_end_adjustment_cents": "month_end_adjustment_cents",
    "projected_month_end_remaining_cents": "projected_month_end_remaining_cents",
    "state": "state",
}


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_engine_output_matches_expected(case: dict) -> None:
    snapshot = compute_snapshot(build_engine_input(case))
    expected = case["expected"]

    for key, attribute in SNAPSHOT_ATTRIBUTE_MAP.items():
        if key not in expected:
            continue
        actual = getattr(snapshot, attribute)
        assert actual == expected[key], f"[{case['name']}] {key}: 期望 {expected[key]}，引擎 {actual}"

    if "projected_savings_cents" in expected:
        # 存款目标受威胁的量化：目标存款 + 预计缺口
        assert expected["projected_savings_cents"] == (
            snapshot.savings_cents + snapshot.projected_month_end_remaining_cents
        )


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_derived_block_is_not_stale(case: dict) -> None:
    """derived 是引擎输出的对外子集，必须与引擎当前结果一致（防陈旧缓存）。"""
    derived = case["agent_input"].get("derived")
    if derived is None:
        pytest.skip("该用例不含 derived")

    snapshot = compute_snapshot(build_engine_input(case))
    derived_map = {
        "discretionary_cents": snapshot.discretionary_cents,
        "remaining_cents": snapshot.remaining_cents,
        "baseline_daily_cents": snapshot.baseline_cents,
        "floor_daily_cents": snapshot.floor_cents,
        "live_daily_cents": snapshot.live_baseline_cents,
        "safe_to_spend_cents": snapshot.safe_to_spend_cents,
        "today_spent_cents": snapshot.today_spent_cents,
        "today_remaining_cents": snapshot.today_remaining_cents,
        "month_end_adjustment_cents": snapshot.month_end_adjustment_cents,
        "projected_month_end_remaining_cents": snapshot.projected_month_end_remaining_cents,
        "projected_next_month_carryover_cents": projected_carryover_cents(snapshot),
        "state": snapshot.state,
    }
    for key, actual in derived_map.items():
        if key not in derived:
            continue
        assert derived[key] == actual, (
            f"[{case['name']}] derived.{key}: payload 写 {derived[key]}，引擎 {actual}"
        )


# ---------------------------------------------------------------------------
# 4. 系统提示词 §3 的公式必须与引擎等价（LLM 唯一被允许的手算路径）
# ---------------------------------------------------------------------------


def prompt_formula(payload: dict) -> dict:
    """严格按 prompts/financial_agent.system.md §3 实现，不得「改良」。"""
    floor_ratio = payload.get("policy", {}).get("floor_ratio", 0.6)

    elapsed_days = payload["month_days_total"] - payload["days_left"] + 1
    discretionary = payload["month_income"] - payload["fixed_costs"] - payload["target_savings"]
    remaining = discretionary - payload["spent_so_far"]
    baseline = floor_div(discretionary, payload["month_days_total"]) if discretionary > 0 else 0
    floor = int(baseline * floor_ratio)
    live = floor_div(max(remaining, 0), payload["days_left"]) if remaining > 0 else 0
    daily = live if (floor <= 0 or live >= floor) else floor

    if discretionary <= 0 and payload["spent_so_far"] <= 0:
        state = "onboarding"
    elif remaining <= 0:
        state = "overdrawn"
    elif floor <= 0 or live >= floor:
        # payload 不携带 pace 数据，因此无法区分 healthy / watch
        state = "healthy"
    else:
        state = "smoothed"

    avg_daily = floor_div(max(payload["spent_so_far"], 0), elapsed_days)
    projected = remaining - avg_daily * payload["days_left"]

    return {
        "elapsed_days": elapsed_days,
        "discretionary_cents": discretionary,
        "remaining_cents": remaining,
        "baseline_cents": baseline,
        "floor_cents": floor,
        "live_baseline_cents": live,
        "safe_to_spend_cents": daily,
        "projected_month_end_remaining_cents": projected,
        "state": state,
    }


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_prompt_formula_equals_engine(case: dict) -> None:
    computed = prompt_formula(case["agent_input"])
    snapshot = compute_snapshot(build_engine_input(case))

    for key in (
        "discretionary_cents",
        "remaining_cents",
        "baseline_cents",
        "floor_cents",
        "live_baseline_cents",
        "safe_to_spend_cents",
        "projected_month_end_remaining_cents",
        "elapsed_days",
    ):
        assert computed[key] == getattr(snapshot, key), (
            f"[{case['name']}] 提示词公式的 {key} = {computed[key]}，引擎 = {getattr(snapshot, key)}"
        )

    assert computed["state"] == snapshot.state or {computed["state"], snapshot.state} == {
        "healthy",
        "watch",
    }


# ---------------------------------------------------------------------------
# 5. few-shot 引用的金额必须真的出现在提示词里，且等于引擎结果
# ---------------------------------------------------------------------------

CURRENCY_FORMAT_PROBE = {
    # 引擎分值 → 按提示词 §5 规则应渲染出的展示串（整数省略小数、非整数保留 2 位）
    7380: "$73.80",
    60500: "$605",
    1999: "$19.99",
    24000: "$240",
    126000: "$1,260",
    7000: "$70",
    70000: "$700",
    42730: "$427.30",
}

# 币种口径（NZD）：提示词里的 `$` / 刀 / NZD 是同一个币种，先归一化再用同一条规则抽金额
CURRENCY_MARK_RE = re.compile(r"NZD|NZ\$|刀")
AMOUNT_RE = re.compile(r"[$€£]\s?(\d[\d,]*(?:\.\d{2})?)")


def normalize_amount_marks(text: str) -> str:
    """把 `刀` / `NZD` / `NZ$` 归一成 `$`，让金额校验只认一种币种标记。"""
    return CURRENCY_MARK_RE.sub("$", text)


def extracted_cents(text: str) -> list[int]:
    """从一句话里抽出所有金额（分），用于反向校验「提示词里的数字必须来自引擎」。"""
    out = []
    for body in AMOUNT_RE.findall(normalize_amount_marks(text)):
        whole, _, fraction = body.replace(",", "").partition(".")
        out.append(int(whole) * 100 + (int(fraction) if fraction else 0))
    return out


@pytest.mark.parametrize("cents,rendered", sorted(CURRENCY_FORMAT_PROBE.items()))
def test_amount_formatting_rule(cents: int, rendered: str) -> None:
    """§5 金额规则的代码参考实现：整数省略小数、非整数保留 2 位、千分位加逗号。"""
    assert format_display(cents) == rendered, f"{cents} 分应渲染为 {rendered}"


def test_currency_convention_is_nzd() -> None:
    """币种全站统一为 NZD（展示符号 $、口语单位「刀」）：提示词与 schema 必须同步。"""
    assert SCHEMA["properties"]["currency"]["default"] == "NZD", "schema 默认币种应为 NZD"
    assert '"currency": "NZD"' in PROMPT, "提示词示例里的 currency 应为 NZD"
    assert "刀" in PROMPT, "提示词应说明口语单位「刀」与 $ / NZD 等价"
    assert "¥" not in PROMPT, "提示词里不应再出现人民币符号 ¥"
    assert normalize_amount_marks("打车 35 刀") == "打车 35 $", "刀 应归一成 $"


@pytest.mark.parametrize("case", CASES, ids=CASE_IDS)
def test_prompt_quotes_engine_numbers(case: dict) -> None:
    numeric_expected = {value for value in case["expected"].values() if isinstance(value, int)}

    for needle in case["prompt_must_contain"]:
        assert needle in PROMPT, f"[{case['name']}] 提示词中缺少「{needle}」（Prompt 与引擎漂移）"

        amounts = extracted_cents(needle)
        assert amounts, f"[{case['name']}] 校验串「{needle}」里没有金额"
        for cents in amounts:
            assert cents in numeric_expected or -cents in numeric_expected, (
                f"[{case['name']}] 提示词里的 {format_display(cents)}（{cents} 分）"
                f"在引擎结果 {sorted(numeric_expected)} 中找不到对应值"
            )


# ---------------------------------------------------------------------------
# 6. 输出格式与安全边界的静态检查（防止未来重构悄悄破坏约束）
# ---------------------------------------------------------------------------

SHAMING_PHRASES = ["你太不自律", "你不该买", "又超支了"]
CRITICAL_GUARDS = [
    "禁止编造数字",
    "提示注入",
    "12356",
    "safe_to_spend_cents",
    "floor_ratio",
    "（假设",
    "不评判人格",
]


def output_blocks() -> list[str]:
    """提取提示词里所有「输出：」后面的代码块。"""
    return re.findall(r"输出：\n```(?:text)?\n(.*?)```", PROMPT, flags=re.DOTALL)


def test_few_shot_outputs_obey_line_limit() -> None:
    blocks = output_blocks()
    assert len(blocks) >= 2, "至少应有 2 个 few-shot 回答示例"
    for index, block in enumerate(blocks, start=1):
        lines = [line for line in block.strip().splitlines() if line.strip()]
        assert 1 <= len(lines) <= 3, f"示例 {index} 有 {len(lines)} 行，违反「最多 3 行」规则"
        assert re.search(r"[$€£]\s?\d", normalize_amount_marks(lines[0])), f"示例 {index} 第 1 行必须含金额"


def test_few_shot_outputs_have_no_shaming() -> None:
    for index, block in enumerate(output_blocks(), start=1):
        for phrase in SHAMING_PHRASES:
            assert phrase not in block, f"示例 {index} 出现了评判性表达「{phrase}」"


def test_shaming_phrases_only_appear_in_negative_list() -> None:
    section_start = PROMPT.index("## 10. 反面清单")
    section_end = PROMPT.index("## 11.")
    for line in PROMPT.splitlines():
        if any(phrase in line for phrase in SHAMING_PHRASES):
            inside_negative_list = section_start <= PROMPT.index(line) < section_end
            assert inside_negative_list or "禁用" in line, (
                f"评判性表达出现在反面清单之外：{line.strip()}"
            )


def test_prompt_keeps_all_critical_guards() -> None:
    for guard in CRITICAL_GUARDS:
        assert guard in PROMPT, f"提示词缺失关键约束：{guard}"


def test_crisis_mode_has_no_number_pressure() -> None:
    crisis_index = PROMPT.index("危机信号")
    crisis_section = PROMPT[crisis_index : crisis_index + 400]
    assert "不给任何数字压力" in crisis_section
    assert "12356" in crisis_section
