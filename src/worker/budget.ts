import { DurableObject } from 'cloudflare:workers';
import { limits, type Env } from './config';
import { assert, errorResponse, HttpError, json, readJson } from './util';

interface Reservation {
  kind: 'turn' | 'ws' | 'https' | 'r2' | 'share';
  bytes: number;
  messages: number;
  expiresAt: number;
  source?: string;
  ready?: boolean;
  roomId?: string;
}
interface Ledger {
  month: string;
  day: string;
  requests: number;
  doRequests: number;
  doWsMessages: number;
  d1Read: number;
  d1Written: number;
  turnCommitted: number;
  wsCommitted: number;
  wsMessages: number;
  httpsCommitted: number;
  httpsActiveMs: number;
  classA: number;
  classB: number;
  turnSnapshot?: { bytes: number; at: number };
  reservations: Record<string, Reservation>;
  rates: Record<string, { count: number; resetAt: number }>;
}
export class TURNBudget extends DurableObject<Env> {
  private ledger!: Ledger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ledger = await ctx.storage.get<Ledger>('ledger') ?? {
        month: '', day: '', requests: 0, doRequests: 0, doWsMessages: 0, d1Read: 0, d1Written: 0, turnCommitted: 0, wsCommitted: 0, wsMessages: 0, httpsCommitted: 0, httpsActiveMs: 0, classA: 0, classB: 0, reservations: {}, rates: {},
      };
      this.ledger.doRequests ??= 0; this.ledger.doWsMessages ??= 0; this.ledger.d1Read ??= 0; this.ledger.d1Written ??= 0;
      this.ledger.httpsCommitted ??= 0; this.ledger.httpsActiveMs ??= 0;
    });
  }
  private roll(now: number) {
    const day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
    if (this.ledger.month !== month) {
      Object.assign(this.ledger, { month, turnCommitted: 0, wsCommitted: 0, wsMessages: 0, httpsCommitted: 0, httpsActiveMs: 0, classA: 0, classB: 0, turnSnapshot: undefined });
    }
    if (this.ledger.day !== day) { this.ledger.day = day; this.ledger.requests = 0; this.ledger.doRequests = 0; this.ledger.doWsMessages = 0; this.ledger.d1Read = 0; this.ledger.d1Written = 0; }
    for (const [key, rate] of Object.entries(this.ledger.rates)) if (rate.resetAt <= now) delete this.ledger.rates[key];
    for (const [key, reservation] of Object.entries(this.ledger.reservations)) {
      // R2 和分享只在物理清理确认后释放；不能因时钟到期而提前释放存储预算。
      if (reservation.expiresAt <= now && (reservation.kind === 'turn' || reservation.kind === 'ws')) {
        this.commit(reservation, reservation.bytes, reservation.messages);
        delete this.ledger.reservations[key];
      }
    }
  }
  private rate(key: string, maximum: number, now: number) {
    assert(Object.keys(this.ledger.rates).length < 5000 || this.ledger.rates[key], 429, 'rate_capacity', '当前访问过多，请稍后重试');
    const entry = this.ledger.rates[key] ??= { count: 0, resetAt: now + 60000 };
    assert(entry.count < maximum, 429, 'rate_limit', '请求过于频繁，请稍后重试');
    entry.count++;
  }
  private sum(kind: Reservation['kind']) { return Object.values(this.ledger.reservations).filter(x => x.kind === kind).reduce((n, x) => n + x.bytes, 0); }
  private count(kind: Reservation['kind']) { return Object.values(this.ledger.reservations).filter(x => x.kind === kind).length; }
  private doUsage(pending = 0) { return this.ledger.doRequests + Math.ceil((this.ledger.doWsMessages + pending) / 20); }
  private commit(reservation: Reservation, bytes: number, messages: number) {
    if (reservation.kind === 'turn') this.ledger.turnCommitted += reservation.bytes;
    if (reservation.kind === 'ws') { const incoming = Math.min(reservation.messages, messages); this.ledger.wsCommitted += Math.min(reservation.bytes, bytes); this.ledger.wsMessages += incoming; this.ledger.doWsMessages += incoming; }
  }
  private async syncTurn(now: number) {
    const conf = limits(this.env);
    if (this.ledger.turnSnapshot && now - this.ledger.turnSnapshot.at < conf.turnStatsMaxAgeMs) return;
    assert(this.env.CF_ACCOUNT_ID && this.env.CF_ANALYTICS_API_TOKEN, 503, 'turn_stats_unavailable', 'TURN 使用量统计尚未配置');
    const query = `query($account: String!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $account }) { callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) { sum { egressBytes } } } } }`;
    let response: Response;
    try {
      response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', headers: { Authorization: `Bearer ${this.env.CF_ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { account: this.env.CF_ACCOUNT_ID, from: `${this.ledger.month}-01`, to: this.ledger.day } }), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new HttpError(503, 'turn_stats_unavailable', 'TURN 统计查询失败，暂停新的授权'); }
    assert(response.ok, 503, 'turn_stats_unavailable', 'TURN 统计查询失败，暂停新的授权');
    const data = await response.json() as { errors?: unknown[]; data?: { viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number } }[] }[] } } };
    const groups = data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
    assert(!data.errors?.length && groups && groups.every(g => Number.isSafeInteger(g.sum?.egressBytes) && g.sum!.egressBytes! >= 0), 503, 'turn_stats_unavailable', 'TURN 统计数据无效，暂停新的授权');
    const measured = groups.reduce((n, x) => n + x.sum!.egressBytes!, 0);
    this.ledger.turnSnapshot = { bytes: Math.max(measured, this.ledger.turnSnapshot?.bytes ?? 0), at: now };
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const data = await readJson(request), path = new URL(request.url).pathname, now = Date.now(), conf = limits(this.env);
        this.roll(now);
        this.ledger.doRequests++;
        if (path === '/charge') {
          const source = String(data.source ?? 'internal');
          const relayMessages = Object.values(this.ledger.reservations).filter(x => x.kind === 'ws').reduce((n, x) => n + x.messages, 0);
          if (data.websocket === true) { this.ledger.doWsMessages++; this.ledger.wsMessages++; }
          else { this.ledger.requests++; if (data.room === true) this.ledger.doRequests++; }
          if (data.cleanup === true) this.rate(`cleanup:${source}`, 30, now);
          else {
            assert(data.websocket === true || this.ledger.requests <= conf.apiRequestsPerDay, 429, 'api_budget', '今日请求预算已用完');
            assert(this.doUsage(relayMessages) <= conf.doRequestsPerDay && this.ledger.d1Read < conf.d1RowsReadPerDay && this.ledger.d1Written < conf.d1RowsWrittenPerDay, 429, 'database_request_budget', '今日 DO 或 D1 请求预算已用完');
            this.rate(`api:${source}`, conf.apiRequestsPerMinute, now);
          }
          if (data.create === true) this.rate(`create:${source}`, conf.createsPerMinute, now);
        } else if (path === '/turn-probe') {
          this.rate(`turn-probe:${String(data.source)}`, 1, now);
          this.rate('turn-probe:global', 60, now);
        } else if (path === '/admin-login') {
          for (const key of [`admin:${String(data.source)}`, 'admin:global']) {
            const maximum = key === 'admin:global' ? 60 : 5;
            const rate = this.ledger.rates[key];
            if (!rate || rate.resetAt <= now) this.ledger.rates[key] = { count: 1, resetAt: now + 900000 };
            else { assert(rate.count < maximum, 429, 'login_rate', '登录尝试过多，请 15 分钟后重试'); rate.count++; }
          }
        } else if (path === '/share-unlock') {
          const key = `share-unlock:${String(data.shareId)}:${String(data.source)}`, entry = this.ledger.rates[key];
          assert(Object.keys(this.ledger.rates).length < 5000 || entry, 429, 'rate_capacity', '当前访问过多');
          if (!entry || entry.resetAt <= now) this.ledger.rates[key] = { count: 1, resetAt: now + 900000 };
          else { assert(entry.count < 5, 429, 'share_password_rate', '提取密码尝试过多，请 15 分钟后重试'); entry.count++; }
        } else if (path === '/d1-used') {
          const read = Number(data.read), written = Number(data.written);
          assert(Number.isSafeInteger(read) && read >= 0 && Number.isSafeInteger(written) && written >= 0, 400, 'invalid_usage', 'D1 使用量无效');
          this.ledger.d1Read += read; this.ledger.d1Written += written;
        } else if (path === '/do-used') {
          const count = data.count;
          assert(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0, 400, 'invalid_usage', 'DO 请求数量无效');
          this.ledger.doRequests += count;
        } else if (path === '/r2-ready') {
          const reservation = this.ledger.reservations[String(data.id)];
          if (reservation?.kind === 'r2') reservation.ready = true;
        } else if (path === '/r2-operation') {
          const kind = data.kind === 'A' ? 'classA' : 'classB';
          const count = data.count ?? 1;
          assert(typeof count === 'number' && Number.isSafeInteger(count) && count > 0, 400, 'invalid_count', '操作数量无效');
          assert(data.cleanup === true || this.ledger[kind] + count <= (kind === 'classA' ? conf.r2ClassAMonthly : conf.r2ClassBMonthly), 429, 'r2_operation_budget', 'R2 操作预算已用完');
          this.ledger[kind] += count;
        } else if (path === '/reserve') {
          const key = String(data.id), kind = data.kind as Reservation['kind'], bytes = data.bytes, expiresAt = data.expiresAt;
          assert(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 && typeof expiresAt === 'number' && expiresAt > now, 400, 'invalid_reservation', '预算参数无效');
          assert(['turn', 'ws', 'https', 'r2', 'share'].includes(kind), 400, 'invalid_reservation', '未知资源类型');
          const existing = this.ledger.reservations[key];
          if (existing) {
            assert(existing.kind === kind && existing.bytes === bytes, 409, 'reservation_conflict', '重复预留参数不一致');
          } else {
            if (kind === 'turn') {
              assert(conf.turnEnabled, 409, 'turn_disabled', 'TURN 未启用');
              await this.syncTurn(now);
              assert(this.count('turn') < conf.turnMaxConcurrent && this.ledger.turnSnapshot!.bytes + this.ledger.turnCommitted + this.sum('turn') + bytes + conf.turnExternalReserveBytes <= conf.turnMonthlyBytes, 429, 'turn_budget', 'TURN 免费预算或并发额度不足');
            }
            if (kind === 'ws') {
              const messages = Number(data.messages);
              assert(Number.isSafeInteger(messages) && messages > 0, 400, 'invalid_reservation', '消息预算无效');
              const pending = Object.values(this.ledger.reservations).filter(x => x.kind === 'ws').reduce((n, x) => n + x.messages, 0);
              assert(conf.wsEnabled && this.count('ws') < conf.wsMaxConcurrent && this.doUsage(pending + messages) <= conf.doRequestsPerDay, 429, 'ws_budget', 'WS 中继请求预算或并发额度不足');
            }
            if (kind === 'r2') assert(conf.r2Enabled && Object.values(this.ledger.reservations).filter(x => x.kind === 'r2' && !x.ready).length < conf.r2MaxUploads && this.sum('r2') + bytes <= conf.r2MaxBytes, 429, 'r2_budget', 'R2 存储预算或上传额度不足');
            if (kind === 'https') assert(conf.httpsEnabled && this.count('https') < conf.httpsMaxConcurrent && this.ledger.requests < conf.apiRequestsPerDay && this.doUsage() <= conf.doRequestsPerDay, 429, 'https_budget', 'HTTPS 中继请求预算或并发额度不足');
            if (kind === 'share') assert(Object.values(this.ledger.reservations).filter(x => x.kind === 'share' && x.source === data.source).length < conf.maxSharesPerSource, 429, 'share_limit', '此来源的活动分享数量已达上限');
            this.ledger.reservations[key] = { kind, bytes, messages: Number(data.messages ?? 0), expiresAt, source: typeof data.source === 'string' ? data.source : undefined, roomId: typeof data.roomId === 'string' && /^[a-f0-9]{32}$/.test(data.roomId) ? data.roomId : undefined };
          }
        } else if (path === '/settle' || path === '/release') {
          const key = String(data.id), reservation = this.ledger.reservations[key];
          if (reservation) {
            if (path === '/settle') {
              if (reservation.kind === 'https') {
                const bytes = data.bytes ?? 0, activeMs = data.activeMs ?? 0;
                assert(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 && typeof activeMs === 'number' && Number.isSafeInteger(activeMs) && activeMs >= 0, 400, 'invalid_usage', 'HTTPS 用量无效');
                this.ledger.httpsCommitted += bytes; this.ledger.httpsActiveMs += activeMs;
              } else this.commit(reservation, Number(data.bytes ?? reservation.bytes), Number(data.messages ?? reservation.messages));
            }
            delete this.ledger.reservations[key];
          }
        } else if (path !== '/snapshot') throw new HttpError(404, 'not_found', '资源接口不存在');
        await this.ctx.storage.put('ledger', this.ledger);
        return json(path === '/snapshot' ? {
          month: this.ledger.month, day: this.ledger.day, apiRequests: this.ledger.requests,
          doRequests: this.doUsage(), doHttpRequests: this.ledger.doRequests, doWsMessages: this.ledger.doWsMessages, d1RowsRead: this.ledger.d1Read, d1RowsWritten: this.ledger.d1Written,
          turnMeasured: this.ledger.turnSnapshot, turnCommitted: this.ledger.turnCommitted, turnReserved: this.sum('turn'),
          wsBytes: this.ledger.wsCommitted, wsReserved: this.sum('ws'), wsMessages: this.ledger.wsMessages,
          wsRoomIds: [...new Set(Object.values(this.ledger.reservations).filter(x => x.kind === 'ws' && x.roomId).map(x => x.roomId))],
          wsTransfers: Object.entries(this.ledger.reservations).filter(([, value]) => value.kind === 'ws').map(([id, value]) => ({ id, roomId: value.roomId })),
          httpsBytes: this.ledger.httpsCommitted, httpsActiveMs: this.ledger.httpsActiveMs, httpsActiveTransfers: this.count('https'),
          httpsTransfers: Object.entries(this.ledger.reservations).filter(([, value]) => value.kind === 'https').map(([id, value]) => ({ id, roomId: value.roomId })),
          r2Bytes: this.sum('r2'), r2Reservations: this.count('r2'), classA: this.ledger.classA, classB: this.ledger.classB,
          r2ActiveUploads: Object.values(this.ledger.reservations).filter(x => x.kind === 'r2' && !x.ready).length,
        } : { ok: true });
      } catch (error) { await this.ctx.storage.put('ledger', this.ledger); return errorResponse(error); }
    });
  }
}
