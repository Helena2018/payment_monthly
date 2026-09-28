default: test

# ---- 端侧引擎（TypeScript）----
build:
	cd packages/core && npx tsc -p tsconfig.json

test-ts: build
	cd packages/core && node dist/test/money.test.js && node dist/test/engine.test.js && node dist/test/reschedule.test.js && node dist/test/golden.test.js

# ---- 网页版（index.html 内联逻辑）----
# 把 index.html 里的纯逻辑抽出来跑同一份黄金向量，保证网页版与引擎逐位一致
validate-web:
	node tools/validate_webapp_core.js

# ---- 后端镜像（Python）----
venv:
	python3 -m venv .venv && .venv/bin/python -m pip install --quiet --upgrade pip -r backend/requirements.txt

test-py:
	.venv/bin/python -m pytest tests -q

test: test-ts validate-web test-py

serve:
	python3 -m http.server 8080

.PHONY: default build test-ts validate-web venv test-py test serve
