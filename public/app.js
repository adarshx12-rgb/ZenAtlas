const form=document.querySelector('#search-form'),status=document.querySelector('#status');
fetch('/api/session',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error();}).catch(()=>{status.textContent='The search service is unavailable. Please try again later.';status.hidden=false;});
form.addEventListener('submit',event=>{
 event.preventDefault();
 const params=new URLSearchParams([...new FormData(form)].filter(([,v])=>v!==''));
 window.location.href=`/results.html?${params}`;
});
