/**
 * reschedule.test.ts — 异常处理：大额超支后的额度平摊与「健康额度」重建
 *
 * 使用与 fixtures 第 2 号用例相同的场景（$10,000 收入、月中买 $3,000 电脑），
 * 断言用户能看到的每一个补救选项及其代价。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SnapshotInput,
  buildGentleMessageFacts,
  classifyOverspendLevel,
  computeBorrowToExitFloor,
  computeSnapshot,
  makeBudget,
  makeFixedExpense,
  makeSavingsGoal,
  makeTransaction,
  nextMonthCarryoverFromSnapshot,
  planOverspendRecovery,
  projectedCarryoverCents,
  rescheduleDailyAllowances,
  simulateTransaction,
  triageTransactionAmount,
  withSavingsReduced,
} from '../src/index';

const MONTH = '2026-09';
const TODAY = '2026-09-20';

function severeInput(): SnapshotInput {
  const budget = makeBudget({ id: 'b', month: MONTH, incomeCents: 1000000 });
  const fixed = [
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
    makeFixedExpense({
      id: 'f3',
      budgetId: 'b',
      name: '宽带',
      estimatedCents: 15000,
      dueDay: 10,
      status: 'paid',
      reservedAt: '2026-09-01',
    }),
    makeFixedExpense({
      id: 'f4',
      budgetId: 'b',
      name: '保险',
      estimatedCents: 15000,
      dueDay: 15,
      status: 'paid',
      reservedAt: '2026-09-01',
    }),
  ];
  const normalDays = [
    '2026-09-03',
    '2026-09-06',
    '2026-09-09',
    '2026-09-12',
    '2026-09-15',
    '2026-09-18',
  ];
  const transactions = [
    ...normalDays.map((d, i) =>
      makeTransaction({ id: `t${i + 1}`, budgetId: 'b', amountCents: 30000, localDate: d }),
    ),
    makeTransaction({
      id: 'big',
      budgetId: 'b',
      amountCents: 300000,
      localDate: '2026-09-20',
      note: '笔记本电脑',
    }),
  ];
  return {
    budget,
    fixedExpenses: fixed,
    savingsGoals: [makeSavingsGoal({ id: 'g1', budgetId: 'b', targetCents: 150000 })],
    transactions,
    today: TODAY,
  };
}

test('场景基线：当日额度被保底线接住，缺口显式记为月末调节项', () => {
  const s = computeSnapshot(severeInput());
  assert.equal(s.discretionaryCents, 600000);
  assert.equal(s.remainingCents, 120000);
  assert.equal(s.liveBaselineCents, 10909); // 真值日均
  assert.equal(s.safeToSpendCents, 12000); // 展示口径（保底）
  assert.equal(s.monthEndAdjustmentCents, -12000); // 诚实记账的缺口
  assert.equal(s.state, 'smoothed');
  assert.equal(classifyOverspendLevel(s), 'severe');
});

test('额度排期：保底模式下每天 $120，缺口逐日累积，月末正好等于 monthEndAdjustment', () => {
  const s = computeSnapshot(severeInput());
  const schedule = rescheduleDailyAllowances(s, 11);
  assert.equal(schedule.length, 11);
  assert.ok(schedule.every((d) => d.allowanceCents === 12000 && d.floorProtected));
  assert.equal(schedule[0].date, '2026-09-20');
  assert.equal(schedule[10].remainingAfterCents, -12000);
  assert.equal(schedule[10].remainingAfterCents, s.monthEndAdjustmentCents);
});

test('额度排期：正常模式用最大余数法均摊，总和精确等于剩余额', () => {
  const s = computeSnapshot({ ...severeInput(), today: '2026-09-05' });
  const horizon = rescheduleDailyAllowances(s, 7);
  const all = rescheduleDailyAllowances(s, s.daysLeft);
  assert.equal(all.reduce((a, d) => a + d.allowanceCents, 0), s.remainingCents);
  assert.ok(horizon.every((d) => !d.floorProtected));
  assert.equal(horizon[0].allowanceCents, all[0].allowanceCents);
});

test('补救方案 ①：接受保底 → 不动数据，缺口结转到下月', () => {
  const plan = planOverspendRecovery({ input: severeInput(), triggerTransactionId: 'big' });
  const opt = plan.options.find((o) => o.code === 'accept_smoothed')!;
  assert.equal(opt.viable, true);
  assert.equal(opt.resultingDailyCents, 12000);
  assert.equal(opt.resultingNextMonthCarryoverCents, -12000);
  assert.equal(opt.costKey, 'cost.carryover_next_month');
  assert.equal(plan.shortfallCents, 12000);
});

test('补救方案 ②：向储蓄借 → 必须解不动点，借入额大于朴素缺口', () => {
  const input = severeInput();
  const plan = planOverspendRecovery({
    input,
    triggerTransactionId: 'big',
    savingsBorrowableCents: 50000,
  });
  const opt = plan.options.find((o) => o.code === 'borrow_from_savings')!;
  assert.equal(opt.viable, true);

  const required = opt.costFacts.borrowCents as number;
  // 关键断言：借入额 > 朴素缺口。因为借入会抬高 F → 抬高日基线 → 抬高 floor。
  assert.ok(
    required > plan.shortfallCents,
    `借入额 ${required} 必须大于朴素缺口 ${plan.shortfallCents}`,
  );
  assert.equal(opt.costFacts.naiveShortfallCents, plan.shortfallCents);
  assert.equal(opt.resultingRemainingCents, 120000 + required);
  assert.equal(opt.resultingNextMonthCarryoverCents, -required);

  // 借完之后必须真的退出保底模式（而不是还差一点点）
  const after = computeSnapshot(withSavingsReduced(input, required));
  assert.notEqual(after.state, 'smoothed');
  assert.ok(after.safeToSpendCents >= after.floorCents);
  // 再少借 1 分就不够 —— 证明返回的是满足条件的最小量级
  const justBelow = computeSnapshot(withSavingsReduced(input, required - 1));
  assert.equal(justBelow.state, 'smoothed');

  const poor = planOverspendRecovery({
    input,
    triggerTransactionId: 'big',
    savingsBorrowableCents: 5000,
  });
  const poorOpt = poor.options.find((o) => o.code === 'borrow_from_savings')!;
  assert.equal(poorOpt.viable, false);
  assert.equal(poorOpt.costKey, 'cost.savings_not_enough');
});

test('向储蓄借的额度求解器：未进入保底模式时返回 0', () => {
  const healthy = { ...severeInput(), today: '2026-09-05' };
  assert.equal(computeBorrowToExitFloor(healthy), 0);
  assert.ok(computeBorrowToExitFloor(severeInput()) > 0);
});

test('补救方案 ③：把大额标记为预算外 → 退出保底模式', () => {
  const plan = planOverspendRecovery({ input: severeInput(), triggerTransactionId: 'big' });
  const opt = plan.options.find((o) => o.code === 'mark_off_budget')!;
  assert.equal(opt.viable, true);
  assert.equal(opt.resultingRemainingCents, 420000);
  assert.equal(opt.resultingDailyCents, 38181); // 420000 / 11
  assert.equal(opt.costKey, 'cost.off_budget_recorded');
});

test('补救方案 ④：重排固定项（跳过一笔账单）→ 释放额度并提高日额度', () => {
  const plan = planOverspendRecovery({
    input: severeInput(),
    triggerTransactionId: 'big',
    skippableFixedIds: ['f2'],
  });
  const opt = plan.options.find((o) => o.code === 'rebalance_fixed')!;
  assert.equal(opt.viable, true);
  assert.equal(opt.resultingRemainingCents, 140000);
  assert.equal(opt.costFacts.releasedCents, 20000);
  assert.equal(opt.resultingDailyCents, 12727); // 140000 / 11

  const noTarget = planOverspendRecovery({ input: severeInput(), skippableFixedIds: [] });
  assert.equal(noTarget.options.find((o) => o.code === 'rebalance_fixed')!.viable, false);
});

test('记账即时反馈：这笔之后今天还能花多少（可能为负）', () => {
  const input = { ...severeInput(), transactions: severeInput().transactions.slice(0, 6) };
  const triage = triageTransactionAmount(input, 300000);
  assert.equal(triage.isBigTicket, true);
  assert.equal(triage.thresholdCents, 40000);
  assert.equal(triage.safeToSpendCents, 38181);
  assert.equal(triage.todayRemainingCents, 38181 - 300000);

  const tx = makeTransaction({
    id: 'x',
    budgetId: 'b',
    amountCents: 300000,
    localDate: TODAY,
  });
  assert.equal(simulateTransaction(input, tx).remainingCents, 120000);
});

test('跨月结转策略：结余按策略处理，透支一律如实结转（除 reset）', () => {
  const surplus = computeSnapshot({ ...severeInput(), today: '2026-09-05' });
  assert.equal(nextMonthCarryoverFromSnapshot(surplus), surplus.remainingCents);
  assert.equal(nextMonthCarryoverFromSnapshot(surplus, { carryoverPolicy: 'to_savings' }), 0);

  const deficit = computeSnapshot(severeInput());
  assert.equal(projectedCarryoverCents(deficit), -12000);
  assert.equal(nextMonthCarryoverFromSnapshot({ ...deficit, remainingCents: -80000 }), -80000);
  assert.equal(
    nextMonthCarryoverFromSnapshot({ ...deficit, remainingCents: -80000 }, { carryoverPolicy: 'reset' }),
    0,
  );
});

test('温和提醒的事实值：全部来自引擎，不给 LLM 编数字的机会', () => {
  const input = severeInput();
  const plan = planOverspendRecovery({ input, triggerTransactionId: 'big' });
  const facts = buildGentleMessageFacts(computeSnapshot(input), plan);
  assert.equal(facts.overByTodayCents, 300000 - 12000);
  assert.equal(facts.daysLeft, 11);
  assert.equal(facts.tomorrowDailyCents, 10909);
  assert.equal(facts.projectedGapCents, 144000);
  assert.equal(facts.dailyDragCents, 27273);
  assert.equal(facts.carryoverCents, -12000);
});
