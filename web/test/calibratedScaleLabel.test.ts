import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibratedScaleLabel } from '../src/lib/calibratedScaleLabel.js';
test('calibrated ratios use baseline PDF paper dimensions, not screen zoom',()=>{
 for(const render of [1,2,3]) {
  assert.equal(calibratedScaleLabel(78/(12*72*render),render,'metric'),'1:78');
  assert.equal(calibratedScaleLabel(78/(12*72*render),render,'imperial'), `1" = 6.5'`);
  assert.equal(calibratedScaleLabel(96/(12*72*render),render,'metric'),'1:96');
 }
 assert.equal(calibratedScaleLabel(78.1234/(12*72*2),2),'1:78.12');
});
test('invalid calibration is not presented as a valid ratio',()=>{
 for(const n of [0,-1,NaN,Infinity]) assert.equal(calibratedScaleLabel(n,2),'');
 assert.equal(calibratedScaleLabel(1,0),'');
});
