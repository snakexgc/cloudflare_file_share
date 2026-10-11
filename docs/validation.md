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
