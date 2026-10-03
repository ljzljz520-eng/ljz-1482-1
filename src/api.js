// API 封装
const BASE = '/api';

export async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', 'X-Actor': currentActor() },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 ${res.status}`);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

export function currentActor() {
  return localStorage.getItem('actor') || '编辑员甲';
}
export function setCurrentActor(name) {
  localStorage.setItem('actor', name);
}
