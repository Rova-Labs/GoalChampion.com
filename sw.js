/* Champion Goal — Service Worker
   Daily study reminders that keep working while the page is closed.
   Strategy (honest, browser-only):
     1) In-memory timer while SW is alive (recent browser activity)
     2) IndexedDB persistence so SW restarts never lose the target time
     3) Periodic Background Sync (Chrome/Edge, installed PWA) wakes the SW
        even after it was killed, so reminders fire near the target hour   */
'use strict';

const CG_CACHE = 'champ-goal-v1';
const CG_CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './favicon.png'];
const CG_DB = 'champ-goal-db';
const CG_STORE = 'kv';

let cgTarget = null;   // 'HH:MM'
let cgOn = false;
let cgLastFire = '';   // 'YYYY-MM-DD'
let cgTimer = null;

/* ---------- tiny promise IndexedDB ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(CG_DB, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore(CG_STORE); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(CG_STORE, 'readwrite');
      tx.objectStore(CG_STORE).put(val, key);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  } catch (e) { /* storage blocked — keep memory only */ }
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(CG_STORE, 'readonly');
      const rq = tx.objectStore(CG_STORE).get(key);
      rq.onsuccess = () => { db.close(); res(rq.result); };
      rq.onerror = () => { db.close(); rej(rq.error); };
    });
  } catch (e) { return undefined; }
}

/* ---------- lifecycle ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CG_CACHE);
      try { await c.addAll(CG_CORE); } catch (err) { /* offline best-effort */ }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CG_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      await cgRestore();
      cgStartTimer();
    })()
  );
});

async function cgRestore() {
  const tgt = await idbGet('target');
  const on = await idbGet('on');
  const last = await idbGet('lastFire');
  if (typeof tgt === 'string') cgTarget = tgt;
  if (typeof on === 'boolean') cgOn = on;
  if (typeof last === 'string') cgLastFire = last;
}

/* ---------- fetch: cache-first for core ---------- */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        fetch(e.request).then((r) => {
          if (r && r.ok) caches.open(CG_CACHE).then((c) => c.put(e.request, r.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(e.request).then((r) => {
        if (r && r.ok && new URL(e.request.url).origin === self.location.origin) {
          const cl = r.clone();
          caches.open(CG_CACHE).then((c) => c.put(e.request, cl));
        }
        return r;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

/* ---------- messages from the page ---------- */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'setRemind') {
    cgTarget = typeof d.target === 'string' ? d.target : null;
    cgOn = !!d.on;
    cgLastFire = '';
    idbSet('target', cgTarget);
    idbSet('on', cgOn);
    idbSet('lastFire', cgLastFire);
    cgStartTimer();
  } else if (d.type === 'stopRemind') {
    cgOn = false;
    cgTarget = null;
    idbSet('on', false);
  } else if (d.type === 'ping') {
    if (e.source) e.source.postMessage({ type: 'pong', target: cgTarget, on: cgOn });
  }
});

/* ---------- time logic ---------- */
function cgTodayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function cgNotify() {
  self.registration.showNotification('Champion Goal — وقت المذاكرة!', {
    body: 'البطل لا يؤجل: ادخل الآن وأنجز جلستك الأولى اليوم. سلسلتك بانتظارك!',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'cg-daily',
    renotify: true,
    dir: 'rtl',
    lang: 'ar',
    data: { url: './index.html' }
  });
}

function cgCheck() {
  if (!cgOn || !cgTarget) return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(cgTarget);
  if (!m) return;
  const tgt = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = cgTodayKey();
  if (cgLastFire === today) return;   // already fired today
  if (cur < tgt) return;              // too early
  if (cur >= tgt + 240) return;       // missed the generous 4h window
  cgLastFire = today;
  idbSet('lastFire', cgLastFire);
  cgNotify();
}

function cgStartTimer() {
  if (cgTimer) clearInterval(cgTimer);
  cgTimer = setInterval(cgCheck, 60000);
}

/* ---------- Periodic Background Sync (installed PWA) ----------
   The browser wakes the SW roughly every 12h minimum; when it does,
   we check whether today's reminder is still pending and fire it
   if we are past the target hour (within the window).             */
self.addEventListener('periodicsync', (e) => {
  if (e.tag !== 'cg-daily-remind') return;
  e.waitUntil(
    (async () => {
      await cgRestore();
      cgCheck();
      /* nudge the browser to keep the cadence */
      try {
        await self.registration.periodicSync.register('cg-daily-remind', { minInterval: 12 * 60 * 60 * 1000 });
      } catch (err) { /* permission may have changed */ }
    })()
  );
});

/* ---------- notification click -> open app ---------- */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); return; }
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
