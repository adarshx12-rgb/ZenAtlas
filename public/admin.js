const $=selector=>document.querySelector(selector);
const PAGE=100;
const TOKEN_KEY='zenatlas-admin-token';
const state={status:'all',q:'',sort:'seen',offset:0,total:0,rows:[],selected:new Set()};
let token=null;
try{token=sessionStorage.getItem(TOKEN_KEY);}catch{/* Storage can be unavailable; the token then lasts until reload. */}

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined&&text!==null)el.textContent=String(text);if(className)el.className=className;return el;}
function button(text,onClick,className='secondary small'){const b=node('button',text,className);b.type='button';b.addEventListener('click',onClick);return b;}
const plural=(n,word,many=`${word}s`)=>`${n} ${n===1?word:many}`;
const date=value=>value?new Date(value).toLocaleDateString():'—';
function ago(value){
 if(!value)return 'never';
 const minutes=Math.round((Date.now()-new Date(value).getTime())/60000);
 if(minutes<1)return 'just now';if(minutes<60)return `${minutes} min ago`;
 const hours=Math.round(minutes/60);if(hours<24)return `${hours} h ago`;
 return `${Math.round(hours/24)} d ago`;
}
const STATUS_LABEL={active:'approved',candidate:'candidate',paused:'paused',rejected:'rejected'};

class AuthError extends Error{}
async function api(path,{method='GET',body}={}){
 const headers={Authorization:`Bearer ${token}`};
 if(method!=='GET'){headers['X-Requested-With']='CreatorSearch';if(body!==undefined)headers['Content-Type']='application/json';}
 const response=await fetch(path,{method,headers,credentials:'same-origin',body:body===undefined?undefined:JSON.stringify(body)});
 if(response.status===403){const data=await response.json().catch(()=>null);
   if(data?.error?.code==='admin_required')throw new AuthError('That token was not accepted.');
   throw Error(data?.error?.message??'This request was refused.');}
 if(!response.ok){const data=await response.json().catch(()=>null);throw Error(data?.error?.message??`Request failed (${response.status}).`);}
 return {data:response.status===204?null:await response.json(),headers:response.headers};
}

function flash(message,isError=false){const el=$('#flash');el.textContent=message;el.classList.toggle('error',isError);el.hidden=false;
 clearTimeout(flash.timer);if(!isError)flash.timer=setTimeout(()=>{el.hidden=true;},6000);}
async function run(action,success){
 try{await action();if(success)flash(success);}
 catch(error){if(error instanceof AuthError)return signOut(error.message);flash(error.message,true);}
}

function signOut(message){
 token=null;try{sessionStorage.removeItem(TOKEN_KEY);}catch{/* ignore */}
 $('#dashboard').hidden=true;$('#login').hidden=false;$('#sign-out').hidden=true;
 const error=$('#login-error');error.textContent=message??'';error.hidden=!message;
}
async function signIn(value){
 token=value;
 try{await api('/api/admin/sources/summary');}
 catch(error){return signOut(error instanceof AuthError?error.message:error.message);}
 try{sessionStorage.setItem(TOKEN_KEY,value);}catch{/* ignore */}
 $('#login').hidden=true;$('#dashboard').hidden=false;$('#sign-out').hidden=false;$('#login-error').hidden=true;
 await refresh();
}

