// ============================================================
// LeanTrace —— 轻量博客访问统计（Cloudflare Workers + Hono + D1）
//
// 与旧版（analytics_with_cloudflare）的关键差异：
//   1. 全索引访问，PV/UV 为预聚合计数器点查（旧版每次埋点 3~4 条全表扫描）
//   2. UV 去重状态由客户端持有的签名 token 承担（JWT 风格 HMAC + Bloom 指纹）；
//      服务端另保留【有界】防滥用状态表 t_visitor_state（防重放 + IP 限额，
//      一行/访客，按保留期 cron 清理）；明细表仅短期保留用于来源分析
//   3. 访客身份 = 客户端 token 内的随机 ID（localStorage + cookie 双写），
//      换 IP / 换网络身份不变
//   4. D1 计费优化：站点级计数器列（无 SUM 聚合）、404/5xx 与超上限路径
//      聚合到哨兵行（页面行数严格有界）、热路径只读不写
//   5. 免手动建库：首次请求自动迁移 schema（见 lib/migrate.ts）
// ============================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  consumeVisitorVersion,
  createVisitorState,
  createWebsite,
  findWebsiteId,
  purgeExpiredLogs,
  purgeInactiveVisitorStates,
  readPageStat,
  readSiteMetaByDomain,
  readSiteStats,
  recordVisit,
  wasRecentlyActive,
} from './lib/db';
import {
  BLOOM_BYTES,
  TOKEN_REFRESH_SEC,
  TOKEN_TTL_SEC,
  bloomAdd,
  bloomContains,
  issueToken,
  pagePositions,
  parseToken,
  randomVid,
} from './lib/token';
import { resolveStatTarget } from './lib/paths';
import { withSchemaRetry } from './lib/migrate';
import { normalizeHostname, normalizePath, parseReferrer } from './lib/validate';

interface Bindings {
  DB: D1Database;
  /** token 签名密钥（>=16 字符）。线上: wrangler secret put TOKEN_SECRET；本地: .dev.vars */
  TOKEN_SECRET?: string;
  /** t_visit_log 保留天数，默认 90 */
  LOG_RETENTION_DAYS?: string;
  /** t_visitor_state（防重放/IP 限额状态表）保留天数，默认 90 */
  VISITOR_RETENTION_DAYS?: string;
  /** 每站页面计数行上限，超出后新路径计入溢出哨兵行，默认 5000 */
  MAX_PAGES_PER_SITE?: string;
}

class ConfigError extends Error {}

function requireTokenSecret(env: Bindings): string {
  const secret = env.TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new ConfigError(
      'TOKEN_SECRET is not configured (>= 16 chars). ' +
        'Run: npx wrangler secret put TOKEN_SECRET  (local dev: .dev.vars)',
    );
  }
  return secret;
}

function parseMaxPages(env: Bindings): number {
  return Math.max(10, Math.floor(Number(env.MAX_PAGES_PER_SITE ?? '5000')) || 5000);
}

/** 客户端上报的 HTTP 状态码：未知/缺省按 200 处理（老浏览器兼容） */
function parseStatus(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 200;
  if (raw < 100 || raw > 599) return 200;
  return raw;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('LeanTrace analytics is running'));
app.use('/api/*', cors());

/**
 * 埋点上报 + 计数（带防重放）。
 * 兼容旧 payload（hostname/url/referrer/pv/uv），新增可选 token/status 字段。
 * 响应保持旧结构 {ret, data}；token 仅在需要客户端更新时返回。
 *
 * 注意：body 在 withSchemaRetry 之外解析（Workers 的请求体只能读一次，
 * 迁移重试不能重复消费流）；重试的是 handleVisit 整段逻辑，可安全重放。
 */
app.post('/api/visit', async (c) => {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const ip = (c.req.header('CF-Connecting-IP') ?? 'unknown').slice(0, 64);

  try {
    return await withSchemaRetry(c.env.DB, () => handleVisit(c.env, body, ip));
  } catch (err) {
    if (err instanceof ConfigError) {
      return c.json({ ret: 'ERROR', data: null, message: err.message }, 503);
    }
    console.error('visit failed:', err);
    return c.json({ ret: 'ERROR', data: null, message: 'Internal Server Error' }, 500);
  }
});

