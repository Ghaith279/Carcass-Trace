// The Meatrix (Marabina): screens and workflow
import { printLabels } from './labels.js';

const mod = window.CT_TEST_API ? { api: window.CT_TEST_API, configured: true } : await import('./api.js');
const { api, configured } = mod;
const print = (items) => (window.CT_TEST_PRINT || printLabels)(items.map(it => {
  const d = { ...it.data };
  if (it.kind === 'tray') d.product_name_ar = d.product_name_ar ?? state.productsById[d.product_id]?.name_ar;
  else d.species_ar = d.species_ar ?? state.species.find(x => x.name === d.species)?.name_ar;
  return { ...it, data: d };
}), state.settings);

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const kg = (v, d = 2) => num(v).toFixed(d);
const when = t => t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const ymdLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymdLocal(d); };
const showYmd = s => { if (!s) return ''; const [y, m, d] = String(s).split('-'); return `${d}/${m}/${y}`; };
const errText = e => (e && e.message) ? e.message : String(e);
function msg(el, text, kind = 'info') { el.innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : ''; }
function msgHtml(el, html, kind = 'info') { el.innerHTML = `<div class="msg ${kind}">${html}</div>`; }
// "Are you sure?" before a step that is hard to undo. Cancel has the focus, so a stray scan or Enter does nothing.
function ask(title, body = '', ok = 'Yes, go ahead') {
  return new Promise(res => {
    const d = $('askBox');
    $('askTitle').textContent = title; $('askBody').innerHTML = body; $('askOk').textContent = ok;
    d.returnValue = ''; d.onclose = () => res(d.returnValue === 'ok');
    d.showModal(); $('askNo').focus();
  });
}
function onEnter(input, fn) {
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim(); input.value = '';
    if (v) fn(v);
  });
}
const STATUS = {
  in_chiller: ['In chiller', ''], cutting: ['Cutting', 'warn'], finished: ['Finished', ''], sold_whole: ['Sold whole', 'accent'],
  in_stock: ['In stock', 'good'], sold: ['Left shop', ''], written_off: ['Written off', 'bad'], reproduced: ['Reproduced', 'accent'], returned: ['Returned', 'bad']
};
const chip = s => { const v = STATUS[s] || [s, '']; return `<span class="chip ${v[1]}">${esc(v[0])}</span>`; };
function useByChip(ymd) {
  const today = ymdLocal(), soon = addDays(state.settings?.expiry_warning_days ?? 1);
  if (ymd < today) return `<span class="chip bad">${showYmd(ymd)} expired</span>`;
  if (ymd <= soon) return `<span class="chip warn">${showYmd(ymd)}</span>`;
  return `<span class="chip">${showYmd(ymd)}</span>`;
}
const carcassNos = t => (t.carcasses || []).map(c => c.no);
const WASTE = { trimmings: 'Trimmings', fat: 'Fat', bones: 'Bones', intestines: 'Intestines' };
const pct = v => v == null ? '' : num(v).toFixed(1) + '%';
// "22.0 kg received → 15.4 kg packed (70.0%) · 3.1 kg bones · 0.8 kg shrinkage (3.6%)"
function breakdown(y) {
  const parts = [`${kg(y.weight_kg, 1)} kg received → ${kg(y.packed_kg, 1)} kg packed (${pct(y.yield_pct)})`];
  Object.keys(WASTE).forEach(k => { if (num(y[k + '_kg']) > 0) parts.push(`${kg(y[k + '_kg'], 1)} kg ${WASTE[k].toLowerCase()}`); });
  if (y.shrink_kg != null) parts.push(`${kg(y.shrink_kg, 1)} kg shrinkage (${pct(y.shrink_pct)})`);
  return parts.join(' · ');
}

const state = {
  settings: null, products: [], productsById: {}, species: [], butchers: [], me: { id: null, role: 'staff' },
  cut: { active: [], product: null, mode: 'cut', wasteKind: null },
  repro: { items: [], product: null },
  pack: { order: null, items: [] },
  counter: { items: [] }
};

/* ---------------- start, sign in ---------------- */
function show(id) { ['v-config', 'v-login', 'app'].forEach(v => { $(v).hidden = v !== id; }); }

async function start() {
  if (!configured) { show('v-config'); return; }
  const session = await api.session().catch(() => null);
  if (session) await enter(session); else show('v-login');
  if (api.onAuth) api.onAuth(s => { if (!s) { show('v-login'); $('who').hidden = true; } });
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { const r = await api.signIn($('lEmail').value.trim(), $('lPass').value); await enter(r.session); }
  catch (err) { msg($('lMsg'), 'Sign-in failed: ' + errText(err), 'err'); }
});
$('signOut').addEventListener('click', async () => { await api.signOut(); show('v-login'); $('who').hidden = true; });

async function enter(session) {
  show('app');
  $('who').hidden = false; $('whoEmail').textContent = session?.user?.email || '';
  state.settings = await api.settings();
  try { state.me = await api.myRole(); } catch (_) { state.me = { id: null, role: 'staff' }; }
  const isAdmin = state.me.role === 'admin';
  document.body.classList.toggle('is-admin', isAdmin);
  $('whoRole').textContent = isAdmin ? 'Admin' : 'Staff';
  await Promise.all([loadProducts(), loadSpecies(), loadButchers()]);
  let tab = 'dash';
  try { tab = localStorage.getItem('ct_tab') || tab; } catch (_) {}
  showTab(tab);
}
const DEFAULT_SPECIES = ['Naeemi', 'Naeemi Herfy', 'Harri', 'Beef', 'Hashi'].map(name => ({ name, active: true, chiller_days: 5 }));
async function loadSpecies() {
  try { state.species = await api.species(); } catch (_) { state.species = DEFAULT_SPECIES; }
  const active = state.species.filter(s => s.active);
  const keep = $('rSpecies').value;
  $('rSpecies').innerHTML = active.map(s => `<option value="${esc(s.name)}">${esc(s.name)}${s.name_ar ? ' · ' + esc(s.name_ar) : ''}</option>`).join('');
  if (keep && active.some(s => s.name === keep)) $('rSpecies').value = keep;
  const yk = $('ySpecies').value;
  $('ySpecies').innerHTML = '<option value="">All animals</option>' + state.species.map(s => `<option>${esc(s.name)}</option>`).join('');
  $('ySpecies').value = yk;
}
/* butchers: picked once per device on the cutting-room screen */
async function loadButchers() {
  try { state.butchers = await api.butchers(); } catch (_) { state.butchers = []; }
  let saved = ''; try { saved = localStorage.getItem('ct_butcher') || ''; } catch (_) {}
  const active = state.butchers.filter(b => b.active);
  $('cButcher').innerHTML = '<option value="">Choose…</option>' + active.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  $('cButcher').value = active.some(b => b.id === saved) ? saved : '';
  renderButcherBar();
}
function renderButcherBar() {
  const none = !state.butchers.some(b => b.active);
  $('cButcher').closest('.butcher-bar').hidden = none;
  $('cButcher').closest('.butcher-bar').classList.toggle('need', !none && !$('cButcher').value);
  $('cButcherHint').textContent = $('cButcher').value ? 'Units, wastage and finished carcasses are recorded under this name.' : 'Pick your name before printing or recording wastage.';
}
$('cButcher').addEventListener('change', () => { try { localStorage.setItem('ct_butcher', $('cButcher').value); } catch (_) {} renderButcherBar(); });
// Returns the chosen butcher, or throws when butchers are set up but none is picked
function butcherId() {
  if (!state.butchers.some(b => b.active)) return null;
  const id = $('cButcher').value;
  if (!id) { $('cButcher').focus(); throw new Error('Choose the butcher at the top of the cutting room first.'); }
  return id;
}
async function loadProducts() {
  state.products = await api.products();
  state.productsById = Object.fromEntries(state.products.map(p => [p.id, p]));
}

/* ---------------- tabs ---------------- */
const loaders = {};
function showTab(name) {
  if (!$('v-' + name) || (name === 'settings' && state.me.role !== 'admin')) name = 'dash';
  state.tab = name;
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('#app > section').forEach(s => { s.hidden = s.id !== 'v-' + name; });
  try { localStorage.setItem('ct_tab', name); } catch (_) {}
  if (loaders[name]) loaders[name]();
  const focus = { cut: state.cut.mode === 'repro' ? 'xScan' : 'cScan', pack: state.pack.order ? 'pScan' : 'pOrderNo', counter: 'kScan', trace: 'tScan' }[name];
  if (focus) setTimeout(() => $(focus).focus(), 0);
}
$('nav').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
function traceTo(q) { showTab('trace'); $('tScan').value = q; runTrace(q); }
document.addEventListener('click', e => {
  const t = e.target.closest('[data-trace]');
  if (t && !e.target.closest('button:not([data-trace]), input, select')) { e.preventDefault(); traceTo(t.dataset.trace); }
});

/* ---------------- receive ---------------- */
loaders.receive = async () => {
  try {
    const [rows, lists] = await Promise.all([api.openCarcasses(), api.recentFarms()]);
    $('farmList').innerHTML = lists.farms.map(v => `<option value="${esc(v)}">`).join('');
    $('abattoirList').innerHTML = lists.slaughterhouses.map(v => `<option value="${esc(v)}">`).join('');
    $('rEmpty').hidden = rows.length > 0;
    const maxT = num(state.settings?.max_arrival_temp_c ?? 7);
    $('rRows').innerHTML = rows.map(c => `<tr class="click" data-trace="${esc(c.no)}"><td class="code">${esc(c.no)}</td><td>${esc(c.species)}</td><td>${esc(c.ear_tag)}</td><td>${esc(c.farm)}</td><td class="num">${kg(c.weight_kg, 1)}</td><td class="num">${c.arrival_temp_c == null ? '' : `<span class="chip ${num(c.arrival_temp_c) > maxT ? 'bad' : ''}">${num(c.arrival_temp_c).toFixed(1)}</span>`}</td><td>${c.chiller_use_by ? useByChip(c.chiller_use_by) : ''}</td><td>${chip(c.status)}${c.trays ? ` <span class="chip">${c.trays} units</span>` : ''}</td><td><button class="btn small" type="button" data-reprint="${esc(c.no)}">Print label</button></td></tr>`).join('');
  } catch (err) { msg($('rMsg'), errText(err), 'err'); }
};
$('rRows').addEventListener('click', async e => {
  const b = e.target.closest('[data-reprint]'); if (!b) return;
  try { const c = await api.carcassByNo(b.dataset.reprint); print([{ kind: 'carcass', data: c }]); }
  catch (err) { msg($('rMsg'), errText(err), 'err'); }
});
$('rForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('rSubmit').disabled = true;
  try {
    const c = await api.registerCarcass({
      species: $('rSpecies').value, weight_kg: num($('rWeight').value), ear_tag: $('rTag').value,
      farm: $('rFarm').value, slaughterhouse: $('rAbattoir').value, kill_no: $('rKill').value,
      arrival_temp_c: $('rTemp').value === '' ? null : num($('rTemp').value), source: $('rSource').value
    });
    const maxT = num(state.settings?.max_arrival_temp_c ?? 7), hot = c.arrival_temp_c != null && num(c.arrival_temp_c) > maxT;
    msgHtml($('rMsg'), `Registered <span class="code">${esc(c.no)}</span>. ${$('rAutoPrint').checked ? 'Label sent to the printer.' : ''}${hot ? ` <strong>It arrived at ${num(c.arrival_temp_c).toFixed(1)} °C, above ${maxT} °C. Check the delivery truck.</strong>` : ''}`, hot ? 'warn' : 'ok');
    if ($('rAutoPrint').checked) { try { print([{ kind: 'carcass', data: c }]); } catch (err) { msg($('rMsg'), errText(err), 'err'); } }
    ['rWeight', 'rTag', 'rKill', 'rTemp'].forEach(id => { $(id).value = ''; });
    $('rWeight').focus();
    loaders.receive();
  } catch (err) { msg($('rMsg'), 'Could not register: ' + errText(err), 'err'); }
  $('rSubmit').disabled = false;
});

/* ---------------- cutting room ---------------- */
loaders.cut = async () => {
  try {
    const open = await api.openCarcasses();
    $('cOpenWrap').hidden = !open.length;
    $('cOpen').innerHTML = open.map(c => `<button class="chip code" type="button" data-pick="${esc(c.no)}" style="border:1px solid var(--line);cursor:pointer;padding:6px 10px">${esc(c.no)}</button>`).join('');
  } catch (_) {}
  renderCutActive(); renderProducts(); renderCutTrays();
};
$('cOpen').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) pickCarcass(b.dataset.pick); });
onEnter($('cScan'), v => pickCarcass(v));

