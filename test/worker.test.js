import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const BASE = 'https://worker.example.test';
const TOKEN = 'test-token-0123456789abcdef';

const DICT = {
  'Hello, world!': '你好，世界！',
  'Good morning.': '早上好。',
  'How are you?': '你好吗？',
  'The weather is nice today.': '今天天气很好。',
  'See you tomorrow.': '明天见。',
  Hello: '你好',
  world: '世界',
};

function fakeTranslate(text) {
  // 占位符形态：保留 ⟦n⟧，只替换可识别的词，用于验证 HTML 标签还原。
  if (text.includes('⟦')) {
    return text.replace(/Hello/g, '你好').replace(/world/g, '世界');
  }
  if (Object.hasOwn(DICT, text)) return DICT[text];
  return text
    .split('\n')
    .map((line) => DICT[line] ?? `译:${line}`)
    .join('\n');
}

function createEnv(overrides = {}) {
  return {
    AI: {
      run: async (_model, input) => {
        if (input && Array.isArray(input.messages)) {
          const user = input.messages.find((message) => message.role === 'user');
          const matched = (user?.content || '').match(/^<text>\n([\s\S]*)\n<\/text>$/);
          return { response: fakeTranslate(matched ? matched[1] : '') };
        }
        return { translated_text: fakeTranslate(String(input?.text ?? '')) };
      },
    },
    TOKEN,
    ...overrides,
  };
}

function jsonRequest(path, body, headers = {}, method = 'POST') {
  return new Request(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  });
}

function formRequest(path, pairs, headers = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  return new Request(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: params.toString(),
  });
}

const AUTH = { Authorization: `DeepL-Auth-Key ${TOKEN}` };

async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

test('JSON 单条 /translate 返回 DeepLX 结构', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: 'Hello, world!', source_lang: 'EN', target_lang: 'ZH' }, AUTH),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.equal(body.code, 200);
  assert.equal(body.data, '你好，世界！');
  assert.equal(body.alternatives, null);
  assert.equal(body.source_lang, 'EN');
  assert.equal(body.target_lang, 'ZH');
  assert.equal(body.method, 'Free');
  assert.equal(typeof body.id, 'number');
});

test('JSON 批量 /translate 保持输入顺序', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/translate',
        { text: ['Good morning.', 'How are you?'], source_lang: 'EN', target_lang: 'ZH' },
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.deepEqual(body.data, ['早上好。', '你好吗？']);
});

test('表单单条 /translate 返回 Easydict 需要的 translations[]', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      formRequest(
        '/translate',
        [
          ['text', 'Hello, world!'],
          ['target_lang', 'zh-hans'],
        ],
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.equal(body.translations.length, 1);
  assert.equal(body.translations[0].text, '你好，世界！');
  assert.equal(body.translations[0].detected_source_language, 'AUTO');
});

test('/v2/translate JSON 返回 translations[] 并回显源语言', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/v2/translate',
        { text: ['Good morning.', 'How are you?'], source_lang: 'EN', target_lang: 'ZH' },
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.deepEqual(
    body.translations.map((item) => item.text),
    ['早上好。', '你好吗？'],
  );
  assert.equal(body.translations[0].detected_source_language, 'EN');
});

test('/v2/translate 表单形态可用', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      formRequest(
        '/v2/translate',
        [
          ['text', 'The weather is nice today.'],
          ['text', 'See you tomorrow.'],
          ['target_lang', 'ZH'],
        ],
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.equal(body.translations.length, 2);
  assert.equal(body.translations[0].text, '今天天气很好。');
  assert.equal(body.translations[1].text, '明天见。');
});

test('tag_handling=html 能还原标签占位符', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/translate',
        {
          text: '<p>Hello <b>world</b>!</p>',
          source_lang: 'EN',
          target_lang: 'ZH',
          tag_handling: 'html',
        },
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.equal(body.data, '<p>你好 <b>世界</b>!</p>');
  assert.equal(body.data.includes('⟦'), false);
});

test('鉴权：所有受支持形式均通过', async (t) => {
  const env = createEnv();
  const body = { text: 'Hello, world!', target_lang: 'ZH' };
  const cases = [
    ['Authorization: DeepL-Auth-Key', jsonRequest('/translate', body, AUTH)],
    [
      'Authorization: Bearer',
      jsonRequest('/translate', body, { Authorization: `Bearer ${TOKEN}` }),
    ],
    ['Authorization 裸 token', jsonRequest('/translate', body, { Authorization: TOKEN })],
    ['DeepL-Auth-Key 独立头', jsonRequest('/translate', body, { 'DeepL-Auth-Key': TOKEN })],
    ['X-Auth-Key 独立头', jsonRequest('/translate', body, { 'X-Auth-Key': TOKEN })],
    [
      '?token= 查询参数',
      jsonRequest(`/translate?token=${TOKEN}`, body),
    ],
    [
      '?auth_key= 查询参数',
      jsonRequest(`/translate?auth_key=${TOKEN}`, body),
    ],
  ];

  for (const [name, request] of cases) {
    await t.test(name, async () => {
      const { status, body: payload } = await readJson(await worker.fetch(request, env));
      assert.equal(status, 200);
      assert.equal(payload.data, '你好，世界！');
    });
  }
});

test('错误 token 返回 401', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/translate',
        { text: 'Hello, world!', target_lang: 'ZH' },
        { Authorization: 'DeepL-Auth-Key wrong-token' },
      ),
      env,
    ),
  );

  assert.equal(status, 401);
  assert.equal(body.code, 401);
  assert.equal(body.message, 'Invalid access token');
});

test('无任何凭据返回 401', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: 'Hello, world!', target_lang: 'ZH' }),
      env,
    ),
  );

  assert.equal(status, 401);
  assert.equal(body.code, 401);
});

test('缺少 text 返回 400', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(jsonRequest('/translate', { target_lang: 'ZH' }, AUTH), env),
  );

  assert.equal(status, 400);
  assert.equal(body.code, 400);
  assert.equal(body.message, 'No text provided');
});

test('超过 1500 字符返回 413', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: 'a'.repeat(1501), target_lang: 'ZH' }, AUTH),
      env,
    ),
  );

  assert.equal(status, 413);
  assert.equal(body.code, 413);
});

test('方法不符返回 405 且带 Allow', async () => {
  const env = createEnv();

  const v2 = await worker.fetch(new Request(`${BASE}/v2/translate`, { method: 'GET' }), env);
  assert.equal(v2.status, 405);
  assert.equal(v2.headers.get('Allow'), 'POST');

  const translate = await worker.fetch(
    new Request(`${BASE}/translate`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }),
    env,
  );
  assert.equal(translate.status, 405);
  assert.equal(translate.headers.get('Allow'), 'GET, POST');
});

test('未知路径返回 404', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(new Request(`${BASE}/does-not-exist`, { method: 'POST' }), env),
  );

  assert.equal(status, 404);
  assert.equal(body.code, 404);
});

test('未实现路由返回 501', async () => {
  const env = createEnv();
  const { status, body } = await readJson(
    await worker.fetch(new Request(`${BASE}/v1/translate`, { method: 'POST' }), env),
  );

  assert.equal(status, 501);
  assert.equal(body.code, 501);
});