/**
 * 三条路径：
 *   A. 有效 token 且版本号未被消费（CAS 成功）-> 计数，回发 version+1 的新 token
 *   B. 非法请求（验签失败/重放旧版本/vid 状态过期/无 token）-> 按新用户规则：
 *      IP 1 小时内未建过号则建新 ID 并计数；建过则【不计数、不下发 cookie、
 *      只读返回当前统计】（防同一 bloom 位图重放刷计数，攻击上限 ≤ 1 UV/小时/IP）
 *   C. 多标签页竞态宽限：CAS 失败但该访客数秒内刚活跃 -> 只读返回，不分裂新身份
 */
const IP_WINDOW_SEC = 3600; // 同一 IP 最多每 1 小时产生一个新访客 ID
const TAB_RACE_GRACE_SEC = 15; // 竞态宽限窗口（略大于一次页面加载的网络延迟）

async function handleVisit(
  env: Bindings,
  body: Record<string, unknown> | null,
  ip: string,
): Promise<Response> {
  const hostname = normalizeHostname(body?.hostname);
  if (!hostname) {
    return Response.json({ ret: 'ERROR', data: null, message: 'invalid hostname' }, { status: 400 });
  }
  const realPath = normalizePath(body?.url);
  const referrer = parseReferrer(body?.referrer);
  const status = parseStatus(body?.status);
  const secret = requireTokenSecret(env);
  const maxPages = parseMaxPages(env);

  // 1) 站点元信息（第 1 次 D1 往返，热路径纯读 0 写）：
  //    ID 解析 + page_count 镜像 + 页面存在性，一条语句完成
  let meta = await readSiteMetaByDomain(env.DB, hostname, realPath);
  if (!meta) meta = { websiteId: await createWebsite(env.DB, hostname), pageCount: 0, hasPage: false };

  // 2) 计数落点解析：真实路径 / 404 哨兵 / 错误哨兵 / 溢出哨兵
  //    （404/超上限路径不建独立行，页面行数严格有界；见 lib/paths.ts）
  const target = resolveStatTarget(status, realPath, meta.pageCount, meta.hasPage, maxPages);

  // 3) 指纹位置按【落点路径】计算：404 扫描不消耗真实页面的 bloom 容量
  const now = Math.floor(Date.now() / 1000);
  const positions = await pagePositions(meta.websiteId, target.statPath);

  let counted = false;
  let visitorId = '';
  let uvBump: 0 | 1 = 0;
  let nextToken: string | null = null;

  // 4) 验签 + 版本消费（防重放）
  const tok = await parseToken(body?.token, secret, now);
  if (tok) {
    const consumed = await consumeVisitorVersion(env.DB, tok.vid, tok.version);
    if (consumed) {
      // 路径 A：携带的是最新 token —— 正常计数，版本前移后必须回发新 token
      counted = true;
      visitorId = tok.vid;
      if (!bloomContains(tok.bloom, positions)) {
        bloomAdd(tok.bloom, positions); // Bloom 无假阴性：置位后此页永不再误判为新访客
        uvBump = 1;
      }
      tok.version += 1;
      if (tok.exp - now < TOKEN_REFRESH_SEC) tok.exp = now + TOKEN_TTL_SEC; // 活跃老访客静默续签
      nextToken = await issueToken(secret, tok);
    } else if (await wasRecentlyActive(env.DB, tok.vid, TAB_RACE_GRACE_SEC)) {
      // 路径 C：多标签页竞态（数秒内刚消费过）—— 只读返回，不计数不分裂身份；
      // 同时封死「刚消费完立刻重放旧 bloom 换新 ID」的攻击窗口
    } else {
      // 路径 B（重放/状态过期）：按新用户规则，受 IP 限额约束
      const reborn = await newVisitorFlow(env.DB, secret, { ip, now, positions });
      counted = reborn.counted;
      visitorId = reborn.visitorId;
      nextToken = reborn.nextToken;
      if (reborn.counted) uvBump = 1; // 新访客对落点必为首访
    }
  } else {
    // 路径 B（无 token / 验签失败 / 过期）：首次到访或按新用户规则重建
    const fresh = await newVisitorFlow(env.DB, secret, { ip, now, positions });
    counted = fresh.counted;
    visitorId = fresh.visitorId;
    nextToken = fresh.nextToken;
    if (fresh.counted) uvBump = 1; // 新访客对落点必为首访
  }

  // 5) 计数或只读返回
  let stat: { pv: number; uv: number };
  if (counted) {
    // 明细(真实路径) + 页面计数(落点) + 站点计数器，一次 batch（事务）完成
    stat = await recordVisit(env.DB, {
      websiteId: meta.websiteId,
      statPath: target.statPath,
      realPath,
      status,
      visitorId,
      uvBump,
      countSite: target.countSite,
      isRealPath: target.isRealPath,
      referrer,
    });
  } else {
    // 限额/竞态/重放拒绝：不写入任何记录，只读返回落点当前统计
    stat = await readPageStat(env.DB, meta.websiteId, target.statPath);
  }

  const data: { pv?: number; uv?: number; token?: string } = {};
  if (body?.pv) data.pv = stat.pv;
  if (body?.uv) data.uv = stat.uv;
  if (nextToken) data.token = nextToken;
  return Response.json({ ret: 'OK', data });
}

