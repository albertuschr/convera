// Penyimpanan lokal (localStorage). Hanya state "permanen" yang disimpan; modal/menu/toast tidak.
import { appConfig } from './config.js';
const KEY = 'convera:v1';
export const PERSIST = ['f', 'page', 'ws', 'range', 'dark', 'screen', 'step', 'collapsed', 'banners', 'read', 'leadOv', 'kvNew', 'lgOv', 'rulesList', 'rulesOn',
  'ldQ', 'ldCamp', 'ldStatus', 'ldSel', 'kvSrc', 'pfOpen', 'pfSort', 'atTab', 'rb', 'rbEdit', 'rtMsg', 'rtFrom', 'lgSt', 'lgSrc', 'lgTab',
  'keys', 'invites', 'wh', 'whEv', 'whSecret', 'lpOn', 'lpCh', 'lpP', 'lpTo', 'lpDay', 'lpHour', 'lpSaved', 'defEv', 'defVal', 'disc', 'intOn', 'sandbox', 'sessOut',
  'wa', 'methods', 'plan', 'bill', 'tokenDays', 'nt', 'retention', 'delPhones', 'pwUpdated', 'wsDelAt', 'events', 'profile', 'owner'];
export function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
let t;
export function save(state) {
  clearTimeout(t);
  t = setTimeout(() => { try { const o = {}; PERSIST.forEach((k) => { if (state[k] !== undefined) o[k] = state[k]; }); if (appConfig.backendEnabled) { if (o.f) o.f = { ...o.f, token: '', waToken: '' }; delete o.whSecret; } localStorage.setItem(KEY, JSON.stringify(o)); } catch {} }, 150);
}
// Hapus data lokal tanpa reload (dipakai saat ganti akun / logout). Batalkan save yang masih tertunda.
export const clear = () => { clearTimeout(t); try { localStorage.removeItem(KEY); } catch {} };
export const reset = () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); };
