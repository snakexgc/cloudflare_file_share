import type { Env } from './config';
import { budget } from './util';

/** D1 返回的实际 rows_read / rows_written 记入全站账本；达到阈值后停止新业务请求，清理继续执行。 */
export function meteredDB(database: D1Database, env: Env): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = async (results: D1Result[]) => {
    const read = results.reduce((sum, result) => sum + (result.meta.rows_read ?? 0), 0);
    const written = results.reduce((sum, result) => sum + (result.meta.rows_written ?? 0), 0);
    try { await budget(env, '/d1-used', { read, written }); }
    catch { console.error(JSON.stringify({ type: 'd1-meter-unavailable', read, written })); }
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === 'run' || property === 'all') return async () => { const result = await target[property](); await record([result]); return result; };
        if (property === 'first') return async (column?: string) => {
          const result = await target.all(); await record([result]);
          const row = result.results[0] as Record<string, unknown> | undefined;
          if (!row) return null;
          if (!column) return row;
          if (!(column in row)) throw new Error('D1_COLUMN_NOTFOUND');
          return row[column];
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement); return proxy;
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => { const results = await target.batch(statements.map(statement => originals.get(statement) ?? statement)); await record(results); return results; };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
