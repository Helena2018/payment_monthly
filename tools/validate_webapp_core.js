#!/usr/bin/env node
/**
 * validate_webapp_core.js — 验证 index.html 里的纯逻辑核心与 Python/TS 引擎逐位一致。
 *
 * 做法：把 index.html 中 ==CORE_START== / ==CORE_END== 之间的代码抽出来，
 * 在 Node 里执行，然后跑 fixtures/golden_cases.json 的同一份 10 个黄金向量。
 * 断言字段与 tests/test_engine.py 的 assertable_view 完全对应。
 *
 * 运行：node tools/validate_webapp_core.js
 * 退出码：0 = 全部一致；1 = 有偏差（会打印具体字段）
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");
const FIXTURES_PATH = path.join(ROOT, "fixtures", "golden_cases.json");

function loadCore() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const markerAt = html.indexOf("==CORE_START==");
  if (markerAt < 0) throw new Error("index.html 中找不到 CORE_START 标记");
  // 标记本身在注释里：从包含它的注释结束处开始切
  const commentEnd = html.indexOf("*/", markerAt);
  if (commentEnd < 0) throw new Error("CORE_START 注释未闭合");
  const codeStart = commentEnd + 2;
  const codeEnd = html.indexOf("/* ==CORE_END== */");
  if (codeEnd < 0 || codeEnd <= codeStart) throw new Error("index.html 中找不到 CORE_END 标记");
  const code = html.slice(codeStart, codeEnd);
  // 用 Function 构造器执行；块内会自行挂载 globalThis.Core
  const factory = new Function(code + "\n;return globalThis.Core;");
  const core = factory();
  if (!core || typeof core.computeSnapshot !== "function") {
    throw new Error("CORE 块没有正确导出 Core 对象");
  }
  return core;
}

