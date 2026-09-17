import {SearchController} from './search-controller.js';
const form=document.querySelector('#search-form'),status=document.querySelector('#status'),notices=document.querySelector('#notices');
const catalogueBox=document.querySelector('#catalogue-results'),foundBox=document.querySelector('#found-results');
const deepBox=document.querySelector('#deep-results'),deepHeading=document.querySelector('#deep-heading');
const more=document.querySelector('#more'),retry=document.querySelector('#retry'),cancel=document.querySelector('#cancel');
const deepRow=document.querySelector('#deep-row'),deep=document.querySelector('#deep');
const controller=new SearchController();
let searchId=null,next=null,params=null,pollTimer=null,current=null,pageEnd=0,catalogueTotal=0;
// Result id -> its card and the data it was drawn from, so a changed result is redrawn in place.
const cards=new Map();
const PAGE=20;
// Longer than the server's discovery windows, so the server reports a delay before the page gives up.
const POLL_WINDOW_MS={quick:240000,deep:900000};
const UNDERRATED='Underrated find';
// A failed session check is retried by the next search instead of failing every later one.
let ready=null;
function session(){return ready??=api('/api/session').catch(error=>{ready=null;throw error;});}
session().catch(()=>{});
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function safeURL(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u:null;}catch{return null;}}
function link(url,text){const u=safeURL(url);if(!u)throw Error('Invalid link');const a=node('a',text);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function api(url,options={}){let response;
 try{response=await fetch(url,{credentials:'same-origin',...options});}
 catch(error){if(error.name==='AbortError')throw error;throw Object.assign(Error('Cannot reach the search service. Check your connection and retry.'),{network:true});}
 if(!response.ok){const data=await response.json().catch(()=>null);throw Error(data?.error?.message??'Search is unavailable. Please retry.');}return response.status===204?null:response.json();}
function duration(seconds){const s=Math.round(seconds),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${r}`:`${m}:${r}`;}
function thumbnail(item){
 const wrap=node('div',undefined,'thumb-wrap');
 const source=safeURL(item.thumbnail);
 const src=source?`/api/thumbnail?${new URLSearchParams({url:source.href})}`:item.preview&&searchId?`/api/search/${encodeURIComponent(searchId)}/previews/${encodeURIComponent(item.id)}`:null;
 if(src){const img=node('img');img.src=src;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.remove());wrap.append(img);}
 if(item.duration)wrap.append(node('span',duration(item.duration),'badge duration'));
 return wrap;
}
function card(item){
 const article=node('article',undefined,'card');article.dataset.id=item.id;
 article.append(thumbnail(item));
 article.append(node('div',`${item.source_name} · ${item.origin==='catalogue'?'Catalogue':'External discovery'}`,'meta'));
 const heading=node('h3');heading.append(link(item.canonical_url,item.title));article.append(heading);
 const details=[item.creator,item.duration?duration(item.duration):null,item.published_at?new Date(item.published_at).toLocaleDateString():null].filter(Boolean);
 if(details.length)article.append(node('div',details.join(' · '),'details'));
 for(const badge of item.badges??[])article.append(node('span',badge,badge===UNDERRATED?'badge gem':'badge highlight'));
 article.append(node('span',item.evidence.replaceAll('_',' '),'badge'),node('span',`Rights: ${item.rights_status}`,'badge'));
 if(item.judgement)article.append(node('p',`Why this matches (${item.judgement.relevance}/10): ${item.judgement.reason}`,'why'));
 if(item.description)article.append(node('p',item.description));
 for(const moment of item.moments){
  const passage=node('div',undefined,'moment');
  if(moment.evidence_type==='viewer_timestamp'){
   passage.append(node('strong',`Viewers point to ${duration(moment.start_seconds)} – ${duration(moment.end_seconds)}`));
   for(const said of moment.summary.split(' · '))passage.append(node('p',`“${said}”`,'quote'));
  }else{
   passage.append(node('strong',`${moment.start_seconds}s – ${moment.end_seconds}s · ${moment.evidence_type.replaceAll('_',' ')}${moment.scene?` · ${moment.scene.model}`:''}`));
   passage.append(node('p',moment.summary));
  }
  if(moment.scene){
   for(const tag of moment.scene.tags)passage.append(node('span',tag,'badge'));
   if(moment.scene.dialogue)passage.append(node('p',`Subtitles: “${moment.scene.dialogue}”`,'quote'));
   const offset=moment.scene.timeline_offset_seconds;
   passage.append(node('div',`Version ${moment.scene.media_version}${offset?` · media ${moment.scene.media_start_seconds}s – ${moment.scene.media_end_seconds}s, offset ${offset>0?'+':''}${offset}s`:''}`,'meta'));
  }
  const url=new URL(item.canonical_url);if(url.hostname==='www.youtube.com'&&url.pathname==='/watch'){url.searchParams.set('t',String(Math.floor(moment.start_seconds)));passage.append(link(url.href,'Open timestamp ↗'));}
  article.append(passage);
 }
 if(item.scene_analysis&&item.scene_analysis.status!=='complete')article.append(node('p',item.scene_analysis.message,'notice'));
 const message=node('span','');
 for(const [text,useful] of [['Useful',true],['Not useful',false]]){const button=node('button',text,'secondary');
  const cardSearchId=searchId;button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'CreatorSearch'},body:JSON.stringify({search_id:cardSearchId,content_id:item.id,useful})});message.textContent='Feedback saved';}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});article.append(button);}
 article.append(message);return article;
}
// Returns the card for a result, redrawing it in place when the result changed. Results with unsafe links get no card.
function cardFor(item){
 const json=JSON.stringify(item),known=cards.get(item.id);
 if(known?.json===json)return known.el;
 let el;try{el=card(item);}catch{return null;}
 if(known)known.el.replaceWith(el);
 cards.set(item.id,{el,json});
 return el;
}
function showCatalogue(items){
 for(const item of items)if(item.origin==='catalogue'){const el=cardFor(item);if(el&&!el.isConnected)catalogueBox.append(el);}
}
// Discovered results follow the server's order: new finds are added at the end, and a finished search reorders its own finds.
function showIn(box,items){
 const keep=new Set();let previous=null;
 for(const item of items){
  const el=cardFor(item);if(!el)continue;keep.add(el);
  const expected=previous?previous.nextElementSibling:box.firstElementChild;
  if(el!==expected)box.insertBefore(el,expected);
  previous=el;
 }
 for(const el of [...box.children])if(!keep.has(el))el.remove();
}
function showFound(items){
 showIn(foundBox,items.filter(item=>!item.deep_find));showIn(deepBox,items.filter(item=>item.deep_find));
 for(const [id,entry] of cards)if(!entry.el.isConnected)cards.delete(id);
}
function progressText(data){
 if(data.depth==='deep')return data.stage==='checking'?'Deep dive: checking its finds, viewer comments and Reddit, then ranking them with AI…'
  :data.stage==='following'?'Deep dive: following leads from what it found…':'Deep dive: searching niche platforms and later result pages…';
 return data.stage==='checking'?'Checking pages, viewer comments and Reddit, then ranking with AI…':'Searching external sources…';
}
function showDeepHeading(data,busy){
 const count=deepBox.children.length,gems=deepBox.querySelectorAll('.badge.gem').length;
 deepHeading.hidden=data.depth!=='deep'||(!busy&&!count);
 deepHeading.replaceChildren('Deep dive finds',node('span',busy?`${count} so far`:count?`${count} new${gems?` · ${gems} underrated`:''}`:''));
}
const shownCount=()=>catalogueBox.children.length+foundBox.children.length+deepBox.children.length;
function render(data){
 searchId=data.search_id;catalogueTotal=data.catalogue_total;
 showCatalogue(data.results);showFound(data.discovered);
 notices.replaceChildren(...data.providers.filter(p=>p.status!=='ok').map(p=>node('p',p.message,'notice')));
 const busy=data.status==='discovering',partial=data.status==='partial',deepDone=data.depth==='deep';
 cancel.hidden=!busy;
 more.hidden=!(next&&pageEnd<catalogueTotal);
 deepRow.hidden=busy||deepDone||data.status==='cancelled'||params.get('mode')==='catalogue';
 showDeepHeading(data,busy);
 const count=shownCount();
 const label=`${count} ${count===1?'result':'results'}`;
 status.textContent=busy?`${label} so far. ${progressText(data)}`
  :count?`${label} · ${deepDone?(partial?'Deep dive finished; some services were unavailable':'Deep dive complete'):partial?'Some search services are unavailable':'Search complete'}`
  :partial?'No catalogue matches. Discovery is unavailable or incomplete.':'No matching results. Try another query or broader filters.';
}
async function poll(token,deadline,misses=0){if(!controller.current(token.generation))return;
 if(Date.now()>deadline){cancel.hidden=true;retry.hidden=false;const count=shownCount();
  status.textContent=`${count} ${count===1?'result':'results'} so far. External sources are taking longer than expected; retry to check again.`;return;}
 try{const data=await api(`/api/search/${searchId}`,{signal:token.signal});if(!controller.current(token.generation))return;
  // Polling reads the first page; once later pages are loaded, keep their cursor.
  if(pageEnd<=PAGE)next=data.next_cursor;
  render(data);
  if(data.status==='discovering')pollTimer=setTimeout(()=>poll(token,deadline),1500);
 }catch(error){if(!controller.current(token.generation))return;
  // A brief outage, such as the service restarting, should not end the search.
  if(error.network&&misses<5){pollTimer=setTimeout(()=>poll(token,deadline,misses+1),3000);return;}
  status.textContent=error.message;retry.hidden=false;}
}
function follow(token,data){
 next=data.next_cursor;pageEnd=PAGE;render(data);
 if(data.status==='discovering')pollTimer=setTimeout(()=>poll(token,Date.now()+POLL_WINDOW_MS[data.depth]),1500);
}
async function search(){clearTimeout(pollTimer);const previous=searchId;current=controller.begin();const token=current;
 if(previous)void api(`/api/search/${previous}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});
 searchId=null;next=null;cards.clear();catalogueBox.replaceChildren();foundBox.replaceChildren();deepBox.replaceChildren();deepHeading.hidden=true;notices.replaceChildren();
 more.hidden=true;retry.hidden=true;cancel.hidden=true;deepRow.hidden=true;status.textContent='Searching the catalogue…';
 params=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));params.set('limit',String(PAGE));
 try{await session();const data=await api(`/api/search?${params}`,{signal:token.signal});if(controller.current(token.generation))follow(token,data);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}
