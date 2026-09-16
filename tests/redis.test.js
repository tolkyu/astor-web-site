import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
for(const key of Object.keys(process.env))if(/^(KV_REST_|UPSTASH_|VERCEL|AWS_LAMBDA_|ADMIN_|TELEGRAM_)/.test(key))delete process.env[key];
process.env.KV_REST_API_URL='https://redis.invalid';
process.env.KV_REST_API_TOKEN='test-token';
const state=new Map();
let unavailable=false;
globalThis.fetch=async(url,options)=>{
 assert(String(url).startsWith('https://redis.invalid'));
 if(unavailable)throw new Error('Simulated Redis outage');
 const execute=([op,...args])=>{
  if(op==='GET')return state.get(args[0])??null;
  if(op==='PING')return 'PONG';
  if(op==='EVAL'){
   const [script,count,key,expected,next]=args;
   assert(script.includes("redis.call('SET'"));assert.equal(count,'1');
   const current=state.get(key);
   if(current&&JSON.parse(current).revision!==expected)return 0;
   state.set(key,next);return 1;
  }
  throw new Error('Unexpected command '+op);
 };
 const command=JSON.parse(options.body);
 const result=Array.isArray(command[0])?command.map(c=>({result:execute(c)})):{result:execute(command)};
 return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
};
const {getPriceState,savePrices,getPrices}=await import('../server/src/priceStore.js');
const {rateLimit}=await import('../server/src/rateLimit.js');
test('Redis: migrate legacy prices, retain last known values on outage, reject admin writes',async()=>{
 const legacy=[{id:'test',label:'Перевірка',rows:[{service:'Робота',price:'777',time:'30 хв'}]}];
 state.set('astor:prices',JSON.stringify(legacy));
 assert.equal((await getPrices())[0].rows[0].price,'777');
 const current=await getPriceState();
 const result=await savePrices(legacy,'test',current.revision);
 assert(state.has('astor:price-state'));assert.equal((await getPriceState()).revision,result.revision);
 unavailable=true;
 assert.equal((await getPrices())[0].rows[0].price,'777');
 await assert.rejects(()=>getPriceState({strict:true}),e=>e.status===503);
 await assert.rejects(()=>savePrices(legacy,'test',result.revision),e=>e.status===503);
 unavailable=false;
});
test('Redis: compare-and-set rejects racing saves',async()=>{
 const previous=await getPriceState();
 const results=await Promise.allSettled([savePrices(previous.prices,'a',previous.revision),savePrices(previous.prices,'b',previous.revision)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
});
test('Redis outage blocks admin login rate limiter; public limiter remains bounded in memory',async()=>{
 unavailable=true;
 const req={ip:'127.0.0.9'};
 function response(){return {statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
 let next=0;const strict=response();
 await rateLimit('admin-test',60000,2,{strict:true})(req,strict,()=>next++);
 assert.equal(strict.statusCode,503);assert.equal(next,0);
 const limiter=rateLimit('public-test',60000,1);
 const first=response(),second=response();
 await limiter(req,first,()=>next++);await limiter(req,second,()=>next++);
 assert.equal(next,1);assert.equal(second.statusCode,429);
 unavailable=false;
});
