# CFWorkerAITranslate

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/JosephusZhou/CFWorkerAITranslate/actions/workflows/ci.yml/badge.svg)](https://github.com/JosephusZhou/CFWorkerAITranslate/actions/workflows/ci.yml)

用 **Cloudflare Workers AI** 免费额度提供 DeepLX / DeepL 兼容的翻译接口。默认模型 `@cf/qwen/qwen3-30b-a3b-fp8`，单文件实现、无第三方运行时依赖。

适合这些场景：

- 给 Easydict 等支持「自定义 DeepL 接口」的客户端做后端；
- 需要一个零运维、按天限额的轻量翻译 API；
- 想换模型做实验，但不想自己搭服务。

## 目录结构

```text
.
├── src/index.js                          # Worker 实现（唯一运行时代码）
├── test/worker.test.js                   # Node 内置 test runner 测试
├── .github/workflows/ci.yml              # GitHub Actions CI
├── wrangler.toml                         # AI binding、变量、可选 KV
├── package.json                          # dev / deploy / check / test 脚本
├── README.md
├── AGENTS.md                             # 给后续维护者/AI 的约定与约束
└── LICENSE                               # MIT
```

## 前置条件

- **Node.js 22 或更高**（当前 wrangler 4.x 要求 `node >= 22`）。用 `node -v` 确认；版本过低时先升级 Node。
- 一个 **Cloudflare 账号**（免费计划即可）。
- 账号已启用 **Workers AI**（免费计划默认开启，每日 10,000 Neurons，UTC 00:00 / 北京时间 08:00 重置）。
- 免费额度用尽后接口返回 `429`，不会自动转付费；Free 计划另有 100,000 请求/天限制。
- 能正常访问 Cloudflare API 的网络环境。

## 从零开始：本地运行与部署

以下命令默认在项目根目录（`package.json` 所在目录）执行，可以直接复制。

### 1. 获取代码

```bash
git clone https://github.com/JosephusZhou/CFWorkerAITranslate.git AITranslate
cd AITranslate
```

也可以直接在仓库页面下载 ZIP 解压后进入目录。

### 2. 安装依赖

```bash
npm install
```

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页，点击允许即可。确认登录状态：

```bash
npx wrangler whoami
```

### 4. 本地跑起来并自测

```bash
npm run dev
```

默认监听 `http://localhost:8787`。**注意**：本地开发也会调用远端 Workers AI，会消耗真实配额。

另开一个终端测试：

```bash
curl -s http://localhost:8787/translate \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello, world!","target_lang":"ZH"}'
```

期望返回类似 `{"code":200,...,"data":"你好，世界！"}`。

如果本地也想启用鉴权，写一个 `.dev.vars`（已被 `.gitignore` 忽略）：

```bash
echo 'TOKEN=dev-token' > .dev.vars
npm run dev
```

之后本地请求要带 `-H 'Authorization: DeepL-Auth-Key dev-token'`。

### 5. 可选：修改 Worker 名称

打开 `wrangler.toml`，把第一行改成你喜欢的名字：

```toml
name = "my-deeplx"
```

- 名称只能是小写字母、数字和连字符，且在账号内唯一；
- 名称决定免费域名：`https://<name>.<你的子域名>.workers.dev`；
- 不改也可以，默认是 `ai-deeplx`。

同时确认 `workers_dev = true`（默认已开启），否则不会分配 `workers.dev` 地址。

### 6. 首次部署

```bash
npm run deploy
```

部署成功后终端会打印类似：

```text
https://ai-deeplx.<你的子域名>.workers.dev
```

记下这个地址，后面配置客户端要用。

第一次部署前，账号侧还需要确认：

- Workers AI 在账号中可用（免费计划默认开启，每日 10,000 Neurons）；
- 使用 Llama 等模型前，需在 Cloudflare Dashboard 的 Workers AI 页面同意模型条款，否则返回 `403 / 5016`。

### 7. 设置访问 Token（强烈建议）

生成一个足够强的随机串：

```bash
openssl rand -hex 24
```

复制输出的 48 位字符串，然后执行：

```bash
npx wrangler secret put TOKEN
```

按提示粘贴刚才的字符串并回车。设置成功后立即生效，**不需要重新部署**。

> 如果提示找不到 Worker，先执行一次 `npm run deploy` 创建 Worker，再回来设置 secret。
>
> 不设置 `TOKEN` 时接口完全公开，任何人都能消耗你的免费配额，公网部署务必设置。
>
> 如需非交互写入：`printf '%s' '<你的 token>' | npx wrangler secret put TOKEN`。

### 8. 验证线上接口

把下面命令里的 `<worker-name>`、`<你的子域名>`、`<TOKEN>` 替换成实际值：

```bash
curl -s "https://<worker-name>.<你的子域名>.workers.dev/translate" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: DeepL-Auth-Key <TOKEN>' \
  -d '{"text":"Hello, world!","target_lang":"ZH"}'
```

成功时返回 `data` 为中文译文。再确认鉴权生效：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<worker-name>.<你的子域名>.workers.dev/translate" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hi"}'
```

应输出 `401`。

### 9. 查看实时日志

```bash
npx wrangler tail
```

排错时在另一个终端发请求，即可看到 Worker 的 `console` 输出与异常。

## 在 Easydict 中配置

1. 打开 Easydict → 设置 → 翻译服务 → DeepL；
2. 「API 地址」填**完整地址**，例如 `https://<worker-name>.<你的子域名>.workers.dev/translate`；
3. 「Auth Key」填第 7 步设置的 `TOKEN` 明文；
4. 不要勾选需要官方向 API 才能用的功能（术语表、formality 等）。

