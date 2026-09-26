import {SearchController} from './search-controller.js';
const form=document.querySelector('#search-form'),status=document.querySelector('#status'),notices=document.querySelector('#notices');
const catalogueBox=document.querySelector('#catalogue-results'),foundBox=document.querySelector('#found-results');
const deepBox=document.querySelector('#deep-results'),deepHeading=document.querySelector('#deep-heading');
const more=document.querySelector('#more'),retry=document.querySelector('#retry'),cancel=document.querySelector('#cancel');
const deepRow=document.querySelector('#deep-row'),deep=document.querySelector('#deep');
const missing=document.querySelector('#missing'),missingNote=document.querySelector('#missing-note'),missingStatus=document.querySelector('#missing-status');
const videoGrid=document.querySelector('#results'),imageGrid=document.querySelector('#image-results');
const imageMore=document.querySelector('#image-more'),resultsHeading=document.querySelector('#results-heading');
const tabVideos=document.querySelector('#tab-videos'),tabImages=document.querySelector('#tab-images');
const tabWeb=document.querySelector('#tab-web'),tabDocs=document.querySelector('#tab-docs');
const webList=document.querySelector('#web-results'),webMore=document.querySelector('#web-more'),huntSites=document.querySelector('#hunt-sites');
const TABS={videos:tabVideos,web:tabWeb,images:tabImages,docs:tabDocs};
const docViewer=document.querySelector('#doc-viewer'),docFrame=document.querySelector('#doc-frame'),docStatus=document.querySelector('#doc-viewer-status');
const docTitle=document.querySelector('#doc-viewer-title'),docSource=document.querySelector('#doc-viewer-source');
const docMore=document.querySelector('#doc-more'),docTools=document.querySelector('#doc-tools'),docPage=document.querySelector('#doc-page'),docScroll=document.querySelector('#doc-scroll');
let docRequest=null,pdfjs=null,pdfViewer=null,pdfDocument=null;
const matchTabs=document.querySelector('#match-tabs'),tabMatches=document.querySelector('#tab-matches'),tabClosest=document.querySelector('#tab-closest');
const closestPanel=document.querySelector('#closest-panel'),closestBox=document.querySelector('#closest-results');
const closestStatus=document.querySelector('#closest-status'),closestRetry=document.querySelector('#closest-retry');
let matchView='matches',closestSearch=null,closestLoaded=false,closestRequest=null,closestAbort=null,closestTimer=null,closestDeadline=0,lastSearchData=null;
const controller=new SearchController();
// Images come from a separate discovery-only endpoint, so they keep their own paging state
// rather than sharing the search snapshot's cursor.
let imagePage=1,imageBusy=false,webPage=1,webBusy=false;
const IMAGE_PAGE=48;
let searchId=null,next=null,params=null,pollTimer=null,current=null,pageEnd=0,catalogueTotal=0;
// Result id -> its card and the data it was drawn from, so a changed result is redrawn in place.
const cards=new Map();
const PAGE=20;
// Longer than the server's discovery windows, so the server reports a delay before the page gives up.
const POLL_WINDOW_MS={quick:240000,deep:900000};
const UNDERRATED='Underrated find';
// A failed session check is retried by the next search instead of failing every later one.
let ready=null;
function learn(id,body){return api(`/api/search/${id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'CreatorSearch'},body:JSON.stringify(body)});}
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
 const heading=node('h3'),title=link(item.canonical_url,item.title);heading.append(title);article.append(heading);
 const cardSearchId=searchId;
 title.addEventListener('click',()=>{learn(cardSearchId,{kind:'open',url:item.canonical_url}).catch(()=>{});});
 const details=[item.creator,item.duration?duration(item.duration):null,item.published_at?new Date(item.published_at).toLocaleDateString():null].filter(Boolean);
 if(details.length)article.append(node('div',details.join(' · '),'details'));
 for(const badge of item.badges??[])article.append(node('span',badge,badge===UNDERRATED?'badge gem':'badge highlight'));
 article.append(node('span',item.evidence.replaceAll('_',' '),'badge'),node('span',`Rights: ${item.rights_status}`,'badge'));
 if(item.judgement)article.append(node('p',`${item.badges?.includes('Closest match')?'Why this may be related':'Why this matches'} (${item.judgement.relevance}/10): ${item.judgement.reason}`,'why'));
 else if(item.origin==='discovery')article.append(node('p','Relevance has not been checked.','hint'));
 // Each requirement with the evidence behind it; unconfirmed ones are said plainly, never shown as met.
 if(item.requirements?.length){
  const chips=node('div',undefined,'requirements');
  const mark={supported:'✓',contradicted:'✗',unknown:'?',waived:'≈'};
  for(const r of item.requirements){const chip=node('span',`${mark[r.status]??'?'} ${r.text}`,`badge req ${r.status}`);
   chip.title=r.excerpt?`Evidence (${(r.method??'').replaceAll('_',' ')}): ${r.excerpt}`:'No evidence found yet';chips.append(chip);}
  article.append(chips);
 }
 for(const note of item.uncertainties??[])article.append(node('p',note,'hint uncertain'));
 if(item.description)article.append(node('p',item.description));
 for(const moment of item.moments){
  const passage=node('div',undefined,'moment');
  if(moment.evidence_type==='viewer_timestamp'){
   passage.append(node('strong',`Viewers point to ${duration(moment.start_seconds)} – ${duration(moment.end_seconds)}`));
   for(const said of moment.summary.split(' · '))passage.append(node('p',`“${said}”`,'quote'));
  }else{
   const [from,to]=moment.focus??[moment.start_seconds,moment.end_seconds];
   passage.append(node('strong',`${duration(from)} – ${duration(to)} · ${moment.evidence_type.replaceAll('_',' ')}${moment.scene?` · ${moment.scene.model}`:''}`));
   if(moment.focus)passage.append(node('div',`Best match within the transcript passage ${duration(moment.start_seconds)} – ${duration(moment.end_seconds)}`,'meta'));
   passage.append(node('p',moment.summary));
  }
  if(moment.scene){
   for(const tag of moment.scene.tags)passage.append(node('span',tag,'badge'));
   if(moment.scene.dialogue)passage.append(node('p',`Subtitles: “${moment.scene.dialogue}”`,'quote'));
   const offset=moment.scene.timeline_offset_seconds;
   passage.append(node('div',`Version ${moment.scene.media_version}${offset?` · media ${moment.scene.media_start_seconds}s – ${moment.scene.media_end_seconds}s, offset ${offset>0?'+':''}${offset}s`:''}`,'meta'));
  }
  const url=new URL(item.canonical_url);if(url.hostname==='www.youtube.com'&&url.pathname==='/watch'){url.searchParams.set('t',String(Math.floor(moment.focus?.[0]??moment.start_seconds)));passage.append(link(url.href,'Open timestamp ↗'));}
  article.append(passage);
 }
 if(item.scene_analysis&&item.scene_analysis.status!=='complete')article.append(node('p',item.scene_analysis.message,'notice'));
 // Votes and reasons teach the engine's learning loop; they work on every result, saved in the catalogue or not.
 const message=node('span',''),reasons=node('div',undefined,'reasons');reasons.hidden=true;
 const vote=async(body,done)=>{try{await learn(cardSearchId,{url:item.canonical_url,...body});message.textContent=done;}catch(error){message.textContent=error.message;}};
 for(const [text,useful] of [['Useful',true],['Not useful',false]]){const button=node('button',text,'secondary');
  button.addEventListener('click',async()=>{button.disabled=true;await vote({useful},useful?'Thanks, noted':'Noted. Why? (optional)');reasons.hidden=useful;button.disabled=false;});article.append(button);}
 for(const [text,reason] of [['Off-topic','off_topic'],['Low quality','low_quality'],['Wrong format','wrong_format'],['Duplicate','duplicate']]){
  const chip=node('button',text,'secondary small');chip.addEventListener('click',async()=>{await vote({useful:false,reason},`Noted: ${text.toLowerCase()}`);reasons.hidden=true;});reasons.append(chip);}
 article.append(message,reasons);return article;
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
// Keep every card in the server's combined rank order, including on completion of a deep search.
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
 showIn(foundBox,items);deepBox.replaceChildren();
 for(const [id,entry] of cards)if(!entry.el.isConnected)cards.delete(id);
}
function progressText(data){
 if(data.depth==='deep')return data.stage==='checking'?'Deep dive: checking its finds, viewer comments and Reddit, then ranking them with AI…'
  :data.stage==='following'?'Deep dive: following leads from what it found…':'Deep dive: searching niche platforms and later result pages…';
 return data.stage==='checking'?'Checking pages, viewer comments and Reddit, then ranking with AI…':'Searching external sources…';
}
function showDeepHeading(data,busy){
 deepHeading.hidden=true;
}
const shownCount=()=>catalogueBox.children.length+foundBox.children.length+deepBox.children.length;
function resetClosest(resetView=true){
 clearTimeout(closestTimer);closestDeadline=0;
 closestAbort?.abort();closestAbort=null;closestRequest=null;closestSearch=null;closestLoaded=false;
 closestBox.replaceChildren();closestRetry.hidden=true;closestPanel.removeAttribute('aria-busy');
 closestStatus.textContent='Select this tab to load closest matches.';
 if(resetView)matchView='matches';
}
function showMatchView(){
 const images=tabOf(window.location.search)!=='videos',closest=matchView==='closest';
 matchTabs.hidden=images;closestPanel.hidden=images||!closest;videoGrid.hidden=images||closest;
 status.hidden=!images&&closest;
 if(!images)resultsHeading.textContent=closest?'Closest matches':'Search results';
 for(const [button,selected] of [[tabMatches,!closest],[tabClosest,closest]]){
  button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected);
 }
 if(closest&&!images)more.hidden=true;
}
async function loadClosest(){
 if(matchView!=='closest'||tabOf(window.location.search)!=='videos')return;
 if(!searchId){closestStatus.textContent='Run a search to see closest matches.';return;}
 if(!current||!controller.current(current.generation)){closestStatus.textContent='Discovery updates were stopped. Start another search to see closest matches.';return;}
 if(closestSearch!==searchId){resetClosest(false);closestSearch=searchId;}
 if(closestLoaded||closestRequest)return;
 clearTimeout(closestTimer);
 closestDeadline ||= Date.now()+POLL_WINDOW_MS[lastSearchData?.depth??'quick'];
 if(Date.now()>closestDeadline){closestStatus.textContent='Discovery is taking longer than expected. Retry to check for closest matches.';closestRetry.hidden=false;return;}
 const request={id:searchId,generation:current.generation};closestRequest=request;closestAbort=new AbortController();
 closestPanel.setAttribute('aria-busy','true');closestRetry.hidden=true;closestStatus.textContent='Loading closest matches…';
 const valid=()=>closestRequest===request&&searchId===request.id&&controller.current(request.generation)&&matchView==='closest';
 try{
  const data=await api(`/api/search/${encodeURIComponent(request.id)}/closest`,{signal:closestAbort.signal});
  if(!valid())return;
  closestLoaded=data.status!=='pending';
  closestStatus.textContent=autoClosest===request.id&&data.status==='ready'&&data.results.length?UNVERIFIED_INTRO:data.message;
  if(data.status==='pending')closestTimer=setTimeout(()=>void loadClosest(),1500);
  // Separate cards prevent an optional result from moving into the main results during polling.
  closestBox.replaceChildren(...data.results.flatMap(item=>{try{return [card(item)];}catch{return [];}}));
 }catch(error){if(valid()&&error.name!=='AbortError'){closestStatus.textContent=error.message;closestRetry.hidden=false;}}
 finally{if(closestRequest===request){closestRequest=null;closestPanel.removeAttribute('aria-busy');}}
}
function selectMatchView(view){
 matchView=view;
 if(view==='matches'){
  clearTimeout(closestTimer);
  closestAbort?.abort();closestRequest=null;closestPanel.removeAttribute('aria-busy');
  if(lastSearchData)render(lastSearchData);
 }
 showMatchView();if(view==='closest')void loadClosest();
}
tabMatches.addEventListener('click',()=>selectMatchView('matches'));
tabClosest.addEventListener('click',()=>selectMatchView('closest'));
closestRetry.addEventListener('click',()=>{closestDeadline=0;void loadClosest();});
matchTabs.addEventListener('keydown',event=>{
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const view=event.key==='Home'?'matches':event.key==='End'?'closest':matchView==='closest'?'matches':'closest';
 selectMatchView(view);(view==='closest'?tabClosest:tabMatches).focus();
});
// How the engine read the request: its requirements, the assumptions it made instead of asking, and what it could
// not satisfy. Every stage of the search worked from this reading.
function interpretation(info){
 const box=node('section',undefined,'interpretation');
 box.append(node('strong','Interpreted as: '),node('span',info.intent));
 const must=info.requirements.filter(r=>r.hardness==='hard'),nice=info.requirements.filter(r=>r.hardness!=='hard');
 if(must.length){const list=node('ul');for(const r of must)list.append(node('li',`${r.text}${r.scope==='set'?' (across the results)':''}`));box.append(node('p','Every result must:','hint'),list);}
 if(nice.length)box.append(node('p',`Preferred: ${nice.map(r=>r.text).join('; ')}`,'hint'));
 for(const a of info.assumptions)box.append(node('p',`Assumed: ${a}`,'hint'));
 if(info.unmet.length){const list=node('ul');for(const u of info.unmet)list.append(node('li',u));box.append(node('p','Not satisfied:','notice'),list);}
 return box;
}
function render(data){
 lastSearchData=data;
 if(searchId!==data.search_id)resetClosest(false);
 searchId=data.search_id;catalogueTotal=data.catalogue_total;
 catalogueBox.replaceChildren();showFound(data.ranked??[...data.results.filter(r=>r.origin==='catalogue'),...data.discovered]);
 notices.replaceChildren(...(data.interpretation?[interpretation(data.interpretation)]:[]),
  ...data.providers.filter(p=>p.status!=='ok'||p.provider==='relevance_filter'||p.provider==='video_inspection'||p.message.includes('did not')).map(p=>node('p',p.message,'notice')));
 const busy=data.status==='discovering',partial=data.status==='partial',deepDone=data.depth==='deep';
 cancel.hidden=!busy;
 missing.hidden=busy;if(missing.dataset.search!==data.search_id){missing.dataset.search=data.search_id;missingStatus.textContent='';}
 more.hidden=!!data.ranked||!(next&&pageEnd<catalogueTotal);
 deepRow.hidden=busy||deepDone||data.status==='cancelled'||params.get('mode')==='catalogue';
 showDeepHeading(data,busy);
 const count=shownCount();
 const label=`${count} ${count===1?'result':'results'}`;
 status.textContent=busy?`${label} so far. ${progressText(data)}`
  :count?`${label} · ${deepDone?(partial?'Deep dive finished; some services were unavailable':'Deep dive complete'):partial?'Some search services are unavailable':'Search complete'}`
  :partial?'No catalogue matches. Discovery is unavailable or incomplete.':'No matching results. Try another query or broader filters.';
 // A finished discovery with nothing verified opens the unverified candidates instead of an empty page (once per search,
 // so choosing "Matches" again is respected).
 if(!busy&&!count&&data.discovery_job_id&&data.status!=='cancelled'&&matchView==='matches'&&autoClosest!==data.search_id){
  autoClosest=data.search_id;matchView='closest';
 }
 showMatchView();if(matchView==='closest'&&closestRetry.hidden)void loadClosest();
}
let autoClosest=null;
const UNVERIFIED_INTRO='No result could be verified. These candidates may match: each shows which requirements are confirmed (✓) and which are still unverified (?).';
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
 resetClosest();lastSearchData=null;showMatchView();
 if(previous)void api(`/api/search/${previous}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});
 searchId=null;next=null;cards.clear();catalogueBox.replaceChildren();foundBox.replaceChildren();deepBox.replaceChildren();deepHeading.hidden=true;notices.replaceChildren();
 more.hidden=true;retry.hidden=true;cancel.hidden=true;deepRow.hidden=true;status.textContent='Searching the catalogue…';
 params=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));params.delete('doc_type');params.set('limit',String(PAGE));
 try{await session();const data=await api(`/api/search?${params}`,{signal:token.signal});if(controller.current(token.generation))follow(token,data);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}
