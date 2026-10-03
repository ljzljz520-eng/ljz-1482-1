let currentUser = localStorage.getItem('uid') || 'u_admin';
export const getUser = () => currentUser;
export const setUser = u => { currentUser = u; localStorage.setItem('uid', u); };

export const USERS = [
  ['u_admin', '管理员'],
  ['u_editor', '编辑小李'],
  ['u_reviewer_a', '复核员甲'],
  ['u_reviewer_b', '复核员乙'],
  ['u_publisher', '发布员'],
];

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-id': currentUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
export const get = url => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});
export const put = (url, body) => api('PUT', url, body ?? {});
export const del = (url, body) => api('DELETE', url, body);
