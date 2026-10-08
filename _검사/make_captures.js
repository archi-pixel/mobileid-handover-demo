// 신분증 이어받기 시뮬레이터: 기획서용 화면 캡처 만들기(1600×900, 기기 배율 2, PNG 3200×1800)
// 사용법: node make_captures.js
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const HTML = path.resolve(__dirname, '..', 'index.html');
const URL0 = pathToFileURL(HTML).href + '?fast=1';
const OUT = path.resolve(__dirname, '..', '캡처');
const OUTP = path.join(OUT, '폰화면');
fs.mkdirSync(OUTP, { recursive: true });

(async () => {
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL0);
  await page.waitForFunction(() => window.__poc && __poc.ready);

  const settle = () => page.waitForTimeout(700);
  const clean = () => page.evaluate(() => document.querySelectorAll('.next').forEach(x => x.classList.remove('next'))); // 캡처엔 주황 안내 테두리 빼기
  const scenario = async n => { await page.evaluate(n => __poc.scenario(n), n); await settle(); };
  const play = async (n, upto) => { const e = await page.evaluate(([n, u]) => __poc.play([n], u ? { upto: u } : {}), [n, upto || 0]); if (e) throw new Error(e); await settle(); };
  const expandLast = async kind => { await page.evaluate(k => { const s = __poc.snapshot(); const e = s.log.filter(x => x.kind === k).pop(); if (e) __poc.expand(e.id); }, kind); await page.waitForTimeout(300); };
  const shot = async name => { await clean(); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  ' + name + '.png'); };
  const phone = async (who, name) => { await clean(); await page.locator('#' + who).screenshot({ path: path.join(OUTP, name + '.png') }); console.log('  폰화면/' + name + '.png'); };

  await scenario(1);                         await shot('00_전체화면');
  await play(1, 3);                          await shot('01-1_새폰_이어받기_QR');  await phone('nw', '새폰_이어받기_QR');
  // 근거리 확인 화면: 잠깐 지나가는 장면이라 속도를 늦춰 「가까이 있음」이 뜬 순간을 찍음
  await play(1, 5);
  await page.evaluate(() => { S.slow = 4; doAct('old', 'scan'); });
  await page.waitForFunction(() => S.old.near === 'ok'); await page.waitForTimeout(600);
  await phone('old', '옛폰_근거리확인');
  await page.waitForFunction(() => S.busy === 0, null, { timeout: 30000 }); await page.evaluate(() => { S.slow = 0.05; });
  await play(1, 6);                          await shot('01-2_옛폰_승인화면_경고문'); await phone('old', '옛폰_승인화면_경고문');
  await play(1, 7);                          await shot('01_정상이어받기');        await phone('nw', '새폰_신분증_이어받기1회차_보호중'); await phone('old', '옛폰_옮겨짐_되돌리기열쇠');
  await expandLast('transfer');              await shot('01-3_공통기반_서명값_검증결과');
  await play(1, 9);                          await shot('01-4_72시간보호_개통제한'); await phone('nw', '새폰_72시간보호_개통거절');
  await play(1);                             await shot('01-5_72시간뒤_옛폰폐기_개통가능');
  await play(2, 3);                          await shot('02_사기범폰_얼굴불일치_거절'); await phone('nw', '사기범폰_거절'); await phone('old', '옛폰_명의시도알림');
  await play(2);                             await phone('old', '피해자폰_신분증그대로');
  await play(3);                             await shot('03_옛폰분실_방문안내');    await phone('nw', '새폰_방문또는IC안내');
  await play(4, 7);                          await shot('04_30일안_재시도_거절');
  await play(5);                             await shot('05_6년상한_방문안내');
  await scenario(6);                         await shot('06-1_72시간안_옛폰알림');   await phone('old', '옛폰_내가하지않았어요_버튼');
  await play(6);                             await shot('06_내가하지않았어요_되돌림'); await phone('nw', '새폰_정지됨');
  await scenario(7);                         await shot('07-1_만료60일전_알림');     await phone('old', '내폰_갱신알림');
  await play(7);                             await shot('07_같은폰_3년갱신');
  await play(8);                             await shot('08_멀리서승인_근거리확인거절');
  await page.evaluate(() => __poc.setTamper('sig'));
  await play(1, 7); await expandLast('transfer'); await shot('09_위조시험_승인서명1바이트_거절');
  await scenario(1); await page.click('#top [data-act="help"]'); await page.waitForTimeout(400); await shot('10_도움말');
  await browser.close();
  console.log(errors.length ? '콘솔 오류: ' + errors.join(' | ') : '콘솔 오류 0건');
})().catch(e => { console.error(e); process.exit(1); });
