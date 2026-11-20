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

function failingEnv(err) {
  return createEnv({ AI: { run: async () => { throw err; } } });
}

function aiError(message, code) {
  const err = new Error(message);
  if (code !== undefined) err.code = code;
  return err;
}

async function translateWith(env) {
  return readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: 'Hello, world!', target_lang: 'ZH' }, AUTH),
      env,
    ),
  );
}

test('模型被 Cloudflare 停用（5028）返回 410 并提示换 MODEL', async () => {
  const env = failingEnv(
    aiError(
      'AiError: 5028: @cf/qwen/qwen3-30b-a3b-fp8 was deprecated on 2026-11-20. See the model catalog for alternatives.',
      5028,
    ),
  );
  const { status, body } = await translateWith(env);

  assert.equal(status, 410);
  assert.equal(body.code, 410);
  assert.match(body.message, /deprecated/);
  assert.match(body.message, /MODEL/);
});

test('错误码只出现在 message 里时也能识别（5016）', async () => {
  // binding 的真实错误是 InferenceUpstreamError，name 为 AiError，没有 code 字段，
  // 码值只出现在 message 开头，形如 `5016: <text>`。
  const env = failingEnv(aiError('5016: User has not agreed to Llama3.2 model terms'));
  const { status, body } = await translateWith(env);

  assert.equal(status, 403);
  assert.equal(body.code, 403);
  assert.match(body.message, /terms/);
});

test('真实形态的停用错误（message 开头 5028，无 code 字段）映射为 410', async () => {
  const env = failingEnv(
    aiError(
      '5028: @cf/qwen/qwen3-30b-a3b-fp8 was deprecated on 2026-11-20. See the model catalog for alternatives: https://developers.cloudflare.com/workers-ai/models/',
    ),
  );
  const { status, body } = await translateWith(env);

  assert.equal(status, 410);
  assert.match(body.message, /deprecated/);
});

test('未收录的错误码在 503 message 里带出码值', async () => {
  const env = failingEnv(aiError('AiError: 6001: something unexpected', 6001));
  const { status, body } = await translateWith(env);

  assert.equal(status, 503);
  assert.equal(body.message, 'Translation failed (Workers AI error 6001)');
});

test('无错误码的上游异常兜底为 503，reference 数字不会被当成配额码', async () => {
  // reference 是随机串，历史上可能被宽松的码值正则误读成 3036 而错报 429。
  const env = failingEnv(
    aiError('InferenceUpstreamError: Error: internal error; reference = tr3036v1uavkol1r6jbv5prek'),
  );
  const { status, body } = await translateWith(env);

  assert.equal(status, 503);
  assert.equal(body.message, 'Translation failed');
});

test('OpenAI 兼容结构（choices[].message.content）也能取到译文', async () => {
  const env = createEnv({
    AI: {
      run: async () => ({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '你好，世界！', reasoning: '思考过程不应出现在译文里' },
            finish_reason: 'stop',
          },
        ],
      }),
    },
  });
  const { status, body } = await translateWith(env);

  assert.equal(status, 200);
  assert.equal(body.data, '你好，世界！');
});

test('模型返回空正文时不再静默给出空译文，而是 503', async () => {
  const env = createEnv({ AI: { run: async () => ({ choices: [{ message: { content: '' } }] }) } });
  const { status, body } = await translateWith(env);

  assert.equal(status, 503);
  assert.match(body.message, /empty output/);
});

test('停用错误以 InferenceUpstreamError 抛出时同样映射为 410', async () => {
  const env = failingEnv(
    aiError('InferenceUpstreamError: 5028: @cf/zai-org/glm-5.3-flash was deprecated on 2026-11-20.'),
  );
  const { status, body } = await translateWith(env);

  assert.equal(status, 410);
  assert.equal(body.code, 410);
});

test('输出预算为思考内容留出空间，避免正文被思考挤空', async () => {
  let requested = 0;
  const env = createEnv({
    AI: {
      run: async (_model, input) => {
        requested = input.max_tokens;
        return { response: '你好' };
      },
    },
  });

  await translateWith(env);

  assert.ok(requested >= 512, `max_tokens 只给了 ${requested}，思考内容会占满预算`);
});

// ---------------------------------------------------------------------------
// 主模型 + 兜底模型
// ---------------------------------------------------------------------------

const PRIMARY = 'model-primary';
const SECONDARY = 'model-fallback';