// The deep search starts from existing results and replaces their order when its checks finish.
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

// ---- images ---------------------------------------------------------------------------------
// Videos run the full evidence pipeline; web, images and docs are discovery-only lists from their own endpoints.
const tabOf=search=>{const tab=new URLSearchParams(search).get('tab');return tab in TABS?tab:'videos';};
// The tab the URL names, or null when none was chosen for this query yet (a new search, or an older link).
const chosenTab=search=>{const tab=new URLSearchParams(search).get('tab');return tab in TABS?tab:null;};
const labelOf=field=>form.elements.namedItem(field)?.closest('label');

// Keeps the tab links pointing at the current query, so they stay shareable and middle-clickable
// instead of being buttons that only work through JavaScript.
function syncTabs(tab){
 const base=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 base.delete('tab');
 base.delete('doc_type');
 for(const [name,anchor] of Object.entries(TABS)){
  const query=new URLSearchParams(base);query.set('tab',name);
  if(name==='docs'&&form.elements.namedItem('doc_type').value)query.set('doc_type',form.elements.namedItem('doc_type').value);
  anchor.href=`/results.html?${query}`;anchor.classList.toggle('tab--active',tab===name);
  if(tab===name)anchor.setAttribute('aria-current','page');else anchor.removeAttribute('aria-current');
 }
 // Catalogue mode, evidence and the deep dive are all properties of the video pipeline; the other
 // tabs never touch it, so the controls would be inert.
 const list=tab!=='videos',pages=tab==='web'||tab==='docs';
 for(const field of ['mode','evidence'])labelOf(field)?.toggleAttribute('hidden',list);
 labelOf('doc_type')?.toggleAttribute('hidden',tab!=='docs');
 videoGrid.hidden=list;imageGrid.hidden=tab!=='images';webList.hidden=!pages;huntSites.hidden=true;
 resultsHeading.textContent={videos:'Search results',web:'Web results',images:'Image results',docs:'Documents'}[tab];
 if(list){deepRow.hidden=true;cancel.hidden=true;more.hidden=true;missing.hidden=true;}
 if(tab!=='images')imageMore.hidden=true;
 if(!pages)webMore.hidden=true;
 if(tab!=='docs')closePreview();
 showMatchView();
}

