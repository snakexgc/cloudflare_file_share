export const MODE_LABELS: Record<string, string> = { p2p: 'P2P 直连', turn: 'TURN 中继', ws: 'WS 中继', https: 'HTTPS 中继', r2: 'R2 云端' };
/** Three-second window, reset on retries/epochs, with idle samples decaying to zero. */
export class TransferSpeed {
  private key = '';
  private samples: { at: number; bytes: number }[] = [];
  sample(key: string, bytes: number, now = performance.now()) {
    const last = this.samples.at(-1);
    if (key !== this.key || last && (bytes < last.bytes || now < last.at)) { this.key = key; this.samples = []; }
    if (this.samples.at(-1)?.at === now) this.samples[this.samples.length - 1] = { at: now, bytes };
    else this.samples.push({ at: now, bytes });
    while (this.samples.length > 2 && this.samples[1].at <= now - 3000) this.samples.shift();
    const first = this.samples[0], elapsed = now - first.at;
    return elapsed > 0 ? Math.max(0, (bytes - first.bytes) * 1000 / elapsed) : 0;
  }
}