async function pickCarcass(raw) {
  const no = raw.trim().toUpperCase();
  try {
    const c = await api.carcassByNo(no);
    if (!c) { msg($('cMsg'), `No carcass ${no}. Check the label.`, 'err'); return; }
    if (c.status === 'sold_whole') { msg($('cMsg'), `Carcass ${no} was sold whole and cannot be cut.`, 'err'); return; }
    const cut = state.cut;
    if ($('cBatch').checked) {
      if (cut.active.length && cut.active[0].species !== c.species) { msg($('cMsg'), `${no} is ${c.species}. A batch can only mix carcasses of the same animal (${cut.active[0].species}).`, 'err'); return; }
      if (!cut.active.some(a => a.id === c.id)) cut.active.push(c);
    }
    else {
      if (cut.active.length === 1 && cut.active[0].id !== c.id) msg($('cMsg'), `Switched to ${no}. Make sure the block is clear.`, 'warn'); else msg($('cMsg'), '');
      cut.active = [c];
    }
    if (cut.product && cut.product.species && cut.product.species !== c.species) cut.product = null;
    renderCutActive(); renderProducts(); renderSelected(); renderCutTrays();
    $('cProdSearch').focus();
  } catch (err) { msg($('cMsg'), errText(err), 'err'); }
}
function renderCutActive() {
  const a = state.cut.active, el = $('cActive');
  $('cActiveBtns').hidden = !a.length; $('cFinish').hidden = a.length !== 1; $('cFinishBox').hidden = true;
  $('wPanel').hidden = a.length !== 1;
  if (a.length === 1) loadWaste();
  if (!a.length) { el.className = 'empty'; el.textContent = 'No carcass selected.'; return; }
  el.className = 'active-card';
  if (a.length === 1) {
    const c = a[0];
    el.innerHTML = `<span class="big-code">${esc(c.no)}</span><span>${esc(c.species)} · tag ${esc(c.ear_tag || '?')} · ${esc(c.farm || 'farm not recorded')} · ${kg(c.weight_kg, 1)} kg</span>`;
  } else {
    el.innerHTML = `<strong>Batch from ${a.length} carcasses</strong><div class="chips">${a.map(c => `<span class="chip accent code">${esc(c.no)}<button type="button" data-unbatch="${esc(c.id)}" aria-label="Remove ${esc(c.no)}">×</button></span>`).join('')}</div>`;
  }
}
$('cActive').addEventListener('click', e => {
  const b = e.target.closest('[data-unbatch]'); if (!b) return;
  state.cut.active = state.cut.active.filter(c => c.id !== b.dataset.unbatch);
  renderCutActive(); renderProducts(); renderCutTrays();
});
$('cBatch').addEventListener('change', () => {
  if (!$('cBatch').checked && state.cut.active.length > 1) { state.cut.active = state.cut.active.slice(0, 1); renderCutActive(); renderCutTrays(); }
  $('cScan').focus();
});
$('cClear').addEventListener('click', () => { state.cut.active = []; renderCutActive(); renderProducts(); renderCutTrays(); $('cScan').focus(); });
// Finishing shows the carcass's numbers first; nothing changes until OK is pressed
$('cFinish').addEventListener('click', async () => {
  const c = state.cut.active[0]; if (!c) return;
  $('cFinish').disabled = true;
  try {
    butcherId(); msg($('cMsg'), '');
    const y = await api.carcassYieldOne(c.id);
    if (state.cut.active[0]?.id !== c.id) return;
    const rec = num(y?.weight_kg ?? c.weight_kg), packed = num(y?.packed_kg), waste = num(y?.waste_kg), shrink = rec - packed - waste;
    const p = v => rec > 0 ? ` (${pct(v / rec * 100)})` : '';
    const parts = Object.keys(WASTE).filter(k => num(y?.[k + '_kg']) > 0).map(k => `${kg(y[k + '_kg'], 1)} kg ${WASTE[k].toLowerCase()}`);
    $('cFinishTitle').textContent = `Finish ${c.no}? Check these numbers first.`;
    $('cFinishKv').innerHTML = `<dt>Received</dt><dd>${kg(rec, 1)} kg</dd>
      <dt>Yield (packed)</dt><dd><strong>${kg(packed, 2)} kg${p(packed)}</strong> in ${y?.trays ?? 0} units</dd>
      <dt>Wastage</dt><dd><strong>${kg(waste, 2)} kg${p(waste)}</strong>${parts.length ? ' · ' + esc(parts.join(', ')) : ''}</dd>
      <dt>Shrinkage</dt><dd><strong>${kg(shrink, 2)} kg${p(shrink)}</strong></dd>`;
    const notes = [];
    if (!packed) notes.push('Nothing has been packed from this carcass.');
    if (!waste) notes.push('No wastage has been recorded.');
    notes.push('If a number is wrong, press Cancel and fix it before finishing.');
    $('cFinishNote').textContent = notes.join(' ');
    $('cFinishBox').hidden = false; $('cFinishOk').focus();
  } catch (err) { msg($('cMsg'), errText(err), 'err'); }
  finally { $('cFinish').disabled = false; }
});
$('cFinishNo').addEventListener('click', () => { $('cFinishBox').hidden = true; $('cScan').focus(); });
$('cFinishOk').addEventListener('click', async () => {
  const c = state.cut.active[0]; if (!c) return;
  $('cFinishOk').disabled = true;
  try {
    await api.finishCarcass(c.id, butcherId());
    let line = '';
    try { const y = await api.carcassYieldOne(c.id); if (y) line = ' ' + breakdown(y) + '.'; } catch (_) {}
    msg($('cMsg'), `${c.no} finished.${line} Scan the next carcass.`, 'ok');
    $('cFinishBox').hidden = true;
    state.cut.active = []; loaders.cut(); $('cScan').focus();
  } catch (err) { msg($('cMsg'), errText(err), 'err'); }
  finally { $('cFinishOk').disabled = false; }
});

function productsForCut() {
  const sp = state.cut.active[0]?.species;
  return state.products.filter(p => p.active && (!sp || !p.species || p.species === sp));
}
const short = v => kg(v, 3).replace(/0+$/, '').replace(/\.$/, '');
const weightText = p => p.fixed_weight_kg ? short(p.fixed_weight_kg) + ' kg'
  : p.min_weight_kg && p.max_weight_kg ? `${short(p.min_weight_kg)}–${short(p.max_weight_kg)} kg`
  : p.min_weight_kg ? `from ${short(p.min_weight_kg)} kg` : 'per kg';
// Products grouped by animal: the given animals first and open, products for any animal next,
// the other animals folded underneath (or left out when onlyOwn is set)
function productGroups(q, own, sel, attr, otherNote, onlyOwn = false) {
  const btn = p => `<button type="button" data-${attr}="${esc(p.id)}" aria-pressed="${p.id === sel}">${esc(p.name)}<span>${weightText(p)} · ${p.shelf_life_days} days</span></button>`;
  const byName = (a, b) => (b.quick ? 1 : 0) - (a.quick ? 1 : 0) || String(a.name).localeCompare(String(b.name));
  let all = state.products.filter(p => p.active);
  if (q) all = all.filter(p => [p.name, p.name_ar, p.sku, p.barcode].some(v => v && String(v).toLowerCase().includes(q)));
  const names = state.species.map(x => x.name);
  all.forEach(p => { if (p.species && !names.includes(p.species)) names.push(p.species); });
  const order = [...own, '', ...names.filter(n => !own.includes(n))];
  const groups = order.filter(n => !onlyOwn || !own.length || n === '' || own.includes(n))
    .map(n => ({ n, items: all.filter(p => (p.species || '') === n).sort(byName) })).filter(g => g.items.length);
  const html = groups.map(g => {
    const open = q || !own.length || own.includes(g.n) || g.n === '' || g.items.some(p => p.id === sel);
    const label = g.n ? g.n : 'Any animal';
    const note = otherNote && own.length && g.n && !own.includes(g.n) ? ' <span class="hint">· other animal</span>' : '';
    return `<details class="pgroup" ${open ? 'open' : ''}><summary>${esc(label)} <span class="hint">${g.items.length}</span>${note}</summary><div class="products">${g.items.slice(0, 80).map(btn).join('')}</div></details>`;
  }).join('');
  return { html, empty: !groups.length };
}
function renderProducts() {
  const q = $('cProdSearch').value.trim().toLowerCase();
  const sp = state.cut.active[0]?.species;
  const g = productGroups(q, sp ? [sp] : [], state.cut.product?.id, 'prod', true, true);
  $('cProdEmpty').hidden = !g.empty;
  $('cProdEmpty').textContent = q ? `No product matches "${$('cProdSearch').value.trim()}".` : 'No products yet. Load them from Zid in Settings.';
  $('cProducts').innerHTML = g.html;
}
$('cProdSearch').addEventListener('input', renderProducts);
$('cProdSearch').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = $('cProdSearch').value.trim();
  const hit = state.products.find(p => p.active && (p.barcode === q || p.sku === q));
  const match = state.products.filter(p => p.active && [p.name, p.sku, p.barcode].some(v => v && String(v).toLowerCase().includes(q.toLowerCase())));
  const own = productsForCut().filter(p => match.includes(p));
  const list = state.cut.active.length || own.length ? own : match;
  const p = hit || (list.length === 1 ? list[0] : null);
  const other = !p && !list.length && match.length && state.cut.active.length;
  if (p) { $('cProdSearch').value = ''; selectProduct(p); }
  else msg($('cMsg'), other ? `"${q}" is not a ${state.cut.active[0].species} product, so it cannot be made from this carcass.` : `No single product matches "${q}".`, other ? 'err' : 'warn');
});
$('cProducts').addEventListener('click', e => { const b = e.target.closest('[data-prod]'); if (b) selectProduct(state.productsById[b.dataset.prod]); });
function selectProduct(p) {
  const sp = state.cut.active[0]?.species;
  if (p.species && sp && p.species !== sp) { msg($('cMsg'), `${p.name} is a ${p.species} product and cannot be made from a ${sp} carcass.`, 'err'); return; }
  state.cut.product = p;
  $('cWeight').value = p.fixed_weight_kg ? Number(p.fixed_weight_kg) : '';
  $('cCount').value = 1;
  renderProducts(); renderSelected();
  (p.fixed_weight_kg ? $('cCount') : $('cWeight')).focus();
  $(p.fixed_weight_kg ? 'cCount' : 'cWeight').select();
}
function renderSelected() {
  const p = state.cut.product;
  $('cPrintBtn').disabled = !p;
  if (!p) { $('cSelTitle').textContent = 'Choose a product'; $('cSelInfo').textContent = 'Labels will show the product, weight, carcass number and consume-before date.'; return; }
  $('cSelTitle').textContent = p.name;
  $('cSelInfo').textContent = `${p.fixed_weight_kg ? 'Fixed weight' : p.min_weight_kg ? `Weigh it: ${weightText(p)}` : 'Weigh each unit'} · consume before ${showYmd(addDays(p.shelf_life_days))} (${p.shelf_life_days} days)`;
  updatePrintLabel();
}
function updatePrintLabel() { const n = Math.max(1, parseInt($('cCount').value, 10) || 1); $('cPrintBtn').textContent = `Print ${n} label${n === 1 ? '' : 's'}`; }
$('cCount').addEventListener('input', updatePrintLabel);
$('cMinus').addEventListener('click', () => { $('cCount').value = Math.max(1, (parseInt($('cCount').value, 10) || 1) - 1); updatePrintLabel(); });
$('cPlus').addEventListener('click', () => { $('cCount').value = Math.min(200, (parseInt($('cCount').value, 10) || 0) + 1); updatePrintLabel(); });

$('cPrintForm').addEventListener('submit', async e => {
  e.preventDefault();
  const { active, product } = state.cut;
  if (!active.length) { msg($('cMsg'), 'Scan the carcass on the block first.', 'err'); $('cScan').focus(); return; }
  if (!product) { msg($('cMsg'), 'Choose a product.', 'err'); return; }
  const count = parseInt($('cCount').value, 10), weight = num($('cWeight').value);
  if (!(count >= 1 && count <= 200)) { msg($('cMsg'), 'Number of units must be between 1 and 200.', 'err'); return; }
  if (!(weight > 0)) { msg($('cMsg'), 'Enter the unit weight.', 'err'); $('cWeight').focus(); return; }
  if (product.species && active.some(c => c.species !== product.species)) { msg($('cMsg'), `${product.name} is a ${product.species} product. Choose a product for this animal.`, 'err'); return; }
  const min = num(product.min_weight_kg), max = num(product.max_weight_kg);
  if (min > 0 && weight < min) { msg($('cMsg'), `${product.name} must weigh at least ${short(min)} kg. This one is ${short(weight)} kg.`, 'err'); $('cWeight').focus(); $('cWeight').select(); return; }
  if (max > 0 && weight > max && !(await ask(`${short(weight)} kg is over the usual weight`, `<p>${esc(product.name)} is normally ${esc(weightText(product))}. Print it at ${esc(short(weight))} kg anyway?</p>`, 'Yes, print it'))) { $('cWeight').focus(); return; }
  $('cPrintBtn').disabled = true;
  try {
    const trays = await api.createTrays(product.id, active.map(c => c.id), count,
      product.fixed_weight_kg && num(product.fixed_weight_kg) === weight ? null : weight, butcherId());
    print(trays.map(t => ({ kind: 'tray', data: { ...t, carcasses: active } })));
    msg($('cMsg'), `Printed ${trays.length} × ${product.name} from ${active.map(c => c.no).join(', ')}.`, 'ok');
    $('cCount').value = 1; updatePrintLabel();
    if (!product.fixed_weight_kg) { $('cWeight').value = ''; $('cWeight').focus(); }
    renderCutTrays();
  } catch (err) { msg($('cMsg'), 'Could not create labels: ' + errText(err), 'err'); }
  $('cPrintBtn').disabled = !state.cut.product;
});

async function renderCutTrays() {
  const a = state.cut.active;
  if (!a.length) { $('cRows').innerHTML = ''; $('cRowsEmpty').hidden = false; $('cRowsEmpty').textContent = 'Select a carcass to see its units.'; $('cYield').textContent = ''; return; }
  try {
    let trays = await api.traysForCarcass(a[0].id);
    if (a.length > 1) { const key = a.map(c => c.no).sort().join(','); trays = trays.filter(t => carcassNos(t).sort().join(',') === key); }
    $('cRowsEmpty').hidden = trays.length > 0; $('cRowsEmpty').textContent = 'No units yet.';
    $('cRows').innerHTML = trays.slice(0, 200).map(t => `<tr><td class="code">${esc(t.code)}</td><td>${esc(t.product_name)}${carcassNos(t).length > 1 ? ' <span class="chip">batch</span>' : ''}</td><td class="num">${kg(t.weight_kg, 3)}</td><td>${showYmd(t.use_by)}</td><td>${chip(t.status)}</td><td>${t.status === 'in_stock' ? `<button class="btn small" type="button" data-reprint-tray="${esc(t.code)}">Reprint</button> <button class="btn small danger admin-only" type="button" data-void="${esc(t.code)}">Delete</button>` : ''}</td></tr>`).join('');
    if (a.length === 1) {
      const packed = trays.reduce((s, t) => s + num(t.weight_kg) / Math.max(1, (t.carcasses || []).length), 0);
      $('cYield').textContent = `${trays.length} units · ${kg(packed)} kg packed from ${kg(a[0].weight_kg, 1)} kg received · ${Math.round(packed / num(a[0].weight_kg) * 100)}% yield so far`;
    } else $('cYield').textContent = `${trays.length} units in this batch`;
  } catch (err) { msg($('cMsg'), errText(err), 'err'); }
}
$('cRows').addEventListener('click', async e => {
  const rp = e.target.closest('[data-reprint-tray]');
  if (rp) { try { const t = await api.trayByCode(rp.dataset.reprintTray); print([{ kind: 'tray', data: t }]); } catch (err) { msg($('cMsg'), errText(err), 'err'); } return; }
  const b = e.target.closest('[data-void]'); if (!b) return;
  if (!(await ask(`Delete label ${b.dataset.void}?`, '<p>The unit is removed from stock and its weight goes back to the carcass. Throw away the printed label.</p>', 'Yes, delete it'))) return;
  try { await api.voidTray(b.dataset.void); msg($('cMsg'), `Label ${b.dataset.void} deleted. Throw away the printed label.`, 'info'); renderCutTrays(); }
  catch (err) { msg($('cMsg'), errText(err), 'err'); }
});

