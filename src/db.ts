import pg from 'pg';

export interface DB {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function connect(connectionString: string): DB {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000, statement_timeout: 5000 });
  pool.on('error', () => console.error('database_pool_error'));
  const wrap = (client: pg.Pool | pg.PoolClient): DB => ({
    query: async <T = any>(sql: string, params?: any[]) => ({rows:(await client.query(sql, params)).rows as T[]}),
    transaction: async fn => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const value = await fn(wrap(c)); await c.query('COMMIT'); return value; }
      catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    },
    close: () => pool.end(),
  });
  return wrap(pool);
}
