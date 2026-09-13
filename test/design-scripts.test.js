// The skill's scripts are what the pipeline's prompts tell a session to run and what the gate
// reads back, so they are tested here rather than trusted. Each test skips when its runtime is
// missing (python3 + Pillow + numpy for the two Python tools, a Chrome for the screenshotter),
// because CI without them should stay green — but on a machine that has them, they must work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { designScript } from '../src/stages.js';

const py = process.env.AUTODEV_PYTHON || 'python3';
const havePil = spawnSync(py, ['-c', 'import PIL, numpy'], { stdio: 'ignore' }).status === 0;
const chrome = process.env.CHROME_BIN || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome', win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[platform()];
const haveChrome = !!chrome && existsSync(chrome);

// Two pictures the size of an iPhone 15 screenshot: a cream page with a dark bar and a rust
// panel, and the same page with the panel painted camel.
function fixtures() {
  const d = mkdtempSync(join(tmpdir(), 'design-'));
  execFileSync(py, ['-c', `
from PIL import Image, ImageDraw
import sys
d = sys.argv[1]
ref = Image.new("RGB", (1179, 2556), (241, 229, 205)); dr = ImageDraw.Draw(ref)
dr.rectangle([0, 0, 1179, 140], fill=(45, 22, 11)); dr.rectangle([80, 400, 1100, 900], fill=(168, 70, 30))
ref.save(d + "/home.png")
ren = ref.copy(); ImageDraw.Draw(ren).rectangle([80, 400, 1100, 900], fill=(205, 155, 99)); ren.save(d + "/render-home.png")
ref.save(d + "/render-same.png")
`, d]);
  return d;
}

test('brief.py measures each reference once: device, viewport, palette, crops', { skip: !havePil && 'python3 with Pillow+numpy not available' }, () => {
  const d = fixtures();
  const out = execFileSync(py, [designScript('brief.py'), d], { encoding: 'utf8' });
  assert.match(out, /home\.png: 1179x2556 → iPhone .*render at 393x852 @3x/);
  const brief = JSON.parse(readFileSync(join(d, 'brief-home.json'), 'utf8'));
  assert.deepEqual(brief.viewport, { width: 393, height: 852, dpr: 3 });
  assert.equal(brief.palette[0].hex, '#F1E5CD', 'the cream is sampled, not guessed');
  assert.equal(brief.bands.top, '#2D160B');
  for (const c of ['top', 'mid', 'bottom']) assert.ok(existsSync(join(d, `brief-home-${c}.png`)));
  // renders are not references, and a second run does not redo the work
  assert.ok(!existsSync(join(d, 'brief-render-home.json')));
  assert.match(execFileSync(py, [designScript('brief.py'), d], { encoding: 'utf8' }), /already present/);
});

test('score.py: identical is 0%, a wrong panel colour is a number with the block named, masks are counted', { skip: !havePil && 'python3 with Pillow+numpy not available' }, () => {
  const d = fixtures();
  const run = (...a) => execFileSync(py, [designScript('score.py'), ...a], { encoding: 'utf8' });
  run('--ref', join(d, 'home.png'), '--render', join(d, 'render-same.png'), '--screen', 'same');
  assert.equal(JSON.parse(readFileSync(join(d, 'score-same.json'), 'utf8')).mismatchPct, 0);

  const out = run('--ref', join(d, 'home.png'), '--render', join(d, 'render-home.png'), '--screen', 'home', '--mask', '0,0.9,1,1');
  const s = JSON.parse(readFileSync(join(d, 'score-home.json'), 'utf8'));
  assert.ok(s.mismatchPct > 10 && s.mismatchPct < 30, `the panel is ~17% of the picture: got ${s.mismatchPct}`);
  assert.ok(s.maskedPct > 9 && s.maskedPct < 12, `a 10% strip was masked: got ${s.maskedPct}`);
  assert.deepEqual(s.masks, [[0, 0.9, 1, 1]]);
  assert.equal(s.worstBlocks[0].mismatchPct, 100);
  assert.match(s.worstBlocks[0].reference, /^#A[78]4[56]1[DE]$/, 'rust on the reference side');
  assert.match(s.worstBlocks[0].render, /^#C[CD]9[AB]6[23]$/, 'camel on the render side');
  assert.ok(existsSync(join(d, 'diff-home.png')), 'the heat map');
  assert.match(out, /home: \d+\.\d% mismatch/);

  // a render at another shape is flagged rather than silently stretched to fit
  execFileSync(py, ['-c', `from PIL import Image; Image.new("RGB", (800, 1200), (241, 229, 205)).save("${join(d, 'render-photo.png')}")`]);
  run('--ref', join(d, 'home.png'), '--render', join(d, 'render-photo.png'), '--screen', 'photo');
  assert.match(JSON.parse(readFileSync(join(d, 'score-photo.json'), 'utf8')).warnings[0], /aspect mismatch/);
});

test('shot.mjs renders at the exact viewport and DPR, with a sidecar saying so', { skip: !haveChrome && 'no Chrome on this machine' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'shot-'));
  writeFileSync(join(d, 'page.html'), '<!doctype html><body style="margin:0;background:#F1E5CD"><h1 style="background:#2D160B;color:#fff;margin:0;padding:20px">Kaaram</h1></body>');
  const out = join(d, 'render-page.png');
  const log = execFileSync(process.execPath, [designScript('shot.mjs'), `file://${join(d, 'page.html')}`, out, '--viewport', '393x852', '--dpr', '3', '--wait-ms', '100'],
    { encoding: 'utf8', env: { ...process.env, CHROME_BIN: chrome } });
  assert.match(log, /393x852 @3x/);
  // PNG header: width and height are big-endian at bytes 16 and 20
  const png = readFileSync(out);
  assert.equal(png.readUInt32BE(16), 1179);
  assert.equal(png.readUInt32BE(20), 2556);
  const meta = JSON.parse(readFileSync(`${out}.json`, 'utf8'));
  assert.deepEqual(meta.viewport, { width: 393, height: 852 });
  assert.equal(meta.dpr, 3);
  assert.match(meta.chrome, /Chrome|Chromium|Edg/);
});
