import { appConfig } from './config.js';
import { requestJson } from './api.js';

export const ENDPOINTS = Object.freeze({
  profile: '/api/v1/me/profile',
  session: '/api/v1/auth/session',
  login: '/api/v1/auth/login',
  register: '/api/v1/auth/register',
  logout: '/api/v1/auth/logout',
  workspaces: '/api/v1/workspaces',
  leads: '/api/v1/leads',
  events: '/api/v1/events',
  reports: '/api/v1/reports',
});

const unwrap = (response) => response?.data ?? response;
const json = (method, body) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

// Workspace aktif (UUID dari server). Diisi setelah sesi dipulihkan / login.
let workspaceId = null;
export const setActiveWorkspace = (id) => { workspaceId = id || null; };
const ws = (path) => {
  if (!workspaceId) throw new Error('Workspace belum dipilih');
  return `${ENDPOINTS.workspaces}/${workspaceId}${path}`;
};

export async function updateProfile(profile) {
  // Mode demo: kembalikan data profil saja. Password tidak boleh ikut tersimpan ke localStorage.
  if (!appConfig.backendEnabled) { const { currentPassword, newPassword, ...safe } = profile; return safe; }
  return unwrap(await requestJson(ENDPOINTS.profile, json('PATCH', profile)));
}

export const getSession = async () => unwrap(await requestJson(ENDPOINTS.session));
export const login = async (email, password) => unwrap(await requestJson(ENDPOINTS.login, json('POST', { email, password })));
export const register = async (input) => unwrap(await requestJson(ENDPOINTS.register, json('POST', input)));
export const logout = async () => requestJson(ENDPOINTS.logout, json('POST'));

// Kredensial Meta & webhook dikelola server; browser tidak pernah menyimpan token/secret.
export const metaTest = async (body = {}) => unwrap(await requestJson(ws('/integrations/meta/test'), json('POST', body)));
export const metaSave = async (body) => unwrap(await requestJson(ws('/integrations/meta'), json('PUT', body)));
export const metaSendEvent = async (payload, source = 'manual') => unwrap(await requestJson(ws('/meta/events'), json('POST', { payload, source })));
export const webhookSave = async (body) => unwrap(await requestJson(ws('/integrations/webhook'), json('PUT', body)));
export const webhookTest = async () => unwrap(await requestJson(ws('/integrations/webhook/test'), json('POST')));