Easydict 会把 API 地址原样作为请求 URL，不会在末尾追加 `/v2/translate` 或 `/translate`，所以不会出现 `/translate/translate`。地址留空时它会请求官方 `api.deepl.com`。

## 支持的接口

| 路径 | 方法 | 请求体 | 响应 |
|---|---|---|---|
| `/translate` | `POST` | JSON（DeepLX 风格） | `{code, id, data, alternatives, source_lang, target_lang, method}` |
| `/translate` | `POST` | 表单（DeepL 官方风格） | `{translations: [{detected_source_language, text}]}` |
| `/v2/translate` | `POST` | JSON 或表单 | `{translations: [{detected_source_language, text}]}` |
| `/translate` | `GET` | — | 纯文本 `Please use POST method :)` |
| `/` | `GET` | — | 当前模型与限制信息 |
| `/v1/translate` | 任意 | — | `501`（未实现） |

- `text` 传字符串是单条，传字符串数组是批量（表单里重复 `text` 字段等价于批量）。
- `source_lang` 缺省 `auto`，`target_lang` 缺省 `en`。
- `tag_handling` 支持 `html` / `xml`，会把标签替换成占位符保护起来，翻译后还原。
- `Content-Type` 缺失或标错时，会先按 JSON 解析，失败再按表单解析。
- 跨域预检 `OPTIONS` 返回 `204`，响应带 `Access-Control-Allow-*`。

JSON 示例：

```bash
curl -s https://<你的域名>/translate \
  -H 'Content-Type: application/json' \
  -H 'Authorization: DeepL-Auth-Key <你的 TOKEN>' \
  -d '{"text":["Hello, world!","Good morning"],"target_lang":"ZH"}'
```

表单示例（等价于 DeepL 官方 API）：

```bash
curl -s https://<你的域名>/v2/translate \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Authorization: DeepL-Auth-Key <你的 TOKEN>' \
  --data-urlencode 'text=Hello, world!' \
  --data-urlencode 'target_lang=ZH'
```

## 配置与变量