/** 用假模型名跑一遍模型链，记录调用顺序，避免测试跟默认模型名绑死。 */
function chainEnv(reply, vars = {}) {
  const calls = [];
  const env = createEnv({
    MODEL: PRIMARY,
    FALLBACK_MODEL: SECONDARY,
    ...vars,
    AI: {
      run: async (model, input) => {
        calls.push(model);
        return reply(model, input, calls.length);
      },
    },
  });
  return { env, calls };
}

function openAI(text) {
  return { choices: [{ message: { content: text } }] };
}

test('主模型上游报错时先重试一次，再切到兜底模型', async () => {
  const { env, calls } = chainEnv((model) => {
    if (model === SECONDARY) return openAI('你好，世界！');
    throw aiError('InferenceUpstreamError: Error: internal error; reference = abcdef');
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 200);
  assert.equal(body.data, '你好，世界！');
  assert.deepEqual(calls, [PRIMARY, PRIMARY, SECONDARY]);
});

test('主模型被停用（410）时直接换兜底模型，不重复调用主模型', async () => {
  const { env, calls } = chainEnv((model) => {
    if (model === SECONDARY) return { response: '兜底译文' };
    throw aiError(`AiError: 5028: ${PRIMARY} was deprecated on 2026-11-20.`, 5028);
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 200);
  assert.equal(body.data, '兜底译文');
  assert.deepEqual(calls, [PRIMARY, SECONDARY]);
});

test('配额耗尽（3036）不换模型，直接 429', async () => {
  const { env, calls } = chainEnv(() => {
    throw aiError('AiError: 3036: You have used up your daily free allocation.', 3036);
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 429);
  assert.match(body.message, /quota exhausted/);
  assert.deepEqual(calls, [PRIMARY]);
});

test('两个模型都失败时沿用上游语义（容量不足 429）', async () => {
  const { env, calls } = chainEnv(() => {
    throw aiError('AiError: 3040: Capacity temporarily exceeded.', 3040);
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 429);
  assert.match(body.message, /Capacity/);
  assert.deepEqual(calls, [PRIMARY, PRIMARY, SECONDARY, SECONDARY]);
});

test('FALLBACK_MODEL 设为空串时只用主模型', async () => {
  const { env, calls } = chainEnv(
    () => {
      throw aiError(`AiError: 5028: ${PRIMARY} was deprecated on 2026-11-20.`, 5028);
    },
    { FALLBACK_MODEL: '' },
  );

  const { status } = await translateWith(env);

  assert.equal(status, 410);
  assert.deepEqual(calls, [PRIMARY]);
});

test('兜底模型的译文按兜底模型入缓存，不与主模型共用键', async () => {
  const keys = { got: [], put: [] };
  const { env } = chainEnv(
    (model) => {
      if (model === SECONDARY) return openAI('兜底译文');
      throw aiError('InferenceUpstreamError: Error: internal error; reference = abcdef');
    },
    {
      CACHE: {
        get: async (key) => {
          keys.got.push(key);
          return null;
        },
        put: async (key) => {
          keys.put.push(key);
        },
      },
    },
  );

  const { status, body } = await translateWith(env);

  assert.equal(status, 200);
  assert.equal(body.data, '兜底译文');
  // 绑定 KV 后配额熔断也会读一次 KV，这里只看翻译缓存键。
  const trKeys = keys.got.filter((key) => key.startsWith('tr:v1:'));
  assert.equal(trKeys.length, 1);
  assert.equal(keys.put.length, 1);
  // 缓存键含模型名：兜底产物不能占住主模型的键。
  assert.notEqual(keys.put[0], trKeys[0]);
});

test('分段结果混用主模型与兜底模型时不写缓存', async () => {
  const keys = { got: [], put: [] };
  const { env, calls } = chainEnv(
    (model, _input, callIndex) => {
      if (callIndex <= 2) {
        throw aiError('InferenceUpstreamError: Error: internal error; reference = abcdef');
      }
      return openAI('译文');
    },
    {
      SEGMENT_CHARS: '20',
      CACHE: {
        get: async (key) => {
          keys.got.push(key);
          return null;
        },
        put: async (key) => {
          keys.put.push(key);
        },
      },
    },
  );

  const long = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm';
  // 分段数不写死：只要各段用到的模型不同即可。
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: long, source_lang: 'EN', target_lang: 'ZH' }, AUTH),
      env,
    ),
  );

  assert.equal(status, 200, JSON.stringify(body));
  // 主模型先失败两次 -> 该段走兜底；后续段主模型已恢复，于是两段用了不同模型。
  assert.deepEqual(calls.slice(0, 3), [PRIMARY, PRIMARY, SECONDARY]);
  assert.ok(new Set(calls).size === 2, '应当同时用到主模型与兜底模型');
  assert.equal(keys.put.length, 0);
});

