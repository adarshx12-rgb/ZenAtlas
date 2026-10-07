import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, testConfig } from './helpers.js';
import { createApp } from '../src/app.js';
import { databaseReadiness, requiredMigrations } from '../src/runtime.js';
import type { DB } from '../src/db.js';

test('readiness checks the complete migration set, including enabled vectors', async () => {
 const db=await database(); const app=await createApp(db,testConfig);
 try {
   assert.equal((await app.inject('/health/ready')).statusCode,200);
   const vector=await databaseReadiness(db,requiredMigrations(process.cwd(),true));
   assert.equal(vector.code,'migrations_pending');
   assert.ok(vector.pending!.every(p=>p.startsWith('optional/')));
   await db.query("DELETE FROM schema_migrations WHERE name='018_field_sources_grant.sql'");
   const missing=await app.inject('/health/ready');
   assert.equal(missing.statusCode,503); assert.equal(missing.json().code,'migrations_pending');
   assert.match(missing.json().runtime.code_hash,/^[a-f0-9]{64}$/);
   assert.ok(!missing.body.includes(testConfig.SESSION_SECRET));
 } finally {await app.close();await db.close();}
});

test('database outage, missing schema and permission failures expose safe diagnostic codes',async()=>{
 for(const [code,expected] of [['ECONNREFUSED','database_unavailable'],['42P01','schema_missing'],['42501','database_permission_denied']]) {
   const db={query:async()=>{throw Object.assign(new Error('secret connection details'),{code});}} as unknown as DB;
   const result=await databaseReadiness(db,['001_catalogue.sql']);
   assert.deepEqual(result,{status:'not_ready',code:expected});
 }
});
