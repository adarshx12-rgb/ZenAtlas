import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { SearchService, ApiError } from './search.js';
import { takeBudget } from './budgets.js';
import { setSourcePolicy, sourcePolicy } from './admin.js';
import {addSource,setAlternative} from './source-health.js';
import { listPolicyRules, setPolicyRule } from './policy-rules.js';

const sourceListQuery = z.object({
 status:z.enum(['all','candidate','active','paused','rejected']).default('all'),
 q:z.string().trim().toLowerCase().max(253).default(''),
 sort:z.enum(['newest','seen','domain']).default('newest'),
 limit:z.coerce.number().int().min(1).max(500).default(200),
 offset:z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();
const sourceOrder = {newest:'s.created_at DESC,s.domain',seen:'s.discovery_appearances DESC,s.discovery_last_seen_at DESC NULLS LAST,s.domain',domain:'s.domain'};

export async function createApp(db:DB,config:Config) {
 const app=Fastify({logger:false,bodyLimit:16384,requestTimeout:15000,trustProxy:false});
 await app.register(cookie,{secret:config.SESSION_SECRET});
 const service=new SearchService(db,config);
 app.decorateRequest('searchOwner','');
 app.addHook('onRequest',async(req,reply)=>{
   reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
     .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
   if(!req.url.startsWith('/api/')) return;
   reply.header('Cache-Control','no-store');
   const ipHash=createHmac('sha256',config.SESSION_SECRET).update(req.ip).digest('hex');
   if(!await takeBudget(db,`requests:${ipHash}`,120,'minute')) throw new ApiError(429,'rate_limit','Too many requests. Please wait a minute.');
   const value=req.cookies.creator_session;
   const unsigned=value?req.unsignCookie(value):null;
   let owner=unsigned?.valid?unsigned.value:null;
   if(!owner || !z.string().uuid().safeParse(owner).success) {
     owner=randomUUID(); reply.setCookie('creator_session',owner,{signed:true,httpOnly:true,sameSite:'strict',
       secure:new URL(config.PUBLIC_ORIGIN).protocol==='https:',path:'/',maxAge:90*86400});
   }
   (req as any).searchOwner=owner;
   if(['POST','PATCH','DELETE','PUT'].includes(req.method)) {
     if(req.headers.origin && req.headers.origin!==new URL(config.PUBLIC_ORIGIN).origin) throw new ApiError(403,'origin_denied','This request origin is not allowed.');
     if(req.headers['x-requested-with']!=='CreatorSearch') throw new ApiError(403,'request_header_required','A request verification header is required.');
     if(!await takeBudget(db,`writes:${ipHash}`,30,'minute')) throw new ApiError(429,'rate_limit','Too many changes. Please wait a minute.');
   }
 });
 app.setErrorHandler((error:any,req,reply)=>{
   if(error instanceof ZodError) return reply.code(400).send({error:{code:'invalid_request',message:'Check the query, filters, or request fields.'}});
   if(error instanceof ApiError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
   if(error?.message==='unsafe_url') return reply.code(400).send({error:{code:'unsafe_url',message:'Use a public http(s) web address.'}});
   if(error.statusCode && error.statusCode<500) return reply.code(error.statusCode).send({error:{code:'invalid_request',message:'The request could not be accepted.'}});
   console.error(JSON.stringify({event:'request_failed',request_id:req.id,code:'internal_error'}));
   return reply.code(503).send({error:{code:'service_unavailable',message:'Search is temporarily unavailable. Please retry.'}});
 });
 const owner=(req:any):string=>req.searchOwner;
 const id=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
 const admin=(req:any)=>{
   const supplied=Buffer.from(String(req.headers.authorization??''));const expected=Buffer.from(`Bearer ${config.ADMIN_TOKEN}`);
   if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) throw new ApiError(403,'admin_required','Administrator access is required.');
 };
 app.get('/health/live',async()=>({status:'ok'}));
 app.get('/health/ready',async(_req,reply)=>{
   try {await db.query('SELECT 1 FROM schema_migrations LIMIT 1');return {status:'ready'};}
   catch {return reply.code(503).send({status:'not_ready'});}
 });
 app.get('/api/session',async()=>({status:'ready'}));
 app.get('/api/search',async req=>service.start(req.query,owner(req)));
 app.get('/api/search/:id',async req=>service.poll(id(req.params),owner(req)));
 app.delete('/api/search/:id',async req=>service.cancel(id(req.params),owner(req)));
 app.post('/api/feedback',async(req,reply)=>{
   const input=z.object({search_id:z.string().uuid(),content_id:z.string().uuid(),useful:z.boolean()}).strict().parse(req.body);
   const snapshot=await service.owned(input.search_id,owner(req));
   if(!snapshot.results.some((r:any)=>r.id===input.content_id)) throw new ApiError(403,'result_required','Feedback requires a result from your search.');
   const content=(await db.query(`SELECT c.id FROM content c JOIN sources s ON s.id=c.source_id WHERE c.id=$1
     AND s.status='active' AND c.expires_at>now() AND c.availability<>'unavailable'`,[input.content_id])).rows[0];
   if(!content) throw new ApiError(409,'catalogue_required','Feedback is available for retained catalogue records.');
   await db.query(`INSERT INTO feedback(owner,content_id,useful) VALUES($1,$2,$3)
     ON CONFLICT(owner,content_id) DO UPDATE SET useful=$3,updated_at=now()`,[owner(req),input.content_id,input.useful]);
   return reply.code(204).send();
 });
 app.get('/api/feedback',async req=>(await db.query('SELECT content_id,useful,updated_at FROM feedback WHERE owner=$1 ORDER BY updated_at DESC LIMIT 100',[owner(req)])).rows);
 app.delete('/api/feedback',async(req,reply)=>{await db.query('DELETE FROM feedback WHERE owner=$1',[owner(req)]);return reply.code(204).send();});
 app.get('/api/admin/sources',async(req,reply)=>{admin(req);
   const input=sourceListQuery.parse(req.query);
   const rows=(await db.query(`SELECT s.*,(SELECT count(*)::int FROM content c WHERE c.source_id=s.id) AS saved_videos,count(*) OVER()::int AS total_rows
     FROM sources s WHERE ($1='all' OR s.status=$1) AND ($2='' OR s.domain LIKE '%'||$2||'%' ESCAPE '\\' OR lower(s.display_name) LIKE '%'||$2||'%' ESCAPE '\\')
     ORDER BY ${sourceOrder[input.sort]} LIMIT $3 OFFSET $4`,[input.status,input.q.replace(/[\\%_]/g,'\\$&'),input.limit,input.offset])).rows;
   reply.header('X-Total-Count',String(rows[0]?.total_rows??0));
   return rows.map(({total_rows:_total,...row})=>row);});
 app.get('/api/admin/sources/summary',async req=>{admin(req);return {
   statuses:Object.fromEntries((await db.query('SELECT status,count(*)::int AS n FROM sources GROUP BY status')).rows.map(r=>[r.status,r.n])),
   rules:(await db.query('SELECT count(*)::int AS n FROM source_policy_rules')).rows[0].n,
   saved_videos:(await db.query('SELECT count(*)::int AS n FROM content')).rows[0].n,
 };});
 app.post('/api/admin/sources/bulk',async req=>{admin(req);
   const input=z.object({ids:z.array(z.string().uuid()).min(1).max(100),policy:sourcePolicy}).strict().parse(req.body);
   let updated=0;for(const sourceId of new Set(input.ids))if(await setSourcePolicy(db,sourceId,input.policy))updated++;
   return {updated};});
 app.get('/api/admin/rules',async req=>{admin(req);return listPolicyRules(db);});
 app.post('/api/admin/rules',async req=>{admin(req);
   const input=z.object({pattern:z.string().max(255),policy:z.unknown()}).strict().parse(req.body);
   return setPolicyRule(db,input.pattern,input.policy);});
 app.delete('/api/admin/rules/:id',async(req,reply)=>{admin(req);
   if(!(await db.query('DELETE FROM source_policy_rules WHERE id=$1 RETURNING id',[id(req.params)])).rows.length)throw new ApiError(404,'rule_not_found','Rule not found.');
   return reply.code(204).send();});
 app.post('/api/admin/sources',async req=>{admin(req);const input=z.object({url:z.string().url().max(2048),name:z.string().max(300).optional()}).strict().parse(req.body);return addSource(db,input.url,input.name);});
 app.get('/api/admin/sources/:id/alternatives',async req=>{admin(req);return (await db.query('SELECT * FROM source_alternatives WHERE source_id=$1 ORDER BY created_at DESC',[id(req.params)])).rows;});
 app.post('/api/admin/sources/:id/alternatives',async req=>{admin(req);return setAlternative(db,id(req.params),req.body);});
 app.patch('/api/admin/sources/:id',async req=>{admin(req);const result=await setSourcePolicy(db,id(req.params),req.body);
   if(!result) throw new ApiError(404,'source_not_found','Source not found.');return result;});
 app.get('/api/admin/health',async req=>{admin(req);return {
   providers:(await db.query('SELECT * FROM provider_health')).rows,
   sources:(await db.query('SELECT id,domain,active_domain,health_status,health_failures,health_checked_at,health_next_at,health_code FROM sources ORDER BY health_next_at LIMIT 200')).rows,
   recent_switches:(await db.query("SELECT * FROM source_health_events WHERE kind='switch' ORDER BY created_at DESC LIMIT 50")).rows,
   jobs:(await db.query('SELECT kind,status,count(*)::int FROM jobs GROUP BY kind,status')).rows,
   scene_analysis:(await db.query(`SELECT analysis_status,analysis_code,count(*)::int FROM media_versions WHERE status='current' GROUP BY analysis_status,analysis_code`)).rows,
   oldest_queued:(await db.query(`SELECT min(created_at) AS since FROM jobs WHERE status='queued'`)).rows[0]?.since??null,
 };});
 app.get('/admin',async(_req,reply)=>reply.redirect('/admin.html'));
 await app.register(staticFiles,{root:resolve('public'),index:'index.html'});
 return app;
}
