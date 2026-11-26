/* 에이앤텍 입고 — 가공품 QR을 이어서 찍고 한 번에 저장하는 폰 앱.
 * 기록은 구글 Apps Script 웹앱(tools/apps_script/가공입고)을 거쳐 구글 드라이브의 가공_입고_스캔.csv 에 들어간다.
 * 신호가 없으면 폰에 담아 두었다가 신호가 잡히면 저절로 보낸다.
 * 저장 전에 확인 화면, 저장 뒤 몇 분 동안은 '되돌리기'(서버에서 기록번호로 그 줄을 지움). */
'use strict';

var VERSION = '2026-11-26.1';
var API = window.IPGO_API || '';
var FIX = ['수정', '재작업'];
var POST_WORKS = ['와이어', '도금', '연마', '열처리', '흑착색', '아노다이징'];
var NEW_VENDOR = '__new__';
var NO_VENDOR = '';
var UNDO_MIN = 10;          // 저장하고 이 시간(분) 안에만 되돌리기

var st = {
  pin: get('pin', ''), who: get('who', ''), vendors: get('vendors', []), names: get('names', []),
  vendor: get('vendor', ''), items: get('items', []), queue: get('queue', []),
  done: get('done', []).filter(function (b) { return b.day === today(); })   // 오늘 저장한 묶음 (맨 앞이 방금 것)
};

