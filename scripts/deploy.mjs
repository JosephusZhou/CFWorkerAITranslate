#!/usr/bin/env node
/**
 * 交互式部署脚本：按 README 的部署流程逐步引导，直到线上接口自测通过。
 *
 * 流程：环境检查 → 登录检查/调起 → Worker 名称 → 访问 Token → 可选自定义域名 → 部署 → 写入 secret → 线上自测
 *
 * 不包含本地开发（npm run dev）。仅使用 Node 内置模块，不引入第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const TOTAL_STEPS = 7;

const WRANGLER_BIN = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// 名称规则：小写字母/数字/连字符，首尾必须为字母或数字，最长 63 位。
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// 自定义域名会写进 wrangler.toml 的这个注释块内，重复运行脚本时整段覆盖。
const ROUTE_START = '# >>> 交互式部署脚本：自定义域名（再次运行脚本会覆盖本段）';
const ROUTE_END = '# <<< 交互式部署脚本：自定义域名';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function step(index, title) {
  console.log(`\n${bold(`[${index}/${TOTAL_STEPS}] ${title}`)}`);
}

function ok(message) {
  console.log(green(`  ✓ ${message}`));
}

function warn(message) {
  console.log(yellow(`  ! ${message}`));
}

function fail(message) {
  console.log(red(`  ✗ ${message}`));
}

function cancelled(message, code = 1) {
  fail(message);
  process.exit(code);
}

// 复用同一个 readline 实例，并把读到的行放进队列：
// - TTY 下逐行提问，正常回显；
// - 管道输入时也能把多行答案依次分发给后面的问题，不会因为读得快而丢行。
// 需要把终端让给子进程（wrangler login / npm install）时先关闭它。
let rl = null;
let inputEnded = false;
let closingForChild = false;
const lineQueue = [];
const lineWaiters = [];

function getRl() {
  if (!rl) {
    const instance = createInterface({ input: process.stdin, output: process.stdout });
    rl = instance;

    instance.on('line', (line) => {
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else lineQueue.push(line);
    });

    instance.on('close', () => {
      if (rl === instance) rl = null;
      if (closingForChild) {
        closingForChild = false;
        return;
      }
      inputEnded = true;
      while (lineWaiters.length) lineWaiters.shift()('');
    });
  }
  return rl;
}

function closeRl() {
  if (!rl) return;
  const instance = rl;
  closingForChild = true;
  rl = null;
  instance.close();
}

async function ask(question, defaultValue = '') {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const promptText = `${question}${suffix}：`;

  if (inputEnded) {
    console.log(promptText);
    return defaultValue;
  }

  const instance = getRl();
  instance.setPrompt(promptText);
  instance.prompt();

  const line = await new Promise((resolve) => {
    const queued = lineQueue.shift();
    if (queued !== undefined) resolve(queued);
    else lineWaiters.push(resolve);
  });

  const answer = line.trim();
  return answer || defaultValue;
}

async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(question, hint)).toLowerCase();
  if (answer === hint.toLowerCase()) return defaultYes;
  return answer.startsWith('y');
}

/** 调用 wrangler，可选择是否把输出实时转发到终端。 */
function runWrangler(args, { stream = true } = {}) {
  const bin = fs.existsSync(WRANGLER_BIN) ? WRANGLER_BIN : NPX_BIN;
  const fullArgs = fs.existsSync(WRANGLER_BIN) ? args : ['wrangler', ...args];

  return new Promise((resolve) => {
    const child = spawn(bin, fullArgs, { cwd: ROOT, env: process.env });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      if (stream) process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ ok: false, code: 1, output, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code, output }));
  });
}

