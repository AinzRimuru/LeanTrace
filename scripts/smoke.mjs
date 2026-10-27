// ============================================================
// LeanTrace 冒烟测试（无需网络 / 无需 wrangler / 无需 Cloudflare 账号）
//
// 运行: node scripts/smoke.mjs    （要求 Node >= 23.6，建议 24+）
//
// 验证内容：
//   P1  schema 可执行且幂等；新旧 schema 的 EXPLAIN QUERY PLAN 对比
//   P2  Bloom 误判率实测；token 长度有界性；明细保留期清理
//   P3  token 签发/验签/防篡改/过期；PV/UV 全场景计数语义
//
// 注意：SQL 部分镜像 src/lib/db.ts（recordVisit 拆为 run+get 两步），
// 改任何一侧时必须同步另一侧。
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
function section(name) {
  console.log(`\n== ${name} ==`);
}

// ---- 加载线上同一份 token 模块（Node 原生类型擦除运行 .ts）----
const token = await import(pathToFileURL(join(ROOT, 'src/lib/token.ts')).href);
const {
  BLOOM_BYTES,
  TOKEN_REFRESH_SEC,
  TOKEN_TTL_SEC,
  bloomAdd,
  bloomContains,
  issueToken,
  pagePositions,
  parseToken,
  randomVid,
} = token;

// 加载线上同一份落点解析模块（哨兵路径 + 上限判定）
const pathsMod = await import(pathToFileURL(join(ROOT, 'src/lib/paths.ts')).href);
const { PATH_404, PATH_ERR, PATH_OVERFLOW, resolveStatTarget } = pathsMod;

// ---- 与 src/lib/db.ts 保持一致的 SQL ----
const SQL = {
  metaByDomain: `
    select w.id as id, w.page_count as page_count,
            exists(select 1 from t_page_stat p
                   where p.website_id = w.id and p.url_path = ?2 limit 1) as has_page
    from t_website w where w.domain = ?1`,
  createWebsite: `
    insert into t_website (name, domain) values (?1, ?2)
    on conflict (domain) do update set update_at = current_timestamp
    returning id`,
  insertLog: `
    insert into t_visit_log (website_id, url_path, visitor_id, referrer_domain, referrer_path, status)
    values (?1, ?2, ?3, ?4, ?5, ?6)`,
  pageCondIncr: `
    update t_website set page_count = page_count + 1
    where id = ?1 and not exists (
      select 1 from t_page_stat p where p.website_id = ?1 and p.url_path = ?2 limit 1
    )`,
  siteCounters: `
    update t_website set pv = pv + 1, uv = uv + ?2, update_at = current_timestamp
    where id = ?1`,
  readSiteCounters: `select pv, uv from t_website where id = ?1`,
  bumpStat: `
    insert into t_page_stat (website_id, url_path, pv, uv) values (?1, ?2, 1, ?3)
    on conflict (website_id, url_path) do update
      set pv = pv + 1, uv = uv + excluded.uv, update_at = current_timestamp`,
  readStat: `select pv, uv from t_page_stat where website_id = ?1 and url_path = ?2`,
  purge: `
    delete from t_visit_log where id in (
      select id from t_visit_log where create_at < ?1 limit 500
    )`,
};

const db = new DatabaseSync(':memory:');

// ------------------------------------------------------------
section('P1: schema 初始化与幂等');
db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
check('schema.sql 可执行', true);
db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
check('schema.sql 重复执行幂等（if not exists）', true);

