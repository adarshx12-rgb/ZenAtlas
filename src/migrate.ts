import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connect, type DB } from './db.js';

export async function migrate(db: DB, vectors = false) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(746219)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
    if (vectors) files.push('optional/002_vectors.sql');
    for (const file of files) {
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])).rows.length) continue;
      await tx.query(await readFile(`migrations/${file}`, 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL');
  const db = connect(url);
  try { await migrate(db, process.argv.includes('--vectors')); console.log('Migrations applied'); }
  finally { await db.close(); }
}
