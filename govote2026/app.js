'use strict';

const CFG = window.GOVOTE_CONFIG;
const SLOTS = [['10-12', '10:00–12:00'], ['12-14', '12:00–14:00'], ['14-16', '14:00–16:00'], ['16-18', '16:00–18:00']];
const SLOT_LABEL = Object.fromEntries(SLOTS);
const slotsText = slots => slots.map(s => `<bdi dir="ltr">${SLOT_LABEL[s] || esc(s)}</bdi>`).join(' · ');
const COLORS = { free: '#dc2626', claimed: '#2563eb', in_progress: '#eab308', done: '#16a34a' };
const STATUS_TEXT = { free: 'פנוי – עדיין לא נתפס', claimed: 'נתפס', in_progress: 'בסיבוב עכשיו', done: 'הושלם ✓' };
const ERRORS = {
  already_claimed: 'מישהו אחר תפס את הבלוק הזה ממש עכשיו. נסו בלוק סמוך.',
  bad_names: 'נא למלא שם (2–80 תווים).',
  bad_phone: 'מספר הטלפון לא תקין.',
  bad_slots: 'בחרו לפחות משמרת אחת.',
  busy: 'יש עומס רגעי, נסו שוב בעוד דקה.',
  not_live: 'הסימון נפתח רק ביום הבחירות.',
  not_allowed: 'לא הצלחנו לאמת שזה הבלוק שלכם. בדקו את מספר הטלפון.',
  bad_status: 'מצב הבלוק השתנה. רעננו את הדף.',
  no_such_block: 'בלוק לא קיים.',
  no_such_house: 'כתובת לא קיימת בבלוק.',
  not_claimed: 'הבלוק עדיין פנוי – אפשר פשוט לתפוס אותו.',
  own_block: 'זה כבר הבלוק שלכם.',
  already_requested: 'כבר שלחתם בקשה להצטרף לבלוק הזה. המארגנים יחזרו אליכם.',
  bad_note: 'ההערה ארוכה מדי (עד 300 תווים).',
  bad_site_key: 'הסיסמה לאתר השתנתה. רעננו את הדף והקלידו את הסיסמה החדשה.',
};

const SIM = Boolean(CFG.simulate);  // election-day demo: fake data, nothing is saved
const DATA = CFG.dataBase || '';
const GEO_VERSION = 6;  // bump when tools/build_blocks.py or build_results.py output changes, so browsers don't use stale blocks
const params = new URLSearchParams(location.search);

// ---------- backend: Supabase, or an in-memory stand-in for the simulation ----------
function supabaseApi() {
  // every request carries the key derived from the site password (gate.js); the database refuses changes without it
  const siteFetch = (url, opts = {}) => {
    const headers = new Headers(opts.headers);
    if (window.SITE_KEY) headers.set('x-site-key', window.SITE_KEY);
    return fetch(url, { ...opts, headers });
  };
  const sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { global: { fetch: siteFetch } });
  return {
    claims: () => sb.from('claims').select('*'),
    houses: () => sb.from('house_done').select('house_id, block_id'),
    settings: () => sb.from('settings').select('live_from').maybeSingle(),
    rpc: (fn, args) => sb.rpc(fn, args),
    subscribe: (onClaim, onHouse) => sb.channel('claims-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, onClaim)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'house_done' }, onHouse).subscribe(),
  };
}

function simulatedApi() {
  const rows = {};
  const houses = {};  // house id -> block id
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
        rows[id] = { block_id: id, names: NAMES[i % NAMES.length], slots: [slot], status, seeded: true };
        // some addresses already marked in blocks that are under way
        if (status === 'in_progress') {
          const n = state.blocks[id].entrances;
          for (let k = 1; k < n; k++) if (rand() < 0.4) houses[`${id}-${k}`] = id;
        }
      });
    },
    claims: async () => ok(Object.values(rows).map(r => ({ ...r }))),
    houses: async () => ok(Object.entries(houses).map(([house_id, block_id]) => ({ house_id, block_id }))),
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
        case 'mark_house': {
          if (!r || r.status === 'done') return fail('bad_status');
          if (a.p_done) houses[a.p_house_id] = a.p_block_id;
          else delete houses[a.p_house_id];
          const marked = Object.values(houses).filter(b => b === a.p_block_id).length;
          r.status = marked >= state.blocks[a.p_block_id].entrances ? 'done' : 'in_progress';
          return ok(r.status);
        }
        case 'reopen_round':
          if (!r || r.status !== 'done') return fail('bad_status');
          r.status = 'in_progress'; return ok();
        case 'release_block':
          if (!r || r.status === 'done') return fail('bad_status');
          delete rows[a.p_block_id];
          Object.keys(houses).forEach(h => { if (houses[h] === a.p_block_id) delete houses[h]; });
          return ok();
        case 'request_join':
          if (!r) return fail('not_claimed');
          return ok();
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
  housesDone: new Set(),  // house ids ('K001-3') marked done
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
    liveBox.textContent = 'היום יום הבחירות! סמנו "מתחיל סיבוב" כשאתם יוצאים, כל בניין שסיימתם, ו"סיימתי" בסוף.';
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
function buildingStyle(id, houses) {
  const done = houses && houses.length && houses.every(h => state.housesDone.has(h));
  const color = done ? COLORS.done : COLORS[statusOf(id)];
  return { color, weight: 0.6, fillColor: color, fillOpacity: 0.75, interactive: false };
}
function restyle(id) {
  if (state.layers[id]) state.layers[id].setStyle(blockStyle(id));
  (state.buildings[id] || []).forEach(l => l.setStyle(buildingStyle(id, l.feature.properties.h)));
}
function restyleAll() { Object.keys(state.blocks).forEach(restyle); renderStats(); }

