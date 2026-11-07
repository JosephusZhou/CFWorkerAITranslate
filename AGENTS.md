# AGENTS.md

给后续维护者与自动化代理的项目约定。改动前先读完本文件与 `README.md`。

## 项目定位

一个运行在 Cloudflare Workers 上的翻译服务，用 Workers AI 的免费额度提供两类兼容接口：

- **DeepLX 风格**：`POST /translate`（JSON 进、`code/data` 出），面向 DeepLX 生态；
- **DeepL 官方风格**：`POST /v2/translate` 与 `/translate` 的表单请求（`translations[]` 出），面向 Easydict 等标准客户端。

目标是「最小可用、行为可预期」，不追求覆盖 DeepL 全部付费能力。做不到的能力必须在 README 的已知限制里写明，不要假装支持。

## 目录结构与职责

```text
src/index.js       唯一运行时代码。路由、鉴权、请求体解析、翻译流程、错误映射全在这里。
test/worker.test.js Node 内置 test runner 测试；`env.AI` 使用 stub，不访问 Cloudflare。
.github/workflows/ci.yml  GitHub Actions：push / pull_request 时跑 check + test。
wrangler.toml      部署配置。AI binding、可调变量、可选 KV；不放任何密钥。
package.json       仅开发期脚本：dev / deploy / check / test；无运行时依赖。
README.md          面向第一次接触仓库的使用文档（接口、部署、变量、限制）。
AGENTS.md          本文件：维护约定与技术约束。
LICENSE            MIT 许可证（Copyright (c) 2026 AITranslate contributors）。
```

约束：

- `src/index.js` 必须保持**零第三方依赖**，只用 Workers 运行时 API（`fetch`、`crypto.subtle`、`env.AI`、可选的 `env.CACHE`）。
- `wrangler.toml` 的 `main` 只指向 `src/index.js`。
- 不要新增构建步骤。`node --check src/index.js` 能过即可部署。
- 测试不得访问真实 Cloudflare 服务或消耗 Workers AI 配额；AI 调用一律用 stub 替换。

## 关键技术约束

### 1. Workers AI 配额与错误码

- 免费账号每日 10,000 Neurons，UTC 00:00（北京时间 08:00）重置；超出后免费账号返回 429 / `3036`，不会自动转付费。
- 文本生成类模型约 300 rpm，翻译类约 720 rpm；Free 计划另有 100,000 请求/天、10ms CPU 限制。
- 错误码必须经 `mapAIError` 转成稳定的 HTTP 语义，**禁止把上游原始异常直接抛给客户端**：

| AI 错误码 | 对外 HTTP | 含义 |
|---|---|---|
| `3036` | 429 | 当日免费配额耗尽（配置 KV 时写熔断标记） |
| `3040` | 429 | 上游容量不足，可重试 |
| `5035` | 403 | 模型需要 Workers Paid |
| `5016` | 403 | 未同意模型条款 |
| `3006` | 413 | 请求超过模型上限 |
| `3007` / `3008` | 504 | 推理超时 |
| 其他 429 | 429 | 被限流 |
| 其他 | 503 | 统一兜底 |

- `env.AI` 必须存在；缺失时返回 500 并提示检查 `[ai] binding = "AI"`。
- `wrangler dev` 的 AI 推理同样走远端并消耗真实配额。

### 2. 鉴权

- `TOKEN` 为空时**不校验**；设置后所有翻译请求都要校验。`GET /` 不校验。
- 支持的形式（改鉴权逻辑时必须全部保留）：

```http
Authorization: DeepL-Auth-Key <token>    # 大小写不敏感
Authorization: Bearer <token>
Authorization: <token>                   # 裸 key
DeepL-Auth-Key: <token>
X-Auth-Key: <token>
?token=<token> / ?auth_key=<token>
```

- 比较必须走 `safeEqual`（常量时间），不要用 `===`。
- 401 一律返回 `{"code":401,"message":"Invalid access token"}`，不要回显收到的值。
- 不要为排错向日志打印 token 明文或长度；历史诊断日志已移除。

### 3. 请求体：两种格式

