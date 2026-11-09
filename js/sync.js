// ====================================================================
// js/sync.js: account saves on the hosted site.
// The game still saves to localStorage exactly as before (save.js). On a host that
// serves /api (the hosted site) this module also keeps a copy on the server under the
// player's GLL ID: it loads that copy before the game boots and uploads after saves.
// Anywhere else (GitHub Pages, local files) /api/me is not JSON, so nothing here runs.
// Relative URLs only. The server only needs the save to be a JSON object with a numeric ts.
// ====================================================================
import { SAVE_KEY } from './config.js';

const META = 'openworld-sync';          // { user, rev, dirty }: which account the local copy belongs to
const H = { 'content-type': 'application/json', 'x-ow': '1' };
let FLUSH_MS = 15000;
let hosted = false, stopped = false, user = '', rev = 0;
let timer = 0, busy = false, seq = 0, listening = false;

export const isHosted = () => hosted;
export const __test = { setFlushMs: (n) => { FLUSH_MS = n; } };

const meta = () => { try { return JSON.parse(localStorage.getItem(META) || '{}'); } catch { return {}; } };
const setMeta = (m) => { try { localStorage.setItem(META, JSON.stringify(m)); } catch { /* quota: the next save retries */ } };
const tsOf = (raw) => { try { return +JSON.parse(raw).ts || 0; } catch { return 0; } };
const api = (path, o) => fetch('api/' + path, { credentials: 'same-origin', ...o });

function box(html, id) {
  const d = document.createElement('div');
  d.id = id;
  d.style.cssText = 'position:fixed;z-index:99999;left:0;right:0;top:0;padding:10px 14px;background:#1F2937;color:#F9FAFB;font:14px system-ui,sans-serif;text-align:center;border-bottom:1px solid #4A5568';
  d.innerHTML = html;
  document.body.appendChild(d);
  return d;
}
const banner = (msg) => {
  const d = box(`${msg} <button style="margin-left:8px">Reload</button>`, 'ow-sync-banner');
  if (d.querySelector) d.querySelector('button').onclick = () => location.reload();
};

function signInScreen() {
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  const d = box('', 'ow-signin');
  d.style.cssText = 'position:fixed;z-index:99999;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0B1220;color:#F9FAFB;font:16px system-ui,sans-serif;text-align:center;padding:24px';
  d.innerHTML = '<div style="font-size:28px;letter-spacing:.2em">OPEN WORLD</div><div style="max-width:420px;color:#9CA3AF">Sign in with your GLL ID to play. Your world is saved to your account, so it follows you to any device.</div><a href="api/auth/gate/login" style="background:#2563EB;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign in with GLL ID</a>';
}

// Awaited once at boot, before loadGame(). Resolves when the game may start; never resolves while signed out.
export async function hydrate() {
  hosted = false; stopped = false; user = ''; rev = 0; busy = false; seq = 0; clearTimeout(timer); timer = 0;
  let r;
  try { r = await api('me'); } catch { return; }
  if (!(r.headers.get('content-type') || '').includes('json')) return;      // not the hosted site
  hosted = true;
  if (r.status === 401) { signInScreen(); return new Promise(() => {}); }
  if (!r.ok) return;
  user = (await r.json()).name;
  const s = await (await api('save')).json();
  const local = localStorage.getItem(SAVE_KEY), m = meta();
  const mine = m.user === user;

  if (s.data) {
    const keepLocal = mine && m.dirty && local && tsOf(local) > (+s.data.ts || 0);   // unsynced progress made on this device
    rev = s.rev;
    if (keepLocal) { setMeta({ user, rev, dirty: true }); schedule(); }
    else {
      const body = JSON.stringify(s.data);
      if (local && local !== body) localStorage.setItem(SAVE_KEY + '-backup', local);  // never silently drop a different local world
      localStorage.setItem(SAVE_KEY, body);
      setMeta({ user, rev, dirty: false });
    }
  } else if (local) {
    const ok = confirm('Found a world saved in this browser. OK moves it to your GLL ID account. Cancel starts a new world (the browser copy is kept as a backup).');
    if (ok) {
      const i = await api('save/import', { method: 'POST', headers: H, body: JSON.stringify({ data: JSON.parse(local) }) });
      if (i.ok) rev = (await i.json()).rev;
      setMeta({ user, rev, dirty: !i.ok });
    } else {
      localStorage.setItem(SAVE_KEY + '-backup', local);
      localStorage.removeItem(SAVE_KEY);
      setMeta({ user, rev: 0, dirty: false });
    }
  } else setMeta({ user, rev: 0, dirty: false });

  if (!listening && typeof addEventListener === 'function') {
    listening = true;
    // best effort on tab close: browsers cap keepalive bodies near 64 KB, so a big save may not go; the dirty flag covers the next visit
    addEventListener('pagehide', () => { if (hosted && !stopped && meta().dirty) flush(true); });
  }
}