// ------------------------------------------------------------
section('P1: 查询计划（新 vs 旧）');
function planOf(database, sql, params) {
  return database
    .prepare('explain query plan ' + sql)
    .all(...params)
    .map((row) => row.detail)
    .join(' | ');
}
const planSite = planOf(db, 'select id from t_website where domain = ?1', ['a.com']);
check('站点查询走唯一索引（旧版：SCAN）', planSite.includes('uk_website_domain'), planSite);
const planStat = planOf(db, SQL.readStat, [1, '/x/']);
check('计数读取走主键点查（旧版：SCAN + COUNT）', planStat.includes('PRIMARY KEY'), planStat);
const planPurge = planOf(db, 'select id from t_visit_log where create_at < ?1 limit 500', ['2020-01-01']);
check('清理子查询走时间索引', planPurge.includes('idx_visit_log_created_at'), planPurge);
const planSiteO1 = planOf(db, SQL.readSiteCounters, [1]);
check('站点汇总走主键点查（旧实现 SUM 扫全部页面行，无上界）', planSiteO1.includes('PRIMARY KEY'), planSiteO1);
const planMeta = planOf(db, SQL.metaByDomain, ['a.com', '/x/']);
check('站点元信息（ID+页数+存在性）一次点查完成', planMeta.includes('uk_website_domain') && planMeta.includes('PRIMARY KEY') && !planMeta.includes('SCAN'), planMeta);

// 对照组：旧项目（webviso 类实现）的表结构，原样内联保留 ——
// 无任何索引、每次 PV 插一行含明文 IP、UV 靠 COUNT(DISTINCT ip)
const OLD_SCHEMA_SQL = `
  create table t_website (
    id integer primary key autoincrement,
    name text not null,
    domain text not null,
    create_at datetime default current_timestamp,
    update_at datetime default current_timestamp
  );
  create table t_web_visitor (
    id integer primary key autoincrement,
    website_id integer not null,
    url_path text not null,
    referrer_domain text not null,
    referrer_path text not null,
    visitor_ip text not null,
    create_at datetime default current_timestamp,
    update_at datetime default current_timestamp
  );
`;
const oldDb = new DatabaseSync(':memory:');
oldDb.exec(OLD_SCHEMA_SQL);
const planOldUv = planOf(
  oldDb,
  'select count(*) as total from (select distinct visitor_ip from t_web_visitor where website_id = ?1 and url_path = ?2)',
  [1, '/x/'],
);
check('对照组：旧版 UV 查询确为全表扫描', planOldUv.includes('SCAN'), planOldUv);

// ------------------------------------------------------------
section('P3: token 签发与校验');
const SECRET = 'smoke-secret-0123456789abcdef';
const OTHER_SECRET = 'another-secret-abcdefghij';
const now = Math.floor(Date.now() / 1000);

const vid = randomVid();
check('访客 ID 为 32 位 hex', /^[0-9a-f]{32}$/.test(vid), vid);
const tokStr = await issueToken(SECRET, { vid, version: 1, bloom: new Uint8Array(BLOOM_BYTES), exp: now + TOKEN_TTL_SEC });
const parsed = await parseToken(tokStr, SECRET, now);
check(
  'token 签发/解析往返一致（含版本号 n=1）',
  parsed !== null && parsed.vid === vid && parsed.version === 1 && parsed.exp === now + TOKEN_TTL_SEC,
  JSON.stringify(parsed),
);
const tampered = tokStr.slice(0, -2) + (tokStr.endsWith('aa') ? 'bb' : 'aa');
check('篡改后验签失败', (await parseToken(tampered, SECRET, now)) === null);
check('密钥不符验签失败', (await parseToken(tokStr, OTHER_SECRET, now)) === null);
const expiredStr = await issueToken(SECRET, { vid, version: 1, bloom: new Uint8Array(BLOOM_BYTES), exp: now - 10 });
check('过期 token 被拒', (await parseToken(expiredStr, SECRET, now)) === null);
check('垃圾字符串被拒', (await parseToken('garbage', SECRET, now)) === null);
check('非字符串被拒', (await parseToken({ v: 1 }, SECRET, now)) === null);
check('多段注入被拒', (await parseToken(tokStr + '.' + tokStr.slice(0, 5), SECRET, now)) === null);

// ------------------------------------------------------------
section('P3: 防重放 + PV/UV 计数语义（镜像 src/index.ts 的服务端逻辑）');

const IP_WINDOW_SEC = 3600;
const TAB_RACE_GRACE_SEC = 15;