`wrangler.toml`：

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `MODEL` | var | `@cf/qwen/qwen3-30b-a3b-fp8` | 翻译模型，可换成其他 Workers AI 文本模型 |
| `MAX_TOTAL_CHARS` | var | `1500` | 单请求（批量合计）最大 UTF-16 字符数，对齐 DLX |
| `MAX_ITEMS` | var | `30` | 批量最多文本段数 |
| `SEGMENT_CHARS` | var | `1000` | 单段超过该长度时先切分再逐段翻译 |
| `MAX_OUTPUT_TOKENS` | var | `4096` | 输出上限，避免模型默认 256 token 截断长文 |
| `TEMPERATURE` | var | `0.1` | 采样温度 |
| `CONCURRENCY` | var | `2` | 批量时的并发 AI 调用数 |
| `CACHE_TTL` | var | `86400` | KV 缓存 TTL（秒） |
| `TOKEN` | secret | 空 | 设置后启用鉴权；为空则不校验（公网部署务必设置） |
| `AI` | AI binding | `[ai]` | 必需，名称必须与代码里的 `env.AI` 一致 |
| `CACHE` | KV binding | 未绑定 | 可选；启用精确缓存与配额熔断 |

`package.json` 脚本：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发服务器（默认 8787） |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run check` | 语法自检（`node --check src/index.js`） |
| `npm test` | 运行 Node 内置测试（stub AI，不访问 Cloudflare、不消耗配额） |

## 测试

```bash
npm test
```

测试覆盖 JSON / 表单两种请求体、`/translate` 与 `/v2/translate` 两种响应、HTML 占位符还原、鉴权各形式与 400/401/404/405/413 错误语义。`env.AI` 全部使用 stub，不会发起真实推理。

## 切换模型

只改 `wrangler.toml` 的 `MODEL`，然后重新部署：

```toml
[vars]
MODEL = "@cf/meta/m2m100-1.2b"
```

```bash
npm run deploy
```

可用模型示例：`@cf/meta/llama-3.2-3b-instruct`、`@cf/ibm-granite/granite-4.0-h-micro`、`@cf/meta/m2m100-1.2b`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`。

> M2M100 不支持自动检测，调用时必须显式传 `source_lang`，否则返回 `400`。

## 启用 KV 缓存（可选）

KV 用于精确缓存翻译结果，并在配额耗尽时写入当天熔断标记。不启用也不影响基本翻译。

```bash
npx wrangler kv namespace create CACHE
```

