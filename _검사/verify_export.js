// 「검증 기록 내보내기」로 받은 JSON의 전자서명을 브라우저 밖(Node.js 내장 crypto)에서 다시 검증합니다.
// 사용법: node verify_export.js 검증기록_....json
'use strict';
const crypto = require('crypto');
const fs = require('fs');

// 시제품과 똑같이 키를 정렬한 JSON 문자열을 만든다(서명 대상 바이트)
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function verify(spkiHex, obj, sigHex) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spkiHex, 'hex'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(canon(obj), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigHex, 'hex'));
  } catch (e) { return false; }
}
const fp = spkiHex => crypto.createHash('sha256').update(Buffer.from(spkiHex, 'hex')).digest('hex');

// 기록마다 서명을 다시 검증하고, 브라우저(공통기반)가 내린 판정과 같은지 비교
function check(json) {
  const iss = json['발급기관_공개키_SPKI'], hub = json['공통기반_공개키_SPKI'];
  const out = [];
  for (const e of json['기록']) {
    const d = e['원자료']; if (!d) continue;
    const browser = name => { const c = (e['검사'] || []).find(x => x['항목'] === name); return c ? c['결과'] : null; };
    const push = (항목, 결과, 브라우저) => out.push({ 번호: e['번호'], 제목: e['제목'], 항목, 결과, 브라우저판정: 브라우저 });
    if (d.cred) {
      const r = verify(iss, d.cred.payload, d.cred.sig);
      push('신분증 발급기관 서명', r, browser('옛 신분증 서명') || browser('신분증 서명'));
    }
    if (d.approval) {
      const bind = fp(d.oldPhoneSpki) === d.cred.payload.holderKeyFp;
      const r = bind && d.approval.credId === d.cred.payload.id && verify(d.oldPhoneSpki, d.approval, d.approvalSig);
      push('옛 폰 이어받기 승인 서명(신분증에 묶인 열쇠인지 포함)', r, browser('승인 서명'));
    }
    if (d.undoKey) push('되돌리기 열쇠 공통기반 서명', verify(hub, d.undoKey.payload, d.undoKey.sig), browser('되돌리기 열쇠 공통기반 서명'));
    if (d.request) {
      // 제출·갱신은 신분증에, 되돌리기 요청은 되돌리기 열쇠에 묶인 폰 열쇠로 서명해야 함
      const base = d.cred || d.undoKey; const idField = d.cred ? 'credId' : 'undoKeyId';
      const bind = fp(d.phoneSpki) === base.payload.holderKeyFp;
      const r = bind && d.request[idField] === base.payload.id && verify(d.phoneSpki, d.request, d.signature);
      push(`폰 서명(${d.request.type})`, r, browser('폰 서명') || browser('요청 서명'));
    }
    if (d.newCred) push('새로 발급한 신분증 발급기관 서명', verify(iss, d.newCred.payload, d.newCred.sig), null);
  }
  // 브라우저 판정과 비교: '통과'↔true, '실패'↔false, '검사 안 함'은 비교하지 않음
  for (const r of out) {
    r.일치 = r.브라우저판정 === null || r.브라우저판정 === '검사 안 함' ? null : ((r.브라우저판정 === '통과') === r.결과);
  }
  return out;
}
module.exports = { check, verify, canon, fp };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.log('사용법: node verify_export.js 검증기록.json'); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = check(j);
  let mismatch = 0;
  for (const x of r) {
    if (x.일치 === false) mismatch++;
    console.log(`#${x.번호} ${x.제목} | ${x.항목}: ${x.결과 ? '맞음' : '틀림'}` + (x.브라우저판정 ? ` (브라우저 판정: ${x.브라우저판정}${x.일치 === false ? ' — 다름!' : ''})` : ''));
  }
  console.log(`서명 ${r.length}건 다시 검증 · 브라우저 판정과 다른 것 ${mismatch}건`);
  process.exit(mismatch ? 2 : 0);
}