function imageTile(item){
 const page=safeURL(item.page_url),source=safeURL(item.thumbnail)??safeURL(item.image_url);
 if(!page||!source)return null;
 const tile=node('a',undefined,'image-tile');
 tile.href=page.href;tile.target='_blank';tile.rel='noopener noreferrer';
 const img=node('img');
 img.src=`/api/thumbnail?${new URLSearchParams({url:source.href})}`;
 img.alt=item.title||'';img.loading='lazy';
 // A tile whose image will not load is worse than no tile: it leaves a caption over a gap.
 img.addEventListener('error',()=>tile.remove());
 if(item.width&&item.height)img.style.aspectRatio=`${item.width} / ${item.height}`;
 tile.append(img);
 const meta=node('span',undefined,'image-tile-meta');
 // The server falls back to the hostname when an engine titles an image with its filename,
 // so skip the title line when it would just repeat the host below it.
 if(item.title&&item.title!==item.source_name)meta.append(node('span',item.title,'image-tile-title'));
 meta.append(node('span',item.source_name,'image-tile-host'));
 tile.append(meta);
 return tile;
}

async function searchImagesPage(token,append){
 const query=new URLSearchParams();
 query.set('q',form.elements.namedItem('q').value);
 query.set('limit',String(IMAGE_PAGE));query.set('page',String(imagePage));
 const language=form.elements.namedItem('language')?.value;
 if(language)query.set('language',language);
 const data=await api(`/api/images?${query}`,{signal:token.signal});
 if(!controller.current(token.generation))return;
 if(!append)imageGrid.replaceChildren();
 const tiles=data.results.map(imageTile).filter(Boolean);
 imageGrid.append(...tiles);
 notices.replaceChildren(...data.providers.filter(p=>p.status!=='ok').map(p=>node('p',p.message,'notice')));
 imageMore.hidden=!data.next_cursor||!data.results.length;
 const count=imageGrid.children.length;
 status.textContent=count?`${count} ${count===1?'image':'images'}`:'No images found. Try another query.';
}

