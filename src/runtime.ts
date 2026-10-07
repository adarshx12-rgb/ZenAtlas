import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';

export interface RuntimeIdentity { code_hash: string; settings_hash: string; started_at: string }
let identity: RuntimeIdentity|undefined;
export const runningIdentity = () => identity;

// Capture once, when the process starts. Never report newly edited files as already running.
export function initializeRuntime(config: Config, root = process.cwd()): RuntimeIdentity {
 if (identity) return identity;
 const hash = createHash('sha256');
 for (const dir of ['src', 'migrations']) {
   for (const file of readdirSync(join(root, dir), {recursive: true, encoding: 'utf8'}).filter(f => /\.(ts|sql)$/.test(f)).sort()) {
     hash.update(`${dir}/${file.replaceAll('\\', '/')}\0`).update(readFileSync(join(root, dir, file)));
   }
 }
 for (const file of ['package.json', 'package-lock.json']) hash.update(file).update(readFileSync(join(root, file)));
 // Settings provenance excludes credentials and connection strings, even from the hash input.
 const settings = Object.fromEntries(Object.entries(config).filter(([key]) => !/TOKEN|SECRET|KEY|PASSWORD|URL|ROOT|DIR|PYTHON|CONVERTER/.test(key)).sort(([a],[b]) => a.localeCompare(b)));
 identity = {code_hash: hash.digest('hex'), settings_hash: createHash('sha256').update(JSON.stringify(settings)).digest('hex'), started_at: new Date().toISOString()};
 return identity;
}

export function requiredMigrations(root = process.cwd(), vectors = false): string[] {
 const files = readdirSync(join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort();
 if (vectors) files.push(...readdirSync(join(root, 'migrations', 'optional')).filter(f => f.endsWith('.sql')).sort().map(f => `optional/${f}`));
 return files;
}

export interface Readiness { status: 'ready'|'not_ready'; code: string; pending?: string[] }
export async function databaseReadiness(db: DB, required: string[]): Promise<Readiness> {
 try {
   const applied = new Set((await db.query<{name: string}>('SELECT name FROM schema_migrations')).rows.map(r => r.name));
   const pending = required.filter(name => !applied.has(name));
   return pending.length ? {status: 'not_ready', code: 'migrations_pending', pending} : {status: 'ready', code: 'ready'};
 } catch (error) {
   const code = (error as {code?: string})?.code;
   return {status: 'not_ready', code: code === '42P01' ? 'schema_missing' : code === '42501' ? 'database_permission_denied' : 'database_unavailable'};
 }
}
