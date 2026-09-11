import test from 'node:test';import assert from 'node:assert/strict';import relay from '../ops/cloudflare/ocr-relay.mjs';
test('OCR relay rejects anonymous use and only forwards allowed Gemini requests',async()=>{
 const original=globalThis.fetch,env={RELAY_SECRET:'test-only-secret',GEMINI_API_KEY:'test-provider-key',ALLOWED_MODELS:'gemini-test'};let calls=0;
 try{
  globalThis.fetch=async(input:any,init:any)=>{calls++;assert.equal(String(input),'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');assert.equal(init.headers['x-goog-api-key'],env.GEMINI_API_KEY);assert.equal(init.headers.authorization,undefined);assert.equal(await new Response(init.body).text(),'{"contents":[]}');return new Response('{"candidates":[]}',{status:200});};
  const make=(auth:string,path='gemini-test')=>new Request('https://relay.invalid/v1beta/models/'+path+':generateContent',{method:'POST',headers:{authorization:auth,'content-type':'application/json','content-length':'15'},body:'{"contents":[]}'});
  assert.equal((await relay.fetch(make(''),env)).status,401);assert.equal((await relay.fetch(make('Bearer test-only-secret','other-model'),env)).status,404);assert.equal(calls,0);
  const result=await relay.fetch(make('Bearer test-only-secret'),env);assert.equal(result.status,200);assert.equal(calls,1);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-goog-api-key'),null);
 }finally{globalThis.fetch=original;}
});
