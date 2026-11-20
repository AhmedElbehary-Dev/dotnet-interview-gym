let BANK = [];
// Presentation-only enhancements; BANK ids and correct answers are unchanged.
function codeFor(q){return q.code||null}
function highlightedCode(code){
  const token=/(\/\/[^\n]*|--[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:int|long|var|void|new|for|foreach|in|class|public|private|static|return|async|await|ref|using|SELECT|WHERE|ORDER|BY|PARTITION|OVER|ROW_NUMBER|DESC|AND|OR|NULL|AS|FROM|JOIN|ON)\b|\b\d+(?:\.\d+)?\b)/gi;
  return String(code).split(token).map(part=>{
    if(!part)return '';
    let kind='';
    if(/^(?:\/\/|--)/.test(part))kind='syntax-comment';
    else if(/^["']/.test(part))kind='syntax-string';
    else if(/^\d/.test(part))kind='syntax-num';
    else if(/^(?:int|long|var|void|new|for|foreach|in|class|public|private|static|return|async|await|ref|using|SELECT|WHERE|ORDER|BY|PARTITION|OVER|ROW_NUMBER|DESC|AND|OR|NULL|AS|FROM|JOIN|ON)$/i.test(part))kind='syntax-keyword';
    return kind?'<span class="'+kind+'">'+escapeHTML(part)+'</span>':escapeHTML(part);
  }).join('');
}
function renderCodeBlock(code,lang,compact=false){return `<div class="code-block ${compact?'review-code':''}"><div class="code-toolbar"><span>${escapeHTML(lang||'Code')}</span></div><pre><code dir="ltr">${highlightedCode(code)}</code></pre></div>`}
function renderQuestion(q){const d=codeFor(q);return `<p class="prompt">${escapeHTML(d?.prompt||q.q)}</p>${d?renderCodeBlock(d.code,d.lang,true):''}`}
function choiceLabel(q,value){return [61,69,73].includes(q.id)?`<code class="answer-code">${escapeHTML(value)}</code>`:escapeHTML(value)}
const THEME_KEY='interview_gym_theme';
function applyTheme(theme){
  const t=theme==='dark'?'dark':'light';
  document.documentElement.dataset.theme=t;
  try{localStorage.setItem(THEME_KEY,t)}catch{}
  const button=$('themeToggle');
  button.textContent=t==='dark'?'☀ الوضع الفاتح':'☾ الوضع الداكن';
  button.setAttribute('aria-pressed',String(t==='dark'));
  document.querySelector('meta[name="theme-color"]').setAttribute('content',t==='dark'?'#161625':'#F6F6FA');
}

const KEY='interview_gym_session_v2',HKEY='interview_gym_history_v2';
const A=window.GymAssessment;
const $=id=>document.getElementById(id);
const BY_ID=new Map();
const CATEGORIES=[];
let state=null,interval=null;
const escapeHTML=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function loadJSON(key){try{return JSON.parse(localStorage.getItem(key))}catch{return null}}
function history(){
  const stored=loadJSON(HKEY);
  return stored && typeof stored==='object' && !Array.isArray(stored) ? stored : {};
}
function save(){if(state)localStorage.setItem(KEY,JSON.stringify(state))}
function saveHistory(h){localStorage.setItem(HKEY,JSON.stringify(h))}
function view(section){['setup','quiz','results'].forEach(id=>$(id).classList.toggle('hidden',id!==section));window.scrollTo(0,0)}
function filteredBank({category='all', difficulty='all', skill='all'}){
  return BANK.filter(q=>(category==='all'||q.category===category)&&
    (difficulty==='all'||q.difficulty===difficulty)&&(skill==='all'||q.skill===skill));
}
function paintProfile(containerId, h=history()){
  const profile=A.buildProfile(BANK,h);
  const container=$(containerId);
  container.innerHTML=profile.categories.map(p=>`<div class="skill-row">
    <div class="skill-row-top"><strong>${escapeHTML(p.category)}</strong><span>${p.score===null?'—':p.score+'%'} · ${escapeHTML(p.level)}</span></div>
    <div class="skill-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.score??0}" aria-label="${escapeHTML(p.category)}"><div style="width:${p.score??0}%"></div></div>
    <div class="skill-row-meta">${p.count}/${p.total} سؤال مختلف · الثقة: ${escapeHTML(p.confidence)}${p.assisted?' · بمساعدة: '+p.assisted:''}</div>
  </div>`).join('');
  const weakness=profile.categories.filter(x=>x.count>=3).sort((a,b)=>a.score-b.score)[0];
  const intro=profile.attempted<20?'تقييم أولي: يتطلب الحساب إنجاز مزيد من الأسئلة المتنوعة عبر مختلف التخصصات.':'المؤشرات تدريبية استرشادية مبنية على أسئلة الاختيار من متعدد، وليست تقييماً وظيفياً شاملاً.';
  const recommendation=weakness?`المجال المقترح للجولة القادمة: ${weakness.category} (مؤشر الأداء: ${weakness.score}% عبر ${weakness.count} أسئلة).`:'يُنصح ببدء اختبار تحديد المستوى، أو مواصلة الجولات التدريبية لجمع عينة كافية من البيانات.';
  const footer=$(containerId==='skillProfile'?'profileMessage':'resultProfileMessage');
  if(footer)footer.textContent=intro+' '+recommendation;
}
function setup(){
  const h=history();
  const mastery={unseen:0,review:0,reinforcement:0,mastered:0};
  const counts={};
  for(const q of BANK){
    mastery[A.masteryStatus(h[q.id])]++;
    counts[q.category]=(counts[q.category]||0)+1;
  }
  $('totalCount').textContent=BANK.length;
  for(const [status,count] of Object.entries(mastery))$(status+'Count').textContent=count;
  $('topics').innerHTML=Object.entries(counts).map(([cat,count])=>`<div class="topic-row"><span dir="auto">${escapeHTML(cat)}</span><strong>${count}</strong></div>`).join('');
  $('resume').disabled=!resumableSession(loadJSON(KEY));
  for(const id of ['retry','reinforce','revisit','reassess'])$(id).disabled=false;
  paintProfile('skillProfile',h);
}
function resumableSession(session){
  return session && !session.done && Array.isArray(session.ids) && session.ids.length &&
    session.ids.every(id=>BY_ID.has(id)) && Number.isInteger(session.index) &&
    session.index>=0 && session.index<=session.ids.length && session.answers && typeof session.answers==='object';
}
async function start(poolType='standard', plan='standard'){
  const h=history();
  const filters=plan==='placement'?{}:{
    category:$('category').value,
    difficulty:plan==='adaptive'?'all':$('difficulty').value,
    skill:$('skill').value
  };
  const bank=filteredBank(filters);
  const selectedPool=poolType==='reassess'?'mastered':poolType;
  const pool=plan==='placement'?bank:A.selectRound(bank,h,selectedPool);
  $('emptyRound').classList.toggle('hidden',pool.length>0);
  if(!pool.length)return;
  const previous=loadJSON(KEY);
  if(previous&&!previous.done){
    const accepted=await GymUI.confirm('جولة غير مكتملة','توجد جولة سابقة لم تكتمل بعد. هل تود بدء جولة جديدة واستبدال الجولة المحفوظة؟');
    if(!accepted)return;
  }
  const requested=plan==='placement'?30:+$('size').value;
  const target=Math.min(requested,pool.length);
  const mode=plan==='placement'||poolType==='reassess'?'exam':
    poolType==='mastered'?'learn':document.querySelector('input[name="mode"]:checked').value;
  const duration=+$('seconds').value;
  state={version:5,plan,ids:[],index:0,answers:{},hints:{},mode,duration,
    remainingMs:duration*1000,selected:null,paused:false,target,topicQueue:[],filters,
    done:false,createdAt:new Date().toISOString()};
  if(plan!=='standard'){
    state.topicQueue=A.buildTopicQueue(bank,h,plan,target,filters.category);
    state.target=state.topicQueue.length;
    const first=A.chooseQuestion(bank,h,state);
    if(first)state.ids.push(first.id);
  }else{
    state.ids=pool.slice(0,target).map(q=>q.id);
  }
  if(!state.ids.length){state=null;$('emptyRound').classList.remove('hidden');return}
  if(state.target<requested)GymUI.notify(`ستتضمن الجولة ${state.target} من أصل ${requested} سؤالاً، حسب الأسئلة المتاحة لهذه الجولة واختيارات التصفية.`);
  save();draw();
}
function current(){return BY_ID.get(state?.ids[state?.index])}
function remainingTime(){
  return Number.isFinite(state.deadline) ? Math.max(0,state.deadline-Date.now()) : state.remainingMs;
}
function stopClock(){
  clearInterval(interval);
  interval=null;
  if(Number.isFinite(state?.deadline)){
    state.remainingMs=remainingTime();
    delete state.deadline;
  }
}
function clockUI(){
  const seconds=Math.ceil(remainingTime()/1000);
  $('timer').textContent=state.duration?`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:'∞';
  $('timer').classList.toggle('warning',state.duration>0&&seconds<=15);
}
function checkClock(){
  clockUI();
  if(remainingTime()<=0)answer(null,'timeout');
}
function startClock(){
  clearInterval(interval);
  if(!state.duration){clockUI();return}
  state.deadline??=Date.now()+state.remainingMs;
  save();
  interval=setInterval(checkClock,200);
  checkClock();
}
function draw(){if(state.index>=state.target){finish();return}view('quiz');const q=current(),a=state.answers[q.id],learning=state.mode==='learn';$('questionNo').textContent=`السؤال ${state.index+1} من ${state.target||state.ids.length}`;$('runMode').textContent=state.plan==='placement'?'تحديد المستوى • تقييم أولي':state.plan==='adaptive'?'تدريب تكيفي وفق مستوى الأداء':learning?'وضع التعلم والمذاكرة':'وضع الاختبار — يُعرض الشرح في التقرير الختامي';const pct=Math.round(100*state.index/(state.target||state.ids.length));const pctStr=pct+'%';const pBar=$('progressBar');if(pBar){pBar.style.width=pctStr;pBar.style.height=pctStr}const pPct=$('progressPct');if(pPct)pPct.textContent=pctStr;$('topic').textContent=q.category;$('qTags').innerHTML=`<span>${escapeHTML(q.skill)}</span><span>${escapeHTML(q.difficulty)}</span>`;const code=codeFor(q);$('questionText').textContent=code?.prompt||q.q;$('microHintText').textContent=q.hint||'';const hintShown=!!state.hints[q.id];$('hintToggle').classList.toggle('hidden',!q.hint||!!a||hintShown);$('hintToggle').disabled=state.paused;$('hintToggle').setAttribute('aria-expanded',String(hintShown));$('microHint').classList.toggle('hidden',!q.hint||!hintShown);$('questionCode').classList.toggle('hidden',!code);if(code){$('codeLang').textContent=code.lang;$('codeText').innerHTML=highlightedCode(code.code)}$('choices').innerHTML=q.options.map((o,i)=>`<button class="choice ${state.selected===i?'selected':''} ${a&&learning?(i===q.answer?'correct':i===a.choice?'wrong':''):''}" data-option="${i}" ${a?'disabled':''} aria-pressed="${state.selected===i?'true':'false'}"><span class="letter">${'ABCD'[i]}</span><span class="answer-text">${choiceLabel(q,o)}</span></button>`).join('');if(!a)document.querySelectorAll('.choice').forEach(b=>b.addEventListener('click',()=>select(+b.dataset.option)));$('submit').classList.toggle('hidden',!!a);$('next').classList.toggle('hidden',!a);$('submit').disabled=state.selected===null||state.paused;$('skip').classList.toggle('hidden',!!a);$('pause').classList.toggle('hidden',!!a);$('pause').disabled=!state.duration;$('pause').textContent=state.paused?'استئناف المؤقت':'إيقاف مؤقت';$('shortcuts').textContent=state.paused?'المؤقت متوقف مؤقتًا. انقر على «استئناف» للمتابعة.':learning?'اختصارات: 1–4 للاختيار، Enter للتأكيد • يُعرض الشرح عقب الإجابة مباشرة':'اختصارات: 1–4 للاختيار، Enter للتأكيد • تُحجب الإجابات حتى ختام الجولة';$('feedback').classList.toggle('hidden',!(a&&learning));if(a&&learning){$('feedback').classList.toggle('bad',!a.correct);$('feedback').innerHTML=`<strong>${a.correct?'إجابة صحيحة':a.status==='timeout'?'انتهى الوقت المخصص':a.status==='skip'?'تم تخطي السؤال':'إجابة غير صحيحة'}</strong><p class="explain-label">الإجابة الصحيحة: <strong>${escapeHTML(q.options[q.answer])}</strong></p><p class="explain-reason">الشرح والتحليل: ${escapeHTML(q.why)}</p>`}clockUI();if(!a&&!state.paused)startClock()}
function select(i){if(!state||state.paused||state.answers[current().id])return;if(state.duration&&remainingTime()<=0){answer(null,'timeout');return}state.selected=i;document.querySelectorAll('.choice').forEach((b,j)=>{b.classList.toggle('selected',i===j);b.setAttribute('aria-pressed',String(i===j))});$('submit').disabled=false}
function answer(choice,status='answered'){
  if(!state||state.done||state.paused)return;
  const q=current();
  if(!q||state.answers[q.id])return;
  stopClock();
  if(state.duration&&state.remainingMs<=0){choice=null;status='timeout'}
  const seconds=state.duration&&!state.legacyTiming
    ? Math.max(0,state.duration*1000-state.remainingMs)/1000 : null;
  const correct=status==='answered'&&choice===q.answer;
  const hintUsed=!!state.hints[q.id];
  state.answers[q.id]={choice,correct,status,seconds,hintUsed};
  const h=history();
  const record={...h[q.id]};
  const counter=correct?'correct':'wrong';
  record[counter]=(Number(record[counter])||0)+1;
  record.correct??=0;
  record.wrong??=0;
  record.streak=correct?(Number(record.streak)||0)+1:0;
  Object.assign(record,{
    lastCorrect:correct,lastStatus:status,lastHint:hintUsed,lastSeconds:seconds,
    lastDuration:state.duration,lastMode:state.plan==='placement'?'placement':state.mode,
    lastAnsweredAt:new Date().toISOString()
  });
  record.masteryStatus=A.masteryStatus(record);
  h[q.id]=record;
  saveHistory(h);
  state.selected=null;
  save();
  if(state.mode==='exam')next();
  else draw();
}
function next(){
  stopClock();
  if((state.plan==='placement'||state.plan==='adaptive')&&state.ids.length<state.target){
    const pool=filteredBank(state.filters);
    const question=A.chooseQuestion(pool,history(),state);
    if(question)state.ids.push(question.id);
    else{
      state.target=state.ids.length;
      GymUI.notify(`انتهت الجولة بعد ${state.target} سؤالاً حسب الأسئلة المتاحة.`);
    }
  }
  state.index++;
  state.selected=null;
  state.remainingMs=state.duration*1000;
  delete state.legacyTiming;
  state.paused=false;
  save();draw();
}
function togglePause(){
  if(!state||state.answers[current().id]||!state.duration)return;
  if(!state.paused){
    stopClock();
    if(state.remainingMs<=0){answer(null,'timeout');return}
  }
  state.paused=!state.paused;
  save();draw();
}
function leave(){
  stopClock();
  state.paused=true;
  save();
  view('setup');setup();
}
function resume(){
  const data=loadJSON(KEY);
  if(!resumableSession(data)){GymUI.notify('لا توجد جولة سابقة محفوظة للاستئناف.','warn');return}
  state=data;
  state.plan??='standard';
  state.target??=state.ids.length;
  state.filters??={category:state.categoryFilter,skill:state.skillFilter};
  state.hints??={};
  if(!Number.isFinite(state.remainingMs)){
    // Old checkpoints rounded to whole seconds and may be stale after a reload.
    state.remainingMs=1000*(state.remaining??state.duration);
    state.legacyTiming=true;
    const q=current();
    if(q?.hint&&state.plan!=='placement'&&!state.answers[q.id])state.hints[q.id]=true;
  }
  state.version=5;
  state.paused=false;
  if(current()&&state.mode==='exam'&&state.answers[current().id])next();
  else{
    if(state.index>=state.ids.length)state.target=state.index;
    draw();
  }
}
function finish(){stopClock();state.done=true;save();view('results');const items=results();const right=items.filter(x=>x.a.correct).length,wrong=items.filter(x=>x.a.status==='answered'&&!x.a.correct).length,unanswered=items.filter(x=>x.a.status!=='answered').length;$('score').textContent=`${right}/${items.length}`;$('right').textContent=right;$('wrongCount').textContent=wrong;$('unanswered').textContent=unanswered;$('runInfo').textContent=`${Math.round(right/Math.max(1,items.length)*100)}% إجابات صحيحة • متوسط وقت الإجابة: ${Math.round(items.reduce((sum,x)=>sum+(x.a.seconds||0),0)/Math.max(1,items.filter(x=>x.a.seconds!==null).length))} ثانية • ${state.mode==='exam'?'وضع الاختبار':'وضع المذاكرة'} • ${items.length} سؤال`;
const m={};items.forEach(({q,a})=>{m[q.category]??={correct:0,count:0};m[q.category].count++;if(a.correct)m[q.category].correct++});$('breakdown').innerHTML=Object.entries(m).map(([name,stats])=>`<div class="topic-row"><span dir="auto">${escapeHTML(name)}</span><strong>${stats.correct}/${stats.count}</strong></div>`).join('');paintProfile('resultSkills');setFilter('weak');}
function results(){return state.ids.map(id=>({q:BY_ID.get(id),a:state.answers[id]})).filter(x=>x.a)}
function setFilter(filter){document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));const items=results().filter(x=>filter==='all'||(filter==='timeout'?x.a.status==='timeout':!x.a.correct));$('reviewList').innerHTML=items.length?items.map(({q,a},i)=>{const status=a.correct?'صحيحة':a.status==='timeout'?'انتهى الوقت':a.status==='skip'?'تم التخطي':'خاطئة';const color=a.correct?'success':a.status==='timeout'?'timeout':'error';return `<details class="review-item"><summary><span class="dot ${color}"></span><span>${escapeHTML(q.category)}</span> — ${escapeHTML(status)} <span class="small muted">(السؤال ${q.id} • ${escapeHTML(q.difficulty)}${a.seconds!=null?` • ${a.seconds} ثانية`:``})</span></summary><div class="review-body">${renderQuestion(q)}<p>إجابتك: <strong dir="auto">${a.choice===null?'لم تُجب':escapeHTML(q.options[a.choice])}</strong></p><p>الإجابة الصحيحة: <strong dir="auto">${escapeHTML(q.options[q.answer])}</strong></p><p class="explain"><strong>الشرح والتحليل:</strong> ${escapeHTML(q.why)}</p></div></details>`}).join(''):'<p class="muted">لا توجد أسئلة ضمن هذا التصنيف خلال الجولة الحالية.</p>'}
function reportText(){const all=results(),right=all.filter(x=>x.a.correct).length;return `.NET Interview Gym — ${right}/${all.length}\nMode: ${state.mode}\n\n`+all.filter(x=>!x.a.correct).map(({q,a})=>`[${q.category}] ${q.q}\nإجابتي: ${a.choice===null?'لم أجب':q.options[a.choice]}\nالصحيح: ${q.options[q.answer]}\nالتفسير: ${q.why}`).join('\n\n')}
function copyReport(){const str=reportText();if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(str).then(()=>GymUI.notify('تم نسخ التقرير ✓')).catch(()=>fallbackCopy(str))}else fallbackCopy(str)}
function fallbackCopy(str){const t=document.createElement('textarea');t.value=str;document.body.appendChild(t);t.select();try{if(document.execCommand('copy'))GymUI.notify('تم نسخ التقرير ✓');else GymUI.notify('تعذر النسخ تلقائيًا.','warn')}catch{GymUI.notify('تعذر النسخ تلقائيًا.','warn')}t.remove()}
$('placement').addEventListener('click',()=>start('standard','placement'));
$('adaptive').addEventListener('click',()=>start('standard','adaptive'));
$('hintToggle').addEventListener('click',()=>{
  const q=current();
  if(!q?.hint||state.paused||state.answers[q.id])return;
  if(state.duration&&remainingTime()<=0){answer(null,'timeout');return}
  state.hints[q.id]=true;
  save();draw();
});
$('start').addEventListener('click',()=>start());
$('retry').addEventListener('click',()=>start('review'));
$('reinforce').addEventListener('click',()=>start('reinforcement'));
$('revisit').addEventListener('click',()=>start('mastered'));
$('reassess').addEventListener('click',()=>start('reassess'));
$('again').addEventListener('click',()=>{view('setup');setup();start('review')});
$('resume').addEventListener('click',resume);
$('submit').addEventListener('click',()=>{if(state.selected!==null&&!state.paused)answer(state.selected)});$('skip').addEventListener('click',()=>answer(null,'skip'));$('next').addEventListener('click',next);$('pause').addEventListener('click',togglePause);$('exit').addEventListener('click',leave);$('newRound').addEventListener('click',()=>{view('setup');setup()});$('copy').addEventListener('click',copyReport);$('reset').addEventListener('click',async()=>{if(await GymUI.confirm('إعادة ضبط التقدم','سيتم حذف كافة نتائجك والجولة المحفوظة على هذا الجهاز. هل أنت متأكد من المتابعة؟','إعادة الضبط')){localStorage.removeItem(KEY);localStorage.removeItem(HKEY);state=null;setup();GymUI.notify('تمت إعادة ضبط بيانات التقدم بنجاح.')}});document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setFilter(b.dataset.filter)));
function populateCategories(){CATEGORIES.forEach(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;$('category').appendChild(o)})}
document.addEventListener('keydown',ev=>{if($('quiz').classList.contains('hidden')||!state||ev.altKey||ev.ctrlKey||ev.metaKey)return;if(ev.target instanceof HTMLInputElement||ev.target instanceof HTMLSelectElement)return;if(state.paused||state.answers[current().id])return;const opts=['1','2','3','4','a','b','c','d'];const n=opts.indexOf(ev.key.toLowerCase());if(n>=0){select(n%4);ev.preventDefault()}if(ev.key==='Enter'&&state.selected!==null){answer(state.selected);ev.preventDefault()}});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&Number.isFinite(state?.deadline))checkClock();
});

$('themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
$('copyCode').addEventListener('click',()=>{
  const q=current();if(!q)return;const code=codeFor(q)?.code;if(!code)return;
  const done=()=>{const btn=$('copyCode');btn.textContent='تم النسخ ✓';setTimeout(()=>{btn.textContent='نسخ الكود'},1200)};
  if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(code).then(done).catch(()=>fallbackCopyCode(code,done));
  else fallbackCopyCode(code,done);
});
function fallbackCopyCode(code,done){const node=document.createElement('textarea');node.value=code;document.body.appendChild(node);node.select();try{if(document.execCommand('copy'))done()}catch{}node.remove()}
applyTheme(document.documentElement.dataset.theme);

loadQuestionBank();
async function loadQuestionBank(){
  try {
    const response=await fetch('questions/manifest.json',{cache:'no-cache'});
    if(!response.ok)throw new Error(`manifest HTTP ${response.status}`);
    const manifest=await response.json();
    if(manifest.schemaVersion!==1||!Array.isArray(manifest.files))throw new Error('Invalid manifest');
    const shards=await Promise.all(manifest.files.map(async entry=>{
      const res=await fetch(entry.path);
      if(!res.ok)throw new Error(`${entry.path}: HTTP ${res.status}`);
      return res.json();
    }));
    BANK=shards.flatMap(data=>data.questions||[]);
    if(BANK.length!==manifest.total)throw new Error('Question bank count mismatch');
    BANK.forEach(q=>{if(BY_ID.has(q.id))throw new Error(`Duplicate question ID ${q.id}`);BY_ID.set(q.id,q)});
    CATEGORIES.push(...new Set(BANK.map(q=>q.category)));
    populateCategories();
    $('start').disabled=false;$('placement').disabled=false;$('adaptive').disabled=false;
    $('loadStatus').textContent=`بنك الأسئلة جاهز: يتضمن ${BANK.length} سؤالاً.`;
    setup();
  }catch(err){
    console.error('Question bank loading failed:',err);
    $('loadStatus').textContent='تعذر تحميل ملفات الأسئلة. يُرجى تشغيل التطبيق عبر خادم محلي (Local Server) أو استضافته على GitHub Pages، وليس بفتح ملف index.html مباشرة.';
    GymUI.notify('تعذر تحميل بنك الأسئلة. يُرجى التحقق من بيئة التشغيل.','warn',7500);
  }
}
function exportProgress(){
  const backup={schema:'interview-gym-progress-v1',exportedAt:new Date().toISOString(),history:history(),session:loadJSON(KEY)};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=`interview-gym-progress-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  GymUI.notify('تم تصدير ملف بيانات التقدم بنجاح.');
}
$('exportProgress').addEventListener('click',exportProgress);
$('importProgress').addEventListener('click',()=>$('progressFile').click());
$('progressFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
    if(file.size>5_000_000)throw new Error('File too large');
    const backup=JSON.parse(await file.text());
    if(backup.schema!=='interview-gym-progress-v1'||!backup.history||typeof backup.history!=='object'||Array.isArray(backup.history))throw new Error('Invalid backup');
    const accepted=await GymUI.confirm('استيراد التقدم','سيؤدي هذا الإجراء إلى استبدال كافة بيانات التقدم المحفوظة على هذا الجهاز. هل ترغب في المتابعة؟','استيراد');
    if(accepted){
      localStorage.setItem(HKEY,JSON.stringify(backup.history));
      const s=backup.session;
      if(resumableSession(s))localStorage.setItem(KEY,JSON.stringify(s));
      else localStorage.removeItem(KEY);
      state=null;
      setup();GymUI.notify('تم استيراد بيانات التقدم بنجاح ✓');
    }
  }catch(err){console.error(err);GymUI.notify('ملف التقدم غير صالح أو لا يمكن قراءته.','warn')}
  event.target.value='';
});
