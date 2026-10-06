// Text and links come from a checked answer snapshot. Render as text, never as model-provided HTML.
export function mountAnswer(panel, stop) {
 let latest=null, previous='', returnFocus=null;
 const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
 const dialog=document.createElement('dialog');dialog.className='answer-source-dialog';dialog.setAttribute('aria-label','Supporting sources');
 document.body.append(dialog);
 dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
 dialog.addEventListener('close',()=>returnFocus?.focus());
 const sourcesFor=(ids)=>latest.sources.filter(s=>!ids||s.passages.some(p=>ids.includes(p.id)));
 function showSources(ids,trigger){
   returnFocus=trigger;dialog.replaceChildren();
   const bar=el('div',undefined,'answer-head'),title=el('h2','Supporting sources'),close=el('button','Close','secondary');
   close.type='button';close.addEventListener('click',()=>dialog.close());bar.append(title,close);dialog.append(bar);
   for(const source of sourcesFor(ids)){
     let url;try{url=new URL(source.url);if(!['https:','http:'].includes(url.protocol))continue;}catch{continue;}
     const card=el('section',undefined,'answer-source');
     const a=el('a',`${latest.sources.indexOf(source)+1}. ${source.title}`);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';
     card.append(a,el('p',url.hostname,'hint'));
     const date=source.published?`Published ${source.published} · `:'';
     card.append(el('p',`${date}Read ${new Date(source.fetched_at).toLocaleString()}`,'hint'));
     for(const passage of source.passages.filter(p=>!ids||ids.includes(p.id)))card.append(el('blockquote',passage.text));
     dialog.append(card);
   }
   if(!dialog.open)dialog.showModal();
 }
 function reset(){latest=null;previous='';panel.hidden=true;panel.replaceChildren();if(dialog.open)dialog.close();}
 function render(answer){
   if(!answer){reset();return;}
   const key=JSON.stringify(answer);if(key===previous)return;previous=key;latest=answer;
   panel.hidden=false;panel.replaceChildren();
   const head=el('div',undefined,'answer-head'),heading=el('h2','Answer');head.append(heading);
   const pending=['reading','drafting','checking'].includes(answer.status);
   if(pending){const button=el('button','Stop answer','secondary');button.type='button';button.addEventListener('click',()=>{stop();render({status:'cancelled',message:'Answer stopped. Search results remain available.',claims:[],sources:[],limited:false});});head.append(button);}
   else if(answer.status==='ready')head.append(el('span',`${answer.sources.length} cited ${answer.sources.length===1?'source':'sources'}`,'hint'));
   panel.append(head);
   panel.setAttribute('aria-busy',String(pending));
   if(answer.message){const message=el('p',answer.message,'answer-message');message.setAttribute('role','status');panel.append(message);}
   for(const claim of answer.claims){
     const p=el('p',claim.text,'answer-claim');
     for(const source of sourcesFor(claim.evidence)){
       const number=answer.sources.indexOf(source)+1,button=el('button',`[${number}]`,'answer-citation');button.type='button';
       button.setAttribute('aria-label',`Source ${number}: ${source.title}`);
       button.addEventListener('click',()=>showSources(claim.evidence.filter(id=>source.passages.some(s=>s.id===id)),button));p.append(' ',button);
     }
     panel.append(p);
   }
   if(answer.status==='ready'){
     const actions=el('div',undefined,'answer-actions'),view=el('button','View sources','secondary'),copy=el('button','Copy with citations','secondary');
     view.type=copy.type='button';view.addEventListener('click',()=>showSources(null,view));
     copy.addEventListener('click',async()=>{
       const body=answer.claims.map(c=>`${c.text} ${sourcesFor(c.evidence).map(s=>`[${answer.sources.indexOf(s)+1}]`).join('')}`).join('\n\n');
       const refs=answer.sources.map((s,i)=>`[${i+1}] ${s.title}: ${s.url}`).join('\n');
       try{await navigator.clipboard.writeText(`${body}\n\n${refs}${answer.message?'\n\n'+answer.message:''}`);copy.textContent='Copied';}catch{copy.textContent='Copy unavailable';}
     });
     actions.append(view,copy,el('span','AI summary · Check the supporting sources','hint'));panel.append(actions);
   }
 }
 return {render,reset};
}
