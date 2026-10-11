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
