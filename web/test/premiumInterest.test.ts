import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {premiumPayload, sendPremiumInterest} from '../src/lib/premiumInterest.js';
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
