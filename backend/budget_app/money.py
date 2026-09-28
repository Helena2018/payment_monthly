"""money.py — 整数分运算。与 packages/core/src/money.ts 逐函数镜像。

约定（ADR-001）：全系统金额一律 int 分，禁止 float 参与金额运算。
两端必须给出完全一致的结果，因此：
  - floor_div 使用 Python 的 // （向 -Infinity 取整，等价于 JS Math.floor(a/b)）
  - round_half_away_from_zero 显式约定「远离零」舍入，绕开 Python round() 的银行家舍入
  - allocate 使用最大余数法，余数优先给靠前的份额
"""

from __future__ import annotations

import math
from typing import Iterable, List

#: 主币单位（NZD「刀」）→ 分的换算常量；名字里的 YUAN 是历史命名，语义即「主币单位」。
CENTS_PER_YUAN = 100
MAX_SAFE_INTEGER = 2**53 - 1

#: 金额类型别名：整数分。$1 = 100。
Cents = int


def assert_cents(value: object, name: str = "cents") -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer number of cents, got {value!r}")
    if abs(value) > MAX_SAFE_INTEGER:
        raise RangeError(f"{name} exceeds MAX_SAFE_INTEGER: {value}")
    return value


class RangeError(ValueError):
    """与 TS 侧 RangeError 语义对应的异常类型。"""


def floor_div(numerator: int, denominator: int) -> int:
    assert_cents(numerator, "numerator")
    if not isinstance(denominator, int) or isinstance(denominator, bool) or denominator == 0:
        raise RangeError(f"denominator must be a non-zero integer, got {denominator!r}")
    return numerator // denominator


def div_round(numerator: int, denominator: int) -> int:
    assert_cents(numerator, "numerator")
    if not isinstance(denominator, int) or isinstance(denominator, bool) or denominator == 0:
        raise RangeError(f"denominator must be a non-zero integer, got {denominator!r}")
    sign = -1 if (numerator < 0) != (denominator < 0) else 1
    return sign * int(math.floor(abs(numerator) / abs(denominator) + 0.5))


def round_half_away_from_zero(value: float) -> int:
    """跨语言一致的舍入：远离零方向（等价于 JS 的 roundHalfAwayFromZero）。"""
    if not math.isfinite(value):
        raise TypeError(f"value must be finite, got {value}")
    if value == 0:
        return 0
    return int(math.copysign(math.floor(abs(value) + 0.5), value))


def sum_cents(values: Iterable[int]) -> int:
    total = 0
    for value in values:
        total += assert_cents(value, "value")
    return total


def allocate(total: int, parts: int) -> List[int]:
    """把 total 精确拆成 parts 份，保证 sum(结果) == total（最大余数法）。"""
    assert_cents(total, "total")
    if not isinstance(parts, int) or isinstance(parts, bool) or parts <= 0:
        raise RangeError(f"parts must be a positive integer, got {parts!r}")
    sign = -1 if total < 0 else 1
    absolute = abs(total)
    base = absolute // parts
    remainder = absolute - base * parts
    out = [base] * parts
    for i in range(remainder):
        out[i] += 1
    return [value * sign for value in out]


def format_cents(cents: int, fraction_digits: int = 2) -> str:
    assert_cents(cents, "cents")
    sign = "-" if cents < 0 else ""
    absolute = abs(cents)
    yuan = absolute // CENTS_PER_YUAN
    frac = absolute - yuan * CENTS_PER_YUAN
    grouped = f"{yuan:,}"
    if fraction_digits == 0:
        return f"{sign}{grouped}"
    return f"{sign}{grouped}.{frac:02d}"


def format_display(
    amount_cents: int,
    symbol: str = "$",
    fraction_digits: int = 2,
    drop_zero_fraction: bool = True,
) -> str:
    """AI 助理展示格式化（提示词 §5 规则的**代码参考实现**）。

    规则：整数金额省略小数（$605）、非整数保留 2 位（$73.80）、千分位加逗号、符号前置。
    把它放在代码里而不是让 LLM 独自实现，是为了保证 UI 与 AI 回复里的金额长得一模一样。
    """
    assert_cents(amount_cents, "amount_cents")
    body = format_cents(abs(amount_cents), fraction_digits)
    if drop_zero_fraction and fraction_digits > 0:
        zero_tail = "." + "0" * fraction_digits
        if body.endswith(zero_tail):
            body = body[: -len(zero_tail)]
    sign = "-" if amount_cents < 0 else ""
    return f"{sign}{symbol}{body}"


def from_yuan_string(text: str) -> int:
    """用户输入「12.3」→ 1230 分；整数化解析，避免 float('...')*100 的精度陷阱。"""
    import re

    trimmed = text.strip().replace(",", "")
    match = re.fullmatch(r"(-?)(\d*)(?:\.(\d{0,2}))?", trimmed)
    if not match or (match.group(2) == "" and (match.group(3) or "") == ""):
        raise TypeError(f"invalid yuan amount: {text!r}")
    sign = -1 if match.group(1) == "-" else 1
    yuan_part = int(match.group(2)) if match.group(2) else 0
    frac_text = (match.group(3) or "").ljust(2, "0")
    frac_part = int(frac_text) if frac_text else 0
    return sign * (yuan_part * CENTS_PER_YUAN + frac_part)
