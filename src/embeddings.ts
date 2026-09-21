import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON } from './http.js';
import { takeBudget } from './budgets.js';

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function embed(db: DB, config: Config, text: string): Promise<number[]|null> {
 if (!config.SEMANTIC_ENABLED || !config.EMBEDDING_URL || !config.EMBEDDING_MODEL) return null;
 if (!await takeBudget(db,'embeddings',config.EMBEDDING_DAILY_BUDGET)) return null;
 const url = new URL(config.EMBEDDING_URL);
 const result = await fetchJSON(url.href,{method:'POST',body:{input:text,model:config.EMBEDDING_MODEL},
   trustedOrigin:url.origin,token:config.EMBEDDING_TOKEN||(url.origin==='https://openrouter.ai'?config.OPENROUTER_API_KEY:''),timeoutMs:config.PROVIDER_TIMEOUT_MS,redirects:0});
 return parseEmbedding(result,config.EMBEDDING_DIMENSIONS);
}
export function parseEmbedding(result:unknown,dimensions:number):number[] {
 const vector=z.array(z.number().finite()).length(dimensions).refine(a=>a.some(v=>v!==0));
 const parsed=z.union([z.object({embedding:vector}),z.object({data:z.array(z.object({embedding:vector})).length(1)})]).parse(result);
 return 'embedding' in parsed?parsed.embedding:parsed.data[0].embedding;
}
export async function enrichEmbedding(db: DB, config: Config, id: string) {
 const row = (await db.query(`SELECT c.* FROM content c JOIN sources s ON s.id=c.source_id
   WHERE c.id=$1 AND s.status='active' AND (s.policy->>'metadata')::boolean=true
   AND s.health_status<>'down' AND split_part(split_part(c.canonical_url,'://',2),'/',1)=s.active_domain
   AND c.expires_at>now() AND c.availability<>'unavailable'`,[id])).rows[0];
 if (!row) return;
 const text = `${row.title}\n${row.description??''}`; const hash = contentHash(text);
 if (!config.SEMANTIC_ENABLED) return;
 const cached = (await db.query('SELECT 1 FROM embeddings WHERE content_id=$1 AND model=$2 AND content_hash=$3',[id,config.EMBEDDING_MODEL,hash])).rows.length;
 if (cached) await db.query('UPDATE embeddings SET created_at=now() WHERE content_id=$1',[id]);
 const vector = cached?null:await embed(db,config,text);
 if (vector) await db.query(`INSERT INTO embeddings(content_id,model,content_hash,embedding) VALUES($1,$2,$3,$4::vector)
 ON CONFLICT(content_id) DO UPDATE SET model=$2,content_hash=$3,embedding=$4::vector,created_at=now()`,[id,config.EMBEDDING_MODEL,hash,JSON.stringify(vector)]);
 await enrichEvidenceEmbeddings(db,config,id);
}

export async function enrichEvidenceEmbeddings(db:DB,config:Config,id:string) {
 if(!config.SEMANTIC_ENABLED) return;
 const chunks=(await db.query(`SELECT m.id,m.summary AS text,'moment' AS kind FROM moments m
 JOIN content c ON c.id=m.content_id JOIN sources s ON s.id=c.source_id
 WHERE c.id=$1 AND m.status='active' AND m.evidence_type='transcript_supported' AND (s.policy->>'transcripts')::boolean=true
 AND s.status='active' AND c.expires_at>now()
 UNION ALL SELECT v.id,v.description||' '||array_to_string(v.tags,' '),'scene' FROM video_scenes v
 JOIN content c ON c.id=v.content_id JOIN sources s ON s.id=c.source_id JOIN media_versions mv ON mv.id=v.media_version_id
 WHERE c.id=$1 AND v.status='active' AND mv.status='current' AND mv.access_status='accessible'
 AND (s.policy->>'video_analysis')::boolean=true AND s.status='active' AND c.expires_at>now() ORDER BY id LIMIT 80`,[id])).rows;
 for(const chunk of chunks) {
   const hash=contentHash(chunk.text),column=chunk.kind==='moment'?'moment_id':'scene_id';
   if((await db.query(`SELECT 1 FROM evidence_embeddings WHERE ${column}=$1 AND model=$2 AND content_hash=$3`,[chunk.id,config.EMBEDDING_MODEL,hash])).rows.length) continue;
   const vector=await embed(db,config,chunk.text); if(!vector) break;
   // Recheck evidence after the network call; revocation or replacement must not resurrect retained text.
   await db.query(`INSERT INTO evidence_embeddings(content_id,${column},model,content_hash,embedding)
     SELECT $1,$2,$3,$4,$5::vector WHERE EXISTS(SELECT 1 FROM ${chunk.kind==='moment'?'moments':'video_scenes'} e
       JOIN content c ON c.id=e.content_id JOIN sources s ON s.id=c.source_id WHERE e.id=$2 AND e.status='active'
       AND s.status='active' AND (s.policy->>'${chunk.kind==='moment'?'transcripts':'video_analysis'}')::boolean=true)
     ON CONFLICT(${column}) DO UPDATE SET model=$3,content_hash=$4,embedding=$5::vector,created_at=now()`,[id,chunk.id,config.EMBEDDING_MODEL,hash,JSON.stringify(vector)]);
 }
}