function get(k, d) { try { var v = localStorage.getItem('ipgo_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function put(k, v) { try { localStorage.setItem('ipgo_' + k, JSON.stringify(v)); } catch (e) { /* 저장 공간 없음 */ } }
function el(id) { return document.getElementById(id); }
function show(id, on) { el(id).classList.toggle('hide', !on); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function stamp() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
         pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function today() { return stamp().slice(0, 10); }
function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function div(cls, text) { var d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; }

// ---------------------------------------------------------------------------
// 서버 (Apps Script)
// ---------------------------------------------------------------------------

function call(a, body) {
  if (!API) return Promise.reject(new Error('앱 설정에 서버 주소가 없습니다 (config.js)'));
  body = Object.assign({a: a, pin: st.pin, who: st.who}, body || {});
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 25000);
  return fetch(API, {method: 'POST', body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow'})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j.ok) { var e = new Error(j.err || '서버 오류'); e.server = true; throw e; }
        return j.r;
      }, function (e) { clearTimeout(timer); var x = new Error('신호가 없거나 서버에 닿지 않음'); x.net = true; throw x; });
}

// ---------------------------------------------------------------------------
// 이번에 할 일 (지금까지 기록 + 공정 순서) — 예전 Page.html 과 같은 규칙
// 첫 공정은 도면이 이미 업체에 있으니 '들어옴', 그 뒤 공정은 '보냄' → '들어옴', 불량이면 '수정 보냄/들어옴'
// ---------------------------------------------------------------------------

function routeOf(it) {
  var route = (it.k || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return it.a === '1' ? route.slice(0, 1) : route;
}

function nextStep(it, hist) {
  var need = Number(it.c || 1), steps = routeOf(it);
  var got = {}, sent = {}, defect = 0, fixSent = false;
  (hist || []).forEach(function (h) {
    var n = h.q ? Number(h.q) : need;
    if (h.kind === '불량') { defect++; fixSent = false; }
    else if (h.kind === '보냄') { if (FIX.indexOf(h.work) >= 0) fixSent = true; else sent[h.work] = true; }
    else if (FIX.indexOf(h.work) >= 0) { defect = Math.max(0, defect - 1); fixSent = false; }
    else if (h.work) { got[h.work] = (got[h.work] || 0) + n; }
  });
  if (defect) return {k: fixSent ? '들어옴' : '보냄', w: '수정', left: need};
  if (!steps.length) {
    var plain = 0;
    (hist || []).forEach(function (h) { if (!h.work && (h.kind || '들어옴') === '들어옴') plain += h.q ? Number(h.q) : need; });
    if (plain >= need && hist.length) return {k: '', w: '', done: true};
    return {k: '들어옴', w: '', left: need - plain};
  }
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    if ((got[s] || 0) >= need) continue;
    if (i === 0 || sent[s] || got[s]) return {k: '들어옴', w: s, left: need - (got[s] || 0)};
    return {k: '보냄', w: s};
  }
  return {k: '', w: '', done: true};
}

function actText(it) {
  if (it.whole) return '전부 들어옴';
  if (it.kind === '불량') return '불량';
  if (!it.kind) return '이미 다 끝남';
  var w = it.work ? it.work + ' ' : '';
  return it.kind === '보냄' ? (it.work || '') + '(으)로 보냄' : w + '들어옴';
}

function qtyText(it) {
  if (it.whole || it.kind !== '들어옴') return '';
  var q = it.qty || it.c || 1;
  return q + '개' + (it.c ? (Number(q) < Number(it.c) ? ' (도면 ' + it.c + '개 중)' : '') : '');
}

function histText(h) {
  if (h.kind === '불량') return '불량';
  var w = h.work ? h.work + ' ' : '';
  return (h.kind === '보냄' ? w + '보냄' : w + '들어옴') + (h.q ? ' ' + h.q + '개' : '');
}

/** 오늘 이미 저장한 도면이면 {t: '14:50', what: '와이어 들어옴'} — 이 폰에서 저장한 것, 그다음 서버 기록 */
function savedToday(it, hist) {
  for (var i = 0; i < st.done.length; i++) {
    var b = st.done[i];
    if (b.status === 'undone') continue;
    var hit = b.items.filter(function (x) { return x.key === it.key; })[0];
    if (hit) return {t: b.hhmm, what: actText(hit)};
  }
  var day = today(), last = null;
  (hist || []).forEach(function (h) {
    var on = h.at ? String(h.at).slice(0, 10) === day : String(h.t || '').slice(0, 5) === day.slice(5);
    if (on) last = h;
  });
  if (last) return {t: last.at ? String(last.at).slice(11, 16) : String(last.t).slice(6, 11), what: histText(last)};
  return null;
}

function dupText(it) { return '오늘 ' + it.dup.t + '에 이미 저장했어요 (' + it.dup.what + ')'; }

// ---------------------------------------------------------------------------
// QR 글자 → 도면
// ---------------------------------------------------------------------------

function parseQR(text) {
  text = String(text || '').trim();
  var q = {};
  try {
    var u = new URL(text);
    u.searchParams.forEach(function (v, k) { q[k] = v; });
  } catch (e) {
    if (/^[0-9A-Za-z][0-9A-Za-z\-_.]{2,40}$/.test(text)) q.d = text.toUpperCase();
    else return null;
  }
  if (!q.d && !q.v) return null;
  return q;
}

function keyOf(q) { return q.d ? 'd:' + String(q.d).toUpperCase() : 'v:' + q.v + '|' + (q.p || ''); }

function addFromQR(q, quiet) {
  var key = keyOf(q);
  if (st.items.some(function (it) { return it.key === key; })) {
    if (!quiet) toast('이미 찍었어요: ' + (q.d || q.v + ' 전부'));
    return false;
  }
  var it = {key: key, id: uid(), t: stamp(), d: q.d ? String(q.d).toUpperCase() : '', p: q.p || '', v: q.v || '',
            n: q.n || '', c: q.c || '', k: q.k || '', a: q.a || '', whole: !q.d, loading: !!q.d,
            kind: '들어옴', work: '', qty: '', memo: ''};
  it.dup = savedToday(it, null);
  if (it.v && !st.vendor) setVendor(it.v);
  st.items.unshift(it);
  saveItems();
  draw();
  if (it.dup && !quiet) toast('⚠ ' + (it.d || it.v + ' 전부') + ' — ' + dupText(it), 'err');
  if (it.d && st.pin) lookup(it);
  return true;
}

function lookup(it) {
  call('look', {ds: [it.d]}).then(function (r) {
    var x = r[it.d] || {};
    var info = x.info || {};
    ['p', 'n', 'c', 'k', 'a'].forEach(function (f) { if (!it[f] && info[f]) it[f] = info[f]; });
    it.unknown = !x.info;
    var p = nextStep(it, x.hist || []);
    it.kind = p.k; it.work = p.w; it.left = p.left;
    it.qty = p.k === '들어옴' ? String(p.left || it.c || 1) : '';
    it.hist = (x.hist || []).length;
    var had = !!it.dup;
    it.dup = savedToday(it, x.hist);
    it.loading = false;
    saveItems(); draw();
    if (it.dup && !had && st.items.indexOf(it) >= 0) toast('⚠ ' + it.d + ' — ' + dupText(it), 'err');
  }, function (e) {
    it.loading = false;
    it.offline = !!e.net;
    it.err = e.server ? e.message : '';
    saveItems(); draw();
    if (e.server && /비밀번호/.test(e.message)) logout(e.message);
  });
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

function saveItems() { put('items', st.items); }
function putDone() { put('done', st.done.slice(0, 30)); }
function saveable(it) { return it.whole || it.kind; }

function warnOf(it) {
  return it.err || (it.offline ? '신호 없음 — 공정을 몰라 그냥 "들어옴"으로 저장돼요 (눌러서 고치기)' : '')
      || (it.unknown ? '도면 목록에 없는 도번이에요 — 맞는지 확인' : '')
      || (!it.kind && !it.whole ? '이 도면은 모든 공정이 끝났어요 — 저장 안 됨 (눌러서 고치기)' : '');
}

function draw() {
  var box = el('items');
  box.innerHTML = '';
  st.items.forEach(function (it, i) {
    var row = div('item ' + (it.whole ? '' : (it.kind === '보냄' ? 'send' : it.kind === '불량' ? 'bad' : !it.kind ? 'done' : ''))
                  + (it.dup ? ' dup' : ''));
    var top = div('top');
    var left = div('left');
    left.appendChild(div('no', it.whole ? (it.v + ' 전부') : it.d));
    left.appendChild(div('info', it.whole ? ((it.p ? it.p + ' · ' : '') + '이 업체가 가지고 있던 도면 전부')
        : [it.n, it.c ? '수량 ' + it.c + '개' : '', it.p].filter(Boolean).join(' · ') || (it.loading ? '불러오는 중…' : '')));
    if (it.dup) left.appendChild(div('dupwarn', '⚠ ' + dupText(it) + (saveable(it) ? ' — 또 저장하면 두 번 들어가요. 아니면 눌러서 빼기' : '')));
    var warn = warnOf(it);
    if (warn) left.appendChild(div('warn', warn));
    top.appendChild(left);
    top.appendChild(div('act', it.loading ? '불러오는 중…' : actText(it)));
    row.appendChild(top);
    if (!it.loading && !it.whole && it.kind === '들어옴') row.appendChild(qtyRow(i, it));
    row.onclick = function () { openSheet(i); };
    box.appendChild(row);
  });
  var n = st.items.filter(saveable).length;
  var busy = st.items.filter(function (it) { return it.loading; }).length;
  show('empty', !st.items.length);
  show('savebar', st.items.length > 0 && !el('main').classList.contains('hide'));
  el('save').textContent = busy ? '정보 불러오는 중… (' + busy + '장)' : n ? n + '장 저장' : '저장할 것 없음';
  el('save').disabled = !n || busy > 0;
  drawCam();
  drawQueue();
  drawVendors();
  drawRecent();
}

function qtyRow(i, it) {
  var q = div('qty');
  q.appendChild(div('lbl', '받은 수량'));
  var minus = document.createElement('button');
  minus.className = 'step'; minus.textContent = '−'; minus.setAttribute('aria-label', '수량 하나 빼기');
  var plus = document.createElement('button');
  plus.className = 'step'; plus.textContent = '+'; plus.setAttribute('aria-label', '수량 하나 더하기');
  minus.onclick = function (e) { e.stopPropagation(); stepQty(i, -1); };
  plus.onclick = function (e) { e.stopPropagation(); stepQty(i, 1); };
  var val = div('val', (it.qty || it.c || 1) + '개');
  if (it.c) val.appendChild(div('of', '도면 ' + it.c + '개' + (it.left && Number(it.left) < Number(it.c) ? ' · 남은 ' + it.left + '개' : '')));
  q.appendChild(minus); q.appendChild(val); q.appendChild(plus);
  q.onclick = function (e) { e.stopPropagation(); };
  return q;
}

function stepQty(i, d) {
  var it = st.items[i];
  if (!it) return;
  var max = Number(it.c || 0);
  var n = Number(it.qty || it.c || 1) + d;
  if (n < 1) n = 1;
  if (max && n > max) { n = max; toast('도면 수량이 ' + max + '개예요'); }
  it.qty = String(n);
  saveItems(); draw();
}

/** 카메라 위: 몇 장 찍었는지, 방금 찍은 것. 목록이 생기면 카메라를 줄여 목록이 바로 보이게 */
function drawCam() {
  var n = st.items.length;
  el('cambox').classList.toggle('small', n > 0);
  show('hint', n === 0);
  show('camcount', n > 0 && !!stream);
  el('camon').textContent = n ? '📷 카메라 켜고 이어서 찍기 (' + n + '장 찍음)' : '📷 카메라 켜고 QR 찍기';
  if (!n) return;
  var it = st.items[0];
  el('camn').textContent = n + '장 찍음';
  el('camlast').textContent = '방금: ' + (it.whole ? it.v + ' 전부' : it.d) +
      (it.n ? ' · ' + it.n : it.loading ? ' · 불러오는 중…' : '') + (it.dup ? '  ⚠ 오늘 이미 저장' : '');
}

function drawQueue() {
  var n = st.queue.reduce(function (s, b) { return s + b.recs.length; }, 0);
  show('queue', n > 0);
  el('queue').textContent = '보내지 못한 ' + n + '장이 폰에 있어요 — 신호가 잡히면 저절로 보냅니다.';
}

function drawVendors() {
  var sel = el('vendor');
  var works = {};
  st.items.forEach(function (it) { if (it.work) works[it.work] = true; });
  var list = st.vendors.slice().sort(function (a, b) {
    var ma = Object.keys(works).some(function (w) { return (a.k || '').indexOf(w) >= 0; }) ? 0 : 1;
    var mb = Object.keys(works).some(function (w) { return (b.k || '').indexOf(w) >= 0; }) ? 0 : 1;
    return ma - mb || a.n.localeCompare(b.n, 'ko');
  });
  var names = list.map(function (v) { return v.n; });
  if (st.vendor && names.indexOf(st.vendor) < 0) names.unshift(st.vendor);
  var html = ['<option value="">(업체 모름)</option>'];
  names.forEach(function (n) {
    var v = list.filter(function (x) { return x.n === n; })[0];
    html.push('<option value="' + esc(n) + '">' + esc(n) + (v && v.k ? '  — ' + esc(v.k) : '') + '</option>');
  });
  html.push('<option value="' + NEW_VENDOR + '">＋ 새 업체 직접 입력</option>');
  sel.innerHTML = html.join('');
  sel.value = st.vendor || NO_VENDOR;
}

function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }

function setVendor(v) { st.vendor = v; put('vendor', v); }

var tt;
function toast(text, kind) {
  var t = el('toast');
  t.textContent = text;
  t.className = 'toast ' + (kind || '');
  clearTimeout(tt);
  tt = setTimeout(function () { t.className = 'toast hide'; }, kind === 'err' ? 5000 : 2200);
}

// 한 장 고치기
var editing = -1;
function openSheet(i) {
  var it = st.items[i];
  editing = i;
  el('sh_title').textContent = it.whole ? it.v + ' 전부' : it.d;
  el('sh_sub').textContent = [it.n, it.c ? '수량 ' + it.c + '개' : '', it.k ? '공정: ' + it.k.split(',').join(' → ') : ''].filter(Boolean).join(' · ');
  var works = routeOf(it).concat(FIX, POST_WORKS);
  works = works.filter(function (w, j) { return works.indexOf(w) === j; });
  el('sh_work').innerHTML = '<option value="">(공정 모름)</option>' + works.map(function (w) { return '<option>' + esc(w) + '</option>'; }).join('');
  el('sh_work').value = it.work || '';
  el('sh_kind').value = it.kind || '들어옴';
  el('sh_qty').value = it.qty || it.c || 1;
  el('sh_memo').value = it.memo || '';
  ['sh_work', 'sh_kind'].forEach(function (id) { el(id).disabled = !!it.whole; });
  show('sheet', true);
}

function closeSheet(ok) {
  if (ok && editing >= 0) {
    var it = st.items[editing];
    if (!it.whole) { it.work = el('sh_work').value; it.kind = el('sh_kind').value; }
    it.qty = el('sh_qty').value;
    it.memo = el('sh_memo').value.trim();
    it.offline = false; it.err = '';
    saveItems(); draw();
  }
  editing = -1;
  show('sheet', false);
}

// ---------------------------------------------------------------------------
// 저장: 확인 화면 → 한꺼번에 · 못 보낸 것 다시 보내기 · 되돌리기
// ---------------------------------------------------------------------------

function toRec(it) {
  var need = Number(it.c || 1), q = Number(it.qty);
  var partial = it.kind === '들어옴' && !it.whole && it.qty !== '' && (it.c ? q < need : q > 1);
  return {id: it.id, t: it.t, v: it.whole ? it.v : st.vendor, p: it.p, d: it.whole ? '' : it.d, memo: it.memo,
          w: it.whole ? '' : it.work, k: it.whole ? '' : it.kind, q: partial ? String(it.qty) : ''};
}

function askSave() {
  var take = st.items.filter(saveable);
  if (!take.length) return;
  if (st.items.some(function (it) { return it.loading; })) { toast('아직 정보를 불러오는 중이에요. 잠시만요'); return; }
  el('cf_sub').textContent = '업체: ' + (st.vendor || '(업체 모름)') + ' · ' + take.length + '장';
  var box = el('cf_list');
  box.innerHTML = '';
  if (!st.vendor && take.some(function (it) { return !it.whole; })) box.appendChild(div('dupwarn', '⚠ 업체를 안 골랐어요'));
  take.forEach(function (it) {
    var r = div('cfrow' + (it.dup ? ' dup' : ''));
    r.appendChild(div('no', (it.whole ? it.v + ' 전부' : it.d) + (it.n ? '  ' + it.n : '')));
    r.appendChild(div('what', actText(it) + (qtyText(it) ? ' · ' + qtyText(it) : '') + (it.memo ? ' · ' + it.memo : '')));
    if (it.dup) r.appendChild(div('dupwarn', '⚠ ' + dupText(it)));
    var w = warnOf(it);
    if (w) r.appendChild(div('warn', w));
    box.appendChild(r);
  });
  var skip = st.items.length - take.length;
  if (skip) box.appendChild(div('warn', '모든 공정이 끝난 ' + skip + '장은 저장하지 않아요'));
  show('confirm', true);
}

function doSave() {
  show('confirm', false);
  var take = st.items.filter(saveable);
  if (!take.length || st.items.some(function (it) { return it.loading; })) return;
  var batch = {id: uid(), recs: take.map(toRec)};
  st.queue.push(batch); put('queue', st.queue);
  var now = new Date();
  st.done.unshift({id: batch.id, at: now.getTime(), day: today(), hhmm: hhmm(now), vendor: st.vendor,
                   items: take, status: 'wait'});
  putDone();
  st.items = []; saveItems(); draw();
  window.scrollTo(0, 0);
  flush(true);
}

var flushing = false;
function flush(loud) {
  if (flushing || !st.queue.length || !st.pin) return Promise.resolve();
  flushing = true;
  var batch = st.queue[0];
  drawRecent();
  return call('save', {recs: batch.recs}).then(function (r) {
    st.queue.shift(); put('queue', st.queue);
    st.done.forEach(function (b) { if (b.id === batch.id) b.status = 'ok'; });
    putDone();
    if (loud) toast(batch.recs.length + '장 저장했어요 ✔', 'ok');
    flushing = false; drawQueue(); drawRecent();
    if (st.queue.length) return flush(loud);
  }, function (e) {
    flushing = false; drawQueue(); drawRecent();
    if (e.server) {
      toast('저장 못 함: ' + e.message, 'err');
      if (/비밀번호/.test(e.message)) logout(e.message);
    } else if (loud) {
      toast('신호가 없어 폰에 담아 두었어요. 신호가 잡히면 저절로 보냅니다.', 'err');
    }
  });
}

/** 방금 저장한 것 + 되돌리기 */
var undoArm = 0, undoBusy = false;
function drawRecent() {
  var b = st.done[0];
  show('recent', !!(b && !b.hidden));
  if (!b || b.hidden) return;
  var inQueue = st.queue.some(function (q) { return q.id === b.id; });
  var sending = inQueue && flushing && st.queue[0].id === b.id;
  el('rc_title').textContent = '방금 저장한 것 (' + b.hhmm + ', ' + b.items.length + '장)';
  el('rc_state').textContent = b.status === 'undone' ? '되돌렸어요 — 위 목록에 다시 넣어 두었어요. 고친 뒤 다시 저장하세요.'
      : sending ? '보내는 중…' : inQueue ? '신호가 없어 폰에 담아 두었어요 — 신호가 잡히면 저절로 보내요'
      : '저장됨 ✔' + (b.vendor ? ' · ' + b.vendor : '');
  el('rc_state').className = 'state ' + (b.status === 'undone' ? 'undone' : inQueue ? 'wait' : 'ok');
  var box = el('rc_list');
  box.innerHTML = '';
  b.items.forEach(function (it) {
    box.appendChild(div('rcrow', (it.whole ? it.v + ' 전부' : it.d) + (it.n ? ' · ' + it.n : '') + ' — ' + actText(it)
        + (qtyText(it) ? ' ' + qtyText(it) : '')));
  });
  var left = UNDO_MIN * 60000 - (Date.now() - b.at);
  var can = b.status !== 'undone' && left > 0;
  show('rc_undo', can);
  el('rc_undo').disabled = sending || undoBusy;
  el('rc_undo').textContent = undoBusy ? '되돌리는 중…' : Date.now() < undoArm ? '정말 되돌릴까요? 한 번 더 누르세요' : '되돌리기 (저장 취소)';
  el('rc_undo').classList.toggle('armed', Date.now() < undoArm);
  el('rc_note').textContent = can ? '잘못 저장했으면 ' + Math.ceil(left / 60000) + '분 안에 되돌릴 수 있어요'
      : b.status === 'undone' ? '' : '되돌릴 수 있는 시간(' + UNDO_MIN + '분)이 지났어요. 고칠 게 있으면 사무실에 말해 주세요';
}

function undo() {
  var b = st.done[0];
  if (!b || b.status === 'undone' || undoBusy) return;
  if (Date.now() >= undoArm) {   // 한 번 눌러 확인, 4초 안에 한 번 더
    undoArm = Date.now() + 4000;
    drawRecent();
    setTimeout(drawRecent, 4100);
    return;
  }
  undoArm = 0;
  var qi = -1;
  st.queue.forEach(function (q, i) { if (q.id === b.id) qi = i; });
  if (qi >= 0) {
    if (flushing && qi === 0) { toast('지금 보내는 중이에요. 잠시 뒤 다시 눌러 주세요'); drawRecent(); return; }
    st.queue.splice(qi, 1); put('queue', st.queue);   // 아직 안 보낸 것: 폰에서만 지움
    undone(b, b.items.length);
    return;
  }
  undoBusy = true; drawRecent();
  call('undo', {ids: b.items.map(function (it) { return it.id; })}).then(function (r) {
    undoBusy = false;
    undone(b, r.removed);
  }, function (e) {
    undoBusy = false; drawRecent();
    toast('되돌리지 못했어요: ' + e.message + (e.net ? ' — 신호가 잡히면 다시 눌러 주세요' : ''), 'err');
  });
}

function undone(b, n) {
  b.status = 'undone'; putDone();
  var have = {};
  st.items.forEach(function (it) { have[it.key] = true; });
  b.items.slice().reverse().forEach(function (it) {
    if (have[it.key]) return;
    var c = Object.assign({}, it, {id: uid()});   // 다시 저장할 때는 새 기록번호
    st.items.unshift(c);
  });
  saveItems(); draw();
  toast(n === b.items.length ? '되돌렸어요. 목록에서 고친 뒤 다시 저장하세요'
      : '기록에서 ' + (n || 0) + '장만 찾아 지웠어요 (' + b.items.length + '장 중). 목록에 다시 넣어 두었어요', n === b.items.length ? 'ok' : 'err');
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// 카메라 · QR 읽기 (안드로이드 크롬은 BarcodeDetector, 아이폰은 jsQR)
// ---------------------------------------------------------------------------

var stream = null, detector = null, lastText = '', lastAt = 0, audio = null, camWanted = false, wake = null;

function beep(warn) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    [0, warn ? 0.2 : -1].forEach(function (at) {
      if (at < 0) return;
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = warn ? 700 : 1500; g.gain.value = 0.25;
      o.connect(g); g.connect(audio.destination);
      o.start(audio.currentTime + at); o.stop(audio.currentTime + at + 0.12);
    });
  } catch (e) { /* 소리 없음 */ }
  if (navigator.vibrate) navigator.vibrate(warn ? [120, 80, 120] : 120);
  var f = el('flash'); f.classList.toggle('warn', !!warn); f.classList.add('on');
  setTimeout(function () { f.classList.remove('on'); }, 120);
}

function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise(function (ok, bad) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    s.onload = ok; s.onerror = function () { bad(new Error('QR 읽기 도구를 못 불러옴 (처음 한 번은 인터넷 필요)')); };
    document.head.appendChild(s);
  });
}