// Review dialog: every change records a note, matching the command-line policy files.
function review({title,target,mode,feed=false,rule=null,defaults={}}){
 const dialog=$('#review'),form=$('#review-form');
 form.reset();
 $('#review-title').textContent=title;$('#review-target').textContent=target;
 $('#approve-options').hidden=mode!=='approve';$('#feed-option').hidden=!feed;
 form.elements.note.value=defaults.note??({approve:'Approved in admin page: public video site; keep titles and links only.',
   reject:'Rejected in admin page: not a relevant or trustworthy video source.',pause:'Paused in admin page pending another review.'})[mode];
 form.elements.retention.value=defaults.retention??30;form.elements.feed.value=defaults.feed??'';
 form.elements.transcripts.checked=!!defaults.transcripts;form.elements.viewers.checked=!!defaults.viewers;form.elements.video.checked=!!defaults.video;
 $('#rule-option').hidden=!rule;$('#rule-option-text').textContent=rule?`Also ${mode==='reject'?'block':'approve'} every ${rule} website, including ones found later`:'';
 $('#review-confirm').textContent={approve:'Approve',reject:'Reject',pause:'Pause'}[mode];
 $('#review-confirm').className=mode==='reject'?'danger':'';
 return new Promise(resolve=>{
   dialog.addEventListener('close',()=>{
     if(dialog.returnValue!=='confirm')return resolve(null);
     const feedValue=form.elements.feed.value.trim();
     resolve({note:form.elements.note.value.trim(),retention:Number(form.elements.retention.value),
       feed:feed&&feedValue?normaliseURL(feedValue):null,transcripts:form.elements.transcripts.checked,viewers:form.elements.viewers.checked,
       video:form.elements.video.checked,rule:!!rule&&form.elements.rule.checked});
   },{once:true});
   dialog.returnValue='';dialog.showModal();
 });
}
const approvePolicy=r=>({status:'active',metadata:true,transcripts:r.transcripts,video_analysis:r.video,viewer_signals:r.viewers,retention_days:r.retention,
 adapter:r.feed?'json_feed':'link_only',feed_url:r.feed,review_note:r.note});
const rejectPolicy=note=>({status:'rejected',metadata:false,transcripts:false,video_analysis:false,viewer_signals:false,retention_days:30,adapter:'link_only',feed_url:null,review_note:note});
const pausePolicy=(row,note)=>({status:'paused',metadata:row.policy?.metadata===true,transcripts:!!row.policy?.transcripts,
 video_analysis:!!row.policy?.video_analysis,viewer_signals:!!row.policy?.viewer_signals,retention_days:row.policy?.retention_days??30,adapter:row.adapter,feed_url:row.feed_url,review_note:note});
const rulePattern=domain=>`*.${domain.replace(/^www\./,'')}`;
function normaliseURL(value){return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)?value:`https://${value}`;}

async function saveRule(pattern,policy){await api('/api/admin/rules',{method:'POST',body:{pattern,policy}});}

async function approve(row){
 const result=await review({title:`Approve ${row.domain}`,target:'Its videos will be saved and shown in catalogue searches.',mode:'approve',feed:true,
   rule:rulePattern(row.domain),defaults:row.status==='active'?{note:row.provenance?.review_note,retention:row.policy?.retention_days,
   feed:row.feed_url,transcripts:row.policy?.transcripts,video:row.policy?.video_analysis,viewers:row.policy?.viewer_signals}:{}});
 if(!result)return;
 await run(async()=>{
   await api(`/api/admin/sources/${row.id}`,{method:'PATCH',body:approvePolicy(result)});
   if(result.rule)await saveRule(rulePattern(row.domain),approvePolicy({...result,feed:null}));
   await refresh();
 },`${row.domain} approved${result.rule?` (rule ${rulePattern(row.domain)} saved)`:''}.`);
}
async function reject(row){
 const result=await review({title:`Reject ${row.domain}`,target:'Its saved videos are deleted and its results stop appearing.',mode:'reject',rule:rulePattern(row.domain)});
 if(!result)return;
 await run(async()=>{
   await api(`/api/admin/sources/${row.id}`,{method:'PATCH',body:rejectPolicy(result.note)});
   if(result.rule)await saveRule(rulePattern(row.domain),rejectPolicy(result.note));
   await refresh();
 },`${row.domain} rejected${result.rule?` (rule ${rulePattern(row.domain)} saved)`:''}.`);
}
async function pause(row){
 const result=await review({title:`Pause ${row.domain}`,target:'Its results are hidden and collection stops until you approve it again. Saved videos are kept.',mode:'pause'});
 if(!result)return;
 await run(async()=>{await api(`/api/admin/sources/${row.id}`,{method:'PATCH',body:pausePolicy(row,result.note)});await refresh();},`${row.domain} paused.`);
}
async function bulk(mode){
 const ids=[...state.selected];if(!ids.length)return;
 const result=await review({title:`${mode==='approve'?'Approve':'Reject'} ${plural(ids.length,'website')}`,
   target:state.rows.filter(r=>state.selected.has(r.id)).map(r=>r.domain).join(', '),mode});
 if(!result)return;
 await run(async()=>{
   const {data}=await api('/api/admin/sources/bulk',{method:'POST',body:{ids,policy:mode==='approve'?approvePolicy(result):rejectPolicy(result.note)}});
   state.selected.clear();await refresh();
   flash(`${plural(data.updated,'website')} ${mode==='approve'?'approved':'rejected'}.`);
 });
}

