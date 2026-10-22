import { appConfig } from './config.js';

function createError(message, status = 0) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function requestJson(path, options = {}) {
  if (!appConfig.apiBaseUrl) throw createError('VITE_API_BASE_URL belum dikonfigurasi');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), appConfig.requestTimeoutMs);
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  try {
    const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
      ...options,
      headers,
      credentials: options.credentials || 'include',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw createError(data?.message || `Request gagal (${response.status})`, response.status);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw createError('Request timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
