const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function utility(name) {
  const scope={module:{exports:{}},Date};
  vm.runInNewContext(fs.readFileSync(path.join(root,'miniprogram/utils',`${name}.js`),'utf8'),scope);
  return scope.module.exports;
}
const ranges = utility('history-range');
const cache = utility('catalog-cache');

function predicate(fn) { return { test: fn, and(other) {return predicate(value => fn(value) && other.test(value));} }; }
function matches(record, where) {return Object.entries(where).every(([key, value]) => value && value.test ? value.test(record[key]) : value === record[key]);}
function harness(functionName, fixtures, openid='founder') {
  const reads=[];
  const command={gte:v=>predicate(x=>x>=v),lt:v=>predicate(x=>x<v),gt:v=>predicate(x=>x>v),in:v=>predicate(x=>v.includes(x)),eq:v=>predicate(x=>x===v),neq:v=>predicate(x=>x!==v)};
  const db={command,collection(name){
    let where={},sorts=[],skip=0,limit=100;
    const query={where(v){where=v;return query;},orderBy(k,d){sorts.push([k,d]);return query;},skip(v){skip=v;return query;},limit(v){limit=v;return query;},async get(){
      reads.push(name);
      let data=(fixtures[name]||[]).filter(x=>matches(x,where));
      data=data.slice().sort((a,b)=>{for(const [key,dir] of sorts){const diff=String(a[key]).localeCompare(String(b[key]));if(diff)return dir==='desc'?-diff:diff;}return 0;});
      return {data:data.slice(skip,skip+limit)};
    },doc(id){return {async get(){reads.push(name);return {data:(fixtures[name]||[]).find(x=>x._id===id)};}};}};
    return query;
  }};
  const scope={exports:{},Date,console:{error(){},warn(){}},require(name){
    if(name==='crypto')return crypto;
    if(name==='wx-server-sdk')return {init(){},DYNAMIC_CURRENT_ENV:'test',database:()=>db,getWXContext:()=>({OPENID:openid})};
    throw new Error(name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'cloudfunctions',functionName,'index.js'),'utf8'),scope);
  return {main:scope.exports.main,reads};
}
function admin(role, active=true){return {_id:crypto.createHash('sha256').update(role==='owner'?'coowner':'founder').digest('hex'),role,active,displayName:'测试店主'};}
const normalized = data => JSON.parse(JSON.stringify(data));