// 与 src/lib/db.ts 新增语句逐字镜像
const SQL2 = {
  consumeVersion:
    `update t_visitor_state set last_used_version = ?1, update_at = current_timestamp where visitor_id = ?2 and last_used_version < ?1`,
  createVisitor:
    `insert into t_visitor_state (visitor_id, last_used_version, ip, ip_hour) select ?1, 0, ?2, ?3 where not exists (select 1 from t_visitor_state where ip = ?2 and create_at > ?4)`,
  recentlyActive: `select 1 as ok from t_visitor_state where visitor_id = ?1 and update_at > ?2`,
};

const planCas = planOf(db, SQL2.consumeVersion, [1, '0123456789abcdef0123456789abcdef']);
check('CAS 消费走主键索引点查（text 主键 -> 自动唯一索引）', planCas.startsWith('SEARCH') && planCas.includes('visitor_id=?'), planCas);
const planCreate = planOf(db, SQL2.createVisitor, ['0123456789abcdef0123456789abcdef', '1.2.3.4', '1.2.3.4|1', '2020-01-01 00:00:00']);
check('建号限额探测走 (ip, create_at) 覆盖索引（SCAN CONSTANT ROW 为单行常量源，非表扫描）', planCreate.includes('COVERING INDEX idx_visitor_state_ip_create'), planCreate);
const planGrace = planOf(db, SQL2.recentlyActive, ['0123456789abcdef0123456789abcdef', '2020-01-01 00:00:00']);
check('竞态宽限探测走主键索引点查', planGrace.startsWith('SEARCH') && planGrace.includes('visitor_id=?'), planGrace);

const decodeToken = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
// 与 src/lib/db.ts 的 sqliteUtc 一致：CURRENT_TIMESTAMP 格式 'YYYY-MM-DD HH:MM:SS'（UTC）
const sqliteUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
/** 与 src/index.ts POST /api/visit 逐句对应 */
const CAP = 3; // 测试用每站页面上限（生产默认 5000，见 wrangler.toml）
const sitePv = () => Number(db.prepare(SQL.readSiteCounters).get(1).pv);

async function resolveSite(hostname, realPath) {
  const row = db.prepare(SQL.metaByDomain).get(hostname, realPath);
  if (row) {
    return { websiteId: Number(row.id), pageCount: Number(row.page_count), hasPage: Number(row.has_page) === 1 };
  }
  const id = Number(db.prepare(SQL.createWebsite).get(hostname.split('.').join('_'), hostname).id);
  return { websiteId: id, pageCount: 0, hasPage: false };
}
async function createNewVisitor(ip, nowSec, positions) {
  const visitorId = randomVid();
  const ipHour = `${ip}|${Math.floor(nowSec / IP_WINDOW_SEC)}`;
  const windowCutoff = sqliteUtc(new Date(Date.now() - IP_WINDOW_SEC * 1000));
  let res;
  try {
    res = db.prepare(SQL2.createVisitor).run(visitorId, ip, ipHour, windowCutoff);
  } catch (e) {
    if (!String(e).includes('UNIQUE')) throw e;
    return { counted: false, visitorId: '', nextToken: null }; // 同桶并发竞态
  }
  if (res.changes !== 1) return { counted: false, visitorId: '', nextToken: null };
  const bloom = new Uint8Array(BLOOM_BYTES);
  bloomAdd(bloom, positions);
  const nextToken = await issueToken(SECRET, { vid: visitorId, version: 1, bloom, exp: nowSec + TOKEN_TTL_SEC });
  return { counted: true, visitorId, nextToken };
}

