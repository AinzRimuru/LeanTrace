// ============================================================
// 根路径：自演示页（参考 webviso 的产品形态）
//   - 展示接入代码片段（含本实例真实地址，JS 运行时填充）
//   - 页面自身被统计：底部动态挂载 /js/index.min.js 埋点，
//     中部实时显示「当前页 PV / UV」
//   - 附接入配置检测（纯浏览器端执行，本服务不做代理抓取）
//
// 单文件零依赖；外层为模板字符串，内嵌 JS 一律使用单引号拼接
// （禁止反引号与 ${，避免与外层冲突）
// ============================================================

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LeanTrace · 轻量博客访问统计</title>
<meta name="description" content="轻量、隐私友好的博客访问统计：换 IP 不丢访客身份，明文 IP 不落库，Cloudflare Workers + D1 免费额度可跑。">
<style>
  :root { --brand:#f6821f; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --line:#e5e7eb; --muted:#6b7280; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:#fafafa; color:#1f2328; }
  .wrap { max-width:720px; margin:0 auto; padding:40px 20px 64px; }
  h1 { font-size:24px; margin:0 0 6px; }
  h1 b { color:var(--brand); }
  .sub { color:var(--muted); font-size:14px; margin:0 0 28px; }
  section { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px 22px; margin-bottom:18px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  h2 { font-size:15px; margin:0 0 14px; }
  h2 small { font-weight:400; color:var(--muted); }
  pre { margin:0; padding:14px; background:#f6f8fa; border:1px solid var(--line); border-radius:8px; font-size:13px; line-height:1.8; overflow:auto; font-family:ui-monospace,Consolas,monospace; }
  ul { margin:14px 0 0; padding-left:20px; }
  li { line-height:2.1; font-size:14px; }
  code { background:#f6f8fa; padding:1px 6px; border-radius:4px; font-size:13px; }
  .num { color:var(--brand); font-weight:700; font-size:16px; font-variant-numeric:tabular-nums; }
  .row { display:flex; gap:8px; }
  input[type=text] { flex:1; padding:8px 10px; border:1px solid var(--line); border-radius:6px; font-size:14px; }
  input[type=text]:focus { outline:2px solid #fdb77733; border-color:var(--brand); }
  button { padding:8px 16px; border:0; border-radius:6px; background:var(--brand); color:#fff; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .log { margin-top:14px; font-size:13px; line-height:1.9; font-family:ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
  .log .ok { color:var(--ok); } .log .warn { color:var(--warn); } .log .bad { color:var(--bad); } .log .info { color:var(--muted); }
  .hint { font-size:12px; color:var(--muted); margin:12px 0 0; line-height:1.7; }
  footer { text-align:center; font-size:13px; color:var(--muted); margin-top:28px; }
  footer a { color:var(--brand); text-decoration:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Lean<b>Trace</b></h1>
  <p class="sub">轻量、隐私友好的博客访问统计 —— 本页即实时演示</p>

  <section>
    <h2>接入你的博客</h2>
    <pre id="snippet">…</pre>
    <ul>
      <li>在 <code>&lt;/body&gt;</code> 前加入上述 <code>&lt;script&gt;</code>（脚本可直接引用本实例，结尾不带 <code>/</code>）</li>
      <li>加入 id 为 <code>page_pv</code> / <code>page_uv</code> 的元素即可显示计数</li>
      <li>换 IP 不丢访客身份 · 明文 IP 不落库 · 404/错误页自动聚合不占页面配额</li>
      <li>当前页演示 —— 访问人次 <span id="page_pv" class="num">?</span> 　访问人数 <span id="page_uv" class="num">?</span></li>
    </ul>
  </section>

  <section>
    <h2>接入配置检测 <small>—— 纯浏览器端执行，不经本服务代理</small></h2>
    <div class="row">
      <input type="text" id="check-url" placeholder="https://blog.example.com/post/hello/" spellcheck="false">
      <button id="check-btn">检测</button>
    </div>
    <div class="log" id="check-log"></div>
    <p class="hint">
      在你的浏览器中直接请求目标页：读取源码做静态检查（受目标站跨域策略限制），
      并于隐藏 iframe 中真实加载页面观察本实例是否收到上报（配置正确会计入一次 PV）。
      同 IP 每小时仅产生一个新访客，刚测过同一站点请稍候再试。
    </p>
  </section>

  <footer><a href="https://github.com/AinzRimuru/LeanTrace" target="_blank" rel="noopener">GitHub · AinzRimuru/LeanTrace</a></footer>
</div>

<script>
(function () {
  'use strict';
  var SELF = location.origin;

  /* 接入代码片段（含本实例真实地址） */
  document.getElementById('snippet').textContent =
    '<script defer src="' + SELF + '/js/index.min.js"><' + '/script>\\n' +
    '本页访问人次: <span id="page_pv"></span>\\n' +
    '本页访问人数: <span id="page_uv"></span>';

  /* 本页自挂埋点：页面自身即被统计（演示） */
  var s = document.createElement('script');
  s.src = '/js/index.min.js';
  s.defer = true;
  s.setAttribute('data-base-url', SELF);
  document.body.appendChild(s);

  /* ---------- 配置检测（纯浏览器端） ---------- */
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function statOf(host) {
    return fetch('/api/stats?hostname=' + encodeURIComponent(host)).then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (j) { return j && j.data ? j.data : null; });
    });
  }

  var logEl = document.getElementById('check-log');
  function out(kind, text) {
    var line = document.createElement('div');
    line.className = kind;
    line.textContent = text;
    logEl.appendChild(line);
  }

  function runCheck() {
    logEl.textContent = '';
    var btn = document.getElementById('check-btn');
    btn.disabled = true;
    var raw = document.getElementById('check-url').value.trim();
    var url = /^https?:\\/\\//i.test(raw) ? raw : 'https://' + raw;
    var host;
    try { host = new URL(url).hostname; } catch (e) { out('bad', '✗ URL 无法解析'); btn.disabled = false; return; }

    var finish = function () { out('info', '—— 检测结束 ——'); btn.disabled = false; };
    out('info', '目标：' + url + '（域名 ' + host + '）');

    /* 层1：静态分析（目标站允许跨域读取时） */
    fetch(url, { redirect: 'follow' })
      .then(function (res) {
        return res.text().then(function (html) {
          out('ok', '✓ 页面源码可读取（HTTP ' + res.status + '），静态检查：');
          var m = html.match(/data-base-url\\s*=\\s*["']([^"']+)["']/i);
          if (m) {
            var target = m[1].replace(/\\/+$/, '');
            if (target === SELF) out('ok', '✓ data-base-url 指向本实例');
            else out('bad', '✗ data-base-url = ' + m[1] + '，与本实例 ' + SELF + ' 不一致');
          } else {
            out('bad', '✗ 未找到 data-base-url 属性（页面可能未引入脚本）');
          }
          if (/<script[^>]+index\\.min\\.js/i.test(html)) out('ok', '✓ 检测到埋点脚本引用');
          else out('warn', '! 未检测到 index.min.js 引用（改过文件名可忽略）');
          if (/id\\s*=\\s*["']page_pv["']/i.test(html)) out('ok', '✓ 存在 id="page_pv" 元素');
          else out('warn', '! 未找到 id="page_pv" 元素（无 PV 展示需求可忽略）');
          if (/id\\s*=\\s*["']page_uv["']/i.test(html)) out('ok', '✓ 存在 id="page_uv" 元素');
          else out('warn', '! 未找到 id="page_uv" 元素（无 UV 展示需求可忽略）');
          return true;
        });
      })
      .catch(function () {
        return fetch(url, { mode: 'no-cors' })
          .then(function () {
            out('warn', '! 站点可达，但跨域策略禁止读取源码 —— 跳过静态检查，改用行为实测');
            return true;
          })
          .catch(function (e2) {
            out('bad', '✗ 站点不可达（' + (e2 && e2.message ? e2.message : '网络错误') + '）');
            return false;
          });
      })
      .then(function (reachable) {
        if (!reachable) { finish(); return; }

        /* 层2：行为实测 —— 隐藏 iframe 真实加载，观察本实例计数变化 */
        out('info', '行为实测：在隐藏 iframe 中真实加载页面（约 6 秒）…');
        var before = null;
        statOf(host)
          .then(function (b) { before = b; })
          .then(function () {
            var f = document.createElement('iframe');
            f.style.display = 'none';
            f.setAttribute('aria-hidden', 'true');
            f.src = url;
            document.body.appendChild(f);
            return sleep(6000).then(function () { f.remove(); });
          })
          .then(function () { return statOf(host); })
          .then(function (after) {
            if (after && (!before || after.pv > before.pv)) {
              out('ok', '✓ 埋点已真实上报到本实例（PV ' + (before ? before.pv : 0) + ' → ' + after.pv + '）—— 配置有效');
            } else if (after && before && after.pv === before.pv) {
              out('bad', '✗ 页面已加载但计数无变化 —— 脚本可能被 CSP 拦截，或同 IP 一小时内已建过访客');
            } else {
              out('bad', '✗ 本实例未收到该域名的任何上报 —— 大概率未接入或 data-base-url 指向别处');
            }
            finish();
          })
          .catch(function (e) { out('bad', '✗ 行为实测异常：' + (e && e.message ? e.message : e)); finish(); });
      });
  }
  document.getElementById('check-btn').addEventListener('click', runCheck);
  document.getElementById('check-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') runCheck(); });
})();
</script>
</body>
</html>
`;
