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
const matchTabs=document.querySelector('#match-tabs'),tabMatches=document.querySelector('#tab-matches'),tabClosest=document.querySelector('#tab-closest');
const closestPanel=document.querySelector('#closest-panel'),closestBox=document.querySelector('#closest-results');
const closestStatus=document.querySelector('#closest-status'),closestRetry=document.querySelector('#closest-retry');
let matchView='matches',closestSearch=null,closestLoaded=false,closestRequest=null,closestAbort=null,closestTimer=null,closestDeadline=0,lastSearchData=null;
const controller=new SearchController();
// Images come from a separate discovery-only endpoint, so they keep their own paging state
// rather than sharing the search snapshot's cursor.
let imagePage=1,imageBusy=false;
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
 const images=tabOf(window.location.search)==='images',closest=matchView==='closest';
 matchTabs.hidden=images;closestPanel.hidden=images||!closest;videoGrid.hidden=images||closest;
 status.hidden=!images&&closest;
 if(!images)resultsHeading.textContent=closest?'Closest matches':'Search results';
 for(const [button,selected] of [[tabMatches,!closest],[tabClosest,closest]]){
  button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected);
 }
 if(closest&&!images)more.hidden=true;
}
async function loadClosest(){
 if(matchView!=='closest'||tabOf(window.location.search)==='images')return;
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
  closestLoaded=data.status!=='pending';closestStatus.textContent=data.message;
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
function render(data){
 lastSearchData=data;
 if(searchId!==data.search_id)resetClosest(false);
 searchId=data.search_id;catalogueTotal=data.catalogue_total;
 catalogueBox.replaceChildren();showFound(data.ranked??[...data.results.filter(r=>r.origin==='catalogue'),...data.discovered]);
 notices.replaceChildren(...data.providers.filter(p=>p.status!=='ok'||p.provider==='relevance_filter'||p.message.includes('did not')).map(p=>node('p',p.message,'notice')));
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
 showMatchView();if(matchView==='closest'&&closestRetry.hidden)void loadClosest();
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
 resetClosest();lastSearchData=null;showMatchView();
 if(previous)void api(`/api/search/${previous}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});
 searchId=null;next=null;cards.clear();catalogueBox.replaceChildren();foundBox.replaceChildren();deepBox.replaceChildren();deepHeading.hidden=true;notices.replaceChildren();
 more.hidden=true;retry.hidden=true;cancel.hidden=true;deepRow.hidden=true;status.textContent='Searching the catalogue…';
 params=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));params.set('limit',String(PAGE));
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
const tabOf=search=>new URLSearchParams(search).get('tab')==='images'?'images':'videos';
const labelOf=field=>form.elements.namedItem(field)?.closest('label');

// Keeps the tab links pointing at the current query, so they stay shareable and middle-clickable
// instead of being buttons that only work through JavaScript.
function syncTabs(tab){
 const base=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 base.delete('tab');
 const videos=new URLSearchParams(base),images=new URLSearchParams(base);
 images.set('tab','images');
 tabVideos.href=`/results.html?${videos}`;tabImages.href=`/results.html?${images}`;
 tabVideos.classList.toggle('tab--active',tab==='videos');
 tabImages.classList.toggle('tab--active',tab==='images');
 if(tab==='videos')tabVideos.setAttribute('aria-current','page');else tabVideos.removeAttribute('aria-current');
 if(tab==='images')tabImages.setAttribute('aria-current','page');else tabImages.removeAttribute('aria-current');
 // Catalogue mode, evidence and the deep dive are all properties of the video pipeline; images
 // never touch it, so the controls would be inert.
 const images_=tab==='images';
 for(const field of ['mode','evidence'])labelOf(field)?.toggleAttribute('hidden',images_);
 videoGrid.hidden=images_;imageGrid.hidden=!images_;
 resultsHeading.textContent=images_?'Image results':'Search results';
 if(images_){deepRow.hidden=true;cancel.hidden=true;more.hidden=true;missing.hidden=true;}else{imageMore.hidden=true;}
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

function runFromURL(){
 applyParamsFromURL();
 const tab=tabOf(window.location.search);
 syncTabs(tab);
 if(!form.elements.namedItem('q').value){status.textContent=tab==='images'?'Enter a query to search for images.':'Enter a query to search the catalogue.';return;}
 if(tab==='images')void runImageSearch();else void search();
}
form.addEventListener('submit',event=>{event.preventDefault();
 const tab=tabOf(window.location.search);
 const query=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 // A search typed while the Images tab is open stays on Images.
 if(tab==='images')query.set('tab','images');
 window.history.pushState(null,'',`/results.html?${query}`);
 syncTabs(tab);
 if(tab==='images')void runImageSearch();else void search();
});
retry.addEventListener('click',()=>{if(tabOf(window.location.search)==='images')void runImageSearch();else void search();});
// Tabs are real links, so let the browser handle modified clicks (new tab, new window) and only
// take over the plain click to swap results without a reload.
for(const tab of [tabVideos,tabImages])tab.addEventListener('click',event=>{
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
