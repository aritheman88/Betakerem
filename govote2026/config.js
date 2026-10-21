// Public settings for the govote2026 page. The publishable key is meant to be public;
// never put the secret key or the database password here.
window.GOVOTE_CONFIG = {
  supabaseUrl: 'https://plsyyconetnlpkpspaje.supabase.co',
  supabaseKey: 'sb_publishable_DG7VvWfcdCT1v8XUpyDBUQ_J4XkriA4',
  // fallbacks until the settings row loads (Israel time, UTC+2 after DST ends on 25/10)
  liveFrom: '2026-10-27T00:00:00+02:00',
  pollsClose: '2026-10-27T22:00:00+02:00',
  maxClaimsPerPhone: 5,
};
