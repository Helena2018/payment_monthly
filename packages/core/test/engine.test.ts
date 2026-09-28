/** engine.test.ts — 日历边界、口径一致性（预留/实付、退款、幂等、摊销） */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_CONFIG,
  amortizedChargeCents,
  bigTicketThresholdCents,
  buildAlerts,
  computeSnapshot,
  daysInMonth,
  daysLeftInclusive,
  makeBudget,
  makeFixedExpense,
  makeSavingsGoal,
  makeTransaction,
  resolveDueDay,
  selectAlertsForDisplay,
  SnapshotInput,
} from '../src/index';

const MONTH = '2026-09';

function baseInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  const budget = makeBudget({ id: 'b', month: MONTH, incomeCents: 1000000 });
  return {
    budget,
    fixedExpenses: [
      makeFixedExpense({
        id: 'f1',
        budgetId: 'b',
        name: '房租',
        estimatedCents: 200000,
        dueDay: 1,
        status: 'paid',
        reservedAt: '2026-09-01',
      }),
      makeFixedExpense({
        id: 'f2',
        budgetId: 'b',
        name: '电费',
        estimatedCents: 20000,
        dueDay: 25,
        status: 'reserved',
        reservedAt: '2026-09-01',
      }),
    ],
    savingsGoals: [makeSavingsGoal({ id: 'g1', budgetId: 'b', targetCents: 150000 })],
    transactions: [],
    today: '2026-09-15',
    ...overrides,
  };
}

test('日历：天数、剩余天数、账单日越界夹到月末', () => {
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(daysInMonth('2026-09'), 30);
  assert.equal(resolveDueDay('2026-02', 31), '2026-02-28');
  assert.equal(resolveDueDay('2028-02', 31), '2028-02-29');
  assert.equal(resolveDueDay('2026-02', 'month_end'), '2026-02-28');
  assert.equal(resolveDueDay('2026-09', 0), '2026-09-01');
  assert.equal(daysLeftInclusive('2026-09', '2026-09-01'), 30);
  assert.equal(daysLeftInclusive('2026-09', '2026-09-30'), 1);
});

test('固定开销：预留与实付都占用预算，跳过则释放', () => {
  const input = baseInput();
  const s = computeSnapshot(input);
  assert.equal(s.hardExpenseCents, 220000);
  assert.equal(s.fixed.paidCents, 200000);
  assert.equal(s.fixed.reservedCents, 20000);
  assert.equal(s.discretionaryCents, 1000000 - 220000 - 150000);

  const skipped = computeSnapshot({
    ...input,
    fixedExpenses: input.fixedExpenses.map((f) =>
      f.id === 'f2' ? { ...f, status: 'skipped' as const } : f,
    ),
  });
  assert.equal(skipped.hardExpenseCents, 200000);
  assert.equal(skipped.fixed.skippedCents, 20000);
  assert.equal(skipped.discretionaryCents, s.discretionaryCents + 20000);
});

test('幂等：同一 idempotencyKey 重复上报只计一次（离线补传不重复扣钱）', () => {
  const tx = makeTransaction({
    id: 't1',
    budgetId: 'b',
    amountCents: 30000,
    localDate: '2026-09-10',
    idempotencyKey: 'k1',
  });
  const dup = { ...tx, id: 't1-dup', idempotencyKey: 'k1' };
  const s = computeSnapshot(baseInput({ transactions: [tx, dup] }));
  assert.equal(s.spentCents, 30000);
});

test('状态过滤：voided 不计入、pending 只提示不进余额', () => {
  const txs = [
    makeTransaction({ id: 't1', budgetId: 'b', amountCents: 30000, localDate: '2026-09-10' }),
    makeTransaction({
      id: 't2',
      budgetId: 'b',
      amountCents: 99999,
      localDate: '2026-09-11',
      status: 'voided',
    }),
    makeTransaction({
      id: 't3',
      budgetId: 'b',
      amountCents: 8888,
      localDate: '2026-09-12',
      status: 'pending',
    }),
  ];
  const s = computeSnapshot(baseInput({ transactions: txs }));
  assert.equal(s.spentCents, 30000);
  assert.equal(s.spending.pendingCents, 8888);
});

test('大额阈值：达到 2 倍日基线即判定为大额', () => {
  const s = computeSnapshot(baseInput());
  assert.equal(s.baselineCents, 21000); // (1000000 - 220000 - 150000) / 30 = 21000
  assert.equal(bigTicketThresholdCents(s.baselineCents, DEFAULT_CONFIG), 42000);

  const below = computeSnapshot(
    baseInput({
      transactions: [
        makeTransaction({ id: 't1', budgetId: 'b', amountCents: 41999, localDate: '2026-09-10' }),
      ],
    }),
  );
  const exact = computeSnapshot(
    baseInput({
      transactions: [
        makeTransaction({ id: 't1', budgetId: 'b', amountCents: 42000, localDate: '2026-09-10' }),
      ],
    }),
  );
  assert.equal(below.spending.bigTicketCount, 0);
  assert.equal(exact.spending.bigTicketCount, 1);
});

