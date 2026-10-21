// Data access for The Meatrix. Every screen talks to the database through these functions.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}
const TRAY_WITH_CARCASSES = '*, tray_carcasses(carcasses(id, no, species, ear_tag, farm, slaughterhouse, kill_no))';
const flattenTray = t => t && ({ ...t, carcasses: (t.tray_carcasses || []).map(x => x.carcasses).filter(Boolean) });

export const api = {
  // --- sign in ---
  async session() { return check(await sb.auth.getSession()).session; },
  onAuth(cb) { return sb.auth.onAuthStateChange((_e, s) => cb(s)); },
  async signIn(email, password) { return check(await sb.auth.signInWithPassword({ email, password })); },
  async signOut() { await sb.auth.signOut(); },

  // --- staff and roles ---
  async myRole() {
    const { data: { user } } = await sb.auth.getUser();
    const row = user ? check(await sb.from('staff').select('role').eq('user_id', user.id).maybeSingle()) : null;
    return { id: user?.id, role: row?.role || 'staff' };
  },
  async staffList() { return check(await sb.from('staff').select('*').order('created_at')); },
  async setStaffRole(userId, role) { return check(await sb.rpc('set_staff_role', { p_user_id: userId, p_role: role })); },
  async createStaff(email, password, role) { return this.zid('create_staff', { email, password, role }); },
  async removeStaff(userId) { return this.zid('delete_staff', { user_id: userId }); },

  // --- settings ---
  async settings() { return check(await sb.from('settings').select('*').eq('id', 1).single()); },
  async saveSettings(patch) { return check(await sb.from('settings').update(patch).eq('id', 1).select().single()); },

  // --- animals ---
  async species() { return check(await sb.from('species').select('*').order('sort').order('name')); },
  async saveSpecies(name, patch) { return check(await sb.from('species').update(patch).eq('name', name).select().single()); },
  async addSpecies(row) { return check(await sb.from('species').insert(row).select().single()); },

  // --- butchers ---
  async butchers() { return check(await sb.from('butchers').select('*').order('name')); },
  async addButcher(name) { return check(await sb.from('butchers').insert({ name }).select().single()); },
  async saveButcher(id, patch) { return check(await sb.from('butchers').update(patch).eq('id', id).select().single()); },

  // --- returns and complaints ---
  async recordComplaint(c) {
    return check(await sb.rpc('record_complaint', { p_kind: c.kind, p_reason: c.reason, p_tray_code: c.tray_code || null, p_order_ref: c.order_ref || null, p_notes: c.notes || null, p_unit_returned: !!c.unit_returned }));
  },
  async complaintsFor({ trayCode, orderRef, carcassNo }) {
    let q = sb.from('complaints').select('*').order('created_at', { ascending: false }).limit(50);
    if (trayCode) q = q.eq('tray_code', trayCode);
    if (orderRef) q = q.eq('order_ref', orderRef);
    if (carcassNo) q = q.contains('carcass_nos', [carcassNo]);
    return check(await q);
  },

  // --- stock check and recall ---
  async saveStockCheck(codes) { return check(await sb.rpc('save_stock_check', { p_scanned: codes })); },
  async lastStockChecks(limit = 5) { return check(await sb.from('stock_checks').select('*').order('checked_at', { ascending: false }).limit(limit)); },
  async recall(farm, from, to, nos) { return check(await sb.rpc('recall_orders', { p_farm: farm || null, p_from: from || null, p_to: to || null, p_carcass_nos: nos && nos.length ? nos : null })); },

  // --- products ---
  async products() { return check(await sb.from('products').select('*').order('name')); },
  async saveProduct(id, patch) { return check(await sb.from('products').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single()); },
  async addProduct(p) { return check(await sb.from('products').insert(p).select().single()); },

  // --- carcasses ---
  async registerCarcass(f) {
    return check(await sb.rpc('register_carcass', {
      p_species: f.species, p_weight_kg: f.weight_kg, p_ear_tag: f.ear_tag, p_farm: f.farm,
      p_slaughterhouse: f.slaughterhouse, p_kill_no: f.kill_no, p_notes: f.notes,
      p_arrival_temp_c: f.arrival_temp_c ?? null, p_source: f.source || null
    }));
  },
  async openCarcasses() {
    return check(await sb.from('carcass_yield').select('*').in('status', ['in_chiller', 'cutting']).order('received_at', { ascending: false }));
  },
  async carcassYield(limit = 200) {
    return check(await sb.from('carcass_yield').select('*').order('received_at', { ascending: false }).limit(limit));
  },
  async carcassByNo(no) { return check(await sb.from('carcasses').select('*').eq('no', no).maybeSingle()); },
  async carcassesByEarTag(tag) { return check(await sb.from('carcasses').select('*').eq('ear_tag', tag)); },
  async recentFarms() {
    const rows = check(await sb.from('carcasses').select('farm, slaughterhouse').order('received_at', { ascending: false }).limit(300));
    return { farms: [...new Set(rows.map(r => r.farm).filter(Boolean))], slaughterhouses: [...new Set(rows.map(r => r.slaughterhouse).filter(Boolean))] };
  },
  async finishCarcass(id, butcherId) { return check(await sb.rpc('finish_carcass', { p_id: id, p_butcher_id: butcherId || null })); },
  async deleteCarcass(no) { return check(await sb.rpc('delete_carcass', { p_no: no })); },
  async carcassYieldOne(id) { return check(await sb.from('carcass_yield').select('*').eq('id', id).maybeSingle()); },

  // --- wastage ---
  async recordWaste(carcassId, kind, weightKg, butcherId) { return check(await sb.rpc('record_waste', { p_carcass_id: carcassId, p_kind: kind, p_weight_kg: weightKg, p_butcher_id: butcherId || null })); },
  async wasteForCarcass(carcassId) { return check(await sb.from('carcass_waste').select('*').eq('carcass_id', carcassId).order('recorded_at', { ascending: false })); },
  async deleteWaste(id) { return check(await sb.rpc('delete_waste', { p_id: id })); },

  // --- trays ---
  async createTrays(productId, carcassIds, count, weightKg, butcherId) {
    return check(await sb.rpc('create_trays', { p_product_id: productId, p_carcass_ids: carcassIds, p_count: count, p_weight_kg: weightKg ?? null, p_butcher_id: butcherId || null }));
  },
  async traysForCarcass(carcassId) {
    const rows = check(await sb.from('tray_carcasses').select(`trays(${TRAY_WITH_CARCASSES})`).eq('carcass_id', carcassId));
    return rows.map(r => flattenTray(r.trays)).filter(Boolean).sort((a, b) => b.packed_at.localeCompare(a.packed_at));
  },
  async reproduceTrays(codes, productId, count, weightKg, butcherId) {
    return check(await sb.rpc('reproduce_trays', { p_codes: codes, p_product_id: productId, p_count: count, p_weight_kg: weightKg ?? null, p_butcher_id: butcherId || null }));
  },
  async trayByCode(code) { return flattenTray(check(await sb.from('trays').select(TRAY_WITH_CARCASSES).eq('code', code).maybeSingle())); },
  async carcassesForOrder(ref) { return check(await sb.from('carcasses').select('*').eq('order_ref', ref)); },
  async traysForOrder(ref) { return check(await sb.from('trays').select(TRAY_WITH_CARCASSES).eq('order_ref', ref)).map(flattenTray); },
  async voidTray(code) { return check(await sb.rpc('void_tray', { p_code: code })); },
  async writeOff(codes, reason) { return check(await sb.rpc('write_off_trays', { p_codes: codes, p_reason: reason })); },
  async stockByProduct() { return check(await sb.from('stock_by_product').select('*').order('product_name')); },
  async inStockTrays() {
    return check(await sb.from('trays').select(TRAY_WITH_CARCASSES).eq('status', 'in_stock').order('use_by').limit(2000)).map(flattenTray);
  },

  // --- live dashboard ---
  async dashboard() { return check(await sb.rpc('dashboard')); },
  async exportData(from, to) { return check(await sb.rpc('export_data', { p_from: from, p_to: to })); },

  // --- sales ---
  async sellItems(codes, channel, orderRef, customer) {
    return check(await sb.rpc('sell_items', { p_codes: codes, p_channel: channel, p_order_ref: orderRef || null, p_customer_name: customer || null }));
  },
  async order(ref) { return check(await sb.from('orders').select('*').eq('ref', ref).maybeSingle()); },
  async linkCounterSale(ref, zidRef) { return check(await sb.rpc('link_counter_sale', { p_ref: ref, p_zid_ref: zidRef })); },
  async ordersByRefs(refs) { return refs.length ? check(await sb.from('orders').select('ref').in('ref', refs)) : []; },
  async traysForOrders(refs) { return refs.length ? check(await sb.from('trays').select('order_ref, product_id, product_name, weight_kg').in('order_ref', refs)) : []; },
  async recentOrders(channel, limit = 15) {
    return check(await sb.from('orders').select('*').eq('channel', channel).order('created_at', { ascending: false }).limit(limit));
  },

  // --- Zid (through the server function, which keeps the Zid keys secret) ---
  async zid(action, payload = {}) {
    const { data, error } = await sb.functions.invoke('zid', { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  },
  zidConnectUrl() { return `${SUPABASE_URL}/functions/v1/zid?action=oauth_start`; }
};