async function runImageSearch(){
 clearTimeout(pollTimer);current=controller.begin();const token=current;
 resetClosest();lastSearchData=null;showMatchView();
 imagePage=1;imageGrid.replaceChildren();notices.replaceChildren();
 imageMore.hidden=true;retry.hidden=true;status.textContent='Searching for images…';
 try{await session();await searchImagesPage(token,false);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}

// ---- web and documents ----------------------------------------------------------------------
const DOC_LABELS={pdf:'PDF',doc:'Word',docx:'Word',odt:'OpenDocument',rtf:'RTF',ppt:'PowerPoint',pptx:'PowerPoint',odp:'OpenDocument slides',
 key:'Keynote',xls:'Excel',xlsx:'Excel',ods:'OpenDocument sheet',csv:'CSV',epub:'EPUB'};
// Every Docs result is the document file itself. Clicking its title previews the first pages here (/api/doc fetches it
// from its source, converted to PDF when it is an office file); the whole document is one click away at its source,
// where a PDF opens in the browser and other files download.
const fullDocument=item=>{
 const a=link(item.url,item.doc_type==='pdf'?'Open full document ↗':`Download ${item.doc_type?.toUpperCase()??'file'} ↓`);
 a.className='doc-action';return a;
};
// PDF.js draws the pages itself, so previews look the same everywhere, including phone browsers that cannot show a PDF inline.
// It loads only when the first document is opened.
const PDFJS='/vendor/pdfjs/';
async function pdfViewerReady(){
 if(pdfViewer)return pdfViewer;
 const lib=await import(`${PDFJS}build/pdf.min.mjs`);
 lib.GlobalWorkerOptions.workerSrc=`${PDFJS}build/pdf.worker.min.mjs`;
 globalThis.pdfjsLib=lib; // pdf_viewer.mjs reads the core library from here.
 const viewer=await import(`${PDFJS}web/pdf_viewer.mjs`);
 const eventBus=new viewer.EventBus();
 const linkService=new viewer.PDFLinkService({eventBus,externalLinkTarget:viewer.LinkTarget.BLANK,externalLinkRel:'noopener noreferrer nofollow'});
 pdfViewer=new viewer.PDFViewer({container:docScroll,viewer:document.querySelector('#doc-pdf'),eventBus,linkService});
 linkService.setViewer(pdfViewer);
 pdfjs={lib,linkService};
 eventBus.on('pagesinit',()=>{pdfViewer.currentScaleValue='page-width';});
 eventBus.on('pagechanging',({pageNumber})=>{docPage.textContent=`${pageNumber} / ${pdfViewer.pagesCount}`;});
 // Keep "fit width" true when the panel changes size (window resize, phone rotation).
 new ResizeObserver(()=>{if(pdfViewer.pagesCount&&pdfViewer.currentScaleValue==='page-width')pdfViewer.currentScaleValue='page-width';}).observe(docScroll);
 return pdfViewer;
}
async function showPdf(bytes){
 const viewer=await pdfViewerReady();
 const next=await pdfjs.lib.getDocument({data:bytes,cMapUrl:`${PDFJS}cmaps/`,cMapPacked:true,standardFontDataUrl:`${PDFJS}standard_fonts/`,
  wasmUrl:`${PDFJS}wasm/`,iccUrl:`${PDFJS}iccs/`}).promise;
 const previous=pdfDocument;pdfDocument=next;
 viewer.setDocument(next);pdfjs.linkService.setDocument(next,null);
 docPage.textContent=`1 / ${next.numPages}`;
 releaseDocument(previous);
}
// Frees a loaded PDF; in this pdf.js version that goes through its loading task, and a failure must never break the page.
function releaseDocument(doc){try{void (doc?.loadingTask?.destroy?.()??doc?.destroy?.());}catch{/* already released */}}
// Closes the preview with the way to the rest: "Showing 5 of 30 pages" and the one-click full document.
function previewEnd(item,shown,total){
 docMore.replaceChildren();docMore.hidden=!(total>shown);
 if(docMore.hidden)return;
 docMore.append(node('p',`Preview: the first ${shown} of ${total} pages.`),fullDocument(item));
}
function closePreview(){docRequest?.abort();docRequest=null;docViewer.hidden=true;docFrame.hidden=true;docTools.hidden=true;docMore.hidden=true;
 if(pdfDocument){pdfViewer.setDocument(null);releaseDocument(pdfDocument);pdfDocument=null;}
 for(const row of webList.querySelectorAll('.web-item.selected'))row.classList.remove('selected');}
async function openPreview(item,row){
 docRequest?.abort();const request=docRequest=new AbortController();
 for(const other of webList.querySelectorAll('.web-item.selected'))other.classList.remove('selected');
 row.classList.add('selected');
 docViewer.hidden=false;docFrame.hidden=true;docTools.hidden=true;docMore.hidden=true;
 docTitle.textContent=item.title;docSource.replaceChildren(fullDocument(item));
 docStatus.textContent=item.doc_type==='pdf'?'Loading the document…':'Fetching and converting the document…';
 if(!window.matchMedia('(min-width: 900px)').matches)docViewer.scrollIntoView({block:'start'});
 const src=`/api/doc?${new URLSearchParams({url:item.url,t:item.preview})}`;
 try{
  const response=await fetch(src,{credentials:'same-origin',signal:request.signal});
  if(!response.ok){const data=await response.json().catch(()=>null);throw Error(data?.error?.message??'This document could not be shown. Open it from its source.');}
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(request!==docRequest)return;
  docFrame.hidden=false;
  await showPdf(bytes);
  if(request!==docRequest)return;
  const total=Number(response.headers.get('X-Document-Pages')),shown=Number(response.headers.get('X-Preview-Pages'));
  previewEnd(item,shown,total);
  if(total>shown)docPage.dataset.total=` · preview of ${total} pages`;else delete docPage.dataset.total;
  docStatus.textContent='';docTools.hidden=false;
 }catch(error){
  if(error.name==='AbortError'||request!==docRequest)return;
  docFrame.hidden=true;
  docStatus.textContent=error.name==='InvalidPDFException'?'This document could not be read. Open it from its source.':error.message;
 }
}
// Search engines add the site's name to titles ("… · GitHub", "YouTube - …"). Leading or trailing segments that only
// repeat the site are dropped so the heading keeps the meaningful part; the full title stays in the tooltip.
function cleanTitle(title,host,source){
 // Names compare without spaces or punctuation, against the site and each label of its host ("Chrome Web Store" is
 // chromewebstore.google.com, "Medium" is annabyang.medium.com).
 const bare=text=>text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const labels=host.toLowerCase().replace(/^www\./,'').split('.');
 const brands=new Set([bare(labels.join('.')),...labels.slice(0,-1).map(bare),bare(source??'')].filter(Boolean));
 let text=title.trim();
 for(let changed=true;changed;){
  changed=false;
  const tail=text.match(/^(.*\S)\s+[·|–—-]\s+([^·|–—]+)$/);
  if(tail&&brands.has(bare(tail[2]))){text=tail[1];changed=true;continue;}
  // A leading name is often the product itself ("Youtube to Transcript - …"), so only a one-word site name ("GitHub - …") goes.
  const head=text.match(/^(\S+)\s+[·|–—-]\s+(\S.*)$/);
  if(head&&brands.has(bare(head[1]))){text=head[2];changed=true;}
 }
 return text||title;
}
const QUERY_STOPWORDS=new Set(['the','and','for','with','from','that','this','what','how','are','was','you','your','into','about','videos','video']);
const queryWords=query=>[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[])].filter(w=>!QUERY_STOPWORDS.has(w));
// A heading's main keyword is its name: the text before ": " or the first " · ", " - " or " | ". It goes on the pink
// stroke. Of the description after it, the one sentence sharing the most query words (the first on a tie) goes on marine
// blue, if it is a real sentence of four words or more; the rest stays plain. A heading with no name part is all name.
function headingParts(text,query){
 const split=text.match(/^(.{1,80}?)(:\s+|\s+[·|–—-]\s+)(\S.*)$/);
 if(!split)return [node('span',text,'title-key')];
 const [,name,separator,description]=split,words=queryWords(query);
 const pieces=description.split(/((?<=[.!?])\s+)/),sentences=pieces.filter((_,i)=>i%2===0);
 const score=s=>words.filter(w=>s.toLowerCase().includes(w)).length;
 const lead=sentences.reduce((best,s)=>score(s)>score(best)?s:best,sentences[0]);
 const parts=[node('span',name,'title-key'),document.createTextNode(separator)];
 let marked=false;
 for(const [i,piece] of pieces.entries()){
  if(i%2===0&&!marked&&piece===lead&&piece.split(/\s+/).length>=4){parts.push(node('span',piece,'title-lead'));marked=true;}
  else if(piece)parts.push(document.createTextNode(piece));
 }
 return parts;
}
function webItem(item){
 const url=safeURL(item.url);if(!url)return null;
 const row=node('article',undefined,'web-item');row.dataset.id=item.id;
 const head=node('div',undefined,'web-item-source');
 const source=link(url.href,item.source_name);source.className='web-item-host';head.append(source);
 if(item.doc_type)head.append(node('span',item.doc_type==='viewer'?item.viewer??'Document viewer':DOC_LABELS[item.doc_type]??item.doc_type.toUpperCase(),'badge'));
 if(item.access)head.append(node('span',item.access,'badge'));
 if(item.walled){const b=node('span','Preview','badge badge-preview');b.title=`${item.walled.host} asks visitors to sign in; ZenAtlas shows this result without it.`;head.append(b);}
 if(item.check==='blocked'){const b=node('span','Unverified','badge');b.title='This site refused an automated check, so the file could not be confirmed.';head.append(b);}
 if(item.published)head.append(node('span',new Date(item.published).toLocaleDateString(),'meta'));
 const title=node('h3'),heading=cleanTitle(item.title,url.hostname,item.source_name);
 const query=form.elements.namedItem('q').value;
 if(item.preview){
  // The parts sit in spans: a button cannot break into per-line highlight bars, inline spans can.
  const open=node('button',undefined,'web-item-open');open.type='button';open.append(...headingParts(heading,query));
  open.addEventListener('click',()=>void openPreview(item,row));
  title.append(open);
 }else{const a=link(url.href,'');a.append(...headingParts(heading,query));title.append(a);
  // A login-walled result opens in the login-free preview; a modified click still opens the site.
  if(item.walled)walledRow(row,item,a);}
 if(heading!==item.title)title.title=item.title;
 row.append(head,title);
 // A document found inside a website shows the pages that led to it.
 if(item.found_via?.length)row.append(node('div',`Found via ${item.found_via.map(v=>v.title).join(' › ')}`,'web-item-via'));
 if(item.snippet)row.append(node('p',item.snippet));
 // A document result opens the file in one click; a web result's title is already its link.
 if(item.doc_type){const actions=node('div',undefined,'web-item-actions');
  if(item.preview){const open=node('button','Preview','secondary');open.type='button';open.addEventListener('click',()=>void openPreview(item,row));actions.append(open);}
  actions.append(fullDocument(item));row.append(actions);}
 return row;
}
async function searchWebPage(token,kind,append){
 const query=new URLSearchParams({q:form.elements.namedItem('q').value,kind,page:String(webPage)});
 const language=form.elements.namedItem('language')?.value;if(language)query.set('language',language);
 const docType=form.elements.namedItem('doc_type')?.value;if(kind==='docs'&&docType)query.set('doc_type',docType);
 const data=await api(`/api/web?${query}`,{signal:token.signal});
 if(!controller.current(token.generation))return;
 if(!append){closeWalled();webList.replaceChildren();closePreview();walledSeen=0;}
 const rows=data.results.map(webItem).filter(Boolean),page=webPage;
 for(const row of rows)row.dataset.page=String(page);
 webList.append(...rows);
 // On a wide screen the first document that can be shown opens straight away, beside the list.
 const first=data.results.find(r=>r.preview);
 if(!append&&first&&window.matchMedia('(min-width: 900px)').matches)void openPreview(first,webList.querySelector('.web-item:has(.web-item-open)'));
 notices.replaceChildren(...data.providers.filter(p=>p.status!=='ok').map(p=>node('p',p.message,'notice')));
 webMore.hidden=!data.next_cursor;
 const count=webList.children.length,noun=kind==='docs'?['document','documents']:['result','results'];
 status.textContent=count?`${count} ${noun[count===1?0:1]}${data.hunt?' · searching further…':''}${data.review?' · checking relevance…':''}`
  :data.hunt?'Searching inside websites for documents…'
  :kind==='docs'?'No documents found. Try another query or document type.':'No results found. Try another query.';
 if(data.hunt)void followHunt(token,page,data.hunt);
 if(data.review)void followReview(token,page,data.review);
}
const VERDICTS={searching:'Searching…',document:'Document found',web_only:'On the page, no file',access:'Buy or borrow',not_found:'Not found'};
// The websites the document hunt looked inside, each with what it found there.
function renderSites(sites){
 huntSites.hidden=!sites.length;
 huntSites.replaceChildren(...(sites.length?[node('h3','Websites searched','hunt-sites-title'),...sites.map(s=>{
  const row=node('div',undefined,`hunt-site hunt-${s.verdict}`),host=link(s.url,s.host);host.className='web-item-host';
  row.append(host,node('span',s.title,'hunt-site-title'),node('span',s.verdict==='access'&&s.note?s.note:VERDICTS[s.verdict]??s.verdict,'hunt-site-verdict'));
  return row;})]:[]));
}
// A reviewed result whose page or file could not be opened is a lead: matched on its title and snippet only.
function markLead(row,item){
 if(!item?.lead||row.querySelector('.badge-lead'))return;
 const b=node('span','Lead · not opened','badge badge-lead');b.title='ZenAtlas could not open this page or file, so it was matched on its title and description only.';
 row.querySelector('.web-item-source')?.append(b);
}
// Removes the rows of one result page that a review rejected and orders the kept ones in place, as the review ranked them.
function reorderPage(page,items){
 const now=new Map([...webList.querySelectorAll(`.web-item[data-page="${page}"]`)].map(r=>[r.dataset.id,r])),kept=items.map(d=>now.get(d.id)).filter(Boolean);
 let before=[...now.values()][0]?.previousElementSibling??null;
 for(const row of now.values())if(!kept.includes(row)){if(row.classList.contains('selected'))closePreview();row.remove();}
 for(const row of kept){if(before)before.after(row);else webList.prepend(row);before=row;}
 return kept;
}
// The Web tab's relevance review, polled until it completes: pages that do not match are removed, the rest ranked, each
// with the judge's reason. A failed or expired poll leaves the search results as they are.
async function followReview(token,page,review){
 const settle=()=>{if(controller.current(token.generation))status.textContent=status.textContent.replace(' · checking relevance…','');};
 for(let polls=0;polls<50;polls++){
  await new Promise(resolve=>setTimeout(resolve,1200));
  if(!controller.current(token.generation))return;
  let snap;
  try{snap=await api(`/api/web/review?token=${encodeURIComponent(review)}`,{signal:token.signal});}catch{settle();return;}
  if(!controller.current(token.generation))return;
  if(snap.status!=='complete')continue;
  const byId=new Map(snap.results.map(r=>[r.id,r]));
  if(walledOpen&&!walledOpen.row.isConnected)closeWalled();
  for(const row of reorderPage(page,snap.results)){
   row.querySelector('.why')?.remove();
   const r=byId.get(row.dataset.id);markLead(row,r);
   if(r?.judgement)row.querySelector('h3').after(node('p',`Why this matches (${r.judgement.relevance}/10): ${r.judgement.reason}`,'why'));
  }
  for(const p of snap.providers)if(p.status!=='ok')notices.append(node('p',p.message,'notice'));
  const count=webList.children.length;
  status.textContent=count?`${count} ${count===1?'result':'results'}${snap.removed?` · ${snap.removed} removed as not matching`:''}`:'No page matched the request. Try another query.';
  placeWalled();
  return;
 }
 settle();
}
// The Docs tab's document hunt, polled until it completes. Documents Jev finds inside websites appear as they are
// confirmed; at the end, documents the review rejected are removed and the rest ordered by relevance, in place.
async function followHunt(token,page,hunt){
 const rowsOf=()=>new Map([...webList.querySelectorAll(`.web-item[data-page="${page}"]`)].map(r=>[r.dataset.id,r]));
 for(let polls=0;polls<150;polls++){
  let snap;
  try{snap=await api(`/api/docs/hunt?token=${encodeURIComponent(hunt)}`,{signal:token.signal});}
  catch{if(controller.current(token.generation))status.textContent=status.textContent.replace(' · searching further…','');return;}
  if(!controller.current(token.generation))return;
  if(page===1)renderSites(snap.sites);
  const rows=rowsOf(),last=[...rows.values()].at(-1);
  const fresh=snap.documents.filter(d=>!rows.has(d.id)).map(d=>{const row=webItem(d);if(row)row.dataset.page=String(page);return row;}).filter(Boolean);
  if(fresh.length){if(last)last.after(...fresh);else webList.append(...fresh);}
  if(snap.status==='complete'){
   reorderPage(page,snap.documents);
   for(const d of snap.documents)markLead(webList.querySelector(`.web-item[data-id="${CSS.escape(d.id)}"]`)??document.createElement('div'),d);
   for(const p of snap.providers)if(p.status!=='ok')notices.append(node('p',p.message,'notice'));
   const count=webList.children.length,inside=snap.documents.filter(d=>d.found_via?.length).length;
   status.textContent=count?`${count} ${count===1?'document':'documents'}${inside?` · ${inside} found inside websites`:''}${snap.removed?` · ${snap.removed} removed as not matching`:''}`
    :'No document matched the request. Try another query or document type.';
   // The first document opens beside the list if none is open (the review may have removed the one that was).
   const first=page===1&&!webList.querySelector('.web-item.selected')&&snap.documents.find(d=>d.preview);
   if(first&&window.matchMedia('(min-width: 900px)').matches)void openPreview(first,rowsOf().get(first.id));
   return;
  }
  const n=webList.children.length,sites=snap.sites.length;
  status.textContent=`${n?`${n} ${n===1?'document':'documents'} · `:''}${sites?`searching inside ${sites} ${sites===1?'website':'websites'} · ${snap.checked_pages} pages checked`:'checking relevance'}…`;
  await new Promise(resolve=>setTimeout(resolve,1200));
 }
}
async function runWebSearch(kind){
 clearTimeout(pollTimer);current=controller.begin();const token=current;
 resetClosest();lastSearchData=null;showMatchView();
 webPage=1;webList.replaceChildren();closePreview();notices.replaceChildren();huntSites.replaceChildren();huntSites.hidden=true;
 webMore.hidden=true;retry.hidden=true;status.textContent=kind==='docs'?'Searching for documents…':'Searching the web…';
 try{await session();await searchWebPage(token,kind,false);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}
function runTab(tab){if(tab==='images')void runImageSearch();else if(tab==='web'||tab==='docs')void runWebSearch(tab);else void search();}

// ---- login-free preview ---------------------------------------------------------------------
// Results from login-walled sites (X, Reddit, Quora…) open in a window attached to the result, showing the content the
// engine found (/api/walled, official sources only). Links in it and "Continue to site" go to the site itself, whose
// login rules apply. Desktop: beside the result, notch pointing at it; narrow screens: below it. Previews load ahead on
// hover or focus, on touch, and for the first few walled results in view unless the connection is slow or saving data.
const walledCache=new Map();let walledOpen=null,walledSeen=0;
const slowLink=()=>{const c=navigator.connection;return !!c&&(c.saveData||/(^|-)(2g|3g)$/.test(c.effectiveType??''));};
function loadWalled(item){
 if(!walledCache.has(item.id))walledCache.set(item.id,api(`/api/walled?${new URLSearchParams({url:item.url,t:item.walled.token})}`).catch(()=>null));
 return walledCache.get(item.id);
}
const walledView=new IntersectionObserver(entries=>{for(const e of entries){
 if(!e.isIntersecting)continue;walledView.unobserve(e.target);
 if(walledSeen<3&&!slowLink()){walledSeen++;void loadWalled(e.target.walledItem);}
}});
function walledRow(row,item,titleLink){
 row.walledItem=item;row.classList.add('walled');
 const ahead=()=>void loadWalled(item);
 row.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse')ahead();});
 row.addEventListener('focusin',ahead);
 row.addEventListener('touchstart',ahead,{passive:true});
 walledView.observe(row);
 titleLink.addEventListener('click',event=>{
  if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
  event.preventDefault();
  if(walledOpen?.row===row)closeWalled();else void openWalled(row);
 });
}
const walledRows=()=>[...webList.querySelectorAll('.web-item.walled')];
function closeWalled(restoreFocus){
 if(!walledOpen)return;
 const {row,pop,watch}=walledOpen;walledOpen=null;
 watch.disconnect();pop.remove();row.classList.remove('walled-open');
 if(restoreFocus)row.querySelector('h3 a')?.focus();
}
// Beside the row when there is room (at least 340px), otherwise below it; kept inside the window, notch on the row.
function placeWalled(){
 if(!walledOpen)return;
 const {row,pop}=walledOpen,rect=row.getBoundingClientRect(),room=window.innerWidth-rect.right-40;
 if(room<340){
  if(pop.previousElementSibling!==row)row.after(pop);
  pop.classList.add('inline');pop.style.cssText='';return;
 }
 if(pop.parentElement!==document.body)document.body.append(pop);
 pop.classList.remove('inline');
 const width=Math.min(580,room),height=Math.min(pop.firstChild.scrollHeight+2,window.innerHeight-24);
 let top=rect.top;
 if(top+height>window.innerHeight-12)top=window.innerHeight-12-height;
 top=Math.max(12,top);
 const notch=Math.min(Math.max(rect.top-top+Math.min(28,rect.height/2),18),height-18);
 pop.style.cssText=`left:${rect.right+18+window.scrollX}px;top:${top+window.scrollY}px;width:${width}px;--max:${window.innerHeight-24}px;--notch:${notch}px`;
}
const lockLine=(notice,text)=>notice.replaceChildren(node('span','🔓 ','walled-lock'),node('strong','Login-free preview'),text);
async function openWalled(row){
 closeWalled();
 const item=row.walledItem,host=item.walled.host;
 const pop=node('div',undefined,'walled-pop');pop.setAttribute('role','dialog');pop.setAttribute('aria-label',`Login-free preview of ${item.title}`);pop.tabIndex=-1;
 const close=node('button','×','walled-close');close.type='button';close.setAttribute('aria-label','Close preview');close.addEventListener('click',()=>closeWalled(true));
 const notice=node('p',undefined,'walled-notice');
 lockLine(notice,` · ${host} normally asks you to sign in to see this. ZenAtlas brought it here for you.`);
 const body=node('div',undefined,'walled-body');body.append(node('p','Loading the preview…','walled-loading'));
 const cont=link(item.url,`Continue to ${host} ↗`);cont.className='walled-continue';
 const foot=node('footer',undefined,'walled-foot');foot.append(cont,node('small',`${host} may ask you to sign in.`));
 // The notch sits on the outer box; the inner box scrolls, so it cannot clip the notch.
 const inner=node('div',undefined,'walled-inner');inner.append(close,notice,body,foot);pop.append(inner);
 row.classList.add('walled-open');
 // Closes when its result scrolls out of view.
 const watch=new IntersectionObserver(([e])=>{if(!e.isIntersecting&&walledOpen?.row===row)closeWalled();});
 walledOpen={row,pop,watch};
 placeWalled();watch.observe(row);pop.focus({preventScroll:true});
 const preview=await loadWalled(item);
 if(walledOpen?.pop!==pop)return;
 if(!preview?.complete)lockLine(notice,` · ${host} requires sign-in to read this. Here's what ZenAtlas could show without it.`);
 body.replaceChildren();
 if(preview?.author||preview?.published){const m=node('p',undefined,'walled-meta');
  if(preview.author&&preview.author_url&&safeURL(preview.author_url))m.append(link(preview.author_url,preview.author));
  else if(preview.author)m.append(preview.author);
  if(preview.published)m.append(`${preview.author?' · ':''}${preview.published}`);
  body.append(m);}
 body.append(node('h4',preview?.title??item.title));
 const text=preview?.text??item.snippet;
 if(text)for(const para of text.split(/\n{2,}/).slice(0,40))body.append(node('p',para));
 else body.append(node('p','Nothing more could be read without signing in.','walled-empty'));
 if(preview?.links?.length){const list=node('ul',undefined,'walled-links');
  for(const l of preview.links.slice(0,8)){if(!safeURL(l.url))continue;const li=node('li');li.append(link(l.url,l.text));list.append(li);}
  body.append(list);}
 if(preview?.comments?.length){const c=node('div',undefined,'walled-comments');c.append(node('h5','Top comments'));
  for(const x of preview.comments){const p=node('p');p.append(node('strong',`${x.author} `),x.text);c.append(p);}
  body.append(c);}
 placeWalled();
}
// Skimming: ↓/↑ move the preview to the next or previous walled result, Esc closes it; on touch, swipe left/right and
// swipe down (or tap outside) do the same.
function stepWalled(by){
 if(!walledOpen)return;
 const rows=walledRows(),next=rows[rows.indexOf(walledOpen.row)+by];
 if(next){next.scrollIntoView({block:'nearest'});void openWalled(next);}
}
document.addEventListener('keydown',event=>{
 if(!walledOpen||event.target.closest?.('input,select,textarea'))return;
 if(event.key==='Escape'){event.preventDefault();closeWalled(true);}
 else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();stepWalled(event.key==='ArrowDown'?1:-1);}
});
document.addEventListener('pointerdown',event=>{if(walledOpen&&!walledOpen.pop.contains(event.target)&&!walledOpen.row.contains(event.target))closeWalled();});
let swipe=null;
document.addEventListener('touchstart',event=>{if(walledOpen?.pop.contains(event.target))swipe={x:event.touches[0].clientX,y:event.touches[0].clientY,top:walledOpen.pop.firstChild.scrollTop};},{passive:true});
document.addEventListener('touchend',event=>{
 if(!swipe||!walledOpen)return;
 const t=event.changedTouches[0],dx=t.clientX-swipe.x,dy=t.clientY-swipe.y,start=swipe;swipe=null;
 if(Math.abs(dx)>60&&Math.abs(dy)<40)stepWalled(dx<0?1:-1);
 else if(dy>80&&Math.abs(dx)<40&&start.top===0)closeWalled();
},{passive:true});
window.addEventListener('resize',()=>placeWalled());
// Beside its row, the window follows the row as the page scrolls, staying inside the viewport.
let walledFrame=0;
window.addEventListener('scroll',()=>{if(walledOpen&&!walledFrame)walledFrame=requestAnimationFrame(()=>{walledFrame=0;placeWalled();});},{passive:true});

