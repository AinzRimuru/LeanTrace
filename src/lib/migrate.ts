// ============================================================
// 版本化数据库迁移
//
// 版本存储：t_schema_version 单行表（id=1），只升不降。
//
// 当前版本 v1 = 首版（项目未上线，无存量库，无历史迁移步）；
// DELTA_STEPS 暂为空，空库/预建未打戳库由兑底戳直接落 v1。
//
// 算法（ensureSchema，由 withSchemaRetry 在查询失败时惰性触发，稳态零开销）：
//   1. bootstrap 版本表（幂等），读当前版本 current（无行 = 0）
//   2. current >= LATEST —— 已是最新，直接返回
//   3. current == 0（空库，或经 initSql 预建但未打戳的库）——
//      先按最新形态建表（schema.sql，if not exists 幂等），再走增量步
//      （schema.sql 只建版本表不打戳，戳由这里统一写入，
//       否则未来升级时旧库会在建表批里被误标为最新而跳过增量）
//   4. 依次应用 to > current 的增量步：每步 DDL 与版本戳在同一 batch
//      （事务）内 —— 失败不推进版本；戳更新带 where version < 新值
//      单调保护，并发 isolate 不可能把版本改回去；增量步容错
//      duplicate column（列已存在则整批回滚后单独补戳）
//   5. 兜底：DELTA_STEPS 未覆盖到 LATEST 时（当前 v1 即此情形）直接补戳
//
// 新增迁移（维护者指南）：
//   a. 修改 schema.sql 到新形态，并把 LATEST_SCHEMA_VERSION +1
//   b. DELTA_STEPS 追加 { to: 新版本, statements: 旧->新 的增量 DDL }
//      （ALTER 需可容错 duplicate column；无 down-migration）
// ============================================================

import schemaSql from '../../schema.sql';

/** 当前最新 schema 版本（v1 = 首版；修改 schema 时与 DELTA_STEPS 同步 +1） */
export const LATEST_SCHEMA_VERSION = 1;

const VERSION_TABLE_DDL = `
  create table if not exists t_schema_version (
    id         integer primary key check (id = 1),
    version    integer not null,
    applied_at datetime default current_timestamp
  )`;

/** 版本戳：单调保护 —— 已有更高版本时不回退（并发 isolate 安全） */
function stampSql(version: number): string {
  return (
    `insert into t_schema_version (id, version) values (1, ${version}) ` +
    `on conflict (id) do update set version = excluded.version, applied_at = current_timestamp ` +
    `where t_schema_version.version < excluded.version`
  );
}

/**
 * 增量迁移步。当前为空：v1 是首个版本，不存在需要升级的存量库。
 * 首次 schema 变更时在此追加 { to: 2, statements: 旧->新增量 DDL }。
 */
const DELTA_STEPS: ReadonlyArray<{ to: number; statements: string[] }> = [];

/**
 * 拆分 DDL：去掉整行注释后按 ';' 切分。
 * schema.sql 不含字符串字面量与内联注释，可安全按 ';' 切分；
 * 修改 schema.sql 时保持这一约定（注释独占一行）。
 */
export function parseDdlStatements(sqlText: string): string[] {
  return sqlText
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

let schemaReady = false; // isolate 内缓存：迁移成功后本实例不再执行

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;

  // 1) bootstrap 版本表并读当前版本
  await db.prepare(VERSION_TABLE_DDL).run();
  let current = await readVersion(db);
  if (current >= LATEST_SCHEMA_VERSION) {
    schemaReady = true;
    return;
  }

  // 2) 空库 / 无版本行的存量库：先按最新形态建表（幂等）。
  //    不重读版本、不提前返回 —— 无版本行的旧库必须继续走增量补列
  if (current === 0) {
    await db.batch(parseDdlStatements(schemaSql).map((stmt) => db.prepare(stmt)));
  }

  // 3) 依次应用增量步（DDL + 版本戳同事务；失败不推进版本）
  for (const step of DELTA_STEPS) {
    if (step.to <= current) continue;
    try {
      await db.batch([...step.statements.map((s) => db.prepare(s)), db.prepare(stampSql(step.to))]);
    } catch (err) {
      if (!String(err).includes('duplicate column')) throw err;
      // 列已存在（存量库已是最新形态）：整批已回滚，单独补戳（幂等、单调）
      await db.prepare(stampSql(step.to)).run();
    }
    current = step.to;
  }

  // 4) 兕底：增量步未覆盖到 LATEST（如仅加索引的版本）时直接补戳
  if (current < LATEST_SCHEMA_VERSION) {
    await db.prepare(stampSql(LATEST_SCHEMA_VERSION)).run();
  }
  schemaReady = true;
}

async function readVersion(db: D1Database): Promise<number> {
  const v = await db
    .prepare('select version from t_schema_version where id = 1')
    .first<number>('version');
  return v === null ? 0 : Number(v);
}

/**
 * 包一层自动迁移重试。
 * 注意：传入的 fn 必须可安全重复执行 —— 尤其不要在 fn 里读请求 body
 * （Workers 的 body 流只能读一次，由调用方先解析再传入）。
 */
export async function withSchemaRetry<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!/no such (table|column)/i.test(String(err))) throw err;
    await ensureSchema(db);
    return await fn();
  }
}
