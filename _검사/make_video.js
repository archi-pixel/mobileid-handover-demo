// 시연 영상 만들기: 「자동 시연」으로 ①②⑧⑥⑦을 이어서 녹화 → 1920×1080 H.264 MP4
// 화면이 바뀔 때마다 PNG 프레임을 받아(Chrome DevTools 화면 전송 기능) ffmpeg로 이어 붙임(글자가 흐려지지 않게)
// 사용법: node make_video.js   (ffmpeg 필요)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const HTML = path.resolve(__dirname, '..', 'index.html');
const OUT = path.resolve(__dirname, '..', '시연영상.mp4');
const LIST = process.argv[2] || '12867';
const FPS = 30;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-video-'));
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(HTML).href);
  await page.waitForFunction(() => window.__poc && __poc.ready);
  await page.waitForTimeout(800);

  const cdp = await ctx.newCDPSession(page);
  const frames = []; // { file, t }
  let n = 0;
  cdp.on('Page.screencastFrame', async ev => {
    const file = path.join(tmp, `f${String(n++).padStart(5, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ file, t: ev.metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (e) { /* 끝난 뒤 */ }
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  await page.waitForTimeout(1200);
  const err = await page.evaluate(l => __poc.play(l.split('').map(Number)), LIST);
  if (err) throw new Error(err);
  await page.waitForTimeout(2500);
  const t1 = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(300);
  await browser.close();

  // 프레임마다 다음 프레임까지 걸린 시간만큼 보여 주도록 concat 목록 작성
  frames.sort((a, b) => a.t - b.t);
  if (!frames.length) throw new Error('프레임을 받지 못함');
  const start = frames[0].t, end = frames[0].t + (t1 - t0);
  let txt = '';
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    const dur = Math.max(0.001, next - frames[i].t); // 실제 시간 그대로(뒤에서 fps 필터가 30fps로 맞춤)
    txt += `file '${frames[i].file}'\nduration ${dur.toFixed(4)}\n`;
  }
  txt += `file '${frames[frames.length - 1].file}'\n`;
  const listFile = path.join(tmp, 'list.txt'); fs.writeFileSync(listFile, txt);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-tune', 'stillimage', '-movflags', '+faststart', '-an', OUT], { stdio: 'inherit' });
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', OUT]).toString().trim();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`시연영상.mp4: 길이 ${(+dur).toFixed(1)}초, 받은 프레임 ${frames.length}장, 녹화 시간 ${(t1 - t0).toFixed(1)}초`);
  console.log(errors.length ? '콘솔 오류: ' + errors.join(' | ') : '콘솔 오류 0건');
})().catch(e => { console.error(e); process.exit(1); });