| 来源 | Content-Type | 解析方式 |
|---|---|---|
| DeepLX / 一般 JSON 客户端 | `application/json` | `JSON.parse` |
| Easydict / DeepL 官方风格 | `application/x-www-form-urlencoded` | `URLSearchParams`，重复 `text` 视为批量 |

- Content-Type 缺失或标错时：先试 JSON，失败再试表单。
- 字段名固定为 `text`、`source_lang`、`target_lang`、`tag_handling`；缺省 `source_lang=auto`、`target_lang=en`（对齐参考实现）。
- 不要新增「看起来支持但实际不生效」的字段（如 `formality`、`context`、`glossary`）。

### 4. 响应格式

- 改动接口时**必须同时覆盖两种响应**，不能只改其中一种：
  - DeepLX：`{code, id, data, alternatives, source_lang, target_lang, method}`；批量时 `data` 为数组。
  - DeepL 官方：`{translations: [{detected_source_language, text}]}`；`auto` 时 `detected_source_language` 固定为 `"AUTO"`（无真实语言检测）。
- `/translate` 表单请求走 DeepL 官方响应；`/v2/translate` 无论 JSON 还是表单都走官方响应。
- 错误响应统一为 `{code, message}`，且 HTTP 状态码与 `code` 相同。

### 5. 模型切换

- 只通过 `MODEL` 环境变量切换，默认 `@cf/qwen/qwen3-30b-a3b-fp8`。
- 代码按模型名分支：`isM2M100()` 走 `{text, source_lang, target_lang}` 入参，其余走 chat messages。
- M2M100 不支持 `AUTO`，必须显式 `source_lang`，否则 400。
- 无论换哪个模型，都必须保留：显式 `max_tokens`、reasoning 清理、占位符校验、长文本分段。
- 新模型若改变输出结构，先补 `cleanOutput` 与回归，再改默认值。

### 6. 文本处理不变量

- 单请求总字符数上限 `MAX_TOTAL_CHARS`（默认 1500），超限 413。
- HTML/XML 标签保护使用 `⟦n⟧` 占位符；翻译后必须校验所有占位符都存在，缺失重试一次，仍失败返回 503。
- 长文本按 段落 → 句子 → 硬切分；硬切分不得从占位符中间切断。
- 输出清洗要处理：BOM、`<think>`/reasoning 块、`<text>` 包裹、代码块、成对引号、`Translation:` 类前缀。
- 批量结果顺序必须与输入顺序一致。

## 本地开发与验证

```bash
npm install
npx wrangler login      # AI 推理走远端，必须先登录
npm run dev             # http://localhost:8787
npm run check           # node --check src/index.js
npm run deploy
```

本地 Token：`.dev.vars` 写 `TOKEN=dev-token`（已被 `.gitignore` 忽略）。线上 Token 用 `npx wrangler secret put TOKEN`。

改动后至少跑通这几条：

1. JSON 单条 `/translate`（应返回 `data` 字符串）；
2. JSON 批量 `/translate`（应返回 `data` 数组且顺序一致）；
3. 表单单条 `/translate`（应返回 `translations[0].text`，Easydict 形态）；
4. 表单批量 `/v2/translate`；
5. 无 token → 401；带 `DeepL-Auth-Key` → 200；
6. 缺 `text` → 400；超 1500 字符 → 413。

## 修改约定

- **不要硬编码任何密钥、Token、账号 ID、子域名或真实部署地址**。示例一律用 `<your-domain>`、`<token>` 这类占位符。
- 不要把 `.dev.vars`、`.wrangler/`、`.wrangler-home/`、`.env*` 提交进仓库。
- 不新增依赖；确需新增时先说明理由并确认能被 wrangler 打包。
- 改路由或响应字段必须同步更新 `README.md` 与 `AGENTS.md`。
- 未验证的能力写进「已知限制」，不要写进「支持」。
- 删除功能时一并删除对应分支、注释与文档，不保留向后兼容的空壳。
- 提交前跑 `npm run check`，并按上面的验证清单做一次真实回归。
- 许可证：本项目采用 MIT（见 `LICENSE`）。修改版权人或更换许可证需维护者确认。