function keepAwake() {   // 찍는 동안 화면이 꺼지지 않게 (꺼지면 카메라가 멈춤)
  try {
    if (navigator.wakeLock && !wake) navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }, function () {});
  } catch (e) { /* 지원 안 함 */ }
}

function startCamera(auto) {
  if (stream) return;
  if (!auto) beep(); // 소리 켜기 (아이폰은 누를 때만 소리를 켤 수 있음)
  camWanted = true;
  var ready = ('BarcodeDetector' in window)
      ? BarcodeDetector.getSupportedFormats().then(function (f) {
          if (f.indexOf('qr_code') >= 0) detector = new BarcodeDetector({formats: ['qr_code']});
          else return loadJsQR();
        }, loadJsQR)
      : loadJsQR();
  ready.then(function () {
    return navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment', width: {ideal: 1280}, height: {ideal: 960}}, audio: false});
  }).then(function (s) {
    stream = s;
    var v = el('video');
    v.srcObject = s;
    return v.play();
  }).then(function () {
    show('camon', false);
    keepAwake();
    drawCam();
    scanLoop();
  }).catch(function (e) {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (!auto) toast('카메라를 켜지 못했어요: ' + (e.name === 'NotAllowedError' ? '카메라 허용을 눌러 주세요' : e.message), 'err');
  });
}

