/**
 * @budget/core — 月度预算端侧权威引擎
 *
 * 使用方式（端侧 / 服务端同一份代码）：
 *   const { snapshot } = computeDashboard({ budget, fixedExpenses, savingsGoals, transactions, today });
 *   snapshot.safeToSpendCents        // 今天还能花多少（分）
 *   snapshot.remainingCents          // 本月还剩多少可支配（分）
 *   snapshot.state                   // healthy | watch | smoothed | overdrawn | onboarding
 */

export * from './money';
export * from './calendar';
export * from './models';
export * from './engine';
export * from './reschedule';