function renderSummary(summary){
 const box=$('#summary');box.replaceChildren();
 for(const [label,value,status] of [['Approved',summary.statuses.active??0,'active'],['Candidates',summary.statuses.candidate??0,'candidate'],
   ['Paused',summary.statuses.paused??0,'paused'],['Rejected',summary.statuses.rejected??0,'rejected'],['Trust rules',summary.rules,null],['Saved videos',summary.saved_videos,null]]){
   const card=node(status?'button':'div',undefined,'stat');
   card.append(node('strong',value.toLocaleString()),node('span',label));
   if(status){card.type='button';card.addEventListener('click',()=>setStatus(status));}
   box.append(card);
 }
}
function renderRows(){
 const body=$('#sources tbody');body.replaceChildren();
 for(const row of state.rows){
   const tr=node('tr');
   const check=node('input');check.type='checkbox';check.checked=state.selected.has(row.id);check.setAttribute('aria-label',`Select ${row.domain}`);
   check.addEventListener('change',()=>{check.checked?state.selected.add(row.id):state.selected.delete(row.id);updateSelection();});
   const site=node('td');const a=node('a',row.domain);a.href=`https://${row.active_domain??row.domain}/`;a.target='_blank';a.rel='noopener noreferrer';site.append(a);
   if(row.display_name&&row.display_name!==row.domain)site.append(node('div',row.display_name,'hint'));
   if(row.active_domain&&row.active_domain!==row.domain)site.append(node('div',`now at ${row.active_domain}`,'hint'));
   if(row.provenance?.auto_policy_rule)site.append(node('div',`by rule ${row.provenance.auto_policy_rule}`,'hint'));
   const status=node('td');status.append(node('span',STATUS_LABEL[row.status]??row.status,`pill status-${row.status}`));
   if(row.provenance?.review_note){status.title=row.provenance.review_note;}
   const actions=node('td',undefined,'actions');
   actions.append(button(row.status==='active'?'Edit':'Approve',()=>approve(row),row.status==='active'?'secondary small':'small'));
   if(row.status==='active')actions.append(button('Pause',()=>pause(row)));
   if(row.status!=='rejected')actions.append(button('Reject',()=>reject(row),'secondary small danger-text'));
   const cells=[node('td'),site,status,node('td',row.adapter==='json_feed'?'feed':'links'),node('td',row.discovery_appearances??0,'num'),
     node('td',row.saved_videos??0,'num'),node('td',row.health_status,`health-${row.health_status}`),node('td',ago(row.discovery_last_seen_at)),node('td',date(row.created_at)),actions];
   cells[0].append(check);tr.append(...cells);body.append(tr);
 }
 $('#empty').hidden=state.rows.length>0;
 const from=state.total?state.offset+1:0,to=state.offset+state.rows.length;
 $('#page-info').textContent=`${from}–${to} of ${state.total.toLocaleString()}`;
 $('#prev').disabled=state.offset===0;$('#next').disabled=to>=state.total;
 updateSelection();
}
function updateSelection(){
 const n=state.selected.size;$('#selected-count').textContent=`${n} selected`;
 $('#bulk-approve').disabled=$('#bulk-reject').disabled=n===0;
 const onPage=state.rows.filter(r=>state.selected.has(r.id)).length;
 $('#select-all').checked=state.rows.length>0&&onPage===state.rows.length;
 $('#select-all').indeterminate=onPage>0&&onPage<state.rows.length;
}
function renderRules(rules){
 const body=$('#rules tbody');body.replaceChildren();
 for(const rule of rules){
   const tr=node('tr');const blocked=rule.policy?.status==='rejected';
   const action=node('td');action.append(node('span',blocked?'block':'approve',`pill status-${blocked?'rejected':'active'}`));
   const remove=node('td',undefined,'actions');
   remove.append(button('Delete',async()=>{
     if(!confirm(`Delete rule ${rule.pattern}? Websites it already classified keep their current status.`))return;
     await run(async()=>{await api(`/api/admin/rules/${rule.id}`,{method:'DELETE'});await refresh();},`Rule ${rule.pattern} deleted.`);
   },'secondary small danger-text'));
   tr.append(node('td',rule.pattern,'mono'),action,node('td',blocked?'—':`${rule.policy?.retention_days??30} days`),node('td',rule.review_note,'note'),node('td',date(rule.updated_at)),remove);
   body.append(tr);
 }
 $('#rules-empty').hidden=rules.length>0;
}