// ---- mode routing ---------------------------------------------------------------------------
// A new search opens on the tab its query suits (/api/mode: format words, then Jev, then a small model; videos when
// unsure). A tab the user clicks is always kept. The chosen tab goes into the URL, so links and Back keep it.
const modeNote=document.querySelector('#mode-note');
const MODE_LABELS={videos:'videos',web:'web results',images:'images',docs:'documents'};
let routeSeq=0;
async function routeQuery(q){
 const seq=++routeSeq;
 status.textContent='Choosing where to search…';
 let decision={mode:'videos',source:'default'};
 try{const d=await api(`/api/mode?q=${encodeURIComponent(q)}`);if(d&&d.mode in TABS)decision=d;}catch{}
 return seq===routeSeq?decision:null;
}
function showModeNote(decision){
 modeNote.replaceChildren();modeNote.hidden=decision.source==='default';
 if(modeNote.hidden)return;
 modeNote.append(`Showing ${MODE_LABELS[decision.mode]} for this query · Search `);
 Object.keys(TABS).filter(t=>t!==decision.mode).forEach((t,i,all)=>{
  const a=node('a',t==='web'?'the web':t,'mode-switch');a.href=TABS[t].href;
  a.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;event.preventDefault();TABS[t].click();});
  modeNote.append(a);if(i<all.length-1)modeNote.append(' · ');
 });
 modeNote.append(' instead');
}
// Routes a query without a chosen tab, then records the tab in the URL (replace: Back skips the undecided address).
async function routeAndRun(push){
 const q=form.elements.namedItem('q').value;
 const decision=await routeQuery(q);
 if(!decision)return;
 const query=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 query.set('tab',decision.mode);if(decision.mode!=='docs')query.delete('doc_type');
 window.history[push?'pushState':'replaceState'](null,'',`/results.html?${query}`);
 syncTabs(decision.mode);showModeNote(decision);
 runTab(decision.mode);
}

