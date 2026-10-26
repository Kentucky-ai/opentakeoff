import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPixelWidth, previewViewport } from '../src/lib/sheetPreview.js';
import { normalizeLayout, readWorkspacePreferences } from '../src/lib/workspaceLayout.js';

test('sheet previews match display density and bound oversized requests', () => {
  assert.equal(previewPixelWidth(640, 1), 640);
  assert.equal(previewPixelWidth(640, 2), 1280);
  assert.equal(previewPixelWidth(640, 3), 1280);
  assert.equal(previewPixelWidth(1200, 2), 2400);
  assert.equal(previewPixelWidth(10000, 2), 2400);
  assert.equal(previewPixelWidth(NaN, NaN), 640);
});
test('portrait, landscape and extreme pages stay inside raster memory budget', () => {
  for (const [width,height] of [[1000,700],[700,1000],[100,100000]]) {
    const page={getViewport:({scale}:{scale:number})=>({width:width*scale,height:height*scale})};
    const result=previewViewport(page,2400);
    assert.ok(result.width*result.height<=6000000.01);
    assert.ok(Math.abs(result.width/result.height-width/height)<1e-9);
  }
});
test('floating readout is an independent, persisted opt-in', () => {
  assert.equal(normalizeLayout({}).readout,false);
  const prefs=readWorkspacePreferences(JSON.stringify({version:1,enabled:true,layout:{readout:true,counter:false,look:'hud',backlight:80}}));
  assert.equal(prefs.layout.readout,true);
  assert.equal(prefs.layout.counter,false);
  assert.equal(prefs.layout.look,'hud');
  assert.equal(prefs.layout.backlight,80);
  assert.equal(normalizeLayout({readout:'false',look:'unknown',backlight:200}).backlight,100);
  assert.equal(normalizeLayout({readout:'false',look:'unknown'}).look,'graphite');
  assert.equal(normalizeLayout({readout:'false'}).readout,false);
});