const CHECK_LABEL={ok:'ok',warning:'warning',failing:'failing',disabled:'off'};
const PROCESS={api:'zenatlas-api',worker:'zenatlas-worker',watchdog:'zenatlas-watchdog'};
// report is null when the health report could not be loaded (for example before the database migration is applied).
function renderHealth(report){
 const line=$('#health-line');const body=$('#dependencies tbody');const services=$('#services');
 body.replaceChildren();services.replaceChildren();
 if(!report){line.textContent='The health report is unavailable. Apply the latest migration (npm run migrate, then npm run db:app-user).';line.className='health-line health-failing';return;}
 const {counts}=report;
 line.textContent=report.status==='unmonitored'?`The watchdog is not running, so these results may be out of date. Start it: pm2 start ecosystem.config.cjs --only ${PROCESS.watchdog}`
   :counts.failing?`${plural(counts.failing,'dependency','dependencies')} failing${counts.warning?` and ${plural(counts.warning,'warning')}`:''}.`
   :counts.warning?`Everything works; ${plural(counts.warning,'warning')} to look at.`:'Everything the search engine depends on is working.';
 line.className=`health-line health-${report.status}`;
 for(const name of Object.keys(PROCESS)){
   const s=report.services.find(x=>x.service===name);
   const chip=node('span',`${PROCESS[name]}: ${!s?'never reported':s.running?`running (pid ${s.pid})`:`stopped ${ago(s.beat_at)}`}`,`pill check-${s?.running?'ok':'failing'}`);
   if(s)chip.title=`Started ${new Date(s.started_at).toLocaleString()} on ${s.host}`;
   services.append(chip);
 }
 for(const check of report.checks){
   const tr=node('tr');
   const name=node('td');name.append(node('div',check.label),node('div',check.category,'hint'));
   const status=node('td');status.append(node('span',CHECK_LABEL[check.status]??check.status,`pill check-${check.status}`));
   if(check.observed!==check.status)status.append(node('div',`now ${CHECK_LABEL[check.observed]??check.observed}, rechecking`,'hint'));
   const checked=node('td',ago(check.checked_at));checked.title=`${check.latency_ms} ms; status since ${new Date(check.changed_at).toLocaleString()}`;
   tr.append(name,status,node('td',check.summary,'note'),checked);
   body.append(tr);
 }
 if(!report.checks.length){const tr=node('tr'),td=node('td','No results yet. Start the watchdog.','hint');td.colSpan=4;tr.append(td);body.append(tr);}
}

