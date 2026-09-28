/**
 * golden.test.ts — 黄金向量测试（端侧引擎）
 *
 * 同一份 fixtures/golden_cases.json 也被 backend 的 tests/test_engine.py 读取，
 * 两端必须给出完全相同的数字 —— 这是「端侧离线算 + 后端对账」架构能成立的前提。
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  DailyTransaction,
  FixedExpense,
  MonthlyBudget,
  SavingsGoal,
  SnapshotInput,
  buildAlerts,
  computeSnapshot,
  makeBudget,
  makeFixedExpense,
  makeSavingsGoal,
  makeTransaction,
  roundHalfAwayFromZero,
  selectAlertsForDisplay,
} from '../src/index';

const FIXTURE_PATH = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fixtures', 'golden_cases.json');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('fixtures/golden_cases.json not found');
})();

interface RawBudget {
  id: string;
  month: string;
  incomeCents: number;
  payday?: number | 'month_end';
  carryoverCents?: number;
}

interface RawFixed {
  id: string;
  name: string;
  kind?: FixedExpense['kind'];
  estimatedCents: number;
  actualCents?: number | null;
  dueDay?: number | 'month_end';
  autoDebit?: boolean;
  status?: FixedExpense['status'];
  active?: boolean;
}

interface RawGoal {
  id: string;
  name?: string;
  method?: SavingsGoal['method'];
  targetCents?: number;
  percent?: number | null;
  status?: SavingsGoal['status'];
}

interface RawTx {
  id: string;
  amountCents: number;
  localDate: string;
  necessity?: DailyTransaction['necessity'];
  scope?: DailyTransaction['scope'];
  offBudgetReason?: string;
  status?: DailyTransaction['status'];
  tags?: string[];
  note?: string;
}

interface GoldenCase {
  name: string;
  note: string;
  today: string;
  budget: RawBudget;
  fixedExpenses?: RawFixed[];
  savingsGoals?: RawGoal[];
  transactions?: RawTx[];
  expectSnapshot: Record<string, number | string>;
  expectAlertCodes?: string[];
}

const RESERVED_AT = '2026-09-01';

export function expandCase(c: GoldenCase): SnapshotInput {
  const budget: MonthlyBudget = makeBudget({
    id: c.budget.id,
    month: c.budget.month,
    incomeCents: c.budget.incomeCents,
    payday: c.budget.payday,
    carryoverCents: c.budget.carryoverCents,
  });

  const fixedExpenses: FixedExpense[] = (c.fixedExpenses ?? []).map((f) =>
    makeFixedExpense({
      id: f.id,
      budgetId: budget.id,
      name: f.name,
      kind: f.kind,
      estimatedCents: f.estimatedCents,
      actualCents: f.actualCents ?? null,
      dueDay: f.dueDay ?? 'month_end',
      autoDebit: f.autoDebit,
      status: f.status,
      reservedAt: RESERVED_AT,
      active: f.active,
    }),
  );

  const savingsGoals: SavingsGoal[] = (c.savingsGoals ?? []).map((g) =>
    makeSavingsGoal({
      id: g.id,
      budgetId: budget.id,
      name: g.name,
      method: g.method,
      targetCents: g.targetCents,
      percent: g.percent ?? null,
      status: g.status,
    }),
  );

  const transactions: DailyTransaction[] = (c.transactions ?? []).map((t) =>
    makeTransaction({
      id: t.id,
      budgetId: budget.id,
      amountCents: t.amountCents,
      localDate: t.localDate,
      necessity: t.necessity,
      scope: t.scope,
      offBudgetReason: t.offBudgetReason,
      status: t.status,
      tags: t.tags,
      note: t.note,
    }),
  );

  return { budget, fixedExpenses, savingsGoals, transactions, today: c.today };
}

/** 把快照摊平成与 expectSnapshot 同构的断言对象。 */
export function assertableView(input: SnapshotInput): Record<string, number | string> {
  const s = computeSnapshot(input);
  return {
    totalDays: s.totalDays,
    elapsedDays: s.elapsedDays,
    daysLeft: s.daysLeft,
    fixedSkippedCents: s.fixed.skippedCents,
    hardExpenseCents: s.hardExpenseCents,
    savingsCents: s.savingsCents,
    committedCents: s.committedCents,
    discretionaryCents: s.discretionaryCents,
    baselineCents: s.baselineCents,
    floorCents: s.floorCents,
    spentCents: s.spentCents,
    remainingCents: s.remainingCents,
    liveBaselineCents: s.liveBaselineCents,
    safeToSpendCents: s.safeToSpendCents,
    todaySpentCents: s.todaySpentCents,
    todayRemainingCents: s.todayRemainingCents,
    monthEndAdjustmentCents: s.monthEndAdjustmentCents,
    paceSpentCents: s.paceSpentCents,
    paceGapBp: roundHalfAwayFromZero(s.paceGap * 10000),
    projectedMonthEndRemainingCents: s.projectedMonthEndRemainingCents,
    amortizedCount: s.amortization.length,
    amortizedSpreadDays: s.amortization[0]?.spreadDays ?? 0,
    amortizedDailyDragCents: s.amortization[0]?.dailyDragCents ?? 0,
    state: s.state,
  };
}

const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: GoldenCase[] };

test('golden fixtures: TS 引擎与期望值逐项一致', () => {
  assert.ok(raw.cases.length > 0, 'fixtures 不能为空');
  for (const c of raw.cases) {
    const input = expandCase(c);
    const actual = assertableView(input);
    for (const [key, expected] of Object.entries(c.expectSnapshot)) {
      assert.equal(
        actual[key],
        expected,
        `[${c.name}] ${key} 期望 ${expected}，实际 ${actual[key]}`,
      );
    }
  }
});

test('golden fixtures: 展示用告警（节流后）与期望一致', () => {
  for (const c of raw.cases) {
    if (!c.expectAlertCodes) continue;
    const input = expandCase(c);
    const shown = selectAlertsForDisplay(buildAlerts(computeSnapshot(input), input)).map(
      (a) => a.code,
    );
    assert.deepEqual(shown, c.expectAlertCodes, `[${c.name}] 展示告警不一致`);
  }
});