test('摊销：真实余额立刻全额扣除，但节奏口径只计当日摊销份额', () => {
  const big = makeTransaction({
    id: 'big',
    budgetId: 'b',
    amountCents: 300000,
    localDate: '2026-09-20',
  });
  const s = computeSnapshot(baseInput({ transactions: [big], today: '2026-09-20' }));

  // 真值：余额一次性少 300000
  assert.equal(s.remainingCents, 1000000 - 220000 - 150000 - 300000);
  // 节奏：只计入 300000 / 11 天的首份
  assert.equal(amortizedChargeCents(big, MONTH, '2026-09-20'), 27273);
  assert.equal(s.paceSpentCents, 27273);
  assert.equal(s.amortization.length, 1);
  assert.equal(s.amortization[0].spreadDays, 11);
  assert.equal(s.amortization[0].dailyDragCents, 27273);
  assert.equal(s.amortization[0].pendingAmortizationCents, 300000 - 27273);
});

test('摊销：跨到月末时全额摊完（不会多摊或少摊 1 分）', () => {
  const big = makeTransaction({
    id: 'big',
    budgetId: 'b',
    amountCents: 300000,
    localDate: '2026-09-20',
  });
  assert.equal(amortizedChargeCents(big, MONTH, '2026-09-30'), 300000);
  assert.equal(amortizedChargeCents(big, MONTH, '2026-09-25'), 27273 * 6);
});

test('摊销：购买日在今天之后（未来/错误数据）记为 0，不污染节奏', () => {
  const future = makeTransaction({
    id: 'tf',
    budgetId: 'b',
    amountCents: 300000,
    localDate: '2026-09-25',
  });
  assert.equal(amortizedChargeCents(future, MONTH, '2026-09-20'), 0);
});

test('摊销：购买日在上月 → 全额计入（不跨月平摊）', () => {
  const lastMonth = makeTransaction({
    id: 'tp',
    budgetId: 'b',
    amountCents: 300000,
    localDate: '2026-08-28',
  });
  assert.equal(amortizedChargeCents(lastMonth, MONTH, '2026-09-20'), 300000);
  assert.equal(computeSnapshot(baseInput({ transactions: [lastMonth] })).amortization.length, 0);
});

test('退款：负额交易自动加回余额，不算大额', () => {
  const refund = makeTransaction({
    id: 'r1',
    budgetId: 'b',
    amountCents: -50000,
    localDate: '2026-09-14',
  });
  const s = computeSnapshot(baseInput({ transactions: [refund] }));
  assert.equal(s.spentCents, -50000);
  assert.equal(s.remainingCents, 630000 + 50000);
  assert.equal(s.spending.refundCents, 50000);
  assert.equal(s.spending.bigTicketCount, 0);
});

test('浮动账单：实际金额覆盖预估，差额自动回冲弹性池', () => {
  const input = baseInput();
  const withActual = computeSnapshot({
    ...input,
    fixedExpenses: input.fixedExpenses.map((f) =>
      f.id === 'f2' ? { ...f, actualCents: 24000 } : f,
    ),
  });
  assert.equal(withActual.hardExpenseCents, 224000);
  assert.equal(withActual.discretionaryCents, computeSnapshot(input).discretionaryCents - 4000);
});

test('引导态：没有任何收入与支出时不报错、不显示负数额度', () => {
  const s = computeSnapshot({
    budget: makeBudget({ id: 'b0', month: MONTH, incomeCents: 0 }),
    fixedExpenses: [],
    savingsGoals: [],
    transactions: [],
    today: '2026-09-01',
  });
  assert.equal(s.state, 'onboarding');
  assert.equal(s.safeToSpendCents, 0);
  assert.equal(s.daysLeft, 30);
  const alerts = selectAlertsForDisplay(buildAlerts(s, {
    budget: makeBudget({ id: 'b0', month: MONTH, incomeCents: 0 }),
    fixedExpenses: [],
    savingsGoals: [],
    transactions: [],
    today: '2026-09-01',
  }));
  assert.equal(alerts[0].messageKey, 'alert.onboarding');
});

test('月末之后复盘（today > 月末）被夹到月末，不会除零', () => {
  const s = computeSnapshot(baseInput({ today: '2026-10-20' }));
  assert.equal(s.today, '2026-09-30');
  assert.equal(s.daysLeft, 1);
  assert.ok(Number.isFinite(s.safeToSpendCents));
});

test('账单临近到期（T6）按到期日排序输出', () => {
  const input = baseInput({ today: '2026-09-23' });
  const s = computeSnapshot(input);
  assert.deepEqual(s.fixed.dueSoon.map((d) => d.id), ['f2']);
  assert.equal(s.fixed.dueSoon[0].dueDate, '2026-09-25');
});

test('时点语义：日期在 today 之后的交易不计入已花（保证历史可重放）', () => {
  const transactions = [
    makeTransaction({ id: 't1', budgetId: 'b', amountCents: 30000, localDate: '2026-09-05' }),
    makeTransaction({ id: 't2', budgetId: 'b', amountCents: 50000, localDate: '2026-09-20' }),
  ];
  const at10 = computeSnapshot(baseInput({ transactions, today: '2026-09-10' }));
  assert.equal(at10.spentCents, 30000);
  assert.equal(at10.spending.futureScheduledCents, 50000);
  assert.equal(at10.amortization.length, 0);

  const at20 = computeSnapshot(baseInput({ transactions, today: '2026-09-20' }));
  assert.equal(at20.spentCents, 80000);
  assert.equal(at20.spending.futureScheduledCents, 0);
  assert.equal(at20.amortization.length, 1);
});
