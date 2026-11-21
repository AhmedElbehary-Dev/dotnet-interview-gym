import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');
const assessment=fs.readFileSync(path.join(root,'assets/assessment.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'questions/manifest.json'),'utf8'));
const store=new Map();
const elements=new Map();
const events=new Map();
const historyKey='interview_gym_history_v2';
const sessionKey='interview_gym_session_v2';
let now=Date.parse('2099-07-02T21:01:00Z'), exported;
class TestDate extends Date {
  constructor(...args){super(...(args.length?args:[now]))}
  static now(){return now}
}
class FakeElement {
  constructor(id){
    this.id=id;this.style={};this.textContent='';this.innerHTML='';
    this.value=id==='size'?'30':id==='category'||id==='difficulty'||id==='skill'?'all':id==='seconds'?'75':'';
    this.disabled=false;this.children=[];
    const classes=new Set();
    this.classList={
      toggle:(name,on)=>on?classes.add(name):classes.delete(name),
      add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)
    };
  }
  addEventListener(type,listener){events.set(this.id+':'+type,listener)}
  setAttribute(){}
  appendChild(e){this.children.push(e)}
  remove(){}
  focus(){}
  click(){}
}
function el(id){if(!elements.has(id))elements.set(id,new FakeElement(id));return elements.get(id)}
const document={
  documentElement:{dataset:{theme:'light'}},
  getElementById:el,
  querySelector:(sel)=>sel==='input[name="mode"]:checked'?{value:'exam'}:new FakeElement(sel),
  querySelectorAll:()=>[],
  createElement:tag=>new FakeElement(tag),
  addEventListener(type,listener){events.set('document:'+type,listener)},body:{appendChild(){}}
};
const localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
const uiMessages=[];
const context=vm.createContext({document,window:{scrollTo(){},addEventListener(){},isSecureContext:false},localStorage,console,
  setInterval,clearInterval,setTimeout:()=>{},clearTimeout,URL:{
    createObjectURL:blob=>{exported=blob;return 'blob:backup'},revokeObjectURL(){}
  },Blob,Math,Date:TestDate,
  GymUI:{notify:(...args)=>uiMessages.push(args),confirm:async()=>true},
  fetch:async(p)=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'))})
});
vm.runInContext(assessment,context,{filename:'assessment.js'});
vm.runInContext(app,context,{filename:'app.js'});
await new Promise(r=>setTimeout(r,50));
assert.equal(vm.runInContext('BANK.length',context),manifest.total);
assert.equal(elements.get('totalCount').textContent,manifest.total);
assert.equal(elements.get('start').disabled,false);
assert.equal(vm.runInContext('CATEGORIES.length',context),10);
await vm.runInContext('start()',context);
assert.equal(vm.runInContext('state.ids.length',context),30);
let firstId=vm.runInContext('current().id',context);
vm.runInContext('answer(current().answer)',context);
assert.equal(vm.runInContext('state.index',context),1);
assert.equal(Object.keys(JSON.parse(store.get('interview_gym_history_v2'))).length,1);
vm.runInContext('leave()',context);
await vm.runInContext('start()',context);
assert.notEqual(vm.runInContext('current().id',context),firstId);
vm.runInContext('stopClock()',context);
await vm.runInContext("start('standard','placement')",context);
assert.equal(vm.runInContext('state.target',context),30);
assert.equal(vm.runInContext('state.plan',context),'placement');
for(let i=0;i<30;i++) vm.runInContext('answer(current().answer)',context);
assert.equal(vm.runInContext('state.done',context),true);
assert.equal(vm.runInContext('state.ids.length',context),30);
await vm.runInContext("start('standard','adaptive')",context);
assert.equal(vm.runInContext('state.plan',context),'adaptive');
assert.equal(vm.runInContext('state.target',context),30);
vm.runInContext('answer(null,"skip")',context);
assert.equal(vm.runInContext('state.index',context),1);
vm.runInContext('stopClock()',context);

const run=source=>vm.runInContext(source,context);
const record=id=>JSON.parse(store.get(historyKey))[id];
const begin=pool=>run(`start(${JSON.stringify(pool)})`);
store.clear();
el('seconds').value='30';
await begin('standard');
firstId=run('current().id');
now+=7_250;
run('togglePause()');
now+=60_000;
run('togglePause()');
now+=2_250;
run('leave()');
now+=60_000;
run('resume()');
now+=5_500;
run('answer(current().answer)');
assert.equal(record(firstId).lastSeconds,15);
assert.equal(record(firstId).lastDuration,30);
assert.equal(record(firstId).masteryStatus,'mastered','pause and leaving do not count as time spent');
const timeoutId=run('current().id');
run('clearInterval(interval); state=null');
now+=30_000;
run('resume()');
assert.equal(record(timeoutId).lastStatus,'timeout','saved running deadline survives reload');
const hiddenId=run('current().id');
document.hidden=true;
now+=30_000;
events.get('document:visibilitychange')();
document.hidden=false;
events.get('document:visibilitychange')();
assert.equal(record(hiddenId).lastStatus,'timeout','hidden elapsed time counts');
run('leave()');
assert.equal(el('masteredCount').textContent,1);
assert.equal(el('reviewCount').textContent,2);
assert.equal(el('unseenCount').textContent,manifest.total-3);

await begin('mastered');
assert.equal(run('current().id'),firstId);
assert.equal(run('state.mode'),'learn');
assert.equal(run('state.target'),1);
assert.match(uiMessages.at(-1)[0], /1 من أصل 30/);
run('leave()');
await begin('reassess');
assert.equal(run('state.mode'),'exam');
assert.equal(run('current().id'),firstId);
run('answer(null,"skip")');
assert.equal(record(firstId).masteryStatus,'review');
assert.equal(record(firstId).correct,1);
assert.equal(record(firstId).wrong,1);
const beforeEmpty=store.get(sessionKey);
await begin('mastered');
assert.equal(store.get(sessionKey),beforeEmpty,'empty round does not replace the session');
assert.equal(el('emptyRound').classList.contains('hidden'),false);

const chosen=run('BANK[0]');
el('category').value=chosen.category;
el('difficulty').value=chosen.difficulty;
el('skill').value=chosen.skill;
await begin('standard');
assert.ok([...run('state.ids.map(id=>BY_ID.get(id))')].every(q =>
  q.category===chosen.category && q.difficulty===chosen.difficulty && q.skill===chosen.skill));
run('leave()');
events.get('exportProgress:click')();
const backup=JSON.parse(await exported.text());
assert.deepEqual(backup.history,JSON.parse(store.get(historyKey)));
assert.deepEqual(backup.session,JSON.parse(store.get(sessionKey)));

const oldSession={ ...backup.session,version:4,remaining:25 };
delete oldSession.remainingMs;
const legacyId=oldSession.ids[0];
const legacyHistory={ [legacyId]:{correct:3,wrong:0,streak:3,custom:'keep'} };
const importBackup=async data=>events.get('progressFile:change')({
  target:{files:[{size:100,text:async()=>JSON.stringify(data)}]}
});
await importBackup({...backup,history:legacyHistory,session:oldSession});
assert.equal(el('reinforcementCount').textContent,1);
assert.equal(el('masteredCount').textContent,0);
run('resume(); answer(current().answer); leave()');
assert.equal(record(legacyId).correct,4);
assert.equal(record(legacyId).custom,'keep');
assert.equal(record(legacyId).lastSeconds,null);
assert.equal(record(legacyId).masteryStatus,'reinforcement');
await importBackup(backup);
assert.equal(el('reviewCount').textContent,3);
assert.deepEqual(JSON.parse(store.get(sessionKey)),backup.session);
assert.deepEqual(JSON.parse(store.get(historyKey)),backup.history);

now=Date.parse('2099-07-02T21:01:00Z');
assert.notEqual(run('cairoCalendar.format(new Date())'),'2099-07-03','locale output need not be ISO');
const saved=store.get(historyKey);
const savedSession=store.get(sessionKey);
assert.equal(el('startArrivalsToday').disabled,true);
run(`for(const [id,publishedOn] of [['arrival-today','2099-07-03'],['arrival-recent','2099-07-02'],
  ['arrival-old','2099-06-26'],['arrival-future','2099-08-04']]){
    const q={...BANK.find(q=>!q.code),id,publishedOn,q:'Question '+id+' <safe>'};
    BANK.push(q);BY_ID.set(q.id,q);
  }
  setup()`);
assert.match(el('arrivalsToday').innerHTML,/arrival-today &lt;safe&gt;/);
assert.doesNotMatch(el('arrivalsToday').innerHTML,/arrival-recent|arrival-future/);
assert.match(el('arrivalsRecent').innerHTML,/arrival-recent/);
assert.doesNotMatch(el('arrivalsRecent').innerHTML,/arrival-old|arrival-today/);
assert.equal(store.get(historyKey),saved);
assert.equal(store.get(sessionKey),savedSession);
assert(run("filteredBank({}).some(q=>q.id==='arrival-old')"), 'older arrivals stay in the main bank');
await events.get('startArrivalsToday:click')();
assert.equal(run('current().id'),'arrival-today');
run('answer(current().answer); leave()');
assert.equal(record('arrival-today').masteryStatus,'mastered');
for(const [id, entry] of Object.entries(JSON.parse(saved))) assert.deepEqual(record(id),entry);
await events.get('startArrivalsToday:click')();
assert.equal(run('current().id'),'arrival-today','mastered arrivals can still be practiced');
run('leave()');

now=Date.parse('2099-07-22T12:00:00Z');
const irregularHistory=store.get(historyKey),irregularSession=store.get(sessionKey);
run(`for(let i=0;i<999;i++){
    const q={...BY_ID.get('arrival-today'),id:'batch-'+i};
    BANK.push(q);BY_ID.set(q.id,q);
  }
  setup()`);
assert.equal(el('startArrivalsToday').disabled,true);
assert.equal(el('startArrivalsRecent').disabled,false);
assert.match(el('arrivalsRecent').innerHTML,/arrival-today/);
assert.doesNotMatch(el('arrivalsRecent').innerHTML,/arrival-recent|arrival-old|arrival-future/);
assert.equal((el('arrivalsRecent').innerHTML.match(/class="prompt"/g)||[]).length,5);
assert.match(el('arrivalsRecent').innerHTML,/1000/);
assert.equal(run("filteredBank(arrivalFilters('Recent')).length"),1000);
assert.equal(store.get(historyKey),irregularHistory);
assert.equal(store.get(sessionKey),irregularSession);
await events.get('startArrivalsRecent:click')();
assert.equal(run('state.target'),30);
assert.equal(run("state.ids.every(id=>id==='arrival-today'||id.startsWith('batch-'))"),true);
assert.ok(run("state.ids.some(id=>/^batch-(?:[4-9]|\\d{2,})$/.test(id))"),'practice reaches beyond the displayed previews');
run('leave()');
console.log('Smoke test passed: standard, placement, adaptive, timing, review, filters, empty state, reload, backup compatibility, New Arrivals, and mastery persistence.');
