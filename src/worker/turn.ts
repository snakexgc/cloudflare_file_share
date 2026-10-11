import type { Env } from './config';
import type { IceServer } from '../shared/types';
import { assert } from './util';
export function turnConfiguration(env: Env) {
  const names = ['TURN_KEY_ID', 'TURN_KEY_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ANALYTICS_API_TOKEN'] as const;
  const turnMissing = names.filter(name => !env[name]);
  return { turnConfigured: turnMissing.length === 0, turnMissing };
}

export async function generateTurn(env: Env, ttl: number): Promise<IceServer[]> {
  assert(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN, 503, 'turn_not_configured', 'TURN 凭证尚未配置');
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, 503, 'turn_credentials_failed', '无法生成 TURN 凭证');
  const data = await response.json() as { iceServers?: IceServer[] };
  const servers = data.iceServers?.filter(x => x.username && typeof x.credential === 'string' && (Array.isArray(x.urls) ? x.urls : [x.urls]).some(url => /^turns?:/.test(url))).map(x => ({ ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(url => /^turns?:/.test(url) && !/:53(?:\?|$)/.test(url)) }));
  assert(servers?.length, 503, 'turn_credentials_failed', 'TURN 服务返回了无效凭证');
  return servers;
}
export async function revokeTurn(env: Env, usernames: string[]) {
  if (!usernames.length) return;
  assert(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN, 503, 'turn_not_configured', 'TURN 凭证尚未配置');
  for (const username of [...new Set(usernames)]) {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/${encodeURIComponent(username)}/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` }, signal: AbortSignal.timeout(10000),
    });
    assert(response.ok || response.status === 404, 503, 'turn_revoke_failed', 'TURN 撤销失败，将继续重试');
  }
}
