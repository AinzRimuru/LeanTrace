# LeanTrace

轻量、隐私友好的博客访问统计 —— 跑在 Cloudflare Workers 免费额度上，一行脚本接入。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![D1](https://img.shields.io/badge/D1-SQLite-0051C3?logo=cloudflare&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-4.x-E36002)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
[![CI & Deploy](https://github.com/AinzRimuru/LeanTrace/actions/workflows/deploy.yml/badge.svg)](https://github.com/AinzRimuru/LeanTrace/actions/workflows/deploy.yml)

LeanTrace 在博客页面展示「本页访问人次（PV）/ 本页访问人数（UV）」。它是对 webviso 类统计服务的现代化重写，解决此类方案的三个结构性问题：全表扫描、明文 IP 无限膨胀、把 IP 当作用户身份。

## 特性

- **一行脚本接入** —— 可直接引用实例自带的 `/js/index.min.js`（无需自托管脚本），两个标签展示 PV/UV；根路径即在线演示与配置检测页
- **换 IP 不丢身份** —— 访客身份是浏览器持有的签名 token（JWT 风格 HMAC + Bloom 页面指纹），不再是 IP：NAT 下的多个人不再被算成一个人，换网络刷新不再变成新访客
- **明文 IP 不落库** —— 计数与访问明细里没有 IP；仅防滥用限额表临时保存 90 天
- **防刷** —— token 一次性版本号防重放，同 IP 每小时最多产生 1 个新访客 ID（刷量成本被压到 ≤ 1 UV/小时/IP）
- **计费友好** —— 全索引 O(1) 读写、无 COUNT/SUM 聚合、404 与刷路径自动聚合到哨兵行，存储行数严格有界
- **零运维** —— 首次请求自动建表（版本化迁移），cron 每日清理过期数据

## 快速开始

### 1. 部署后端

```bash
npm install
npx wrangler login                    # 浏览器授权 Cloudflare 账号

npx wrangler d1 create leantrace      # 把输出中的 database_id 填入 wrangler.toml
npx wrangler secret put TOKEN_SECRET  # 输入 ≥16 位随机字符串（token 签名密钥）
npm run deploy
```

> [!NOTE]
> 不需要手动建表。数据库结构在首次请求时自动创建（版本化迁移）。
> 走 [自动部署](#自动部署) 时可跳过本节，直接把仓库推上去。

### 2. 接入博客

部署后访问 Worker 域名（根路径）即可看到**自演示页**：接入代码片段、本页实时 PV/UV、以及接入配置检测（纯浏览器端执行）。接入博客只需：

```html
<script defer src="https://leantrace.your-name.workers.dev/js/index.min.js"></script>

本页访问人次: <span id="page_pv"></span>
本页访问人数: <span id="page_uv"></span>
```

也可以把 [`front/dist/index.min.js`](front/dist/index.min.js) 放进自己博客的静态目录自行托管，引用时加上 `data-base-url`：

```html
<script defer src="/leantrace/index.min.js"
        data-base-url="https://leantrace.your-name.workers.dev"></script>
```

> [!WARNING]
> 直引实例脚本时无需 `data-base-url`（同源自动指向本实例）；自托管时必填且结尾不带 `/`。缺少时脚本静默跳过 —— LeanTrace 永远不会把数据发往第三方默认地址。

**前端参数**

| 属性 | 默认 | 说明 |
|---|---|---|
| `data-base-url` | 无（必填） | 你部署的 Worker 地址 |
| `data-page-pv-id` | `page_pv` | 展示 PV 的元素 id |
| `data-page-uv-id` | `page_uv` | 展示 UV 的元素 id |

## API

### `POST /api/visit`

埋点上报 + 计数（前端脚本自动调用，也可自行集成）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `hostname` | ✓ | 站点域名 |
| `url` | ✓ | 页面路径（自动去 query/hash，截断 512） |
| `referrer` | | 来源 URL，服务端拆解为域名 + 路径 |
| `token` | | 上次响应返回的 token；一次性使用，首访为空 |
| `status` | | 当前文档 HTTP 状态码；404/5xx 聚合到哨兵行（缺省按 200） |
| `pv` / `uv` | | 传 `true` 才在响应中返回对应计数 |

```jsonc
// 响应
{ "ret": "OK", "data": { "pv": 42, "uv": 17, "token": "..." } }
// token 在每次成功计数后返回（版本号已前移，旧版本立即作废）；
// 被防刷拦截时不计数、不返回 token，只回只读统计
```

### `GET /api/stats`

只读查询，不产生记录。

```
GET /api/stats?hostname=blog.example.com&url=/post/hello/   单页计数
GET /api/stats?hostname=blog.example.com                    站点汇总
GET /api/stats?hostname=blog.example.com&url=/__lt_404__   全站 404 汇总
```

## 配置

`wrangler.toml` 中的 `[vars]` 与 secret：

| 变量 | 方式 | 默认 | 说明 |
|---|---|---|---|
| `TOKEN_SECRET` | `wrangler secret put` | —（必需） | token 签名密钥，≥16 位随机字符；本地开发写入 `.dev.vars`（参考 `.dev.vars.example`） |
| `LOG_RETENTION_DAYS` | `[vars]` | `90` | 访问明细保留天数，cron 每日清理 |
| `VISITOR_RETENTION_DAYS` | `[vars]` | `90` | 防滥用状态表保留天数（按最近活跃计） |
| `MAX_PAGES_PER_SITE` | `[vars]` | `5000` | 每站页面计数行上限，超出后新路径计入溢出哨兵行 |

## 自动部署

推送到 `main` 即自动部署（GitHub Actions，[deploy.yml](.github/workflows/deploy.yml)）：先跑全部测试（typecheck / 冒烟 / 端到端），通过后部署到 Cloudflare Workers；**首次运行会自动创建 D1 数据库并解析 `database_id`**，无需手改 `wrangler.toml`。PR 只跑测试不部署。

在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 必需 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✓ | 权限：Account · Workers Scripts · **Edit** + Account · D1 · **Edit** |
| `TOKEN_SECRET` | 建议 | Worker 签名密钥（≥16 随机字符），每次部署自动同步到 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | 多账号时 | 仅当 Token 可访问多个账号时需要 |
## 数据与隐私

| 数据 | 存储位置 | 保留期 |
|---|---|---|
| PV/UV 计数 | `t_page_stat` / `t_website` | 永久（计数器本身） |
| 访问明细（路径、来源、状态码、访客 ID） | `t_visit_log` | 90 天，cron 自动清理 |
| 防滥用状态（版本号、建号时 IP） | `t_visitor_state` | 90 天不活跃后清理 |

**不采集**：明文 IP 不进任何计数或明细行；无 User-Agent、屏幕、行为数据；无跨站跟踪。访客身份只是 token 内的 128 bit 随机数。

## 已知取舍

> [!IMPORTANT]
> - UV 是 **400 天滚动窗口**而非建站以来精确去重；单页 UV 精确，站点级 UV 为各页之和（上限估计）
> - token 一次性使用，前端脚本自动保存每次回发的新版本 —— **必须使用本项目前端脚本**（旧 webviso 脚本不兼容）
> - 清空浏览器存储 / 隐私模式的访客，1 小时内不会计为新用户（IP 限额的代价，换来 ≤ 1 UV/小时/IP 的刷量成本）
> 404/5xx 页面上的计数器显示全站 404 汇总，不产生独立计数行
> - **自部署实例建议在 Cloudflare 边缘为 `POST /api/visit` 配置速率限制**（如 >120 次/分/IP 阻断）：蹭用与脚本刷量流量在到达 Worker 前被拦截，不消耗 Workers/D1 配额。动作用 Block 而非人机验证 —— 埋点是后台 fetch，弹不出验证页

## 开发

```bash
npm run typecheck    # tsc --noEmit（strict）
npm run smoke        # 62 项冒烟：node:sqlite 跑真实 SQLite，含新旧 schema EXPLAIN 对照
npm run e2e          # 22 项端到端：起 wrangler dev + 本地 D1，从空库验证自动迁移
npm run dev          # 本地调试（读 .dev.vars）
```

```
src/index.ts        # Hono 路由与请求流程
src/lib/token.ts    # HMAC 签名 token + Bloom 页面指纹
src/lib/db.ts       # D1 访问层（全索引 O(1)）
src/lib/paths.ts    # 计数落点解析（真实路径 / 404·错误·溢出哨兵）
src/lib/migrate.ts  # 版本化自动迁移
src/lib/validate.ts # 入参规范化与防御
front/dist/         # 埋点脚本（可读版 + 压缩版）
schema.sql          # 最新表结构（幂等）
.github/workflows/  # CI 与自动部署
scripts/            # 冒烟 / 端到端测试
```

## 致谢

设计思路源自 [webviso](https://webviso.yestool.org/)（yestool）及其开源实现，针对其三个结构性问题重写。
