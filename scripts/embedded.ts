import {PGlite} from '@electric-sql/pglite';
import type {DB} from '../src/db.js';
// Development and test adapter only. Production uses the pooled PostgreSQL adapter in src/db.ts.
export function embedded(path?:string):DB{
 const pg=new PGlite(path);
 const wrap=(client:any):DB=>({query:async(sql,params)=>{
   if(!params && (sql.includes('CREATE TABLE sources')||sql.includes('CREATE TABLE content_removals')||sql.includes('CREATE FUNCTION')||sql.includes('CREATE EXTENSION IF NOT EXISTS vector')||sql.includes('CREATE TABLE source_policy_rules')||sql.includes('CREATE TABLE viewer_timestamps')||sql.includes('CREATE TABLE page_previews'))){await client.exec(sql);return {rows:[]};}
   return client.query(sql,params);
 },transaction:fn=>pg.transaction(tx=>fn(wrap(tx))),close:()=>pg.close()});
 return wrap(pg);
}