/* ---------------- cutting room: wastage ---------------- */
async function loadWaste() {
  const c = state.cut.active[0]; if (!c) return;
  try {
    const rows = await api.wasteForCarcass(c.id);
    if (state.cut.active[0]?.id !== c.id) return;
    $('wRows').innerHTML = rows.map(w => `<tr><td>${esc(WASTE[w.kind] || w.kind)}</td><td class="num">${kg(w.weight_kg, 3)} kg</td><td class="hint">${when(w.recorded_at)}</td><td><button class="btn small danger admin-only" type="button" data-rm-waste="${esc(w.id)}">Delete</button></td></tr>`).join('');
    const total = rows.reduce((s, w) => s + num(w.weight_kg), 0);
    $('wTotal').textContent = rows.length ? `${kg(total)} kg wastage recorded for ${c.no}.` : `No wastage recorded for ${c.no} yet.`;
  } catch (err) { msg($('wMsg'), errText(err), 'err'); }
}
function setWasteKind(k) {
  state.cut.wasteKind = k;
  document.querySelectorAll('#wKinds [data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
  $('wSave').disabled = !k; $('wSave').textContent = k ? `Record ${WASTE[k].toLowerCase()}` : 'Record wastage';
  if (k) $('wWeight').focus();
}
$('wKinds').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) setWasteKind(b.dataset.kind); });
$('wPanel').addEventListener('submit', async e => {
  e.preventDefault();
  const c = state.cut.active[0], k = state.cut.wasteKind, w = num($('wWeight').value);
  if (!c || !k) return;
  if (!(w > 0)) { msg($('wMsg'), 'Enter the weight.', 'err'); $('wWeight').focus(); return; }
  $('wSave').disabled = true;
  try {
    await api.recordWaste(c.id, k, w, butcherId());
    msg($('wMsg'), `Recorded ${kg(w, 3)} kg ${WASTE[k].toLowerCase()} for ${c.no}.`, 'ok');
    $('wWeight').value = ''; setWasteKind(null); loadWaste();
  } catch (err) { msg($('wMsg'), errText(err), 'err'); $('wSave').disabled = false; }
});
$('wRows').addEventListener('click', async e => {
  const b = e.target.closest('[data-rm-waste]'); if (!b) return;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again'; return; }
  try { await api.deleteWaste(b.dataset.rmWaste); msg($('wMsg'), 'Wastage entry deleted.', 'info'); loadWaste(); }
  catch (err) { msg($('wMsg'), errText(err), 'err'); }
});

/* ---------------- cutting room: modes ---------------- */
function setCutMode(m) {
  state.cut.mode = m;
  document.querySelectorAll('#cutModes [data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('cutMain').hidden = m !== 'cut'; $('cutRepro').hidden = m !== 'repro';
  if (m === 'repro') renderRepro();
  setTimeout(() => $(m === 'repro' ? 'xScan' : 'cScan').focus(), 0);
}
$('cutModes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setCutMode(b.dataset.mode); });

/* ---------------- cutting room: reproduce units ---------------- */
const MINCE = /(mince|keema|kheema|qeema|ground|مفروم)/i;
const reproAnimal = () => state.repro.items[0]?.species?.[0] || null;
const reproProducts = () => { const sp = reproAnimal(); return sp ? state.products.filter(p => p.active && p.species === sp && MINCE.test(`${p.name || ''} ${p.name_ar || ''}`)) : []; };
function renderRepro() {
  if (state.repro.product && !reproProducts().includes(state.repro.product)) state.repro.product = null;
  const { items, product } = state.repro;
  $('xEmpty').hidden = items.length > 0;
  $('xRows').innerHTML = items.map((it, i) => `<tr><td class="code">${esc(it.code)}</td><td>${esc(it.label)}</td><td class="code">${it.carcasses.map(esc).join('<br>')}</td><td class="num">${kg(it.weight_kg, 3)}</td><td><button class="btn small" type="button" data-rm-x="${i}" aria-label="Remove">×</button></td></tr>`).join('');
  const total = items.reduce((s, it) => s + num(it.weight_kg), 0);
  $('xTotal').textContent = items.length ? `${items.length} unit(s), ${kg(total, 3)} kg going in.` : '';
  // units can only become minced meat of their own animal
  const q = $('xProdSearch').value.trim().toLowerCase();
  const sp = reproAnimal(), list = reproProducts().filter(p => !q || [p.name, p.name_ar, p.sku, p.barcode].some(v => v && String(v).toLowerCase().includes(q)));
  $('xProducts').innerHTML = list.length
    ? `<div class="products">${list.map(p => `<button type="button" data-xprod="${esc(p.id)}" aria-pressed="${p.id === product?.id}">${esc(p.name)}<span>${weightText(p)} · ${p.shelf_life_days} days</span></button>`).join('')}</div>`
    : `<p class="empty">${!sp ? 'Scan the units first. Their minced meat shows here.' : q ? `No ${esc(sp.toLowerCase())} minced meat matches "${esc($('xProdSearch').value.trim())}".` : `No minced meat is set up for ${esc(sp.toLowerCase())}. In Settings › Products, set the animal of its minced meat product to ${esc(sp)}.`}</p>`;
  $('xPrintBtn').disabled = !product || !items.length;
  if (product) {
    $('xSelTitle').textContent = product.name;
    const oldest = items.map(i => i.use_by).filter(Boolean).sort()[0];
    let useBy = addDays(product.shelf_life_days); if (oldest && oldest < useBy) useBy = oldest;
    $('xSelInfo').textContent = `Consume before ${showYmd(useBy)}${oldest && oldest === useBy ? ' (the oldest unit going in)' : ''}.`;
    const n = Math.max(1, parseInt($('xCount').value, 10) || 1);
    $('xPrintBtn').textContent = `Reproduce and print ${n} label${n === 1 ? '' : 's'}`;
  } else { $('xSelTitle').textContent = 'Choose the new product'; $('xSelInfo').textContent = 'The consume-before date is never later than the oldest unit going in.'; }
}
onEnter($('xScan'), async v => {
  const items = state.repro.items;
  if (items.some(i => i.code === v)) { msg($('xMsg'), `${v} is already scanned.`, 'warn'); return; }
  try {
    const it = await lookupItem(v);
    if (it.kind !== 'tray') { msg($('xMsg'), 'Scan unit labels here, not carcass labels.', 'err'); return; }
    const sp = reproAnimal();
    if (it.species.length !== 1 || (sp && it.species[0] !== sp)) { msg($('xMsg'), `${it.code} is ${it.species.join(' and ').toLowerCase() || 'from no carcass'}. Only units from one animal${sp ? ` (${sp.toLowerCase()})` : ''} can be reproduced together.`, 'err'); return; }
    items.push(it); msg($('xMsg'), `Added ${it.label}.`, 'ok'); $('xResult').innerHTML = ''; renderRepro();
  } catch (err) { msg($('xMsg'), errText(err), 'err'); }
});
$('xRows').addEventListener('click', e => { const b = e.target.closest('[data-rm-x]'); if (!b) return; state.repro.items.splice(+b.dataset.rmX, 1); renderRepro(); $('xScan').focus(); });
$('xProdSearch').addEventListener('input', renderRepro);
$('xProdSearch').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = $('xProdSearch').value.trim();
  const ok = reproProducts();
  const hit = ok.find(p => p.barcode === q || p.sku === q);
  const list = ok.filter(p => [p.name, p.name_ar, p.sku, p.barcode].some(v => v && String(v).toLowerCase().includes(q.toLowerCase())));
  const p = hit || (list.length === 1 ? list[0] : null);
  if (p) { $('xProdSearch').value = ''; selectReproProduct(p); } else msg($('xMsg'), `No single ${(reproAnimal() || '').toLowerCase()} minced meat matches "${q}".`, 'warn');
});
$('xProducts').addEventListener('click', e => { const b = e.target.closest('[data-xprod]'); if (b) selectReproProduct(state.productsById[b.dataset.xprod]); });
function selectReproProduct(p) {
  state.repro.product = p;
  const total = state.repro.items.reduce((s, it) => s + num(it.weight_kg), 0);
  if (p.fixed_weight_kg) { $('xWeight').value = Number(p.fixed_weight_kg); $('xCount').value = Math.max(1, Math.floor(total / num(p.fixed_weight_kg)) || 1); }
  else { $('xWeight').value = total ? Number(total.toFixed(3)) : ''; $('xCount').value = 1; }
  renderRepro(); $('xWeight').focus(); $('xWeight').select();
}
$('xCount').addEventListener('input', renderRepro);
$('xPrintForm').addEventListener('submit', async e => {
  e.preventDefault();
  const { items, product } = state.repro;
  if (!items.length) { msg($('xMsg'), 'Scan the units going in first.', 'err'); $('xScan').focus(); return; }
  if (!product) return;
  const count = parseInt($('xCount').value, 10), weight = num($('xWeight').value);
  if (!(count >= 1 && count <= 200)) { msg($('xResult'), 'Number of units must be between 1 and 200.', 'err'); return; }
  if (!(weight > 0)) { msg($('xResult'), 'Enter the unit weight.', 'err'); $('xWeight').focus(); return; }
  const inKg0 = items.reduce((s, it) => s + num(it.weight_kg), 0);
  if (!(await ask(`Reproduce ${items.length} unit${items.length > 1 ? 's' : ''}?`, `<p>${items.length} unit(s), ${esc(kg(inKg0, 3))} kg, become ${count} × ${esc(product.name)} (${esc(kg(count * weight, 3))} kg). The old labels stop working.</p>`, 'Yes, reproduce'))) return;
  $('xPrintBtn').disabled = true;
  try {
    const trays = await api.reproduceTrays(items.map(i => i.code), product.id, count, weight, butcherId());
    const carcasses = [...new Set(items.flatMap(i => i.carcasses))].map(no => ({ no }));
    print(trays.map(t => ({ kind: 'tray', data: { ...t, carcasses } })));
    const inKg = items.reduce((s, it) => s + num(it.weight_kg), 0), outKg = count * weight;
    msg($('xResult'), `Made ${trays.length} × ${product.name} (${kg(outKg, 3)} kg) from ${items.length} unit(s) (${kg(inKg, 3)} kg). Labels sent to the printer.${inKg - outKg > 0.0005 ? ` ${kg(inKg - outKg, 3)} kg lost in reproduction counts as shrinkage.` : ''}`, 'ok');
    state.repro = { items: [], product: null }; $('xCount').value = 1; $('xWeight').value = '';
    renderRepro(); $('xScan').focus();
  } catch (err) { msg($('xResult'), 'Could not reproduce: ' + errText(err), 'err'); $('xPrintBtn').disabled = false; }
});

