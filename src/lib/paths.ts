// ============================================================
// 计数落点解析：真实路径 vs 哨兵路径
//
// 背景（D1 计费优化）：
//   t_page_stat 的行数必须严格有界。两类来源会让「页面数」远超站点实际：
//   1. 404/5xx 页面 —— 博客主题的 404 模板通常带埋点脚本，
//      每个被扫的错误地址都会变成一行永久计数
//   2. 刷随机路径 / SPA catch-all 模板 —— 任意路径都渲染页面并触发埋点
//
// 对策：
//   - 错误状态 -> 每站恒定 1 行的哨兵（404 单独一行，其余 4xx/5xx 一行），
//     真实路径只进 90 天保留期的 t_visit_log（诊断用）
//   - 页面数超上限 -> 新路径进溢出哨兵行；已有页面不受影响
//   - 哨兵不参与 page_count 镜像（其数量恒定为 3，无需计入）
// ============================================================

export const PATH_404 = '/__lt_404__';
export const PATH_ERR = '/__lt_err__'; // 404 以外的 4xx/5xx
export const PATH_OVERFLOW = '/__lt_overflow__';

export type StatReason = 'normal' | '404' | 'error' | 'overflow';

export interface StatTarget {
  /** 写入 t_page_stat 的路径（哨兵或真实路径） */
  statPath: string;
  /** statPath 是否为真实页面路径（参与 page_count 镜像） */
  isRealPath: boolean;
  /** 是否同步站点级 pv/uv 计数器（错误哨兵不计入站点总量） */
  countSite: boolean;
  reason: StatReason;
}

/**
 * 解析本次访问的计数落点。
 * @param status   客户端上报的 HTTP 状态码（0/未知按 200 处理）
 * @param realPath 规范化后的真实路径
 * @param pageCount 该站当前 t_page_stat 行数（镜像，来自 t_website）
 * @param hasPage  realPath 是否已有计数行
 * @param maxPages 每站页面上限（MAX_PAGES_PER_SITE）
 */
export function resolveStatTarget(
  status: number,
  realPath: string,
  pageCount: number,
  hasPage: boolean,
  maxPages: number,
): StatTarget {
  if (status === 404) {
    return { statPath: PATH_404, isRealPath: false, countSite: false, reason: '404' };
  }
  if (status >= 400 && status <= 599) {
    return { statPath: PATH_ERR, isRealPath: false, countSite: false, reason: 'error' };
  }
  if (!hasPage && pageCount >= maxPages) {
    return { statPath: PATH_OVERFLOW, isRealPath: false, countSite: true, reason: 'overflow' };
  }
  return { statPath: realPath, isRealPath: true, countSite: true, reason: 'normal' };
}
