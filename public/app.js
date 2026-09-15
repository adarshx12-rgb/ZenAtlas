import {SearchController} from './search-controller.js';
const form=document.querySelector('#search-form'),results=document.querySelector('#results'),status=document.querySelector('#status');
const notices=document.querySelector('#notices'),more=document.querySelector('#more'),retry=document.querySelector('#retry'),cancel=document.querySelector('#cancel');
const controller=new SearchController();let searchId=null,next=null,params=null,pollTimer=null,current=null;const seen=new Set();
const ready=fetch('/api/session',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('The search service is unavailable.');});
ready.catch(()=>{});
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function link(url,text){const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid link');const a=node('a',text);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function api(url,options={}){const response=await fetch(url,{credentials:'same-origin',...options});if(!response.ok){const data=await response.json().catch(()=>null);throw Error(data?.error?.message??'Search is unavailable. Please retry.');}return response.status===204?null:response.json();}
function card(item){
 const article=node('article',undefined,'card');article.dataset.id=item.id;
 article.append(node('div',`${item.source_name} · ${item.origin==='catalogue'?'Catalogue':'External discovery'}`,'meta'));
 const heading=node('h3');heading.append(link(item.canonical_url,item.title));article.append(heading);
 article.append(node('span',item.evidence.replaceAll('_',' '),'badge'),node('span',`Rights: ${item.rights_status}`,'badge'));
 if(item.description)article.append(node('p',item.description));
 for(const moment of item.moments){
  const passage=node('div',undefined,'moment');passage.append(node('strong',`${moment.start_seconds}s – ${moment.end_seconds}s · ${moment.evidence_type.replaceAll('_',' ')}`));
  passage.append(node('p',moment.summary));
  const url=new URL(item.canonical_url);if(url.hostname==='www.youtube.com'&&url.pathname==='/watch'){url.searchParams.set('t',String(Math.floor(moment.start_seconds)));passage.append(link(url.href,'Open timestamp ↗'));}
  article.append(passage);
 }
 const message=node('span','');
 for(const [text,useful] of [['Useful',true],['Not useful',false]]){const button=node('button',text,'secondary');
  const cardSearchId=searchId;button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'CreatorSearch'},body:JSON.stringify({search_id:cardSearchId,content_id:item.id,useful})});message.textContent='Feedback saved';}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});article.append(button);}
 article.append(message);return article;
}
function render(data,paging=false){searchId=data.search_id;for(const item of data.results){if(!seen.has(item.id)){seen.add(item.id);try{results.append(card(item));}catch{/* Invalid links are not rendered. */}}}
 if(!paging){notices.replaceChildren(...data.providers.filter(p=>p.status!=='ok').map(p=>node('p',p.message,'notice')));}
 next=data.next_cursor;more.hidden=!data.has_more;cancel.hidden=data.status!=='discovering';
 const countLabel=`${seen.size} ${seen.size===1?'result':'results'}`;
 status.textContent=data.status==='discovering'?`${countLabel} so far. Searching external sources…`:seen.size?`${countLabel} · ${data.status==='partial'?'Some search services are unavailable':'Search complete'}`:data.status==='partial'?'No catalogue matches. Discovery is unavailable or incomplete.':'No matching results. Try another query or broader filters.';
}
async function poll(token,count=0){if(count>=40||!controller.current(token.generation)){cancel.hidden=true;return;}
 try{const data=await api(`/api/search/${searchId}`,{signal:token.signal});if(!controller.current(token.generation))return;
  // Keep the currently loaded pagination cursor: polling the first page must not rewind later pages.
  const oldNext=next;render(data);if(oldNext){next=oldNext;more.hidden=false;}
  if(data.status==='discovering')pollTimer=setTimeout(()=>poll(token,count+1),1500);
 }catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}
async function search(){clearTimeout(pollTimer);const previous=searchId;current=controller.begin();const token=current;
 if(previous)void api(`/api/search/${previous}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});
 searchId=null;next=null;seen.clear();results.replaceChildren();notices.replaceChildren();more.hidden=true;retry.hidden=true;cancel.hidden=true;status.textContent='Searching the catalogue…';
 params=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));params.set('limit','20');
 try{await ready;const data=await api(`/api/search?${params}`,{signal:token.signal});if(!controller.current(token.generation))return;render(data);if(data.status==='discovering')pollTimer=setTimeout(()=>poll(token),1500);}
 catch(error){if(controller.current(token.generation)){status.textContent=error.message;retry.hidden=false;}}
}
form.addEventListener('submit',event=>{event.preventDefault();void search();});retry.addEventListener('click',()=>void search());
more.addEventListener('click',async()=>{if(!next)return;const token=current;more.disabled=true;const page=new URLSearchParams(params);page.set('cursor',next);
 try{const data=await api(`/api/search?${page}`,{signal:token.signal});if(controller.current(token.generation))render(data,true);}catch(error){if(controller.current(token.generation))status.textContent=error.message;}finally{more.disabled=false;}});
cancel.addEventListener('click',()=>{clearTimeout(pollTimer);controller.stop();cancel.hidden=true;status.textContent='Discovery updates stopped. Your current results remain available.';if(searchId)void api(`/api/search/${searchId}`,{method:'DELETE',headers:{'X-Requested-With':'CreatorSearch'}}).catch(()=>{});});
