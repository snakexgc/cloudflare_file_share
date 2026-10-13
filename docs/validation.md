# 本地验收记录

日期：2026-10-11。以下记录为首次本地验收，外部服务机密变量尚未配置。

## 自动验证

`npm run check`：前端、后端、共享协议与测试的 TypeScript 检查通过。

`npm test`：52 项测试通过，在 workerd、真实本地 D1、R2 与 Durable Objects 中执行。覆盖有效期、独立权限、等待需求、HTTPS 控制、事件队列/去重/重同步、实际 WS 转发/窗口/任务隔离、重启/迟到帧、完整文件/增量 SHA-256/零字节/写入失败、R2 单 PUT/Multipart/共享上传/迟到写入清理、TURN 原子预留/统计失败拒绝/幂等结算、D1 实际行数记账和预算耗尽后清理。

TURN、Analytics 和 S3 ListParts / ListMultipartUploads 的外部 HTTP 调用使用受控替代；真实 R2 对象的 PUT/HEAD/DELETE 和 DO WebSocket 在本地运行。>5 GiB Multipart 测试使用大小元数据和真实本地 Multipart 创建，不代表已经实传 5 GiB 文件。

`npm run build`：Vite 前端构建与 Wrangler Worker dry-run 打包通过。`npm audit`：0 个已报告漏洞。

## 浏览器验证

Edge 浏览器通过本地验收入口调用生产的控制、发送、接收和写入代码，将生成的数据写入 OPFS，关闭后重新读取：

| 测试 | 保存字节数 | 源文件及保存文件 SHA-256 | 结果 |
| --- | ---: | --- | --- |
| WS 二进制文件 | 2,097,169 | `be619fa5586a0ae58e37b01ea9e88010523fe8100de9f1c996ccadf88957805b` | 相等，通过 |
| WS 零字节文件 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 相等，通过 |

首页在浏览器中正确加载，无桌面横向溢出。浏览器验收页面不进入生产构建。

当前 Edge 环境的 `RTCPeerConnection` 为 undefined，所以真实浏览器 P2P / TURN 数据通道未验证。验收入口明确 SKIP，不能把 WS 回退成功记作 P2P 成功。自动化文件选择也被扩展的文件权限阻止，因此未完成原生文件选择器/操作系统保存对话框验收。没有更改浏览器安全设置。

尝试的 viewport override 没有作用于当前首页，实际测得 1703 像素。因此不声称已完成 390 像素浏览器验收；移动端 CSS 已实现，待支持该尺寸的环境复测。

## 后续真实环境验收

配置 README 中的机密变量后，仍须验证真实 R2 单 PUT/大文件 Multipart、CORS/ETag、Content-Length 签名兼容性、签名到期与在途请求、Lifecycle 和远程 Alarm/Cron；验证 WebRTC 跨 NAT、TURN 统计 schema/额度及撤销对已有 allocation 的影响；验证常用文件格式、移动端和慢网络的大文件内存与落盘。

本地联调真实 R2 时，S3 endpoint 与 `BUCKET` binding 必须指向同一账户和私有桶。在 Wrangler 的 R2 binding 中设置 `remote: true` 才能用远程对象执行 HEAD/Complete/Delete；只填 `.dev.vars` 而保留本地 binding，会把远程 PUT 与本地 HEAD 混用。当前测试和默认配置都使用本地 binding。

## Cloudflare 部署与线上验收

