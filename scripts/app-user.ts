import {connect} from '../src/db.js';
const secret=process.env.APP_DATABASE_PASSWORD;
if(!secret || secret.length<20 || secret.startsWith('replace-'))throw Error('Set APP_DATABASE_PASSWORD to at least 20 random characters');
if(!process.env.MIGRATION_DATABASE_URL)throw Error('Set MIGRATION_DATABASE_URL');
const db=connect(process.env.MIGRATION_DATABASE_URL);
try{
 await db.transaction(async tx=>{
   if(!(await tx.query("SELECT 1 FROM pg_roles WHERE rolname='search_app'")).rows.length)await tx.query('CREATE ROLE search_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
   // PostgreSQL DDL does not accept bind parameters for role passwords. Escape only a string literal, never an identifier.
   await tx.query(`ALTER ROLE search_app PASSWORD '${secret.replaceAll("'","''")}'`);
   await tx.query('GRANT USAGE ON SCHEMA public TO search_app');
   await tx.query('GRANT SELECT ON schema_migrations TO search_app');
   await tx.query('GRANT SELECT,INSERT,UPDATE,DELETE ON sources,source_alternatives,source_health_events,source_policy_rules,content,content_removals,transcript_segments,moments,jobs,searches,feedback,provider_health,budgets,media_versions,scene_analyses,video_scenes TO search_app');
   if((await tx.query("SELECT to_regclass('embeddings') AS name")).rows[0].name)await tx.query('GRANT SELECT,INSERT,UPDATE,DELETE ON embeddings TO search_app');
 });console.log('search_app runtime privileges configured.');
}finally{await db.close();}