function stopCamera(keep) {
  if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  stream = null;
  if (!keep) camWanted = false;
  if (wake) { try { wake.release(); } catch (e) { /* 이미 풀림 */ } wake = null; }
  show('camon', true);
  drawCam();
}

function found(text) {
  var now = Date.now();
  if (text === lastText && now - lastAt < 2500) return;
  lastText = text; lastAt = now;
  var q = parseQR(text);
  if (!q) { toast('입고 QR이 아니에요'); return; }
  if (addFromQR(q, false)) beep(!!st.items[0].dup);
}

function scanLoop() {
  if (!stream) return;
  var v = el('video');
  if (v.readyState < 2) { setTimeout(scanLoop, 150); return; }
  if (detector) {
    detector.detect(v).then(function (codes) {
      if (codes.length) found(codes[0].rawValue);
      setTimeout(scanLoop, 120);
    }, function () { setTimeout(scanLoop, 300); });
    return;
  }
  var c = el('canvas'), w = v.videoWidth, h = v.videoHeight;
  var s = Math.min(1, 800 / Math.max(w, h));
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  var ctx = c.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(v, 0, 0, c.width, c.height);
  var img = ctx.getImageData(0, 0, c.width, c.height);
  var code = window.jsQR(img.data, c.width, c.height, {inversionAttempts: 'dontInvert'});
  if (code && code.data) found(code.data);
  setTimeout(scanLoop, 150);
}