/**
 * 新用户规则：同一 IP 1 小时（滚动窗口 + 唯一索引兜底）内最多产生一个新访客 ID。
 * 建号成功 -> 本次按新访客计数（uv+1）并签发 version=1 的 token；
 * 限额触发 -> 不计数、不下发 cookie，由调用方只读返回统计。
 */
async function newVisitorFlow(
  db: D1Database,
  secret: string,
  input: { ip: string; now: number; positions: number[] },
): Promise<{ counted: boolean; visitorId: string; nextToken: string | null }> {
  const visitorId = randomVid();
  const ipHour = `${input.ip}|${Math.floor(input.now / IP_WINDOW_SEC)}`;
  const created = await createVisitorState(db, visitorId, input.ip, ipHour, IP_WINDOW_SEC);
  if (!created) return { counted: false, visitorId: '', nextToken: null };

  const bloom = new Uint8Array(BLOOM_BYTES);
  bloomAdd(bloom, input.positions); // 新访客对当前落点必为首访
  const nextToken = await issueToken(secret, {
    vid: visitorId,
    version: 1,
    bloom,
    exp: input.now + TOKEN_TTL_SEC,
  });
  return { counted: true, visitorId, nextToken };
}

/**
 * 只读计数查询（不产生记录）。
 *   GET /api/stats?hostname=blog.example.com&url=/post/hello/  单页（含哨兵行）
 *   GET /api/stats?hostname=blog.example.com                   站点汇总（O(1) 计数器）
 */
app.get('/api/stats', async (c) => {
  try {
    return await withSchemaRetry(c.env.DB, async () => {
      const hostname = normalizeHostname(c.req.query('hostname'));
      if (!hostname) {
        return c.json({ ret: 'ERROR', data: null, message: 'invalid hostname' }, 400);
      }
      const websiteId = await findWebsiteId(c.env.DB, hostname);
      if (websiteId === null) {
        return c.json({ ret: 'ERROR', data: null, message: 'website not found' }, 404);
      }
      const urlParam = c.req.query('url');
      const data =
        urlParam === undefined
          ? await readSiteStats(c.env.DB, websiteId)
          : await readPageStat(c.env.DB, websiteId, normalizePath(urlParam));
      return c.json({ ret: 'OK', data });
    });
  } catch (err) {
    console.error('stats failed:', err);
    return c.json({ ret: 'ERROR', data: null, message: 'Internal Server Error' }, 500);
  }
});

async function runPurges(env: Bindings): Promise<void> {
  const logDays = Math.max(1, Math.floor(Number(env.LOG_RETENTION_DAYS ?? '90')) || 90);
  const visitorDays = Math.max(1, Math.floor(Number(env.VISITOR_RETENTION_DAYS ?? '90')) || 90);
  await purgeExpiredLogs(env.DB, logDays);
  await purgeInactiveVisitorStates(env.DB, visitorDays);
}

export default {
  fetch: app.fetch,
  // cron：每日清理过期明细与不活跃访客状态（空库时自动迁移后执行）
  scheduled: (_event: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(withSchemaRetry(env.DB, () => runPurges(env)));
  },
};
