#!/usr/bin/env node
/**
 * Screenshot a URL at an exact CSS viewport and device pixel ratio, with web fonts loaded.
 * Zero dependencies: drives Chrome over its own DevTools protocol (Node >= 22 for WebSocket).
 *
 *   node shot.mjs <url> <out.png> [--viewport 393x852] [--dpr 3] [--wait-ms 600]
 *                 [--full-page] [--cookie name=value] [--header "Name: value"] [--chrome <path>]
 *                 [--scroll-y <px>] [--ua <string>] [--no-mobile]
 *
 * Why not `chrome --headless --screenshot --window-size=W,H`: on macOS that does not set the
 * viewport — the page lays out wider (a minimum window width applies), is cropped to W, and
 * you get a picture of a layout the app never has. Emulation.setDeviceMetricsOverride is the
 * viewport, exactly, plus the DPR the reference was taken at, so the two pictures are the same
 * shape and the score is about the design rather than about the harness.
 *
 * Writes <out.png> and a sidecar <out>.json recording url, viewport, dpr, fonts loaded, and
 * the Chrome version — the evidence that the render was taken in the app, at the right size.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const flags = (name) => args.flatMap((a, i) => a === name && args[i + 1] !== undefined ? [args[i + 1]] : []);
const has = (name) => args.includes(name);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--full-page', '--no-mobile'].includes(args[i - 1])));
const [url, out] = positional;
if (!url || !out) { console.error('usage: node shot.mjs <url> <out.png> [--viewport WxH] [--dpr N] ...'); process.exit(2); }

const [vw, vh] = flag('--viewport', '393x852').toLowerCase().split('x').map(Number);
const dpr = Number(flag('--dpr', '3'));
const waitMs = Number(flag('--wait-ms', '600'));
const scrollY = Number(flag('--scroll-y', '0'));
const mobile = !has('--no-mobile');
const ua = flag('--ua', mobile
  ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  : null);

const CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
           '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
};
const chrome = flag('--chrome', process.env.CHROME_BIN) || (CANDIDATES[platform()] ?? []).find(existsSync);
if (!chrome) { console.error('shot.mjs: no Chrome found — pass --chrome <path> or set CHROME_BIN'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${vw},${vh}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => { try { proc.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
const die = (msg) => { console.error(`shot.mjs: ${msg}`); cleanup(); process.exit(1); };
process.on('SIGINT', () => die('interrupted'));

const wsBase = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('Chrome did not announce its DevTools port within 20s')), 20_000);
  proc.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  proc.on('exit', (c) => reject(new Error(`Chrome exited early (${c}): ${buf.slice(-300)}`)));
}).catch(e => die(e.message));

const httpBase = wsBase.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
const targets = await fetch(`${httpBase}/json/list`).then(r => r.json()).catch(e => die(`DevTools list failed: ${e.message}`));
const page = targets.find(t => t.type === 'page') ?? die('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(die('DevTools socket failed')); });

let seq = 0; const pending = new Map(); const events = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method && events.has(msg.method)) { events.get(msg.method)(msg.params); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method, timeoutMs) => new Promise((res) => { const t = setTimeout(() => { events.delete(method); res(null); }, timeoutMs); events.set(method, (p) => { clearTimeout(t); events.delete(method); res(p); }); });

try {
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: dpr, mobile, screenWidth: vw, screenHeight: vh });
  if (ua) await send('Emulation.setUserAgentOverride', { userAgent: ua });
  const headers = Object.fromEntries(flags('--header').map(h => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));
  if (Object.keys(headers).length) await send('Network.setExtraHTTPHeaders', { headers });
  for (const c of flags('--cookie')) {
    const i = c.indexOf('='); const name = c.slice(0, i), value = c.slice(i + 1);
    const ok = await send('Network.setCookie', { name, value, url });
    if (!ok?.success) die(`cookie ${name} was not accepted for ${url}`);
  }
  const loaded = once('Page.loadEventFired', 30_000);
  const nav = await send('Page.navigate', { url });
  if (nav.errorText) die(`navigation failed: ${nav.errorText}`);
  if (!(await loaded)) console.error('shot.mjs: load event not seen within 30s — shooting anyway');
  // Fonts: the single most common false difference is the fallback face. Wait for every
  // declared face, then a little longer for layout to settle after the swap.
  const fonts = await send('Runtime.evaluate', {
    expression: `document.fonts.ready.then(() => ({ n: document.fonts.size, loaded: [...document.fonts].filter(f => f.status === 'loaded').length, failed: [...document.fonts].filter(f => f.status === 'error').map(f => f.family) }))`,
    awaitPromise: true, returnByValue: true,
  }).then(r => r.result.value).catch(() => ({ n: 0, loaded: 0, failed: [] }));
  if (scrollY) await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scrollY})` });
  await new Promise(r => setTimeout(r, waitMs));
  let clip;
  if (has('--full-page')) {
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  const version = await send('Browser.getVersion').catch(() => ({}));
  const meta = { url, out, viewport: { width: vw, height: vh }, dpr, mobile, scrollY, fullPage: !!clip,
    fonts, chrome: version.product ?? chrome, capturedAt: new Date().toISOString(), tool: 'autodev-pixel-match/shot.mjs' };
  writeFileSync(`${out}.json`, JSON.stringify(meta, null, 2));
  console.log(`${out}  ${vw}x${vh} @${dpr}x  fonts ${fonts.loaded}/${fonts.n}${fonts.failed?.length ? `  FAILED: ${fonts.failed.join(', ')}` : ''}`);
} catch (e) {
  die(e.message);
} finally {
  ws.close();
  cleanup();
}
