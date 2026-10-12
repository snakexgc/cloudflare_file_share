# 临时传 · Cloudflare File Share

匿名临时文件分享服务。普通访客按 **P2P → TURN → WS → HTTPS 中继** 授权回退，所有在线路径失败后停止，不自动使用 R2。管理员登录后，其源端分享、其下载任务以及明确指定的文件才可以使用 R2。Workers 提供页面和控制 API，SQLite Durable Objects 协调会话、流控与预算，D1 保存元数据，私有 R2 桶保存临时文件。

在线地址：[临时传](https://share.snakexgc.com)（[workers.dev 入口](https://cloudflare-file-share.9420.workers.dev)）。源码：[GitHub 公开仓库](https://github.com/snakexgc/cloudflare_file_share)。

项目使用 Wrangler 部署到 Cloudflare。未配置机密变量时，分享页面、P2P 信令与 WS 中继仍可运行；R2 直传和 TURN 需要补齐下文对应的机密变量。已完成的测试与待验证项目见 [验收记录](docs/validation.md)。

## 本地运行

需要 Node.js 22.12+（本次使用 Node.js 24）、npm 和现代浏览器。

```powershell
npm ci
npm run db:local
npm run dev
```

访问 `http://127.0.0.1:8787`。本地 D1、R2 和 DO 状态写入 `.wrangler/`；未配置 TURN 机密变量时不会签发中继凭据，不需要云端密钥即可运行分享页面、P2P 信令和 WS 文件中继。R2 直传未配置时会显示明确错误，不会偷偷改成 Worker 文件代理。

选择文件与 1–24 的整数小时有效期，生成公开链接。管理令牌只在管理页面 URL 的 `#owner=...` 中，请只分享页面显示的公开链接。刷新管理页面后重新选择原文件：核对名称、精确大小、修改时间，以及已经登记的 SHA-256，确认后才能恢复发送。没有首次传输哈希时，只能核对登记的文件元数据。

有效期默认 6 小时，从创建分享开始计算，重连、上传、暂停、恢复与切换模式都不延长。打开页面会自动检测网络、维持在线状态和尝试打洞；点击下载后才传输文件内容。P2P、TURN、WS 和 HTTPS 需要分享者页面可运行并联网；R2 完整对象 ready 后，在有效管理员授权期限内可离线下载。

## 管理登录、文件和用量

访问 [`/admin`](https://share.snakexgc.com/admin)，输入 **`ADMIN_TOKEN` 的值**作为管理密码。没有配置该 Secret 时管理登录关闭，R2 也不会对匿名用户自动开放。此密码与分享链接中的 `#owner=...` 管理令牌不同：owner 令牌只管理一个分享，不能获得全站管理或 R2 准入权限。

登录使用 8 小时有效的 HttpOnly、SameSite=Strict Cookie（HTTPS 下增加 Secure），密码不写入 localStorage。服务端只保存随机会话令牌的哈希；退出登录、会话过期或更换 `ADMIN_TOKEN` 都会撤销后续授权。每个来源 15 分钟最多 5 次登录尝试。登录只授权该管理员参与的分享或下载，不会为其他匿名分享全局开启 R2。

管理台提供：

- API / DO / D1 当日统计、R2 存储预留与 Class A/B 月度计数、WS 流量、TURN 测量值和预留预算条形图。
- 全部分享和文件的分页列表、原到期时间、云端与清理状态、房间内在线源端和接收端数量、传输模式。
- 在线页面会话数和最近心跳；匿名服务没有用户账号，统计口径是页面会话，60 秒内有心跳视为在线。
- 按文件强制 P2P / TURN / WS / HTTPS / R2，或恢复自动选择；在线接收端从已写入偏移切换，后续下载沿用指定方式。R2 下载会重新下载完整对象。强制方式失败后报告错误，不自动降级，也不被后台 P2P 成功覆盖。
- 删除文件、撤销整个分享、分页列出及删除 `temporary/` 下的 R2 实际对象。删除已登记文件会阻止新下载，取消相关传输、Abort Multipart、删除当前对象，并持续复核迟到 PUT；已签发的 URL 到期前不能单独撤销，因此清理记录和容量预留会保留到复核结束。

管理员登录的分享页面也会出现逐文件传输方式选择器。普通访客不显示 R2 检测项或方式选择器。跨标签页登录/退出后，回到分享页面会更新可见选项；实际 R2 请求仍由服务端检查授权。预算为应用侧账本，不是 Cloudflare 账单或账户支付上限；实际费用请在 Cloudflare 账单页面核对。

## 自动检测与后台 NAT 打洞

打开网页自动检测 P2P/STUN 候选、TURN 中继候选分配、WS 握手与小消息回显、HTTPS 请求回显，可点击「快速复测」。管理员还可检测 R2 私有桶访问；该项不会自动上传测试文件，S3 密钥和 CORS 在实际直传时验证。TURN 未启用或未配置时显示原因；TURN 探测受账户预算控制，凭证有效 60 秒、每来源每分钟一次、每次保守预留 1 MiB。候选分配成功不代表尚未在线的接收端可以连通。

检测分阶段报告：P2P 先检查当前页面能否创建 WebRTC DataChannel，再收集 ICE 候选；只有与实际对端建立通道后才算直连成功。缺少 `RTCPeerConnection` 或创建被拒绝时，显示「当前页面 API 不可用 / 无法测试」，并可展开查看构造器类型、安全上下文及相关接口，不能据此断定浏览器产品不支持 WebRTC 或 NAT 不可打洞。此检测不请求摄像头或麦克风。

TURN 分别报告缺失变量名称、已配置但开关关闭、统计/签名接口失败、短期凭据签发成功，以及客户端 relay 候选分配情况。即使当前页面不能使用 WebRTC，也可验证服务端配置和凭据签发，显示「服务已验证，当前页面无法测试中继链路」。快速复测在有效期内复用短期探测凭据，触发限速时显示暂缓，不将限速误报为凭据未配置。

两端分享页面在线时，单独的后台 ICE 通道自动交换 host / srflx 等候选并检查连通性，允许 IPv4 和 IPv6，不按地址族过滤候选。一次协商等待最多 45 秒；未打通时每 30 秒检查并重试，传输期间也继续。打通的 DataChannel 保留供后续文件复用。自动模式的 TURN / WS / HTTPS / R2 接收任务会停止旧链路、等待正在写入的数据落盘，然后按已写入偏移、全新 epoch 和 transferId 切换到热 P2P 通道，继续完整 SHA-256 校验；旧链路迟到分片不再写入。没有下载需求时只交换信令，不发送文件内容。

**NAT 判定边界：**浏览器 WebRTC API 提供 ICE 候选与连接状态，不开放任意 STUN 属性或原始 UDP。RFC 5780 的精确 NAT 映射/过滤分类需要专门服务器和 `CHANGE-REQUEST` / `OTHER-ADDRESS` 测试，因此纯网页无法可靠宣称「全锥形」「对称 NAT」等类型。页面如实显示候选地址族、公网映射是否取得、实际直连是否打通；mDNS 或隐私策略隐藏地址时显示「地址隐藏」。无法精确分类时仍尝试标准 ICE 打洞，避免错判而放弃可用路径。[WebRTC 标准](https://www.w3.org/TR/webrtc/)、[RFC 5780](https://www.rfc-editor.org/rfc/rfc5780.html)。

Cloudflare TURN 的客户端到服务器连接支持 IPv4/IPv6，但当前只分配 IPv4 relay 地址；不会将 IPv4 relay 当成 IPv6 不可用的证明。[Cloudflare TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)。页面需要浏览器允许 WebRTC、可运行和联网；后台休眠、设备睡眠或浏览器禁用 WebRTC 时不能保证打洞继续。

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
| `ADMIN_TOKEN` | 管理台和 R2 准入必需 | `/admin` 登录密码；保护全站统计、删除和方式选择，并允许管理员参与的任务使用 R2；建议随机生成至少 32 字节 |

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

**TURN Secrets 配齐且 `LIMITS.turnEnabled: true` 才能签发凭据。** 当前仓库的 `wrangler.jsonc` 与示例已显式启用；底层配置默认值仍为 false，使用自己的配置时应核对开关。统计查询失败或过旧时拒绝新 TURN 授权，继续检查 WS 和 HTTPS；仅有有效管理员授权时才进一步考虑 R2。统计汇总账户所有 TURN Key；账户同时使用 SFU 时，必须通过 `turnExternalReserveBytes` 为 SFU 等共享使用量预留预算。独占账户可以明确设为 0。

## 配置与限额

### HTTPS 分块中继

普通访客自动按 P2P → TURN → WS → HTTPS 授权回退，在线路径失败后仅有有效管理员授权才允许 R2。管理员可在分享页或管理台强制指定 HTTPS；强制方式失败后报告错误。HTTPS 默认无需额外 Secrets，完整文件上限为 10 GiB，块大小为 16 MiB，可通过 `httpsEnabled`、`httpsMaxFileBytes`、`httpsChunkBytes`、`httpsMaxConcurrent` 配置。块大小独立于 WS 和 R2 分片，最高 50 MiB，且不能超过房间缓冲。Cloudflare Free/Pro 的普通请求体上限仍为 100 MB，流式读取不绕过这个上限。[Workers 官方限制](https://developers.cloudflare.com/workers/platform/limits/)

分享者以 `File.slice()` 得到的 Blob POST 原始二进制块，服务器验证当前会话、任务、文件、epoch、transferId、偏移与精确长度后暂存在 DO 内存。下载者 GET 完整块、写入同一个目标文件，再 POST ACK；上传 POST 等待这个 ACK 后才返回新的发送偏移并允许下一块。无块时 GET 最多等待 25 秒，返回 204 与 Retry-After；上传和 ACK 使用现有 5 分钟截止时间。POST / ACK 幂等，未确认的块可重新 GET。HTTPS 内容仅在有界内存中中转，元数据持续持久化，完成时仍验证完整字节数与 SHA-256。

每任务只准入一个块窗口；HTTPS 与 WS 共用每房间最多 64 MiB 的预算，同一个运行实例中的 HTTPS 窗口也合计限制为 64 MiB。默认全局最多 32 个 HTTPS 任务，实际并发受上述窗口进一步限制。上传读取及网络等待位于房间串行锁外，因此慢上传不阻塞心跳、取消或其他文件。取消、切换、超时、到期和删除会停止旧请求并释放缓冲。

HTTPS 任务的发现、心跳、事件和完成信令使用 HTTP，即使浏览器没有 WebSocket 或 WebRTC 也可下载。仅 HTTPS 会话跳过 WS 握手和探测，同页面其他文件可保留已有 WS 数据连接。同块网络请求最多重试两次，仍失败或 DO 重启时可按实际写入进度重建一次 HTTPS 任务，使用新的 epoch / transferId；分享者重新扫描源前缀，接收者继续完整文件哈希。文件写入或 SHA-256 校验失败直接终止。大文件保存沿用现有流式文件写入器及浏览器能力要求。

接口为 `/api/shares/:shareId/download-requests/:requestId/https/chunk`（POST 上传、GET 读取）和 `/https/ack`（POST JSON 确认）。chunk 查询参数与 ACK JSON 都携带 `fileId`、`epoch`、`transferId`、`offset`；上传使用 `application/octet-stream`。`/download-requests/:requestId/resume` 验证接收会话、旧 epoch / transferId 和恢复偏移后重建 HTTPS 任务。数据接口使用现有会话 Bearer 令牌，并禁止缓存与跨站调用。

每块通常产生一次上传、一次读取和一次 ACK；重试、25 秒等待结束后的再次读取及控制轮询另计。HTTP 请求按现有 API / DO 日阈值计量，不使用 WS 消息的 20:1 折算。管理台显示已转发字节（包含重读）、在传任务及累计任务活跃时长；并行任务时长相加，因此不是 Cloudflare 账单的房间活跃时长。DO 等待和定时器会产生持续时长计费，结束后停止定时器；此功能没有新增全账户计算时长熔断。[DO 官方计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)

`LIMITS` 是 JSON 字符串，仅接受 [配置定义](src/worker/config.ts) 中的字段；未知字段、错误类型和不一致的块/窗口参数会报错。推荐初始配置见 [examples/limits.json](examples/limits.json)，示例写法：

```json
"vars": {
  "R2_BUCKET_NAME": "file-share-temporary",
  "LIMITS": "{\"turnEnabled\":true}"
}
```

默认单文件 10 GiB、单分享 20 GiB、最多 32 个文件。WS 单文件默认最多 512 MiB，这是本项目的中继准入配置。Cloudflare 的 **32 MiB 限制作用于单条完整 WS 消息**，可以通过多条消息传输更大的完整文件；本项目每条消息有 52 字节协议头，并额外预留 1 KiB 链路余量，因此 `chunkBytes` 默认 **33,553,356 字节**，编码后的完整消息为 33,553,408 字节（32 MiB 减 1 KiB）。该余量来自云端实测：恰好达到 32 MiB 的消息在当前链路超时，预留 1 KiB 后连续大消息传输通过；它不是 Cloudflare 另行规定的上限。[DO 官方限制](https://developers.cloudflare.com/durable-objects/platform/limits/)

**WS 不设累计流量上限。** `/admin` 显示当月已转发字节，包含正在传输的已转发数据；整个文件的预留字节不会被误记为实际流量。原 `wsMonthlyBytes` 和自设的 `wsMonthlyMessages` 已移除，WS 消息统一受 DO 请求预算控制。并发、单文件、内存窗口和超时仍是独立准入参数。

**TURN 月上限为 950,000,000,000 字节（950 GB，十进制）**，对应 SFU / TURN 共享的首 1000 GB 免费额度的 95%。950 GB 已包含 5% 余量，原 `turnSafetyBytes` 已移除，不再重复扣减；`turnExternalReserveBytes` 默认 0，只有同账户使用 SFU 等其他共享服务时才明确填写。[Realtime 官方计费](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)。

WS 每任务窗口默认一块载荷，收到实际写入 ACK 后再发送下一块；每房间在途数据预算最多 64 MiB，默认最多同时准入两个 WS 文件任务，避免扩大块后同时扩大内存占用。ACK 超时默认 5 分钟，给慢网络传输大消息留出时间；存在尚未 ACK 的文件消息时改走 HTTPS 心跳，即使 `bufferedAmount` 已清空也维持源会话租约。断连、到期仍会提前终止。RTC 保持独立的 32 KiB 数据块和 1 MiB 窗口，并受协商的 SCTP `maxMessageSize` 约束，不套用 WS 的大消息窗口。

活跃 WS 中继设置 ACK 截止时间定时器，阻止 DO 在大消息尚未完整到达时休眠、丢失内存中的流控窗口；该阶段按活动时长计费。最后一个中继完成、取消或超时后清除定时器，空闲信令仍可休眠。意外重启继续拒绝旧窗口并由客户端重新同步或回退。[DO 生命周期与休眠规则](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

默认 R2 保留/已用预算共 8,000,000,000 字节，最多 16 个未完成上传。ready 对象继续占存储预算，释放上传并发。单次 PUT 的精确上限为 `5 * 1024 ** 3 - 5 * 1024 ** 2`（5,363,466,240 字节）；不超上限只发一次整文件 PUT。这个请求上限也适用于 Multipart 的单片请求。[R2 官方限制及脚注](https://developers.cloudflare.com/r2/platform/limits/)

超过上限才创建 Multipart，`multipartPartBytes` 默认使用上述精确上限，表示每片的最大目标大小。创建时按最少分片数均衡划分：8,000,000,000 字节的文件分为两片，每片 4,000,000,000 字节，替代原来的 120 个 64 MiB 分片。所有非末片大小相同且至少 5 MiB，最后一片可以更小，总数不超过 10,000。选定的 `partSize` 保存在上传尝试的 DO 状态中，恢复、签名及完成校验均使用同一值，配置调整或 DO 重启不会改变已经开始的 Multipart 边界。[Multipart 官方规则](https://developers.cloudflare.com/r2/objects/upload-objects/#part-size-limits)

Multipart 仍串行浏览器直传，由服务端查询真实 parts 并合并。**签发分片前先增量核对完整源 SHA-256，恢复会话也必须重新确认源文件身份。** `hashChunkBytes` 独立设为 8 MiB；增量哈希和下载流写入的内存块不等于 R2 上传分片，不产生额外上传请求。数 GiB 的分片直接以 `File.slice()` 得到的 Blob 作为请求体，不读成数 GiB 的 ArrayBuffer。

首次升级旧版本已存在的 Multipart 会话时，DO 会将旧配置的分片大小（旧默认 64 MiB）补入持久化状态；这些上传沿原边界完成，新创建的上传使用大分片策略。

请求类预算按 **Workers Free 计划免费额度的 95%** 配置，于 2026-10-12 核对；每日账本在 00:00 UTC 重置，月度账本按 UTC 自然月重置。

| 配置 | 官方免费额度 | 本项目上限 |
| --- | --- | --- |
| `apiRequestsPerDay` | Worker 100,000 请求/日 | 95,000/日 |
| `doRequestsPerDay` | DO 100,000 请求/日 | 95,000/日 |
| `d1RowsReadPerDay` | D1 5,000,000 读取行/日 | 4,750,000/日 |
| `d1RowsWrittenPerDay` | D1 100,000 写入行/日 | 95,000/日 |
| `r2ClassAMonthly` | R2 Standard 1,000,000 次/月 | 950,000/月 |
| `r2ClassBMonthly` | R2 Standard 10,000,000 次/月 | 9,500,000/月 |

依据：[Workers 请求及静态资源](https://developers.cloudflare.com/workers/platform/pricing/)、[DO 请求与 WebSocket 消息](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1 行计量](https://developers.cloudflare.com/d1/platform/pricing/)、[R2 Standard 操作](https://developers.cloudflare.com/r2/pricing/)。免费计划的日额度与付费计划的月度包含量不是同一个口径，当前目标是按免费计划保留 5% 请求余量。

仅 `/api/*` 先运行 Worker；页面、JS、CSS 和 SPA 路由由 Static Assets 直接提供，保留 `_headers` 安全响应头，不消耗 Worker 业务请求计数。WS 控制消息不计入 Worker HTTP 请求；DO 估算将 HTTP / 内部调用与 WS 入站消息按官方 20:1 计费比例合并，并计入尚未完成的 WS 消息预留。管理内部房间查询、Cron 和 Alarm 也计入 DO 请求；D1 使用量来自实际 `rows_read` / `rows_written`。达到阈值后拒绝新业务，已授权管理与清理保留执行入口。

这些是本服务的准入阈值，**不保证任意使用量或账户其他项目下账单为零**。DO 计数是应用侧估算，自动回复、运行时长与 DO 存储行数另有平台计量；本次 95% 限制针对上述请求类预算，不是全账户费用熔断。D1 执行后计量可有一次有界的阈值跨越；R2 直传短 URL 可被重复使用，签发计数不能替代所有实际 S3 请求。拒绝的请求、后台清理、其他服务和已有 TURN allocations 仍可能耗用账户资源。TURN 已签发授权按完整预留量保守结算，不相信客户端报的收费字节；统计与已结算量相加可能重复计量，代价是更早拒绝新授权。

## 文件完整性与恢复

所有传输路径共用一个写入器和增量 SHA-256。协议核对 `fileId`、`transferId`、epoch、顺序偏移和长度，拒绝重复、空洞、越界与迟到消息。写入器关闭成功、全部字节到齐且 SHA-256 一致后才完成。

桌面 Chrome / Edge 优先使用 File System Access API，增量落盘。缺少文件流时只允许默认最多 32 MiB 的有界内存下载，仍输出一个完整文件；显示「已校验，已交给浏览器保存」，不声称已确认操作系统保存完成。更大文件明确提示更换支持流式保存的浏览器。取消或写入失败会 abort；不会输出独立分片文件。

同一页面的 P2P → TURN / WS / HTTPS、后台直连成功后的 TURN / WS / HTTPS / R2 → P2P，均可携带已实际写入的偏移与可信哈希前缀，发送端重新扫描源前缀。切换前先停止旧任务；开始 R2 下载或 R2 网络重试时从头写入并清空旧结果。刷新接收页面后重新下载。DO 重启不持久化 WS 文件数据或 credit，旧窗口被拒绝，重新同步并从可信进度重建；只有有效管理员授权才可回退 R2。单次 PUT 取消后重新上传；Multipart 在受控分片边界暂停，默认宽限 5 分钟且不超过原到期时间。

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

可以先部署，再在 Worker 的「设置 → 变量和机密」中补齐密钥并部署设置变更。缺少 R2 S3 密钥时不会签发上传或下载 URL；本仓库已启用 TURN 开关，补齐四个 TURN 相关变量且统计权限有效后即可签发凭据。后续更新代码使用 `npm run deploy`，新增数据库迁移时先执行 `npm run db:remote`。

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

打开 `http://127.0.0.1:5175` 点击各项测试。当前页面未暴露 WebRTC API 或阻止创建连接时，直连项目会明确 SKIP 并显示环境诊断，不能把 WS 回退成功当作 WebRTC 成功。测试会撤销自己的分享并清除生成的 OPFS 文件。

“WS 大消息与尾片”生成 67,106,729 字节数据，检查实际发送的完整消息大小为 33,553,408、33,553,408、69 字节，并在写入 OPFS 后重新读取、校验 SHA-256。该测试使用默认 WS 分片配置；协议单元测试另行验证 32 MiB 硬上限的包含与越界边界。

“HTTPS 多块”在当前测试页面临时禁用 WebSocket 与 RTCPeerConnection，生成两个默认 16 MiB 块加 17 字节尾片，确认两端控制和文件传输均为 HTTP，再重新读取保存文件核对 SHA-256；测试结束恢复构造器。“HTTPS 零字节”验证空文件。“HTTPS 与 WS 并行”使用同一个分享者的 WS 连接和独立 HTTP 任务，同时保存两个文件并分别重新核对哈希。

本地 Wrangler 不自动运行 Cron。可手动触发：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

预算监控：网页访问 `/admin`；CLI 仍可通过 `GET /api/admin/budget` 与 `Authorization: Bearer <ADMIN_TOKEN>` 查询。网页管理 API 使用 Cookie，包含 `/api/admin/session`、`/login`、`/logout`、`/overview`、`/shares`、`/objects`，公网不能直接调用房间的内部管理路由。返回当日 API/DO/D1、月度 TURN 统计与预留、WS 字节/消息、HTTPS 字节/活跃任务/任务时长、R2 保留字节与操作次数。日志只记录任务标识、字节、消息、时长与失败原因，不打印密钥或文件内容。

## 接口与代码位置

公开查看 `/api/shares/:id`；独立管理权限用于会话、上传与撤销。控制层提供 `/sessions`、`/ws`、`/signals`、`/events?cursor=...`、`/heartbeat`、`/files-status`、`/peers`、`/peer-signals`。下载者通过 `/download-requests` 创建需求；`/download-requests/:requestId/advance` 授权下一阶段，`/upgrade` 只授权双方 ready 的同一后台直连，`/switch` 验证管理员当前指定策略，DELETE 只取消本人任务。TURN 凭证与 WS / HTTPS relay 准入仍由服务端预算判断。

R2 控制接口为 `/files/:fileId/uploads`、`/identity`、`/parts/:part/sign`、`/complete`、`/abort`、`/failure`、`/download`。`/failure` 在未获得上传授权时也能通知等待者，源文件不可读时进入等待恢复。内部初始化和清理路由仅由 Worker 的 DO binding 调用，公网不转发 `/internal/*`。源代码分别在 `src/worker/`、`src/client/`、`src/shared/`、`web/`，SQL 在 `migrations/`。

## 核对的官方资料

实现时于 2026-10-11 核对：[TURN 凭证管理](https://developers.cloudflare.com/realtime/turn/generate-credentials/)、[TURN Analytics](https://developers.cloudflare.com/realtime/turn/analytics/)、[Workers WS API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、[R2 上传限制](https://developers.cloudflare.com/r2/platform/limits/)、[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[aws4fetch 签名示例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)。真实额度、价格和服务行为上线前仍需复核。
