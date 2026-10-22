// Site-wide password gate. Loaded synchronously in <head> of every page.
// Only the SHA-256 of the (lower-cased) password is here. The page also derives an API key from the password,
// window.SITE_KEY = sha256('betakerem-api:' + password), which the map sends with every change it makes; the
// database refuses changes without it (supabase/schema.sql, table site_key), so the source alone isn't enough.
// To change the password, update HASH below and the key in Supabase:
//   python -c "import hashlib; p='newpassword'.lower(); print(hashlib.sha256(p.encode()).hexdigest()); print(hashlib.sha256(('betakerem-api:'+p).encode()).hexdigest())"
//   SQL editor: update public.site_key set key = '<second line>' where id = 1;
// Pages that need to wait for the gate before running (asking for location, logging in) await window.SITE_GATE.
(function () {
  'use strict';
  const HASH = 'bbf24ae413d6dc83c15d3130cba9ce32be3203da8429bf6a765c39db697e3e17';
  const KEY = 'betakerem_gate';
  const API_KEY = 'betakerem_api_key';
  const stored = k => { try { return localStorage.getItem(k); } catch { return null; } };
  let open;
  window.SITE_GATE = new Promise(resolve => { open = resolve; });
  // forget a key the server no longer accepts (the password was changed); the next visit asks again
  window.SITE_GATE_RESET = () => { try { localStorage.removeItem(KEY); localStorage.removeItem(API_KEY); } catch { /* ignore */ } };
  if (stored(KEY) === HASH && stored(API_KEY)) { window.SITE_KEY = stored(API_KEY); open(); return; }

  const html = document.documentElement;
  html.classList.add('site-gated');
  const style = document.createElement('style');
  style.textContent = `
    html.site-gated body > *:not(#site-gate) { display: none !important; }
    #site-gate { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; padding: 16px;
      background: #f6f5f1; color: #1d232b; font-family: 'Heebo', system-ui, sans-serif; direction: rtl; }
    #site-gate form { width: 100%; max-width: 340px; background: #fff; border: 1px solid #e2e0da; border-radius: 14px;
      padding: 22px 20px; box-shadow: 0 2px 14px rgba(0,0,0,.12); text-align: center; }
    #site-gate h1 { margin: 0 0 4px; font-size: 1.5rem; color: #1f4e79; font-weight: 800; }
    #site-gate p { margin: 0 0 14px; color: #5e6873; font-size: .95rem; }
    #site-gate input { width: 100%; box-sizing: border-box; font: inherit; font-size: 1.05rem; padding: 11px 12px;
      border-radius: 10px; border: 1px solid #e2e0da; background: #f6f5f1; color: inherit; text-align: center; }
    #site-gate button { width: 100%; margin-top: 10px; font: inherit; font-weight: 700; font-size: 1.05rem; border: 0;
      border-radius: 12px; padding: 12px; background: #1f4e79; color: #fff; cursor: pointer; }
    #site-gate .err { color: #dc2626; font-size: .92rem; margin: 10px 0 0; min-height: 1.2em; }
    @media (prefers-color-scheme: dark) {
      #site-gate { background: #15181c; color: #eceae6; }
      #site-gate form { background: #1f2328; border-color: #343a41; }
      #site-gate h1 { color: #8fb8e0; }
      #site-gate p { color: #a2a9b1; }
      #site-gate input { background: #15181c; border-color: #343a41; }
      #site-gate button { background: #2f6aa3; }
    }`;
  document.head.appendChild(style);

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function show() {
    const gate = document.createElement('div');
    gate.id = 'site-gate';
    gate.innerHTML = `<form autocomplete="off">
        <h1>בית הכרם</h1>
        <p>האתר למתנדבי השכונה. הקלידו את הסיסמה שקיבלתם.</p>
        <input type="password" aria-label="סיסמה" placeholder="סיסמה" autocapitalize="off" autocorrect="off" spellcheck="false" required>
        <button type="submit">כניסה</button>
        <div class="err" aria-live="polite"></div>
      </form>`;
    document.body.appendChild(gate);
    const form = gate.querySelector('form');
    const input = gate.querySelector('input');
    input.focus();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const password = input.value.trim().toLowerCase();
      if (await sha256(password) !== HASH) {
        gate.querySelector('.err').textContent = 'סיסמה שגויה';
        input.select();
        return;
      }
      window.SITE_KEY = await sha256('betakerem-api:' + password);
      try { localStorage.setItem(KEY, HASH); localStorage.setItem(API_KEY, window.SITE_KEY); } catch { /* private mode: asked again next visit */ }
      gate.remove();
      html.classList.remove('site-gated');
      open();
      window.dispatchEvent(new Event('resize'));  // let the map measure itself now that it is visible
    });
  }
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
