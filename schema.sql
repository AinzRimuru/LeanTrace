-- ============================================================
-- LeanTrace schema —— 版本化（当前：v1 首版，与 src/lib/migrate.ts 的
-- LATEST_SCHEMA_VERSION 保持同步）
--
-- v1 = 首版形态：4 张业务表 + 版本表。项目未上线、无存量库，
-- 因此没有历史迁移步；未来的增量见 migrate.ts 的 DELTA_STEPS。
--
-- 本文件描述【最新形态】（建表用 if not exists，幂等）。
-- 修改 schema 时三处同步：本文件 + LATEST_SCHEMA_VERSION + DELTA_STEPS。
-- ============================================================

-- 版本表：单行（id=1），版本只升不降（戳更新带单调保护，见 migrate.ts）
-- 注意：这里只建表不打戳 —— 版本戳由迁移器统一写入；
-- 若在此预打戳，无版本行的旧库会在建表批里被误标为最新而跳过增量补列
create table if not exists t_schema_version (
  id         integer primary key check (id = 1),
  version    integer not null,
  applied_at datetime default current_timestamp
);

-- ============================================================
-- 以下为业务表（最新形态）
-- ============================================================
-- LeanTrace schema —— 针对旧项目三个问题的修复策略：
--   P2 访客明细无限膨胀 -> 「到访过哪些页面」的去重状态由客户端持有的
--        签名 token 承担（JWT 风格 HMAC + Bloom 页面指纹）；
--        服务端仅保留【有界】的防滥用状态表 t_visitor_state
--        （一行/访客而非一行/PV，含 IP 仅供新 ID 限额，按保留期 cron 清理）；
--        原始明细表仅短期保留（cron 清理）用于来源分析
--   P3 IP 当作用户 -> 访客 ID 存于客户端（localStorage + cookie 双写），
--        换 IP / 换网络身份不变；UV 按 token 内访客 ID 去重，与 IP 解耦
--
-- v3 计费优化（D1 按行读/行写计费，写比读贵 1000 倍）：
--   a. 站点级 pv/uv/page_count 计数器列：写入时同事务自增，
--      GET /api/stats 站点汇总从「SUM 扫全部页面行（无上界）」变为 1 行点查
--   b. 404/5xx 哨兵路径：错误状态不按真实路径建行（否则每个错误地址一行，
--      页面数远超站点实际页面数），聚合到每站恒定 1 行的哨兵；
--      真实路径仅进 90 天保留期的明细表
--   c. page_count 镜像 + MAX_PAGES_PER_SITE 上限：超限新路径进溢出哨兵行，
--      t_page_stat 每站行数严格有界，与是否被爬虫/攻击者刷路径无关
--   d. 所有存在性探测均 LIMIT 1，杜绝任何查询读取行数超过常数
--
-- 服务端 4 张表，行数全部有界：
--   t_website       行数 = 站点数
--   t_page_stat     行数 <= 站点数 x (MAX_PAGES_PER_SITE + 3 个哨兵行)
--   t_visit_log     行数 ≈ 保留天数 x 日均 PV（cron 定期清理）
--   t_visitor_state 行数 ≈ 保留期内活跃访客数（cron 按 update_at 清理）
--
-- 幂等：全部 if not exists，可重复执行
-- ============================================================

-- 站点表：domain 唯一索引
--   - pv/uv：站点级计数器，recordVisit 同事务自增（避免 SUM 聚合扫描）
--   - page_count：该站 t_page_stat 行数镜像（仅真实页面行），
--     「新行判定 + 自增」与页面 upsert 同 batch，D1 单写者串行化保证精确
--   - 热路径（已存在站点）只读不写：写入仅发生在新域名建站与计数时
create table if not exists t_website (
  id          integer primary key autoincrement,
  name        text not null,
  domain      text not null,
  pv          integer not null default 0,
  uv          integer not null default 0,
  page_count  integer not null default 0,
  create_at   datetime default current_timestamp,
  update_at   datetime default current_timestamp
);
create unique index if not exists uk_website_domain on t_website (domain);

-- 预聚合计数器表：一行 = 一个「站点 x 页面」
--   - PV/UV 读取为主键点查；更新为原子自增，并发安全
--   - 哨兵路径（/__lt_404__ 等）与真实页面同表存储，天然受同样的 O(1) 待遇
create table if not exists t_page_stat (
  website_id integer not null,
  url_path   text not null,
  pv         integer not null default 0,
  uv         integer not null default 0,
  update_at  datetime default current_timestamp,
  primary key (website_id, url_path)
) without rowid;

-- 原始访问明细表：仅供近期来源分析（referrer/status），与计数器解耦
--   - url_path 存【真实路径】（即使计数落点是哨兵行），status 存客户端上报的
--     HTTP 状态码 —— 404 扫描诊断靠这张表（90 天保留期），而不是计数表
--   - 不承担任何计数职责，因此可以放心定期清理
create table if not exists t_visit_log (
  id              integer primary key autoincrement,
  website_id      integer not null,
  url_path        text not null,
  visitor_id      text not null,
  referrer_domain text not null default '',
  referrer_path   text not null default '',
  status          integer not null default 200,
  create_at       datetime default current_timestamp
);
create index if not exists idx_visit_log_created_at on t_visit_log (create_at);
create index if not exists idx_visit_log_site_path_time on t_visit_log (website_id, url_path, create_at);

-- 访客状态表（防重放 + IP 限额）
--   一行 = 一个访客 ID：id / 已消费版本号 / 时间戳 / 分配时 IP
--   防重放：token 内携带单调递增版本号，只有「版本 > last_used_version」
--           的请求才计数；CAS 更新（where last_used_version < ?）保证
--           同一 token 并发使用时仅一次生效 —— 重放旧 bloom 无法再刷计数
--   IP 限额：同一 IP 1 小时（滚动窗口）内最多产生一个新访客 ID；
--           ip_hour 唯一索引是并发穿透的兜底（同桶同时 INSERT 只成一个）
--   体积：行数 ≈ 保留期内活跃访客数（VISITOR_RETENTION_DAYS，cron 清理）
create table if not exists t_visitor_state (
  visitor_id        text primary key,            -- token 内的 v（32 hex）
  last_used_version integer not null default 0,  -- 已消费的最高 token 版本号
  ip                text not null,               -- 分配该 ID 时的来源 IP（仅用于限额）
  ip_hour           text not null,               -- "ip|小时桶"，唯一约束兜并发竞态
  create_at         datetime default current_timestamp,
  update_at         datetime default current_timestamp
);
create unique index if not exists ux_visitor_state_ip_hour on t_visitor_state (ip_hour);
create index if not exists idx_visitor_state_ip_create on t_visitor_state (ip, create_at);
create index if not exists idx_visitor_state_update on t_visitor_state (update_at);
