import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');
const store=new Map();
const elements=new Map();
class FakeElement {
  constructor(id){this.id=id;this.style={};this.textContent='';this.innerHTML='';this.value=id==='size'?'30':id==='category'||id==='difficulty'||id==='skill'?'all':id==='seconds'?'75':'';this.disabled=false;this.children=[];this.classList={toggle:()=>{},add:()=>{},remove:()=>{},contains:()=>false};}
  addEventListener(){}
  setAttribute(){}
  appendChild(e){this.children.push(e)}
  remove(){}
  focus(){}
}
function el(id){if(!elements.has(id))elements.set(id,new FakeElement(id));return elements.get(id)}
const document={
  documentElement:{dataset:{theme:'light'}},
  getElementById:el,
  querySelector:(sel)=>sel==='input[name="mode"]:checked'?{value:'exam'}:new FakeElement(sel),
  querySelectorAll:()=>[],
  createElement:tag=>new FakeElement(tag),
  addEventListener(){},body:{appendChild(){}}
};
const localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
const uiMessages=[];
const context=vm.createContext({document,window:{scrollTo(){},addEventListener(){},isSecureContext:false},localStorage,console,
  setInterval,clearInterval,setTimeout,clearTimeout,URL,Blob,Math,Date,
  GymUI:{notify:(...args)=>uiMessages.push(args),confirm:async()=>true},
  fetch:async(p)=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'))})
});
vm.runInContext(app,context,{filename:'app.js'});
await new Promise(r=>setTimeout(r,50));
assert.equal(vm.runInContext('BANK.length',context),120);
assert.equal(elements.get('totalCount').textContent,120);
assert.equal(elements.get('start').disabled,false);
assert.equal(vm.runInContext('CATEGORIES.length',context),10);
await vm.runInContext('start(false)',context);
assert.equal(vm.runInContext('state.ids.length',context),30);
let firstId=vm.runInContext('current().id',context);
vm.runInContext('answer(current().answer)',context);
assert.equal(vm.runInContext('state.index',context),1);
assert.equal(Object.keys(JSON.parse(store.get('interview_gym_history_v2'))).length,1);
vm.runInContext('leave()',context);
await vm.runInContext('start(false)',context);
assert.notEqual(vm.runInContext('current().id',context),firstId);
vm.runInContext('stopClock()',context);
console.log('Smoke test OK: loads JSON, starts timed exam, saves history, prefers unseen and restores flow.');
