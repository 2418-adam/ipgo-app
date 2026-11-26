/* 에이앤텍 입고 — '현황' 화면 (공정·도면·부품, 대표·경리는 돈 자료도).
 * 회사 PC가 30분마다 만드는 현황_요약.json·현황_돈.json 을 Apps Script(dash 요청)가 비밀번호 확인 뒤 내려준다.
 * - 열면 폰에 담아 둔 마지막 자료를 바로 보여 주고 서버에서 새 자료를 받는다.
 * - 자료가 10분 넘었거나 [새로 고침]이면 회사 PC에 '새로 만들어 달라' 요청을 남기고, 1~2분 동안 새 자료를 기다린다.
 * - 돈 자료는 관리자(대표·경리) 비밀번호를 넣은 폰에서만 (서버가 이름·비밀번호가 맞을 때만 내려줌).
 *   비밀번호는 각자 여기서 정하고 바꾼다 (처음·잊었을 때는 등록된 이메일로 인증번호).
 * app.js 의 st·call·get·put·el·show·esc·toast·stopCamera·startCamera·draw 를 쓴다. */
'use strict';

var D = {
  tab: 'in', s: get('dash_s', null), m: get('dash_m', null), admin: get('admin2', null),
  admins: get('admins', []), pick: '', mode: '', mail: '',
  asked: '', waitUntil: 0, timer: null, busy: false, find: '', shown: 30
};
var STALE_MIN = 10;          // 이보다 오래된 자료면 열 때 회사 PC에 새로 요청
var OFF_MIN = 45;            // 이보다 오래됐으면 회사 PC가 꺼져 있다고 봄 (30분마다 만드니까)
var WAIT_MS = 3 * 60000;     // 요청하고 새 자료를 기다리는 시간
var TONE = {'납기 넘김 예상': 'red', '빠듯함': 'orange', '여유': 'green', '출하 완료': 'green'};