命令会输出类似：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<返回的 namespace id>"
```

把这段内容追加到 `wrangler.toml`（或取消文件末尾注释并填入 id），然后重新部署：

```bash
npm run deploy
```

## 鉴权

设置 `TOKEN` 后，下列任意一种形式都可用：

```http
Authorization: DeepL-Auth-Key <token>
Authorization: Bearer <token>
Authorization: <token>
DeepL-Auth-Key: <token>
X-Auth-Key: <token>
POST /translate?token=<token>
POST /translate?auth_key=<token>
```

鉴权失败统一返回 `401 {"code":401,"message":"Invalid access token"}`。

## 错误语义

HTTP 状态码与响应体 `code` 一致：

| 场景 | HTTP / code | 说明 |
|---|---|---|
| 缺少 `text` / 请求体无法解析 | 400 | `No text provided` / `Invalid JSON payload` |
| `target_lang` 缺失或非法 | 400 | `target_lang is required` |
| Token 无效 | 401 | `Invalid access token` |
| 方法不允许 | 405 | 响应头带 `Allow` |
| 超过字符数或段数上限 | 413 | 与 DLX 的 1500 字符语义一致 |
| 免费 Neuron 配额用尽 | 429 | 对应 AI `3036`；配置 KV 后会熔断到 UTC 00:00 |
| 上游容量不足 | 429 | 对应 AI `3040`，可重试 |
| 模型需要 Paid / 未同意条款 | 403 | 对应 AI `5035` / `5016` |
| 模型输出连续两次不合格 | 503 | 占位符丢失或返回解释性文字 |
| 推理超时 | 504 | 对应 AI `3007` / `3008` |

## 已处理的工程问题

- **`max_tokens` 显式设置**：按源文本估算（CJK 1.3 token/字，其他 0.32）并留余量，上限 `MAX_OUTPUT_TOKENS`。
- **reasoning 过滤**：去掉 `<think>…</think>` 等块；Qwen3/GLM 额外追加 `/no_think`；输出像解释性文字时用更严格 prompt 重试一次。
- **HTML/XML 占位符保护**：`tag_handling=html|xml` 时把标签替换为 `⟦n⟧`，翻译后校验并还原；缺失则重试，仍失败返回 503。
- **超长文本分段**：按段落 → 句子 → 硬切分；硬切分避开占位符，译文按顺序拼回。
- **配额语义**：`3036` 不重试，配置 KV 时写入当天熔断标记，次日 UTC 00:00 自动解除。
- **批量并发可控**：默认 2 路并发，结果顺序与输入一致。

## 已知限制

| 能力 | 现状 |
|---|---|
| `alternatives` | 恒为 `null`（DeepLX 本身也是空值） |
| `detected_source_language` | 只回显请求的 `source_lang`；`auto` 时返回 `"AUTO"`，**不做真实语言检测** |
| `formality` / `glossary` | 未支持，不会假装生效 |
| `/v1/translate` | 未实现，返回 501 |
| `tag_handling` | 正则级保护，不解析嵌套/畸形 HTML，也不保护标签内部文本与实体 |
| 流式输出（SSE） | 未实现，只有一次性 JSON |
| 超长文档 | 默认按 DLX 语义返回 413；调高 `MAX_TOTAL_CHARS` 后需自行分段 |
| 多 Key 轮询 / 多账号 | 未实现，免费额度用尽建议升级 Workers Paid |
| 强一致限流 | 未实现；KV 为最终一致，仅用于近似缓存与熔断 |

## 停用与删除

### 临时停用 `workers.dev` 域名

Cloudflare Dashboard → Workers & Pages → 选中该 Worker → Settings → Domains & Routes → 关闭 `workers.dev`。代码和配置保留，可随时重新开启。

### 删除 Worker

```bash
npx wrangler delete
```

会按 `wrangler.toml` 的 `name` 删除对应 Worker，并提示确认。也可以直接在 Dashboard 里删除。

删除 Worker 后，`workers.dev` 地址立即失效，绑定的 secret 一并删除。

### 删除 KV namespace

```bash
npx wrangler kv namespace list          # 查看 id
npx wrangler kv namespace delete <namespace id 或名称>
```

### 单独删除 secret

```bash
npx wrangler secret delete TOKEN
```

### 退出本机登录

```bash
npx wrangler logout
```

## 排错

- `AI binding is not configured`：检查 `wrangler.toml` 的 `[ai] binding = "AI"`。
- `403 / 5016`：到 Cloudflare Dashboard 的 Workers AI 页面同意对应模型条款。
- `403 / 5035`：该模型需要 Workers Paid，换回默认模型。
- `429`：免费额度按 Cloudflare 账号统计，UTC 00:00（北京时间 08:00）重置。
- `1010` 或非浏览器请求被拒：`*.workers.dev` 对部分 UA 有边缘限制，用浏览器 UA 或自定义域名复测。
- 本地 `wrangler dev` 调用慢或 `InferenceUpstreamError`：远程 binding 通道问题，可改用 `npm run deploy` 后验证；不影响线上逻辑。
- `npx wrangler` 报 Node 版本过低：升级到 Node.js 22+。

## 许可证

本项目采用 **MIT** 许可证，完整文本见 [LICENSE](LICENSE)。

Copyright (c) 2026 AITranslate contributors
