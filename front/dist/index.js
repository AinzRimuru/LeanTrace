/*!
 * LeanTrace 埋点脚本 v2 —— 无状态访客 token
 *
 * 访客身份与「到访过哪些页面」保存在客户端（服务端零去重存储）：
 *   - 服务端签发的 HMAC token 写入 localStorage，并镜像到 cookie 双保险
 *   - 每次上报携带 token；服务端需要更新（新访客/新页面/续签）时回传新 token
 *   - 换 IP / 换网络身份不变；隐私模式（存储不可用）自动退化为按会话计数
 *
 * 用法（放在 </body> 前，data-base-url 必填、无尾部斜杠）：
 *   <script defer src="/path/to/index.min.js"
 *           data-base-url="https://your-worker.workers.dev"
 *           data-page-pv-id="page_pv"
 *           data-page-uv-id="page_uv"></script>
 *
 *   本页访问人次: <span id="page_pv"></span>
 *   本页访问人数: <span id="page_uv"></span>
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'leantrace_token';
  var COOKIE_KEY = 'leantrace_token';
  var TOKEN_MAX_LEN = 4096; // 与服务端 BLOOM_BYTES=2048 时的 token 尺寸（~3768）兼容；服务端会精确校验上限
  var COOKIE_MAX_AGE_SEC = 34560000; // 400 天，与 token TTL 对齐

  var currentScript = document.currentScript;
  var baseUrl = (currentScript && currentScript.getAttribute('data-base-url')) || '';
  var pvElementId = (currentScript && currentScript.getAttribute('data-page-pv-id')) || 'page_pv';
  var uvElementId = (currentScript && currentScript.getAttribute('data-page-uv-id')) || 'page_uv';

  function readTokenFromCookie() {
    var match = document.cookie.match(new RegExp('(?:^|;\\s)' + COOKIE_KEY + '=([^;]*)'));
    if (!match) return '';
    try {
      var value = decodeURIComponent(match[1]);
      return value.length > 0 && value.length <= TOKEN_MAX_LEN ? value : '';
    } catch (e) {
      return '';
    }
  }

  function readToken() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored.length <= TOKEN_MAX_LEN) return stored;
    } catch (e) {
      /* 隐私模式 / 禁用存储：退回 cookie */
    }
    return readTokenFromCookie();
  }

  function writeToken(token) {
    try {
      localStorage.setItem(STORAGE_KEY, token);
    } catch (e) {
      /* ignore */
    }
    try {
      // 单 cookie 上限约 4096 字节（含名称）；若未来调大指纹导致超限，
      // 只保留 localStorage 镜像，避免 cookie 被浏览器静默丢弃/截断
      if (COOKIE_KEY.length + 1 + token.length <= 4000) {
        document.cookie =
          COOKIE_KEY + '=' + encodeURIComponent(token) +
          '; path=/; max-age=' + COOKIE_MAX_AGE_SEC + '; SameSite=Lax';
      }
    } catch (e) {
      /* ignore */
    }
  }

  function init() {
    var pvEle = document.getElementById(pvElementId);
    var uvEle = document.getElementById(uvElementId);
    if (!pvEle && !uvEle) return;
    if (!baseUrl) {
      // 不设默认第三方服务：缺配置就静默跳过，绝不把数据发往别处
      console.warn('[LeanTrace] missing data-base-url, skip tracking');
      return;
    }

    var here = document.createElement('a');
    here.href = window.location.href;

    // 当前文档的 HTTP 状态码（PerformanceNavigationTiming.responseStatus）：
    // 404/5xx 页面（主题模板通常带埋点脚本）会上报给服务端聚合到哨兵行，
    // 避免每个错误地址都变成一行永久计数；老浏览器拿不到则为 0，服务端按 200 处理
    var status = 0;
    try {
      var nav = window.performance && performance.getEntriesByType &&
        performance.getEntriesByType('navigation')[0];
      if (nav && typeof nav.responseStatus === 'number') status = nav.responseStatus;
    } catch (e) {
      /* ignore */
    }

    var payload = {
      hostname: here.hostname,
      url: here.pathname,
      referrer: document.referrer || '',
      token: readToken(),
      status: status,
    };
    if (pvEle) payload.pv = true;
    if (uvEle) payload.uv = true;

    fetch(baseUrl + '/api/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (res) {
        if (!res || res.ret !== 'OK' || !res.data) return;
        if (typeof res.data.token === 'string' && res.data.token) writeToken(res.data.token);
        if (pvEle && typeof res.data.pv !== 'undefined') pvEle.innerText = res.data.pv;
        if (uvEle && typeof res.data.uv !== 'undefined') uvEle.innerText = res.data.uv;
      })
      .catch(function (err) {
        console.warn('[LeanTrace] report failed', err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
