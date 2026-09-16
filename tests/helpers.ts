import { embedded } from '../scripts/embedded.js';
import type { DB } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { configSchema } from '../src/config.js';
import { ingest } from '../src/catalogue.js';
import { contentInput } from '../src/types.js';
export const testConfig=configSchema.parse({DATABASE_URL:'test',SESSION_SECRET:'test-session-secret-32-characters-long',ADMIN_TOKEN:'test-admin-token-32-characters-long',REDDIT_SIGNALS:'false',PAGE_CHECKS:'0'});
export async function database():Promise<DB>{
 const db=embedded();
 await migrate(db);return db;
}
export async function fixture(db:DB,title='Big bright bedroom property tour',description='A property tour showing a large bright bedroom'){
 await db.query(`INSERT INTO sources(domain,display_name,status,policy,provenance) VALUES('videos.example.com','TEST FIXTURE source','active',
   '{"metadata":true,"transcripts":true,"retention_days":30}','{"fixture":true}') ON CONFLICT(domain) DO NOTHING`);
 return (await ingest(db,contentInput.parse({url:`https://videos.example.com/watch/${crypto.randomUUID()}`,title,description,language:'en',duration:120,availability:'available'}),{fixture:true}))!;
}