test('week picker handles cross-month first week, current week and leap-year month',()=>{
  const weeks=ranges.weeksForMonth('2026-09');
  assert.equal(weeks[0].label,'8/31～9/6（第一周）');
  assert.equal(weeks[1].label,'9/7～9/13（第二周）');
  assert.equal(weeks.find(w=>w.startDate<='2026-09-14'&&w.endDate>='2026-09-14').label,'9/14～9/20（第三周）');
  assert.equal(ranges.rangeFor('month','2028-02-01').endDate,'2028-02-29');
  assert.equal(ranges.weeksForMonth('2027-01')[0].startDate,'2026-12-28');
});
test('public catalog expires and never contains authority or availability decisions',()=>{
  const services=[{_id:'basic-care'}];cache.saveCatalog(services,1000);
  assert.equal(cache.getCatalog(1001),services);
  assert.equal(cache.getCatalog(301000),null);
  assert.equal(cache.getCatalog(999),null);
});
test('ordinary and disabled WeChat accounts receive no appointment data on summary/dashboard',async()=>{
  for(const user of ['stranger','founder']){
    for(const action of ['summary','dashboard']){
      const h=harness('ownerAppointments',{admins:[admin('super_admin',false)],settings:[{_id:'system',ownerBindingStatus:'bound'}],appointments:[{customerName:'private'}]},user);
      const result=await h.main({action});assert.equal(result.isAdmin,false);assert.equal(h.reads.includes('appointments'),false);assert.equal(JSON.stringify(result).includes('private'),false);
    }
  }
});
test('co-owner dashboard excludes account management and homepage summary limits fields',async()=>{
  const future=new Date(Date.now()+86400000).toISOString();
  const appointments=Array.from({length:8},(_,i)=>({_id:String(i),status:i===7?'pending':'confirmed',startsAt:future,customerName:'客人',scheduledDate:'2099-01-01',scheduledTime:'09:00',customerOpenid:'secret',contact:'private',note:'private'}));
  const h=harness('ownerAppointments',{admins:[admin('owner'),admin('super_admin')],appointments},'coowner');
  const dash=await h.main({action:'dashboard'});assert.equal(dash.isAdmin,true);assert.deepEqual(normalized(dash.admins),[]);assert.equal(h.reads.filter(n=>n==='admins').length,1);
  const summary=await h.main({action:'summary'});assert.equal(summary.appointments.length,5);assert.equal(summary.hasMore,true);assert.equal(JSON.stringify(summary).includes('secret'),false);assert.equal(JSON.stringify(summary).includes('private'),false);
});
test('history filter applies before sorting/paging and includes both cancellation sources',async()=>{
  const appointments=Array.from({length:130},(_,i)=>({_id:String(i).padStart(3,'0'),startsAt:'2026-09-14T06:00:00.000Z',status:['pending','confirmed','cancelled_by_customer','cancelled_by_owner'][i%4],customerName:'客人',serviceName:'护理'}));
  const h=harness('ownerAppointments',{admins:[admin('super_admin')],appointments});
  const args={action:'query',startDate:'2026-09-14',endDate:'2026-09-14'};
  const all=await h.main(args);assert.equal(all.records.length,50);assert.equal(all.hasMore,true);
  const booked=await h.main({...args,statusFilter:'booked'});assert.equal(booked.records.length,50);assert.ok(booked.records.every(x=>['pending','confirmed'].includes(x.status)));
  const rest=await h.main({...args,statusFilter:'booked',offset:booked.nextOffset});assert.equal(rest.hasMore,false);assert.equal(rest.records.length,16);assert.equal(new Set([...booked.records,...rest.records].map(x=>x.id)).size,66);
  const cancelled=await h.main({...args,statusFilter:'cancelled'});assert.ok(cancelled.records.every(x=>x.status.startsWith('cancelled_')));assert.equal(cancelled.records[0].id,'127');
  assert.equal((await h.main({...args,statusFilter:'unexpected'})).code,'INVALID_HISTORY_FILTER');
});
test('new history endpoints still reject ordinary customers and invalid ranges',async()=>{
  const h=harness('ownerAppointments',{admins:[],appointments:[{customerName:'private'}]},'stranger');
  assert.equal((await h.main({action:'query',startDate:'2026-09-01',endDate:'2026-09-30'})).code,'OWNER_FORBIDDEN');
  assert.equal(h.reads.includes('appointments'),false);
});
test('parallel availability queries still honor time locks and temporary closures',async()=>{
  const tomorrow=ranges.addDays(ranges.todayDate(),1);
  const weekday=new Date(`${tomorrow}T00:00:00Z`).getUTCDay();
  const fixtures={services:[{_id:'s',active:true,durationMinutes:60,bookingBlockMinutes:150}],settings:[{_id:'system',primaryResourceId:'room'}],business_hours:[{_id:`weekday-${weekday}`,enabled:true,openingSlots:['09:00','12:00']}],appointment_slots:[],schedule_blocks:[]};
  const args={serviceId:'s',date:tomorrow,customTime:'09:00'};
  assert.equal((await harness('getAvailability',fixtures).main(args)).slots[0].available,true);
  fixtures.appointment_slots=[{_id:`room__${tomorrow}__0900`}];
  assert.equal((await harness('getAvailability',fixtures).main(args)).slots[0].reason,'已占用');
  fixtures.appointment_slots=[];fixtures.schedule_blocks=[{resourceId:'room',startsAt:new Date(`${tomorrow}T10:00:00+08:00`).toISOString(),endsAt:new Date(`${tomorrow}T12:00:00+08:00`).toISOString()}];
  assert.equal((await harness('getAvailability',fixtures).main(args)).slots[0].reason,'白兰偷懒,正在深度休息中~');
});