// ---------------------------------------------------------------------------
// 처음 설정 · 시작
// ---------------------------------------------------------------------------

function drawNames() {
  var sel = el('name');
  sel.innerHTML = st.names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('')
      + '<option value="__me__">목록에 없음 (직접 적기)</option>';
  if (st.who && st.names.indexOf(st.who) >= 0) sel.value = st.who;
  else if (st.who) { sel.value = '__me__'; el('name2').value = st.who; }
  show('name2', sel.value === '__me__');
}

function hello() {
  return call('hello').then(function (r) {
    st.names = r.names || []; put('names', st.names);
    st.vendors = r.vendors || []; put('vendors', st.vendors);
    drawNames(); drawVendors();
    return r;
  });
}

function logout(why) {
  stopCamera();
  st.pin = ''; put('pin', '');
  show('main', false); show('savebar', false); show('login', true);
  if (window.dashLeave) dashLeave(true);
  el('loginmsg').textContent = why || '';
  el('who').textContent = '';
  pinOk = false;
  show('namebox', false);
  el('loginbtn').textContent = '다음';
  el('pin').value = '';
}

var pinOk = false;
function login() {
  if (!pinOk) {   // 1) 비밀번호 확인 → 직원 이름 목록을 받음
    var pin = el('pin').value.trim();
    if (!pin) { el('loginmsg').textContent = '비밀번호를 넣어 주세요'; return; }
    el('loginbtn').disabled = true;
    el('loginmsg').textContent = '확인 중…';
    st.pin = pin;
    hello().then(function () {
      pinOk = true;
      el('loginbtn').disabled = false;
      el('loginmsg').textContent = '';
      show('namebox', true);
      el('loginbtn').textContent = '시작하기';
    }, function (e) {
      st.pin = '';
      el('loginbtn').disabled = false;
      el('loginmsg').textContent = e.message;
    });
    return;
  }
  var who = el('name').value === '__me__' ? el('name2').value.trim() : el('name').value;   // 2) 이름
  if (!who) { el('loginmsg').textContent = '이름을 골라 주세요'; return; }
  st.who = who; put('who', who); put('pin', st.pin);
  enter();
}