// The deep search starts from everything already shown and keeps adding to the same grid.
async function digDeeper(){if(!searchId)return;
 clearTimeout(pollTimer);current=controller.begin();const token=current;
 deep.disabled=true;retry.hidden=true;status.textContent='Starting a deep search…';
 try{const data=await api(`/api/search/${encodeURIComponent(searchId)}/deep`,{method:'POST',headers:{'X-Requested-With':'CreatorSearch'},signal:token.signal});
  if(!controller.current(token.generation))return;
  params.set('depth','deep');follow(token,data);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;deepRow.hidden=false;}}
 finally{deep.disabled=false;}
}
function applyParamsFromURL(){for(const [key,value] of new URLSearchParams(window.location.search)){const field=form.elements.namedItem(key);if(field)field.value=value;}}
function runFromURL(){applyParamsFromURL();if(form.elements.namedItem('q').value)void search();else status.textContent='Enter a query to search the catalogue.';}
form.addEventListener('submit',event=>{event.preventDefault();
 const query=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 window.history.pushState(null,'',`/results.html?${query}`);
 void search();
});
retry.addEventListener('click',()=>void search());
deep.addEventListener('click',()=>void digDeeper());
// A page can hold only results already on screen (for example after a deep search restarts paging), so keep going until something new appears.
more.addEventListener('click',async()=>{if(!next)return;const token=current;more.disabled=true;
 try{
  for(let pages=0;next&&pages<10;pages++){
   const page=new URLSearchParams(params);page.set('cursor',next);
   const before=catalogueBox.children.length;
   const data=await api(`/api/search?${page}`,{signal:token.signal});if(!controller.current(token.generation))return;
   next=data.next_cursor;pageEnd+=PAGE;showCatalogue(data.results);
   if(catalogueBox.children.length>before||pageEnd>=catalogueTotal)break;
  }
  more.hidden=!(next&&pageEnd<catalogueTotal);
 }catch(error){if(controller.current(token.generation))status.textContent=error.message;}finally{more.disabled=false;}});
cancel.addEventListener('click',()=>{clearTimeout(pollTimer);controller.stop();cancel.hidden=true;status.textContent='Discovery updates stopped. Your current results remain available.';if(searchId)void api(`/api/search/${searchId}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});});
window.addEventListener('popstate',runFromURL);
runFromURL();
