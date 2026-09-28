# payment_monthly — 极简月度预算 App 的领域层与计算引擎

只回答三个问题的预算 App 的**数据模型 + 核心算法**实现：

1. 本月总收入 / 可用资金
2. 固定必要开销 + 计划储蓄（房租、水电网、保险、每月固定存入）
3. **剩余可支配余额** → 折算成**「今天安全可花额度」**

设计理念与交互逻辑见上一份产品设计稿；本仓库是其**工程落地**：两端同源、离线优先、金额零漂移。

---

## 目录结构

```
payment_monthly/
├── index.html                        # ★单文件 App（内联 CSS/JS），GitHub Pages 直接可用
├── docs/architecture.md              # ★架构决策记录(ADR) + 公式语义 + 状态机 + 异常清单
├── prompts/financial_agent.system.md # ★AI 财务助理「月月」的 System Prompt
├── schemas/budget.schema.json        # 领域模型契约（JSON Schema 2020-12）
├── schemas/agent_input.schema.json   # AI 助理输入契约（5 个核心字段 + 引擎派生块）
├── fixtures/golden_cases.json        # ★黄金测试向量（TS / Python / 网页版三方共用）
├── fixtures/agent_eval_cases.json    # ★AI 助理评估用例（few-shot 数字绑定到引擎结果）
├── tools/validate_webapp_core.js     # 网页版逻辑 vs 黄金向量（250 项检查）
├── packages/core/                    # 端侧权威引擎（TypeScript，零运行时依赖）
│   ├── src/money.ts                  #   整数分运算 / 最大余数法分配 / 跨语言一致舍入
│   ├── src/calendar.ts               #   本地自然日工具（时区安全、账单日越界处理）
│   ├── src/models.ts                 #   实体定义 + 运行时校验 + 工厂函数
│   ├── src/engine.ts                 #   computeSnapshot 等核心计算 + 告警
│   ├── src/reschedule.ts             #   大额超支后的额度重排与补救方案
│   └── test/*.test.ts                #   36 个测试（含黄金向量一致性）
├── backend/budget_app/               # 后端镜像实现（Python + Pydantic v2）
│   ├── money.py / models.py
│   └── engine.py                     #   与 engine.ts / reschedule.ts 逐函数镜像
├── tests/test_engine.py              #   23 个 pytest（含与 TS 的逐位一致性）
├── tests/test_agent_prompt.py        #   32 个 pytest（Prompt 与引擎数字绑定）
└── Makefile                          # make test = 全量测试；make serve = 本地起服务
```

---

## 快速开始

```bash
# 1) 端侧引擎测试（TypeScript）
cd packages/core
npm install
npx tsc -p tsconfig.json
node dist/test/money.test.js && node dist/test/engine.test.js \
  && node dist/test/reschedule.test.js && node dist/test/golden.test.js

# 2) 网页版逻辑独立验证（抽自 index.html，250 项断言）
node tools/validate_webapp_core.js

# 3) 后端镜像测试（Python）
cd ../..
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python -m pytest tests -q

# 4) 一次跑完全部三端 + 提示词套件
make test

# 5) 本地启动网页版体验
make serve          # 打开 http://localhost:8080 即可在浏览器/手机体验
```

---

## 零依赖单文件移动 Web App（`index.html`）

仓库根目录的 `index.html` 是一个**无需任何构建步骤、零外部运行时依赖、自包含 CSS/JS** 的现代移动 Web 账本，可直接丢进 GitHub Pages 运行。

### 功能清单

- **两主数字英雄区**：超大字号展示「本月还能花」（余额）与「今天还能花」（根据当月保底与剩余天数动态算出的安全日额度）；卡片带状态药丸（🟢 正常 / 🟡 偏快 / 🔵 摊销中 / 🔴 超支 / ⚪️ 刚起步）。
- **自然语言极速记账（AI 驱动 + 本地双保底）**：
  - 支持直接输口语，如：`打车 35`、`买咖啡 15 块`、`冲动买了双鞋 899`、`退货昨天的衣服 120`。
  - **有 Key 时**：调用 OpenAI 或 DeepSeek 的 `/chat/completions` 解析结构化 JSON（金额、用途、必要/非必要、是否退款、是否大额摊销、是否计入预算）。
  - **无 Key / 网络超时 / API 报错时**：自动秒级降级为**纯本地正则解析器**，永不丢输入、不弹阻塞 alert。
  - **一键切换**：必要 / 想要 / 退款 快捷胶囊。