async function visit(hostname, urlPath, tokenRaw, opts = {}) {
  const ip = opts.ip || '9.9.9.9';
  const status = typeof opts.status === 'number' ? opts.status : 200;
  const meta = await resolveSite(hostname, urlPath);
  const target = resolveStatTarget(status, urlPath, meta.pageCount, meta.hasPage, CAP);
  const nowSec = Math.floor(Date.now() / 1000);
  const positions = await pagePositions(meta.websiteId, target.statPath);

  let counted = false;
  let visitorId = '';
  let uvBump = 0;
  let nextToken = null;

  const tok = await parseToken(tokenRaw, SECRET, nowSec);
  if (tok) {
    const cas = db.prepare(SQL2.consumeVersion).run(tok.version, tok.vid);
    if (cas.changes === 1) {
      // 路径 A：携带最新 token —— 计数并回发 version+1
      counted = true;
      visitorId = tok.vid;
      if (!bloomContains(tok.bloom, positions)) {
        bloomAdd(tok.bloom, positions);
        uvBump = 1;
      }
      tok.version += 1;
      nextToken = await issueToken(SECRET, tok);
    } else {
      const graceCutoff = sqliteUtc(new Date(Date.now() - TAB_RACE_GRACE_SEC * 1000));
      const inGrace = db.prepare(SQL2.recentlyActive).get(tok.vid, graceCutoff);
      if (!inGrace) {
        // 路径 B：重放/状态过期 -> 新用户规则（受 IP 限额）
        const reborn = await createNewVisitor(ip, nowSec, positions);
        counted = reborn.counted;
        visitorId = reborn.visitorId;
        nextToken = reborn.nextToken;
        if (reborn.counted) uvBump = 1; // 新访客必为首访（与 index.ts 一致）
      }
      // 路径 C：竞态宽限 —— 只读返回
    }
  } else {
    // 路径 B：无 token / 验签失败
    const fresh = await createNewVisitor(ip, nowSec, positions);
    counted = fresh.counted;
    visitorId = fresh.visitorId;
    nextToken = fresh.nextToken;
    if (fresh.counted) uvBump = 1; // 新访客必为首访（与 index.ts 一致）
  }

  let row;
  if (counted) {
    // 镜像 recordVisit 的 batch 语句顺序（顺序即语义）
    db.prepare(SQL.insertLog).run(meta.websiteId, urlPath, visitorId, '', '', status);
    if (target.isRealPath) {
      db.prepare(SQL.pageCondIncr).run(meta.websiteId, target.statPath);
    }
    db.prepare(SQL.bumpStat).run(meta.websiteId, target.statPath, uvBump);
    if (target.countSite) {
      db.prepare(SQL.siteCounters).run(meta.websiteId, uvBump);
    }
    row = db.prepare(SQL.readStat).get(meta.websiteId, target.statPath);
  } else {
    row = db.prepare(SQL.readStat).get(meta.websiteId, target.statPath) || { pv: 0, uv: 0 };
  }
  return {
    stat: { pv: Number(row.pv), uv: Number(row.uv) },
    token: nextToken,
    counted,
    statPath: target.statPath,
  };
}

const SITE = 'blog.example.com';

// --- 正常流程：首访、回访、新页 ---
let r = await visit(SITE, '/a/', null, { ip: '198.51.100.1' });
check('场景1 首访（IP-A）-> pv=1 uv=1 且下发 v1 token', r.stat.pv === 1 && r.stat.uv === 1 && typeof r.token === 'string', JSON.stringify(r.stat));
let t1 = r.token;
const vid1 = decodeToken(t1).v;
check('场景1 token 版本号 n=1', decodeToken(t1).n === 1);

r = await visit(SITE, '/a/', t1);
check('场景2 携带 token 刷新 -> pv=2 uv=1（IP 无关）且回发 v2', r.stat.pv === 2 && r.stat.uv === 1 && typeof r.token === 'string' && decodeToken(r.token).n === 2, JSON.stringify(r.stat));
let t2 = r.token;

r = await visit(SITE, '/b/', t2);
check('场景3 同访客新页 /b/ -> 该页 pv=1 uv=1 且回发 v3', r.stat.pv === 1 && r.stat.uv === 1 && typeof r.token === 'string' && decodeToken(r.token).n === 3, JSON.stringify(r.stat));
let t3 = r.token;
check('场景1-3 同一访客 ID 贯穿', decodeToken(t3).v === vid1);

// --- 防重放 ---
r = await visit(SITE, '/a/', t1); // 重放 v1（已消费到 v3）
check('场景4 重放旧 token（v1）-> 不计数不回发（竞态宽限窗口内）', !r.counted && r.stat.pv === 2 && r.stat.uv === 1 && r.token === null, JSON.stringify(r.stat));

