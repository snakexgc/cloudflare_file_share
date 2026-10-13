import { expect, it } from 'vitest';
import { MODE_LABELS, TransferSpeed } from '../src/client/speed';
it('速度按字节和时间计算，停止传输后归零', () => {
  const meter = new TransferSpeed(); expect(meter.sample('a', 0, 0)).toBe(0); expect(meter.sample('a', 1024, 1000)).toBe(1024);
  meter.sample('a', 2048, 2000); meter.sample('a', 2048, 3000); meter.sample('a', 2048, 4000); expect(meter.sample('a', 2048, 5000)).toBe(0);
});
it('恢复偏移不算新流量，切换任务和网络重试时重置样本', () => {
  const meter = new TransferSpeed(); meter.sample('a', 8192, 0); expect(meter.sample('a', 9216, 1000)).toBe(1024);
  expect(meter.sample('b', 9216, 2000)).toBe(0); expect(meter.sample('b', 10240, 3000)).toBe(1024); expect(meter.sample('b', 9216, 4000)).toBe(0);
});
it('每种传输方式均有明确显示名称', () => { expect(Object.keys(MODE_LABELS)).toEqual(['lan', 'p2p', 'turn', 'ws', 'https', 'r2']); });