/* ---------------- dashboard ---------------- */
let dashBusy = false;
const n0 = v => Math.round(num(v)).toLocaleString();
const n1 = v => num(v).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const units = v => { const x = num(v); return Math.abs(x - Math.round(x)) < 0.05 ? n0(x) : n1(x); };
loaders.dash = async () => {
  if (dashBusy) return; dashBusy = true;
  try {
    const d = await api.dashboard();
    const sp = d.species, sum = (rows, f) => rows.reduce((s, r) => s + num(r[f]), 0);
    const tile = (big, label, cls = '') => `<div class="tile ${cls}"><b>${big}</b><span>${label}</span></div>`;
    const expired = sum(sp, 'chiller_expired'), soon = sum(sp, 'chiller_soon');
    const stockSoon = sum(d.stock, 'expiring_soon'), stockExp = sum(d.stock, 'expired');
    $('dTiles').innerHTML = [
      tile(`${n1(sum(sp, 'kg_sold') + sum(sp, 'whole_kg'))} kg`, `sold today · ${n1(sum(sp, 'kg_online'))} kg online · ${n1(sum(sp, 'kg_counter'))} kg counter · ${n1(sum(sp, 'whole_kg'))} kg whole`, 'hl'),
      tile(`${n0(sum(sp, 'whole_head'))} head`, `whole carcasses sold today · ${n1(sum(sp, 'whole_kg'))} kg`, 'hl'),
      tile(`${n0(sum(sp, 'chiller_head'))} head`, `in the chiller · ${n1(sum(sp, 'chiller_kg'))} kg`),
      tile(`${n0(sum(sp, 'received_head'))} head`, `received today · ${n1(sum(sp, 'received_kg'))} kg`),
      tile(`${n1(sum(sp, 'kg_made'))} kg`, `produced today · ${units(sum(sp, 'units_made'))} units`),
      tile(`${n1(sum(sp, 'stock_kg'))} kg`, `in stock · ${units(sum(sp, 'stock_units'))} units`),
      tile(`${n1(sum(sp, 'waste_kg'))} kg`, 'wastage today'),
      tile(expired + soon, `carcasses near or past chiller date${expired ? ` (${expired} past)` : ''}`, expired ? 'bad' : (soon ? 'warn' : '')),
      tile(stockSoon + stockExp, `units near or past consume-before${stockExp ? ` (${stockExp} past)` : ''}`, stockExp ? 'bad' : (stockSoon ? 'warn' : '')),
      tile(num(d.complaints_30d), `returns and complaints, last 30 days${num(d.complaints_today) ? ` · ${d.complaints_today} today` : ''}`, num(d.complaints_today) ? 'warn' : '')
    ].join('');
    const row = r => `<td class="num">${n0(r.chiller_head)}</td><td class="num">${n1(r.chiller_kg)}</td><td class="num">${n0(r.received_head)}</td><td class="num">${n1(r.received_kg)}</td><td class="num hl">${n0(r.whole_head)}</td><td class="num hl">${n1(r.whole_kg)}</td><td class="num hl">${units(r.units_sold)}</td><td class="num hl">${n1(r.kg_sold)}</td><td class="num hl">${n1(r.kg_online)}</td><td class="num hl">${n1(r.kg_counter)}</td><td class="num">${units(r.units_made)}</td><td class="num">${n1(r.kg_made)}</td><td class="num">${units(r.stock_units)}</td><td class="num">${n1(r.stock_kg)}</td><td class="num">${n1(r.waste_kg)}</td>`;
    const shown = sp.filter(r => ['chiller_head', 'received_head', 'whole_head', 'units_made', 'units_sold', 'stock_units', 'waste_kg'].some(f => num(r[f])) || state.species.find(x => x.name === r.species)?.active);
    $('dSpecies').innerHTML = shown.map(r => `<tr><td><b>${esc(r.species)}</b></td>${row(r)}</tr>`).join('');
    const tot = {}; ['chiller_head', 'chiller_kg', 'received_head', 'received_kg', 'whole_head', 'whole_kg', 'units_sold', 'kg_sold', 'kg_online', 'kg_counter', 'units_made', 'kg_made', 'stock_units', 'stock_kg', 'waste_kg'].forEach(f => { tot[f] = sum(sp, f); });
    $('dSpeciesTotal').innerHTML = `<tr><td><b>Total</b></td>${row(tot)}</tr>`;
    // carcasses on hand: whole ones still hanging, and what is left on the ones being cut
    const left = c => c.status === 'cutting' ? Math.max(0, num(c.weight_kg) - num(c.packed_kg) - num(c.waste_kg)) : num(c.weight_kg);
    const hand = {};
    sp.forEach(r => { hand[r.species] = { whole: 0, wholeKg: 0, cut: 0, cutKg: 0, stockKg: num(r.stock_kg) }; });
    d.chiller.forEach(c => {
      const h = hand[c.species] || (hand[c.species] = { whole: 0, wholeKg: 0, cut: 0, cutKg: 0, stockKg: 0 });
      if (c.status === 'cutting') { h.cut++; h.cutKg += left(c); } else { h.whole++; h.wholeKg += num(c.weight_kg); }
    });
    const handRow = (name, h) => `<tr><td><b>${esc(name)}</b></td><td class="num hl">${n0(h.whole)}</td><td class="num hl">${n1(h.wholeKg)}</td><td class="num">${n0(h.cut)}</td><td class="num">${n1(h.cutKg)}</td><td class="num">${n0(h.whole + h.cut)}</td><td class="num">${n1(h.wholeKg + h.cutKg)}</td><td class="num">${n1(h.stockKg)}</td></tr>`;
    const handShown = Object.entries(hand).filter(([n, h]) => h.whole || h.cut || h.stockKg || state.species.find(x => x.name === n)?.active);
    $('dOnHand').innerHTML = handShown.map(([n, h]) => handRow(n, h)).join('');
    const ht = { whole: 0, wholeKg: 0, cut: 0, cutKg: 0, stockKg: 0 };
    Object.values(hand).forEach(h => Object.keys(ht).forEach(k => { ht[k] += h[k]; }));
    $('dOnHandTotal').innerHTML = handRow('Total', ht);
    const hrs = h => num(h) < 24 ? `${Math.round(num(h))} h` : `${(num(h) / 24).toFixed(1)} days`;
    $('dChillerEmpty').hidden = d.chiller.length > 0;
    $('dChiller').innerHTML = d.chiller.map(c => `<tr class="click" data-trace="${esc(c.no)}"><td class="code">${esc(c.no)}</td><td>${esc(c.species)}</td><td>${esc(c.farm || '')}</td><td class="num">${kg(c.weight_kg, 1)}</td><td class="num">${hrs(c.hours)}</td><td>${c.chiller_use_by ? useByChip(c.chiller_use_by) : ''}</td><td class="num">${kg(c.packed_kg, 1)}</td><td class="num"><b>${kg(left(c), 1)}</b></td><td class="num">${kg(c.waste_kg, 1)}</td><td>${chip(c.status)}</td></tr>`).join('');
    $('dWholeEmpty').hidden = d.whole_today.length > 0;
    $('dWhole').innerHTML = d.whole_today.map(c => `<tr class="click" data-trace="${esc(c.no)}"><td class="code">${esc(c.no)}</td><td>${esc(c.species)}</td><td class="num">${kg(c.weight_kg, 1)}</td><td class="code">${esc(c.order_ref || '')}</td></tr>`).join('');
    $('dProducedEmpty').hidden = d.produced_today.length > 0;
    $('dProduced').innerHTML = d.produced_today.map(r => `<tr><td>${esc(r.product_name)}</td><td class="num">${r.trays}</td><td class="num">${kg(r.kg, 1)}</td></tr>`).join('');
    $('dStockEmpty').hidden = d.stock.length > 0;
    $('dStock').innerHTML = d.stock.map(r => `<tr><td>${esc(r.product_name)}</td><td class="num">${r.trays}</td><td class="num">${kg(r.kg, 1)}</td><td>${useByChip(r.oldest_use_by)}</td><td class="num">${r.days_left < 0 ? `<span class="chip bad">${r.days_left}</span>` : r.days_left}</td><td class="num">${r.expiring_soon ? `<span class="chip warn">${r.expiring_soon}</span>` : 0}</td><td class="num">${r.expired ? `<span class="chip bad">${r.expired}</span>` : 0}</td></tr>`).join('');
    const y30 = sp.filter(r => num(r.n30));
    $('dYieldEmpty').hidden = y30.length > 0;
    $('dYield').innerHTML = y30.map(r => `<tr><td>${esc(r.species)}</td><td class="num">${r.n30}</td><td class="num">${kg(r.avgkg30, 1)}</td><td class="num">${pct(r.yield30)}</td><td class="num">${pct(r.waste30)}</td><td class="num">${pct(r.shrink30)}</td></tr>`).join('');
    $('dWasteEmpty').hidden = d.waste_today.length > 0;
    $('dWaste').innerHTML = d.waste_today.map(r => `<tr><td>${esc(WASTE[r.kind] || r.kind)}</td><td class="num">${kg(r.kg, 2)}</td></tr>`).join('');
    $('dUpdated').textContent = `Live · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · refreshes every 30 seconds`;
    if (!$('xlFrom').value) { const t = new Date(); $('xlFrom').value = ymdLocal(new Date(t.getFullYear(), t.getMonth(), 1)); $('xlTo').value = ymdLocal(t); }
    msg($('dMsg'), '');
  } catch (err) { msg($('dMsg'), errText(err), 'err'); }
  dashBusy = false;
};
setInterval(() => { if (state.tab === 'dash' && !document.hidden && !$('app').hidden) loaders.dash(); }, 30000);

/* ---------------- Excel export ---------------- */
const XL_SHEETS = [
  ['Daily by animal', 'daily', { date: 'Date', animal: 'Animal', received_head: 'Received head', received_kg: 'Received kg', whole_sold_head: 'Sold whole head', whole_sold_kg: 'Sold whole kg', finished_head: 'Carcasses finished', units_made: 'Units produced', kg_made: 'kg produced', units_sold: 'Units sold', kg_sold: 'kg sold', kg_sold_online: 'kg sold online', kg_sold_counter: 'kg sold counter', kg_written_off: 'kg written off', wastage_kg: 'Wastage kg' }],
  ['Carcasses', 'carcasses', { carcass: 'Carcass', animal: 'Animal', ear_tag: 'Ear tag', source: 'From', farm: 'Farm or trader', slaughterhouse: 'Slaughterhouse', arrival_temp_c: 'Arrival °C', butcher: 'Butcher', received: 'Received', received_kg: 'Received kg', chiller_consume_before: 'Chiller consume before', status: 'Status', finished_or_sold: 'Finished or sold', sold_whole_order: 'Sold whole on order', units: 'Units', packed_kg: 'Packed kg', yield_pct: 'Yield %', trimmings_kg: 'Trimmings kg', fat_kg: 'Fat kg', bones_kg: 'Bones kg', intestines_kg: 'Intestines kg', wastage_kg: 'Wastage kg', shrinkage_kg: 'Shrinkage kg', shrinkage_pct: 'Shrinkage %' }],
  ['Units', 'units', { unit: 'Unit', product: 'Product', animal: 'Animal', carcasses: 'Carcasses', kg: 'kg', packed: 'Packed', consume_before: 'Consume before', status: 'Status', channel: 'Channel', order: 'Order', left_stock: 'Left stock', reason: 'Reason', made_from: 'Reproduced from', butcher: 'Butcher' }],
  ['Wastage', 'wastage', { recorded: 'Recorded', carcass: 'Carcass', animal: 'Animal', type: 'Type', kg: 'kg', butcher: 'Butcher' }],
  ['Returns and complaints', 'complaints', { date: 'Date', kind: 'Type', reason: 'Reason', unit: 'Unit', order: 'Order', carcasses: 'Carcasses', farms: 'Farms', butchers: 'Butchers', unit_returned: 'Unit came back', notes: 'Notes' }],
  ['Stock checks', 'stock_checks', { date: 'Date', expected: 'Expected units', scanned: 'Scanned', found: 'Found', missing_count: 'Missing', missing: 'Missing units', not_in_stock: 'Scanned but not in stock' }],
  ['Orders', 'orders', { order: 'Order', channel: 'Channel', date: 'Date', customer: 'Customer', units: 'Units', kg: 'Units kg', whole_carcasses: 'Whole carcasses', whole_kg: 'Whole kg', trace: 'Carcass numbers', on_zid: 'Added to Zid' }],
  ['Stock at download', 'stock_now', { product: 'Product', units: 'Units', kg: 'kg', oldest_consume_before: 'Oldest consume before', expiring_soon: 'Expiring soon', expired: 'Expired' }]
];
const NICE = { own_farm: 'Our farm', trader: 'Trader', return: 'Return', complaint: 'Complaint', returned: 'Returned', in_chiller: 'In chiller', cutting: 'Cutting', finished: 'Finished', sold_whole: 'Sold whole', in_stock: 'In stock', sold: 'Sold', written_off: 'Written off', reproduced: 'Reproduced', online: 'Online', counter: 'Counter', ...WASTE };
function sheetRows(rows, cols) {
  return rows.map(r => Object.fromEntries(Object.entries(cols).map(([k, label]) => {
    let v = r[k];
    if (typeof v === 'string' && NICE[v]) v = NICE[v];
    if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !['unit', 'carcass', 'order', 'ear_tag', 'missing', 'not_in_stock'].includes(k)) v = Number(v);
    return [label, v ?? ''];
  })));
}
$('xlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const from = $('xlFrom').value, to = $('xlTo').value;
  if (!from || !to || from > to) { msg($('xlMsg'), 'Choose a From date before the To date.', 'err'); return; }
  if (!window.XLSX) { msg($('xlMsg'), 'The Excel library did not load. Check the internet connection and reload.', 'err'); return; }
  $('xlBtn').disabled = true; msg($('xlMsg'), 'Preparing the file…');
  try {
    const data = await api.exportData(from, to);
    const wb = window.XLSX.utils.book_new();
    XL_SHEETS.forEach(([title, key, cols]) => {
      const rows = sheetRows(data[key] || [], cols);
      const ws = window.XLSX.utils.json_to_sheet(rows, { header: Object.values(cols) });
      ws['!cols'] = Object.values(cols).map(h => ({ wch: Math.max(10, h.length + 2) }));
      window.XLSX.utils.book_append_sheet(wb, ws, title);
    });
    window.XLSX.writeFile(wb, `Meatrix records ${from} to ${to}.xlsx`);
    msg($('xlMsg'), `Downloaded: ${(data.carcasses || []).length} carcasses, ${(data.units || []).length} units, ${(data.wastage || []).length} wastage entries, ${(data.orders || []).length} orders.`, 'ok');
  } catch (err) { msg($('xlMsg'), errText(err), 'err'); }
  $('xlBtn').disabled = false;
});

/* ---------------- scanning units out (shared by packing and counter) ---------------- */
async function lookupItem(raw) {
  const code = raw.trim();
  const t = await api.trayByCode(code);
  if (t) {
    if (t.status === 'sold') throw new Error(`Unit ${code} already left on order ${t.order_ref}.`);
    if (t.status === 'written_off') throw new Error(`Unit ${code} was taken out of stock (${t.write_off_reason}).`);
    if (t.status === 'returned') throw new Error(`Unit ${code} came back from a customer (${t.write_off_reason}).`);
    if (t.status === 'reproduced') throw new Error(`Unit ${code} was reproduced (${t.write_off_reason}). Scan the new unit instead.`);
    return { kind: 'tray', code: t.code, product_id: t.product_id, label: t.product_name, carcasses: carcassNos(t), species: [...new Set((t.carcasses || []).map(c => c.species))], weight_kg: t.weight_kg, use_by: t.use_by };
  }
  const c = await api.carcassByNo(code.toUpperCase());
  if (c) {
    if (c.status === 'sold_whole') throw new Error(`Carcass ${c.no} was already sold whole.`);
    return { kind: 'carcass', code: c.no, label: `Whole ${c.species.toLowerCase()}`, carcasses: [c.no], species: [c.species], weight_kg: c.weight_kg };
  }
  throw new Error(`Nothing found for ${code}. Was the label printed by this system?`);
}
const warnLine = it => it.warn ? `<div class="hint" style="color:var(--warn)">${esc(it.warn)}</div>` : '';
const itemRows = (items, attr) => items.map((it, i) => `<tr>${attr === 'p'
  ? `<td class="code">${esc(it.code)}</td><td>${esc(it.label)}${warnLine(it)}</td>`
  : `<td>${esc(it.label)}<div class="hint code">${esc(it.code)}</div>${warnLine(it)}</td>`}<td class="code">${it.carcasses.map(esc).join('<br>')}</td><td class="num">${kg(it.weight_kg, 3)}</td><td><button class="btn small" type="button" data-rm-${attr}="${i}" aria-label="Remove">×</button></td></tr>`).join('');

