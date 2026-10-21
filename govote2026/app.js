'use strict';

const CFG = window.GOVOTE_CONFIG;
const SLOTS = [['09-11', '09:00–11:00'], ['11-13', '11:00–13:00'], ['13-15', '13:00–15:00'], ['15-17', '15:00–17:00']];
const SLOT_LABEL = Object.fromEntries(SLOTS);
const slotsText = slots => slots.map(s => `<bdi dir="ltr">${SLOT_LABEL[s] || esc(s)}</bdi>`).join(' · ');
const COLORS = { free: '#dc2626', claimed: '#2563eb', in_progress: '#eab308', done: '#16a34a' };
const STATUS_TEXT = { free: 'פנוי – עדיין לא נתפס', claimed: 'נתפס', in_progress: 'בסיבוב עכשיו', done: 'הושלם ✓' };
const ERRORS = {
  already_claimed: 'מישהו אחר תפס את הבלוק הזה ממש עכשיו. נסו בלוק סמוך.',
  bad_names: 'נא למלא שם (2–80 תווים).',
  bad_phone: 'מספר הטלפון לא תקין.',
  bad_slots: 'בחרו לפחות משמרת אחת.',
  too_many_for_phone: `אפשר לתפוס עד ${CFG.maxClaimsPerPhone} בלוקים לכל מספר טלפון.`,
  busy: 'יש עומס רגעי, נסו שוב בעוד דקה.',
  not_live: 'הסימון נפתח רק ביום הבחירות.',
  not_allowed: 'לא הצלחנו לאמת שזה הבלוק שלכם. בדקו את מספר הטלפון.',
  bad_status: 'מצב הבלוק השתנה. רעננו את הדף.',
  no_such_block: 'בלוק לא קיים.',
};

const SIM = Boolean(CFG.simulate);  // election-day demo: fake data, nothing is saved
const DATA = CFG.dataBase || '';
const params = new URLSearchParams(location.search);

