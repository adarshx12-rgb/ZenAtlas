// The LVL control: which model tier runs the search. SSJ3 is the full model architecture; SSJ1 runs the same steps on
// lower-cost models. The choice lives in the form's hidden "tier" field ('' for SSJ3, so URLs stay clean), is kept in
// the URL by the form, and is remembered in this browser when storage is available.
const LEVELS=[{value:'ssj3',label:'SSJ3',note:'Full models: the most accurate results.'},
 {value:'ssj1',label:'SSJ1',note:'Lower-cost models: the same steps, cheaper to run.'}];
const KEY='zenatlas-level';
const load=()=>{try{return localStorage.getItem(KEY);}catch{return null;}};
const save=value=>{try{localStorage.setItem(KEY,value);}catch{}};

export function mountLevel(form,{onChange}={}){
 const field=form.elements.namedItem('tier');
 const fromURL=new URLSearchParams(window.location.search).get('tier');
 const start=fromURL==='ssj1'||fromURL==='ssj3'?fromURL:load()==='ssj1'?'ssj1':'ssj3';
 field.value=start==='ssj1'?'ssj1':'';
 const wrap=document.createElement('div');wrap.className='level';
 const button=document.createElement('button');button.type='button';button.className='level-button';
 button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
 const menu=document.createElement('ul');menu.className='level-menu';menu.setAttribute('role','listbox');menu.hidden=true;
 menu.setAttribute('aria-label','Model level');
 const get=()=>field.value==='ssj1'?'ssj1':'ssj3';
 const options=LEVELS.map(level=>{
  const li=document.createElement('li');li.setAttribute('role','option');li.tabIndex=-1;li.dataset.value=level.value;
  const name=document.createElement('strong');name.textContent=level.label;
  const note=document.createElement('span');note.textContent=level.note;
  li.append(name,note);
  li.addEventListener('click',()=>choose(level.value));
  li.addEventListener('keydown',event=>{
   if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(level.value);}
   else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();
    const all=[...menu.children],next=all[(all.indexOf(li)+(event.key==='ArrowDown'?1:all.length-1))%all.length];next.focus();}
   else if(event.key==='Escape'){event.preventDefault();close(true);}
   else if(event.key==='Tab')close(false);
  });
  menu.append(li);return li;
 });
 // The field may hold anything a link put there; only 'ssj1' means SSJ1, everything else is SSJ3.
 const draw=()=>{field.value=get()==='ssj1'?'ssj1':'';button.textContent=`LVL · ${get().toUpperCase()}`;
  for(const li of options)li.setAttribute('aria-selected',String(li.dataset.value===get()));};
 const open=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');(options.find(li=>li.dataset.value===get())??options[0]).focus();};
 function close(focus){menu.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();}
 function choose(value){
  const changed=value!==get();
  field.value=value==='ssj1'?'ssj1':'';save(value);draw();close(true);
  if(changed)onChange?.(value);
 }
 button.addEventListener('click',()=>menu.hidden?open():close(false));
 button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();open();}});
 document.addEventListener('pointerdown',event=>{if(!wrap.contains(event.target))close(false);});
 wrap.append(button,menu);
 form.querySelector('.searchbar button[type="submit"]').before(wrap);
 draw();
 // refresh: after the page re-reads the URL (Back/Forward), the field may hold another level.
 return {get,refresh:draw};
}