- **今日明细与撤销**：单笔流水支持一键删除，被删交易不参与任何预算计算。
- **大额消费平滑（Amortization）**：单笔大额消费（> 2 倍日基线）自动按当月剩余天数摊销，避免单日额度瞬间被砸死；UI 显式展示摊销天数与每日分摊拖累。
- **固定开销抽屉**：管理房租、宽带、月租等；支持标记「已付」或「本月跳过」，支持实际扣款金额微调。
- **储蓄目标卡片**：本月计划攒下的目标金额，自动锁死在 committed 预留区。
- **数据管理与重置**：纯本地 `localStorage` 持久化；提供「重置为示例账本」（预填 10000 收入 / 3500 房租 / 2000 储蓄 / 若干流水）与「清空所有数据」能力。
- **月度穿梭**：支持上个月 / 下个月切换查看与预算配置。

### 部署到 GitHub Pages

1. 在 GitHub 仓库设置里进入 **Settings → Pages**。
2. **Build and deployment** 选择 `Deploy from a branch`。
3. Branch 选择 `main`（或你的默认分支），目录选择 `/ (root)`，点击 **Save**。
4. 几分钟后即可通过 `https://<用户名>.github.io/<仓库名>/` 在手机或电脑浏览器访问。可直接在 iOS Safari 点击「添加到主屏幕」当成独立 PWA/Web App 使用。

### 关于 API Key 与 CORS（跨域）的现实说明

- **安全性**：Key 只保存在当前浏览器的 `localStorage`（若勾选"记住"）或 `sessionStorage`（会话结束即焚），**绝不上传任何第三方服务器**，代码全公开透明。
- **CORS 跨域限制**：
  - OpenAI 官方接口 (`api.openai.com`) **不支持浏览器直接跨域调用**（无 `Access-Control-Allow-Origin` 头）。
  - DeepSeek 官方接口视其服务端 CORS 策略而定。
  - **最佳实践**：在设置抽屉中填写你的**自建转发地址**（见下方 10 行 Cloudflare Worker），或使用任何 OpenAI 兼容的反代服务。
  - **免配置模式**：即便完全不填 Key、不配代理，内置的本地正则引擎也完全能应付日常记账（「打车 35」、「买咖啡 15 块」秒级秒记）。

<details>
<summary>附：10 行 Cloudflare Worker CORS 代理参考</summary>

```js
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }
    const target = "https://api.openai.com/v1/chat/completions";
    const res = await fetch(target, { method: request.method, headers: request.headers, body: request.body });
    const responseHeaders = new Headers(res.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  },
};
```
</details>

---

## 用法

### TypeScript（端侧）

```ts
import { computeDashboard, makeBudget, makeFixedExpense, makeSavingsGoal } from '@budget/core';

const { snapshot, alerts } = computeDashboard({
  budget: makeBudget({ id: 'b1', month: '2026-09', incomeCents: 1_000_000 }),
  fixedExpenses: [
    makeFixedExpense({
      id: 'f1', budgetId: 'b1', name: '房租',
      estimatedCents: 350_000, dueDay: 1, status: 'paid', reservedAt: '2026-09-01',
    }),
  ],
  savingsGoals: [makeSavingsGoal({ id: 'g1', budgetId: 'b1', targetCents: 300_000 })],
  transactions: [ /* DailyTransaction[] */],
  today: '2026-09-20',
});

snapshot.remainingCents      // 本月还能花（分）        ← 首页主数字
snapshot.safeToSpendCents    // 今天还能花（分）        ← 首页副主数字
snapshot.state               // healthy | watch | smoothed | overdrawn | onboarding
snapshot.monthEndAdjustmentCents // 负值 = 由下月承担的缺口
alerts[0]?.messageKey        // 文案 key，facts 里是全部数字（交给 LLM 只做措辞）
```

大额超支后的重排：

```ts
import { planOverspendRecovery, rescheduleDailyAllowances } from '@budget/core';

const plan = planOverspendRecovery({
  input,
  triggerTransactionId: 'tx-laptop',
  savingsBorrowableCents: 50_000,
  skippableFixedIds: ['f-subscription'],
});
plan.level                          // none | minor | severe | critical
plan.schedule                       // 未来 7 天的每日额度排期
plan.options                        // 4 个补救选项，每个都带 resultingDailyCents 与代价
```

### Python（后端对账）

```python
from budget_app import compute_snapshot, plan_overspend_recovery, SnapshotInput

snapshot = compute_snapshot(SnapshotInput(budget=..., today="2026-09-20"))
assert snapshot.safe_to_spend_cents == ts_reported_safe_to_spend   # 与端侧对账
```

---

## AI 财务助理（「月月」）层

