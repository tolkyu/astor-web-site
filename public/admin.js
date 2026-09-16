try { localStorage.removeItem('astor-admin-token'); } catch { /* Cookies do not depend on localStorage. */ }
const $ = id => document.getElementById(id);
let prices=[], revision='', saved='', active=0, busy=false;
const dirty=()=>JSON.stringify(prices)!==saved;
async function api(path,options={}) {
  const res=await fetch('/api/admin'+path,{...options,headers:{'Content-Type':'application/json','X-Astor-Admin':'1',...options.headers}});
  const body=await res.json();
  if(res.status===401){showLogin();throw new Error(body.message||'Сесія завершилась. Увійдіть знову.');}
  if(!res.ok||!body.ok)throw new Error(body.message||'Не вдалося виконати дію.');
  return body;
}
function showLogin(){$('login').hidden=false;$('editor').hidden=true;$('logout').hidden=true;}
function message(text){$('message').textContent=text;}
function touch(){message(dirty()?'Є незбережені зміни.':'');}
async function load() {
  const data=await api('/prices');prices=data.prices;revision=data.revision;saved=JSON.stringify(prices);active=Math.min(active,prices.length-1);
  $('meta').textContent=data.meta?'Прайс збережено: '+new Date(data.meta.at).toLocaleString('uk-UA'):'Початковий прайс';
  $('history').replaceChildren(...data.history.map(item=>new Option(item.meta?new Date(item.meta.at).toLocaleString('uk-UA'):'Початковий прайс',item.revision)));
  $('restore').disabled=!data.history.length;
  $('login').hidden=true;$('editor').hidden=false;$('logout').hidden=false;render();
}
function button(text,label,fn,disabled=false){const b=document.createElement('button');b.type='button';b.className='btn btn-secondary';b.textContent=text;b.setAttribute('aria-label',label);b.disabled=disabled;b.addEventListener('click',fn);return b;}
function render() {
  $('category').replaceChildren(...prices.map((c,i)=>new Option(c.label,String(i),false,i===active)));
  const cat=prices[active];$('category-name').value=cat.label;
  $('category-up').disabled=active===0;$('category-down').disabled=active===prices.length-1;$('delete-category').disabled=prices.length===1;
  $('rows').replaceChildren();
  cat.rows.forEach((row,i)=>{
    const section=document.createElement('div');section.className='editor-row';
    [['service','Робота',400],['price','Вартість від, грн',60],['time','Час (з одиницями)',60]].forEach(([key,label,max])=>{
      const field=document.createElement('div');field.className='field';
      const l=document.createElement('label');l.htmlFor='row-'+i+'-'+key;l.textContent=label;
      const input=document.createElement('input');input.id=l.htmlFor;input.value=row[key];input.maxLength=max;input.required=true;input.setAttribute('aria-label',label+', рядок '+(i+1));
      input.addEventListener('input',()=>{row[key]=input.value;touch();});field.append(l,input);section.append(field);
    });
    const actions=document.createElement('div');actions.className='row-actions';
    const move=delta=>{[cat.rows[i],cat.rows[i+delta]]=[cat.rows[i+delta],cat.rows[i]];render();touch();$('row-'+(i+delta)+'-service').focus();};
    actions.append(button('↑','Робота '+(i+1)+': вище',()=>move(-1),i===0),button('↓','Робота '+(i+1)+': нижче',()=>move(1),i===cat.rows.length-1),button('×','Видалити роботу '+(i+1),()=>{
      if(!confirm('Видалити цю роботу? До збереження дію можна скасувати.'))return;
      cat.rows.splice(i,1);render();touch();($('row-'+Math.min(i,cat.rows.length-1)+'-service')||$('add-row')).focus();
    }));
    section.append(actions);$('rows').append(section);
  });
}
async function mutate(path,body,method='POST') {
  if(busy)return;
  busy=true;$('controls').disabled=true;$('logout').disabled=true;message('Зберігаємо…');
  try {await api(path,{method,body:JSON.stringify({...body,revision})});await load();message('Збережено. Оновіть сторінку сайту, щоб побачити зміни.');}
  catch(err){message(err.message);}
  finally{busy=false;$('controls').disabled=false;$('logout').disabled=false;}
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
  try{await api('/login',{method:'POST',body:JSON.stringify({password:$('pw').value})});$('pw').value='';await load();await bookings();}
  catch(err){$('login-message').textContent=err.message;}finally{b.disabled=false;}
});
$('logout').addEventListener('click',async()=>{if(busy||dirty()&&!confirm('Вийти без збереження змін?'))return;try{await api('/logout',{method:'POST'});prices=[];saved='[]';showLogin();}catch(err){message(err.message);}});
$('category').addEventListener('change',e=>{active=Number(e.target.value);render();});
$('category-name').addEventListener('input',e=>{prices[active].label=e.target.value;$('category').options[active].text=e.target.value;touch();});
function moveCategory(delta){const next=active+delta;[prices[active],prices[next]]=[prices[next],prices[active]];active=next;render();touch();$('category-name').focus();}
$('category-up').onclick=()=>moveCategory(-1);$('category-down').onclick=()=>moveCategory(1);
$('add-category').onclick=()=>{prices.push({id:'cat-'+crypto.randomUUID().slice(0,12),label:'Нова категорія',rows:[]});active=prices.length-1;render();touch();$('category-name').focus();};
$('delete-category').onclick=()=>{if(confirm('Видалити категорію разом із роботами?')){prices.splice(active,1);active=Math.max(0,active-1);render();touch();$('category').focus();}};
$('add-row').onclick=()=>{prices[active].rows.push({service:'',price:'',time:''});render();touch();$('row-'+(prices[active].rows.length-1)+'-service').focus();};
$('save').onclick=()=>{
  for(const input of $('rows').querySelectorAll('input'))if(!input.reportValidity())return;
  mutate('/prices',{prices:structuredClone(prices)},'PUT');
};
$('revert').onclick=()=>{if(dirty()&&confirm('Скасувати незбережені зміни?')){prices=JSON.parse(saved);active=Math.min(active,prices.length-1);render();touch();}};
$('reset').onclick=()=>{if(confirm('Замінити поточний прайс початковим? Поточна версія залишиться в історії.'))mutate('/prices/reset',{});};
$('restore').onclick=()=>{if(confirm('Відновити обрану версію? Незбережені зміни буде замінено.'))mutate('/prices/restore',{restoreRevision:$('history').value});};
async function bookings(){
  try{
    const data=await api('/bookings');$('bookings-list').replaceChildren();
    if(!data.bookings.length){$('bookings-list').textContent='Заявок ще немає.';return;}
    for(const item of data.bookings){const card=document.createElement('article');card.className='booking-card';const title=document.createElement('h3');title.textContent=item.name;const tel=document.createElement('a');tel.href='tel:'+item.phone;tel.textContent=item.phone;const p=document.createElement('p');p.textContent=item.msg;const meta=document.createElement('small');meta.textContent=new Date(item.at).toLocaleString('uk-UA')+' · '+({delivered:'Сповіщення доставлено',pending:'Очікує доставки',sending:'Доставка триває',dry_run:'Локальна перевірка'}[item.status]||item.status);card.append(title,tel,p,meta);$('bookings-list').append(card);}
  }catch(err){$('bookings-list').textContent=err.message;}
}
$('refresh-bookings').onclick=bookings;
$('retry-bookings').onclick=async()=>{const b=$('retry-bookings');b.disabled=true;try{await api('/bookings/retry',{method:'POST'});await bookings();}catch(err){message(err.message);}finally{b.disabled=false;}};
window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
load().then(bookings).catch(showLogin);
