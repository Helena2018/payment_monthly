"""models.py — Pydantic v2 数据模型。与 packages/core/src/models.ts 一一镜像。

字段命名差异：Python 用 snake_case，TS 用 camelCase。
对外 API/同步协议建议统一用 camelCase（见 schemas/budget.schema.json），
需要时可加 alias_generator=to_camel，本文件保持 snake_case 以贴合 Python 习惯。
"""

from __future__ import annotations

from datetime import date as _date
from typing import Annotated, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .money import Cents  # noqa: F401  (类型别名，便于阅读)


def _check_month(value: str) -> str:
    """校验 YYYY-MM 是真实的自然月（拒绝 2026-13 这类脏数据）。"""
    year_text, month_text = value.split("-")
    month_number = int(month_text)
    if not 1 <= month_number <= 12:
        raise ValueError(f"invalid month: {value}")
    if not 1900 <= int(year_text) <= 9999:
        raise ValueError(f"invalid year: {value}")
    return value


def _check_iso_date(value: str) -> str:
    try:
        _date.fromisoformat(value)
    except ValueError as exc:  # pragma: no cover - 错误路径
        raise ValueError(f"invalid date: {value}") from exc
    return value

DueDay = Union[Annotated[int, Field(ge=1, le=31)], Literal["month_end"]]

FixedExpenseKind = Literal["bill", "debt", "subscription"]
FixedExpenseStatus = Literal["reserved", "paid", "skipped"]
SavingsMethod = Literal["fixed", "percent"]
SavingsStatus = Literal["planned", "transferred", "skipped"]
Necessity = Literal["necessary", "optional", "unclassified"]
TransactionScope = Literal["flex", "off_budget"]
TransactionStatus = Literal["pending", "settled", "voided"]
BudgetState = Literal["onboarding", "healthy", "watch", "smoothed", "overdrawn"]


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class MonthlyBudget(_Base):
    """月度总预算：一个自然月一条。"""

    id: str
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    income_cents: int = Field(ge=0, description="本月可用收入（税后到手），整数分")
    payday: DueDay = "month_end"
    carryover_cents: int = Field(
        default=0, description="上月结转：正=结余滚入，负=上月透支从本月扣减"
    )
    note: Optional[str] = None
    created_at: str
    updated_at: str

    @field_validator("month")
    @classmethod
    def _month_must_be_real(cls, value: str) -> str:
        return _check_month(value)


class FixedExpense(_Base):
    """固定必用支出 / 账单 / 贷款 / 订阅。

    estimated_cents 用于月初「预留」，actual_cents 是出账后的真实金额；
    浮动账单的差额会自动回冲弹性池（见 engine.compute_snapshot）。
    """

    id: str
    budget_id: str
    name: str = Field(min_length=1)
    kind: FixedExpenseKind = "bill"
    estimated_cents: int = Field(ge=0)
    actual_cents: Optional[int] = Field(default=None, ge=0)
    due_day: DueDay = "month_end"
    auto_debit: bool = False
    status: FixedExpenseStatus = "reserved"
    reserved_at: str
    paid_at: Optional[str] = None
    active: bool = True


class SavingsGoal(_Base):
    """月度存款目标：支持固定金额或收入百分比。"""

    id: str
    budget_id: str
    name: str = "月度储蓄"
    method: SavingsMethod = "fixed"
    target_cents: int = Field(default=0, ge=0)
    percent: Optional[float] = Field(default=None, ge=0, le=100)
    auto_transfer_day: DueDay = 1
    transferred_cents: int = Field(default=0, ge=0)
    status: SavingsStatus = "planned"

    def model_post_init(self, __context) -> None:
        if self.method == "percent" and self.percent is None:
            raise ValueError("percent is required when method='percent'")


class DailyTransaction(_Base):
    """日常变动开销（一笔账）。

    amount_cents < 0 表示退款，会自动回冲余额。
    local_date 由端侧写入（本地自然日），后端不做时区推断。
    """

    id: str
    budget_id: str
    amount_cents: int
    occurred_at: str
    local_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    necessity: Necessity = "unclassified"
    tags: List[str] = Field(default_factory=list)
    note: Optional[str] = None
    scope: TransactionScope = "flex"
    status: TransactionStatus = "settled"
    is_big_ticket: bool = False
    amortize: bool = True
    off_budget_reason: Optional[str] = None
    idempotency_key: str
    version: int = 1
    created_at: str
    updated_at: str
    deleted_at: Optional[str] = None

    def model_post_init(self, __context) -> None:
        if self.scope == "off_budget" and not self.off_budget_reason:
            raise ValueError("off_budget_reason is required when scope='off_budget'")

    @field_validator("local_date")
    @classmethod
    def _local_date_must_be_real(cls, value: str) -> str:
        return _check_iso_date(value)


class EngineConfig(BaseModel):
    """引擎参数（可下发 remote config，灰度调整策略不必发版）。"""

    model_config = ConfigDict(extra="forbid")

    floor_ratio: float = 0.6
    big_ticket_ratio: float = 2.0
    pace_tolerance: float = 0.08
    carryover_policy: Literal["carry", "to_savings", "reset"] = "carry"
    default_overspend_policy: Literal[
        "deduct_next_month", "borrow_from_savings", "off_budget"
    ] = "deduct_next_month"
    rounding: Literal["floor", "round"] = "floor"


class SnapshotInput(BaseModel):
    """一次快照计算的完整输入（纯函数入参，可直接序列化）。"""

    model_config = ConfigDict(extra="forbid")

    budget: MonthlyBudget
    fixed_expenses: List[FixedExpense] = Field(default_factory=list)
    savings_goals: List[SavingsGoal] = Field(default_factory=list)
    transactions: List[DailyTransaction] = Field(default_factory=list)
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    config: Optional[EngineConfig] = None