// ---------- backend: Supabase, or an in-memory stand-in for the simulation ----------
function supabaseApi() {
  const sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  return {
    claims: () => sb.from('claims').select('*'),
    settings: () => sb.from('settings').select('live_from').maybeSingle(),
    rpc: (fn, args) => sb.rpc(fn, args),
    subscribe: handler => sb.channel('claims-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, handler).subscribe(),
  };
}

function simulatedApi() {
  const rows = {};
  const ok = data => ({ data: data ?? null, error: null });
  const fail = message => ({ data: null, error: { message } });
  const NAMES = ['נועה ודני', 'מיכל', 'יואב ורונית', 'אבי', 'תמר', 'עומר ושירה', 'רחל', 'משפחת לוי', 'גיל', 'הדס ואורי'];
  return {
    seed(ids) {
      let x = 7;
      const rand = () => (x = (x * 9301 + 49297) % 233280) / 233280;
      ids.forEach((id, i) => {
        const r = rand();
        if (r < 0.3) return;  // stays free
        const status = r < 0.55 ? 'claimed' : r < 0.75 ? 'in_progress' : 'done';
        const slot = SLOTS[Math.floor(rand() * SLOTS.length)][0];
        rows[id] = { block_id: id, names: NAMES[i % NAMES.length], slots: [slot], status };
      });
    },
    claims: async () => ok(Object.values(rows).map(r => ({ ...r }))),
    settings: async () => ok(null),
    subscribe() {},
    async rpc(fn, a) {
      const r = rows[a.p_block_id];
      switch (fn) {
        case 'claim_block':
          if (r) return fail('already_claimed');
          rows[a.p_block_id] = { block_id: a.p_block_id, names: a.p_names, slots: [...a.p_slots].sort(), status: 'claimed' };
          return ok('sim');
        case 'start_round':
          if (!r || r.status !== 'claimed') return fail('bad_status');
          r.status = 'in_progress'; return ok();
        case 'mark_done':
          if (!r || r.status === 'done') return fail('bad_status');
          r.status = 'done'; return ok();
        case 'reopen_round':
          if (!r || r.status !== 'done') return fail('bad_status');
          r.status = 'in_progress'; return ok();
        case 'release_block':
          if (!r || r.status === 'done') return fail('bad_status');
          delete rows[a.p_block_id]; return ok();
        case 'my_blocks':
          return ok([]);
        default:
          return fail('unknown');
      }
    },
  };
}

const api = SIM ? simulatedApi() : supabaseApi();

const state = {
  blocks: {},        // id -> feature properties
  layers: {},        // id -> leaflet layer
  buildings: {},     // id -> [leaflet layers]
  claims: {},        // id -> claim row
  liveFrom: new Date(CFG.liveFrom),
  pollsClose: new Date(CFG.pollsClose),
  selected: null,
  flash: null,       // {ok, text, until} shown in the sheet for a few seconds
  view: null,        // 'claim' | 'manage' while a form is open
  myIds: new Set(),
};

// ---------- local storage (per-device convenience only) ----------
const memory = {};
const store = SIM ? {
  get: (key, fallback) => (key in memory ? memory[key] : fallback),
  set: (key, value) => { memory[key] = value; },
} : {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};
const tokens = () => store.get('gv26_tokens', {});
function saveToken(id, token) { const t = tokens(); t[id] = token; store.set('gv26_tokens', t); }
function dropToken(id) { const t = tokens(); delete t[id]; store.set('gv26_tokens', t); }
const savedPhone = () => store.get('gv26_phone', '');
const savedNames = () => store.get('gv26_names', '');

// ---------- time ----------
function isLive() {
  if (SIM || params.get('preview') === 'live') return true;
  const now = new Date();
  return now >= state.liveFrom && now < new Date(state.liveFrom.getTime() + 24 * 3600e3);
}

function tickCountdown() {
  const now = new Date();
  const live = isLive();
  document.body.classList.toggle('live', live);
  const boxes = document.getElementById('cd-boxes');
  const label = document.getElementById('cd-label');
  const liveBox = document.getElementById('cd-live');
  let target;
  if (!live && now < state.liveFrom) {
    target = state.liveFrom;
    label.textContent = 'עד יום הבחירות · 27.10.2026';
    liveBox.hidden = true;
  } else if (live && now < state.pollsClose) {
    target = state.pollsClose;
    label.textContent = 'עד סגירת הקלפיות (22:00)';
    liveBox.hidden = false;
    liveBox.textContent = 'היום יום הבחירות! סמנו "מתחיל סיבוב" כשאתם יוצאים ו"סיימתי" בסוף.';
  } else {
    boxes.hidden = true;
    label.textContent = '';
    liveBox.hidden = false;
    liveBox.textContent = live ? 'הקלפיות נסגרו. תודה לכל המתנדבים!' : 'יום הבחירות הסתיים. תודה לכל המתנדבים!';
    return;
  }
  boxes.hidden = false;
  let s = Math.max(0, Math.floor((target - now) / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('cd-d').textContent = d;
  document.getElementById('cd-h').textContent = pad(h);
  document.getElementById('cd-m').textContent = pad(m);
  document.getElementById('cd-s').textContent = pad(s);
}

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true, minZoom: 13, maxZoom: 19, zoomSnap: 0.25 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
map.attributionControl.setPrefix(false);

const statusOf = id => (state.claims[id] ? state.claims[id].status : 'free');

function blockStyle(id) {
  const st = statusOf(id);
  const sel = state.selected === id;
  return { color: sel ? '#111' : COLORS[st], weight: sel ? 3 : 1.2, fillColor: COLORS[st], fillOpacity: sel ? 0.38 : 0.22 };
}
function buildingStyle(id) {
  return { color: COLORS[statusOf(id)], weight: 0.6, fillColor: COLORS[statusOf(id)], fillOpacity: 0.75, interactive: false };
}
function restyle(id) {
  if (state.layers[id]) state.layers[id].setStyle(blockStyle(id));
  (state.buildings[id] || []).forEach(l => l.setStyle(buildingStyle(id)));
}
function restyleAll() { Object.keys(state.blocks).forEach(restyle); renderStats(); }

async function loadGeo() {
  const [blocks, buildings, boundary] = await Promise.all(
    ['blocks.geojson', 'buildings.geojson', 'boundary.geojson'].map(f => fetch(DATA + f).then(r => r.json())));
  L.geoJSON(boundary, { style: { color: '#1f4e79', weight: 2, dashArray: '6 6', fill: false }, interactive: false }).addTo(map);
  const blockLayer = L.geoJSON(blocks, {
    style: f => blockStyle(f.properties.id),
    onEachFeature: (f, layer) => {
      state.blocks[f.properties.id] = f.properties;
      state.layers[f.properties.id] = layer;
      layer.on('click', () => select(f.properties.id));
    },
  }).addTo(map);
  L.geoJSON(buildings, {
    style: f => buildingStyle(f.properties.b),
    interactive: false,
    onEachFeature: (f, layer) => (state.buildings[f.properties.b] ||= []).push(layer),
  }).addTo(map);
  map.fitBounds(blockLayer.getBounds(), { padding: [8, 8] });
  map.setMaxBounds(blockLayer.getBounds().pad(0.6));
  state.area = blockLayer.getBounds().pad(0.15);
  if (SIM) api.seed(blocks.features.map(f => f.properties.id));

  const streets = new Set();
  blocks.features.forEach(f => f.properties.addresses.forEach(a => streets.add(a.street)));
  document.getElementById('streets').innerHTML = [...streets].sort((a, b) => a.localeCompare(b, 'he'))
    .map(s => `<option value="${esc(s)}">`).join('');
}

// ---------- data ----------
async function loadClaims() {
  const { data, error } = await api.claims();
  if (error) { console.warn('claims', error); return; }
  state.claims = Object.fromEntries(data.map(c => [c.block_id, c]));
  restyleAll();
  if (state.selected && !state.view) renderSheet();
}

async function loadSettings() {
  if (SIM) {
    // count down to 22:00 tonight, as on the real day
    const close = new Date();
    close.setHours(22, 0, 0, 0);
    if (close < new Date()) close.setDate(close.getDate() + 1);
    state.pollsClose = close;
    return;
  }
  const { data } = await api.settings();
  if (data && data.live_from) {
    state.liveFrom = new Date(data.live_from);
    state.pollsClose = new Date(state.liveFrom.getTime() + 22 * 3600e3);
  }
}

function subscribe() {
  api.subscribe(payload => {
      if (payload.eventType === 'DELETE') delete state.claims[payload.old.block_id];
      else state.claims[payload.new.block_id] = payload.new;
      const id = payload.eventType === 'DELETE' ? payload.old.block_id : payload.new.block_id;
      restyle(id);
      renderStats();
      if (state.selected === id && !state.view) renderSheet();
  });
}

async function loadMine() {
  state.myIds = new Set(Object.keys(tokens()));
  const phone = savedPhone();
  if (phone) {
    const { data } = await api.rpc('my_blocks', { p_phone: phone });
    (data || []).forEach(id => state.myIds.add(typeof id === 'string' ? id : id.my_blocks));
  }
  // forget tokens for blocks that were released elsewhere
  const btn = document.getElementById('mine-btn');
  const mine = [...state.myIds].filter(id => state.claims[id]);
  btn.hidden = mine.length === 0;
  btn.textContent = `הבלוקים שלי (${mine.length})`;
}

function renderStats() {
  const ids = Object.keys(state.blocks);
  if (!ids.length) return;
  const totalApts = ids.reduce((s, id) => s + state.blocks[id].apartments, 0);
  const sum = st => ids.filter(id => statusOf(id) === st);
  const apts = list => list.reduce((s, id) => s + state.blocks[id].apartments, 0);
  const claimed = sum('claimed'), prog = sum('in_progress'), done = sum('done');
  const taken = claimed.length + prog.length + done.length;
  const pct = n => (100 * n / totalApts).toFixed(0);
  document.getElementById('bar-done').style.width = pct(apts(done)) + '%';
  document.getElementById('bar-prog').style.width = pct(apts(prog)) + '%';
  document.getElementById('bar-claimed').style.width = pct(apts(claimed)) + '%';
  let text = `<b>${taken}</b> מתוך <b>${ids.length}</b> בלוקים נתפסו · <b>${pct(apts(claimed) + apts(prog) + apts(done))}%</b> מ-${totalApts.toLocaleString('he-IL')} הדירות בשכונה`;
  if (isLive()) text += ` · הושלמו <b>${done.length}</b> (${pct(apts(done))}%) · בסיבוב <b>${prog.length}</b>`;
  document.getElementById('stats-text').innerHTML = text;
}

// ---------- sheet ----------
const sheet = document.getElementById('sheet');
const body = document.getElementById('sheet-body');

function select(id) {
  const prev = state.selected;
  state.selected = id;
  state.view = null;
  state.flash = null;
  if (prev) restyle(prev);
  restyle(id);
  state.layers[id].bringToFront();
  document.getElementById('hint').hidden = true;
  renderSheet();
}

function closeSheet() {
  const prev = state.selected;
  state.selected = null;
  state.view = null;
  sheet.hidden = true;
  if (prev) restyle(prev);
}
document.getElementById('sheet-close').addEventListener('click', closeSheet);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addressesHtml(b, open) {
  const items = b.addresses.map(a =>
    `<li><b>${esc(a.street)}</b><div class="houses">${a.houses.map(h =>
      `<span class="house"><bdi>${esc(h[0])}</bdi><small>${h[1]} דירות</small></span>`).join('')}</div></li>`).join('');
  return `<details class="addr"${open ? ' open' : ''}><summary>כתובות בבלוק (${b.entrances} כניסות)</summary>
    <ul>${items}</ul></details>`;
}

function renderSheet(message) {
  const id = state.selected;
  if (!id) return;
  if (message) state.flash = { ...message, id, until: Date.now() + 8000 };
  else if (state.flash && (state.flash.id !== id || Date.now() > state.flash.until)) state.flash = null;
  message = state.flash;
  const b = state.blocks[id];
  const c = state.claims[id];
  const st = statusOf(id);
  const mine = SIM || Boolean(tokens()[id]) || state.myIds.has(id);
  const live = isLive();
  let html = `<h2>${esc(b.label)}</h2>
    <div class="meta">${b.apartments} דירות · ${b.entrances} כניסות · בלוק <bdi>${esc(id)}</bdi></div>
    <div class="status"><span class="dot ${st}"></span>${STATUS_TEXT[st]}</div>`;
  if (c) {
    html += `<div class="meta">מתנדבים: <b>${esc(c.names)}</b><br>משמרות: ${slotsText(c.slots)}</div>`;
  }

  if (state.view === 'claim') {
    html += claimFormHtml();
  } else if (!c) {
    html += `<button class="btn" id="act-claim" type="button">אני לוקח/ת את הבלוק הזה</button>`;
    html += addressesHtml(b, false);
  } else {
    html += manageHtml(id, st, mine, live);
    html += addressesHtml(b, mine);
  }
  if (message) html += `<div class="msg ${message.ok ? 'ok' : 'err'}">${esc(message.text)}</div>`;
  body.innerHTML = html;
  sheet.hidden = false;
  wireSheet(id);
}

function manageHtml(id, st, mine, live) {
  let actions = '';
  if (live && st === 'claimed') actions = `<button class="btn go" data-act="start_round" type="button">מתחיל סיבוב</button>`;
  if (live && st === 'in_progress') actions = `<button class="btn finish" data-act="mark_done" type="button">סיימתי ✓</button>`;
  if (st === 'done') actions = `<button class="btn link" data-act="reopen_round" type="button">סומן בטעות? החזרה ל"בסיבוב"</button>`;
  if (!live && st === 'claimed') {
    actions = `<div class="meta">ביום הבחירות (27.10) יופיעו כאן כפתורי "מתחיל סיבוב" ו"סיימתי".</div>`;
  }
  if (st !== 'done') actions += `<button class="btn link" data-act="release_block" type="button">ביטול – שחררו את הבלוק</button>`;
  if (mine) return actions;
  // not claimed on this device: allow managing with the phone number used to claim
  if (state.view !== 'manage') {
    return `<button class="btn ghost" id="act-manage" type="button" style="width:100%">זה הבלוק שלי (נרשמתי ממכשיר אחר)</button>`;
  }
  return `<div class="phone-row"><label class="field" for="mg-phone">הטלפון שאיתו נרשמתם</label>
    <input id="mg-phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(savedPhone())}"></div>${actions}`;
}

function claimFormHtml() {
  const slots = SLOTS.map(([v, l]) => `<label><input type="checkbox" name="slot" value="${v}">${l}</label>`).join('');
  return `<form class="claim" id="claim-form" novalidate>
    <label class="field">באילו שעות תעברו בבלוק? (אפשר לבחור כמה)</label>
    <div class="slots">${slots}</div>
    <label class="field" for="cf-names">שם / שמות המתנדבים</label>
    <input id="cf-names" type="text" maxlength="80" autocomplete="name" placeholder="למשל: נועה ודני" value="${esc(savedNames())}" required>
    <label class="field" for="cf-phone">טלפון ליצירת קשר</label>
    <input id="cf-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="05X-XXXXXXX" value="${esc(savedPhone())}" required>
    <p class="privacy">השמות יוצגו על המפה. מספר הטלפון לא מוצג באתר – הוא נשמר רק אצל מארגני הקמפיין, לתיאום ביום הבחירות, ומשמש גם לניהול הבלוק ממכשיר אחר.</p>
    <button class="btn" type="submit">תפיסת הבלוק</button>
    <button class="btn link" type="button" id="cf-cancel">ביטול</button>
  </form>`;
}

function wireSheet(id) {
  const claimBtn = document.getElementById('act-claim');
  if (claimBtn) claimBtn.onclick = () => { state.view = 'claim'; renderSheet(); };
  const manageBtn = document.getElementById('act-manage');
  if (manageBtn) manageBtn.onclick = () => { state.view = 'manage'; renderSheet(); };
  const cancel = document.getElementById('cf-cancel');
  if (cancel) cancel.onclick = () => { state.view = null; renderSheet(); };
  const form = document.getElementById('claim-form');
  if (form) form.onsubmit = e => { e.preventDefault(); submitClaim(id, form); };
  body.querySelectorAll('[data-act]').forEach(btn => { btn.onclick = () => act(id, btn.dataset.act, btn); });
}

function errorText(error) {
  const msg = (error && error.message) || '';
  const key = Object.keys(ERRORS).find(k => msg.includes(k));
  return key ? ERRORS[key] : 'משהו השתבש. בדקו את החיבור ונסו שוב.';
}

async function submitClaim(id, form) {
  const slots = [...form.querySelectorAll('input[name=slot]:checked')].map(i => i.value);
  const names = form.querySelector('#cf-names').value.trim();
  const phone = form.querySelector('#cf-phone').value.trim();
  if (!slots.length) return renderInline(form, ERRORS.bad_slots);
  if (names.length < 2) return renderInline(form, ERRORS.bad_names);
  if (phone.replace(/\D/g, '').length < 9) return renderInline(form, ERRORS.bad_phone);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const { data, error } = await api.rpc('claim_block', { p_block_id: id, p_names: names, p_phone: phone, p_slots: slots });
  btn.disabled = false;
  if (error) return renderInline(form, errorText(error));
  saveToken(id, data);
  store.set('gv26_phone', phone);
  store.set('gv26_names', names);
  state.myIds.add(id);
  state.claims[id] = { block_id: id, names, slots: slots.sort(), status: 'claimed' };
  state.view = null;
  restyle(id);
  renderStats();
  loadMine();
  renderSheet({ ok: true, text: 'הבלוק שלכם! תודה רבה. ביום הבחירות חזרו לכאן לסמן התקדמות.' });
}

function renderInline(form, text) {
  let el = form.querySelector('.msg');
  if (!el) { el = document.createElement('div'); form.appendChild(el); }
  el.className = 'msg err';
  el.textContent = text;
}

const CONFIRM = {
  release_block: 'לשחרר את הבלוק? הוא יחזור להיות פנוי לאחרים.',
  mark_done: 'לסמן שהבלוק הושלם?',
};

async function act(id, action, btn) {
  if (CONFIRM[action] && btn.dataset.confirmed !== '1') {
    btn.dataset.confirmed = '1';
    btn.textContent = CONFIRM[action] + ' לחצו שוב לאישור';
    return;
  }
  const phoneInput = document.getElementById('mg-phone');
  const phone = phoneInput ? phoneInput.value.trim() : savedPhone();
  btn.disabled = true;
  const { error } = await api.rpc(action, { p_block_id: id, p_token: tokens()[id] || null, p_phone: phone || null });
  btn.disabled = false;
  if (error) return renderSheet({ ok: false, text: errorText(error) });
  if (phoneInput && phone) store.set('gv26_phone', phone);
  if (action === 'release_block') {
    dropToken(id);
    state.myIds.delete(id);
    delete state.claims[id];
  } else {
    const c = state.claims[id];
    c.status = { start_round: 'in_progress', mark_done: 'done', reopen_round: 'in_progress' }[action];
    if (!tokens()[id]) state.myIds.add(id);
  }
  state.view = null;
  restyle(id);
  renderStats();
  loadMine();
  const done = { start_round: 'בהצלחה בסיבוב!', mark_done: 'כל הכבוד! הבלוק סומן כהושלם.', release_block: 'הבלוק שוחרר.', reopen_round: 'הבלוק חזר ל"בסיבוב".' };
  renderSheet({ ok: true, text: done[action] });
}

// ---------- my blocks / search ----------
document.getElementById('mine-btn').addEventListener('click', () => {
  const ids = [...state.myIds].filter(id => state.claims[id]).sort();
  state.selected && restyle(state.selected);
  state.selected = null;
  body.innerHTML = `<h2>הבלוקים שלי</h2><ul class="mine-list">${ids.map(id =>
    `<li data-id="${id}"><span class="dot ${statusOf(id)}"></span><span><b>${esc(state.blocks[id].label)}</b><br>
      <span class="meta">${STATUS_TEXT[statusOf(id)]} · ${slotsText(state.claims[id].slots)}</span></span></li>`).join('')}</ul>`;
  sheet.hidden = false;
  body.querySelectorAll('li[data-id]').forEach(li => {
    li.onclick = () => { const id = li.dataset.id; map.fitBounds(state.layers[id].getBounds(), { maxZoom: 18 }); select(id); };
  });
});

document.getElementById('search').addEventListener('change', e => {
  const q = e.target.value.trim();
  if (!q) return;
  const ids = Object.keys(state.blocks).filter(id => state.blocks[id].addresses.some(a => a.street.includes(q)));
  if (!ids.length) return;
  const bounds = L.latLngBounds([]);
  ids.forEach(id => bounds.extend(state.layers[id].getBounds()));
  map.fitBounds(bounds, { maxZoom: 18, padding: [20, 20] });
  if (ids.length === 1) select(ids[0]);
});

// ---------- location ----------
let meMarker = null, meCircle = null, centeredOnMe = false;

function showMessage(text) {
  const hint = document.getElementById('hint');
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(showMessage.t);
  showMessage.t = setTimeout(() => { hint.hidden = true; }, 5000);
}

function locate(fromButton) {
  if (!navigator.geolocation) { if (fromButton) showMessage('הדפדפן לא תומך באיתור מיקום'); return; }
  if (locate.watching) {
    if (fromButton && meMarker) recenter(meMarker.getLatLng(), true);
    return;
  }
  locate.watching = true;
  navigator.geolocation.watchPosition(pos => {
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
    if (!meMarker) {
      meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      meMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
      meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
    }
    if (!centeredOnMe) recenter(ll, fromButton);
  }, err => {
    locate.watching = false;
    if (fromButton) showMessage(err.code === 1 ? 'לא ניתנה הרשאת מיקום' : 'לא הצלחנו לקבל מיקום');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function recenter(ll, loud) {
  centeredOnMe = true;
  if (state.area && state.area.contains(ll)) map.setView(ll, 17.5);
  else if (loud) showMessage('נראה שאתם מחוץ לבית הכרם – המפה נשארת על השכונה');
}

const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'locate-btn leaflet-bar');
    btn.type = 'button';
    btn.title = 'הראו לי איפה אני';
    btn.setAttribute('aria-label', 'הראו לי איפה אני');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    L.DomEvent.on(btn, 'click', e => { L.DomEvent.stop(e); locate(true); });
    return btn;
  },
});
map.addControl(new LocateControl());

// refresh when a phone wakes up (realtime sockets drop while the screen is off)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !SIM) loadClaims(); });

(async function init() {
  tickCountdown();
  setInterval(tickCountdown, 1000);
  await loadGeo();
  // on phones, ask for location right away and centre on it when inside the neighbourhood
  if (window.matchMedia('(pointer: coarse)').matches) locate(false);
  await Promise.all([loadSettings(), loadClaims()]);
  tickCountdown();
  renderStats();
  subscribe();
  loadMine();
  if (!SIM) setInterval(loadClaims, 60000);
})();