// ---------------------------------------------------------------------------
// 审查修复的回归用例
// ---------------------------------------------------------------------------

test('兜底模型接不住 AUTO 时跳过它，不把请求变成 400', async () => {
  const { env, calls } = chainEnv(
    () => {
      throw aiError('Error: internal error; reference = zzz');
    },
    { FALLBACK_MODEL: '@cf/meta/m2m100-1.2b' },
  );

  // 不传 source_lang -> auto，Easydict 的默认形态
  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest('/translate', { text: 'Hello', target_lang: 'ZH' }, AUTH),
      env,
    ),
  );

  assert.notEqual(status, 400);
  assert.equal(status, 503, JSON.stringify(body));
  assert.ok(!calls.some((m) => /m2m100/.test(m)), 'M2M100 不该被调用');
});

test('兜底模型被停用时，410 点名真正的模型和真正的变量', async () => {
  const { env } = chainEnv((model) => {
    if (model === PRIMARY) throw aiError('Error: internal error; reference = zzz');
    throw aiError(`5028: ${SECONDARY} was deprecated on 2026-11-20.`);
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 410);
  assert.match(body.message, new RegExp(SECONDARY.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(body.message, /FALLBACK_MODEL/);
});

test('批量请求不做同模型重试，避免重试次数与条数相乘', async () => {
  const { env, calls } = chainEnv(() => {
    throw aiError('Error: internal error; reference = zzz');
  });

  const { status } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/translate',
        { text: ['Good morning.', 'How are you?'], source_lang: 'EN', target_lang: 'ZH' },
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 503);
  // 2 条 × 2 个模型 × 1 次；不是 2 × 2 × 2
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((m) => m === PRIMARY).length, 2);
  assert.equal(calls.filter((m) => m === SECONDARY).length, 2);
});

test('推理超时直接换兜底模型，不在同一模型上再等一次', async () => {
  const { env, calls } = chainEnv((model) => {
    if (model === PRIMARY) throw aiError('3007: Request timeout', 3007);
    return openAI('你好，世界！');
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 200);
  assert.equal(body.data, '你好，世界！');
  assert.deepEqual(calls, [PRIMARY, SECONDARY]);
});

test('拿到过正文但兜底遇到容量限流时，报 429 而不是 503', async () => {
  const { env } = chainEnv((model) => {
    if (model === PRIMARY) return openAI('');
    throw aiError('3040: Capacity temporarily exceeded.', 3040);
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 429, JSON.stringify(body));
  assert.match(body.message, /Capacity/);
});

test('整段只有标签时直接原样返回，不调用模型', async () => {
  const { env, calls } = chainEnv(() => openAI(''));

  const { status, body } = await readJson(
    await worker.fetch(
      jsonRequest(
        '/translate',
        { text: '<p></p>', source_lang: 'EN', target_lang: 'ZH', tag_handling: 'html' },
        AUTH,
      ),
      env,
    ),
  );

  assert.equal(status, 200);
  assert.equal(body.data, '<p></p>');
  assert.equal(calls.length, 0);
});

test('五位账号级错误码也能带进 503 报文', async () => {
  const { env } = chainEnv(() => {
    throw aiError('10021: Service unavailable for account');
  });

  const { status, body } = await translateWith(env);

  assert.equal(status, 503);
  assert.match(body.message, /Workers AI error 10021/);
});

test('GET / 回显构建标识与模型配置，未注入 BUILD 时为 null', async () => {
  const withBuild = await readJson(
    await worker.fetch(new Request(BASE, { method: 'GET' }), createEnv({ BUILD: 'abc1234-dirty' })),
  );
  assert.equal(withBuild.status, 200);
  assert.equal(withBuild.body.build, 'abc1234-dirty');
  assert.ok(withBuild.body.model, 'model 应当回显');
  assert.ok(withBuild.body.fallback_model, 'fallback_model 应当回显');

  const noBuild = await readJson(await worker.fetch(new Request(BASE, { method: 'GET' }), createEnv()));
  assert.equal(noBuild.body.build, null);
});
