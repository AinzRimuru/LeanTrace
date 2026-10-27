// ============================================================
// D1 数据访问层 —— 全部查询均为索引点查/受限范围扫描（O(1) 行数）
//
// 计费设计原则（D1 按行读/行写计费，写贵读 1000 倍）：
//   1. 无任何 COUNT/SUM 聚合：站点级汇总读 t_website 计数器列（1 行）
//   2. 存在性探测一律 LIMIT 1
//   3. 热路径（已存在站点）只读不写；「页面是否新行」的判定与自增
//      放在页面 upsert 之前的同 batch 内，靠 D1 单写者串行化保证
//      page_count 镜像精确
//   4. 删除类操作按索引分批（每批 500 行）
//
// 注意：本文件的 SQL 与 scripts/smoke.mjs 中的镜像保持同步，
// 修改任何语句时两处一起改。
// ============================================================

export interface Referrer {
  domain: string;
  path: string;
}

export interface PageStat {
  pv: number;
  uv: number;
}

/** 站点元信息（一次读往返同时完成：ID 解析 + 页数镜像 + 页面存在性） */
export interface SiteMeta {
  websiteId: number;
  pageCount: number;
  hasPage: boolean;
}

/** 把时间转为与 SQLite CURRENT_TIMESTAMP 一致的 UTC 格式 'YYYY-MM-DD HH:MM:SS'。 */
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ============================================================
// 站点
// ============================================================

/**
 * 站点元信息读取（热路径，纯读 0 写）：
 *   - 走 domain 唯一索引：~2 行读（站点行 + 页面存在性探测）
 *   - 不存在返回 null，由调用方走建站路径
 */
export async function readSiteMetaByDomain(
  db: D1Database,
  hostname: string,
  realPath: string,
): Promise<SiteMeta | null> {
  const row = await db
    .prepare(
      `select w.id as id, w.page_count as page_count,
              exists(select 1 from t_page_stat p
                     where p.website_id = w.id and p.url_path = ?2 limit 1) as has_page
       from t_website w where w.domain = ?1`,
    )
    .bind(hostname, realPath)
    .first<{ id: number; page_count: number; has_page: number }>();
  if (!row) return null;
  return {
    websiteId: Number(row.id),
    pageCount: Number(row.page_count),
    hasPage: Number(row.has_page) === 1,
  };
}

/** 建站（仅新域名；唯一索引兜住并发首访，upsert-returning 单次往返） */
export async function createWebsite(db: D1Database, hostname: string): Promise<number> {
  const name = hostname.split('.').join('_');
  const row = await db
    .prepare(
      `insert into t_website (name, domain) values (?1, ?2)
       on conflict (domain) do update set update_at = current_timestamp
       returning id`,
    )
    .bind(name, hostname)
    .first<{ id: number }>();
  if (!row) throw new Error('failed to create website');
  return Number(row.id);
}

/** 只读站点 ID 查询（/api/stats 用，不建站） */
export async function findWebsiteId(db: D1Database, hostname: string): Promise<number | null> {
  const id = await db
    .prepare('select id from t_website where domain = ?1')
    .bind(hostname)
    .first<number>('id');
  return id === null ? null : Number(id);
}

// ============================================================
// 计数
// ============================================================

export interface RecordVisitInput {
  websiteId: number;
  /** 计数落点（resolveStatTarget 的结果，可能为哨兵路径） */
  statPath: string;
  /** 真实路径（进明细表，用于诊断，保留期 90 天） */
  realPath: string;
  /** 客户端上报的 HTTP 状态码（进明细表） */
  status: number;
  /** token 内访客 ID（非 IP） */
  visitorId: string;
  /** 首访判定来自 token Bloom 指纹，服务端不做去重查询 */
  uvBump: 0 | 1;
  /** 是否同步站点级 pv/uv 计数器（错误哨兵为 false） */
  countSite: boolean;
  /** statPath 是否为真实页面路径（参与 page_count 镜像） */
  isRealPath: boolean;
  referrer: Referrer;
}

