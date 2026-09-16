import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { canonicalize, publicURL } from './urls.js';
import { contentInput, type ContentInput, type Result } from './types.js';
import { findMatchingRule } from './policy-rules.js';

export async function ingest(db: DB, raw: ContentInput, provenance: Record<string, unknown>): Promise<Result|null> {
 const item = contentInput.parse(raw);
 const url = canonicalize(item.url);
 const domain = new URL(url).hostname;
 if (item.thumbnail) publicURL(item.thumbnail);
 if (item.license_url) publicURL(item.license_url);
 return db.transaction(async tx => {
   let sourceId=(await tx.query(`SELECT s.id FROM sources s WHERE domain=$1 OR active_domain=$1
     OR EXISTS(SELECT 1 FROM source_alternatives a WHERE a.source_id=s.id AND a.domain=$1 AND a.status='verified') LIMIT 1`,[domain])).rows[0]?.id;
   if(!sourceId){
     // A brand-new domain gets classified by any matching trust rule immediately; otherwise it lands as a plain candidate.
     const rule=await findMatchingRule(tx,domain);
     if(rule)await tx.query(`INSERT INTO sources(domain,display_name,status,policy,adapter,feed_url,provenance) VALUES($1,$1,$2,$3,$4,$5,$6)
       ON CONFLICT(domain) DO NOTHING`,[domain,rule.policy.status,
       JSON.stringify({metadata:rule.policy.metadata,transcripts:rule.policy.transcripts,video_analysis:rule.policy.video_analysis,retention_days:rule.policy.retention_days}),
       rule.policy.adapter,rule.policy.feed_url,JSON.stringify({...provenance,auto_policy_rule:rule.pattern})]);
     else await tx.query(`INSERT INTO sources(domain,display_name,provenance) VALUES($1,$1,$2)
       ON CONFLICT(domain) DO NOTHING`,[domain,JSON.stringify(provenance)]);
   }
   const source = (await tx.query('SELECT * FROM sources WHERE domain=$1 OR id=$2 FOR UPDATE',[domain,sourceId??null])).rows[0];
   await tx.query(`UPDATE sources SET discovery_appearances=discovery_appearances+1,discovery_last_seen_at=now() WHERE id=$1`,[source.id]);
   if (['paused','rejected'].includes(source.status)) return null;
   if(source.health_status==='down' || source.active_domain!==domain)return null;
   if((await tx.query(`SELECT 1 FROM content_removals WHERE canonical_url=$1 OR (source_id=$2 AND provider_id=$3)`,[url,source.id,item.provider_id])).rows.length) return null;
   const base: Result = {id:randomUUID(),title:item.title,canonical_url:url,source_id:source.id,
     source_name:source.display_name,description:item.description,creator:item.creator,published_at:item.published_at,
     duration:item.duration,language:item.language,thumbnail:item.thumbnail,embeddable:item.embeddable,
     rights_status:item.rights_status,license_url:item.license_url,availability:item.availability,
     evidence:'metadata_match',moments:[],origin:'discovery',verified_at:null};
   if (source.status !== 'active' || source.policy.metadata !== true) return base;
   // Source/provider identity wins over presentation URL; distinct equal titles never merge.
   const existing = (await tx.query(`SELECT id,canonical_url FROM content WHERE canonical_url=$1 OR
     (source_id=$2 AND provider_id=$3) ORDER BY canonical_url=$1 DESC LIMIT 1`,[url,source.id,item.provider_id])).rows[0];
   if(existing && new URL(existing.canonical_url).hostname!==source.active_domain){
     // A real approved-feed item with the same provider ID establishes the new URL. Never synthesize it from the old path.
     provenance={...provenance,previous_canonical_url:existing.canonical_url};
     await tx.query('UPDATE content SET canonical_url=$2 WHERE id=$1',[existing.id,url]);
     await tx.query("UPDATE moments SET status='stale' WHERE content_id=$1",[existing.id]);
   }
   const params = [source.id,item.provider_id,url,item.title,item.description,item.creator,item.published_at,
     item.duration,item.language,item.thumbnail,item.embeddable,item.rights_status,item.license_url,item.availability,
     Number(source.policy.retention_days ?? 30),JSON.stringify(provenance)];
   const record = existing ? (await tx.query(`UPDATE content SET title=$4,description=coalesce($5,description),creator=coalesce($6,creator),
     published_at=coalesce($7,published_at),duration=coalesce($8,duration),language=coalesce($9,language),thumbnail=coalesce($10,thumbnail),
     embeddable=coalesce($11,embeddable),rights_status=CASE WHEN $12='unknown' THEN rights_status ELSE $12 END,license_url=coalesce($13,license_url),
     availability=CASE WHEN $14='unknown' THEN availability ELSE $14 END,fetched_at=now(),expires_at=now()+($15*interval '1 day'),provenance=$16,
     provider_id=coalesce(provider_id,$2),verified_at=CASE WHEN $14='available' THEN now() ELSE verified_at END
     WHERE id=$17 AND source_id=$1 AND (canonical_url=$3 OR provider_id=$2) RETURNING *`,
     [...params,existing.id])).rows[0] : undefined;
   const row = record ?? (await tx.query(`INSERT INTO content(source_id,provider_id,canonical_url,title,description,creator,
     published_at,duration,language,thumbnail,embeddable,rights_status,license_url,availability,expires_at,provenance,verified_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+($15*interval '1 day'),$16,
       CASE WHEN $14='available' THEN now() ELSE NULL END) RETURNING *`,params)).rows[0];
   return {...base,id:row.id,canonical_url:row.canonical_url,description:row.description,creator:row.creator,
     published_at:row.published_at?.toISOString()??null,duration:row.duration,language:row.language,thumbnail:row.thumbnail,
     embeddable:row.embeddable,rights_status:row.rights_status,license_url:row.license_url,availability:row.availability,
     verified_at:row.verified_at?.toISOString()??null};
 });
}

export function matchesFilters(item: Result, filters: {language?:string;source?:string;after?:string;evidence:string}): boolean {
 return item.availability !== 'unavailable' && (!filters.language || item.language === filters.language) &&
   (!filters.source || item.source_id === filters.source) &&
   (!filters.after || !!item.published_at && item.published_at >= filters.after) &&
   (filters.evidence === 'any' || item.moments.some(m => m.evidence_type === filters.evidence));
}