function made(s) {           // 자료 기준 시각 (회사 PC 시각 = 한국 시각)
  var t = s && s['기준시각'];
  return t ? new Date(String(t).slice(0, 19) + '+09:00') : null;
}
function ageMin(s) { var d = made(s); return d ? (Date.now() - d.getTime()) / 60000 : 1e9; }
function n0(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function fmt(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Math.abs(v) >= 10000 ? v.toLocaleString('ko-KR') : String(v);
  return String(v);
}
function md(s) { return s ? String(s).slice(5, 10).replace('-', '/') : ''; }   // '2026-12-16' → '12/16'

// ---------------------------------------------------------------------------
// 화면 바꾸기
// ---------------------------------------------------------------------------

function setTab(tab) {
  D.tab = tab;
  el('tab_in').classList.toggle('on', tab === 'in');
  el('tab_dash').classList.toggle('on', tab === 'dash');
  if (tab === 'dash') {
    stopCamera(true);    // 카메라는 쉬고, 입고로 돌아오면 다시 켬
    show('main', false); show('savebar', false); show('today', false); show('dash', true);
    window.scrollTo(0, 0);
    openDash();
  } else {
    show('dash', false);
    enter();
    if (camWanted) startCamera(true);
  }
}

/** app.js 가 부름: 로그인 화면(out)·오늘 저장한 것(sub)·입고 화면으로 갈 때 */
window.dashLeave = function (out, sub) {
  show('tabs', !out && !!st.pin);
  if (out) { D.s = null; D.m = null; D.admin = null; D.mode = ''; put('dash_s', null); put('dash_m', null); put('admin2', null); }
  show('dash', false);
  if (!sub) {
    D.tab = 'in';
    el('tab_in').classList.add('on'); el('tab_dash').classList.remove('on');
  }
};

// ---------------------------------------------------------------------------
// 자료 받기
// ---------------------------------------------------------------------------

function openDash() {
  draw_();
  var stale = !D.s || ageMin(D.s) > STALE_MIN;
  fetchDash(stale && !waiting());
}

function waiting() { return Date.now() < D.waitUntil; }

function fetchDash(fresh) {
  if (D.busy) return;
  D.busy = true;
  el('d_refresh').disabled = true;
  if (fresh) state('회사 PC에 새로 만들어 달라고 하는 중…', 'wait');
  call('dash', {admin: D.admin, fresh: !!fresh}).then(function (r) {
    D.busy = false;
    el('d_refresh').disabled = false;
    take(r);
    if (fresh && r.asked) {
      D.asked = r.asked;
      D.waitUntil = Date.now() + WAIT_MS;
      poll();
    }
    draw_();
  }, function (e) {
    D.busy = false;
    el('d_refresh').disabled = false;
    draw_();
    if (e.server && /비밀번호가 틀립니다/.test(e.message)) { logout('회사 비밀번호가 바뀌었어요. 다시 넣어 주세요'); return; }
    state('새 자료를 못 받았어요 (' + e.message + ') — 폰에 담아 둔 자료예요', 'warn');
  });
}

function take(r) {
  if (r.s) { D.s = r.s; put('dash_s', r.s); }
  if (r.admins) { D.admins = r.admins; put('admins', r.admins); }
  if (r.adminBad) {
    D.admin = null; put('admin2', null); D.m = null; put('dash_m', null);
    toast('관리자 비밀번호가 틀려요', 'err');
  } else if (r.m) { D.m = r.m; put('dash_m', r.m); }
}

/** 요청 뒤: 20초마다 새 자료가 왔는지 (기준 시각이 요청보다 늦어지면 끝) */
function poll() {
  clearTimeout(D.timer);
  if (D.tab !== 'dash' || document.hidden) return;
  if (newer()) { state('새 자료로 바꿨어요', 'ok'); D.waitUntil = 0; return; }
  if (!waiting()) { draw_(); return; }
  D.timer = setTimeout(function () {
    call('dash', {admin: D.admin}).then(function (r) { take(r); draw_(); poll(); }, function () { poll(); });
  }, 20000);
}

function newer() {
  var t = D.s && D.s['기준시각'];
  return !!(t && D.asked && String(t).slice(0, 19) >= String(D.asked).slice(0, 19));
}

function state(text, kind) {
  var e = el('d_state');
  e.textContent = text || '';
  e.className = 'dstate' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// 그리기
// ---------------------------------------------------------------------------

function draw_() {
  var s = D.s;
  if (!s) {
    el('d_when').textContent = D.busy ? '자료를 불러오는 중…' : '아직 자료가 없어요';
    return;
  }
  var d = made(s), age = Math.round(ageMin(s));
  el('d_when').textContent = (d ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(d) : s['기준']) + ' 기준' +
      (age < 1 ? ' (방금)' : age < 120 ? ' (' + age + '분 전)' : '');
  if (waiting() && !newer()) state('회사 PC가 새로 만드는 중이에요 (1~2분)… 이 화면을 켜 두면 저절로 바뀌어요', 'wait');
  else if (D.asked && !newer()) state('⚠ 회사 PC가 꺼져 있거나 바빠서 ' + (d ? hhmm(d) : '') + ' 자료예요', 'warn');
  else if (age > OFF_MIN) state('⚠ 회사 PC가 꺼져 있는 것 같아요 — ' + (d ? hhmm(d) : '') + ' 자료예요', 'warn');
  else if (!D.busy && el('d_state').className.indexOf('ok') < 0) state('', '');
  if ((s['오류'] || []).length) state('일부를 못 읽었어요: ' + s['오류'].join(' / '), 'warn');

  var n = s['숫자'] || {};
  var nums = [
    ['진행 중인 설비', n['진행 설비'], 'blue'], ['납기 넘김 예상', n['납기 넘김 예상'], 'red'], ['빠듯함', n['빠듯함'], 'orange'],
    ['가공품 미입고', n['가공 미입고(장)'], 'yellow', '장'], ['가공품 늦음', n['가공 늦음(장)'], n0(n['가공 늦음(장)']) ? 'red' : 'gray', '장'],
    ['늦은 구매품', n['늦은 부품'], n0(n['늦은 부품']) ? 'red' : 'gray']
  ];
  el('d_nums').innerHTML = nums.map(function (x) {
    return '<div class="num t-' + x[2] + '"><div class="v">' + esc(fmt(n0(x[1]))) + (x[3] ? '<small>' + x[3] + '</small>' : '') +
        '</div><div class="l">' + esc(x[0]) + '</div></div>';
  }).join('');

  drawUnits(s);
  drawWhere(s);
  drawOpen(s);
  var late = s['늦은부품'] || [];
  show('d_latebox', late.length > 0);
  el('d_late').innerHTML = late.map(function (r) {
    return '<div class="row2"><div class="a">' + esc(r['품목'] || '') + ' <span class="late">' + esc(r['늦음'] || '') + '</span></div>' +
        '<div class="b">' + esc([r['프로젝트번호'], r['업체'], '남은 ' + fmt(r['남은수량']), '예상입고 ' + md(r['예상입고일'])].join(' · ')) + '</div></div>';
  }).join('');
  drawMoney();
}

function drawUnits(s) {
  var mach = s['가공'] || [], parts = {};
  (s['남은부품'] || []).forEach(function (p) { parts[p['프로젝트번호'] + '|' + p['설비명']] = p; });
  var units = s['설비'] || [];
  el('d_units').innerHTML = units.length ? '' : '<div class="card sub">진행 중인 설비가 없어요</div>';
  units.forEach(function (r) {
    var no = String(r['프로젝트번호'] || ''), name = String(r['설비명'] || ''), risk = String(r['납기위험'] || '');
    var margin = r['납기여유(일)'];
    var pill = risk + (margin != null && margin !== '' ? ' ' + (n0(margin) >= 0 ? '+' : '') + n0(margin) + '일' : '');
    var h = '<div class="card unit"><div class="uh">' +
        '<span class="tag' + (no.charAt(0) === '(' ? ' none' : '') + '">' + esc(no.charAt(0) === '(' ? '미등록' : no) + '</span>' +
        '<span class="nm">' + esc(name) + '</span>' +
        (pill.trim() ? '<span class="pill t-' + (TONE[risk] || 'gray') + '">' + esc(pill) + '</span>' : '') + '</div>';
    var left = r['남은일수'] != null && r['남은일수'] !== '' ? ' (D-' + n0(r['남은일수']) + ')' : '';
    h += '<div class="ln"><b>지금</b> ' + esc((r['현재단계'] || '') + ' (' + (r['진행'] || '') + ')') + ' · <b>납기</b> ' +
        esc((r['납기일'] || '없음') + left) + ' · <b>예상 출하</b> ' + esc(r['예상출하일'] || '-') + '</div>';
    var p = parts[no + '|' + name];
    if (p) h += '<div class="ln"><b>구매품</b> ' + esc(p['남은 품목'] + '품목 남음' + (n0(p['늦음']) ? ' (늦음 ' + p['늦음'] + ')' : '') +
        (p['마지막 예상입고'] ? ' · 마지막 예상입고 ' + md(p['마지막 예상입고']) : '')) + '</div>';
    if (r['막힌이유']) h += '<div class="ln"><b>막힌 곳</b> ' + esc(r['막힌이유']) + '</div>';
    if (r['다음할일']) h += '<div class="ln"><b>다음 할 일</b> ' + esc(r['다음할일']) + '</div>';
    var mine = mach.filter(function (x) { return String(x['프로젝트번호']) === no && String(x['설비명']) === name; });
    if (mine.length) {
      h += '<table class="proc"><tr><th>공정</th><th>업체</th><th class="n">입고</th><th class="n">안보냄</th><th class="n">가공중</th><th class="n">늦음</th></tr>';
      mine.forEach(function (x) {
        var tone = n0(x['늦음']) ? 'red' : n0(x['도면 안 보냄']) ? 'orange' : !n0(x['미입고']) ? 'green' : 'blue';
        h += '<tr><td><span class="pk t-' + tone + '">' + esc(x['공정'] || '') + '</span></td><td>' + esc(x['가공업체'] || '') +
            '</td><td class="n">' + n0(x['입고 완료']) + '/' + n0(x['도면(장)']) + '</td><td class="n">' + n0(x['도면 안 보냄']) +
            '</td><td class="n">' + n0(x['가공 중']) + '</td><td class="n">' + n0(x['늦음']) + '</td></tr>';
      });
      h += '</table>';
    }
    el('d_units').insertAdjacentHTML('beforeend', h + '</div>');
  });
}

function drawWhere(s) {
  var rows = s['업체별_보유'] || [];
  el('d_where').innerHTML = rows.length ? rows.map(function (r) {
    var late = n0(r['늦음']);
    return '<div class="row2"><div class="a">' + esc((r['지금 있는 곳'] || '') + ' · ' + (r['작업'] || '')) + ' — ' + n0(r['도면(장)']) + '장' +
        (late ? ' <span class="late">늦음 ' + late + '</span>' : '') + '</div>' +
        '<div class="b">' + esc([r['가장 이른 보낸날'] ? '보낸날 ' + md(r['가장 이른 보낸날']) : '', r['가장 이른 약속일'] ? '약속 ' + md(r['가장 이른 약속일']) : '',
                                 r['도번(앞 10장)'] || ''].filter(Boolean).join(' · ')) + '</div></div>';
  }).join('') : '<div class="sub">지금 업체에 가 있는 가공품이 없어요</div>';
}

function drawOpen(s) {
  var all = s['가공_미입고'] || [];
  var q = D.find.trim().toLowerCase();
  var rows = !q ? all : all.filter(function (r) {
    return ['도번', '파트명', '가공업체', '공정', '상태', '지금 있는 곳', '설비명', '프로젝트번호'].some(function (k) {
      return String(r[k] || '').toLowerCase().indexOf(q) >= 0;
    });
  });
  el('d_opencnt').textContent = q ? '(' + rows.length + ' / ' + all.length + '장)' : '(' + all.length + '장)';
  el('d_open').innerHTML = rows.slice(0, D.shown).map(function (r) {
    return '<div class="row2"><div class="a">' + esc(r['도번'] || '') + ' <span class="sub">' + esc(r['파트명'] || '') + '</span>' +
        (r['늦음'] ? ' <span class="late">' + esc(r['늦음']) + '</span>' : '') + '</div>' +
        '<div class="b">' + esc([r['공정'], r['가공업체'] || (r['지금 있는 곳'] === '아직 안 보냄' ? '' : r['지금 있는 곳']), r['상태'], r['수량'] ? r['수량'] + '개' : '',
                                 r['예상입고일'] ? '예상 ' + md(r['예상입고일']) : ''].filter(Boolean).join(' · ')) + '</div></div>';
  }).join('') || '<div class="sub">' + (q ? '찾는 도면이 없어요' : '미입고 가공품이 없어요') + '</div>';
  show('d_more', rows.length > D.shown);
  el('d_more').textContent = '더 보기 (' + (rows.length - D.shown) + '장 더)';
}

// ---------------------------------------------------------------------------
// 관리자 (대표·경리) — 사람마다 비밀번호를 폰에서 직접 정하고 바꾼다
//   처음 정하기·잊었을 때: 등록된 이메일로 인증번호 6자리 → 새 비밀번호
//   바꾸기: 지금 비밀번호 + 새 비밀번호
// ---------------------------------------------------------------------------

var PW_INPUT = ' type="password" inputmode="numeric" autocomplete="off"';

function pwField(id, ph) { return '<input id="' + id + '"' + PW_INPUT + ' placeholder="' + ph + '">'; }

function newPw() {        // 새 비밀번호 두 칸 확인. 틀리면 알림 후 ''
  var a = el('d_new1').value.trim(), b = el('d_new2').value.trim();
  if (!/^[0-9]{6,12}$/.test(a)) { toast('새 비밀번호는 숫자 6~12자리로 해 주세요', 'err'); return ''; }
  if (a !== b) { toast('새 비밀번호 두 칸이 달라요', 'err'); return ''; }
  return a;
}

function busyBtn(id, on) { var b = el(id); if (b) b.disabled = on; }

function askCode(name) {
  busyBtn('d_codebtn', true);
  call('adminCode', {n: name}).then(function (r) {
    D.mode = 'code'; D.mail = r.mail || '';
    toast((r.mail || '이메일') + '로 인증번호를 보냈어요', 'ok');
    drawMoney();
  }, function (e) { busyBtn('d_codebtn', false); toast(e.message, 'err'); });
}

function setPw(name, req) {
  busyBtn('d_setbtn', true);
  req.n = name;
  call('adminSet', req).then(function () {
    D.admin = {n: name, p: req.neu}; put('admin2', D.admin);
    D.mode = ''; D.m = null;
    toast(req.old ? '관리자 비밀번호를 바꿨어요' : '관리자 비밀번호를 정했어요', 'ok');
    fetchDash(false);
    drawMoney();
  }, function (e) { busyBtn('d_setbtn', false); toast(e.message, 'err'); });
}

function adminLogin() {
  var list = D.admins || [];
  var h = '<h3>돈 (대표·경리만)</h3>';
  if (!list.length) {
    return h + '<div class="note">관리자가 아직 등록되지 않았어요. 회사 PC에서 대표·경리의 이름과 이메일을 넣으면, ' +
        '여기서 각자 비밀번호를 정해 수금·미수·미지급 자료를 볼 수 있어요.</div>';
  }
  var pick = list.filter(function (a) { return a.n === D.pick; })[0] || list[0];
  D.pick = pick.n;
  h += '<select id="d_who">' + list.map(function (a) {
    return '<option' + (a.n === pick.n ? ' selected' : '') + '>' + esc(a.n) + '</option>';
  }).join('') + '</select>';
  if (D.mode === 'code') {
    return h + '<div class="note">' + esc(D.mail || '등록된 이메일') + '로 보낸 인증번호 6자리와 새 비밀번호(숫자 6~12자리)를 넣어 주세요.</div>' +
        '<input id="d_code" inputmode="numeric" autocomplete="one-time-code" placeholder="인증번호 6자리">' +
        pwField('d_new1', '새 비밀번호') + pwField('d_new2', '새 비밀번호 한 번 더') +
        '<button id="d_setbtn" class="small">비밀번호 정하기</button>' +
        '<div class="links"><a href="#" id="d_recode">인증번호 다시 받기</a> · <a href="#" id="d_cancel">취소</a></div>';
  }
  if (!pick.set) {
    return h + '<div class="note">' + esc(pick.n) + '님은 아직 비밀번호를 정하지 않았어요. ' +
        (pick.mail ? esc(pick.mail) + '로 인증번호를 받아 직접 정해요.' : '회사 PC에서 이메일을 먼저 넣어야 해요.') + '</div>' +
        (pick.mail ? '<button id="d_codebtn" class="small">이메일로 인증번호 받기</button>' : '');
  }
  return h + '<div class="note">비밀번호를 넣으면 이 폰에서 수금·미수·미지급 자료가 보여요.</div>' +
      pwField('d_admin', esc(pick.n) + ' 관리자 비밀번호') + '<button id="d_adminok" class="small">확인</button>' +
      '<div class="links"><a href="#" id="d_forgot">비밀번호를 잊었어요 (이메일로 인증번호)</a></div>';
}

function wireLogin() {
  var on = function (id, fn) { var x = el(id); if (x) x.onclick = function (e) { e.preventDefault(); fn(); }; };
  if (el('d_who')) el('d_who').onchange = function () { D.pick = el('d_who').value; D.mode = ''; drawMoney(); };
  on('d_codebtn', function () { askCode(D.pick); });
  on('d_forgot', function () { askCode(D.pick); });
  on('d_recode', function () { askCode(D.pick); });
  on('d_cancel', function () { D.mode = ''; drawMoney(); });
  on('d_setbtn', function () {
    var code = el('d_code').value.trim();
    if (!/^[0-9]{6}$/.test(code)) { toast('인증번호 6자리를 넣어 주세요', 'err'); return; }
    var neu = newPw();
    if (neu) setPw(D.pick, {code: code, neu: neu});
  });
  on('d_adminok', function () {
    var v = el('d_admin').value.trim();
    if (!v) return;
    D.admin = {n: D.pick, p: v}; put('admin2', D.admin);
    fetchDash(false);
  });
}

function drawMoney() {
  var box = el('d_money');
  if (!D.admin) {
    box.innerHTML = adminLogin();
    wireLogin();
    return;
  }
  if (D.mode === 'change') {
    box.innerHTML = '<h3>' + esc(D.admin.n) + ' 관리자 비밀번호 바꾸기</h3>' +
        pwField('d_old', '지금 비밀번호') + pwField('d_new1', '새 비밀번호 (숫자 6~12자리)') + pwField('d_new2', '새 비밀번호 한 번 더') +
        '<button id="d_setbtn" class="small">바꾸기</button><div class="links"><a href="#" id="d_cancel">취소</a></div>';
    el('d_cancel').onclick = function (e) { e.preventDefault(); D.mode = ''; drawMoney(); };
    el('d_setbtn').onclick = function () {
      var old = el('d_old').value.trim();
      if (!old) { toast('지금 비밀번호를 넣어 주세요', 'err'); return; }
      var neu = newPw();
      if (neu) setPw(D.admin.n, {old: old, neu: neu});
    };
    return;
  }
  var m = D.m;
  var h = '<h3>돈 (대표·경리만) <span class="sub">' + esc(D.admin.n) + '</span></h3>';
  if (!m) h += '<div class="note">돈 자료를 불러오는 중…</div>';
  else {
    (m['오류'] || []).forEach(function (e) { h += '<div class="note late">' + esc(e) + '</div>'; });
    (m['표'] || []).forEach(function (t) {
      h += '<div class="mt">' + esc(t['제목'] || '') + '</div>';
      var cols = t['열'] || [], rows = t['줄'] || [];
      if (!rows.length) { h += '<div class="note">' + esc(t['설명'] || '해당 없음') + '</div>'; return; }
      rows.slice(0, 30).forEach(function (r) {
        h += '<div class="row2"><div class="a">' + esc(fmt(r[0])) + '</div><div class="b">' +
            esc(cols.slice(1).map(function (c, i) { var v = fmt(r[i + 1]); return v ? c + ' ' + v : ''; }).filter(Boolean).join(' · ')) + '</div></div>';
      });
      if (rows.length > 30) h += '<div class="note">외 ' + (rows.length - 30) + '줄 — PC 업무 도우미에서 보세요</div>';
      if (t['설명']) h += '<div class="note">' + esc(t['설명']) + '</div>';
    });
  }
  h += '<div class="links"><a href="#" id="d_change">비밀번호 바꾸기</a> · <a href="#" id="d_adminout">이 폰에서 관리자 비밀번호 지우기</a></div>';
  box.innerHTML = h;
  el('d_change').onclick = function (e) { e.preventDefault(); D.mode = 'change'; drawMoney(); };
  el('d_adminout').onclick = function (e) {
    e.preventDefault();
    D.admin = null; D.m = null; put('admin2', null); put('dash_m', null);
    drawMoney();
  };
}

// ---------------------------------------------------------------------------

(function () {
  try { localStorage.removeItem('ipgo_admin'); } catch (e) { /* 예전(11-25)의 공용 관리자 비밀번호 — 이제 안 씀 */ }
  el('tab_in').onclick = function () { if (D.tab !== 'in') setTab('in'); };
  el('tab_dash').onclick = function () { if (D.tab !== 'dash') setTab('dash'); };
  el('d_refresh').onclick = function () { fetchDash(true); };
  el('d_find').oninput = function () { D.find = el('d_find').value; D.shown = 30; if (D.s) drawOpen(D.s); };
  el('d_more').onclick = function () { D.shown += 50; if (D.s) drawOpen(D.s); };
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || D.tab !== 'dash') return;
    if (waiting()) poll();
    else if (!D.s || ageMin(D.s) > STALE_MIN) fetchDash(true);
    else draw_();
  });
  setInterval(function () { if (D.tab === 'dash' && !document.hidden && D.s) draw_(); }, 60000);   // '몇 분 전' 고침
  show('tabs', !!st.pin && !el('main').classList.contains('hide'));
})();
