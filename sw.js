/* 오프라인에서도 앱 화면이 뜨게: 앱 파일과 QR 읽기 도구를 폰에 담아 둔다.
 * 앱 파일은 인터넷이 되면 새것을 받아 두고(다음 실행 때 반영), 안 되면 담아 둔 것을 쓴다. 서버 요청(POST)은 건드리지 않음. */
var CACHE = 'ipgo-v4';
var FILES = ['./', 'index.html', 'app.css', 'app.js', 'dash.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
             'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (f) { return c.add(f).catch(function () {}); }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var mine = url.origin === self.location.origin || url.href.indexOf('cdn.jsdelivr.net/npm/jsqr') >= 0;
  if (!mine) return;
  var key = url.origin === self.location.origin && url.search ? new Request(url.origin + url.pathname) : req;  // ?d=… 로 열어도 같은 화면
  e.respondWith(caches.open(CACHE).then(function (c) {
    return fetch(req).then(function (r) {
      if (r && r.ok) c.put(key, r.clone());
      return r;
    }).catch(function () {
      return c.match(key).then(function (hit) { return hit || c.match('index.html'); });
    });
  }));
});
