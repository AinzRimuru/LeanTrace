// ============================================================
// 入参规范化 / 防御性解析
// 所有写入库的字段在这里完成长度截断与格式校验
// ============================================================

/** hostname：小写、限制字符集，最长 253 */
export function normalizeHostname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().toLowerCase();
  if (h.length === 0 || h.length > 253) return null;
  return /^[a-z0-9.-]+$/.test(h) ? h : null;
}

/** 页面路径：去 query/hash、保证前导 /、截断到 512 */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  let p = raw.split('?')[0].split('#')[0];
  if (p.length > 512) p = p.slice(0, 512);
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/** referrer：解析失败或缺失返回空串，字段各自截断 */
export function parseReferrer(raw: unknown): { domain: string; path: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { domain: '', path: '' };
  }
  try {
    const u = new URL(raw);
    return { domain: u.hostname.toLowerCase().slice(0, 253), path: u.pathname.slice(0, 512) };
  } catch {
    return { domain: '', path: '' };
  }
}