/* ---------------- online packing ---------------- */
loaders.pack = async () => {
  try {
    const rows = await api.recentOrders('online');
    $('pRecentEmpty').hidden = rows.length > 0;
    $('pRecent').innerHTML = rows.map(o => `<tr><td class="code"><a href="#" data-trace="${esc(o.ref)}">${esc(o.ref)}</a></td><td>${when(o.created_at)}</td><td>${o.zid_comment_posted ? '<span class="chip good">On Zid</span>' : `<button class="btn small" type="button" data-comment="${esc(o.ref)}">Send to Zid</button>`}</td></tr>`).join('');
  } catch (_) {}
};
$('pRecent').addEventListener('click', async e => {
  const b = e.target.closest('[data-comment]'); if (!b) return;
  b.disabled = true;
  try { await api.zid('post_comment', { order_ref: b.dataset.comment }); loaders.pack(); }
  catch (err) { b.disabled = false; msg($('pMsg'), 'Zid: ' + errText(err), 'err'); }
});
$('pOrderForm').addEventListener('submit', async e => {
  e.preventDefault();
  const no = $('pOrderNo').value.trim(); if (!no) return;
  state.pack = { order: { id: no, products: [], customer: null, fromZid: false }, items: [] };
  $('pResult').innerHTML = ''; msg($('pMsg'), '');
  try {
    const o = await api.zid('get_order', { order_id: no });
    state.pack.order = { ...o, id: String(o.id || no), fromZid: true };
  } catch (err) {
    state.pack.warn = `Could not load the order from Zid (${errText(err)}). You can still pack it; the carcass numbers will be saved here.`;
  }
  try {
    const already = await api.traysForOrder(state.pack.order.id);
    state.pack.already = already;
  } catch (_) { state.pack.already = []; }
  renderPack();
  $('pScan').focus();
});
function orderLines() {
  const o = state.pack.order; if (!o || !o.products?.length) return [];
  return o.products.map(op => {
    const local = state.products.filter(p => (op.zid_product_id && p.zid_product_id === op.zid_product_id) || (op.barcode && p.barcode === op.barcode) || (op.sku && p.sku === op.sku)).map(p => p.id);
    const packed = [...(state.pack.already || []), ...state.pack.items].filter(it => local.includes(it.product_id)).length;
    return { ...op, local, packed };
  });
}
function renderPack() {
  const { order, items } = state.pack;
  $('pScan').disabled = !order;
  $('pTitle').textContent = order ? `Packing order ${order.id}` : 'Packing';
  if (order) {
    const lines = orderLines();
    const already = state.pack.already || [];
    let html = state.pack.warn ? `<div class="msg warn">${esc(state.pack.warn)}</div>` : '';
    html += order.fromZid ? `<dl class="kv"><dt>Customer</dt><dd>${esc(order.customer || '–')}</dd><dt>Status</dt><dd>${esc(order.status || '–')}</dd></dl>` : '';
    if (lines.length) html += `<div class="table-wrap"><table><thead><tr><th>Ordered</th><th class="num">Qty</th><th class="num">Scanned</th></tr></thead><tbody>${lines.map(l => `<tr><td>${esc(l.name)}</td><td class="num">${l.quantity}</td><td class="num">${l.packed >= l.quantity ? `<span class="chip good">${l.packed}</span>` : l.packed}</td></tr>`).join('')}</tbody></table></div>`;
    if (already.length) html += `<p class="hint">${already.length} unit(s) were already packed for this order earlier.</p>`;
    $('pOrderInfo').innerHTML = html;
  }
  $('pEmpty').hidden = items.length > 0;
  $('pEmpty').textContent = order ? 'Scan the first unit.' : 'Open an order to start packing.';
  $('pRows').innerHTML = itemRows(items, 'p');
  $('pConfirm').disabled = !items.length;
}
onEnter($('pScan'), async v => {
  const { order, items } = state.pack; if (!order) return;
  if (items.some(i => i.code === v || i.code === v.toUpperCase())) { msg($('pMsg'), `${v} is already scanned.`, 'warn'); return; }
  try {
    const it = await lookupItem(v);
    const lines = orderLines();
    if (lines.length && it.kind === 'tray') {
      const line = lines.find(l => l.local.includes(it.product_id));
      // the order's animals: a line for any animal, or one not set up here, allows every animal
      const animals = lines.flatMap(l => l.local.length ? l.local.map(id => state.productsById[id]?.species || '*') : ['*']);
      if (!line && !animals.includes('*') && !it.species.some(sp => animals.includes(sp))) {
        msg($('pMsg'), `${it.label} is ${it.species.join(' + ')}. This order is for ${[...new Set(animals)].join(', ')} only. Put it back.`, 'err'); return;
      }
      if (!line) it.warn = 'Not in this order';
      else if (line.packed >= line.quantity) it.warn = 'More than ordered';
    }
    items.push(it);
    msg($('pMsg'), it.warn ? `${it.label}: ${it.warn.toLowerCase()}. Remove it if this is a mistake.` : `Added ${it.label} from ${it.carcasses.join(', ')}.`, it.warn ? 'warn' : 'ok');
    renderPack();
  } catch (err) { msg($('pMsg'), errText(err), 'err'); }
});
$('pRows').addEventListener('click', e => { const b = e.target.closest('[data-rm-p]'); if (!b) return; state.pack.items.splice(+b.dataset.rmP, 1); renderPack(); $('pScan').focus(); });
$('pConfirm').addEventListener('click', async () => {
  const { order, items } = state.pack; if (!order || !items.length) return;
  const warned = items.filter(i => i.warn).length;
  if (!(await ask(`Finish packing order ${order.id}?`, `<p>${items.length} unit(s) leave stock and the carcass numbers are added to the Zid order.${warned ? ` <strong>${warned} unit(s) have a warning.</strong>` : ''}</p>`, 'Yes, finish packing'))) return;
  $('pConfirm').disabled = true;
  try {
    const o = await api.sellItems(items.map(i => i.code), 'online', order.id, order.customer);
    let zidLine;
    try { const r = await api.zid('post_comment', { order_ref: o.ref }); zidLine = `<p>Added to the Zid order: <span class="code">${esc((r.posted || []).join(' / '))}</span></p>`; }
    catch (err) { zidLine = `<p>Saved here, but not sent to Zid (${esc(errText(err))}). Use "Send to Zid" in Recent orders, or paste this into the order comment:</p><p class="code">${esc(o.trace_summary)}</p>`; }
    msgHtml($('pResult'), `<strong>Order ${esc(o.ref)} packed.</strong> ${zidLine}`, 'ok');
    state.pack = { order: null, items: [] };
    $('pOrderInfo').innerHTML = ''; $('pOrderNo').value = '';
    renderPack(); loaders.pack(); $('pOrderNo').focus();
  } catch (err) { msg($('pMsg'), 'Could not confirm: ' + errText(err), 'err'); $('pConfirm').disabled = false; }
});

/* ---------------- shop counter ---------------- */
const TEMP_REF = /^C\d{6}-\d{6}$/;   // a counter sale with no Zid order number yet
loaders.counter = async () => {
  try {
    const rows = await api.recentOrders('counter');
    $('kRecentEmpty').hidden = rows.length > 0;
    $('kRecent').innerHTML = rows.map(o => {
      const linked = !TEMP_REF.test(o.ref);
      const status = linked
        ? `<span class="chip ${o.zid_comment_posted ? 'good' : ''}">Zid ${esc(o.ref)}</span>`
        : `<div class="link-row"><input class="small" data-link-in="${esc(o.ref)}" placeholder="Zid order no." aria-label="Zid order number for ${esc(o.ref)}"><button class="btn small" type="button" data-link="${esc(o.ref)}">Link</button></div>`;
      return `<tr><td class="click" data-trace="${esc(o.ref)}">${when(o.created_at)}<div class="hint">${esc(o.trace_summary || '')}</div></td><td>${status}</td></tr>`;
    }).join('');
    if (rows.some(o => !TEMP_REF.test(o.ref) && !o.zid_comment_posted)) {
      // a link made earlier whose comment did not reach Zid: try again quietly
      for (const o of rows.filter(o => !TEMP_REF.test(o.ref) && !o.zid_comment_posted).slice(0, 3)) {
        try { await api.zid('post_comment', { order_ref: o.ref }); } catch (_) {}
      }
    }
    if (rows.some(o => TEMP_REF.test(o.ref))) autoLinkCounter();
  } catch (_) {}
};

// Find the Zid POS order for each counter sale that has no Zid number yet:
// an order with the same products, rung up within 30 minutes of the scan. Only a clear match is linked.
// Zid order times are read both as shop time and as UTC, because POS orders may use either.
let linking = false;
const hhmm = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
async function autoLinkCounter(manual = false) {
  if (linking) return; linking = true;
  let reload = false;
  try {
    const sales = (await api.recentOrders('counter', 30)).filter(o => TEMP_REF.test(o.ref) && Date.now() - Date.parse(o.created_at) < 6 * 3600e3);
    if (!sales.length) { if (manual) msg($('kLinkMsg'), 'Every recent sale already has its Zid order.', 'ok'); return; }
    const zr = await api.zid('recent_orders', { since_minutes: 480 });
    const zidOrders = zr.orders || [];
    const taken = new Set((await api.ordersByRefs(zidOrders.map(z => z.id))).map(r => r.ref));
    const free = zidOrders.filter(z => !taken.has(z.id));
    const trays = await api.traysForOrders(sales.map(o => o.ref));
    const localIds = op => state.products.filter(p => (op.zid_product_id && p.zid_product_id === op.zid_product_id) || (op.barcode && p.barcode === op.barcode) || (op.sku && p.sku === op.sku)).map(p => p.id);
    const used = new Set(); let linked = 0, unclear = 0;
    const why = [];
    for (const sale of sales.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      const mine = trays.filter(t => t.order_ref === sale.ref);
      if (!mine.length) { why.push(`${hhmm(sale.created_at)} sale: whole carcass, link it by hand.`); continue; }
      const count = {}; mine.forEach(t => { count[t.product_id] = (count[t.product_id] || 0) + 1; });
      const want = Object.keys(count);
      const cands = []; let near = null;
      for (const z of free) {
        if (used.has(z.id)) continue;
        const times = [z.created_at, z.created_at_utc].filter(Boolean).map(t => Math.abs(Date.parse(t) - Date.parse(sale.created_at)) / 60000);
        if (!times.length) continue;
        const dt = Math.min(...times);
        const lines = (z.products || []).map(l => ({ ids: localIds(l), q: l.quantity, name: l.name || l.sku || '?' }));
        const hits = want.filter(pid => lines.some(l => l.ids.includes(pid))).length;
        if (!near || dt < near.dt) near = { z, dt, hits, lines };
        if (dt > 30 || hits < want.length) continue;
        // extra POS lines (a bag, something not scanned) are allowed but make a match weaker
        const extra = lines.filter(l => !l.ids.some(id => want.includes(id))).length;
        // whole-number quantities should match the number of units; weights in kg are not compared
        let off = extra;
        want.forEach(pid => { const l = lines.find(x => x.ids.includes(pid)); if (Number.isInteger(l.q) && l.q > 1) off += Math.abs(l.q - count[pid]); });
        cands.push({ z, dt, off });
      }
      cands.sort((a, b) => a.off - b.off || a.dt - b.dt);
      const [best, next] = cands;
      if (!best) {
        why.push(!near ? `${hhmm(sale.created_at)} sale: Zid sent no unlinked order to compare.`
          : `${hhmm(sale.created_at)} sale: closest Zid order ${near.z.code || near.z.id} is ${Math.round(near.dt)} min away and has ${near.hits} of ${want.length} products (${near.lines.map(l => l.name).join(', ') || 'no products'}).`);
        continue;
      }
      if (next && next.off === best.off && next.dt - best.dt < 3) { unclear++; why.push(`${hhmm(sale.created_at)} sale: Zid orders ${best.z.code || best.z.id} and ${next.z.code || next.z.id} both fit.`); continue; }
      try {
        await api.linkCounterSale(sale.ref, best.z.id);
        used.add(best.z.id); linked++; reload = true;
        try { await api.zid('post_comment', { order_ref: best.z.id }); } catch (_) {}
      } catch (err) { why.push(`${hhmm(sale.created_at)} sale: could not link to ${best.z.code || best.z.id} (${errText(err)}).`); }
    }
    if (manual) {
      const left = sales.length - linked;
      const info = `Zid listed ${zr.listed ?? 0} orders${zr.newest ? `, newest at ${hhmm(zr.newest)}` : ''}; ${zr.in_window ?? zidOrders.length} from the last 8 hours.`;
      msgHtml($('kLinkMsg'), `${linked ? `Linked ${linked} sale${linked > 1 ? 's' : ''} to Zid. ` : ''}${left ? `${left} still waiting. Type the Zid order number next to ${left > 1 ? 'them' : 'it'}.` : ''}<div class="hint" style="margin-top:6px">${esc(info)}${why.slice(0, 4).map(w => `<br>${esc(w)}`).join('')}</div>`, left ? 'warn' : 'ok');
    }
  } catch (err) { if (manual) msg($('kLinkMsg'), 'Could not check Zid: ' + errText(err), 'err'); }
  finally { linking = false; }
  if (reload) loaders.counter();
}
$('kFind').addEventListener('click', () => autoLinkCounter(true));
setInterval(() => { if (state.tab === 'counter' && !document.hidden && !$('app').hidden) autoLinkCounter(); }, 60000);
$('kRecent').addEventListener('click', async e => {
  const b = e.target.closest('[data-link]');
  if (!b) return;
  const ref = b.dataset.link;
  const input = $('kRecent').querySelector(`[data-link-in="${CSS.escape(ref)}"]`);
  const no = input.value.trim(); if (!no) { input.focus(); return; }
  b.disabled = true;
  try {
    await api.linkCounterSale(ref, no);
    let line = '';
    try { await api.zid('post_comment', { order_ref: no }); line = ' The carcass numbers were added to it.'; }
    catch (err) { line = ` It could not be sent to Zid (${errText(err)}).`; }
    msg($('kLinkMsg'), `Linked to Zid order ${no}.${line}`, 'ok'); loaders.counter();
  } catch (err) { msg($('kLinkMsg'), errText(err), 'err'); b.disabled = false; }
});

