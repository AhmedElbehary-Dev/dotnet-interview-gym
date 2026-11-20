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
const $=id=>document.getElementById(id);
const BY_ID=new Map();
const CATEGORIES=[];
let state=null,interval=null,deadline=null,reviewFilter='weak';
const escapeHTML=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function loadJSON(key){try{return JSON.parse(localStorage.getItem(key))}catch{return null}}
function history(){return loadJSON(HKEY)||{}}
function save(){if(state)localStorage.setItem(KEY,JSON.stringify(state))}
function saveHistory(h){localStorage.setItem(HKEY,JSON.stringify(h))}
function view(section){['setup','quiz','results'].forEach(id=>$(id).classList.toggle('hidden',id!==section));window.scrollTo(0,0)}
function shuffle(items){let a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function pending(q,h){const r=h[q.id];return r && r.wrong>0 && (r.streak||0)<2}
function setup(){const h=history();$('totalCount').textContent=BANK.length;$('triedCount').textContent=Object.keys(h).length;$('needsCount').textContent=BANK.filter(q=>pending(q,h)).length;$('masteredCount').textContent=BANK.filter(q=>h[q.id]?.wrong>0 && h[q.id].streak>=2).length;const counts={};BANK.forEach(q=>counts[q.category]=(counts[q.category]||0)+1);$('topics').innerHTML=Object.entries(counts).map(([cat,count])=>`<div class="topic-row"><span dir="auto">${escapeHTML(cat)}</span><strong>${count}</strong></div>`).join('');const previous=loadJSON(KEY);$('resume').disabled=!(previous&&Array.isArray(previous.ids)&&!previous.done);$('retry').disabled=!BANK.some(q=>pending(q,h));}
async function start(retry=false){
  const previous=loadJSON(KEY);
  if(previous&&!previous.done){
    const accepted=await GymUI.confirm('جولة غير مكتملة','فيه جولة لم تكتمل. تبدأ جولة جديدة وتستبدل المحفوظة؟');
    if(!accepted)return;
  }
  const h=history();
  const category=$('category').value,difficulty=$('difficulty').value,skill=$('skill').value;
  const pool=retry?BANK.filter(q=>pending(q,h)):BANK.filter(q=>
    (category==='all'||q.category===category)&&
    (difficulty==='all'||q.difficulty===difficulty)&&
    (skill==='all'||q.skill===skill)
  );
  if(!pool.length){GymUI.notify(retry?'مفيش أخطاء محتاجة إعادة حاليًا.':'مفيش أسئلة مطابقة للتصفية.','warn');return}
  const target=Math.min(+$('size').value,pool.length);
  const unseen=shuffle(pool.filter(q=>!h[q.id]));
  const seen=shuffle(pool.filter(q=>!!h[q.id]));
  // Prefer unseen questions. Once the filtered pool is exhausted, permit repeats.
  const ids=[...unseen,...seen].slice(0,target).map(q=>q.id);
  if(!retry && unseen.length<target){
    GymUI.notify(unseen.length?`فيه ${unseen.length} سؤال جديد، والباقي للمراجعة.`:'حلّيت كل الأسئلة المتاحة في التصنيف ده، فالجولة هتراجع منها أسئلة سابقة.');
  }
  state={version:3,ids,index:0,answers:{},mode:document.querySelector('input[name="mode"]:checked').value,duration:+$('seconds').value,remaining:+$('seconds').value,selected:null,paused:false,done:false,createdAt:new Date().toISOString()};
  save();draw();
}
function current(){return BY_ID.get(state?.ids[state?.index])}
function stopClock(){if(interval!==null){clearInterval(interval);interval=null}if(deadline!==null&&state?.duration){state.remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000))}deadline=null}
function clockUI(){const seconds=Math.max(0,state.remaining);$('timer').textContent=state.duration?`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:'∞';$('timer').classList.toggle('warning',state.duration>0&&seconds<=15)}
function startClock(){stopClock();if(state.paused||!state.duration||state.answers[current().id]){clockUI();return}deadline=Date.now()+state.remaining*1000;interval=setInterval(()=>{const n=Math.max(0,Math.ceil((deadline-Date.now())/1000));if(n!==state.remaining){state.remaining=n;clockUI();if(n%5===0)save()}if(n<=0){stopClock();answer(null,'timeout')}},200);clockUI()}
function draw(){stopClock();if(state.index>=state.ids.length){finish();return}view('quiz');const q=current(),a=state.answers[q.id],learning=state.mode==='learn';$('questionNo').textContent=`السؤال ${state.index+1} من ${state.ids.length}`;$('runMode').textContent=learning?'وضع المذاكرة':'وضع الاختبار — الشرح في التقرير النهائي';$('progressBar').style.width=(100*state.index/state.ids.length)+'%';$('topic').textContent=q.category;$('qTags').innerHTML=`<span>${escapeHTML(q.skill)}</span><span>${escapeHTML(q.difficulty)}</span>`;const code=codeFor(q);$('questionText').textContent=code?.prompt||q.q;$('microHintText').textContent=q.hint||'';$('questionCode').classList.toggle('hidden',!code);if(code){$('codeLang').textContent=code.lang;$('codeText').innerHTML=highlightedCode(code.code)}$('choices').innerHTML=q.options.map((o,i)=>`<button class="choice ${state.selected===i?'selected':''} ${a&&learning?(i===q.answer?'correct':i===a.choice?'wrong':''):''}" data-option="${i}" ${a?'disabled':''} aria-pressed="${state.selected===i?'true':'false'}"><span class="letter">${'ABCD'[i]}</span><span class="answer-text">${choiceLabel(q,o)}</span></button>`).join('');if(!a)document.querySelectorAll('.choice').forEach(b=>b.addEventListener('click',()=>select(+b.dataset.option)));$('submit').classList.toggle('hidden',!!a);$('next').classList.toggle('hidden',!a);$('submit').disabled=state.selected===null||state.paused;$('skip').classList.toggle('hidden',!!a);$('pause').classList.toggle('hidden',!!a);$('pause').disabled=!state.duration;$('pause').textContent=state.paused?'استكمال المؤقت':'إيقاف مؤقت';$('shortcuts').textContent=state.paused?'المؤقت متوقف. اضغط استكمال المؤقت للمتابعة.':learning?'اختصارات: 1–4 للاختيار، Enter للتأكيد • الشرح بعد الإجابة':'اختصارات: 1–4 للاختيار، Enter للتأكيد • لن تظهر الإجابة الآن';$('feedback').classList.toggle('hidden',!(a&&learning));if(a&&learning){$('feedback').classList.toggle('bad',!a.correct);$('feedback').innerHTML=`<strong>${a.correct?'إجابة صحيحة':a.status==='timeout'?'انتهى الوقت':a.status==='skip'?'تم التخطي':'إجابة غير صحيحة'}</strong><p class="explain-label">الإجابة الصح: <strong>${escapeHTML(q.options[q.answer])}</strong></p><p class="explain-reason">ليه؟ ${escapeHTML(q.why)}</p>`}clockUI();if(!a&&!state.paused)startClock()}
function select(i){if(!state||state.paused||state.answers[current().id])return;if(deadline!==null&&Date.now()>=deadline){answer(null,'timeout');return}state.selected=i;document.querySelectorAll('.choice').forEach((b,j)=>{b.classList.toggle('selected',i===j);b.setAttribute('aria-pressed',String(i===j))});$('submit').disabled=false}
function answer(choice,status='answered'){if(!state||state.done)return;const q=current();if(!q||state.answers[q.id])return;if(status==='answered'&&deadline!==null&&Date.now()>=deadline){choice=null;status='timeout'}const spent=state.duration?Math.max(0,state.duration-Math.max(0,deadline===null?state.remaining:Math.ceil((deadline-Date.now())/1000))):null;stopClock();const correct=status==='answered'&&choice===q.answer;state.answers[q.id]={choice,correct,status,seconds:spent};const h=history();const record=h[q.id]||{correct:0,wrong:0,streak:0};record[correct?'correct':'wrong']++;record.streak=correct?(record.streak||0)+1:0;record.lastCorrect=correct;record.lastStatus=status;h[q.id]=record;saveHistory(h);state.selected=null;save();if(state.mode==='exam'){next()}else{draw()}}
function next(){stopClock();state.index++;state.selected=null;state.remaining=state.duration;state.paused=false;save();draw()}
function togglePause(){if(!state||state.answers[current().id]||!state.duration)return;if(state.paused){state.paused=false;save();draw()}else{stopClock();state.paused=true;save();draw()}}
function leave(){stopClock();state.paused=true;save();view('setup');setup()}
function finish(){stopClock();state.done=true;save();view('results');const items=results();const right=items.filter(x=>x.a.correct).length,wrong=items.filter(x=>x.a.status==='answered'&&!x.a.correct).length,unanswered=items.filter(x=>x.a.status!=='answered').length;$('score').textContent=`${right}/${items.length}`;$('right').textContent=right;$('wrongCount').textContent=wrong;$('unanswered').textContent=unanswered;$('runInfo').textContent=`${Math.round(right/Math.max(1,items.length)*100)}% إجابات صحيحة • متوسط وقت الإجابة: ${Math.round(items.reduce((sum,x)=>sum+(x.a.seconds||0),0)/Math.max(1,items.filter(x=>x.a.seconds!==null).length))} ثانية • ${state.mode==='exam'?'وضع الاختبار':'وضع المذاكرة'} • ${items.length} سؤال`;
const m={};items.forEach(({q,a})=>{m[q.category]??={correct:0,count:0};m[q.category].count++;if(a.correct)m[q.category].correct++});$('breakdown').innerHTML=Object.entries(m).map(([name,stats])=>`<div class="topic-row"><span dir="auto">${escapeHTML(name)}</span><strong>${stats.correct}/${stats.count}</strong></div>`).join('');setFilter('weak');}
function results(){return state.ids.map(id=>({q:BY_ID.get(id),a:state.answers[id]})).filter(x=>x.a)}
function setFilter(filter){reviewFilter=filter;document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));const items=results().filter(x=>filter==='all'||(filter==='timeout'?x.a.status==='timeout':!x.a.correct));$('reviewList').innerHTML=items.length?items.map(({q,a},i)=>{const status=a.correct?'صحيحة':a.status==='timeout'?'انتهى الوقت':a.status==='skip'?'مش عارف':'خاطئة';const color=a.correct?'success':a.status==='timeout'?'timeout':'error';return `<details class="review-item"><summary><span class="dot ${color}"></span><span>${escapeHTML(q.category)}</span> — ${escapeHTML(status)} <span class="small muted">(السؤال ${q.id} • ${escapeHTML(q.difficulty)}${a.seconds!=null?` • ${a.seconds} ثانية`:``})</span></summary><div class="review-body">${renderQuestion(q)}<p>إجابتك: <strong dir="auto">${a.choice===null?'لم تجب':escapeHTML(q.options[a.choice])}</strong></p><p>الإجابة الصح: <strong dir="auto">${escapeHTML(q.options[q.answer])}</strong></p><p class="explain"><strong>الشرح:</strong> ${escapeHTML(q.why)}</p></div></details>`}).join(''):'<p class="muted">مفيش أسئلة في التصنيف ده خلال الجولة.</p>'}
function reportText(){const all=results(),right=all.filter(x=>x.a.correct).length;return `.NET Interview Gym — ${right}/${all.length}\nMode: ${state.mode}\n\n`+all.filter(x=>!x.a.correct).map(({q,a})=>`[${q.category}] ${q.q}\nإجابتي: ${a.choice===null?'لم أجب':q.options[a.choice]}\nالصحيح: ${q.options[q.answer]}\nالتفسير: ${q.why}`).join('\n\n')}
function copyReport(){const str=reportText();if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(str).then(()=>GymUI.notify('تم نسخ التقرير ✓')).catch(()=>fallbackCopy(str))}else fallbackCopy(str)}
function fallbackCopy(str){const t=document.createElement('textarea');t.value=str;document.body.appendChild(t);t.select();try{if(document.execCommand('copy'))GymUI.notify('تم نسخ التقرير ✓');else GymUI.notify('تعذر النسخ تلقائيًا.','warn')}catch{GymUI.notify('تعذر النسخ تلقائيًا.','warn')}t.remove()}
$('start').addEventListener('click',()=>start(false));$('retry').addEventListener('click',()=>start(true));$('again').addEventListener('click',()=>{view('setup');start(true)});$('resume').addEventListener('click',()=>{const data=loadJSON(KEY);if(!data||!Array.isArray(data.ids)||data.done){GymUI.notify('مفيش جولة محفوظة.','warn');return}state=data;state.paused=false;save();draw()});$('submit').addEventListener('click',()=>{if(state.selected!==null&&!state.paused)answer(state.selected)});$('skip').addEventListener('click',()=>answer(null,'skip'));$('next').addEventListener('click',next);$('pause').addEventListener('click',togglePause);$('exit').addEventListener('click',leave);$('newRound').addEventListener('click',()=>{view('setup');setup()});$('copy').addEventListener('click',copyReport);$('reset').addEventListener('click',async()=>{if(await GymUI.confirm('مسح التقدم','هتمسح نتائجك والجولة المحفوظة على الجهاز ده. متأكد؟','مسح التقدم')){localStorage.removeItem(KEY);localStorage.removeItem(HKEY);setup();GymUI.notify('تم مسح التقدم.')}});document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setFilter(b.dataset.filter)));
function populateCategories(){CATEGORIES.forEach(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;$('category').appendChild(o)})}
document.addEventListener('keydown',ev=>{if($('quiz').classList.contains('hidden')||!state||ev.altKey||ev.ctrlKey||ev.metaKey)return;if(ev.target instanceof HTMLInputElement||ev.target instanceof HTMLSelectElement)return;if(state.paused||state.answers[current().id])return;const opts=['1','2','3','4','a','b','c','d'];const n=opts.indexOf(ev.key.toLowerCase());if(n>=0){select(n%4);ev.preventDefault()}if(ev.key==='Enter'&&state.selected!==null){answer(state.selected);ev.preventDefault()}});
window.addEventListener('beforeunload',()=>{if(state&&!state.done){if(deadline!==null)state.remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));state.paused=true;save()}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&deadline!==null&&Date.now()>=deadline)answer(null,'timeout')});

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
    $('start').disabled=false;
    $('loadStatus').textContent=`البنك جاهز: ${BANK.length} سؤال. الأولوية للأسئلة الجديدة في كل جولة.`;
    setup();
  }catch(err){
    console.error('Question bank loading failed:',err);
    $('loadStatus').textContent='تعذر تحميل ملفات الأسئلة. افتح التطبيق عن طريق GitHub Pages أو Local Server، مش مباشرة من ملف index.html.';
    GymUI.notify('تعذر تحميل بنك الأسئلة. راجع طريقة التشغيل.','warn',7500);
  }
}
function exportProgress(){
  const backup={schema:'interview-gym-progress-v1',exportedAt:new Date().toISOString(),history:history(),session:loadJSON(KEY)};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=`interview-gym-progress-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  GymUI.notify('تم تصدير نسخة من تقدمك.');
}
$('exportProgress').addEventListener('click',exportProgress);
$('importProgress').addEventListener('click',()=>$('progressFile').click());
$('progressFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
    if(file.size>5_000_000)throw new Error('File too large');
    const backup=JSON.parse(await file.text());
    if(backup.schema!=='interview-gym-progress-v1'||!backup.history||typeof backup.history!=='object'||Array.isArray(backup.history))throw new Error('Invalid backup');
    const accepted=await GymUI.confirm('استيراد التقدم','ده هيستبدل التقدم المحفوظ على الجهاز الحالي. تكمّل؟','استيراد');
    if(accepted){
      localStorage.setItem(HKEY,JSON.stringify(backup.history));
      const s=backup.session;
      if(s&&Array.isArray(s.ids)&&s.ids.every(id=>BY_ID.has(id))&&!s.done)localStorage.setItem(KEY,JSON.stringify(s));
      else localStorage.removeItem(KEY);
      setup();GymUI.notify('تم استيراد التقدم بنجاح ✓');
    }
  }catch(err){console.error(err);GymUI.notify('ملف التقدم غير صالح أو لا يمكن قراءته.','warn')}
  event.target.value='';
});
