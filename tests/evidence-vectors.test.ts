import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createServer} from 'node:http';
import type {DB} from '../src/db.js';
import {fixture,testConfig} from './helpers.js';
import {importTranscript} from '../src/moments.js';
import {retrieve} from '../src/retrieval.js';
import {searchInput} from '../src/types.js';
import {enrichEvidenceEmbeddings} from '../src/embeddings.js';

test('pgvector retrieves paraphrased transcript evidence and cannot retrieve it after revocation',{
 skip:process.env.VECTOR_INTEGRATION!=='true'?'Set VECTOR_INTEGRATION=true and DATABASE_URL to a migrated PostgreSQL database':false,
},async()=>{
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{embedding:[1,0,0]}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 // Every fixture mutation, including budget rows, is rolled back on the same connection.
 const db:DB={query:async(sql,params)=>({rows:(await client.query(sql,params)).rows}),transaction:fn=>fn(db),close:async()=>{}};
 await client.query('BEGIN');
 try {
   const r=await fixture(db,'A mysterious night','An unassuming story');
   await importTranscript(db,{content_id:r.id,language:'en',origin:'synthetic test',content_version:'fixture',timing_quality:'provided',retention_permitted:true,
     segments:[{start:10,end:20,text:'The spectral narrator explains everything.'}]});
   const config={...testConfig,SEMANTIC_ENABLED:true,EMBEDDING_MODEL:'synthetic-vector-test',EMBEDDING_DIMENSIONS:3,
     EMBEDDING_URL:`http://127.0.0.1:${(server.address() as any).port}/embeddings`};
   await enrichEvidenceEmbeddings(db,config,r.id);
   const input=searchInput.parse({q:'apparition identity',source:r.source_id,mode:'catalogue'});
   const found=await retrieve(db,config,input,'vector-test');
   assert.deepEqual(found.providers,[]);assert.equal(found.results[0]?.id,r.id);
   assert.equal(found.results[0].moments[0].start_seconds,10);
   await db.query(`UPDATE sources SET policy=policy||'{"transcripts":false}'::jsonb WHERE id=$1`,[r.source_id]);
   assert.equal((await retrieve(db,config,input,'vector-test')).results.length,0);
 } finally {await client.query('ROLLBACK');await client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