// What the cashier enters in the POS: each product with the weight of every unit
function renderRingUp(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.kind === 'tray' ? it.product_id : 'c:' + it.code;
    if (!groups.has(key)) {
      const p = it.kind === 'tray' ? state.productsById[it.product_id] : null;
      groups.set(key, { name: p?.name || it.label, ar: p?.name_ar || '', sku: p?.sku || p?.barcode || '', kgs: [] });
    }
    groups.get(key).kgs.push(Number(it.weight_kg));
  }
  $('kRingup').hidden = !items.length;
  $('kRingupRows').innerHTML = [...groups.values()].map(g => `<li><div class="ru-name">${esc(g.name)}${g.ar ? ` <span class="ru-ar" lang="ar" dir="rtl">${esc(g.ar)}</span>` : ''}${g.sku ? ` <span class="hint code">${esc(g.sku)}</span>` : ''}</div>
    <div class="ru-kg">${g.kgs.map(k => kg(k, 3) + ' kg').join(' + ')}${g.kgs.length > 1 ? ` <span class="hint">= ${kg(g.kgs.reduce((a, b) => a + b, 0), 3)} kg, ${g.kgs.length} units</span>` : ''}</div></li>`).join('');
}
function renderCounter() {
  const items = state.counter.items;
  $('kEmpty').hidden = items.length > 0;
  $('kRows').innerHTML = itemRows(items, 'k');
  $('kConfirm').disabled = !items.length;
  renderRingUp(items);
}
onEnter($('kScan'), async v => {
  const items = state.counter.items;
  if (items.some(i => i.code === v || i.code === v.toUpperCase())) { msg($('kMsg'), `${v} is already scanned.`, 'warn'); return; }
  try { const it = await lookupItem(v); items.push(it); msg($('kMsg'), `Added ${it.label}.`, 'ok'); $('kResult').innerHTML = ''; renderCounter(); }
  catch (err) { msg($('kMsg'), errText(err), 'err'); }
});
$('kRows').addEventListener('click', e => { const b = e.target.closest('[data-rm-k]'); if (!b) return; state.counter.items.splice(+b.dataset.rmK, 1); renderCounter(); $('kScan').focus(); });
$('kConfirm').addEventListener('click', async () => {
  const items = state.counter.items; if (!items.length) return;
  const whole = items.filter(i => i.kind === 'carcass');
  if (!(await ask(`Record this sale of ${items.length} item${items.length > 1 ? 's' : ''}?`, `<p>${esc(kg(items.reduce((s, i) => s + num(i.weight_kg), 0), 3))} kg leave stock.${whole.length ? ` <strong>Whole carcass sold: ${whole.map(i => esc(i.code)).join(', ')}.</strong> It cannot be cut after this.` : ''}</p>`, 'Yes, record the sale'))) return;
  $('kConfirm').disabled = true;
  try {
    const ref = $('kReceipt').value.trim();
    const o = await api.sellItems(items.map(i => i.code), 'counter', ref, null);
    let zidLine = '';
    if (ref) {
      try { await api.zid('post_comment', { order_ref: o.ref }); zidLine = ' Added to the Zid order.'; }
      catch (err) { zidLine = ` Could not add it to the Zid order (${esc(errText(err))}).`; }
    }
    msgHtml($('kResult'), `<strong>Sale recorded.${zidLine}${ref ? '' : ' The Meatrix will find its Zid POS order by itself.'}</strong> <span class="code">${esc(o.trace_summary)}</span>`, ref && !zidLine.startsWith(' Could') ? 'ok' : (ref ? 'warn' : 'ok'));
    state.counter.items = []; $('kReceipt').value = ''; renderCounter(); loaders.counter(); $('kScan').focus();
    if (!ref) setTimeout(() => autoLinkCounter(), 45000);
  } catch (err) { msg($('kMsg'), 'Could not record: ' + errText(err), 'err'); $('kConfirm').disabled = false; }
});

/* ---------------- stock ---------------- */
let stockTrays = [];
loaders.stock = async () => {
  try {
    const [rows, trays] = await Promise.all([api.stockByProduct(), api.inStockTrays()]);
    stockTrays = trays;
    const today = ymdLocal(), soon = addDays(state.settings?.expiry_warning_days ?? 1);
    const expired = trays.filter(t => t.use_by < today).length, near = trays.filter(t => t.use_by >= today && t.use_by <= soon).length;
    $('sStats').innerHTML = `<div class="stat"><b>${trays.length}</b><span>Units</span></div><div class="stat"><b>${kg(trays.reduce((s, t) => s + num(t.weight_kg), 0), 1)}</b><span>kg in stock</span></div><div class="stat"><b style="color:var(--warn)">${near}</b><span>Expiring soon</span></div><div class="stat"><b style="color:var(--bad)">${expired}</b><span>Expired</span></div>`;
    $('sEmpty').hidden = rows.length > 0;
    $('sRows').innerHTML = rows.map(r => `<tr><td>${esc(r.product_name)}</td><td class="num">${r.trays}</td><td class="num">${kg(r.kg, 1)}</td><td>${useByChip(r.oldest_use_by)}</td><td class="hint">${state.productsById[r.product_id] ? state.productsById[r.product_id].shelf_life_days + ' days' : ''}</td></tr>`).join('');
    renderStockTrays();
  } catch (err) { msg($('sMsg'), errText(err), 'err'); }
};
function renderStockTrays() {
  const f = $('sFilter').value, today = ymdLocal(), soon = addDays(state.settings?.expiry_warning_days ?? 1);
  const list = stockTrays.filter(t => f === 'all' || (f === 'expired' ? t.use_by < today : (t.use_by >= today && t.use_by <= soon)));
  $('sTraysEmpty').hidden = list.length > 0; $('sAll').checked = false;
  $('sTrays').innerHTML = list.slice(0, 500).map(t => `<tr><td><input type="checkbox" data-sel="${esc(t.code)}" aria-label="Select ${esc(t.code)}"></td><td class="code"><a href="#" data-trace="${esc(t.code)}">${esc(t.code)}</a></td><td>${esc(t.product_name)}</td><td class="code">${carcassNos(t).map(esc).join(', ')}</td><td class="num">${kg(t.weight_kg, 3)}</td><td>${when(t.packed_at)}</td><td>${useByChip(t.use_by)}</td></tr>`).join('');
  updateWriteOff();
}
const selectedCodes = () => [...document.querySelectorAll('#sTrays [data-sel]:checked')].map(i => i.dataset.sel);
function updateWriteOff() { const n = selectedCodes().length; $('sWriteOff').disabled = !n; $('sWriteOff').textContent = n ? `Take ${n} out of stock` : 'Take selected out of stock'; }
$('sFilter').addEventListener('change', renderStockTrays);
$('sRefresh').addEventListener('click', () => loaders.stock());
$('sTrays').addEventListener('change', updateWriteOff);
$('sAll').addEventListener('change', () => { document.querySelectorAll('#sTrays [data-sel]').forEach(i => { i.checked = $('sAll').checked; }); updateWriteOff(); });
$('sWriteOff').addEventListener('click', async () => {
  const b = $('sWriteOff'), codes = selectedCodes(); if (!codes.length) return;
  if (!(await ask(`Take ${codes.length} unit${codes.length > 1 ? 's' : ''} out of stock?`, `<p>Reason: ${esc($('sReason').value)}. This cannot be undone.</p>`, 'Yes, take them out'))) return;
  try { const n = await api.writeOff(codes, $('sReason').value); msg($('sMsg'), `${n} unit(s) taken out of stock: ${$('sReason').value}.`, 'ok'); loaders.stock(); }
  catch (err) { msg($('sMsg'), errText(err), 'err'); }
});

/* ---------------- carcasses & yield ---------------- */
let yieldRows = [];
loaders.carcasses = async () => {
  try { yieldRows = await api.carcassYield(500); renderYield(); } catch (err) { $('yEmpty').hidden = false; $('yEmpty').textContent = errText(err); }
  try {
    const d = await api.dashboard(), bs = d.butchers || [];
    $('yButchersEmpty').hidden = bs.length > 0;
    $('yButchers').innerHTML = bs.map(b => `<tr><td><b>${esc(b.name)}</b></td><td class="num">${b.n30}</td><td class="num">${pct(b.yield30)}</td><td class="num">${pct(b.waste30)}</td><td class="num">${pct(b.shrink30)}</td><td class="num">${b.units_today}</td><td class="num">${kg(b.kg_today, 1)}</td><td class="num">${b.complaints30 ? `<span class="chip bad">${b.complaints30}</span>` : 0}</td></tr>`).join('');
  } catch (_) { $('yButchersEmpty').hidden = false; }
};
function renderYield() {
  const sp = $('ySpecies').value;
  const rows = yieldRows.filter(r => !sp || r.species === sp);
  $('yEmpty').hidden = rows.length > 0;
  $('yRows').innerHTML = rows.map(r => `<tr class="click" data-trace="${esc(r.no)}"><td class="code">${esc(r.no)}</td><td>${esc(r.species)}</td><td>${esc(r.ear_tag)}</td><td>${esc(r.farm)}</td><td class="num">${kg(r.weight_kg, 1)}</td><td class="num">${kg(r.packed_kg, 1)}</td><td class="num">${r.yield_pct == null ? '' : num(r.yield_pct).toFixed(1) + '%'}</td><td class="num">${kg(r.waste_kg, 1)}</td><td class="num">${r.shrink_kg == null ? '' : `${kg(r.shrink_kg, 1)} kg · ${pct(r.shrink_pct)}`}</td><td class="num">${r.trays_in_stock}</td><td class="num">${r.trays_sold}</td><td>${chip(r.status)}</td></tr>`).join('');
  const groups = {};
  rows.filter(r => r.status === 'finished').forEach(r => {
    const k = (r.farm || 'Not recorded') + '|' + r.species;
    (groups[k] = groups[k] || { farm: r.farm || 'Not recorded', species: r.species, n: 0, kg: 0, y: 0, w: 0, s: 0 });
    groups[k].n++; groups[k].kg += num(r.weight_kg); groups[k].y += num(r.yield_pct);
    groups[k].w += num(r.weight_kg) ? num(r.waste_kg) / num(r.weight_kg) * 100 : 0; groups[k].s += num(r.shrink_pct);
  });
  const g = Object.values(groups).sort((a, b) => b.y / b.n - a.y / a.n);
  $('yFarmsEmpty').hidden = g.length > 0;
  $('yFarms').innerHTML = g.map(x => `<tr><td>${esc(x.farm)}</td><td>${esc(x.species)}</td><td class="num">${x.n}</td><td class="num">${kg(x.kg / x.n, 1)}</td><td class="num">${(x.y / x.n).toFixed(1)}%</td><td class="num">${(x.w / x.n).toFixed(1)}%</td><td class="num">${(x.s / x.n).toFixed(1)}%</td></tr>`).join('');
}
$('ySpecies').addEventListener('change', renderYield);

