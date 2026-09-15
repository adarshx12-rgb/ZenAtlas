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
   trustedOrigin:url.origin,token:config.EMBEDDING_TOKEN,timeoutMs:Math.min(1500,config.PROVIDER_TIMEOUT_MS),redirects:0});
 return z.object({embedding:z.array(z.number().finite()).length(config.EMBEDDING_DIMENSIONS)
   .refine(a=>a.some(v=>v!==0))}).parse(result).embedding;
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
 if (cached) {await db.query('UPDATE embeddings SET created_at=now() WHERE content_id=$1',[id]);return;}
 const vector = await embed(db,config,text);
 if (vector) await db.query(`INSERT INTO embeddings(content_id,model,content_hash,embedding) VALUES($1,$2,$3,$4::vector)
 ON CONFLICT(content_id) DO UPDATE SET model=$2,content_hash=$3,embedding=$4::vector,created_at=now()`,[id,config.EMBEDDING_MODEL,hash,JSON.stringify(vector)]);
}
