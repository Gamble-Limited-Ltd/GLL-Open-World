// ====================================================================
// js/systems/economy.js — the money core (Stage 5): spend(),
// earn(), uiBalance(). Every price flows through here.
// ====================================================================
import { fmt$, fmtK } from '../util.js';
import { STATE } from '../state.js';

export function spend(n) { if (STATE.money < n) return false; STATE.money -= n; uiBalance(); return true; }
export function earn(n, countGDP = true) { STATE.money += n; if (countGDP) STATE.gdp += Math.max(0, n); uiBalance(); }
export function uiBalance() {
  const b = document.querySelector('#balance .b');
  if (b) b.textContent = fmt$(STATE.money);
  const g = document.getElementById('gdpv');
  if (g) g.textContent = fmtK(STATE.gdp);
}