// Called by saveGame() right after it writes localStorage.
export function onSaved() {
  if (!hosted || stopped) return;
  seq++;
  setMeta({ user, rev, dirty: true });
  schedule();
}
const schedule = () => { if (!timer) timer = setTimeout(() => flush(), FLUSH_MS); };

async function flush(keepalive = false) {
  clearTimeout(timer); timer = 0;
  if (busy) { schedule(); return; }
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw || stopped) return;
  busy = true;
  const mark = seq;
  try {
    const r = await api('save', { method: 'PUT', headers: H, keepalive, body: JSON.stringify({ rev, data: JSON.parse(raw) }) });
    if (r.ok) {
      rev = (await r.json()).rev;
      setMeta({ user, rev, dirty: seq !== mark });
      if (seq !== mark) schedule();
    } else if (r.status === 401) {
      stopped = true; banner('Your session ended. Reload to sign in again.');
    } else if (r.status === 409) {
      const cur = await (await api('save')).json();
      if (cur.data && (+cur.data.ts || 0) > tsOf(raw)) {          // another device saved later: do not overwrite it
        stopped = true; banner('This world was saved on another device. Reload to continue from it.');
      } else { rev = cur.rev; schedule(); }                        // ours is newer: retry on the new revision
    } else schedule();
  } catch { if (!keepalive) schedule(); }                          // offline: try again later; local copy is safe
  finally { busy = false; }
}

// NEW GAME. Returns false (and keeps everything) if the server copy could not be deleted.
export async function resetSave() {
  if (hosted) {
    try { if (!(await api('save', { method: 'DELETE', headers: H })).ok) throw 0; }
    catch { (globalThis.alert || console.log)('Could not reach the server to delete your world. Try again.'); return false; }
    rev = 0;
  }
  localStorage.removeItem(SAVE_KEY);
  try { localStorage.removeItem(META); } catch { /* ignore */ }
  return true;
}

export async function signOut() {
  try { await api('auth/logout', { method: 'POST', headers: H }); } catch { /* ignore */ }
  location.reload();
}

// Boot screen: who is signed in, and the save line.
export function showAccount() {
  if (!hosted) return;
  const fine = document.querySelector('#boot .fine span');
  if (fine) fine.textContent = fine.textContent.replace('saves locally in this browser', 'saves to your GLL ID account and follows you to any device');
  const card = document.querySelector('#boot .card');
  if (!card) return;
  const d = document.createElement('div');
  d.style.cssText = 'margin-top:10px;font-size:13px;color:#9CA3AF';
  d.textContent = `Signed in as ${user} · `;
  const a = document.createElement('a');
  a.href = '#'; a.textContent = 'Sign out'; a.style.color = '#7DD3FC';
  a.onclick = (e) => { e.preventDefault(); signOut(); };
  d.appendChild(a);
  card.appendChild(d);
}