/**
 * 记录一次被计数的访问，全部语句在同一次 batch（事务）内完成。
 *
 * 语句顺序（顺序即语义）：
 *   1. 明细 INSERT（真实路径 + status）
 *   2. [仅真实路径] page_count 镜像自增 —— 必须在 3 之前：
 *      此时该路径若已存在行则 not exists 为假、不增；配合 D1 单写者
 *      串行化，并发首访同一新页面只有一个请求完成自增，镜像不漂移
 *   3. 页面计数 upsert（原子自增）
 *   4. [仅 countSite] 站点级 pv/uv 自增（替代 SUM 聚合）
 *   5. 读取最新计数（同事务内必然读到自增后的值）
 */
export async function recordVisit(db: D1Database, input: RecordVisitInput): Promise<PageStat> {
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    db
      .prepare(
        `insert into t_visit_log (website_id, url_path, visitor_id, referrer_domain, referrer_path, status)
         values (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(input.websiteId, input.realPath, input.visitorId, input.referrer.domain, input.referrer.path, input.status),
  );

  if (input.isRealPath) {
    stmts.push(
      db
        .prepare(
          `update t_website set page_count = page_count + 1
           where id = ?1 and not exists (
             select 1 from t_page_stat p
             where p.website_id = ?1 and p.url_path = ?2 limit 1
           )`,
        )
        .bind(input.websiteId, input.statPath),
    );
  }

  stmts.push(
    db
      .prepare(
        `insert into t_page_stat (website_id, url_path, pv, uv) values (?1, ?2, 1, ?3)
         on conflict (website_id, url_path) do update
           set pv = pv + 1, uv = uv + excluded.uv, update_at = current_timestamp`,
      )
      .bind(input.websiteId, input.statPath, input.uvBump),
  );

  if (input.countSite) {
    stmts.push(
      db
        .prepare(
          `update t_website set pv = pv + 1, uv = uv + ?2, update_at = current_timestamp
           where id = ?1`,
        )
        .bind(input.websiteId, input.uvBump),
    );
  }

  stmts.push(
    db
      .prepare('select pv, uv from t_page_stat where website_id = ?1 and url_path = ?2')
      .bind(input.websiteId, input.statPath),
  );

  const results = await db.batch(stmts);
  const row = results[results.length - 1].results[0] as { pv: number; uv: number } | undefined;
  return row ? { pv: Number(row.pv), uv: Number(row.uv) } : { pv: 0, uv: 0 };
}

/** 单页计数（只读，主键点查；支持查询哨兵行） */
export async function readPageStat(db: D1Database, websiteId: number, urlPath: string): Promise<PageStat> {
  const row = await db
    .prepare('select pv, uv from t_page_stat where website_id = ?1 and url_path = ?2')
    .bind(websiteId, urlPath)
    .first<{ pv: number; uv: number }>();
  return row ? { pv: Number(row.pv), uv: Number(row.uv) } : { pv: 0, uv: 0 };
}

/**
 * 站点汇总（只读，1 行）：直接读 t_website 计数器列。
 * 旧实现为 `sum(pv) from t_page_stat where website_id = ?`——读取行数
 * 等于该站全部页面行数（404/刷路径膨胀后无上界），已废弃。
 * 注意：站点 uv 为各次 uvBump 累计（跨页可能重复计数，上限估计）。
 */
export async function readSiteStats(db: D1Database, websiteId: number): Promise<PageStat> {
  const row = await db
    .prepare('select pv, uv from t_website where id = ?1')
    .bind(websiteId)
    .first<{ pv: number; uv: number }>();
  return row ? { pv: Number(row.pv), uv: Number(row.uv) } : { pv: 0, uv: 0 };
}

// ============================================================
// 防重放：访客状态表 t_visitor_state 的原子操作
// ============================================================

/**
 * CAS 消费一个 token 版本：仅当 version 大于该访客已消费的最高版本时生效。
 * - 正常请求（携带最新 token）：changes=1，本次请求可计数，随后签发 version+1
 * - 重放（version <= 已消费）或 vid 不存在：changes=0，调用方走非法请求路径
 * - 原子性保证：同一 token 并发到达两次，只有第一次 changes=1，
 *   杜绝用同一 bloom 位图并行刷计数
 */
export async function consumeVisitorVersion(
  db: D1Database,
  visitorId: string,
  version: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `update t_visitor_state set last_used_version = ?1, update_at = current_timestamp
       where visitor_id = ?2 and last_used_version < ?1`,
    )
    .bind(version, visitorId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * 新建访客状态（新用户规则）。
 * 滚动窗口限流：同一 IP 最近 1 小时内已分配过 ID 则拒绝（changes=0）；
 * ip_hour 唯一索引兜底：同小时桶内并发 INSERT 只能成功一个（冲突抛错也归为拒绝）。
 */
export async function createVisitorState(
  db: D1Database,
  visitorId: string,
  ip: string,
  ipHour: string,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const cutoff = sqliteUtc(new Date(Date.now() - windowSeconds * 1000));
    const res = await db
      .prepare(
        `insert into t_visitor_state (visitor_id, last_used_version, ip, ip_hour)
         select ?1, 0, ?2, ?3
         where not exists (
           select 1 from t_visitor_state where ip = ?2 and create_at > ?4 limit 1
         )`,
      )
      .bind(visitorId, ip, ipHour, cutoff)
      .run();
    return (res.meta.changes ?? 0) === 1;
  } catch (err) {
    if (String(err).includes('UNIQUE')) return false; // 同桶并发竞态：另一个请求先建号成功
    throw err;
  }
}

/**
 * 竞态宽限：该访客数秒内刚消费过任意版本。
 * 典型场景是多标签页同时读到同一 token，后到者 CAS 失败但并非攻击 ——
 * 只读返回而不按新用户分裂身份；顺带封死「刚消费完立刻重放换新 ID」的窗口。
 */
export async function wasRecentlyActive(
  db: D1Database,
  visitorId: string,
  withinSeconds: number,
): Promise<boolean> {
  const cutoff = sqliteUtc(new Date(Date.now() - withinSeconds * 1000));
  const row = await db
    .prepare(
      'select 1 as ok from t_visitor_state where visitor_id = ?1 and update_at > ?2 limit 1',
    )
    .bind(visitorId, cutoff)
    .first('ok');
  return row !== null;
}

// ============================================================
// cron 清理（分批删除，走索引）
// ============================================================

/** 清理过期明细（按 create_at，每批 500） */
export async function purgeExpiredLogs(db: D1Database, retentionDays: number): Promise<number> {
  const cutoff = sqliteUtc(new Date(Date.now() - retentionDays * 86400000));
  let total = 0;
  for (let round = 0; round < 100; round++) {
    const res = await db
      .prepare(
        `delete from t_visit_log where id in (
           select id from t_visit_log where create_at < ?1 limit 500
         )`,
      )
      .bind(cutoff)
      .run();
    const deleted = res.meta.changes ?? 0;
    total += deleted;
    if (deleted < 500) break;
  }
  return total;
}

/** 清理长期不活跃的访客状态（按 update_at，每批 500） */
export async function purgeInactiveVisitorStates(db: D1Database, retentionDays: number): Promise<number> {
  const cutoff = sqliteUtc(new Date(Date.now() - retentionDays * 86400000));
  let total = 0;
  for (let round = 0; round < 100; round++) {
    const res = await db
      .prepare(
        `delete from t_visitor_state where visitor_id in (
           select visitor_id from t_visitor_state where update_at < ?1 limit 500
         )`,
      )
      .bind(cutoff)
      .run();
    const deleted = res.meta.changes ?? 0;
    total += deleted;
    if (deleted < 500) break;
  }
  return total;
}
