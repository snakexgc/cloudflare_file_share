# 临时传 · Cloudflare File Share

匿名临时文件分享服务。浏览器优先通过 WebRTC 直连；失败后由服务端按 **P2P → TURN → WS 中继 → R2** 的顺序授权回退。Workers 提供页面和控制 API，SQLite Durable Objects 协调会话、流控与预算，D1 保存元数据，私有 R2 桶保存临时文件。

在线地址：[临时传](https://cloudflare-file-share.9420.workers.dev)。源码：[GitHub 公开仓库](https://github.com/snakexgc/cloudflare_file_share)。

项目使用 Wrangler 部署到 Cloudflare。未配置机密变量时，分享页面、P2P 信令与 WS 中继仍可运行；R2 直传和 TURN 需要补齐下文对应的机密变量。已完成的测试与待验证项目见 [验收记录](docs/validation.md)。

## 本地运行

需要 Node.js 22.12+（本次使用 Node.js 24）、npm 和现代浏览器。

```powershell
npm ci
npm run db:local
npm run dev
```

访问 `http://127.0.0.1:8787`。本地 D1、R2 和 DO 状态写入 `.wrangler/`；默认不开启 TURN，不需要云端密钥即可运行分享页面、P2P 信令和 WS 文件中继。R2 直传未配置时会显示明确错误，不会偷偷改成 Worker 文件代理。

选择文件与 1–24 的整数小时有效期，生成公开链接。管理令牌只在管理页面 URL 的 `#owner=...` 中，请只分享页面显示的公开链接。刷新管理页面后重新选择原文件：核对名称、精确大小、修改时间，以及已经登记的 SHA-256，确认后才能恢复发送。没有首次传输哈希时，只能核对登记的文件元数据。

有效期默认 6 小时，从创建分享开始计算，重连、上传、暂停、恢复与切换模式都不延长。仅访问公开页面不触发传输；点击下载后才开始。P2P、TURN 和 WS 需要分享者页面可运行并联网；R2 完整对象 ready 后可离线下载。

## 机密变量：准确名称与用途

用本地 Wrangler 联调真实 R2 时，还须在 `r2_buckets` 的 `BUCKET` 配置中设 `remote: true`，并确认 binding、`R2_BUCKET_NAME` 和 S3 endpoint 指向同一账户与桶。仅填写 `.dev.vars` 而仍使用本地 R2 binding，会把远程 PUT 与本地 HEAD 混用。本地开发默认使用本地 binding；部署后的 Worker 使用远程 R2 binding。

**在 Cloudflare Worker 的「设置 → 变量和机密」中添加，加密类型选择 Secret，名称大小写必须一致。** 本地需要连接真实服务时，将 `.dev.vars.example` 复制为 `.dev.vars` 后填写。`.dev.vars` 已忽略，不要提交密钥。

| 变量名 | 何时需要 | 用途 |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | R2 必需，使用自定义 `R2_ENDPOINT` 时可省略 | R2 所属 Cloudflare Account ID，生成 S3 endpoint |
| `R2_ACCESS_KEY_ID` | R2 必需 | 桶范围的 R2 S3 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 必需 | 与 Access Key 配套的 S3 Secret Access Key；用于短期 URL 签名和查询 Multipart parts |
| `TURN_KEY_ID` | TURN 必需 | Cloudflare Realtime TURN Key ID |
| `TURN_KEY_API_TOKEN` | TURN 必需 | 该 TURN Key 的 API Token，用于生成和撤销短期凭证 |
| `CF_ACCOUNT_ID` | TURN 必需 | 查询账户级 TURN 使用量的 Account ID |
| `CF_ANALYTICS_API_TOKEN` | TURN 必需 | 具有该账户 **Account Analytics: Read** 权限的 API Token |
| `TURNSTILE_SECRET_KEY` | 可选 | 启用服务端人机验证；配置后创建分享必须通过验证 |
| `TURNSTILE_SITE_KEY` | 配置 Turnstile 时必需 | 与 Secret Key 配套的公开 Site Key，允许应用实际域名；会通过 `/api/config` 提供给浏览器 |
| `ADMIN_TOKEN` | 可选 | 保护只读的 `/api/admin/budget` 预算监控接口；建议随机生成至少 32 字节 |

R2 Access Key 必须允许指定私有桶的对象读写及 Multipart 管理。S3 Access Key/Secret 与 Cloudflare 账户 API Token 是不同凭据；不要把 `CF_ANALYTICS_API_TOKEN` 填到 R2 Secret 的位置。TURN 的长期 API Token 不发给浏览器，浏览器只能获得获准任务的短期 ICE 凭证。

获取 R2 凭据：在 Cloudflare 控制台选中 R2 所属账户，按 `Ctrl + K` 搜索 `Copy account ID`，复制为 `R2_ACCOUNT_ID`。进入 R2 概览的 Account Details，点击 API Tokens 旁的 Manage，创建 Account API token 或 User API token；权限选择 Object Read & Write，只授权 `file-share-temporary` 桶。将创建结果中的 Access Key ID 和 Secret Access Key 分别填入 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。Secret Access Key 只显示一次。详见 [R2 官方说明](https://developers.cloudflare.com/r2/api/tokens/)。

CLI 配置使用项目内 Wrangler，交互输入密钥，避免写到命令参数或 shell 历史：

```powershell
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_API_TOKEN
# 以下为可选
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put ADMIN_TOKEN
```

`R2_ENDPOINT` 是可选配置，默认 `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`。使用受地域限制的桶时设为对应 S3 endpoint；生产必须 HTTPS。本地受控 S3 测试端点只允许 `http://127.0.0.1` 或 `http://localhost`。`R2_BUCKET_NAME` 和 `LIMITS` 是普通变量，写在 `wrangler.jsonc` 的 `vars` 中，不是秘密。

**配完 TURN Secrets 后还必须在 `LIMITS` 中设 `turnEnabled: true`。** 默认关闭 TURN，避免未核对共享额度时发出凭证。统计查询失败或过旧时拒绝新 TURN 授权，继续检查 WS / R2。统计汇总账户所有 TURN Key；账户同时使用 SFU 时，必须通过 `turnExternalReserveBytes` 为 SFU 等共享使用量预留预算。独占账户可以明确设为 0。

## 配置与限额

`LIMITS` 是 JSON 字符串，仅接受 [配置定义](src/worker/config.ts) 中的字段；未知字段、错误类型和不一致的块/窗口参数会报错。推荐初始配置见 [examples/limits.json](examples/limits.json)，示例写法：

```json
"vars": {
  "R2_BUCKET_NAME": "file-share-temporary",
  "LIMITS": "{\"turnEnabled\":true,\"turnExternalReserveBytes\":100000000000}"
}
```

默认单文件 10 GiB、单分享 20 GiB、最多 32 个文件。WS 单文件默认 512 MiB、实际数据块 256 KiB、每任务在途窗口 1 MiB、每房间总窗口 8 MiB；RTC 数据块 32 KiB。协议头计入完整 WS 消息的 33,554,432 字节硬上限。

默认 R2 保留/已用预算共 8,000,000,000 字节，最多 16 个未完成上传。ready 对象继续占存储预算，释放上传并发。单次 PUT 的精确上限为 `5 * 1024 ** 3 - 5 * 1024 ** 2`（5,363,466,240 字节）；不超上限只发一次整文件 PUT。超过上限才创建 Multipart，默认 64 MiB parts、串行直传、由服务端查询真实 parts 并合并。**Multipart 签发分片前先增量核对完整源 SHA-256，恢复会话也必须重新确认源文件身份。**

还可配置来源/IP 速率、活动分享数、会话数、下载并发、TURN 月预算/安全余量/凭证 TTL、WS 月字节/消息预算、R2 Class A/B 操作预算、轮询频率、控制队列容量与 TTL、在线租约和清理宽限。默认业务请求 25,000/UTC 日、保守 DO 请求 40,000/UTC 日、D1 实际扫描行 3,000,000/日及写入行 80,000/日。D1 使用量来自执行结果的 `rows_read`/`rows_written`；达到阈值后拒绝新业务，已登记的删除仍继续。

这些是本服务的准入阈值，**不保证任意使用量或账户其他项目下账单为零**。DO 账本把 WS 消息按原始数量保守计入预算，不能替代 Cloudflare 实际账务；D1 单次操作完成后计量，可能有一次有界的阈值跨越。拒绝请求、静态页面、后台清理、未追踪的其他服务和已有 TURN allocations 仍可能耗用账户资源。TURN 已签发授权按完整预留量保守结算，不相信客户端报的收费字节；统计与已结算量相加可能重复计量，代价是更早拒绝新授权。

## 文件完整性与恢复

所有传输路径共用一个写入器和增量 SHA-256。协议核对 `fileId`、`transferId`、epoch、顺序偏移和长度，拒绝重复、空洞、越界与迟到消息。写入器关闭成功、全部字节到齐且 SHA-256 一致后才完成。

桌面 Chrome / Edge 优先使用 File System Access API，增量落盘。缺少文件流时只允许默认最多 32 MiB 的有界内存下载，仍输出一个完整文件；显示「已校验，已交给浏览器保存」，不声称已确认操作系统保存完成。更大文件明确提示更换支持流式保存的浏览器。取消或写入失败会 abort；不会输出独立分片文件。

同一页面的 P2P → TURN / WS 可携带已实际写入的偏移与可信哈希前缀，发送端重新扫描源前缀。切换前先停止旧任务；R2 回退/网络重试从头写入并清空旧结果。刷新接收页面后重新下载。DO 重启不持久化 WS 文件数据或 credit，旧窗口被拒绝，重新同步并从可信进度重建或回退 R2。单次 PUT 取消后重新上传；Multipart 在受控分片边界暂停，默认宽限 5 分钟且不超过原到期时间。

## 部署到 Cloudflare

首次部署时创建项目专用资源；已有同名资源时直接使用已有配置：

```powershell
npx wrangler login
npx wrangler d1 create file-share-db
npx wrangler r2 bucket create file-share-temporary
```

将 D1 返回的 `database_id` 填入 `wrangler.jsonc`；部署到自己的账户时替换此 ID。DO 使用 SQLite-backed 的 `new_sqlite_classes` 迁移，两个类为 `ShareRoom`、`TURNBudget`。R2 使用 Standard 私有桶，关闭公开 bucket / r2.dev 下载入口。后续变更新增 SQL 迁移，不改已应用的迁移。

确认 [config/r2-cors.json](config/r2-cors.json) 中的来源与应用的 HTTPS origin 一致；部署到其他账户或更换域名时更新来源。必要时单独增加本地联调 origin，勿用无约束来源：

```powershell
npx wrangler r2 bucket cors set file-share-temporary --file config/r2-cors.json
npx wrangler r2 bucket lifecycle add file-share-temporary temporary-expiry temporary/ --expire-days 1 --abort-multipart-days 1
npm run db:remote
npm run deploy
```

可以先部署，再在 Worker 的「设置 → 变量和机密」中补齐密钥并部署设置变更。缺少 R2 S3 密钥时不会签发上传或下载 URL；TURN 默认关闭，补齐 TURN 密钥后还需在 `LIMITS` 中设 `turnEnabled: true`。后续更新代码使用 `npm run deploy`，新增数据库迁移时先执行 `npm run db:remote`。

Lifecycle 是兜底，不能代替 1–24 小时的业务期限，也不保证对象在期限到达的某一毫秒物理消失。主清理由 ShareRoom Alarm 完成，5 分钟 Cron 分页扫描补偿；每个上传 attempt 的唯一 key 在产生 R2 对象前登记。取消后重复检查迟到 PUT，默认额外 1 小时清理宽限，成功清理后保留 24 小时 tombstone。失败保留清单并自动重试，状态区分「已过期」「正在清理」「已删除」。

上传与下载均浏览器直连 R2。Worker 仅签名、HEAD、查询 parts、Complete/Abort/Delete，不 `put` 文件、不 `uploadPart` 文件、不代理 GET 文件。PutObject / UploadPart URL 同时签名 Content-Type 和精确 Content-Length（浏览器自动发送长度）；真实 R2 对该约束的兼容性需要后续联调。所有签名 TTL 不晚于原 `expiresAt`。已开始的 HTTP 流、已建立的 TURN allocation 与已保存的本地文件不能保证在到期瞬间中断/撤回。

## 测试与验收

```powershell
npm run check
npm test
npm run build
npm audit
```

Vitest 在真实 workerd + 本地 D1/R2/DO 中运行；对 Cloudflare 外部 TURN、Analytics、S3 ListParts 使用受控替代，测试不会请求这些外部接口。覆盖授权隔离、过期、事件重同步/去重、共享上传、迟到写入清理、R2 单 PUT 与 Multipart、WS 真正的双向连接/转发/窗口限制、重启后拒绝旧窗口、完整文件与 SHA-256、零字节及失败路径。

浏览器传输验收使用生产的 `ControlSession`、`SendTask`、`ReceiveTask` 与 `VerifiedSink`，生成测试文件，经本地 API 传输到 OPFS，关闭后重新读取比较哈希。验收入口不进入生产构建：

```powershell
# 两个终端分别运行
npm run dev
npm run test:browser
```

打开 `http://127.0.0.1:5175` 点击各项测试。当前浏览器禁用了 WebRTC 构造器时直连项目会明确 SKIP，不能把 WS 回退成功当作 WebRTC 成功。测试会撤销自己的分享并清除生成的 OPFS 文件。

本地 Wrangler 不自动运行 Cron。可手动触发：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

预算监控：`GET /api/admin/budget`，使用 `Authorization: Bearer <ADMIN_TOKEN>`。返回当日 API/DO/D1、月度 TURN 统计与预留、WS 字节/消息、R2 保留字节与操作次数。日志只记录任务标识、字节、消息、时长与失败原因，不打印密钥或文件内容。

## 接口与代码位置

公开查看 `/api/shares/:id`；独立管理权限用于会话、上传与撤销。控制层提供 `/sessions`、`/ws`、`/signals`、`/events?cursor=...`、`/heartbeat`、`/files-status`。下载者通过 `/download-requests` 创建需求；`/download-requests/:requestId/advance` 统一授权下一阶段，DELETE 只取消本人任务。TURN 凭证与 WS relay 准入合并在这个推进接口，客户端不能跳过服务端预算判断。

R2 控制接口为 `/files/:fileId/uploads`、`/identity`、`/parts/:part/sign`、`/complete`、`/abort`、`/failure`、`/download`。`/failure` 在未获得上传授权时也能通知等待者，源文件不可读时进入等待恢复。内部初始化和清理路由仅由 Worker 的 DO binding 调用，公网不转发 `/internal/*`。源代码分别在 `src/worker/`、`src/client/`、`src/shared/`、`web/`，SQL 在 `migrations/`。

## 核对的官方资料

实现时于 2026-10-11 核对：[TURN 凭证管理](https://developers.cloudflare.com/realtime/turn/generate-credentials/)、[TURN Analytics](https://developers.cloudflare.com/realtime/turn/analytics/)、[Workers WS API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[R2 上传限制](https://developers.cloudflare.com/r2/platform/limits/)、[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[aws4fetch 签名示例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)。真实额度、价格和服务行为上线前仍需复核。