db.prepare(`update t_visitor_state set update_at = '2020-01-01 00:00:00' where visitor_id = ?`).run(vid1);
r = await visit(SITE, '/a/', t1, { ip: '198.51.100.1' });
check('场景5 宽限过期 + IP-A 一小时内已建号 -> 限额拦截：不计数不回发', !r.counted && r.stat.pv === 2 && r.stat.uv === 1 && r.token === null, JSON.stringify(r.stat));

// 模拟「窗口已过」：生产中 create_at/ip_hour 在建号时固化，2 小时前的行自然落在旧小时桶；
// 测试里手动老化必须两列同步，否则会撞 ip_hour 唯一索引（那是同桶竞态兑底，属正常拦截）
db.prepare(`update t_visitor_state set create_at = '2020-01-01 00:00:00', ip_hour = 'aged|0' where visitor_id = ?`).run(vid1);
r = await visit(SITE, '/a/', t1, { ip: '198.51.100.1' });
check('场景6 窗口外重放 -> 按新用户计（uv+1）并签发新身份 v1', r.counted && r.stat.pv === 3 && r.stat.uv === 2 && typeof r.token === 'string' && decodeToken(r.token).n === 1 && decodeToken(r.token).v !== vid1, JSON.stringify(r.stat));

// --- IP 限额 ---
r = await visit(SITE, '/c/', null, { ip: '198.51.100.2' });
check('场景7 新 IP-B 首访 /c/ -> pv=1 uv=1', r.counted && r.stat.pv === 1 && r.stat.uv === 1 && typeof r.token === 'string', JSON.stringify(r.stat));
let t5 = r.token;
r = await visit(SITE, '/c/', null, { ip: '198.51.100.2' });
check('场景8 同 IP 一小时内二次建号 -> 拦截：不计数不回发', !r.counted && r.stat.pv === 1 && r.stat.uv === 1 && r.token === null, JSON.stringify(r.stat));

r = await visit(SITE, '/c/', t5);
check('场景9 合法 token 仍可正常计数（pv=2 uv=1，回发 v2）', r.counted && r.stat.pv === 2 && r.stat.uv === 1 && decodeToken(r.token).n === 2, JSON.stringify(r.stat));
r = await visit(SITE, '/c/', t5);
check('场景10 同一 token 二次使用 -> 不计数（单次消费语义）', !r.counted && r.stat.pv === 2 && r.stat.uv === 1 && r.token === null, JSON.stringify(r.stat));

// --- 跨站点 ---
r = await visit('other.example.org', '/a/', t3);
check('场景11 跨站点同 token（未消费的 v3）-> 各站独立 uv=1', r.counted && r.stat.pv === 1 && r.stat.uv === 1 && decodeToken(r.token).n === 4, JSON.stringify(r.stat));
const siteA = db.prepare(SQL.readStat).get(1, '/a/');
check('场景11 站点1 /a/ 不受影响（仍 pv=3 uv=2）', Number(siteA.pv) === 3 && Number(siteA.uv) === 2, JSON.stringify(siteA));

// --- 非法 token 按新用户规则 ---
const forged = t3.slice(0, 20) + 'x' + t3.slice(21);
r = await visit(SITE, '/a/', forged, { ip: '198.51.100.3' });
check('场景12 伪造 token（验签失败）-> 新 IP 按新用户计 uv+1', r.counted && r.stat.pv === 4 && r.stat.uv === 3, JSON.stringify(r.stat));
r = await visit(SITE, '/a/', forged, { ip: '198.51.100.3' });
check('场景13 同 IP 重复伪造 -> 限额拦截', !r.counted && r.stat.pv === 4 && r.stat.uv === 3 && r.token === null, JSON.stringify(r.stat));

// --- CAS 原子性（同版本仅消费一次）---
const vid3Row = db.prepare('select visitor_id from t_visitor_state order by create_at desc limit 1').get();
const cas1 = db.prepare(SQL2.consumeVersion).run(999, vid3Row.visitor_id);
const cas2 = db.prepare(SQL2.consumeVersion).run(999, vid3Row.visitor_id);
check('场景14 同版本并发消费仅一次成功（CAS）', cas1.changes === 1 && cas2.changes === 0, `${cas1.changes}/${cas2.changes}`);

