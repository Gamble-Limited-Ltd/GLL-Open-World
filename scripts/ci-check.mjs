// Plain Node 20, no dependencies. Run: node scripts/ci-check.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(root, f), 'utf8');
let failed = false;
const say = (s, name, msg) => { console.log(`${s}: ${name} - ${msg}`); if (s === 'FAIL') failed = true; };

// 1. game.html is a copy of openworld.html
if (!existsSync(join(root, 'game.html'))) say('PASS', 'game-copy', 'game.html missing, skipped');
else say(readFileSync(join(root, 'game.html')).equals(readFileSync(join(root, 'openworld.html'))) ? 'PASS' : 'FAIL',
  'game-copy', 'game.html vs openworld.html byte comparison');

// 2. inline scripts parse
const tmp = mkdtempSync(join(tmpdir(), 'ci-'));
for (const f of ['openworld.html', 'index.html']) {
  let n = 0, bad = 0;
  for (const m of rd(f).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^\s"'>]+)/i.exec(attrs) || [])[1] || '';
    if (type && type !== 'module' && !/javascript/i.test(type)) continue;
    n++;
    const p = join(tmp, `s${n}.mjs`); // .mjs for all: classic scripts without import/export also parse as modules
    writeFileSync(p, m[2]);
    try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
    catch (e) { bad++; console.log(String(e.stderr).split('\n').slice(0, 4).join('\n')); }
  }
  say(bad ? 'FAIL' : 'PASS', 'script-syntax', `${f}: ${n} inline scripts, ${bad} failed`);
}

// 3. secrets in tracked files
const pats = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /sb_secret/, /service_role/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/];
let hits = [];
let files = [];
try { files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean); } catch { say('WARN', 'secrets', 'not a git checkout'); }
for (const f of files) {
  let b; try { b = readFileSync(join(root, f)); } catch { continue; }
  if (b.includes(0)) continue; // binary
  const t = b.toString('utf8');
  for (const p of pats) if (p.test(t)) hits.push(`${f} (${p.source.slice(0, 20)})`);
}
if (files.length) say(hits.length ? 'FAIL' : 'PASS', 'secrets', hits.length ? hits.join(', ') : `${files.length} tracked files scanned`);

// 4. local references exist
for (const f of ['index.html', 'openworld.html']) {
  const missing = new Set();
  for (const m of rd(f).matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const u = m[1].trim();
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(u)) continue;
    const p = u.split(/[?#]/)[0];
    if (p && !existsSync(join(root, p))) missing.add(u);
  }
  say(missing.size ? 'FAIL' : 'PASS', 'local-refs', `${f}: ${missing.size ? 'missing ' + [...missing].join(', ') : 'all exist'}`);
}

// 5. version consistency
const iv = (/class="pill">\s*(v2\.\d+)/.exec(rd('index.html')) || [])[1];
const ov = (/<title>[^<]*?(v2\.\d+)/.exec(rd('openworld.html')) || [])[1];
let jv; try { jv = JSON.parse(rd('version.json')).version; } catch {}
console.log(`  index.html=${iv} openworld.html title=${ov} version.json=${jv}`);
say(iv && ov && iv === ov ? 'PASS' : 'FAIL', 'version', iv && ov ? `index ${iv} vs title ${ov}` : 'version string not found');

process.exit(failed ? 1 : 0);