日期：2026-10-11。源码已发布到 [公开 GitHub 仓库](https://github.com/snakexgc/cloudflare_file_share)，应用使用项目内 Wrangler 部署至 [正式地址](https://cloudflare-file-share.9420.workers.dev)。Worker 版本为 `3b0e7c21-eb04-4a5d-b1ff-75dc5c1c3d60`。

创建项目专用 D1 `file-share-db`，已应用 `0001_initial.sql`；创建 Standard 私有 R2 桶 `file-share-temporary`，确认 r2.dev 公共访问关闭。CORS 仅允许正式应用来源，支持 GET、HEAD、PUT 并暴露 ETag；`temporary/` 前缀配置 1 天对象清理和 1 天未完成 Multipart 清理。已部署 `ShareRoom`、`TURNBudget` SQLite Durable Objects，以及每 5 分钟的 Cron。

发布前重新执行：52 项测试、TypeScript 检查、前端构建、Worker dry-run 与依赖审计均通过，审计报告 0 个漏洞。

线上验证使用 Node.js 调用实际 HTTPS / WSS 地址，并复用生产二进制帧协议：

- 首页和前端 JavaScript 正确返回 HTML / JavaScript 类型，安全响应头正常；`/api/config` 正确报告 R2 密钥未配置、TURN 默认关闭。
- 创建 1 小时分享、公开读取文件元数据、创建 owner / receiver 会话、拒绝无管理令牌的 owner 会话，均符合预期。公开元数据不包含管理令牌。
- HTTPS 提交的 WebRTC offer 信令到达指定接收会话；服务端授权 P2P → WS 回退，真实 WSS 接收窗口、ACK 和传输完成状态正常。
- 实传 65,553 字节生成数据，发送与接收 SHA-256 均为 `44b097f701dd722c96d3e5b011742c51cc5b8c9816363f704e186e383af22f71`；第三个接收会话收到 0 个二进制文件帧。
- 有实际 R2 下载需求时，缺少 S3 凭据的上传授权返回 `503 r2_not_configured`。
- 测试分享均已撤销，随后公开访问返回 410；D1 显示撤销分享清理完成，上传记录和清理任务均为 0。撤销元数据按 tombstone 策略暂留。

此次没有配置 Secrets。真实 R2 S3 上传 / 下载、跨网络 WebRTC / TURN，以及远程到期 Alarm / Cron 的时间触发行为，仍需补齐机密变量后联调。线上 WSS 验证不代表这些路径已经验证，也不代表浏览器原生文件保存对话框已验证。

## 分片优化与再次部署

日期：2026-10-11。按 Cloudflare 官方限制调整分片与流控，最终 Worker 版本为 `92c54757-37bf-423d-8050-d4f612e085b0`，已部署到 [share.snakexgc.com](https://share.snakexgc.com) 与原 workers.dev 入口。保留已有域名路由和机密变量，R2 CORS 增加同一应用的 HTTPS 自定义域名来源。

默认 WS 载荷从 256 KiB 提高到 33,553,356 字节，完整消息为 32 MiB 减 1 KiB，52 字节协议头已计入。官方硬上限仍为 32 MiB；1 KiB 是根据当前链路验证保留的工程余量。消息恰好达到 32 MiB 时观察到超时，不将该结果解释为 Cloudflare 官方上限发生变化。

R2 单 PUT 阈值保持 5 GiB 减 5 MiB。Multipart 最大目标大小由 64 MiB 提高至同一精确请求上限，按最少分片数均衡划分，8,000,000,000 字节只需两片；上传创建后持久化固定 partSize，配置变更、恢复和重启不改变它。旧上传状态首次升级仍保留原来的分片边界。哈希缓冲独立为 8 MiB，RTC 保留独立的小消息及窗口。

云端复测还发现 `relay_not_ready`：大消息到达前，DO 普通休眠会丢弃内存中的 credit。活跃中继现在通过 ACK 截止时间定时器保持活动，结束或取消后清理计时器，意外重启仍拒绝旧窗口。客户端以未 ACK 的文件消息判断是否需要 HTTPS 心跳，不把 bufferedAmount 清空当作接收完成。上述生命周期行为依据 [DO 官方说明](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)。

自动验证：66 项测试、TypeScript、前端构建、Worker dry-run 均通过，依赖审计 0 个漏洞。新增覆盖大分片划分、单 PUT 精确边界、旧状态升级、配置变化 / DO 重启后的分片边界、独立哈希缓冲、HTTPS 心跳和活跃中继计时器释放。

| 实传验证 | 文件字节数 | 完整 WS 消息字节数 / 请求方式 | 原文件与保存文件 SHA-256 | 结果 |
| --- | ---: | --- | --- | --- |
| Edge 浏览器，本地 Workers，OPFS 写入后重读 | 67,106,729 | 33,553,408、33,553,408、69 | `25e57bf7dced0e02f1c489d0772e37d38878d7e81d94effb59d45a1a7773d371` | 通过 |
| 生产发送 / 接收代码，真实 Cloudflare WSS，落盘后重读 | 67,106,729 | 33,553,408、33,553,408、69 | `d17ace7fbd918084351b62f886d7898c203108254b83390bbcf3cc6c75ca6902` | 通过 |
| 真实 R2 浏览器直传同路径的 S3 PUT / GET，Node 客户端 | 8,388,625 | 原始 File 单 PUT，直接从 R2 GET，CORS 来源为自定义域名 | `47653399e1e3c0039f7f7ccad7cff5059fefe37c9335d258cce47c6021c0d447` | 通过 |

测试内容均由程序生成，测试分享已撤销；截图和临时验证脚本保留在 Git 忽略目录中。R2 实传证明单 PUT / GET、Content-Length 签名和当前 CORS 可用；数 GiB Multipart 的划分、签名准入与恢复边界已测试，但此次没有实传数 GiB 分片。真实 WebRTC / TURN 和远程到期 Alarm / Cron 的时间触发行为仍待相应验收。

## 2026-10-12 管理台、R2 授权与持续直连

本次新增 `0002_admin.sql`，只增加管理员会话、在线页面记录和文件删除标记；未修改已应用的 `0001_initial.sql`。

自动验证累计 **84 项测试通过**，另通过 TypeScript、前端构建、Worker dry-run 和生产依赖审计（0 个漏洞）。新用例覆盖管理员 Cookie 属性、登录限速/跨站拒绝、退出及密码轮换、伪造权限头无效、匿名无 R2 回退、管理员强制 R2 优先于 P2P、管理台指定与传输中切换、文件删除及迟到 PUT 清理、房间对端/ICE generation 隔离、双方 ready 才能升级、强制模式拒绝升级，以及文件写入/哈希失败终止任务。

客户端接收/发送实现测试分别从 WS、R2 下载中保留 65,536 字节已写入前缀，再复用后台 P2P 通道接收剩余分片。文件为 262,161 字节；保存结果与源内容逐字节一致，完整 SHA-256 一致，旧帧无效且完成后不关闭可复用通道。该项替代的是 RTC 网络通道，实际执行的是 `SendTask`、`ReceiveTask` 和 `VerifiedSink`，不能据此宣称完成跨 NAT 实网验证。

本地实际 HTTP/WS 联调：67,106,729 字节文件通过 `[33553408, 33553408, 69]` 三条消息保存到磁盘并重新读取，SHA-256 为 `d17ace7fbd918084351b62f886d7898c203108254b83390bbcf3cc6c75ca6902`，与源文件一致。测试分享已撤销。

远端应用 `0002_admin.sql`，部署版本为 `5d1c728e-6806-4c18-b605-c8b03cf6f70d`。自定义域名验证通过：匿名配置关闭 R2、管理 overview / objects 与 R2 probe 返回 403、匿名任务不进入 R2、上传和强制 R2 请求被拒绝、WS 探测回显正常。生产 WSS 同一 67,106,729 字节文件再次保存并重读，帧大小和 SHA-256 与上述本地结果一致。两项线上验证只使用程序生成的测试分享，均已撤销；未删除用户分享或对象。

浏览器检查已验证 `/admin` 登录、额度条形图、文件列表区域和在线页面统计。后续文件选择器与逐项视觉检查被 Edge 扩展界面暂停；当前浏览器环境未提供 WebRTC，因此未完成真实 IPv4/IPv6 跨 NAT 打洞、TURN 或跨 NAT 传输中热切换验证。页面会如实报告未提供 WebRTC，不伪造 NAT 类型或直连成功。标准能力边界及所依据官方文档见 README。

## 2026-10-12 检测结果分层与 TURN 实网验证

线上初始配置为 `turnConfigured: true`、`turnEnabled: false`：四个 TURN 变量已配置，部署开关仍关闭。部署配置与示例现已显式启用 TURN，保留账户统计、并发、流量与短期凭证预算限制。

检测区现在区分服务端配置、凭据签发、浏览器 API 可创建性、ICE 候选和实际对端连通。缺少核心 API 仅报告「当前页面无法测试」，不推断浏览器产品不支持 WebRTC 或 NAT 不可打洞；缺失变量显示准确名称。快速复测复用仍有效的短期探测凭据，限速显示暂缓。自动验证累计 **93 项测试通过**，覆盖 API 未暴露/创建被阻止、TURN 已配置但关闭、服务签发成功但浏览器受限、候选不等于直连、无 ICE / relay 候选、复测缓存、限速与 CF_ACCOUNT_ID 配置检查。

真实 Cloudflare TURN 验证使用现有密钥与统计令牌，只取得 60 秒探测凭据，不读取或打印长期密钥：统计预算准入与凭据签发通过；TLS-over-TCP IPv4 和 UDP IPv4 均完成认证 Allocate、双方 CreatePermission、两个真实 allocation 之间双向 Send / Data Indication，生成的 41 字节内容收发一致（每种接入方式双向共 82 字节）。测试结束 Refresh lifetime=0 释放 allocation 并关闭连接。IPv6 接入因本机系统解析 `ENOENT` 未完成，不能宣称 IPv6 实传通过。

线上 Edge 页面实际显示安全上下文为「是」，`RTCPeerConnection: undefined`、`RTCSessionDescription: undefined`、`RTCIceCandidate: function`。说明当前页面的核心接口未暴露，不能完成浏览器 P2P 或 TURN DataChannel 测试；具体是哪项设置或扩展造成尚未定位。未改变浏览器隐私配置。TURN 服务验证已与这个客户端限制分开显示。

最终部署版本 `e10d2949-6f09-45f8-817c-22a4a5f8db7d`。线上配置确认 `turnEnabled: true`、`turnConfigured: true`、`turnMissing: []`；匿名 R2 仍关闭，管理接口隔离和 WS 回显复测通过。构建与 TypeScript 检查通过。

## 2026-10-12 WS 用量统计与免费请求 95% 预算

移除 WS 月流量和自设月消息数限制，保留已转发流量统计；后台将已结算值与活跃房间的已转发值合并，并按最新预留 ID 过滤，避免结算并发导致重复计数。WS 消息按 20:1 合并进 DO 请求估算，不再误计为 Worker HTTP 请求。管理内部调用、Cron 与 Alarm 计入 DO 请求；静态页面改由 Assets 直接服务，验证首页、`/admin` 和 SPA 路由均保留 CSP / nosniff 响应头。

请求阈值：Worker / DO 各 95,000 次/日，D1 读取 4,750,000 行/日、写入 95,000 行/日，R2 Class A 950,000 次/月、Class B 9,500,000 次/月。TURN 为十进制 950 GB/月，移除重复安全量，其他服务预留默认 0。来源、周期、计量口径与账本边界已写入 README。

累计 **104 项测试通过**，新增覆盖累计 WS 字节超原上限仍准入、移除月消息数限制、20:1 请求换算、请求/操作阈值边界、拒绝调用记账、维护入口、TURN 950 GB 精确边界、UTC 日重置与活跃 WS 真实字节统计。TypeScript、构建、Worker dry-run、生产依赖审计（0 漏洞）通过。

本地实际 WS 67,106,729 字节经三条 `[33553408, 33553408, 69]` 消息保存并重读，SHA-256 `d17ace7fbd918084351b62f886d7898c203108254b83390bbcf3cc6c75ca6902` 与源内容一致；测试分享已撤销。浏览器管理台确认「WS 无流量上限」、TURN 显示「950 GB」及六项 95% 请求预算。

部署版本 `9c69e68d-53bf-4ebe-9da9-547fbd1bde93`。线上配置确认 WS 两个旧月限额字段不存在，TURN `950000000000` 字节、其他服务预留 0，六项请求类阈值与上述一致。首页、管理页和 SPA 静态响应均有 CSP，匿名 R2 / 管理接口隔离与 WS 回显通过。生产 WSS 同一 67,106,729 字节文件再次落盘重读通过，帧大小与 SHA-256 一致；两项线上测试仅使用生成内容，分享均已撤销。

## 2026-10-12 独立 HTTPS 分块中继

新增 `https` 模式，自动路径为 P2P → TURN → WS → HTTPS → 获授权的 R2。默认块大小 16 MiB、完整文件上限 10 GiB；POST 二进制上传、GET 完整块、写入后 POST ACK，上传请求等待 ACK。文件数据和 HTTPS 任务的控制均通过 HTTP。共享房间缓冲、同实例 HTTPS 缓冲保护、权限与偏移校验、幂等请求、有限重试、DO 重启续传、模式切换以及取消 / 到期释放已实现。

最终 `npm test`：**129 项测试通过**（8 个测试文件）。覆盖 HTTP 多块与尾片、错误角色 / 令牌 / epoch / 偏移 / 长度、重复 POST / GET / ACK、ACK 前禁止下一块、慢上传期间心跳和取消、25 秒无块响应、5 分钟截止时间、DO 实际重启后恢复、全局与房间并发预算、零字节、GET 中断、ACK 响应丢失、写入失败、哈希不匹配、事件重同步、HTTPS → 热 P2P 切换及自动 WS → HTTPS 回退。测试使用真实本地 workerd / D1 / DO；外部服务仍由受控替代隔离。

最终 `npm run build` 通过，包括 TypeScript 检查、Vite 前端构建、Wrangler `deploy --dry-run`。`git diff --check` 通过。无需新增 D1 迁移、DO binding 或 R2 CORS 配置。

Edge 浏览器通过本地 Wrangler 与验收页面调用生产客户端代码，使用默认分片配置写入 OPFS，关闭后重新读取：

| 测试 | 每个保存文件字节数 | 源文件及保存文件 SHA-256 | 结果 |
| --- | ---: | --- | --- |
| HTTPS，多块与 17 字节尾片，临时禁用 WebSocket / RTCPeerConnection | 33,554,449 | `d8cd1e9d5fc0cceff21d96962ec12cd3330987580be884c2ba0e6b94abf5a3ad` | 两端 HTTP 控制、实际 HTTPS 数据，校验通过 |
| HTTPS，零字节，临时禁用 WebSocket / RTCPeerConnection | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 校验通过 |
| 同一分享者同时传 HTTPS 与 WS，两个独立目标文件 | 33,554,449 | `d8cd1e9d5fc0cceff21d96962ec12cd3330987580be884c2ba0e6b94abf5a3ad` | 确认活跃任务重叠，两份文件均校验通过 |

测试结束恢复页面构造器，并执行测试分享撤销与 OPFS 文件清理。并行验收补齐了事件序号跨越后的任务重同步处理；运行中 HTTP 任务不会阻断另一个文件的 WS 数据连接。

管理统计计入实际 GET 转发字节（包含重读），取消与结算保持幂等；HTTPS 请求按普通 HTTP / DO 请求计量。累计任务活跃时长把并行任务相加，因此不是 Cloudflare 账单的房间时长。DO 重启可能丢失尚未持久化的在途字节统计，账本仍为应用侧估算。

上述为部署前本地验证，线上结果见下节。未实传 10 GiB 文件、未触达云端 100 MB 请求体限制，也未测量 128 MB 内存 / CPU / DO 实际时长、跨网络慢链路或浏览器原生保存对话框；HTTPS → P2P 的覆盖为自动测试，不能视为真实跨 NAT 热切换验收。

## 2026-10-12 HTTPS 中继上传与部署

源码提交 `cfd4823c4b68444f962212cb696760389b6886f5` 已推送至 GitHub `main`。通过 `npm run deploy` 完成 TypeScript 检查、前端构建、静态资源上传和 Worker 发布，版本为 `d58aa29b-b484-4083-b68b-5621d369547c`，继续使用既有 D1 / R2 / SQLite DO binding 与每 5 分钟 Cron。

[正式域名](https://share.snakexgc.com) 与 [workers.dev 入口](https://cloudflare-file-share.9420.workers.dev) 均验证首页、最新 JavaScript 静态资源和 CSP 响应正常。`/api/config` 确认 HTTPS 已启用、块大小 `16777216`、完整文件上限 `10737418240`，匿名 R2 仍关闭；HTTPS 探测回显成功，匿名管理 overview 返回 403，原有 WSS 小消息回显复测成功。

通过正式域名使用 Node.js Fetch 与真实云端 API / DO 验证：创建仅声明 `https=true`、`ws=false`、`webrtc=false` 的 owner / receiver 会话，自动授权 `https` 任务。实传 **33,554,449 字节**，实际块大小为 `[16777216, 16777216, 17]`。每个上传 POST 均在目标文件写入并 POST ACK 后才返回新的偏移；整份文件写入同一个本地目标，关闭后重新读取，SHA-256 为 `d8cd1e9d5fc0cceff21d96962ec12cd3330987580be884c2ba0e6b94abf5a3ad`，与源内容完全一致。服务端任务确认为 completed，整个文件传输没有建立 WebSocket。

该文件传输只使用程序生成的测试内容，分享 `c602861d84524874a4f8d39f0cbde22c` 已撤销，随后读取返回 410，清理状态为 cleaned。没有上传用户文件，也没有创建 R2 文件对象。此次是 Node.js 的真实云端传输验收；浏览器 OPFS 与 HTTPS / WS 并行的证据仍为上一节本地验收，不混作线上浏览器或云端并行测试。

## 2026-10-12 速度、传输方式、管理标签与分享访问设置

分享页每个文件独立显示当前传输方式和每秒更新的速度，使用约 3 秒滑动窗口；同文件多个发送任务的速度相加，结束后归零。HTTPS 上传通过普通 HTTP XHR 的上传进度统计，仍等待写入后的 ACK；下载使用响应流实际读取字节。WS / RTC 发送端扣除客户端待发送队列，数值是客户端估算，不是网络层测速。R2 续传的已有分片不计为本次新上传速度。

管理台分为用量总览、任务管理、在线页面和 R2 对象四个标签，支持键盘切换。任务管理支持勾选和全选已加载项目，批量撤销分享、删除文件、指定文件传输方式及取消传输；每批最多 50 项，逐项反馈成功或失败，服务端保留管理员权限校验和幂等取消。

创建分享时可设置 3–32 位短链接和 4–64 字符提取密码，两者均不支持创建后修改。新增 `0003_share_access.sql`，为短链接增加唯一索引。密码只以随机盐 PBKDF2-SHA-256 派生值保存在房间中；未解锁者不能读取文件元数据或创建接收会话。解锁使用 HttpOnly / SameSite Cookie，并按来源和分享限制为 15 分钟 5 次请求（包括成功请求）。撤销清理会移除密码派生值和访问授权。

最终自动验证：**160 项测试通过，11 个测试文件**；TypeScript、Vite 前端构建、Wrangler dry-run 和 `git diff --check` 均通过。新增覆盖短链接校验、并发重名与补偿清理、密码权限隔离、盐值与明文排除、访问授权持久化/到期/撤销、解锁限流、批量操作逐项失败/权限/参数/幂等取消、速度窗口与重试归零，以及上传进度先于 ACK 响应返回。

Edge 实际页面验证错误提取密码不显示文件、正确密码进入分享，四个管理标签可切换，两份生成的测试文件批量切换 HTTPS 返回成功 2 项、失败 0 项。通过生产 `SendTask` / `ReceiveTask` 和速度计量代码，在禁用 WS / RTC 的页面传输 **33,554,449 字节**，取得非零速度样本；OPFS 写入后重读 SHA-256 为 `d8cd1e9d5fc0cceff21d96962ec12cd3330987580be884c2ba0e6b94abf5a3ad`，与源内容一致。本地样本峰值 45.36 MiB/s 不代表公网性能。批量取消活跃任务由真实本地 workerd 自动测试覆盖；页面验收中的任务已先因接收者离线取消，不将该页面操作记作活跃任务取消证据。

浏览器原生文件选择仍受 Edge 扩展文件 URL 权限阻止，因此使用程序生成文件和真实创建 API 验证；没有更改浏览器安全设置，未将该限制记作原生选择器验收通过。截图保存在 Git 忽略的 `docs/screenshots/admin-tabs-2026-10-12.png`。本次创建的两份页面测试分享以及速度测试分享均已撤销，OPFS 测试文件已清理，本地管理员会话已退出。

源码提交 `6d17fdf` 已推送至 GitHub `main`；远端 D1 已成功应用 `0003_share_access.sql`。`npm run deploy` 再次通过类型检查和前端构建，发布 Worker 版本 `5eaf9d8c-5539-4be2-a14b-30a06df64390`。正式域名与 workers.dev 均返回新静态资源 `index-Ckwoylze.js`，包含新增功能和原有 CSP；正式页面已确认创建时的短链接/密码输入与不可修改提示。

正式域名创建受密码保护的短链接分享：ID 与短链接两种访问均在未解锁时拒绝文件元数据和下载会话（401）；重名返回 409；错误密码返回 403，正确密码签发 Secure / HttpOnly / SameSite 授权 Cookie，解锁后可读取元数据。匿名批量管理接口返回 403。随后通过该短链接进行纯 HTTP 控制和 HTTPS 传输，三块 `[16777216, 16777216, 17]` 共 **33,554,449 字节**，每块写入后 ACK，文件关闭并重新读取的 SHA-256 与源一致（`d8cd1e9d5fc0cceff21d96962ec12cd3330987580be884c2ba0e6b94abf5a3ad`），服务端确认为 completed，全程无 WebSocket。测试分享 `cdf2778a535746588bf84c769dc99b56` 已撤销且 cleaned，随后读取 410；只传输程序生成内容，未操作用户分享或 R2 对象。

线上浏览器管理页确认四个标签及服务统计加载正常，截图保存为 `docs/screenshots/admin-tabs-live-2026-10-12.png`（Git 忽略）。线上批量修改用户对象没有执行；批量功能证据为本地页面及本地 workerd 测试。

## 2026-10-12 输入焦点、折叠检测与源端不活跃清理

短链接输入框原来的内层 focus outline 被外层 `overflow:hidden` 裁切，显示为左侧蓝条。现在由整个组合输入框显示边框和轻微阴影，保留键盘焦点提示；公开分享链接采用相同方式。检测区移至创建卡片 / 分享文件卡片正下方，使用原生 details / summary，首次默认折叠，展开可查看检测和复测，页面重挂载时保留已有展开状态。

新增 `defaultShareHours=2` 与 `ownerIdleTimeoutMs=1800000` 默认值，配置示例与界面文案同步。创建 API 不传 `expiresInHours` 时也默认 2 小时，显式有效期仍验证 1–24 小时。房间持久化最后有效源端活动时间，综合各 owner 会话和休眠 WS 的自动心跳时间；接收者和匿名访问不延长它。源端连续 30 分钟不活跃时优先结束分享、取消任务、释放缓冲并清理云端对象。原到期时间保持不变，重连不能复活已结束分享；已就绪 R2 文件同样受该规则约束，迟到 PUT 继续按原补偿清理机制复核。无新 D1 迁移、binding 或 CORS 变更。

完整回归 **170 项测试通过，12 个测试文件**。新增 10 项覆盖默认有效期和 Alarm、30 分钟边界、接收者隔离、有效源端活动续期且不越过原到期时间、多源端/会话剪除/DO 重启、伪造令牌、旧状态升级、休眠 WS 自动心跳时间、HTTPS 未确认块与上传等待者释放，以及 ready R2 对象删除与迟到 PUT 清理。时间边界测试使用受控 Date；休眠 WS 自动心跳的独立运行时时钟使用受控时间戳，不将其记作跨网络 30 分钟在线验收。类型检查、前端构建、Wrangler dry-run 均通过。

Edge 浏览器确认默认输入为 2、短链接焦点无内层 outline 且由完整容器高亮、检测面板首次为 collapsed 并位于文件卡片之后；展开后能查看实际检测结果，分享文件页同样默认折叠。截图 `docs/screenshots/share-layout-local-2026-10-12.png` 保留在 Git 忽略目录，页面测试分享 `a5dcbb51c6d8429ca80acf5d1094bacb` 已撤销。

另建独立本地 Wrangler 状态目录，仅在该测试配置中把不活跃时限缩为 **5 秒**。创建 2 小时有效期的零字节测试分享后，8 秒内不再向房间发送任何请求；先直接查询本地 D1，记录已为 `expired / cleaned` 且剩余文件行数为 0，随后 HTTP 返回 410 与 `owner_inactive`。证明真实本地 Alarm 自动执行清理，不依赖访问触发，也未手动调用 Alarm。该加速测试不会修改正式站点的 30 分钟设置；未进行云端实际等待 30 分钟的时长验收。

提交 `610e412` 已上传至 GitHub `main`，Worker 发布版本为 `ee8af2d6-a4f7-4ebc-ac99-e8bb0acc7fb4`。正式域名与 workers.dev 的 `/api/config` 均确认 `defaultShareHours:2`、`ownerIdleTimeoutMs:1800000`，静态资源为 `index-BlBSDQbB.js`。线上浏览器确认输入为 2、检测区收起且位于文件卡片下方、短链接内层 outline 为 none 并由外框提供焦点提示；完整截图保存为 `docs/screenshots/share-layout-live-2026-10-12.png`（Git 忽略）。

线上创建 API 省略有效期，确认原期限为 2 小时；带密码短链接的权限隔离、冲突和解锁复测通过。纯 HTTP 控制 / HTTPS 数据传输 **65,553 字节**，保存后重新读取 SHA-256 为 `ca32f06a037dd7b4fe417817d1d76fff8f18120fcdd0c6d4977a2d091f16e866`，与源一致，服务端 completed，全程无 WS。测试分享 `8ac6963e18954546b3ec1eb0675ce36b` 已撤销、cleaned，随后读取 410；本地开发服务已停止，未操作用户分享或云端对象。

## 2026-10-13 页面排版与内网直传（本地）

参考 [文件快传](https://transfer.52python.cn/?type=webrtc&mode=send) 的系统字体、36px 标题、16px 正文、14px 按钮以及居中卡片布局，重整首页、发送页、接收页和管理台样式。首页提供自动传输与内网直传，短链接和提取密码默认折叠；连接检测仍在文件卡片下方收起。390px 与 1280px 的真实页面视口检查未发现横向溢出，手机模式纵向排列传输选项。截图保存于 Git 忽略的 `docs/screenshots/home-mobile.jpg` 与 `home-desktop.jpg`。

新增 `lan` 传输模式及分享策略 `transferMode: "lan"`。客户端使用空 ICE 服务器列表，双方和服务端共同过滤内嵌 SDP 与 trickle ICE，仅允许私网 / 本地 IPv6 / mDNS host 候选。房间策略持久化，不创建公网 P2P 预热通道；LAN 失败结束任务，不签发 TURN、不启用 WS / HTTPS / R2 回退。自动分享可由匿名接收者选择内网、从内网切回自动并保留已写入偏移，其他强制方式仍检查管理员授权。无新增 D1 迁移或 limits 字段。

完整回归 **203 项测试通过，14 个测试文件**，包括 LAN 候选边界、DO 重启后策略保持、匿名权限、无 WebRTC、失败停止、内嵌和 trickle 候选过滤、双方 RTC 配置与描述 / ICE 顺序。客户端单元用例替代了 RTC 网络；真实浏览器验收另行执行。TypeScript、Vite 生产构建和 Wrangler deploy dry-run 均通过。

当前 Edge 的 WebRTC API 可用。真实本地 Workers / DO 与浏览器同机双会话分别通过 **WS 信令 + LAN 数据** 和 **HTTPS 信令 + LAN 数据**；两次均传输 **2,097,169 字节**，传输期间 getStats 确认选中 `host → host` 候选对，ICE 服务器列表为空。保存 OPFS 文件后重新读取，字节数与 SHA-256 均与源一致：`be619fa5586a0ae58e37b01ea9e88010523fe8100de9f1c996ccadf88957805b`。验收代码先读取活动连接统计，再等待关闭，避免从已关闭 PC 的空统计误报失败。

以上是本地同机验证，未部署新版本，未完成两台设备间的真实 Wi-Fi / 路由器隔离 / 跨子网验收。内网模式仍需联网打开页面与交换信令。原生文件选择器的自动化 setFiles 被当前 Edge 扩展的文件 URL 权限阻止；未改变扩展或浏览器安全设置，原生文件选择及系统保存对话框未作为本轮通过项。

## 2026-10-14 GitHub 与 Cloudflare 发布

功能提交 `45def52823e470afa16598ab9f39c915c1fb21d9` 已推送至 GitHub `main`。发布前完整回归 **203 项测试通过，14 个测试文件**；TypeScript、Vite 构建、Wrangler dry-run 通过。无新 D1 迁移。Cloudflare Worker 发布版本为 `18f02fff-b29c-4c5e-a68d-dc16e348ff74`。

正式域名 `https://share.snakexgc.com` 与 workers.dev 入口 `https://cloudflare-file-share.9420.workers.dev` 均返回最新页面，引用 `index-Dm2GW3uP.js` 和 `index-a0NdBGWF.css`；两个入口下载的 JS / CSS 内容 SHA-256 均与本地生产构建一致，页面保留禁止嵌入策略。公开配置确认默认 2 小时、源端不活跃时限 30 分钟。

两个入口分别使用独立的匿名测试分享验证线上 API：创建与读取保持 `transferMode: "lan"`，下载任务为 `lan / connecting`、无 ICE 服务器、无公网预热 peer；接受本地 mDNS host 候选，拒绝 relay 候选；报告连接失败后任务保持 LAN 并结束，无中继回退。测试分享均已撤销，随后读取返回 410。本次线上验证为 API 策略与静态资源验证，不包含实际文件数据传输；浏览器同机实传证据见上节，跨设备 Wi-Fi 验收仍未进行。