function enter() {
  show('login', false); show('today', false); show('main', true);
  if (window.dashLeave) dashLeave(false);   // 위 [입고]·[현황] 단추 (dash.js)
  el('who').textContent = st.who;
  draw();
  st.items.forEach(function (it) { if (it.d && (it.loading || it.offline)) { it.loading = true; lookup(it); } });
  flush(false);
}

function showToday() {
  stopCamera();
  show('main', false); show('savebar', false); show('today', true);
  if (window.dashLeave) dashLeave(false, true);
  el('todaylist').textContent = '불러오는 중…';
  call('today').then(function (rows) {
    el('todaylist').innerHTML = rows.length ? '' : '오늘 저장한 것이 없어요';
    rows.forEach(function (r) {
      var d = document.createElement('div');
      d.textContent = r.t + '  ' + r.d + '  ' + (r.k === '불량' ? '불량' : ((r.w || '') + ' ' + (r.k || '들어옴')))
          + (r.q ? ' (' + r.q + '개)' : '') + (r.v ? ' · ' + r.v : '') + (r.who ? ' · ' + r.who : '');
      el('todaylist').appendChild(d);
    });
  }, function (e) { el('todaylist').textContent = '불러오지 못함: ' + e.message; });
}

function addVendor() {
  var name = el('vendorname').value.trim();
  if (!name) return;
  var works = st.items.map(function (it) { return it.work; }).filter(Boolean);
  setVendor(name);
  el('vendorname').value = '';
  show('newvendor', false);
  if (!st.vendors.some(function (v) { return v.n === name; })) st.vendors.push({n: name, k: works[0] || ''});
  put('vendors', st.vendors); drawVendors();
  call('vendor', {name: name, proc: works[0] || ''}).then(function (r) {
    st.vendors = r.vendors || st.vendors; put('vendors', st.vendors); drawVendors();
    toast(name + ' 등록했어요. 다음부터 목록에서 고르면 돼요', 'ok');
  }, function (e) { toast('업체 등록 못 함(이번 저장에는 들어감): ' + e.message, 'err'); });
}