/** 需要占用终端的命令（wrangler login），stdio 直接继承。 */
function runInteractive(args) {
  const bin = fs.existsSync(WRANGLER_BIN) ? WRANGLER_BIN : NPX_BIN;
  const fullArgs = fs.existsSync(WRANGLER_BIN) ? args : ['wrangler', ...args];

  return new Promise((resolve) => {
    const child = spawn(bin, fullArgs, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('error', (error) => resolve({ ok: false, code: 1, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/** 通过 stdin 非交互写入 secret（与 README 中 printf | wrangler secret put 等价）。 */
function runWithInput(args, input) {
  const bin = fs.existsSync(WRANGLER_BIN) ? WRANGLER_BIN : NPX_BIN;
  const fullArgs = fs.existsSync(WRANGLER_BIN) ? args : ['wrangler', ...args];

  return new Promise((resolve) => {
    const child = spawn(bin, fullArgs, {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('error', (error) => resolve({ ok: false, code: 1, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
    child.stdin.end(input);
  });
}

function readToml() {
  return fs.readFileSync(WRANGLER_TOML, 'utf8');
}

function readWorkerName(toml) {
  const match = toml.match(/^name\s*=\s*"([^"]+)"/m);
  return match ? match[1] : '';
}

function writeWorkerName(name) {
  const toml = readToml();
  if (!/^name\s*=\s*"[^"]+"/m.test(toml)) {
    throw new Error('wrangler.toml 中找不到 name 配置，无法修改 Worker 名称');
  }
  fs.writeFileSync(WRANGLER_TOML, toml.replace(/^name\s*=\s*"[^"]+"/m, `name = "${name}"`));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 读取脚本写入的自定义域名（没有则返回空字符串）。 */
function readRouteDomain(toml) {
  const blockRe = new RegExp(
    `${escapeRegExp(ROUTE_START)}[\\s\\S]*?${escapeRegExp(ROUTE_END)}`,
  );
  const block = toml.match(blockRe);
  if (!block) return '';
  const domain = block[0].match(/pattern\s*=\s*"([^"]+)"/);
  return domain ? domain[1] : '';
}

/** 去掉脚本写入的路由注释块，保留用户其它配置。 */
function stripRouteBlock(toml) {
  const lines = toml.split('\n');
  const kept = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === ROUTE_START) {
      inBlock = true;
      continue;
    }
    if (trimmed === ROUTE_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) kept.push(line);
  }
  return kept.join('\n').replace(/\s+$/, '');
}

/** 把自定义域名写入 wrangler.toml 的 routes；已有手工 routes 时拒绝覆盖。 */
function writeRoute(domain) {
  const base = stripRouteBlock(readToml());
  if (/^\s*routes\s*=/m.test(base) || /^\s*\[\[routes\]\]/m.test(base)) {
    throw new Error(
      'wrangler.toml 中已有手工配置的 routes，脚本不会覆盖。请先手动删除，或改由脚本注释块管理',
    );
  }
  const block = [
    ROUTE_START,
    'routes = [',
    `  { pattern = "${domain}", custom_domain = true }`,
    ']',
    ROUTE_END,
  ].join('\n');

  // TOML 中裸键必须写在任何 [table] 之前，否则会被归入上一个表；
  // 因此 routes 段要插到第一个表头（如 [ai]）之前。
  const lines = base.split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable === -1) {
    fs.writeFileSync(WRANGLER_TOML, `${base.replace(/\s+$/, '')}\n\n${block}\n`);
    return;
  }

  const before = lines.slice(0, firstTable).join('\n').replace(/\s+$/, '');
  const after = lines.slice(firstTable).join('\n');
  fs.writeFileSync(WRANGLER_TOML, `${before}\n\n${block}\n\n${after}`);
}

function normalizeDomain(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    fail(`当前 Node.js 版本为 ${process.versions.node}，wrangler 4.x 需要 Node.js 22 或更高`);
    fail('请先升级 Node.js 后重新运行：npm run deploy:interactive');
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);
}

function checkProjectFiles() {
  if (!fs.existsSync(WRANGLER_TOML) || !fs.existsSync(ENTRY)) {
    fail('未在项目根目录找到 wrangler.toml 或 src/index.js');
    fail(`当前脚本所在目录：${ROOT}`);
    process.exit(1);
  }
  ok('wrangler.toml 与 src/index.js 存在');
}

async function ensureWranglerInstalled() {
  if (fs.existsSync(WRANGLER_BIN)) {
    ok('本地已安装 wrangler');
    return;
  }

  warn('未检测到本地 wrangler，首次运行需要安装依赖');
  if (!(await confirm('是否现在执行 npm install？', true))) {
    cancelled('请先手动运行 npm install 后重试');
  }

  console.log(dim('\n执行 npm install ...'));
  closeRl();
  const result = await new Promise((resolve) => {
    const child = spawn(NPM_BIN, ['install'], { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('error', (error) => resolve({ ok: false, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });

  if (!result.ok || !fs.existsSync(WRANGLER_BIN)) {
    cancelled('npm install 失败或仍未找到 wrangler，请检查网络后重试');
  }
  ok('依赖安装完成');
}

function extractEmail(output) {
  const match = output.match(/associated with (?:the email )?([^\s,，)]+@[^\s,，)]+)/i);
  return match ? match[1].replace(/[.。]$/, '') : '';
}

async function ensureLoggedIn() {
  const whoami = await runWrangler(['whoami'], { stream: false });
  const clean = stripAnsi(whoami.output);

  if (whoami.ok && /logged in/i.test(clean)) {
    const email = extractEmail(clean);
    ok(`已登录 Cloudflare${email ? `：${email}` : ''}`);
    return;
  }

  if (/not logged in|not authenticated/i.test(clean)) {
    warn('尚未登录 Cloudflare，即将调起 wrangler login（会打开浏览器授权页）');
    closeRl();
    const login = await runInteractive(['login']);
    if (!login.ok) {
      fail('wrangler login 未成功完成');
      fail('请在可交互的终端中重试，或改用 CLOUDFLARE_API_TOKEN 环境变量');
      process.exit(1);
    }

    const again = await runWrangler(['whoami'], { stream: false });
    if (!again.ok) {
      fail('登录后仍无法确认账号信息，wrangler whoami 输出：');
      console.log(stripAnsi(again.output).trim());
      process.exit(1);
    }
    const email = extractEmail(stripAnsi(again.output));
    ok(`登录成功${email ? `：${email}` : ''}`);
    return;
  }

  fail('无法确认 Cloudflare 登录状态，wrangler whoami 输出：');
  console.log(clean.trim() || '（无输出）');
  fail('请检查网络、代理或 CLOUDFLARE_API_TOKEN 配置后重试');
  process.exit(1);
}

async function chooseWorkerName() {
  const current = readWorkerName(readToml()) || 'ai-deeplx';
  console.log(`  当前 Worker 名称：${bold(current)}`);
  console.log(dim(`  免费地址形如 https://${current}.<你的子域名>.workers.dev`));

  if (!(await confirm('是否自定义 Worker 名称？', false))) {
    ok(`使用现有名称：${current}`);
    return current;
  }

  while (true) {
    const input = await ask('  输入新名称（小写字母/数字/连字符，回车取消）');
    if (!input) {
      ok(`已取消，继续使用：${current}`);
      return current;
    }

    const name = input.toLowerCase();
    if (!WORKER_NAME_RE.test(name) || name.length > 63) {
      fail('名称不合法：只能使用小写字母、数字和连字符，且必须以字母或数字开头/结尾');
      continue;
    }

    try {
      writeWorkerName(name);
    } catch (error) {
      cancelled(error.message);
    }

    ok(`已写入 wrangler.toml：name = "${name}"`);
    if (name !== current) {
      warn('改名会部署为一个新的 Worker，旧 Worker 不会自动删除');
    }
    return name;
  }
}

async function chooseToken() {
  console.log('  公网部署强烈建议设置 TOKEN；不设置时接口完全公开，任何人都能消耗你的免费额度。');

  let mode = '';
  while (!['1', '2', '3'].includes(mode)) {
    mode = await ask('  选择方式：1) 自动生成（推荐） 2) 手动输入 3) 不设置', '1');
  }

  if (mode === '3') {
    warn('已跳过 TOKEN：接口将无鉴权，请勿在公网长期开放');
    return '';
  }

  if (mode === '1') {
    const token = crypto.randomBytes(24).toString('hex');
    ok('已生成 48 位随机 TOKEN（部署结束时会再次显示）');
    return token;
  }

  while (true) {
    const token = await ask('  粘贴自定义 TOKEN（至少 8 位，不能包含空白）', '');
    if (!token) {
      fail('TOKEN 不能为空');
      continue;
    }
    if (/\s/.test(token)) {
      fail('TOKEN 不能包含空格或换行');
      continue;
    }
    if (token.length < 8) {
      fail('TOKEN 至少需要 8 位');
      continue;
    }
    ok('已记录自定义 TOKEN（部署结束时会显示）');
    return token;
  }
}

async function chooseDomain() {
  const existing = readRouteDomain(readToml());
  if (existing) {
    console.log(`  已配置的自定义域名：${bold(existing)}`);
  }
  console.log('  提示：自定义域名必须已经在当前 Cloudflare 账号中托管（Zone 状态 Active），');
  console.log('        且该主机名不能已有冲突的 A/AAAA/CNAME 记录。');

  const question = existing ? '是否重新设置自定义域名？' : '是否绑定自定义域名？';
  if (!(await confirm(question, false))) {
    if (existing) {
      ok(`保留已有自定义域名：${existing}`);
      return existing;
    }
    ok('跳过，使用 workers.dev 免费域名');
    return '';
  }

  while (true) {
    const input = normalizeDomain(
      await ask('  输入自定义域名（如 translate.example.com，回车取消）', existing),
    );

    if (!input) {
      if (existing) {
        ok(`保留已有自定义域名：${existing}`);
        return existing;
      }
      ok('已取消，使用 workers.dev 免费域名');
      return '';
    }

    if (/\.workers\.dev$/.test(input)) {
      fail('workers.dev 是 Cloudflare 免费子域名，不能作为自定义域名');
      continue;
    }

    if (!DOMAIN_RE.test(input)) {
      fail('域名格式不合法：只输入主机名，不要带 https://、端口或路径');
      continue;
    }

    try {
      writeRoute(input);
    } catch (error) {
      cancelled(error.message);
    }

    ok(`已写入 wrangler.toml 自定义域名路由：${input}`);
    return input;
  }
}

async function deployWorker() {
  console.log('  执行 wrangler deploy（首次部署会自动创建 Worker）...');
  const result = await runWrangler(['deploy']);

  if (!result.ok) {
    fail('部署失败，常见原因：');
    console.log('    - 自定义域名未在当前账号托管/未激活，或主机名已有冲突的 DNS 记录');
    console.log('    - 账号未开通 Workers 权限，或登录状态已失效');
    console.log('    - 网络无法访问 Cloudflare API');
    console.log(dim('wrangler 的完整输出见上方。'));
    process.exit(1);
  }

  ok('wrangler deploy 成功');
  return result.output;
}

function extractWorkersDevUrl(output) {
  const match = stripAnsi(output).match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i);
  return match ? match[0] : '';
}

async function putTokenSecret(token) {
  console.log('  写入 TOKEN secret ...');
  const result = await runWithInput(['secret', 'put', 'TOKEN'], `${token}\n`);

  if (!result.ok) {
    fail('TOKEN 写入失败');
    fail('请确认 Worker 已创建成功，并保持登录状态后重试');
    process.exit(1);
  }

  ok('TOKEN 已写入（立即生效，不需要重新部署）');
}

async function requestTranslate(baseUrl, token) {
  const headers = {
    'Content-Type': 'application/json',
    // README 提到部分 UA 在 workers.dev 上会被边缘拒绝，用浏览器风格 UA 避免误判。
    'User-Agent': 'Mozilla/5.0 (compatible; CFWorkerAITranslate deploy check)',
  };
  if (token) headers.Authorization = `DeepL-Auth-Key ${token}`;

  const response = await fetch(`${baseUrl}/translate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Hello, world!', target_lang: 'ZH' }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function verifyTranslation(baseUrl, token) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await requestTranslate(baseUrl, token);
      if (result.status === 200 && result.text.includes('"data"')) {
        ok(`翻译接口自测通过（HTTP 200，返回 ${result.text.slice(0, 100)}）`);
        return true;
      }
      if (attempt < 4) {
        warn(`第 ${attempt} 次自测未通过（HTTP ${result.status}），稍后重试`);
        await sleep(5000);
        continue;
      }
      fail(`翻译接口返回 HTTP ${result.status}`);
      console.log(dim(result.text.slice(0, 500)));
      return false;
    } catch (error) {
      if (attempt < 4) {
        warn(`第 ${attempt} 次请求失败（${error.cause?.code || error.message}），稍后重试`);
        await sleep(5000);
        continue;
      }
      fail(`请求失败：${error.cause?.code || error.message}`);
      return false;
    }
  }
  return false;
}

async function verifyAuth(baseUrl) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; CFWorkerAITranslate deploy check)',
        },
        body: JSON.stringify({ text: 'hi' }),
        signal: AbortSignal.timeout(20000),
      });

      if (response.status === 401) {
        ok('鉴权自测通过（无 TOKEN 请求返回 401）');
        return true;
      }

      if (attempt < 3) {
        warn(`鉴权尚未生效（HTTP ${response.status}），稍后重试`);
        await sleep(3000);
        continue;
      }
      fail(`未携带 TOKEN 的请求返回 HTTP ${response.status}，预期 401`);
      return false;
    } catch (error) {
      if (attempt < 3) {
        await sleep(3000);
        continue;
      }
      fail(`鉴权自测请求失败：${error.cause?.code || error.message}`);
      return false;
    }
  }
  return false;
}

function printSummary({ name, baseUrl, token, domain }) {
  console.log(`\n${green(bold('部署完成'))}`);
  console.log(`  Worker 名称：${name}`);
  console.log(`  接口地址：${baseUrl ? `${baseUrl}/translate` : '未解析到，请从上方 wrangler 输出中复制'}`);
  console.log(`  访问 Token：${token || '未设置（接口公开）'}`);
  if (domain) console.log(`  自定义域名：${domain}（已写入 wrangler.toml）`);
  console.log('');
  console.log('  Easydict：API 地址填上面的「接口地址」，Auth Key 填上面的 Token。');
  console.log('  实时日志：npx wrangler tail');
  console.log('  删除 Worker：npx wrangler delete');
  if (token) {
    console.log(yellow('  请自行保存上面的 Token；本脚本不会把它写入任何文件。'));
  }
}

function printVerifyFailureHint() {
  console.log(yellow('\n  部署本身已完成，但线上自测未通过。排查建议：'));
  console.log('    - 403 / 5016：到 Cloudflare Dashboard 的 Workers AI 页面同意模型条款');
  console.log('    - 403 / 5035：模型需要 Workers Paid，换回 wrangler.toml 的默认模型');
  console.log('    - 429：免费 Neuron 配额用尽，UTC 00:00（北京时间 08:00）重置');
  console.log('    - 自定义域名刚绑定：DNS 生效可能需要几分钟，稍后手动复测');
  console.log('    - 401 一直不生效：确认 secret 写入的是当前 Worker 名称对应的 Worker');
  console.log('  手动复测：npx wrangler tail 查看日志，再从浏览器/curl 请求接口。');
}

async function main() {
  console.log(bold('\nCFWorkerAITranslate 交互式部署'));
  console.log(dim('按 README 的部署流程引导：登录 → 命名 → Token → 可选自定义域名 → 部署 → 线上自测'));
  console.log(dim('不包含本地开发（npm run dev）。随时按 Ctrl+C 退出。'));

  step(1, '环境检查');
  checkNodeVersion();
  checkProjectFiles();
  await ensureWranglerInstalled();

  step(2, '检查 Cloudflare 登录状态');
  await ensureLoggedIn();

  step(3, 'Worker 名称');
  const name = await chooseWorkerName();

  step(4, '访问 Token');
  const token = await chooseToken();

  step(5, '自定义域名（可选）');
  const domain = await chooseDomain();

  step(6, '部署到 Cloudflare');
  const deployOutput = await deployWorker();

  step(7, '写入 secret 并线上自测');
  if (token) await putTokenSecret(token);

  const baseUrl = domain ? `https://${domain}` : extractWorkersDevUrl(deployOutput);
  if (!baseUrl) {
    warn('未能从部署输出中解析出访问地址，跳过线上自测');
    printSummary({ name, baseUrl: '', token, domain });
    return;
  }

  console.log(`  自测地址：${baseUrl}`);
  let verifyOk = await verifyTranslation(baseUrl, token);
  if (token) {
    verifyOk = (await verifyAuth(baseUrl)) && verifyOk;
  }

  if (!verifyOk) printVerifyFailureHint();

  printSummary({ name, baseUrl, token, domain });
  if (!verifyOk) process.exitCode = 1;
}

process.on('SIGINT', () => {
  closeRl();
  console.log('\n已取消部署。');
  process.exit(130);
});

main()
  .catch((error) => {
    fail(error?.stack || error?.message || String(error));
    process.exit(1);
  })
  // 关闭常驻 readline，否则 stdin 会让进程在部署结束后继续挂起。
  .finally(() => closeRl());
