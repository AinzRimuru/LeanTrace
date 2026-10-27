// ============================================================
// 无状态访客 token（JWT 风格）
//
// 形态: <base64url(payload)>.<base64url(HMAC-SHA256(payload))>
// payload = {"v":"<32位hex访客ID>","n":<版本号>,"b":"<base64url Bloom指纹>","e":<过期Unix秒>}
//
// 设计要点：
// - UV 去重所需的「该访客是否到访过本页」由客户端持有的 Bloom 指纹承担，
//   服务端只做 验签 -> 置位 -> 重签发（防重放状态见 db.ts / t_visitor_state）
// - Bloom 指纹定长 2048 字节：访问再多个页面 token 也不膨胀
//   （16384 bit / 11 哈希：1000 页时误判率 ~0.04%，开箱即用覆盖
//    深浏览场景；轻量场景可调小 BLOOM_BYTES，代价见 README 误差表）
// - 指纹只能做成员检测，无法反推出访问过哪些 URL（比明文路径列表更保护隐私）
// - HMAC 防篡改：客户端无法伪造「我来过 / 我没来过」，也无法伪造版本号
// ============================================================

export const TOKEN_TTL_SEC = 400 * 24 * 3600;    // token 寿命 ~13 个月（UV 去重窗口）
export const TOKEN_REFRESH_SEC = 30 * 24 * 3600; // 剩余寿命不足 30 天时静默续签
export const BLOOM_BYTES = 2048;                  // 16384 bit（2 的幂，索引无取模偏置）

const BLOOM_BITS = BLOOM_BYTES * 8;
const BLOOM_HASHES = 11;                          // 1000 页 @ 误判率 ~0.04%（目标 0.1% 内）
const BLOOM_INDEX_BITS = Math.ceil(Math.log2(BLOOM_BITS)); // 索引位宽 = 14
if (BLOOM_HASHES * BLOOM_INDEX_BITS > 256) {
  // 配置自检：索引位序列不能超过单次 SHA-256 的 256 bit，
  // 否则越界读 digest 会静默退化成坏指纹 —— 启动期直接报错，不带到线上
  throw new Error(
    `invalid bloom config: ${BLOOM_HASHES} x ${BLOOM_INDEX_BITS} = ${BLOOM_HASHES * BLOOM_INDEX_BITS} index bits > 256`,
  );
}

// token 最大长度随 BLOOM_BYTES 推导（b64 上界 + 分隔符 + 签名），
// 与 parseToken 入口上限联动：调指纹容量时无需手改这里
const b64MaxLen = (n: number): number => Math.ceil(n / 3) * 4;
export const TOKEN_MAX_LEN = b64MaxLen(30 + 32 + 10 + 12 + b64MaxLen(BLOOM_BYTES)) + 1 + b64MaxLen(32);
const VID_RE = /^[0-9a-f]{32}$/;
const VERSION_MAX = 2147483647; // 版本号上限（防整数溢出/非法值）

export interface VisitToken {
  vid: string;        // 访客 ID（128 bit 随机，hex）
  version: number;    // 单调递增版本号（防重放：服务端存已消费的最高版本）
  bloom: Uint8Array;  // 到访页面 Bloom 指纹（定长）
  exp: number;        // 过期时间（Unix 秒）
}

// ---------- base64url ----------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 签名 ----------

async function hmacSign(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- 签发 / 校验 ----------

export function randomVid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 按 tok 当前内容签发 token 字符串（调用方自行决定 exp） */
export async function issueToken(secret: string, tok: VisitToken): Promise<string> {
  const payload = JSON.stringify({ v: tok.vid, n: tok.version, b: b64urlEncode(tok.bloom), e: tok.exp });
  const sig = await hmacSign(secret, payload);
  return `${b64urlEncode(new TextEncoder().encode(payload))}.${b64urlEncode(sig)}`;
}

/**
 * 校验并解析 token。
 * 任何异常（格式错误 / 签名不符 / 已过期 / 指纹长度不对）一律返回 null，
 * 调用方按「全新访客」处理并签发新 token。
 */
export async function parseToken(
  raw: unknown,
  secret: string,
  now: number,
): Promise<VisitToken | null> {
  if (typeof raw !== 'string' || raw.length < 24 || raw.length > TOKEN_MAX_LEN) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || raw.indexOf('.', dot + 1) !== -1) return null;

  let payloadJson: string;
  let sig: Uint8Array;
  let bloom: Uint8Array;
  let obj: { v?: unknown; n?: unknown; b?: unknown; e?: unknown };
  try {
    payloadJson = new TextDecoder().decode(b64urlDecode(raw.slice(0, dot)));
    obj = JSON.parse(payloadJson);
    if (typeof obj.b !== 'string') return null;
    sig = b64urlDecode(raw.slice(dot + 1));
    bloom = b64urlDecode(obj.b);
  } catch {
    return null;
  }
  if (typeof obj.v !== 'string' || !VID_RE.test(obj.v)) return null;
  if (typeof obj.n !== 'number' || !Number.isInteger(obj.n) || obj.n < 1 || obj.n > VERSION_MAX) return null;
  if (bloom.length !== BLOOM_BYTES) return null;
  if (typeof obj.e !== 'number' || !Number.isFinite(obj.e) || obj.e <= now) return null;

  const expect = await hmacSign(secret, payloadJson);
  if (!constantTimeEqual(sig, expect)) return null;

  return { vid: obj.v, version: obj.n, bloom, exp: obj.e };
}

// ---------- Bloom 指纹 ----------

/** 页面置位位置：对 `站点ID|路径` 做 SHA-256，取 k 个 log2(m)-bit 索引 */
export async function pagePositions(websiteId: number, urlPath: string): Promise<number[]> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${websiteId}|${urlPath}`)),
  );
  const positions: number[] = [];
  for (let h = 0; h < BLOOM_HASHES; h++) {
    const start = h * BLOOM_INDEX_BITS; // 11 x 14 = 154 bit，小于 256 bit 可用
    let index = 0;
    for (let i = 0; i < BLOOM_INDEX_BITS; i++) {
      const bit = start + i;
      index = (index << 1) | ((digest[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    positions.push(index % BLOOM_BITS);
  }
  return positions;
}

/** 是否已置位（Bloom 无假阴性：返回 false 则一定没记录过） */
export function bloomContains(bloom: Uint8Array, positions: number[]): boolean {
  for (const p of positions) {
    if ((bloom[p >> 3] & (1 << (7 - (p & 7)))) === 0) return false;
  }
  return true;
}

/** 置位（原地修改） */
export function bloomAdd(bloom: Uint8Array, positions: number[]): void {
  for (const p of positions) bloom[p >> 3] |= 1 << (7 - (p & 7));
}
