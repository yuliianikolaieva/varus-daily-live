'use strict';
let D, mode = 'day';
const el = id => document.getElementById(id);
const date = value => value.slice(0, 10);
const utc = value => new Date(value + 'T00:00:00Z');
const shift = (value, days) => new Date(+utc(value) + days * 86400000).toISOString().slice(0, 10);
const monday = value => shift(value, -((utc(value).getUTCDay() + 6) % 7));
const fmt = (v, digits = 0) => v == null || !Number.isFinite(+v) ? '—' : new Intl.NumberFormat('uk-UA', {maximumFractionDigits: digits}).format(v);
const pct = v => v == null ? 'Немає даних' : fmt(v, 1) + '%';
const change = (a, b) => a != null && b > 0 ? (a / b - 1) * 100 : null;
const metrics = ['gmv', 'orders', 'availability_pct', 'online_hours', 'bad_orders', 'failed_orders'];

function aggregate(rows) {
  const result = {count: new Set(rows.map(r => r.store_id)).size, row_count: rows.length};
  for (const k of ['gmv', 'orders', 'bad_orders', 'failed_orders', 'placed']) {
    result[k] = rows.length ? rows.reduce((n, r) => n + Number(r[k] || 0), 0) : null;
  }
  const known = rows.filter(r => r.availability_observations > 0 && r.active_time != null && r.working_time != null);
  result.known_count = new Set(known.map(r => r.store_id)).size;
  result.known_rows = known.length;
  result.active_time = known.length ? known.reduce((n,r) => n + r.active_time, 0) : null;
  result.working_time = known.length ? known.reduce((n,r) => n + r.working_time, 0) : null;
  result.online_hours = result.active_time == null ? null : result.active_time / 60;
  result.scheduled_hours = result.working_time == null ? null : result.working_time / 60;
  result.availability_pct = result.working_time > 0 ? result.active_time / result.working_time * 100 : null;
  result.bad_order_rate_pct = result.orders > 0 ? result.bad_orders / result.orders * 100 : null;
  result.failed_order_rate_pct = result.placed > 0 ? result.failed_orders / result.placed * 100 : null;
  return result;
}