const id1 = Number(db.prepare(SQL.createWebsite).get('blog_example_com', SITE).id);
const id2 = Number(db.prepare(SQL.createWebsite).get('blog_example_com', SITE).id);
check('场景15 建站 upsert 幂等（同 domain 同 id，并发安全）', id1 === id2);

// ------------------------------------------------------------
section('P4: 404/错误哨兵与站点级计数器（D1 计费优化）');

// 场景16：404 不建真实路径行，聚合到哨兵，不计入站点总量
let sitePvBefore = sitePv();
r = await visit(SITE, '/gone-page/', null, { ip: '198.51.100.4', status: 404 });
check('场景16 404 -> 落点为哨兵行，pv=1 uv=1', r.counted && r.statPath === PATH_404 && r.stat.pv === 1 && r.stat.uv === 1, JSON.stringify(r.stat));
check('场景16 真实路径 /gone-page/ 无计数行', db.prepare(SQL.readStat).get(1, '/gone-page/') === undefined);
const log404 = db.prepare("select url_path, status from t_visit_log order by id desc limit 1").get();
check('场景16 明细表保留真实路径与状态码（诊断用）', log404.url_path === '/gone-page/' && log404.status === 404, JSON.stringify(log404));
check('场景16 站点总量不受 404 影响', sitePv() === sitePvBefore, `${sitePvBefore} -> ${sitePv()}`);
let tokE = r.token;

// 场景17：同访客第二个 404 路径 -> 哨兵 uv 去重（bloom 按哨兵位置）
r = await visit(SITE, '/gone-2/', tokE, { status: 404 });
check('场景17 同访客再 404 -> 哨兵 pv=2 uv 仍为 1', r.counted && r.statPath === PATH_404 && r.stat.pv === 2 && r.stat.uv === 1, JSON.stringify(r.stat));
tokE = r.token;

// 场景18：500 走独立错误哨兵
r = await visit(SITE, '/boom/', tokE, { status: 500 });
check('场景18 500 -> /__lt_err__ 独立哨兵 pv=1', r.counted && r.statPath === PATH_ERR && r.stat.pv === 1, JSON.stringify(r.stat));
check('场景18 404 哨兵不受影响', Number(db.prepare(SQL.readStat).get(1, PATH_404).pv) === 2);
tokE = r.token;

// 场景19：页面数达上限（CAP=3：/a/ /b/ /c/）后新路径 -> 溢出哨兵
sitePvBefore = sitePv();
r = await visit(SITE, '/brand-new/', tokE);
check('场景19 超上限新路径 -> 溢出哨兵，计入站点总量', r.counted && r.statPath === PATH_OVERFLOW && r.stat.pv === 1 && sitePv() === sitePvBefore + 1, JSON.stringify(r.stat));
check('场景19 真实路径 /brand-new/ 无计数行', db.prepare(SQL.readStat).get(1, '/brand-new/') === undefined);
check('场景19 page_count 镜像仍为 3（真实行数）', Number(db.prepare("select page_count from t_website where id = 1").get().page_count) === 3);
tokE = r.token;

// 场景20：已有页面不受上限影响
r = await visit(SITE, '/a/', tokE);
check('场景20 已有页面 /a/ 仍正常计数（pv 4->5，访客 bloom 首见 /a/ -> uv+1）', r.counted && r.statPath === '/a/' && r.stat.pv === 5 && r.stat.uv === 4, JSON.stringify(r.stat));