| 文件 | 作用 |
|---|---|
| `prompts/financial_agent.system.md` | 系统提示词：角色、三项职责、输入契约、数学口径、输出风格、健康度阈值、安全边界、3 个 few-shot |
| `schemas/agent_input.schema.json` | 输入契约：5 个核心字段（`month_income / fixed_costs / target_savings / spent_so_far / days_left`）+ 可选引擎派生块 `derived` |
| `fixtures/agent_eval_cases.json` | 评估用例：健康 / 严重超支 / 自然语言问答，含引擎权威值与「提示词必须引用的展示串」 |
| `tests/test_agent_prompt.py` | 把提示词与引擎绑定：金额、公式、格式、行数、禁用词、危机模式全部受测 |

设计要点（呼应 `docs/architecture.md` ADR-009）：

- **提示词里的公式与引擎逐值相等**：测试按提示词 §3 重写一遍公式并断言与引擎结果一致，所以模型唯一被允许的手算路径不会算错。
- **few-shot 的每个金额都来自引擎**：`prompt_must_contain` 里的串会被正则抽出金额，再反向断言它在引擎结果中存在 —— 不允许提示词里出现"凭空的钱"。
- **`derived` 优先**：payload 带了引擎派生值时，模型必须直接采用，禁止重算；只有「假设性问题」才允许重算且必须标注。
- **金额格式有代码参考实现**：`format_display()`（整数省略小数、非整数保留 2 位），保证 UI 与 AI 回复里的金额长得一模一样。

---

## 核心公式

```
committed     = Σ固定开销(actual ?? estimated, skipped=0) + Σ计划储蓄
discretionary = 收入 + 上月结转 − committed          # 可自由支配总额 F
remaining     = discretionary − 已花弹性支出          # ★本月还能花
baseline      = floor(discretionary / 当月天数)        # 日基线 B（常量锚）
floor         = floor(baseline × 0.6)                 # 保底线
live          = floor(max(remaining,0) / 剩余天数含今天)
safeToSpend   = live ≥ floor ? live : floor           # ★今天还能花
```

**关键机制**

| 机制 | 作用 |
|---|---|
| 预留 vs 实付分离 | 月初就锁住房租，发薪后不会把房租花掉；浮动账单差额自动回冲 |
| 保底线 + 月末调节项 | 大额超支后日额度不崩盘（可行动），但缺口显式记账并结转下月（不撒谎） |
| 大额按日摊销 | 真值余额立刻扣，但「节奏判断」按天摊 → AI 不会冤枉用户「花太快」 |
| 实时 remaining 分摊 | 昨日的结余/超支天然滚入今天，无需「结转」这种需要解释的概念 |
| 整数分 + 最大余数法 | `Σ每日额度 === remaining`，永不出现 1 分钱对不上 |
| 幂等键 + 版本号 | 离线补传重复上报不会重复扣钱 |

---

## 已验证的关键数字（可复现）

场景：月入 ¥10,000，固定 ¥2,500 + 储蓄 ¥1,500，9/20 买 ¥3,000 电脑（`fixtures` 第 2 例）

| 指标 | 值 |
|---|---|
| 可自由支配总额 | ¥6,000 |
| 当月已花 | ¥4,800 |
| 剩余可支配余额 | ¥1,200（真值） |
| 真值日均 | ¥109.09 |
| **今日安全可花（保底）** | **¥120** |
| 月末调节项 | −¥120（结转下月） |
| 节奏口径支出 | ¥2,072.73 → 不触发「花太快」 |
| 退出保底所需的最小借入额 | ¥153.77（朴素缺口只有 ¥120，必须解不动点） |

---

## 测试与一致性保证

```bash
make test          # TS 36 例 + Python 55 例
```

其中最重要的是两类测试：

1. **跨语言一致性**：`fixtures/golden_cases.json` 被 TS 与 Python 两侧同时读取，逐字段比对。只要一端改算法忘了同步另一端，CI 立刻红。
2. **Prompt ↔ 引擎绑定**（`tests/test_agent_prompt.py`）：AI 助理提示词的 few-shot 里出现的每个金额，都必须等于引擎的权威计算结果；提示词的公式实现必须与引擎逐值相等；金额格式、行数上限、禁用词、危机模式全部有静态检查。**提示词也被当作代码来测。**

开发期间这套测试已抓出 3 个真实缺陷：未来日期污染余额、预算外交易误入摊销、借入额不动点算错。

---

## 进一步阅读

- `docs/architecture.md` — ADR、公式语义、状态机、边界清单、同步策略、扩展点
- `schemas/budget.schema.json` — 字段级契约（可据此生成 TS 类型 / Pydantic 模型 / OpenAPI）
