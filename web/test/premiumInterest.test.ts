import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {premiumPayload, sendPremiumInterest, shouldAutoPromptPremium, readPremiumPrompt, writePremiumPrompt, PREMIUM_PROMPT_SNOOZE_MS} from '../src/lib/premiumInterest.js';
const fields={email:' QA@EXAMPLE.COM ',name:' Demo ',company:'Example',role:'Estimator',trade:'Flooring / finishes',interest:'Native iPad / tablet takeoff'};
test('interest payload contains only submitted contact fields and explicit consent',()=>{
  const body=premiumPayload({...fields,project:'private',shapes:['private'],token:'secret',updates:'on'},'test-id');
  assert.equal(body.get('email'),'qa@example.com');
  assert.equal(body.get('name'),'Demo');
  assert.equal(body.get('updates'),'no');
  for(const key of ['project','shapes','token']) assert.equal(body.has(key),false);
  assert.equal(premiumPayload({...fields,updates:'yes'},'test-id').get('updates'),'yes');
});
test('interest input validation rejects incomplete or unsupported requests',()=>{
  for(const patch of [{email:'bad'}, {role:''}, {trade:'unsupported'}, {interest:''}]) assert.throws(()=>premiumPayload({...fields,...patch},'test-id'));
});
test('static detection includes every posted field',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  for(const key of premiumPayload(fields,'test-id').keys()) {
    if(key!=='form-name') assert.ok(html.includes(`name="${key}"`),key);
  }
  assert.ok(html.includes('name="premium-interest" method="POST" data-netlify="true"'));
});
test('submission rejects service errors and an accidental SPA fallback instead of claiming success',async()=>{
  const body=premiumPayload(fields,'test-id');
  await assert.rejects(sendPremiumInterest(body,async()=>new Response('failed',{status:503})));
  await assert.rejects(sendPremiumInterest(body,async()=>new Response('<div id="root"></div>')));
  await assert.rejects(sendPremiumInterest(body,async()=>{throw new Error('offline');}));
});
test('submission uses encoded same-origin POST and waits for acknowledgment',async()=>{
  const body=premiumPayload(fields,'test-id');
  await sendPremiumInterest(body,async(url,options)=>{
    assert.equal(url,'/'); assert.equal(options?.method,'POST');
    assert.equal(new Headers(options?.headers).get('Content-Type'),'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(String(options?.body)).get('email'),'qa@example.com');
    return new Response('<h1>Thank you!</h1>');
  });
});
test('unprompted dialog waits for real work, snoozes after a dismissal and never follows a request',()=>{
  assert.equal(shouldAutoPromptPremium(null,0),false);
  assert.equal(shouldAutoPromptPremium(null,3),true);
  assert.equal(shouldAutoPromptPremium({status:'dismissed',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS-1),false);
  assert.equal(shouldAutoPromptPremium({status:'dismissed',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS),true);
  assert.equal(shouldAutoPromptPremium({status:'requested',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS*9),false);
});
test('prompt record survives broken storage and a later dismissal never overwrites a request',()=>{
  const data=new Map(), storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
  assert.equal(readPremiumPrompt(storage),null);
  writePremiumPrompt('requested',storage,5); writePremiumPrompt('dismissed',storage,9);
  assert.deepEqual(readPremiumPrompt(storage),{status:'requested',at:5});
  const broken={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  assert.equal(readPremiumPrompt(broken),null); writePremiumPrompt('dismissed',broken);
});