const pct=v=>v===null||v===undefined?'–':`${Math.round(v*100)}%`;
const conf=c=>` (confidence ${pct(c)})`;
function renderAudits(report){
 const line=$('#audit-line'),body=$('#audits tbody');body.replaceChildren();
 if(!report){line.textContent='Audits are unavailable. Apply the latest migration (npm run migrate).';line.className='health-line health-failing';return;}
 const {summary:s}=report,f=s.feedback,m=s.missing_sources;
 line.textContent=`Last 7 days: ${s.audits.complete} audited${s.audits.skipped?`, ${s.audits.skipped} skipped (budget)`:''}${s.audits.failed?`, ${s.audits.failed} failed`:''}. `
   +`Average best results ${pct(s.best_results)}, quality ${pct(s.quality)}. Depth: ${s.depth.too_shallow} too shallow, ${s.depth.enough} enough, ${s.depth.too_deep} too deep. `
   +`Missing sources tested: ${m.confirmed} confirmed, ${m.weak} weak, ${m.refuted+m.no_results} not borne out. `
   +`Reviewer agreement ${pct(s.review.agreement)} over ${s.review.reviewed}. Your feedback: ${f.useful} useful, ${f.not_useful} not useful, ${f.opens} opened, ${f.missing} missing notes.`;
 line.className='health-line';
 for(const a of report.audits){
   const tr=node('tr'),search=node('td');
   search.append(node('div',a.query),node('div',`${a.depth} · ${ago(a.created_at)}${a.audit?` · ${a.audit.topic}`:''}`,'hint'));
   const results=node('td',`${a.metrics.shown} shown, ${a.metrics.verified} verified${a.metrics.possible?`, ${a.metrics.possible} possible`:''}`);
   if(a.status!=='complete'){const td=node('td',`Not audited: ${a.code??a.status}`,'hint');td.colSpan=4;tr.append(search,results,td);}
   else{
     const best=node('td',pct(a.audit.best_results.score)+conf(a.audit.best_results.confidence),'note');best.title=a.audit.best_results.summary;
     for(const x of a.audit.best_results.misranked.slice(0,3))best.append(node('div',`${x.action}: ${x.url}`,'hint'));
     const quality=node('td',pct(a.audit.quality.score),'note');
     for(const i of a.audit.quality.issues.slice(0,3))quality.append(node('div',`${i.kind}: ${i.note}`,'hint'));
     const depth=node('td',a.audit.search_depth.verdict.replace('_',' ')+conf(a.audit.search_depth.confidence),'note');depth.title=a.audit.search_depth.why;
     const missing=node('td','','note');
     for(const p of a.probes??[])missing.append(node('div',`${p.domain}: ${p.status}${p.checked?` (${p.relevant}/${p.checked} relevant)`:''}`));
     if(!(a.probes??[]).length)missing.textContent='None claimed';
     if(a.audit.lessons.length)missing.append(...a.audit.lessons.map(l=>node('div',`Lesson (${l.applies_to}): ${l.lesson}`,'hint')));
     if(a.review)missing.append(node('div',`Reviewer agreed with ${pct(a.review.agreement)} of findings`,'hint'));
     tr.append(search,results,best,quality,depth,missing);
   }
   const fb=a.feedback??{useful:0,not_useful:0,missing:[]};
   const feedback=node('td',`${fb.useful} useful, ${fb.not_useful} not`,'note');
   for(const note of fb.missing??[])feedback.append(node('div',`Missing: ${note}`,'hint'));
   tr.append(feedback);body.append(tr);
 }
 if(!report.audits.length){const tr=node('tr'),td=node('td','No audits yet. Set CRITIC_ENABLED=true and run a search.','hint');td.colSpan=7;tr.append(td);body.append(tr);}
}

