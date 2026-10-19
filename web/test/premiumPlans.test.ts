import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PREMIUM_PLANS, PREMIUM_TRIAL, planHref, shouldAutoPromptPremium, readPremiumPrompt, writePremiumPrompt, PREMIUM_PROMPT_SNOOZE_MS} from '../src/lib/premiumPlans.js';
test('plans match the published prices: Individual Pro $149, Team Pro $399, Enterprise by contact',()=>{
  assert.deepEqual(PREMIUM_PLANS.map(p=>[p.id,p.price]),[['single',149],['team',399],['enterprise',null]]);
  assert.deepEqual(PREMIUM_TRIAL,{days:7,credits:50});
});
test('trial buttons go to the sign-up page with the chosen plan; Enterprise goes to a person',()=>{
  const [single,team,enterprise]=PREMIUM_PLANS;
  assert.equal(planHref(single),'https://start.kentucky-ai.com/?plan=single#start');
  assert.equal(planHref(team),'https://start.kentucky-ai.com/?plan=team#start');
  assert.equal(planHref(enterprise),'https://kentucky-ai.com/#call');
});
test('the early-access form and its Netlify form definition are gone',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.equal(html.includes('premium-interest'),false);
});
test('unprompted dialog waits for real work, snoozes after a dismissal and never follows a trial start or old request',()=>{
  assert.equal(shouldAutoPromptPremium(null,0),false);
  assert.equal(shouldAutoPromptPremium(null,3),true);
  assert.equal(shouldAutoPromptPremium({status:'dismissed',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS-1),false);
  assert.equal(shouldAutoPromptPremium({status:'dismissed',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS),true);
  assert.equal(shouldAutoPromptPremium({status:'started',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS*9),false);
  assert.equal(shouldAutoPromptPremium({status:'requested',at:1000},3,1000+PREMIUM_PROMPT_SNOOZE_MS*9),false);
});
test('prompt record survives broken storage and a later dismissal never overwrites a trial start',()=>{
  const data=new Map(), storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
  assert.equal(readPremiumPrompt(storage),null);
  writePremiumPrompt('started',storage,5); writePremiumPrompt('dismissed',storage,9);
  assert.deepEqual(readPremiumPrompt(storage),{status:'started',at:5});
  const broken={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  assert.equal(readPremiumPrompt(broken),null); writePremiumPrompt('dismissed',broken);
});