async function loadGeo() {
  const [blocks, buildings, boundary] = await Promise.all(
    ['blocks.geojson', 'buildings.geojson', 'boundary.geojson'].map(f => fetch(`${DATA}${f}?v=${GEO_VERSION}`).then(r => r.json())));
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
    style: f => buildingStyle(f.properties.b, f.properties.h),
    interactive: false,
    onEachFeature: (f, layer) => (state.buildings[f.properties.b] ||= []).push(layer),
  }).addTo(map);
  map.fitBounds(blockLayer.getBounds(), { padding: [8, 8] });
  state.home = blockLayer.getBounds();
  map.setMaxBounds(state.home.pad(0.6));
  state.area = blockLayer.getBounds().pad(0.15);
  if (SIM) api.seed(blocks.features.map(f => f.properties.id));

  const streets = new Set();
  blocks.features.forEach(f => f.properties.addresses.forEach(a => streets.add(a.street)));
  document.getElementById('streets').innerHTML = [...streets].sort((a, b) => a.localeCompare(b, 'he'))
    .map(s => `<option value="${esc(s)}">`).join('');
}

// ---------- data ----------
async function loadClaims() {
  const [{ data, error }, houses] = await Promise.all([api.claims(), api.houses()]);
  if (error) { console.warn('claims', error); return; }
  state.claims = Object.fromEntries(data.map(c => [c.block_id, c]));
  if (!houses.error) state.housesDone = new Set(houses.data.map(h => h.house_id));
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

const blockOfHouse = h => h.slice(0, h.lastIndexOf('-'));

function forgetHouses(id) {
  state.housesDone.forEach(h => { if (blockOfHouse(h) === id) state.housesDone.delete(h); });
}

function subscribe() {
  const changed = id => {
    restyle(id);
    renderStats();
    if (state.selected === id && !state.view) renderSheet();
  };
  api.subscribe(payload => {
    const id = payload.eventType === 'DELETE' ? payload.old.block_id : payload.new.block_id;
    if (payload.eventType === 'DELETE') { delete state.claims[id]; forgetHouses(id); }
    else state.claims[id] = payload.new;
    changed(id);
  }, payload => {
    // deletes carry only the primary key
    const h = payload.eventType === 'DELETE' ? payload.old.house_id : payload.new.house_id;
    if (!h) return;
    if (payload.eventType === 'DELETE') state.housesDone.delete(h);
    else state.housesDone.add(h);
    changed(blockOfHouse(h));
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
  setSheetMin(false);
  const prev = state.selected;
  state.selected = null;
  state.view = null;
  sheet.hidden = true;
  if (prev) restyle(prev);
}
document.getElementById('sheet-close').addEventListener('click', closeSheet);

// the sheet can shrink to its title so the map stays usable; tapping a block opens it in full again
function setSheetMin(min) {
  sheet.classList.toggle('min', min);
  document.getElementById('sheet-min').setAttribute('aria-expanded', !min);
}
document.getElementById('sheet-min').addEventListener('click', e => { e.stopPropagation(); setSheetMin(!sheet.classList.contains('min')); });
sheet.addEventListener('click', e => { if (sheet.classList.contains('min') && !e.target.closest('button')) setSheetMin(false); });

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addressesHtml(b, open, canMark) {
  const done = state.housesDone;
  const blockDone = statusOf(b.id) === 'done';
  const items = b.addresses.map(a =>
    `<li><b>${esc(a.street)}</b><div class="houses">${a.houses.map(([label, apts, hid]) => {
      const isDone = blockDone || done.has(hid);
      const inner = `<bdi>${esc(label)}</bdi><small>${apts} דירות</small>${isDone ? '<i>✓</i>' : ''}`;
      return canMark
        ? `<button type="button" class="house${isDone ? ' done' : ''}" data-house="${hid}" aria-pressed="${isDone}">${inner}</button>`
        : `<span class="house${isDone ? ' done' : ''}">${inner}</span>`;
    }).join('')}</div></li>`).join('');
  const marked = blockDone ? b.entrances : b.addresses.reduce((n, a) => n + a.houses.filter(h => done.has(h[2])).length, 0);
  const progress = marked ? ` · ${marked} סומנו` : '';
  const help = canMark ? '<p class="privacy">סיימתם בניין? לחצו על הכתובת שלו והיא תסומן בירוק. כשכל הכתובות מסומנות הבלוק כולו מסומן כהושלם.</p>' : '';
  return `<details class="addr"${open ? ' open' : ''}><summary>כתובות בבלוק (${b.entrances} כניסות${progress})</summary>
    ${help}<ul>${items}</ul></details>`;
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

  const canJoin = c && st !== 'done' && (!mine || c.seeded);
  if (state.view === 'claim') {
    html += claimFormHtml();
  } else if (state.view === 'join') {
    html += joinFormHtml();
  } else if (!c) {
    html += `<button class="btn" id="act-claim" type="button">אני לוקח/ת את הבלוק הזה</button>`;
    html += addressesHtml(b, false, false);
  } else {
    html += manageHtml(id, st, mine, live);
    if (canJoin) html += `<button class="btn ghost wide" id="act-join" type="button">רוצים להצטרף לבלוק הזה? שלחו בקשה</button>`;
    html += addressesHtml(b, mine || st === 'in_progress', mine && live && st !== 'done');
  }
  if (message) html += `<div class="msg ${message.ok ? 'ok' : 'err'}">${esc(message.text)}</div>`;
  body.innerHTML = html;
  sheet.hidden = false;
  setSheetMin(false);
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

function joinFormHtml() {
  return `<form class="claim" id="join-form" novalidate>
    <p class="privacy" style="margin-top:0">הבלוק כבר נתפס. השאירו פרטים והמארגנים יחברו אתכם עם המתנדבים שבו.</p>
    <label class="field" for="jf-names">שם</label>
    <input id="jf-names" type="text" maxlength="80" autocomplete="name" value="${esc(savedNames())}" required>
    <label class="field" for="jf-phone">טלפון</label>
    <input id="jf-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="05X-XXXXXXX" value="${esc(savedPhone())}" required>
    <label class="field" for="jf-note">הערה (לא חובה)</label>
    <input id="jf-note" type="text" maxlength="300" placeholder="למשל: פנוי/ה בין 14:00 ל-16:00">
    <p class="privacy">הפרטים לא מוצגים באתר ולא נמסרים למתנדבים בבלוק – הם מגיעים רק למארגני הקמפיין.</p>
    <button class="btn" type="submit">שליחת בקשה</button>
    <button class="btn link" type="button" id="cf-cancel">ביטול</button>
  </form>`;
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
  const joinBtn = document.getElementById('act-join');
  if (joinBtn) joinBtn.onclick = () => { state.view = 'join'; renderSheet(); };
  const joinForm = document.getElementById('join-form');
  if (joinForm) joinForm.onsubmit = e => { e.preventDefault(); submitJoin(id, joinForm); };
  body.querySelectorAll('[data-act]').forEach(btn => { btn.onclick = () => act(id, btn.dataset.act, btn); });
  body.querySelectorAll('button[data-house]').forEach(btn => { btn.onclick = () => markHouse(id, btn); });
}

function errorText(error) {
  const msg = (error && error.message) || '';
  const key = Object.keys(ERRORS).find(k => msg.includes(k));
  if (key === 'bad_site_key' && window.SITE_GATE_RESET) window.SITE_GATE_RESET();
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

async function submitJoin(id, form) {
  const names = form.querySelector('#jf-names').value.trim();
  const phone = form.querySelector('#jf-phone').value.trim();
  const note = form.querySelector('#jf-note').value.trim();
  if (names.length < 2) return renderInline(form, ERRORS.bad_names);
  if (phone.replace(/\D/g, '').length < 9) return renderInline(form, ERRORS.bad_phone);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await api.rpc('request_join', { p_block_id: id, p_names: names, p_phone: phone, p_note: note || null });
  btn.disabled = false;
  if (error) return renderInline(form, errorText(error));
  store.set('gv26_phone', phone);
  store.set('gv26_names', names);
  state.view = null;
  renderSheet({ ok: true, text: 'הבקשה נשלחה! המארגנים יצרו איתכם קשר ויחברו אתכם עם המתנדבים בבלוק.' });
}

async function markHouse(id, btn) {
  const hid = btn.dataset.house;
  const done = !state.housesDone.has(hid);
  btn.disabled = true;
  const { data, error } = await api.rpc('mark_house', {
    p_block_id: id, p_house_id: hid, p_done: done, p_token: tokens()[id] || null, p_phone: savedPhone() || null,
  });
  btn.disabled = false;
  if (error) return renderSheet({ ok: false, text: errorText(error) });
  if (done) state.housesDone.add(hid);
  else state.housesDone.delete(hid);
  const c = state.claims[id];
  const wasDone = c.status === 'done';
  c.status = data || 'in_progress';
  restyle(id);
  renderStats();
  if (c.status === 'done' && !wasDone) renderSheet({ ok: true, text: 'כל הכתובות סומנו – הבלוק הושלם. כל הכבוד!' });
  else renderSheet();
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
    forgetHouses(id);
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
  setSheetMin(false);
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

// ---------- 2022 results layer ----------
// one circle per polling building in Jerusalem, coloured by the liberal + Arab bloc share vs. the coalition (red);
// the non-coalition side is blue where the liberal bloc leads and green where the Arab bloc does
// or, in turnout mode, by the share of registered voters who voted (red low, green high)
const RESULTS = { layer: null, on: false, mode: 'blocs' };
const pct = x => `${Math.round(100 * x)}%`;
const BLOC_RGB = { coalition: [185, 28, 28], liberal: [29, 78, 216], arab: [21, 128, 61] };

function shareColor(opposition, arabLeads = false) {
  // red at <=25% liberal + Arab, light grey at 50%, blue (or green) at >=75%
  const t = Math.max(-1, Math.min(1, (opposition - 0.5) / 0.25));
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = t < 0 ? mix([229, 231, 235], BLOC_RGB.coalition, -t)
    : mix([229, 231, 235], arabLeads ? BLOC_RGB.arab : BLOC_RGB.liberal, t);
  return `rgb(${rgb.join(',')})`;
}
const blocColor = bloc => `rgb(${BLOC_RGB[bloc].join(',')})`;
const siteColor = site => shareColor(site.liberal_share + site.arab_share, site.arab_share > site.liberal_share);

function turnoutColor(turnout) {
  // red at <=40%, amber at 60% (about the city average), green at >=80%
  const t = Math.max(-1, Math.min(1, (turnout - 0.6) / 0.2));
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = t < 0 ? mix([234, 179, 8], [185, 28, 28], -t) : mix([234, 179, 8], [21, 128, 61], t);
  return `rgb(${rgb.join(',')})`;
}

function resultsPopup(site) {
  const rows = site.boxes.map(b => `<tr class="${b.excluded ? 'excluded' : ''}">
      <td><bdi>${esc(b.kalpi)}</bdi></td><td>${b.valid}</td><td style="color:${turnoutColor(b.voted / b.registered)}">${pct(b.voted / b.registered)}</td>
      <td style="color:${blocColor('liberal')}">${pct(b.liberal / b.valid)}</td><td style="color:${blocColor('arab')}">${pct(b.arab / b.valid)}</td>
      <td style="color:${blocColor('coalition')}">${pct(b.coalition / b.valid)}</td></tr>
      ${b.excluded ? `<tr class="excluded"><td colspan="6">${esc(b.excluded)} – לא נכללה בצבע</td></tr>` : ''}`).join('');
  const where = site.beit_hakerem ? 'בית הכרם' : `${esc(site.neighbourhood)} (שיוך משוער)`;
  return `<div class="res-pop"><b>${esc(site.label)}</b><div class="muted">${esc(site.address)} · ${where}<br>${site.valid.toLocaleString('he-IL')} קולות כשרים<br><span style="color:${turnoutColor(site.turnout)}">הצבעה ${pct(site.turnout)}</span> מתוך ${site.registered.toLocaleString('he-IL')} בעלי זכות${site.approx ? ' · המיקום על המפה משוער' : ''}</div>
    <div class="res-big"><span style="color:${blocColor('liberal')}">ליברלים ${pct(site.liberal_share)}</span> · <span style="color:${blocColor('arab')}">גוש ערבי ${pct(site.arab_share)}</span> · <span style="color:${blocColor('coalition')}">קואליציה ${pct(site.coalition_share)}</span></div>
    <table><tr><th>קלפי</th><th>כשרים</th><th>הצבעה</th><th>ליברלים</th><th>ערבי</th><th>קואליציה</th></tr>${rows}</table></div>`;
}

async function loadResults() {
  const data = await fetch(`${DATA}results2022.json?v=${GEO_VERSION}`).then(r => r.json());
  RESULTS.sites = data.sites.filter(site => site.valid);
  RESULTS.layer = L.layerGroup();
  RESULTS.bounds = L.latLngBounds(data.sites.map(site => [site.lat, site.lon]));
  drawResults();
}

function drawResults() {
  const turnout = RESULTS.mode === 'turnout';
  RESULTS.layer.clearLayers();
  for (const site of RESULTS.sites) {
    const d = Math.round(2 * (6 + Math.sqrt(site.valid) / 5));
    const value = turnout ? site.turnout : site.liberal_share + site.arab_share;
    const label = d >= 26 ? pct(value) : '';
    const icon = L.divIcon({
      className: `res-marker${site.beit_hakerem ? ' home' : ''}`, iconSize: [d, d],
      html: `<div class="res-dot" style="background:${turnout ? turnoutColor(value) : siteColor(site)};font-size:${Math.max(10, d / 3.4)}px">${label}</div>`,
    });
    L.marker([site.lat, site.lon], { icon, title: `${site.label} · ${turnout ? 'הצבעה' : 'ליברלים + גוש ערבי'} ${pct(value)}`, zIndexOffset: 1000 })
      .bindPopup(resultsPopup(site), {
        maxWidth: Math.min(320, innerWidth - 50), maxHeight: Math.round(innerHeight * 0.5), autoPanPadding: [10, 10],
      }).addTo(RESULTS.layer);
  }
  document.getElementById('results-legend').dataset.mode = RESULTS.mode;
  for (const btn of document.querySelectorAll('#results-mode button')) btn.setAttribute('aria-pressed', btn.dataset.mode === RESULTS.mode);
}

async function toggleResults() {
  if (!RESULTS.layer) await loadResults();
  RESULTS.on = !RESULTS.on;
  // the results cover all of Jerusalem: let the map leave the neighbourhood while they are shown
  if (RESULTS.on) {
    RESULTS.layer.addTo(map);
    closeSheet();
    map.setMaxBounds(null);
    map.setMinZoom(11);
    map.fitBounds(RESULTS.bounds, { padding: [10, 10] });
  } else {
    RESULTS.layer.remove();
    map.setMinZoom(13);
    map.fitBounds(state.home, { padding: [8, 8] });
    map.setMaxBounds(state.home.pad(0.6));
  }
  document.body.classList.toggle('results-on', RESULTS.on);
  document.getElementById('results-btn').setAttribute('aria-pressed', RESULTS.on);
}
document.getElementById('results-btn').addEventListener('click', toggleResults);
for (const btn of document.querySelectorAll('#results-mode button')) {
  btn.addEventListener('click', () => { RESULTS.mode = btn.dataset.mode; if (RESULTS.layer) drawResults(); });
}

// ---------- collapsible header and legends (remembered on this device) ----------
const UI_KEY = 'gv26_ui';
const uiPrefs = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } })();
function setCollapsed(name, collapsed) {
  uiPrefs[name] = collapsed;
  try { localStorage.setItem(UI_KEY, JSON.stringify(uiPrefs)); } catch { /* private mode */ }
  if (name === 'top') {
    document.body.classList.toggle('top-min', collapsed);
    const btn = document.getElementById('top-toggle');
    btn.setAttribute('aria-expanded', !collapsed);
    btn.setAttribute('aria-label', collapsed ? 'הצגת הכותרת' : 'הסתרת הכותרת');
    map.invalidateSize();
  } else {
    document.getElementById(name).classList.toggle('min', collapsed);
    document.querySelector(`[data-collapse="${name}"]`).setAttribute('aria-expanded', !collapsed);
  }
}
document.getElementById('top-toggle').addEventListener('click', () => setCollapsed('top', !uiPrefs.top));
for (const btn of document.querySelectorAll('[data-collapse]')) {
  btn.addEventListener('click', () => setCollapsed(btn.dataset.collapse, !uiPrefs[btn.dataset.collapse]));
}
for (const name of ['top', 'legend', 'results-legend']) if (uiPrefs[name]) setCollapsed(name, true);

// refresh when a phone wakes up (realtime sockets drop while the screen is off)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !SIM) loadClaims(); });

(async function init() {
  await window.SITE_GATE;  // site password (gate.js); the map was created hidden, so let it re-measure
  map.invalidateSize();
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