function runFromURL(){
 applyParamsFromURL();
 routeSeq++;lastQuery=form.elements.namedItem('q').value||null;
 if(lastQuery&&!chosenTab(window.location.search)){void routeAndRun(false);return;}
 // A tab named in the URL (clicked, or kept from an earlier routing) is the user's view: no routing note.
 modeNote.hidden=true;
 const tab=tabOf(window.location.search);
 syncTabs(tab);
 if(!form.elements.namedItem('q').value){status.textContent={videos:'Enter a query to search the catalogue.',web:'Enter a query to search the web.',
  images:'Enter a query to search for images.',docs:'Enter a query to search for documents.'}[tab];return;}
 runTab(tab);
}
// A new query is routed to the tab it suits, whichever tab is open. Changing only the document type on the Docs tab
// re-runs that tab.
let lastQuery=null;
form.addEventListener('submit',event=>{event.preventDefault();
 const q=form.elements.namedItem('q').value,tab=chosenTab(window.location.search);
 if(q&&(q!==lastQuery||!tab)){lastQuery=q;modeNote.hidden=true;void routeAndRun(true);return;}
 const query=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 query.set('tab',tab??'videos');
 if(tab!=='docs')query.delete('doc_type');
 window.history.pushState(null,'',`/results.html?${query}`);
 syncTabs(tab??'videos');
 runTab(tab??'videos');
});
retry.addEventListener('click',()=>runTab(tabOf(window.location.search)));
// Changing the document type re-runs the document search straight away.
form.elements.namedItem('doc_type').addEventListener('change',()=>{if(tabOf(window.location.search)==='docs'&&form.elements.namedItem('q').value)form.requestSubmit();});
// Tabs are real links, so let the browser handle modified clicks (new tab, new window) and only
// take over the plain click to swap results without a reload.
for(const tab of Object.values(TABS))tab.addEventListener('click',event=>{
 if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
 event.preventDefault();
 window.history.pushState(null,'',tab.href);
 runFromURL();
});
imageMore.addEventListener('click',async()=>{
 if(imageBusy)return;
 imageBusy=true;imageMore.disabled=true;
 const token=current;imagePage+=1;
 try{await searchImagesPage(token,true);}
 catch(error){if(controller.current(token.generation)){imagePage-=1;status.textContent=error.message;}}
 finally{imageBusy=false;imageMore.disabled=false;}
});
webMore.addEventListener('click',async()=>{
 if(webBusy)return;
 webBusy=true;webMore.disabled=true;
 const token=current;webPage+=1;
 try{await searchWebPage(token,tabOf(window.location.search),true);}
 catch(error){if(controller.current(token.generation)){webPage-=1;status.textContent=error.message;}}
 finally{webBusy=false;webMore.disabled=false;}
});
document.querySelector('#doc-viewer-close').addEventListener('click',closePreview);
document.querySelector('#doc-zoom-in').addEventListener('click',()=>pdfViewer?.increaseScale());
document.querySelector('#doc-zoom-out').addEventListener('click',()=>pdfViewer?.decreaseScale());
document.querySelector('#doc-fit').addEventListener('click',()=>{if(pdfViewer)pdfViewer.currentScaleValue='page-width';});
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
cancel.addEventListener('click',()=>{clearTimeout(pollTimer);controller.stop();resetClosest(false);closestStatus.textContent='Discovery updates were stopped. Start another search to see closest matches.';cancel.hidden=true;status.textContent='Discovery updates stopped. Your current results remain available.';if(searchId)void api(`/api/search/${searchId}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});});
window.addEventListener('popstate',runFromURL);
runFromURL();

// A note on what a search missed goes to the learning loop; the next audit tests the sources it names.
missing.addEventListener('submit',async event=>{event.preventDefault();if(!searchId)return;
 const note=missingNote.value.trim();if(note.length<3)return;
 try{await learn(searchId,{kind:'missing',note});missingNote.value='';missingStatus.textContent='Thanks. This is recorded with the search for the engine to learn from.';}
 catch(error){missingStatus.textContent=error.message;}});