// 场景21：站点计数器与页面行产一致（无 SUM 重算）
{
  const siteRow = db.prepare(SQL.readSiteCounters).get(1);
  const realRows = db.prepare("select coalesce(sum(pv),0) as pv, coalesce(sum(uv),0) as uv from t_page_stat where website_id = 1 and url_path not in (?1, ?2)").all(PATH_404, PATH_ERR)[0];
  check(
    '场景21 站点计数器 == 除错误哨兵外全部行之和（含溢出哨兵，同步自增无漂移）',
    Number(siteRow.pv) === Number(realRows.pv) && Number(siteRow.uv) === Number(realRows.uv),
    JSON.stringify({ site: siteRow, real: realRows }),
  );
  const totalStatRows = Number(db.prepare('select count(*) as c from t_page_stat where website_id = 1').get().c);
  check('场景21 页面行数 = 3 真实 + 3 哨兵（严格有界）', totalStatRows === 6, String(totalStatRows));
}
// ------------------------------------------------------------
section('P2: Bloom 指纹误判率（默认 2048B / 11 哈希 / 16384 bit，设计容量点）');
{
  const bloom = new Uint8Array(BLOOM_BYTES);
  const PAGES = 1000; // 设计容量点：1000 页 @ 目标误判率 0.1%
  const added = [];
  for (let i = 0; i < PAGES; i++) {
    const pos = await pagePositions(9, `/page-${i}/`);
    bloomAdd(bloom, pos);
    added.push(pos);
  }
  let truePositive = 0;
  for (const pos of added) if (bloomContains(bloom, pos)) truePositive++;
  check(`无假阴性：加入的 ${PAGES} 页全部命中`, truePositive === PAGES);

  let falsePositive = 0;
  const SAMPLES = 100000;
  for (let i = 0; i < SAMPLES; i++) {
    const pos = await pagePositions(9, `/other-${i}/`);
    if (bloomContains(bloom, pos)) falsePositive++;
  }
  const rate = (falsePositive / SAMPLES) * 100;
  console.log(`  INFO  ${PAGES} 页规模下对未见页面的误判率: ${rate.toFixed(4)}%（理论 ~0.04%，只导致 UV 少计）`);
  check('误判率 < 0.2%（目标 0.1%，含采样余量）', rate < 0.2, `${rate}%`);
}

// ------------------------------------------------------------
section('P2: token 长度有界性（用户的膨胀担忧）');
{
  const tok = { vid: randomVid(), bloom: new Uint8Array(BLOOM_BYTES), exp: now + TOKEN_TTL_SEC };
  for (let i = 0; i < 1000; i++) {
    const pos = await pagePositions(5, `/deep-${i}/`);
    bloomAdd(tok.bloom, pos);
  }
  const str = await issueToken(SECRET, tok);
  console.log(`  INFO  访问 1000 个不同页面后 token 长度: ${str.length} 字符`);
  check('访问 1000 页后 token 长度在 3700~3900（定长 Bloom，2048B 指纹）', str.length >= 3700 && str.length < 3900, String(str.length));
  check('token 长度不超过服务端推导上限 TOKEN_MAX_LEN', str.length <= token.TOKEN_MAX_LEN, `${str.length} > ${token.TOKEN_MAX_LEN}`);
}

// ------------------------------------------------------------
section('P2: 明细保留期清理');
{
  const before = Number(db.prepare('select count(*) as c from t_visit_log').get().c);
  db.prepare(
    `insert into t_visit_log (website_id, url_path, visitor_id, create_at)
     values (1, '/old/', 'deadbeefdeadbeefdeadbeefdeadbeef', '2020-01-01 00:00:00')`,
  ).run();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const res = db.prepare(SQL.purge).run(cutoff);
  const after = Number(db.prepare('select count(*) as c from t_visit_log').get().c);
  check(
    '仅删除过期行，近期行不受影响',
    res.changes === 1 && after === before,
    `before=${before} after=${after} changes=${res.changes}`,
  );
}

// ------------------------------------------------------------
section('P1: 计数器并发自增语义（原子性）');
{
  // 直接并发执行 50 次自增，验证 pv 精确 +50（SQLite 单写者串行化）
  for (let i = 0; i < 50; i++) {
    db.prepare(SQL.bumpStat).run(4242, '/atomic/', 0);
  }
  const row = db.prepare(SQL.readStat).get(4242, '/atomic/');
  check('50 次并发自增 pv 精确 = 50', Number(row.pv) === 50 && Number(row.uv) === 0, JSON.stringify(row));
}

