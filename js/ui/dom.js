// ====================================================================
// js/ui/dom.js — shared UI primitives (Stage 5): toast(), the modal
// engine, hover tooltip, banner, loading veil + its 45 s watchdog.
// Pure DOM, no imports. mwrap/tt/bannerEl/veil/veilT0 are private.
// ====================================================================

// ---- toast ----------------------------------------------------------
export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.innerHTML = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .35s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 380); }, 2600);
  while (box.children.length > 4) box.firstChild.remove();
}

// ---- modal engine ---------------------------------------------------
const mwrap = document.getElementById('modalwrap');
export function openModal(title, html) {
  document.getElementById('mtitle').textContent = title;
  document.getElementById('mbody').innerHTML = html;
  mwrap.classList.remove('hidden');
}
export function closeModal() { mwrap.classList.add('hidden'); }
document.getElementById('mclose').addEventListener('click', closeModal);
mwrap.addEventListener('click', e => { if (e.target === mwrap) closeModal(); });

// ---- tooltip engine --------------------------------------------------
const tt = document.getElementById('tooltip');
export function showTooltip(x, y, data) {
  tt.querySelector('.tt-t').textContent = data.t || '';
  tt.querySelector('.tt-s').textContent = data.s || '';
  tt.querySelector('.tt-p').textContent = data.p || '';
  tt.querySelector('.tt-a').textContent = data.a || '';
  tt.querySelector('.tt-l').textContent = data.l || '';
  tt.style.opacity = '1';
  const w = 240, h = tt.offsetHeight || 110;
  tt.style.left = Math.min(window.innerWidth - w - 14, x + 16) + 'px';
  tt.style.top = Math.max(8, Math.min(window.innerHeight - h - 30, y - h - 8)) + 'px';
}
export function hideTooltip() { tt.style.opacity = '0'; }

// ---- banner ----------------------------------------------------------
const bannerEl = document.getElementById('banner');
export function showBanner(html, sub = '') {
  bannerEl.innerHTML = html + (sub ? `<div class="k">${sub}</div>` : '');
  bannerEl.classList.remove('hidden');
}
export function hideBanner() { bannerEl.classList.add('hidden'); }

// ---- veil (loading / transitions) ------------------------------------
const veil = document.getElementById('veil');
export function veilOn(text) {
  document.getElementById('veils').textContent = text;
  veil.classList.add('on');
  veilT0 = Date.now();
}
export function veilOff() { veil.classList.remove('on'); veilT0 = 0; }
// v2.33 VEIL WATCHDOG: any enter/import path that throws or hangs before its
// veilOff() leaves the player staring at a frozen overlay — the world keeps
// rendering behind it but reads as broken ("the world looks terrible").
// The veil now always clears itself after 45 s (with a toast) so the game
// stays playable no matter what stalled.
let veilT0 = 0;
setInterval(() => {
  if (veilT0 && Date.now() - veilT0 > 45000 && veil.classList.contains('on')) {
    veilOff();
    toast('<b>That took too long.</b> The view is back — whatever was loading may still be finishing.', 'warn');
  }
}, 2500);