/* ---------------- trace ---------------- */
onEnter($('tScan'), v => { $('tScan').value = v; runTrace(v); });
const orderLink = ref => ref ? `<a href="#" data-trace="${esc(ref)}" class="code">${esc(ref)}</a>` : '';
const REASONS = ['Smell', 'Colour', 'Too much fat or bone', 'Wrong cut or product', 'Wrong weight', 'Late or warm delivery', 'Damaged pack', 'Other'];
function complaintForm(target) {
  return `<form class="panel" data-complaint="${esc(JSON.stringify(target))}" style="margin-bottom:18px">
    <h3>Record a return or complaint</h3>
    <div class="row3" style="align-items:end">
      <label>Type<select data-c="kind"><option value="complaint">Complaint</option><option value="return">Return</option></select></label>
      <label>Reason<select data-c="reason">${REASONS.map(r => `<option>${r}</option>`).join('')}</select></label>
      <label>Notes<input data-c="notes" autocomplete="off"></label>
    </div>
    ${target.tray_code ? '<label class="inline"><input type="checkbox" data-c="unit_returned"> The unit came back to the shop (it is kept out of stock)</label>' : ''}
    <div class="btns"><button class="btn primary" type="submit">Save</button></div><div data-c="msg"></div></form>`;
}
function complaintList(rows) {
  if (!rows.length) return '';
  return `<div class="panel" style="margin-bottom:18px"><h3>Returns and complaints</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Unit</th><th>Order</th><th>Carcasses</th><th>Notes</th></tr></thead><tbody>${rows.map(k => `<tr><td>${when(k.created_at)}</td><td><span class="chip ${k.kind === 'return' ? 'bad' : 'warn'}">${k.kind === 'return' ? 'Return' : 'Complaint'}</span></td><td>${esc(k.reason)}</td><td class="code">${esc(k.tray_code || '')}</td><td class="code">${esc(k.order_ref || '')}</td><td class="code">${(k.carcass_nos || []).map(esc).join(', ')}</td><td>${esc(k.notes || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
}
const safeComplaints = q => (api.complaintsFor ? api.complaintsFor(q) : Promise.resolve([])).catch(() => []);
$('tOut').addEventListener('submit', async e => {
  const f = e.target.closest('[data-complaint]'); if (!f) return;
  e.preventDefault();
  const t = JSON.parse(f.dataset.complaint), v = k => f.querySelector(`[data-c="${k}"]`);
  try {
    await api.recordComplaint({ ...t, kind: v('kind').value, reason: v('reason').value, notes: v('notes').value, unit_returned: v('unit_returned')?.checked });
    msg(v('msg'), 'Saved. It now shows on the carcass, the order and the butcher.', 'ok');
    setTimeout(() => runTrace($('tScan').value || t.tray_code || t.order_ref), 900);
  } catch (err) { msg(v('msg'), errText(err), 'err'); }
});
async function carcassBlock(c) {
  const [trays, y, waste, comps] = await Promise.all([api.traysForCarcass(c.id), api.carcassYieldOne(c.id).catch(() => null), api.wasteForCarcass(c.id).catch(() => []), safeComplaints({ carcassNo: c.no })]);
  const live = trays.filter(t => t.status !== 'reproduced');
  const packed = live.reduce((s, t) => s + num(t.weight_kg) / Math.max(1, (t.carcasses || []).length), 0);
  const orders = [...new Set([...trays.map(t => t.order_ref), c.order_ref].filter(Boolean))];
  const byProduct = {};
  live.forEach(t => { const p = byProduct[t.product_name] = byProduct[t.product_name] || { n: 0, kg: 0, stock: 0 }; p.n++; p.kg += num(t.weight_kg) / Math.max(1, (t.carcasses || []).length); if (t.status === 'in_stock') p.stock++; });
  return `<div class="grid" style="margin-bottom:18px">
    <div class="panel">
      <div class="chain"><span class="chip">Farm: ${esc(c.farm || '?')}</span>→<span class="chip">Slaughterhouse: ${esc(c.slaughterhouse || '?')}${c.kill_no ? ' #' + esc(c.kill_no) : ''}</span>→<span class="chip accent code">${esc(c.no)}</span></div>
      <span class="big-code">${esc(c.no)}</span>
      <dl class="kv">
        <dt>Animal</dt><dd>${esc(c.species)}</dd><dt>Ear tag</dt><dd class="code">${esc(c.ear_tag || '–')}</dd>
        <dt>Farm</dt><dd>${esc(c.farm || '–')}</dd><dt>Slaughterhouse</dt><dd>${esc(c.slaughterhouse || '–')}</dd><dt>Kill no.</dt><dd>${esc(c.kill_no || '–')}</dd>
        <dt>Received</dt><dd>${when(c.received_at)} · ${kg(c.weight_kg, 1)} kg</dd><dt>Status</dt><dd>${chip(c.status)}</dd>
        <dt>Packed</dt><dd>${kg(packed)} kg in ${live.length} units${num(c.weight_kg) ? ` · ${(packed / num(c.weight_kg) * 100).toFixed(1)}% yield` : ''}</dd>
        <dt>Wastage</dt><dd>${waste.length ? waste.map(w => `${kg(w.weight_kg, 2)} kg ${esc((WASTE[w.kind] || w.kind).toLowerCase())}`).join(' · ') : '–'}</dd>
        <dt>Arrived</dt><dd>${c.source === 'trader' ? 'From a trader' : c.source === 'own_farm' ? 'From our farm' : '–'}${c.arrival_temp_c != null ? ` · ${num(c.arrival_temp_c).toFixed(1)} °C` : ''}</dd>
        <dt>Butcher</dt><dd>${esc(y?.butcher || '–')}</dd>
        <dt>Complaints</dt><dd>${comps.length ? `<span class="chip bad">${comps.length}</span>` : '–'}</dd>
        <dt>Shrinkage</dt><dd>${y && y.shrink_kg != null ? `${kg(y.shrink_kg, 2)} kg (${pct(y.shrink_pct)})` : 'Worked out when the carcass is finished'}</dd>
        <dt>Orders</dt><dd>${orders.length ? orders.map(orderLink).join(', ') : '–'}</dd>
      </dl>
      ${Object.keys(byProduct).length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">kg</th><th class="num">In stock</th></tr></thead><tbody>${Object.entries(byProduct).map(([n, p]) => `<tr><td>${esc(n)}</td><td class="num">${p.n}</td><td class="num">${kg(p.kg)}</td><td class="num">${p.stock}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>
    <div class="panel"><h3>Units from this carcass</h3>
      <div class="btns admin-only" style="margin-bottom:8px"><button class="btn small danger" type="button" data-del-carcass="${esc(c.no)}">Delete carcass ${esc(c.no)}</button></div>
      ${trays.length ? `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Product</th><th class="num">kg</th><th>Consume before</th><th>Status</th></tr></thead><tbody>${trays.map(t => `<tr><td class="code">${esc(t.code)}</td><td>${esc(t.product_name)}${carcassNos(t).length > 1 ? ` <span class="chip">batch of ${carcassNos(t).length}</span>` : ''}</td><td class="num">${kg(t.weight_kg, 3)}</td><td>${showYmd(t.use_by)}</td><td>${chip(t.status)} ${orderLink(t.order_ref)}${t.write_off_reason ? ` <span class="hint">${esc(t.write_off_reason)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No units from this carcass yet.</p>'}
    </div></div>`;
}
async function runTrace(q) {
  const out = $('tOut');
  out.innerHTML = '<p class="empty">Searching…</p>';
  try {
    const t = await api.trayByCode(q);
    if (t) {
      let html = `<div class="panel" style="margin-bottom:18px"><h3>Unit</h3><span class="big-code">${esc(t.code)}</span><dl class="kv"><dt>Product</dt><dd>${esc(t.product_name)}</dd><dt>Weight</dt><dd>${kg(t.weight_kg, 3)} kg</dd><dt>Packed</dt><dd>${when(t.packed_at)}</dd><dt>Consume before</dt><dd>${showYmd(t.use_by)}</dd><dt>Status</dt><dd>${chip(t.status)} ${t.order_ref ? 'on order ' + orderLink(t.order_ref) + ' · ' + when(t.sold_at) : ''}${t.write_off_reason ? esc(t.write_off_reason) : ''}</dd><dt>From</dt><dd class="code">${carcassNos(t).map(esc).join(', ')}</dd>${t.made_from ? `<dt>Reproduced from</dt><dd>${t.made_from.map(x => `<a href="#" class="code" data-trace="${esc(x)}">${esc(x)}</a>`).join(', ')}</dd>` : ''}</dl></div>`;
      html += complaintList(await safeComplaints({ trayCode: t.code }));
      if (['sold', 'returned'].includes(t.status)) html += complaintForm({ tray_code: t.code, order_ref: t.order_ref });
      for (const c of t.carcasses) { const cc = await api.carcassByNo(c.no); if (cc) html += await carcassBlock(cc); }
      out.innerHTML = html; return;
    }
    const c = await api.carcassByNo(q.toUpperCase());
    if (c) { out.innerHTML = await carcassBlock(c); return; }
    const o = await api.order(q);
    if (o) {
      const trays = await api.traysForOrder(o.ref);
      const whole = await (api.carcassesForOrder ? api.carcassesForOrder(o.ref) : []);
      out.innerHTML = `<div class="panel"><h3>${o.channel === 'online' ? 'Zid order' : 'Counter sale'}</h3><span class="big-code">${esc(o.ref)}</span>
        <dl class="kv"><dt>Date</dt><dd>${when(o.created_at)}</dd>${o.customer_name ? `<dt>Customer</dt><dd>${esc(o.customer_name)}</dd>` : ''}<dt>Summary</dt><dd class="code">${esc(o.trace_summary || '')}</dd>${o.channel === 'online' ? `<dt>On Zid</dt><dd>${o.zid_comment_posted ? 'Comment added' : 'Not sent yet'}</dd>` : ''}</dl>
        <div class="table-wrap"><table><thead><tr><th>Item</th><th>Carcass</th><th>Ear tag</th><th class="num">kg</th></tr></thead><tbody>
        ${trays.map(t => `<tr><td>${esc(t.product_name)}<div class="hint code">${esc(t.code)}</div></td><td>${t.carcasses.map(c => `<a href="#" class="code" data-trace="${esc(c.no)}">${esc(c.no)}</a>`).join('<br>')}</td><td>${t.carcasses.map(c => esc(c.ear_tag || '–')).join('<br>')}</td><td class="num">${kg(t.weight_kg, 3)}</td></tr>`).join('')}
        ${whole.map(c => `<tr><td>Whole ${esc(c.species.toLowerCase())}</td><td><a href="#" class="code" data-trace="${esc(c.no)}">${esc(c.no)}</a></td><td>${esc(c.ear_tag || '–')}</td><td class="num">${kg(c.weight_kg, 1)}</td></tr>`).join('')}
        </tbody></table></div></div>` + complaintList(await safeComplaints({ orderRef: o.ref })) + complaintForm({ order_ref: o.ref });
      return;
    }
    const tagged = await api.carcassesByEarTag(q);
    if (tagged.length) { let html = ''; for (const x of tagged) html += await carcassBlock(x); out.innerHTML = html; return; }
    out.innerHTML = `<div class="msg err">Nothing found for ${esc(q)}. Check the unit label, carcass number, order number or ear tag.</div>`;
  } catch (err) { out.innerHTML = `<div class="msg err">${esc(errText(err))}</div>`; }
}

$('tOut').addEventListener('click', async e => {
  const b = e.target.closest('[data-del-carcass]'); if (!b) return;
  const no = b.dataset.delCarcass;
  if (!(await ask(`Delete carcass ${no}?`, '<p>The carcass and every unit made only from it are deleted. This cannot be undone.</p>', 'Yes, delete it'))) return;
  try {
    const n = await api.deleteCarcass(no);
    $('tOut').innerHTML = `<div class="msg ok">${esc(no)} deleted, with ${n} unit(s) made only from it.</div>`;
  } catch (err) { $('tOut').insertAdjacentHTML('afterbegin', `<div class="msg err">${esc(errText(err))}</div>`); }
});

/* ---------------- end-of-day stock check ---------------- */
const check = { on: false, codes: new Set(), expected: new Set(), extra: [] };
function renderCheck() {
  const found = [...check.codes].filter(c => check.expected.has(c)).length;
  $('ckStats').innerHTML = `<div class="stat"><b>${check.codes.size}</b><span>Scanned</span></div><div class="stat"><b>${found}</b><span>of ${check.expected.size} expected</span></div><div class="stat"><b style="color:var(--bad)">${check.expected.size - found}</b><span>Not scanned yet</span></div><div class="stat"><b style="color:var(--warn)">${check.extra.length}</b><span>Not in stock</span></div>`;
}
$('ckStart').addEventListener('click', async () => {
  try {
    const trays = await api.inStockTrays();
    Object.assign(check, { on: true, codes: new Set(), expected: new Set(trays.map(t => t.code)), extra: [] });
    $('ckWork').hidden = false; $('ckStart').hidden = true; $('ckResult').innerHTML = ''; msg($('ckMsg'), '');
    renderCheck(); $('ckScan').focus();
  } catch (err) { msg($('ckMsg'), errText(err), 'err'); }
});
onEnter($('ckScan'), v => {
  if (check.codes.has(v)) { msg($('ckMsg'), `${v} is already counted.`, 'warn'); return; }
  check.codes.add(v);
  if (!check.expected.has(v)) { check.extra.push(v); msg($('ckMsg'), `${v} should not be on the shelf: it is not in stock. Put it aside and trace it.`, 'warn'); }
  else msg($('ckMsg'), `Counted ${v}.`, 'ok');
  renderCheck();
});
$('ckCancel').addEventListener('click', () => { check.on = false; $('ckWork').hidden = true; $('ckStart').hidden = false; });
$('ckFinish').addEventListener('click', async () => {
  const found = [...check.codes].filter(c => check.expected.has(c)).length;
  if (!(await ask('Finish the stock check?', `<p>${found} of ${check.expected.size} units scanned.${check.expected.size - found ? ` <strong>${check.expected.size - found} not scanned</strong> will be listed as missing.` : ''}</p>`, 'Yes, finish'))) return;
  try {
    const r = await api.saveStockCheck([...check.codes]);
    check.on = false; $('ckWork').hidden = true; $('ckStart').hidden = false;
    const missing = r.missing || [], extra = r.unexpected || [];
    msgHtml($('ckResult'), `<strong>Stock check saved.</strong> ${r.found} of ${r.expected} units found.${missing.length ? ` <strong>${missing.length} missing:</strong> <span class="code">${missing.map(esc).join(', ')}</span>.` : ' Nothing is missing.'}${extra.length ? ` Scanned but not in stock: <span class="code">${extra.map(esc).join(', ')}</span>.` : ''}${missing.length ? '<div class="btns admin-only" style="margin-top:8px"><button class="btn danger" type="button" id="ckWriteOff">Take the missing units out of stock</button></div>' : ''}`, missing.length ? 'warn' : 'ok');
    const b = $('ckWriteOff');
    if (b) b.addEventListener('click', async () => {
      if (!(await ask(`Take the ${missing.length} missing unit${missing.length > 1 ? 's' : ''} out of stock?`, '<p>Reason: missing at stock check. This cannot be undone.</p>', 'Yes, take them out'))) return;
      try { const n = await api.writeOff(missing, 'Missing at stock check'); b.replaceWith(Object.assign(document.createElement('span'), { textContent: `${n} unit(s) taken out of stock.` })); loaders.stock(); }
      catch (err) { msg($('ckMsg'), errText(err), 'err'); }
    });
    loaders.stock();
  } catch (err) { msg($('ckMsg'), errText(err), 'err'); }
});

/* ---------------- recall ---------------- */
let recallRows = [];
function renderRecall() {
  $('rcRows').innerHTML = recallRows.map(r => `<tr><td class="code"><a href="#" data-trace="${esc(r.order)}">${esc(r.order)}</a></td><td>${r.channel === 'online' ? 'Online' : 'Counter'}</td><td>${esc(r.date)}</td><td>${esc(r.customer || '')}</td><td>${esc(r.phone || '')}</td><td>${esc(r.items)}</td><td class="code">${esc(r.carcasses)}</td><td class="num">${kg(r.kg, 2)}</td></tr>`).join('');
  $('rcZid').disabled = !recallRows.length; $('rcXl').disabled = !recallRows.length;
}
$('rcForm').addEventListener('submit', async e => {
  e.preventDefault();
  const nos = $('rcNos').value.split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
  const farm = $('rcFarm').value.trim();
  if (!farm && !nos.length) { msg($('rcMsg'), 'Enter a farm or trader, or carcass numbers.', 'err'); return; }
  try {
    const r = await api.recall(farm, $('rcFrom').value, $('rcTo').value, nos);
    recallRows = r.orders || [];
    msg($('rcMsg'), `${r.carcasses} carcass(es) match. ${recallRows.length} order(s) got meat from them.${r.units_in_stock ? ` ${r.units_in_stock} unit(s) from them are still in stock: ${r.in_stock_codes.join(', ')}. Take them off the shelf.` : ''}`, r.units_in_stock ? 'warn' : 'ok');
    renderRecall();
  } catch (err) { msg($('rcMsg'), errText(err), 'err'); }
});
$('rcZid').addEventListener('click', async () => {
  $('rcZid').disabled = true;
  let done = 0, failed = 0;
  for (const r of recallRows) {
    if (r.phone || !/^\d+$/.test(r.order)) continue;
    msg($('rcMsg'), `Getting contacts from Zid… ${done + failed + 1} of ${recallRows.length}`);
    try { const o = await api.zid('get_order', { order_id: r.order }); r.customer = o.customer || r.customer; r.phone = o.phone || ''; done++; }
    catch (_) { failed++; }
    renderRecall();
  }
  msg($('rcMsg'), `Contacts loaded for ${done} order(s).${failed ? ` ${failed} could not be read from Zid.` : ''} Counter sales without a Zid order number have no contact.`, failed ? 'warn' : 'ok');
  $('rcZid').disabled = false;
});
$('rcXl').addEventListener('click', () => {
  if (!window.XLSX) { msg($('rcMsg'), 'The Excel library did not load. Check the internet connection and reload.', 'err'); return; }
  const wb = window.XLSX.utils.book_new();
  const rows = recallRows.map(r => ({ Order: r.order, Channel: r.channel === 'online' ? 'Online' : 'Counter', Date: r.date, Customer: r.customer || '', Phone: r.phone || '', Items: r.items, Carcasses: r.carcasses, kg: num(r.kg) }));
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rows), 'Recall');
  window.XLSX.writeFile(wb, `Meatrix recall ${$('rcFarm').value.trim() || 'carcasses'} ${ymdLocal()}.xlsx`);
});

/* ---------------- settings ---------------- */
loaders.settings = async () => {
  const s = state.settings;
  $('stW').value = s.label_width_mm; $('stH').value = s.label_height_mm; $('stCW').value = s.carcass_label_width_mm ?? 100; $('stCH').value = s.carcass_label_height_mm ?? 100; $('stWarn').value = s.expiry_warning_days; $('stTz').value = s.timezone; $('stTemp').value = s.max_arrival_temp_c ?? 7;
  $('zConnect').href = api.zidConnectUrl ? api.zidConnectUrl() : '#';
  renderProductSettings();
  renderSpeciesSettings();
  renderButcherSettings();
  loadStaff();
  try {
    const z = await api.zid('status');
    $('zStatus').textContent = z.connected ? `Connected${z.updated_at ? ' since ' + when(z.updated_at) : ''}.` : 'Not connected yet. Press "Connect Zid" and approve the app in Zid.';
  } catch (err) { $('zStatus').textContent = 'Zid connection is not set up yet (' + errText(err) + ').'; }
};
function renderProductSettings() {
  const q = $('prSearch').value.trim().toLowerCase();
  const list = state.products.filter(p => !q || [p.name, p.name_ar, p.sku, p.barcode].some(v => v && String(v).toLowerCase().includes(q)));
  $('prEmpty').hidden = list.length > 0;
  $('prRows').innerHTML = list.map(p => `<tr data-pid="${esc(p.id)}">
    <td>${esc(p.name)}${p.zid_product_id ? ' <span class="chip">Zid</span>' : ''}</td>
    <td class="code">${esc(p.barcode || p.sku || '')}</td>
    <td><select data-f="species"><option value="">Any</option>${state.species.map(s => `<option ${p.species === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></td>
    <td><input data-f="fixed_weight_kg" type="number" step="0.001" min="0" value="${p.fixed_weight_kg ?? ''}" style="width:90px" aria-label="Fixed weight in kg"></td>
    <td><input data-f="min_weight_kg" type="number" step="0.001" min="0" value="${p.min_weight_kg ?? ''}" style="width:80px" aria-label="Minimum kg"></td>
    <td><input data-f="max_weight_kg" type="number" step="0.001" min="0" value="${p.max_weight_kg ?? ''}" style="width:80px" aria-label="Maximum kg"></td>
    <td><input data-f="shelf_life_days" type="number" min="0" max="365" value="${p.shelf_life_days}" style="width:70px" aria-label="Shelf life in days"></td>
    <td><input data-f="quick" type="checkbox" ${p.quick ? 'checked' : ''} aria-label="Show as button"></td>
    <td><input data-f="active" type="checkbox" ${p.active ? 'checked' : ''} aria-label="In use"></td></tr>`).join('');
}
$('prSearch').addEventListener('input', renderProductSettings);
$('prRows').addEventListener('change', async e => {
  const el = e.target.closest('[data-f]'), tr = e.target.closest('[data-pid]'); if (!el || !tr) return;
  const f = el.dataset.f;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (f === 'species') v = v || null;
  if (['fixed_weight_kg', 'min_weight_kg', 'max_weight_kg'].includes(f)) v = num(v) > 0 ? num(v) : null;
  if (f === 'shelf_life_days') v = Math.max(0, parseInt(v, 10) || 0);
  try {
    const saved = await api.saveProduct(tr.dataset.pid, { [f]: v });
    Object.assign(state.productsById[tr.dataset.pid], saved);
    msg($('prMsg'), `Saved ${saved.name}.`, 'ok');
  } catch (err) { msg($('prMsg'), errText(err), 'err'); }
});
$('prAdd').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const p = await api.addProduct({ name: $('prName').value.trim(), barcode: $('prBarcode').value.trim() || null });
    $('prName').value = ''; $('prBarcode').value = '';
    await loadProducts(); renderProductSettings(); msg($('prMsg'), `Added ${p.name}. Set its animal, weight and shelf life above.`, 'ok');
  } catch (err) { msg($('prMsg'), errText(err), 'err'); }
});
$('zSync').addEventListener('click', async () => {
  $('zSync').disabled = true; msg($('zMsg'), 'Loading products from Zid…');
  try { const r = await api.zid('sync_products'); await loadProducts(); renderProductSettings(); msg($('zMsg'), `Loaded ${r.synced} products from Zid. Set their animal, weight and shelf life below.`, 'ok'); }
  catch (err) { msg($('zMsg'), 'Zid: ' + errText(err), 'err'); }
  $('zSync').disabled = false;
});
function renderButcherSettings() {
  $('buRows').innerHTML = state.butchers.map(b => `<tr data-bu="${esc(b.id)}"><td><input data-f="name" value="${esc(b.name)}" aria-label="Name"></td><td><input data-f="active" type="checkbox" ${b.active ? 'checked' : ''} aria-label="Working here"></td></tr>`).join('');
}
$('buRows').addEventListener('change', async e => {
  const el = e.target.closest('[data-f]'), tr = e.target.closest('[data-bu]'); if (!el || !tr) return;
  const v = el.type === 'checkbox' ? el.checked : el.value.trim();
  if (v === '') return;
  try { await api.saveButcher(tr.dataset.bu, { [el.dataset.f]: v }); await loadButchers(); renderButcherSettings(); msg($('buMsg'), 'Saved.', 'ok'); }
  catch (err) { msg($('buMsg'), errText(err), 'err'); }
});
$('buAdd').addEventListener('submit', async e => {
  e.preventDefault();
  try { const b = await api.addButcher($('buName').value.trim()); $('buName').value = ''; await loadButchers(); renderButcherSettings(); msg($('buMsg'), `Added ${b.name}. They can pick their name in the cutting room now.`, 'ok'); }
  catch (err) { msg($('buMsg'), errText(err), 'err'); }
});
function renderSpeciesSettings() {
  $('spRows').innerHTML = state.species.map(s => `<tr data-sp="${esc(s.name)}">
    <td><b>${esc(s.name)}</b></td>
    <td><input data-f="name_ar" value="${esc(s.name_ar || '')}" dir="rtl" style="width:120px" aria-label="Arabic name"></td>
    <td class="code">${esc(s.prefix)}</td>
    <td><input data-f="chiller_days" type="number" min="0" max="60" value="${s.chiller_days}" style="width:70px" aria-label="Chiller days"></td>
    <td><input data-f="active" type="checkbox" ${s.active ? 'checked' : ''} aria-label="In use"></td></tr>`).join('');
}
$('spRows').addEventListener('change', async e => {
  const el = e.target.closest('[data-f]'), tr = e.target.closest('[data-sp]'); if (!el || !tr) return;
  const f = el.dataset.f;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (f === 'chiller_days') v = Math.max(0, parseInt(v, 10) || 0);
  if (f === 'name_ar') v = v.trim() || null;
  try { await api.saveSpecies(tr.dataset.sp, { [f]: v }); await loadSpecies(); msg($('spMsg'), `Saved ${tr.dataset.sp}. New carcasses use it from now on.`, 'ok'); }
  catch (err) { msg($('spMsg'), errText(err), 'err'); }
});
$('spAdd').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('spName').value.trim(), prefix = $('spPrefix').value.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(prefix)) { msg($('spMsg'), 'Letters must be 1 to 3 English capital letters.', 'err'); return; }
  try {
    await api.addSpecies({ name, prefix, chiller_days: 5, sort: state.species.length + 1 });
    $('spName').value = ''; $('spPrefix').value = '';
    await loadSpecies(); renderSpeciesSettings(); renderProductSettings();
    msg($('spMsg'), `Added ${name}. Set its chiller days above.`, 'ok');
  } catch (err) { msg($('spMsg'), errText(err), 'err'); }
});
async function loadStaff() {
  try {
    const rows = await api.staffList();
    $('stfRows').innerHTML = rows.map(r => `<tr data-uid="${esc(r.user_id)}"><td>${esc(r.email || '')}</td>
      <td><select data-role aria-label="Role"><option value="staff" ${r.role === 'staff' ? 'selected' : ''}>Staff</option><option value="admin" ${r.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
      <td>${r.user_id === state.me.id ? '<span class="hint">You</span>' : '<button class="btn small danger" type="button" data-rm-staff>Remove</button>'}</td></tr>`).join('');
  } catch (err) { msg($('stfMsg'), errText(err), 'err'); }
}
$('stfRows').addEventListener('change', async e => {
  const sel = e.target.closest('[data-role]'), tr = e.target.closest('[data-uid]'); if (!sel || !tr) return;
  try { await api.setStaffRole(tr.dataset.uid, sel.value); msg($('stfMsg'), 'Role saved.', 'ok'); }
  catch (err) { msg($('stfMsg'), errText(err), 'err'); }
  loadStaff();
});
$('stfRows').addEventListener('click', async e => {
  const b = e.target.closest('[data-rm-staff]'), tr = e.target.closest('[data-uid]'); if (!b || !tr) return;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to remove'; return; }
  try { await api.removeStaff(tr.dataset.uid); msg($('stfMsg'), 'Login removed.', 'ok'); }
  catch (err) { msg($('stfMsg'), errText(err), 'err'); }
  loadStaff();
});
$('stfAdd').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api.createStaff($('stfEmail').value.trim(), $('stfPass').value, $('stfRole').value);
    msg($('stfMsg'), `Added ${r.email} as ${r.role}. They can sign in now.`, 'ok');
    $('stfEmail').value = ''; $('stfPass').value = '';
  } catch (err) { msg($('stfMsg'), errText(err), 'err'); }
  loadStaff();
});

$('stSave').addEventListener('click', async () => {
  try {
    state.settings = await api.saveSettings({
      label_width_mm: parseInt($('stW').value, 10) || 50, label_height_mm: parseInt($('stH').value, 10) || 30,
      expiry_warning_days: parseInt($('stWarn').value, 10) || 0, timezone: $('stTz').value.trim() || 'Asia/Riyadh',
      ...('carcass_label_width_mm' in state.settings ? { carcass_label_width_mm: parseInt($('stCW').value, 10) || 100, carcass_label_height_mm: parseInt($('stCH').value, 10) || 100 } : {}),
      ...('max_arrival_temp_c' in state.settings ? { max_arrival_temp_c: $('stTemp').value === '' ? 7 : num($('stTemp').value) } : {})
    });
    msg($('stMsg'), 'Saved.', 'ok');
  } catch (err) { msg($('stMsg'), errText(err), 'err'); }
});
$('stTestC').addEventListener('click', () => {
  try {
    print([{ kind: 'carcass', data: { no: 'N0101-01', species: 'Naeemi', species_ar: 'نعيمي', ear_tag: '2231', farm: 'Test farm', received_at: new Date().toISOString(), chiller_use_by: addDays(5) } }]);
    msg($('stMsg'), 'Test carcass label sent to the printer.', 'ok');
  } catch (err) { msg($('stMsg'), errText(err), 'err'); }
});
$('stTest').addEventListener('click', () => {
  try {
    print([{ kind: 'tray', data: { code: 'T0000000', product_name: 'Test label · Naeemi leg', product_name_ar: 'فخذ نعيمي', weight_kg: 1, use_by: addDays(3), packed_at: new Date().toISOString(), carcasses: [{ no: 'N0101-01' }] } }]);
    msg($('stMsg'), 'Test label sent to the printer.', 'ok');
  } catch (err) { msg($('stMsg'), errText(err), 'err'); }
});

start().catch(err => { document.body.insertAdjacentHTML('afterbegin', `<div class="msg err">${esc(errText(err))}</div>`); });