// ------------------------------------------------------------
section('P5: 版本化迁移（t_schema_version，部署免手动 initSql）');
{
  // ==== 与 src/lib/migrate.ts 逐句镜像 ====
  const LATEST = 1; // LATEST_SCHEMA_VERSION 镜像（v1 首版）
  const VERSION_TABLE_DDL = `
    create table if not exists t_schema_version (
      id         integer primary key check (id = 1),
      version    integer not null,
      applied_at datetime default current_timestamp
    )`;
  const stampSql = (v) =>
    `insert into t_schema_version (id, version) values (1, ${v}) ` +
    `on conflict (id) do update set version = excluded.version, applied_at = current_timestamp ` +
    `where t_schema_version.version < excluded.version`;
  const DELTA_STEPS = []; // 镜像：v1 首版无存量库，无历史迁移步
  const parseDdl = (sqlText) =>
    sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean);
  const schemaSql = readFileSync(join(ROOT, 'schema.sql'), 'utf8');

  const readVersion = (d) => {
    const row = d.prepare('select version from t_schema_version where id = 1').get();
    return row ? Number(row.version) : 0;
  };
  const schemaSyncOk = (() => {
    const hasVersionTable = /create table if not exists t_schema_version/.test(schemaSql);
    const noPreStamp = !/insert[^;]*t_schema_version/.test(schemaSql); // 预打戳会跳过旧库增量补列
    return hasVersionTable && noPreStamp;
  })();
  check('schema.sql 含版本表且不预打戳（防止跳过存量库补列）', schemaSyncOk);

  // 镜像 ensureSchema 的完整算法
  async function migrateMirror(d) {
    d.prepare(VERSION_TABLE_DDL).run();
    let current = readVersion(d);
    if (current >= LATEST) return current;
    if (current === 0) {
      for (const s of parseDdl(schemaSql)) d.prepare(s).run(); // = db.batch
    }
    for (const step of DELTA_STEPS) {
      if (step.to <= current) continue;
      let dupHit = false;
      try {
        for (const s of step.statements) d.prepare(s).run();
        d.prepare(stampSql(step.to)).run();
      } catch (e) {
        if (!String(e).includes('duplicate column')) throw e;
        dupHit = true;
        d.prepare(stampSql(step.to)).run(); // 整批回滚后单独补戳
      }
      current = step.to;
      if (dupHit) d.__dupHits = (d.__dupHits || 0) + 1;
    }
    // 兕底戳（与 migrate.ts 一致）
    if (current < LATEST) {
      d.prepare(stampSql(LATEST)).run();
      current = LATEST;
    }
    return current;
  }

  // -- 状态 A：空库 -> 最新形态 + 版本 1（增量步为空，兑底戳落 v1）--
  const fresh = new DatabaseSync(':memory:');
  const vFresh = await migrateMirror(fresh);
  const objCount = Number(fresh.prepare("select count(*) as c from sqlite_master where type in ('table','index') and name not like 'sqlite_%'").get().c);
  check('空库 -> 建出 5 表（4 业务 + 版本表）+ 6 索引', objCount === 11, String(objCount));
  check('空库 -> 版本落为 1', vFresh === 1 && readVersion(fresh) === 1, String(vFresh));

  // -- 状态 B：initSql 预建但未打戳的库（表已存在、版本行为空）--
  //（增量步为空时兑底戳路径就是它的落戳方式；未来加入首个增量步后，
  //  此状态应升级为「无戳旧形态库 -> 建表 no-op + 增量生效」的回归用例）
  const modernNoStamp = new DatabaseSync(':memory:');
  for (const s of parseDdl(schemaSql)) modernNoStamp.prepare(s).run();
  modernNoStamp.prepare('delete from t_schema_version').run(); // 抹掉戳模拟 initSql 预建
  const vB = await migrateMirror(modernNoStamp);
  check('预建未打戳库 -> 兑底戳落 v1', vB === 1 && readVersion(modernNoStamp) === 1, String(vB));

  // -- 单调保护与幂等 --
  fresh.prepare(stampSql(1)).run(); // 同版本重戳：no-op
  check('重复戳不报错且版本仍为 1', readVersion(fresh) === 1);
  const vAgain = await migrateMirror(fresh);
  check('重复迁移幂等（已是最新直接返回）', vAgain === 1 && readVersion(fresh) === 1);
}

// ------------------------------------------------------------
console.log(`\n== 结果: ${passed} passed, ${failed} failed ==`);
process.exit(failed === 0 ? 0 : 1);