/** 与 TS/Python 侧一致的「远离零」舍入（避免 .5 处规则分歧） */
function roundHalfAwayFromZero(value) {
  if (value === 0) return 0;
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

function assertableView(core, testCase) {
  const budget = testCase.budget || {};
  const snap = core.computeSnapshot({
    month: budget.month,
    today: testCase.today,
    incomeCents: budget.incomeCents || 0,
    carryoverCents: budget.carryoverCents || 0,
    fixed: testCase.fixedExpenses || [],
    savings: testCase.savingsGoals || [],
    transactions: testCase.transactions || [],
  });
  return {
    totalDays: snap.totalDays,
    elapsedDays: snap.elapsedDays,
    daysLeft: snap.daysLeft,
    fixedSkippedCents: snap.fixed.skippedCents,
    hardExpenseCents: snap.hardExpenseCents,
    savingsCents: snap.savingsCents,
    committedCents: snap.committedCents,
    discretionaryCents: snap.discretionaryCents,
    baselineCents: snap.baselineCents,
    floorCents: snap.floorCents,
    spentCents: snap.spentCents,
    remainingCents: snap.remainingCents,
    liveBaselineCents: snap.liveBaselineCents,
    safeToSpendCents: snap.safeToSpendCents,
    todaySpentCents: snap.todaySpentCents,
    todayRemainingCents: snap.todayRemainingCents,
    monthEndAdjustmentCents: snap.monthEndAdjustmentCents,
    paceSpentCents: snap.paceSpentCents,
    paceGapBp: roundHalfAwayFromZero(snap.paceGap * 10000),
    projectedMonthEndRemainingCents: snap.projectedMonthEndRemainingCents,
    amortizedCount: snap.amortization.length,
    amortizedSpreadDays: snap.amortization.length ? snap.amortization[0].spreadDays : 0,
    amortizedDailyDragCents: snap.amortization.length ? snap.amortization[0].dailyDragCents : 0,
    state: snap.state,
  };
}

function main() {
  const core = loadCore();
  const cases = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8")).cases;
  let failures = 0;
  let checks = 0;

  console.log("验证 index.html 内联逻辑 vs fixtures/golden_cases.json\n");
  for (const testCase of cases) {
    const actual = assertableView(core, testCase);
    const diffs = [];
    for (const [key, expected] of Object.entries(testCase.expectSnapshot)) {
      checks += 1;
      if (actual[key] !== expected) {
        diffs.push("    " + key + ": 期望 " + expected + "，网页版 " + actual[key]);
      }
    }
    if (diffs.length) {
      failures += 1;
      console.log("✗ " + testCase.name);
      console.log(diffs.join("\n"));
    } else {
      console.log("✓ " + testCase.name + "  (" + Object.keys(testCase.expectSnapshot).length + " 项断言)");
    }
  }

  // 额外：核心工具的单元检查（与 Python 侧 money.py 的单测同源）
  const extras = [
    ["allocate(100,3)", JSON.stringify(core.allocate(100, 3)), "[34,33,33]"],
    ["allocate 总和", core.sumCents(core.allocate(300000, 11)), 300000],
    ["CURRENCY.code", core.CURRENCY.code, "NZD"],
    ["CURRENCY.symbol", core.CURRENCY.symbol, "$"],
    ["CURRENCY.colloquial", core.CURRENCY.colloquial, "刀"],
    ["fmtCents(7380)", core.fmtCents(7380), "$73.80"],
    ["fmtCents(60500)", core.fmtCents(60500), "$605"],
    ["fmtCents(126000)", core.fmtCents(126000), "$1,260"],
    ["fmtCents(-12000)", core.fmtCents(-12000), "-$120"],
    ["fmtCents(7380,'NZ$')", core.fmtCents(7380, "NZ$"), "NZ$73.80"],
    ["resolveDueDay(2月,31)", core.resolveDueDay("2026-02", 31), "2026-02-28"],
    ["daysLeftInclusive", core.daysLeftInclusive("2026-09", "2026-09-30"), 1],
    ["yuanToCents('0.1')", core.yuanToCents("0.1"), 10],
    ["parseQuickEntry('打车 35').amountCents", core.parseQuickEntry("打车 35").amountCents, 3500],
    ["parseQuickEntry('打车 35').note", core.parseQuickEntry("打车 35").note, "打车"],
    ["parseQuickEntry('打车 35').necessity", core.parseQuickEntry("打车 35").necessity, "necessary"],
    // 币种：优先解析 $ / 刀 / NZD
    ["parseQuickEntry('打车 $35').amountCents", core.parseQuickEntry("打车 $35").amountCents, 3500],
    ["parseQuickEntry('打车 $35').note", core.parseQuickEntry("打车 $35").note, "打车"],
    ["parseQuickEntry('打车 NZ$35').amountCents", core.parseQuickEntry("打车 NZ$35").amountCents, 3500],
    ["parseQuickEntry('打车 35$').amountCents", core.parseQuickEntry("打车 35$").amountCents, 3500],
    ["parseQuickEntry('打车 35 刀').amountCents", core.parseQuickEntry("打车 35 刀").amountCents, 3500],
    ["parseQuickEntry('打车 35 刀').note", core.parseQuickEntry("打车 35 刀").note, "打车"],
    ["parseQuickEntry('打车 刀35').amountCents", core.parseQuickEntry("打车 刀35").amountCents, 3500],
    ["parseQuickEntry('打车 NZD 35').amountCents", core.parseQuickEntry("打车 NZD 35").amountCents, 3500],
    ["parseQuickEntry('打车 NZD 35').note", core.parseQuickEntry("打车 NZD 35").note, "打车"],
    ["parseQuickEntry('打车 35 NZD').amountCents", core.parseQuickEntry("打车 35 NZD").amountCents, 3500],
    ["parseQuickEntry('打车 35 纽币').amountCents", core.parseQuickEntry("打车 35 纽币").amountCents, 3500],
    ["pickAmountText('昨天 2 号 打车 $35')", core.pickAmountText("昨天 2 号 打车 $35"), "35"],
    ["带币种的金额优先于裸数字", core.parseQuickEntry("昨天 2 号 打车 $35").amountCents, 3500],
    ["未标记的裸数字不进备注清洗（单笔 API 保留原样）", core.parseQuickEntry("买菜 $30 加油 40").note, "买菜 加油 40"],
    ["parseQuickEntries('买菜 $30 加油 40') 笔数", core.parseQuickEntries("买菜 $30 加油 40").length, 2],
    ["parseQuickEntries('买菜 $30 加油 40') 金额", JSON.stringify(core.parseQuickEntries("买菜 $30 加油 40").map((e) => e.amountCents)), "[3000,4000]"],
    ["parseQuickEntries('买菜 $30 加油 40') 备注", JSON.stringify(core.parseQuickEntries("买菜 $30 加油 40").map((e) => e.note)), '["买菜","加油"]'],
    ["买咖啡 15 刀", core.parseQuickEntry("买咖啡 15 刀").note, "买咖啡"],
    ["旧写法仍兼容（15 块）", core.parseQuickEntry("买咖啡 15 块").note, "买咖啡"],
    ["旧写法仍兼容（35 元）", core.parseQuickEntry("打车 35 元").amountCents, 3500],
    ["parseQuickEntry('退款 50').isRefund", core.parseQuickEntry("退款 50").isRefund, true],
    ["parseQuickEntry('退款 -$50').amountCents", core.parseQuickEntry("退款 -$50").amountCents, 5000],
    ["parseQuickEntry('退款 -$50').isRefund", core.parseQuickEntry("退款 -$50").isRefund, true],
    ["parseQuickEntry('退款 -$50') 备注不留符号", core.parseQuickEntry("退款 -$50").note, "未备注"],
    ["parseQuickEntry('随便逛逛')", core.parseQuickEntry("随便逛逛"), null],
    // 多笔拆分（「打车 35 / 买咖啡 15」→ 两条独立记录）
    ["splitQuickEntries('打车 35 / 买咖啡 15').length", core.splitQuickEntries("打车 35 / 买咖啡 15").length, 2],
    ["splitQuickEntries('打车 35').length", core.splitQuickEntries("打车 35").length, 1],
    ["splitQuickEntries('打车 $35 / 买咖啡 15 刀')", JSON.stringify(core.splitQuickEntries("打车 $35 / 买咖啡 15 刀")), '["打车 $35","买咖啡 15 刀"]'],
    ["parseQuickEntries('打车 35 / 买咖啡 15').length", core.parseQuickEntries("打车 35 / 买咖啡 15").length, 2],
    ["parseQuickEntries 币种混写", core.parseQuickEntries("打车 $35 / 买咖啡 15 刀 / 超市 NZD 120").length, 3],
    ["parseQuickEntries 币种混写金额", JSON.stringify(core.parseQuickEntries("打车 $35 / 买咖啡 15 刀 / 超市 NZD 120").map((e) => e.amountCents)), "[3500,1500,12000]"],
    ["parseQuickEntries 第 2 笔金额", core.parseQuickEntries("打车 35 / 买咖啡 15")[1].amountCents, 1500],
    ["parseQuickEntries 第 2 笔备注", core.parseQuickEntries("打车 35 / 买咖啡 15")[1].note, "买咖啡"],
    ["parseQuickEntries 第 2 笔必要性", core.parseQuickEntries("打车 35 / 买咖啡 15")[1].necessity, "optional"],
    ["parseQuickEntries 换行分隔", core.parseQuickEntries("打车 35\n买咖啡 15").length, 2],
    ["parseQuickEntries 空格分隔", core.parseQuickEntries("打车 35 买咖啡 15").length, 2],
    ["parseQuickEntries 顿号+连接词", core.parseQuickEntries("打车 35、买咖啡 15 还有午饭 28").length, 3],
    ["parseQuickEntries 单笔长度", core.parseQuickEntries("打车 35").length, 1],
    ["parseQuickEntries 退款标记", core.parseQuickEntries("退款 50 / 超市 120")[0].isRefund, true],
    ["parseQuickEntries('随便逛逛')", JSON.stringify(core.parseQuickEntries("随便逛逛")), "[]"],
  ];
  console.log("");
  for (const [label, got, want] of extras) {
    checks += 1;
    const ok = got === want;
    if (!ok) failures += 1;
    console.log((ok ? "✓ " : "✗ ") + label + (ok ? "" : " → 期望 " + want + "，实际 " + got));
  }

  // DOM 静态检查：JS 里引用的每个 id 都必须真实存在（单文件应用最常见的运行时崩溃来源）
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const declared = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) declared.add(m[1]);
  const referenced = new Set();
  for (const m of html.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(m[1]);
  for (const m of html.matchAll(/getElementById\("([^"]+)"\)/g)) referenced.add(m[1]);

  console.log("");
  const missing = [...referenced].filter((id) => !declared.has(id));
  checks += referenced.size;
  if (missing.length) {
    failures += missing.length;
    console.log("✗ JS 引用了不存在的 id：" + missing.join(", "));
  } else {
    console.log("✓ DOM id 引用完整（" + referenced.size + " 个引用全部存在）");
  }

  // 结构检查：标签配平与脚本闭合
  const structural = [
    ["<script> 与 </script> 数量一致", (html.match(/<script/g) || []).length, (html.match(/<\/script>/g) || []).length],
    ["<body> 与 </body> 数量一致", (html.match(/<body/g) || []).length, (html.match(/<\/body>/g) || []).length],
    ["<style> 与 </style> 数量一致", (html.match(/<style/g) || []).length, (html.match(/<\/style>/g) || []).length],
  ];
  for (const [label, a, b] of structural) {
    checks += 1;
    const ok = a === b && a > 0;
    if (!ok) failures += 1;
    console.log((ok ? "✓ " : "✗ ") + label + "（" + a + " / " + b + "）");
  }

  console.log("\n共 " + checks + " 项检查，" + (failures ? failures + " 项不一致 ✗" : "全部一致 ✓"));
  process.exit(failures ? 1 : 0);
}

main();
