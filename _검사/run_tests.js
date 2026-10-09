// 신분증 이어받기 시뮬레이터 자동 검사: Playwright + Chromium
// 사용법: node run_tests.js   (결과는 같은 폴더 결과.txt 에 저장)
'use strict';
const norm = t => t == null ? t : t.replace(/\u00a0/g, ' ').replace(/\u2060/g, ''); // 줄바꿈 방지용 붙임 문자는 비교 전에 보통 글자로
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/npm-tools/node_modules/playwright'); }
const V = require('./verify_export.js');

const HERE = __dirname;
const HTML = path.resolve(HERE, '..', 'index.html');
const README = path.resolve(HERE, '..', 'README.txt');
const FILE_URL = pathToFileURL(HTML).href;
const OUT = path.join(HERE, '결과.txt');
const NAMES = ['① 정상 이어받기', '② 다른 사람이 내 명의로 시도 → 얼굴 불일치로 거절', '③ 옛 폰 분실 → 방문·IC 안내', '④ 30일 안에 또 이어받기 → 거절',
  '⑤ 대면 확인 6년 상한', '⑥ 72시간 안 「내가 하지 않았어요」', '⑦ 만료 60일 전 → 3년 갱신', '⑧ 멀리서 승인 시도 → 근거리 확인에서 거절(얼굴은 통과했다고 가정한 경우)'];
const G5 = ['옛 신분증 확인', '옛 폰 승인 확인', '본인 확인', '근거리 확인', '이용 규칙'];
const CIRC = '①②③④⑤⑥⑦⑧';

const lines = [];
const log = s => { lines.push(s); console.log(s); };
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; log(`  [통과] ${name}${extra ? ' (' + extra + ')' : ''}`); }
  else { fail++; failures.push(name); log(`  [실패] ${name}${extra ? ' (' + extra + ')' : ''}`); }
}
const consoleErrors = [];
function watch(page, tag) {
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
}
const byKind = (s, k) => s.log.filter(e => e.kind === k);
const failedOf = e => { const c = e.checks.find(c => c[1] === false); return c ? c[0] : null; };
const allPassed = e => e.checks.length > 0 && e.checks.every(c => c[1] === true);
const KST = 9 * 3600e3;
const plus6y = isoStr => { const d = new Date(Date.parse(isoStr) + KST); d.setUTCFullYear(d.getUTCFullYear() + 6); return d.getTime() - KST; };
const capOk = s => s.allCreds.every(c => Date.parse(c.expiresAt) <= plus6y(c.lastInPersonAt));
const groupsOk = e => e.checks.length === 11 && [3, 2, 2, 1, 3].every((n, g) => e.checks.filter(c => c[3] === g).length === n);
let maxActiveAll = 0;

async function open(ctx, url, tag) {
  const page = await ctx.newPage(); watch(page, tag);
  await page.goto(url);
  await page.waitForFunction(() => window.__poc && window.__poc.ready, null, { timeout: 15000 });
  return page;
}
const play = (page, list, opt) => page.evaluate(([l, o]) => __poc.play(l, o), [list, opt || {}]);
const snap = page => page.evaluate(() => __poc.snapshot());
const idle = page => page.waitForFunction(() => S.busy === 0);

function serve(handler, opts) {
  return new Promise(res => { const srv = opts ? https.createServer(opts, handler) : http.createServer(handler); srv.listen(0, '127.0.0.1', () => res(srv)); });
}
const sendHtml = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(HTML)); };