async function refresh(){
 const params=new URLSearchParams({status:state.status,sort:state.sort,limit:String(PAGE),offset:String(state.offset)});
 if(state.q)params.set('q',state.q);
 const [summary,list,rules,health]=await Promise.all([api('/api/admin/sources/summary'),api(`/api/admin/sources?${params}`),api('/api/admin/rules'),
   api('/api/admin/dependencies').catch(error=>{if(error instanceof AuthError)throw error;return null;})]);
 const audits=await api('/api/admin/audits').catch(error=>{if(error instanceof AuthError)throw error;return null;});
 state.rows=list.data;state.total=Number(list.headers.get('X-Total-Count')??0);
 if(!state.rows.length&&state.offset>0){state.offset=Math.max(0,state.offset-PAGE);return refresh();}
 renderSummary(summary.data);renderRows();renderRules(rules.data);renderHealth(health?.data??null);renderAudits(audits?.data??null);
}
const reload=()=>run(refresh);
function setStatus(status){
 state.status=status;state.offset=0;state.selected.clear();
 for(const tab of document.querySelectorAll('#status-tabs button'))tab.classList.toggle('active',tab.dataset.status===status);
 void reload();
}

$('#login-form').addEventListener('submit',event=>{event.preventDefault();void signIn($('#token').value.trim());});
$('#sign-out').addEventListener('click',()=>signOut());
for(const tab of document.querySelectorAll('#status-tabs button'))tab.addEventListener('click',()=>setStatus(tab.dataset.status));
let filterTimer;
$('#filter').addEventListener('input',event=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{state.q=event.target.value.trim();state.offset=0;void reload();},300);});
$('#sort').addEventListener('change',event=>{state.sort=event.target.value;state.offset=0;void reload();});
$('#prev').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-PAGE);void reload();});
$('#next').addEventListener('click',()=>{state.offset+=PAGE;void reload();});
$('#select-all').addEventListener('change',event=>{for(const row of state.rows)event.target.checked?state.selected.add(row.id):state.selected.delete(row.id);renderRows();});
$('#bulk-approve').addEventListener('click',()=>void bulk('approve'));
$('#bulk-reject').addEventListener('click',()=>void bulk('reject'));

$('#add-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target;
 const url=normaliseURL(form.elements.url.value.trim());const name=form.elements.name.value.trim();
 const approveNow=form.elements.approve.checked;
 await run(async()=>{
   const {data:source}=await api('/api/admin/sources',{method:'POST',body:name?{url,name}:{url}});
   form.reset();form.elements.approve.checked=true;
   state.status='all';state.q=source.domain;state.offset=0;$('#filter').value=source.domain;
   for(const tab of document.querySelectorAll('#status-tabs button'))tab.classList.toggle('active',tab.dataset.status==='all');
   await refresh();
   flash(source.status==='candidate'?`${source.domain} added as a candidate.`:`${source.domain} was already in the list (${STATUS_LABEL[source.status]??source.status}).`);
   const row=state.rows.find(r=>r.id===source.id);
   if(approveNow&&row&&row.status!=='active')await approve(row);
 });
});

$('#rule-form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target;
 let pattern=form.elements.pattern.value.trim().toLowerCase();
 if(pattern.includes('://')){try{pattern=new URL(pattern).hostname;}catch{/* validated by the server */}}
 const mode=form.elements.action.value;
 const result=await review({title:`${mode==='approve'?'Approve':'Block'} ${pattern}`,
   target:mode==='approve'?'Matching websites will have their videos saved and shown in catalogue searches.':'Matching websites will never appear in results.',mode});
 if(!result)return;
 await run(async()=>{
   const {data}=await api('/api/admin/rules',{method:'POST',body:{pattern,policy:mode==='approve'?approvePolicy(result):rejectPolicy(result.note)}});
   form.reset();await refresh();
   flash(`Rule ${data.rule.pattern} saved; ${plural(data.applied_to_existing,'existing candidate')} updated.`);
 });
});

if(token)void signIn(token);