function init() {
  el('ver').textContent = '버전 ' + VERSION;
  el('loginbtn').onclick = login;
  el('name').onchange = function () { show('name2', el('name').value === '__me__'); };
  el('camon').onclick = function () { startCamera(false); };
  el('save').onclick = askSave;
  el('cf_ok').onclick = doSave;
  el('cf_back').onclick = function () { show('confirm', false); };
  el('confirm').onclick = function (e) { if (e.target === el('confirm')) show('confirm', false); };
  el('rc_undo').onclick = undo;
  el('rc_close').onclick = function () { if (st.done[0]) { st.done[0].hidden = true; putDone(); } drawRecent(); };
  el('vendor').onchange = function () {
    var v = el('vendor').value;
    if (v === NEW_VENDOR) { show('newvendor', true); el('vendorname').focus(); return; }
    show('newvendor', false);
    setVendor(v);
  };
  el('vendoradd').onclick = addVendor;
  el('manualadd').onclick = function () {
    var q = parseQR(el('manual').value);
    if (!q) { toast('도번을 확인해 주세요'); return; }
    if (addFromQR(q, false)) el('manual').value = '';
  };
  el('sh_ok').onclick = function () { closeSheet(true); };
  el('sh_del').onclick = function () {
    if (editing >= 0) { st.items.splice(editing, 1); saveItems(); draw(); }
    closeSheet(false);
  };
  el('sheet').onclick = function (e) { if (e.target === el('sheet')) closeSheet(false); };
  el('todaylink').onclick = function (e) { e.preventDefault(); showToday(); };
  el('todayback').onclick = enter;
  el('logout').onclick = function (e) { e.preventDefault(); logout(''); };
  window.addEventListener('online', function () { flush(true); });
  setInterval(function () { flush(false); }, 30000);
  setInterval(drawRecent, 20000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopCamera(true); return; }
    flush(false);
    // 화면이 잠깐 꺼졌다 켜지면 찍던 카메라를 다시 켬
    if (camWanted && st.pin && !el('main').classList.contains('hide')) startCamera(true);
  });

  // 예전 QR·입고 앱 주소로 열린 경우 (?d=도번 …): 그 도면을 목록에 넣음
  var q = parseQR(location.href);
  if (q) history.replaceState(null, '', location.pathname);

  if (!st.pin) logout('');
  else { enter(); hello().catch(function () {}); }
  if (q) addFromQR(q, true);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
}

init();
