// ============================================================
// LeanTrace 端到端测试：真实 workerd 运行时 + 本地 D1
//
// 运行: npm run e2e   （要求 Node >= 23.6，Windows/Linux 均可）
//
// 自动完成：
//   0. .dev.vars 不存在时自举仅测试用的 TOKEN_SECRET（CI/全新 clone 开箱即跑）
//   1. 【故意不建库】从空 D1 启动，验证版本化自动迁移
//   2. 后台启动 wrangler dev (127.0.0.1:8787)
//   3. 用真实 HTTP 请求走完埋点全流程后杀掉进程树
// ============================================================
import { execSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`);
  }
}

let child = null;
function killDev() {
  if (child && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      child.kill();
    }
  }
}
function cleanup(code) {
  killDev();
  console.log(`\n== 结果: ${passed} passed, ${failed} failed ==`);
  process.exit(code);
}

/** 停服后直读本地 D1：验证版本表已自动落戳 */
function verifySchemaVersion() {
  killDev();
  try {
    const out = execSync(
      'npx wrangler d1 execute leantrace --local --json --command "select version from t_schema_version"',
      { cwd: ROOT, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } },
    ).toString();
    const m = out.match(/\"version\"\s*:\s*(\d+)/);
    check('t_schema_version 已自动落戳为 v1', m !== null && Number(m[1]) === 1, out.slice(0, 200));
  } catch (e) {
    check('t_schema_version 已自动落戳为 v1', false, String(e.message).slice(0, 200));
  }
}

// ---- 0) .dev.vars 自举：CI/全新 clone 下不存在时生成仅测试用的密钥 ----
//（.gitignore 已忽略 .dev.vars；存在则不覆盖，尊重本地配置）
if (!existsSync(join(ROOT, '.dev.vars'))) {
  writeFileSync(join(ROOT, '.dev.vars'), 'TOKEN_SECRET=e2e-test-only-secret-0123456789\n');
  console.log('  未找到 .dev.vars，已生成仅测试用密钥');
}

// ---- 1) 【故意不初始化本地 D1】从空库启动，验证惰性自动迁移 ----
//（生产部署同样免手动 initSql，见 src/lib/migrate.ts）
console.log('== 跳过手动建库，从空 D1 启动（验证版本化自动迁移） ==');
// ---- 2) 启动 wrangler dev（直接调 node + wrangler bin，避免 npx/shell）----
console.log('\n== 启动 wrangler dev ==');
let devLog = '';
const wranglerBin = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
child = spawn(process.execPath, [wranglerBin, 'dev', '--port', '8787'], {
  cwd: ROOT,
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
});
child.stdout.on('data', (d) => (devLog += d));
child.stderr.on('data', (d) => (devLog += d));

let ready = false;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  try {
    const res = await fetch(BASE + '/');
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没就绪 */
  }
}
if (!ready) {
  console.error('wrangler dev 未就绪，最后 3000 字符日志:\n' + devLog.slice(-3000));
  cleanup(1);
}
console.log('  dev server 就绪');

// 空库首次查询：触发自动迁移后应送 404（站点不存在，而非 500 no such table）
{
  const probe = await fetch(BASE + '/api/stats?hostname=blog.example.com');
  check('空库自动迁移：首次查询触发建表后返回 404（非 500）', probe.status === 404, `status=${probe.status}`);
}

// ---- 3) HTTP 场景 ----
async function visit(body) {
  const res = await fetch(BASE + '/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const payload = (url, token, extra = {}) => ({
  hostname: 'blog.example.com',
  url,
  referrer: 'https://www.google.com/search?q=leantrace',
  pv: true,
  uv: true,
  token,
  ...extra,
});
const decodeN = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8')).n;

console.log('\n== HTTP 场景（wrangler dev 下所有请求共享同一本地 IP，天然覆盖 IP 限额路径） ==');
let r = await visit(payload('/e2e/'));
check(
  '首访 /e2e/ -> 200, pv=1 uv=1, 下发 v1 token',
  r.status === 200 && r.json.ret === 'OK' && r.json.data.pv === 1 && r.json.data.uv === 1 && typeof r.json.data.token === 'string' && decodeN(r.json.data.token) === 1,
  JSON.stringify(r.json).slice(0, 200),
);
let tok = r.json.data.token;

r = await visit(payload('/e2e/', tok));
check(
  '携带 token 刷新 -> pv=2 uv=1, 回发 v2（单次消费后必换发）',
  r.json.data.pv === 2 && r.json.data.uv === 1 && typeof r.json.data.token === 'string' && decodeN(r.json.data.token) === 2,
  JSON.stringify(r.json).slice(0, 200),
);
const tokV2 = r.json.data.token;

r = await visit(payload('/e2e-2/', tokV2));
check(
  '同访客新页 /e2e-2/ -> 该页 pv=1 uv=1, 回发 v3',
  r.json.data.pv === 1 && r.json.data.uv === 1 && typeof r.json.data.token === 'string' && decodeN(r.json.data.token) === 3,
  JSON.stringify(r.json).slice(0, 200),
);
const tokV3 = r.json.data.token;

r = await visit(payload('/e2e/', tokV2)); // 重放已消费的 v2
check(
  '重放旧版本 token -> 竞态宽限只读返回: pv 不增, 无 token',
  r.json.data.pv === 2 && r.json.data.uv === 1 && !('token' in r.json.data),
  JSON.stringify(r.json).slice(0, 200),
);

r = await visit(payload('/e2e/')); // token 丢失（无 token）
check(
  'token 丢失 + 同 IP 一小时内已建号 -> 限额拦截: 不计数不下发',
  r.json.data.pv === 2 && r.json.data.uv === 1 && !('token' in r.json.data),
  JSON.stringify(r.json).slice(0, 200),
);

r = await visit(payload('/e2e/', 'forged.' + tokV3.slice(8)));
check(
  '伪造 token -> 验签失败走新用户规则，同 IP 限额拦截: 不计数不下发',
  r.json.data.pv === 2 && r.json.data.uv === 1 && !('token' in r.json.data),
  JSON.stringify(r.json).slice(0, 200),
);

r = await visit({ hostname: 'blog.example.com', url: '/e2e/', token: tokV3 });
check(
  '无 pv/uv 标志 + 有效 token -> 仍计数（pv=3）, data 无计数字段但含新 token',
  r.json.ret === 'OK' && Object.keys(r.json.data).length === 1 && typeof r.json.data.token === 'string' && decodeN(r.json.data.token) === 4,
  JSON.stringify(r.json).slice(0, 200),
);
const tokV4 = r.json.data.token;

let res = await fetch(BASE + '/api/stats?hostname=blog.example.com&url=/e2e/');
let s = await res.json();
check('GET /api/stats 单页 -> pv=3 uv=1', res.status === 200 && s.data.pv === 3 && s.data.uv === 1, JSON.stringify(s));

res = await fetch(BASE + '/api/stats?hostname=blog.example.com');
s = await res.json();
check(
  'GET /api/stats 站点汇总 -> pv=4 uv=2 (3+1, 1+1)',
  res.status === 200 && s.data.pv === 4 && s.data.uv === 2,
  JSON.stringify(s),
);

res = await visit({ url: '/x/' });
check('缺 hostname -> 400', res.status === 400, JSON.stringify(res.json));

res = await fetch(BASE + '/api/stats?hostname=nosuch.io');
check('未知站点 -> 404', res.status === 404);

res = await visit({ hostname: 'BAD HOST!!', url: '/x/' });
check('非法 hostname -> 400', res.status === 400);

// 长路径截断不 500（无 token -> 限额拦截路径 -> 只读返回 200）
res = await visit(payload('/' + 'a'.repeat(2000)));
check('超长路径被截断处理（不 500）', res.status === 200 && res.json.ret === 'OK', JSON.stringify(res.json).slice(0, 120));

// 有效 token + 长路径：正常计数路径下截断仍工作
res = await visit(payload('/' + 'b'.repeat(2000), tokV4));
check('有效 token + 超长路径 -> 计数成功且 pv=1', res.status === 200 && res.json.data.pv === 1, JSON.stringify(res.json).slice(0, 120));
const tokV5 = res.json.data.token;

// --- 404 哨兵（D1 计费优化）：错误页不建独立计数行 ---
let r404 = await visit(payload('/wp-admin/setup.php', tokV5, { status: 404 }));
check(
  '404 页面 -> 哨兵行计数 pv=1（真实路径不建行）',
  r404.json.ret === 'OK' && r404.json.data.pv === 1 && r404.json.data.uv === 1 && typeof r404.json.data.token === 'string',
  JSON.stringify(r404.json).slice(0, 120),
);
const tokV6 = r404.json.data.token;

res = await fetch(BASE + '/api/stats?hostname=blog.example.com&url=/wp-admin/setup.php');
s = await res.json();
check('真实 404 路径无计数行（pv=0）', res.status === 200 && s.data.pv === 0 && s.data.uv === 0, JSON.stringify(s));

res = await fetch(BASE + '/api/stats?hostname=blog.example.com&url=/__lt_404__');
s = await res.json();
check('哨兵行可查询：全站 404 汇总 pv=1', res.status === 200 && s.data.pv === 1, JSON.stringify(s));

res = await fetch(BASE + '/api/stats?hostname=blog.example.com');
s = await res.json();
check('站点总量不受 404 影响（仍 pv=5）', s.data.pv === 5, JSON.stringify(s));

// 同访客第二个 404：哨兵 uv 去重
r404 = await visit(payload('/wp-login.php', tokV6, { status: 404 }));
check('同访客再 404 -> 哨兵 pv=2 uv 仍为 1', r404.json.data.pv === 2 && r404.json.data.uv === 1, JSON.stringify(r404.json).slice(0, 120));

res = await fetch(BASE + '/api/stats?hostname=blog.example.com');
s = await res.json();
check('站点总量仍不受 404 影响（pv=5）', s.data.pv === 5, JSON.stringify(s));

// --- 根路径自演示页与直供埋点脚本 ---
res = await fetch(BASE + '/');
const homeHtml = await res.text();
check(
  '根路径为自演示页（含实时计数元素与脚本引用）',
  res.status === 200 &&
    (res.headers.get('content-type') || '').includes('text/html') &&
    homeHtml.includes('id="page_pv"') &&
    homeHtml.includes('/js/index.min.js') &&
    homeHtml.includes('check-url'),
  res.headers.get('content-type') + '',
);
res = await fetch(BASE + '/js/index.min.js');
const beaconBody = await res.text();
check(
  'Worker 直供埋点脚本（/js/index.min.js）',
  res.status === 200 &&
    (res.headers.get('content-type') || '').includes('javascript') &&
    beaconBody.includes('leantrace_token') &&
    beaconBody.includes('/api/visit'),
  res.headers.get('content-type') + '',
);

// 停服后终验版本表，再汇总退出
verifySchemaVersion();
cleanup(failed === 0 ? 0 : 1);