(async () => {
  const t0 = Date.now();
  const browser = await pw.chromium.launch();
  log('신분증 이어받기 시뮬레이터: 자동 검사 결과');
  log(`검사 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`);
  log(`브라우저: Chromium ${browser.version()} (Playwright, 화면 없이 실행)`);
  log(`검사 파일: index.html (${fs.statSync(HTML).size.toLocaleString()} 바이트)`);
  log('');

  /* 1. 여는 방식 */
  log('■ 1. 여는 방식별 WebCrypto 동작 (file:// · localhost · https)');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
  const targets = [['file:// (더블클릭으로 연 경우)', FILE_URL, null]];
  const httpSrv = await serve(sendHtml);
  targets.push(['http://localhost', `http://localhost:${httpSrv.address().port}/index.html`, null]);
  let httpsSrv = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    httpsSrv = await serve(sendHtml, { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) });
    targets.push(['https://localhost (자체 서명 인증서)', `https://localhost:${httpsSrv.address().port}/index.html`, 'https']);
  } catch (e) { log('  (openssl이 없어 https 검사는 건너뜀)'); }
  for (const [name, url, kind] of targets) {
    const c = kind === 'https' ? await browser.newContext({ ignoreHTTPSErrors: true }) : ctx;
    const page = await open(c, url + '?fast=1', name);
    const env = await page.evaluate(() => ({ secure: isSecureContext, subtle: !!(window.crypto && crypto.subtle) }));
    const err = await play(page, [1], { upto: 7 });
    const tr = byKind(await snap(page), 'transfer')[0];
    ok(`${name}: 보안 컨텍스트·WebCrypto 사용 가능`, env.secure && env.subtle, `isSecureContext=${env.secure}`);
    ok(`${name}: 실제 서명·검증으로 이어받기 성공`, !err && tr && tr.ok === true);
    await page.close(); if (c !== ctx) await c.close();
  }
  httpSrv.close(); if (httpsSrv) httpsSrv.close();
  {
    const page = await open(ctx, FILE_URL + '?fast=1', '비밀키');
    const r = await page.evaluate(async () => {
      const k = await makeKeys(); let blocked = false;
      try { await crypto.subtle.exportKey('pkcs8', k.priv); } catch (e) { blocked = true; }
      return { blocked, extractable: k.priv.extractable, alg: k.priv.algorithm.name + ' ' + k.priv.algorithm.namedCurve };
    });
    ok('폰 비밀키는 밖으로 꺼낼 수 없음(extractable=false, 내보내기 시도 막힘)', r.blocked && r.extractable === false, r.alg);
    await page.close();
  }
  log('');

  /* 2. 시나리오 8개 */
  log('■ 2. 시나리오 8개 (자동 시연을 빠르게 돌려 결과 확인)');
  const page = await open(ctx, FILE_URL + '?fast=1', '시나리오');
  const expect = {
    1: s => { const pre = byKind(s, 'prepare'), tr = byKind(s, 'transfer'), pr = byKind(s, 'present'), ex = byKind(s, 'expire');
      ok('① 얼굴 먼저: 새 폰 얼굴을 공통기반이 바로 대조해 통과한 뒤에 QR 발급', pre.length === 1 && pre[0].ok === true && pre[0].checks[0][0] === '얼굴 일치(공통기반 대조)' && pre[0].id < tr[0].id);
      ok('① 이어받기 요청: 다섯 가지 확인(세부 검사 11개) 모두 통과', tr.length === 1 && tr[0].ok === true && allPassed(tr[0]) && groupsOk(tr[0]));
      ok('① 새 신분증이 새 폰 열쇠에 묶임, 이어받기 1회차, 만료일 2029. 10. 8.(받은 날+3년)', s.nw.cred && s.nw.cred.holderKeyFp === s.nw.cred.keyFp && s.nw.cred.transferCount === 1 && s.nw.cred.expiresAt.startsWith('2029-10-08'));
      ok('① 72시간 안 휴대폰 개통 → 거절(72시간 보호), 일반 신원확인 → 통과', pr[0] && pr[0].ok === false && failedOf(pr[0]) === '72시간 보호' && pr[1] && pr[1].ok === true);
      ok('① 되돌리기 열쇠는 정확히 72시간 되는 시각(10. 11. 10:02)에 만료, 옛 폰엔 아무것도 안 남음', ex.length === 1 && ex[0].at.startsWith('2026-10-11T10:02') && s.old.screen === 'deleted' && !s.old.cred && !s.old.undoKey);
      ok('① 72시간 뒤 휴대폰 개통 → 통과', pr[2] && pr[2].ok === true); },
    2: s => { const pre = byKind(s, 'prepare')[0];
      ok('② 다른 사람 얼굴 → 새 폰 얼굴 단계에서 공통기반이 바로 거절', pre && pre.ok === false && failedOf(pre) === '얼굴 일치(공통기반 대조)');
      ok('② QR이 뜨지 않음(1회용 번호 발급 0건, 이어받기 요청 0건)', s.transferNonces === 0 && byKind(s, 'transfer').length === 0 && s.nw.screen === 'fail' && !s.nw.cred);
      ok('② 옛 폰(명의자)에 알림 → 신고 접수, 옛 폰 신분증은 그대로', pre.result.includes('명의자 폰에 알림') && byKind(s, 'report').length === 1 && s.old.cred.status === 'active' && !s.old.alert); },
    3: async s => { const txt = norm(await page.textContent('#nw'));
      ok('③ 옛 폰 분실: 옛 폰 칸 비활성, 분실 신고로 정지', s.old.lost && s.old.cred.status === 'suspended');
      ok('③ 새 폰에 「주민센터 방문 / IC 주민등록증」 안내, 이어받기 요청 없음', s.nw.screen === 'nophone' && txt.includes('주민센터 방문') && txt.includes('IC 주민등록증') && byKind(s, 'transfer').length === 0); },
    4: s => { const tr = byKind(s, 'transfer');
      ok('④ 10일 전에 이어받은 신분증으로 또 시도 → 「30일 제한」에서 거절', tr[0] && tr[0].ok === false && failedOf(tr[0]) === '30일 제한');
      ok('④ +30일 뒤 다시 하면 통과(이어받기 2회차)', tr[1] && tr[1].ok === true && s.nw.cred && s.nw.cred.transferCount === 2); },
    5: async s => { const tr = byKind(s, 'transfer')[0], rn = byKind(s, 'renew')[0], nt = byKind(s, 'notice');
      ok('⑤ 대면 확인 6년 안이라 이어받기는 통과, 새 만료일은 대면 확인+6년(2031. 4. 14.)으로 맞춤',
        tr && tr.ok === true && norm(tr.result).includes('대면확인+6년으로 맞춤') && s.nw.cred && s.nw.cred.expiresAt.startsWith('2031-04-14') && Date.parse(s.nw.cred.expiresAt) === plus6y(s.allCreds.find(c => c.id === s.nw.cred.id).lastInPersonAt));
      ok('⑤ 만료 60일 전 알림은 정확히 60일 전(2031. 2. 13. 14:20)에 한 번만', nt.length === 1 && nt[0].at.startsWith('2031-02-13T14:20') && nt[0].result.includes('60일 남음'));
      ok('⑤ 갱신 시도 → 「6년 상한」에서 거절, IC 주민등록증 전환 안내', rn && rn.ok === false && failedOf(rn) === '6년 상한' && s.nw.screen === 'rejected' && s.nw.reject.six && (norm(await page.textContent('#nw'))).includes('IC 주민등록증으로 바꾸기'));
      ok('⑤ 기록 시각이 앞뒤로 엇갈리지 않음', s.log.every((e, i) => i === 0 || Date.parse(s.log[i - 1].at) <= Date.parse(e.at)));
      await page.click('#nw [data-act="ok"]'); await page.waitForTimeout(100);
      const t1 = norm(await page.textContent('#nw'));
      ok('⑤ 새 폰 신분증에 「대면 확인 6년 상한」 표시, 알림은 「갱신 대신 방문」으로 바뀜', t1.includes('대면 확인 6년 상한') && t1.includes('2031. 4. 14.까지') && t1.includes('갱신 대신 방문'));
      await page.click('#top [data-act="t30"]'); await idle(page);
      await page.click('#top [data-act="t30"]'); await idle(page);
      const t2 = norm(await page.textContent('#nw')); const s2 = await snap(page);
      const ex = s2.log.find(e => e.title === '유효기간 만료');
      ok('⑤ 6년이 지나면 만료: 「대면 확인 후 6년이 지났어요」와 방문 안내, 제출·이어주기 버튼 없음',
        t2.includes('대면 확인 후 6년이 지났어요') && t2.includes('IC 주민등록증으로 바꾸기') && !(await page.isVisible('#nw [data-act="present-open"]')) && ex && ex.at.startsWith('2031-04-14T14:20'));
      const r = await page.evaluate(async () => { const d = S.nw; const nonce = rand(16); H.nonces.set(nonce, { kind: 'present', createdAt: S.now, used: false });
        const req = { type: '제출', purpose: '일반 신원확인', credId: d.cred.payload.id, nonce, at: iso(S.now) };
        const x = await hubPresent({ cred: d.cred, spki: d.keys.spki, req, sig: await signObj(d.keys.priv, req) }); render(); return x.failed && x.failed.n; });
      ok('⑤ 6년 지나 만료된 신분증으로 제출 → 「유효기간」에서 거절', r === '유효기간'); },
    6: s => { const u = byKind(s, 'undo')[0], pr = byKind(s, 'present');
      ok('⑥ 72시간 안 「내가 하지 않았어요」 → 공통기반 검사 5개 통과', u && u.ok === true && allPassed(u) && u.checks.length === 5);
      ok('⑥ 새 폰 신분증 폐기, 옛 폰 열쇠에 새로 발급(원래 만료일 2028. 4. 14. 유지)',
        s.nw.cred && s.nw.cred.status === 'revoked' && s.old.cred && s.old.cred.status === 'active' && s.old.cred.holderKeyFp === s.old.cred.keyFp && s.old.cred.expiresAt.startsWith('2028-04-14') && !s.old.undoKey && s.undoKeys[0].used);
      ok('⑥ 폐기된 새 폰으로 제출 → 거절, 다시 받은 옛 폰으로 제출 → 통과', pr[0] && pr[0].ok === false && failedOf(pr[0]) === '정지·폐기 아님' && pr[1] && pr[1].ok === true); },
    7: s => { const n = byKind(s, 'notice'), r = byKind(s, 'renew')[0];
      ok('⑦ 만료 60일 전 알림이 정확히 60일 전(2028. 2. 14. 14:20)에 한 번만', n.length === 1 && n[0].at.startsWith('2028-02-14T14:20') && n[0].result.includes('60일 남음'));
      ok('⑦ 같은 폰에서 갱신(검사 모두 통과)', r && r.ok === true && allPassed(r));
      ok('⑦ 새 만료일 2031. 2. 14. = 받은 날+3년(대면 확인+6년 2031. 4. 14.보다 이름), 알림 사라짐',
        s.old.cred && s.old.cred.expiresAt.startsWith('2031-02-14') && Date.parse(s.old.cred.expiresAt) < plus6y(s.allCreds.find(c => c.id === s.old.cred.id).lastInPersonAt) && s.old.notice === null); },
    8: s => { const pre = byKind(s, 'prepare')[0], tr = byKind(s, 'transfer')[0];
      const i = tr ? tr.checks.findIndex(c => c[0] === '두 폰 가까이(블루투스)') : -1;
      ok('⑧ 얼굴은 통과했다고 가정(공통기반 기록에 「가정」 표시)', pre && pre.ok === true);
      ok('⑧ 멀리서 찍은 QR로 승인 → 「④ 근거리 확인 · 두 폰 가까이(블루투스)」에서 거절', tr && tr.ok === false && failedOf(tr) === '두 폰 가까이(블루투스)' && tr.checks[i][3] === 3);
      ok('⑧ 그 앞의 옛 신분증·승인 서명·얼굴·명의 확인은 모두 통과(근거리만으로 막힘)', tr && i > 0 && tr.checks.slice(0, i).every(c => c[1] === true));
      ok('⑧ 피해자 옛 폰 신분증은 그대로, 사기범 폰엔 발급 안 됨', s.old.cred && s.old.cred.status === 'active' && !s.nw.cred && s.nw.screen === 'fail'); },
  };
  const summary = [];
  for (let n = 1; n <= 8; n++) {
    const before = fail;
    const err = await play(page, [n]);
    ok(`${CIRC[n - 1]} 자동 시연 끝까지 진행`, !err, err || '');
    await expect[n](await snap(page));
    const s2 = await snap(page);
    maxActiveAll = Math.max(maxActiveAll, s2.maxActive);
    const notices = byKind(s2, 'notice').filter(e => e.title === '만료 60일 전 알림');
    ok(`${CIRC[n - 1]} 쓸 수 있는 신분증 1개 이하 · 만료일 ≤ 대면 확인+6년 · 60일 전 알림 중복 없음`, s2.maxActive <= 1 && capOk(s2) && new Set(notices.map(e => e.result)).size === notices.length, `최대 ${s2.maxActive}개`);
    summary.push(`${CIRC[n - 1]} ${fail === before ? '맞음' : '틀림'}`);
  }
  // 중간 장면 확인
  await play(page, [2], { upto: 3 });
  const t2 = norm(await page.textContent('#old'));
  ok('② 옛 폰 알림 문구 「내 명의로 이어받기 시도가 있었어요」 + 신고 버튼', t2.includes('내 명의로 이어받기 시도가 있었어요') && t2.includes('내가 한 게 아니면 신고') && await page.isVisible('#old [data-act="report"]'));
  await play(page, [8], { upto: 6 });
  const t8 = norm(await page.textContent('#old'));
  ok('⑧ 옛 폰 승인 화면에 「가까이 없음」과 사기 경고, 얼굴은 「일치 확인됨(공통기반 대조)」', t8.includes('가까이 없음') && t8.includes('QR 화면을 보내 찍으라고 했다면 사기') && t8.includes('일치 확인됨(공통기반 대조)'));
  log('');

  /* 3. 직접 누르기 */
  log('■ 3. 버튼을 직접 눌러 ① 진행 (주황 테두리 안내, PIN은 숫자판으로)');
  {
    const p = await open(ctx, FILE_URL + '?fast=1&s=1', '직접 클릭');
    const g0 = await p.evaluate(() => __poc.guide());
    ok('처음엔 새 폰 「옛 폰에서 이어받기」에 주황 테두리', g0.highlighted === 'nw:start-transfer');
    await p.click('#old [data-act="give-start"]'); await idle(p);
    const strip = norm(await p.textContent('#strip')); const s0 = await snap(p);
    ok('옛 폰부터 누르면 「새 폰에서 먼저 시작해요」 안내, 옛 폰은 넘어가지 않음', strip.includes('새 폰에서 먼저 시작해요') && s0.old.screen === 'home');
    const click = async (who, act) => { await p.click(`#${who} [data-act="${act}"]`); await idle(p); };
    await click('nw', 'start-transfer');
    const g1 = await p.evaluate(() => __poc.guide());
    ok('누를 때마다 주황 테두리가 다음 버튼으로 옮겨 감', g1.highlighted === 'nw:owner-self');
    await click('nw', 'owner-self'); await click('nw', 'face-self');
    const g2 = await p.evaluate(() => __poc.guide());
    ok('새 폰 QR이 뜨면 옛 폰 「새 폰으로 이어주기」에 주황 테두리', g2.highlighted === 'old:give-start');
    await click('old', 'give-start');
    for (let i = 0; i < 6; i++) await p.click('#old .keypad button[data-act="pin-digit"] >> nth=' + i);
    await p.waitForFunction(() => S.busy === 0 && S.old.screen === 'scan');
    await click('old', 'scan');
    const ap = norm(await p.textContent('#old'));
    ok('승인 화면: 명의 확인됨 · 얼굴 「일치 확인됨(공통기반 대조)」 · 두 폰 「가까이 있음(블루투스)」 · 경고문 (「얼굴 인증 완료」 문구 없음)',
      ap.includes('확인됨') && ap.includes('일치 확인됨(공통기반 대조)') && ap.includes('가까이 있음(블루투스)') && ap.includes('누가 전화로 시켜서 하는 거라면 지금 멈추세요') && !ap.includes('얼굴 인증'));
    await click('old', 'approve');
    const s = await snap(p); const tr = byKind(s, 'transfer')[0];
    ok('직접 클릭으로 이어받기 성공', tr && tr.ok === true && s.nw.screen === 'home' && s.nw.cred.transferCount === 1);
    const nwText = norm(await p.textContent('#nw'));
    ok('새 폰 신분증 화면: 이름·가린 주민번호·유효기간·「이어받기 1회차」·보호 중', nwText.includes('김민수') && nwText.includes('580314-1●●●●●●') && nwText.includes('유효기간') && nwText.includes('이어받기 1회차') && nwText.includes('보호 중'));
    await p.click('#log [data-ent]:has-text("이어받기 요청")');
    const det = norm(await p.textContent('#log .det')); const g5 = norm(await p.textContent('#log .g5'));
    ok('기록 줄: 「다섯 가지 확인(세부 검사 11개)」로 묶여 보이고, 누르면 서명값(16진수)과 verify 결과가 펼쳐짐',
      g5.includes('다섯 가지 확인') && g5.includes('세부 검사 11개') && G5.every(n => g5.includes(n)) && /[0-9a-f]{24}…/.test(det) && det.includes('verify = true') && det.includes('공통기반 서명'));
    await p.close();
  }
  log('');

  /* 3-2. 한 대 규칙, 되돌리기 */
  log('■ 3-2. 신분증으로 쓸 수 있는 폰은 언제나 한 대 · 되돌리기 열쇠 · 분실 신고 창구');
  {
    const p = await open(ctx, FILE_URL + '?fast=1&s=1', '한 대');
    await play(p, [1], { upto: 7 });
    const s = await snap(p);
    const oldId = s.allCreds.find(c => c.issuedAt.startsWith('2025-04-14')).id;
    ok('이어받는 즉시 옛 폰 신분증은 폐기 목록, 쓸 수 있는 신분증은 새 폰 것 1개', s.allCreds.find(c => c.id === oldId).status === 'revoked' && s.activeNow === 1);
    const oldText = norm(await p.textContent('#old'));
    ok('옛 폰 화면: 「이 폰의 신분증은 새 폰으로 옮겨졌어요 · 72시간 안에 되돌릴 수 있어요」 + 「내가 하지 않았어요」만',
      !s.old.cred && oldText.includes('새 폰으로 옮겨졌어요') && oldText.includes('72시간 안에 되돌릴 수 있어요') && await p.isVisible('#old [data-act="undo-open"]') && !(await p.isVisible('#old [data-act="present-open"]')));
    const uk = await p.evaluate(async () => { const u = S.old.undoKey; return { bound: u.payload.holderKeyFp === S.old.keys.fp,
      hub: await verifyObj(H.hub.spki, u.payload, u.sig), issuer: await verifyObj(H.issuer.spki, u.payload, u.sig),
      hours: (Date.parse(u.payload.expiresAt) - Date.parse(u.payload.issuedAt)) / 36e5, oneTime: u.payload.oneTime }; });
    ok('되돌리기 열쇠: 공통기반 서명(발급기관 열쇠로는 검증 안 됨), 옛 폰 열쇠에 묶임, 72시간·1회용', uk.hub && !uk.issuer && uk.bound && uk.hours === 72 && uk.oneTime === true);
    const r = await p.evaluate(async () => {
      const e = H.log.filter(x => x.kind === 'transfer').pop(); const oldCred = e.data.cred; const d = S.old;
      const send = async (cred) => { const nonce = rand(16); H.nonces.set(nonce, { kind: 'present', createdAt: S.now, used: false });
        const req = { type: '제출', purpose: '일반 신원확인', credId: cred.payload.id, nonce, at: iso(S.now) };
        const x = await hubPresent({ cred, spki: d.keys.spki, req, sig: await signObj(d.keys.priv, req) }); return x.failed && x.failed.n; };
      const a = await send(oldCred); const b = await send(d.undoKey);
      // 72시간 안 새 폰 신분증으로 다시 이어받기(=재발급) 시도
      const n = S.nw, third = await makeKeys(), nonce = rand(16), ble = rand(8);
      H.nonces.set(nonce, { kind: 'transfer', createdAt: S.now, used: false, newSpki: third.spki, newFp: third.fp, owner: { name: P.name, birth: P.birth }, face: P.photo, faceOk: true, ble });
      const approval = { type: '이어받기 승인', credId: n.cred.payload.id, newKeyFp: third.fp, nonce, nearToken: ble, requestedAt: iso(S.now), approvedAt: iso(S.now) };
      const t = await hubTransfer({ cred: n.cred, oldSpki: n.keys.spki, approval, approvalSig: await signObj(n.keys.priv, approval) });
      render(); return { a, b, t: t.failed && t.failed.n };
    });
    ok('72시간 안 옛 폰이 예전 신분증으로 제출 → 「정지·폐기 아님」에서 거절', r.a === '정지·폐기 아님');
    ok('되돌리기 열쇠를 신분증처럼 내밀기 → 「신분증 서명」에서 거절', r.b === '신분증 서명');
    ok('72시간 안 새 폰 신분증으로 다시 이어받기(신분증 재발급) → 「72시간 보호」에서 거절', r.t === '72시간 보호');
    await p.close();

    const q = await open(ctx, FILE_URL + '?fast=1&s=6', '되돌리기');
    await play(q, [6], { upto: 2 });
    const sq = await snap(q);
    const r2 = await q.evaluate(async () => {
      const e = H.log.filter(x => x.kind === 'undo').pop(); const key = e.data.undoKey; const d = S.old;
      const nonce = rand(16); H.nonces.set(nonce, { kind: 'undo', createdAt: S.now, used: false });
      const rq = { type: '되돌리기 요청', undoKeyId: key.payload.id, nonce, at: iso(S.now) };
      const x = await hubUndo({ undoKey: key, spki: d.keys.spki, req: rq, sig: await signObj(d.keys.priv, rq) }); render(); return x.failed && x.failed.n;
    });
    ok('되돌리기 뒤에도 쓸 수 있는 신분증은 1개(옛 폰)', sq.activeNow === 1 && sq.old.cred && sq.old.cred.status === 'active');
    ok('같은 되돌리기 열쇠를 한 번 더 쓰기 → 「한 번만」에서 거절', r2 === '한 번만');
    await q.close();

    const w = await open(ctx, FILE_URL + '?fast=1&s=6', '72시간 뒤');
    const r3 = await w.evaluate(async () => {
      const key = S.old.undoKey; const d = S.old; const attacker = await makeKeys();
      const req = async (signer) => { const nonce = rand(16); H.nonces.set(nonce, { kind: 'undo', createdAt: S.now, used: false });
        const rq = { type: '되돌리기 요청', undoKeyId: key.payload.id, nonce, at: iso(S.now) };
        const x = await hubUndo({ undoKey: key, spki: signer.spki, req: rq, sig: await signObj(signer.priv, rq) }); return x.failed && x.failed.n; };
      const other = await req(attacker);
      advance(72 * 3600e3, '+72시간');
      const late = await req(d.keys);
      render(); return { other, late, screen: S.old.screen, hasKey: !!S.old.undoKey };
    });
    ok('다른 폰 열쇠로 되돌리기 요청 → 「요청 서명」에서 거절', r3.other === '요청 서명');
    ok('72시간 지나면 되돌리기 열쇠 만료: 옛 폰 화면에서 사라지고, 예전 열쇠로 요청해도 「72시간 안」에서 거절', r3.late === '72시간 안' && r3.screen === 'deleted' && !r3.hasKey);
    await w.close();

    const c = await open(ctx, FILE_URL + '?fast=1&s=6', '분실 신고 창구');
    ok('「분실 신고 창구에서 되돌리기」는 72시간 안 이어받기가 있을 때만 누를 수 있음', await c.isEnabled('#counterBtn'));
    await c.click('#counterBtn'); await c.click('#counter [data-act="counter-no"]'); await idle(c);
    let sc = await snap(c); const no = byKind(sc, 'counter')[0];
    ok('창구 본인 확인 실패 → 거절', no && no.ok === false && failedOf(no) === '창구 본인 확인' && sc.nw.cred.status === 'active');
    await c.click('#counter [data-act="counter-ok"]'); await idle(c);
    await c.click('#counter [data-act="counter-close"]');
    sc = await snap(c); const yes = byKind(sc, 'counter')[1];
    const ot = norm(await c.textContent('#old'));
    ok('옛 폰 없이 창구에서 본인 확인 → 새 폰 신분증 바로 폐기, 되돌리기 열쇠 사용 처리, 방문·IC로 다시 받기 안내',
      yes && yes.ok === true && sc.nw.cred.status === 'revoked' && sc.undoKeys[0].used && sc.activeNow === 0 && ot.includes('분실 신고 창구에서') && yes.result.includes('IC 주민등록증'));
    ok('되돌린 뒤에는 창구 버튼이 다시 잠김', !(await c.isEnabled('#counterBtn')));
    await c.close();
  }
  log('');

  /* 4. 위조 시험 */
  log('■ 4. 위조 시험 (공통기반이 막아야 함)');
  {
    const p = await open(ctx, FILE_URL + '?fast=1&s=1', '위조');
    await p.click('#top [data-act="help"]');
    await p.click('#help [data-act="tamper-sig"]');
    await p.waitForTimeout(800);
    const chip = await p.isVisible('#tchip');
    await play(p, [1], { upto: 7 });
    let s = await snap(p); let tr = byKind(s, 'transfer')[0];
    ok('승인 서명 1바이트 바꿈(도움말 창 버튼) → 「승인 서명」에서 거절', chip && tr && tr.ok === false && failedOf(tr) === '승인 서명');
    ok('  위조 뒤에도 옛 폰 신분증은 그대로, 새 폰엔 발급 안 됨', s.old.cred.status === 'active' && !s.nw.cred);
    const [dl1] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="export"]')]);
    const f1 = path.join(HERE, '검증기록_예시_위조시험.json'); await dl1.saveAs(f1);
    const r1 = V.check(JSON.parse(fs.readFileSync(f1, 'utf8')));
    const bad = r1.find(x => x.항목.startsWith('옛 폰 이어받기 승인'));
    ok('  내보낸 기록을 Node.js로 다시 검증해도 승인 서명 틀림', bad && bad.결과 === false && r1.every(x => x.일치 !== false));

    await p.evaluate(() => __poc.setTamper('cred'));
    await play(p, [1], { upto: 7 });
    s = await snap(p); tr = byKind(s, 'transfer')[0];
    ok('신분증 생년 고쳐 보냄 → 「옛 신분증 서명」에서 거절', tr && tr.ok === false && failedOf(tr) === '옛 신분증 서명');

    await play(p, [8]);
    await p.evaluate(() => __poc.replay());
    s = await snap(p); const trs = byKind(s, 'transfer');
    ok('막힌 승인(⑧)을 그대로 다시 보냄 → 「1회용 번호」에서 거절', trs.length === 2 && trs[1].ok === false && failedOf(trs[1]) === '1회용 번호');

    await play(p, [1], { upto: 6 });
    const r = await p.evaluate(async () => {
      const d = S.old, sc = d.scanned;
      const base = { type: '이어받기 승인', credId: d.cred.payload.id, newKeyFp: sc.fp, nonce: sc.nonce, nearToken: sc.nearToken, requestedAt: sc.t, approvedAt: iso(S.now) };
      const sig = await signObj(d.keys.priv, base);
      const attacker = await makeKeys();
      const a = await hubTransfer({ cred: d.cred, oldSpki: d.keys.spki, approval: { ...base, newKeyFp: attacker.fp }, approvalSig: sig }, '서명 뒤 새 폰 열쇠 지문을 바꿔치기');
      const b = await hubTransfer({ cred: d.cred, oldSpki: attacker.spki, approval: base, approvalSig: await signObj(attacker.priv, base) }, '다른 폰 열쇠로 서명');
      render(); return { a: a.failed && a.failed.n, b: b.failed && b.failed.n, bn: b.failed && b.failed.note };
    });
    ok('서명 뒤 승인 내용(새 폰 열쇠) 바꿔치기 → 「승인 서명」에서 거절', r.a === '승인 서명');
    ok('옛 신분증에 묶이지 않은 다른 폰 열쇠로 서명 → 「승인 서명」에서 거절', r.b === '승인 서명', r.bn);
    await play(p, [8], { upto: 6 });
    const r4 = await p.evaluate(async () => {
      const d = S.old, sc = d.scanned;
      const ap = { type: '이어받기 승인', credId: d.cred.payload.id, newKeyFp: sc.fp, nonce: sc.nonce, nearToken: rand(8), requestedAt: sc.t, approvedAt: iso(S.now) };
      const x = await hubTransfer({ cred: d.cred, oldSpki: d.keys.spki, approval: ap, approvalSig: await signObj(d.keys.priv, ap) }, '블루투스 신호값을 지어내 넣음');
      render(); return x.failed && x.failed.n;
    });
    ok('멀리서 블루투스 신호값을 지어내 넣고 정상 서명 → 「두 폰 가까이(블루투스)」에서 거절', r4 === '두 폰 가까이(블루투스)');
    await p.close();
  }
  log('');

  /* 5. 내보내기 */
  log('■ 5. 검증 기록 내보내기와 브라우저 밖 재검증');
  {
    const p = await open(ctx, FILE_URL + '?fast=1&s=1', '내보내기');
    await play(p, [1]);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="export"]')]);
    const f = path.join(HERE, '검증기록_예시_시나리오1.json'); await dl.saveAs(f);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('JSON 파일로 내려받아짐(발급기관·공통기반 공개키 포함)', dl.suggestedFilename().endsWith('.json') && j['기록'].length > 0 && !!j['공통기반_공개키_SPKI'], dl.suggestedFilename());
    const r = V.check(j);
    ok(`Node.js 내장 crypto로 서명 ${r.length}건 다시 검증: 모두 맞음, 브라우저 판정과 모두 같음`, r.length >= 9 && r.every(x => x.결과 === true) && r.every(x => x.일치 !== false));
    await p.close();
  }
  log('');

  /* 6. 화면 크기 */
  log('■ 6. 화면 크기별 표시');
  for (const [w, h] of [[1920, 1080], [1600, 900], [1366, 768], [1280, 720]]) {
    const c = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await open(c, FILE_URL, `${w}x${h}`);
    const m = await p.evaluate(() => { const r = document.querySelector('#nw').getBoundingClientRect(), hub = document.querySelector('.hub').getBoundingClientRect(), st = document.querySelector('#strip').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, bottom: Math.max(r.bottom, hub.bottom, st.bottom), ih: innerHeight, right: hub.right }; });
    ok(`${w}×${h}: 가로 스크롤 없음, 세 칸과 단계 안내 줄이 화면 안에 들어옴`, m.sw <= m.iw && m.bottom <= m.ih + 1 && m.right <= m.iw + 1);
    await c.close();
  }
  {
    const c = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await open(c, FILE_URL + '?s=8', '1366 자막');
    p.evaluate(() => __poc.play([8])); // 보통 속도로 돌리며 자막을 살펴봄
    let worst = 0, seen = 0;
    for (let i = 0; i < 24; i++) {
      await p.waitForTimeout(600);
      const m = await p.evaluate(() => { const e = document.querySelector('#strip .spill'); return e ? { sw: e.scrollWidth, cw: e.clientWidth } : null; });
      if (m) { seen++; worst = Math.max(worst, m.sw - m.cw); }
    }
    ok('1366×768에서 자동 시연 단계 안내(가장 긴 ⑧ 이름 포함)가 잘리지 않음', seen > 5 && worst <= 0, `${seen}번 확인`);
    await p.evaluate(() => { if (S.auto) S.auto.stop = true; }); await p.waitForTimeout(2500);
    await c.close();
  }
  for (const [w, vis] of [[800, true], [1024, false]]) {
    const c = await browser.newContext({ viewport: { width: w, height: 700 } });
    const p = await open(c, FILE_URL, `${w}px`);
    const v = await p.isVisible('#narrow');
    ok(`${w}px: 「PC 화면에서 열어 주세요」 안내 ${vis ? '보임' : '안 보임'}`, v === vis && (!vis || (norm(await p.textContent('#narrow'))).includes('PC 화면에서 열어 주세요')));
    await c.close();
  }
  log('');

  /* 6-2. 표현 */
  log('■ 6-2. 이름·표현 점검');
  {
    const html = fs.readFileSync(HTML, 'utf8'), readme = fs.readFileSync(README, 'utf8');
    const p = await open(ctx, FILE_URL, '이름');
    const opts = await p.$$eval('#sc option', os => os.map(o => o.textContent.trim()));
    const title = await p.title(); const brand = norm(await p.textContent('.brand b'));
    await p.close();
    ok('드롭다운 시나리오 이름 8개가 확정 문구와 똑같음', opts.length === 8 && opts.every((t, i) => t === NAMES[i]));
    ok('도움말·README에도 확정 시나리오 이름 8개', NAMES.every(n => html.includes(n) && readme.includes(n)));
    ok('시제품 이름 「신분증 이어받기 시뮬레이터」(페이지 제목·화면 위·README)', title === '신분증 이어받기 시뮬레이터' && brand === '신분증 이어받기 시뮬레이터' && readme.startsWith('﻿신분증 이어받기 시뮬레이터'));
    ok('README 첫머리에 확정 한 줄 요약', readme.includes('폰을 바꾸거나 3년이 지나도 다시 방문하지 않고, 옛 폰의 모바일신분증과 새 폰 얼굴 인증으로 신분증을 이어받습니다.'));
    const banned = [new RegExp('잠금\\s*보관'), /약해지지 않/, /같은 수준/, /두 번 막/, /진짜 방어선/, new RegExp('\uC9C4\uC9DC'), /\u2014/, new RegExp('갤럭시|아이폰|Galaxy|iPhone', 'i')];
    ok('쓰지 않기로 한 표현(예전 72시간 표현, 보안 과장 표현, 긴 줄표, 실제 기종 이름)이 시제품·README에 없음', banned.every(b => !b.test(html) && !b.test(readme)));
    ok('승인 화면 코드에 「얼굴 인증: 완료」 표시가 없음', !/<dt>얼굴 인증<\/dt><dd class="y">완료/.test(html));
  }
  log('');

  /* 7. 콘솔 오류 */
  log('■ 7. 콘솔 오류');
  ok('모든 검사 동안 콘솔 오류 0건', consoleErrors.length === 0, `${consoleErrors.length}건`);
  for (const e of consoleErrors) log('     ' + e);
  log('');

  await browser.close();
  log('■ 요약');
  log(`  시나리오: ${summary.join(' · ')}  (${summary.filter(x => x.endsWith('맞음')).length}/8)`);
  log(`  8개 시나리오를 도는 동안 신분증으로 쓸 수 있었던 것의 최대 개수: ${maxActiveAll}개`);
  log(`  전체 검사 ${pass + fail}개 중 통과 ${pass}개, 실패 ${fail}개${fail ? ' (' + failures.join(', ') + ')' : ''}`);
  log(`  걸린 시간 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  log('');
  log('※ 얼굴 인증·본인 명의 확인·블루투스 근거리 확인·창구 본인 확인은 시뮬레이션이고, 전자서명·검증은 브라우저 내장 WebCrypto로 실제 수행합니다.');
  fs.writeFileSync(OUT, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); lines.push('검사 중 오류: ' + (e.stack || e)); fs.writeFileSync(OUT, '﻿' + lines.join('\r\n'), 'utf8'); process.exit(2); });