function range(rows, start, end) { return rows.filter(r => date(r.date) >= start && date(r.date) <= end); }
function filtered(ignoreStore = false) {
  return D.daily.filter(r => (el('city').value === 'all' || r.city === el('city').value) &&
    (ignoreStore || el('store').value === 'all' || r.store_id === el('store').value));
}
function period() {
  const selected = el('date').value || D.through;
  const start = mode === 'week' ? monday(selected) : selected;
  const end = mode === 'week' ? [shift(start, 6), D.through].sort()[0] : selected;
  return {start, end, previousStart: shift(start, -7), previousEnd: shift(end, -7)};
}
function delta(current, previous, metric) {
  if (current[metric] == null || previous[metric] == null) return 'Порівняння недоступне';
  if (metric === 'availability_pct') {
    const value = current[metric] - previous[metric];
    return (value > 0 ? '+' : '') + fmt(value, 1) + ' п.п.';
  }
  if (previous[metric] === 0) return current[metric] === 0 ? '0%' : 'База = 0';
  const value = change(current[metric], previous[metric]);
  return (value > 0 ? '+' : '') + fmt(value, 1) + '%';
}
function valueFor(record, metric) {
  if (metric === 'availability_pct') return pct(record[metric]);
  if (metric === 'online_hours') return record[metric] == null ? 'Немає даних' : fmt(record[metric], 1);
  if (metric === 'bad_orders') return fmt(record.bad_orders) + ' · ' + (record.bad_order_rate_pct == null ? '—' : pct(record.bad_order_rate_pct));
  if (metric === 'failed_orders') return fmt(record.failed_orders) + ' · ' + (record.failed_order_rate_pct == null ? '—' : pct(record.failed_order_rate_pct));
  return fmt(record[metric], metric === 'gmv' ? 2 : 0);
}
function cell(row, value, comparison) {
  const td = document.createElement('td'); td.textContent = value;
  if (comparison) { const sub = document.createElement('small'); sub.textContent = comparison; td.append(sub); }
  row.append(td); return td;
}
function simpleRow(target, values) { const row = document.createElement('tr'); values.forEach(v => cell(row, v)); target.append(row); }
function headers(target, names) {
  target.replaceChildren(); const row = document.createElement('tr');
  for (const name of names) { const th = document.createElement('th'); th.textContent = name; row.append(th); }
  target.append(row);
}
function grouped(rows, key) {
  const groups = new Map();
  for (const row of rows) { const id = row[key] || 'Місто не вказане'; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
  return groups;
}
function performanceTable(target, currentRows, previousRows, key) {
  target.replaceChildren(); const previous = grouped(previousRows, key);
  for (const [id, rows] of [...grouped(currentRows, key)].sort((a,b) => aggregate(b[1]).gmv - aggregate(a[1]).gmv)) {
    const current = aggregate(rows), before = aggregate(previous.get(id) || []), tr = document.createElement('tr');
    cell(tr, key === 'city' ? id : rows[0].store_name + ' · ' + id);
    if (key === 'city') cell(tr, current.count, before.row_count ? 'Δ ' + fmt(current.count - before.count) + ' точок' : 'Немає бази');
    for (const metric of metrics) {
      let comparison = delta(current, before, metric);
      if (['availability_pct','online_hours'].includes(metric) && (current.known_rows < current.row_count || before.known_rows < before.row_count)) comparison += ' · неповні дані';
      cell(tr, valueFor(current, metric), comparison);
    }
    target.append(tr);
  }
}

function render() {
  const {start, end, previousStart, previousEnd} = period();
  const all = filtered(), rows = range(all,start,end), previousRows = range(all,previousStart,previousEnd);
  const current = aggregate(rows), before = aggregate(previousRows);
  const description = `${start}${start === end ? '' : ' — ' + end} ↔ ${previousStart}${previousStart === previousEnd ? '' : ' — ' + previousEnd}`;
  el('period').textContent = (mode === 'day' ? 'День · ' : 'Тиждень · ') + start + (start === end ? '' : ' — ' + end);
  el('comparison').textContent = (mode === 'day' ? 'Порівняння з тим самим днем минулого тижня: ' : 'Порівняння з відповідними днями попереднього тижня: ') + description;
  el('table-comparison').textContent = 'Зміни: ' + description;
  el('coverage').textContent = current.count + ' точок · EUR · завершені дні';
  el('cards').replaceChildren();
  const titles = ['GMV, €','Orders','Availability','Online hours, год','Bad orders','Failed orders'];
  metrics.forEach((metric,i) => {
    const card = document.createElement('div'); card.className = 'card';
    for (const [cls,text] of [['muted',titles[i]],['value',valueFor(current,metric)],['sub','WoW: ' + delta(current,before,metric)]]) {
      const div=document.createElement('div'); div.className=cls; div.textContent=text; card.append(div);
    }
    if (['availability_pct','online_hours'].includes(metric)) {
      const note=document.createElement('div'); note.className='sub'; note.textContent=`Дані: ${current.known_rows}/${current.row_count} точко-днів`; card.append(note);
    }
    el('cards').append(card);
  });
  el('warnings').replaceChildren();
  const warnings=[];
  const localParts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const expectedDate=shift(`${localParts.year}-${localParts.month}-${localParts.day}`,-1);
  if(Number(localParts.hour)>=9 && D.through<expectedDate) warnings.push(`Оновлення затримується: очікуються дані за ${expectedDate}, зараз доступні за ${D.through}.`);
  if (Date.now()-new Date(D.updated_at)>30*3600000) warnings.push('Дані не оновлювалися понад 30 годин.');
  if (current.known_rows < current.row_count) warnings.push(`Час онлайн доступний для ${current.known_rows} з ${current.row_count} точко-днів. Відсутні дані не замінені нулями.`);
  if (!current.working_time) warnings.push('Availability недоступна: робочий час у вибраному періоді відсутній або дорівнює нулю.');
  for (const message of warnings) { const div=document.createElement('div'); div.className='warning'; div.textContent=message; el('warnings').append(div); }
  const names=['GMV, €','Orders','Availability','Online hours, год','Bad · %','Failed · %'];
  headers(el('head'),['Точка',...names]);
  performanceTable(el('rows'),rows,previousRows,'store_id');
  headers(el('city-head'),['Місто','К-сть точок',...names]);
  const cityRows=filtered(true);
  performanceTable(el('city-rows'),range(cityRows,start,end),range(cityRows,previousStart,previousEnd),'city');
  renderHistory(all,end);
  renderWeeks(all,end);
  draw(all,end);
}

function renderHistory(all,end) {
  el('history').replaceChildren();
  for(let i=0;i<28;i++) {
    const day=shift(end,-i),rs=range(all,day,day); if(!rs.length)continue;
    const current=aggregate(rs), before=aggregate(range(all,shift(day,-7),shift(day,-7)));
    simpleRow(el('history'),[day,pct(current.availability_pct),valueFor(current,'online_hours'),fmt(current.scheduled_hours,1),`${current.known_count}/${current.count}`,delta(current,before,'availability_pct'),delta(current,before,'online_hours')]);
  }
}
function renderWeeks(all,end) {
  el('weeks').replaceChildren();
  for(let i=0;i<8;i++) {
    const start=shift(monday(end),-7*i),stop=[shift(start,6),end].sort()[0];
    const rows=range(all,start,stop);if(!rows.length)continue;
    const current=aggregate(rows),before=aggregate(range(all,shift(start,-7),shift(stop,-7)));
    const days=Math.round((utc(stop)-utc(start))/86400000)+1;
    simpleRow(el('weeks'),[start,fmt(current.gmv,2),fmt(current.orders),fmt(current.gmv/days*7,2),fmt(current.orders/days*7,1),pct(current.availability_pct),valueFor(current,'online_hours'),delta(current,before,'gmv'),days+'/7']);
  }
}
function draw(all,end) {
  const metric=el('metric').value;
  const points=Array.from({length:28},(_,i)=>{const day=shift(end,i-27);return {date:day,value:aggregate(range(all,day,day))[metric]};});
  const max=Math.max(...points.map(p=>p.value).filter(v=>v!=null),1);
  const svg=el('chart'),ns='http://www.w3.org/2000/svg';svg.replaceChildren();
  function tag(name,attrs,text){const node=document.createElementNS(ns,name);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,v));if(text)node.textContent=text;svg.append(node);return node;}
  for(let i=0;i<4;i++){const y=20+i*50;tag('line',{x1:80,y1:y,x2:1080,y2:y,stroke:'#e3ebe5'});tag('text',{x:72,y:y+4,'text-anchor':'end','font-size':12,fill:'#617269'},fmt(max*(3-i)/3,1));}
  let path='',gap=true;
  points.forEach((p,i)=>{if(p.value==null){gap=true;return;}path+=(gap?'M':'L')+(80+i*1000/27)+','+(170-p.value/max*150)+' ';gap=false;});
  tag('path',{d:path,fill:'none',stroke:'#27714f','stroke-width':3});
  points.forEach((p,i)=>{if(p.value==null)return;const dot=tag('circle',{cx:80+i*1000/27,cy:170-p.value/max*150,r:3,fill:'#27714f'});const title=document.createElementNS(ns,'title');title.textContent=p.date+': '+fmt(p.value,2);dot.append(title);});
  for(const i of [0,7,14,21,27])tag('text',{x:80+i*1000/27,y:202,'text-anchor':i===27?'end':'start','font-size':12,fill:'#617269'},points[i].date);
  el('chart-label').textContent=el('metric').selectedOptions[0].text+' · дата · '+points[0].date+' — '+end;
}
function stores() {
  const selected=el('store').value;el('store').replaceChildren();
  const option=document.createElement('option');option.value='all';option.textContent='Усі точки';el('store').append(option);
  const entries=new Map(filtered(true).map(r=>[r.store_id,r.store_name]));
  for(const [id,name]of [...entries].sort((a,b)=>a[1].localeCompare(b[1]))){const option=document.createElement('option');option.value=id;option.textContent=name+' · '+id;el('store').append(option);}
  if(entries.has(selected))el('store').value=selected;
}
async function init() {
  try {
    const response=await fetch('data.json',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);D=await response.json();
    if(D.currency!=='EUR'||D.schema_version!==2)throw new Error('Оновлення даних триває. Перезавантажте сторінку за хвилину.');
    el('stamp').textContent='Оновлено '+new Date(D.updated_at).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'});
    for(const city of [...new Set(D.daily.map(r=>r.city))].filter(Boolean).sort()){const option=document.createElement('option');option.value=city;option.textContent=city;el('city').append(option);}
    stores();el('date').min=date(D.network[0].date);el('date').max=D.through;el('date').value=D.through;
    el('city').onchange=()=>{stores();render();};
    for(const id of ['store','date','metric'])el(id).onchange=render;
    for(const id of ['day','week'])el(id).onclick=()=>{mode=id;el('day').classList.toggle('active',id==='day');el('week').classList.toggle('active',id==='week');render();};
    render();
  }catch(error){el('error').textContent=error.message;el('stamp').textContent='Не вдалося завантажити звіт';}
}
if(typeof document!=='undefined')init();
if(typeof module!=='undefined')module.exports={aggregate,delta,range,shift,monday,change};
