// DeepImg QX Rewrite & Task Script
/*
[rewrite_local]
^ https ?: \/\/api\.deepimg\.ai\/api\/login url script-response-body https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/DeepImg.js

[task_local]
每日签到任务（自行调节 cron 时间）
0 3 * * * https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/DeepImg.js, tag=DeepImg, enabled=true

[MITM]
hostname = % APPEND %
*/



const STORE_KEY = 'DeepImg_Store';

// ---------- 通用工具 ----------
function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}
function normHost(host) {
  return String(host || '').trim().toLowerCase();
}
function pickHeaders(src) {
  const out = {};
  const lower = {};
  if (!src) return out;
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      lower[String(k).toLowerCase()] = src[k];
    }
  }
  const need =
    ['Host', 'User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding', 'Origin', 'Referer', 'Cookie'];
  for (const key of need) {
    const val = src[key] !== undefined ? src[key] : lower[String(key).toLowerCase()];
    if (val !== undefined) out[key] = val;
  }
  return out;
}

// ---------- 本地持久化 ----------
function loadStore() {
  try {
    const raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) return { hosts: {} };
    const obj = safeParse(raw);
    if (!obj || typeof obj !== 'object') return { hosts: {} };
    if (!obj.hosts) obj.hosts = {};
    return obj;
  } catch (e) {
    console.log('[DeepImg] loadStore error:', e);
    return { hosts: {} };
  }
}
function saveStore(st) {
  try {
    $prefs.setValueForKey(JSON.stringify(st), STORE_KEY);
    return true;
  } catch (e) {
    console.log('[DeepImg] saveStore error:', e);
    return false;
  }
}
function ensureHost(st, h) {
  if (!st.hosts[h] || typeof st.hosts[h] !== 'object') st.hosts[h] = { users: {} };
}

// ---------- Rewrite: 捕获凭证 ----------
if (typeof $request !== 'undefined') {
  const url = $request.url || '';
  const hdr = $request.headers || {};
  let host = hdr.Host || hdr.host;
  if (!host) {
    try { host = normHost(new URL(url).hostname); } catch (e) { host = ''; }
  } else {
    host = normHost(host);
  }

  // 登录成功返回 token
  if (/\/api\/login/.test(url)) {
    const json = safeParse($response.body);
    let token = null;
    if (json) {
      if (json.data && json.data.token) token = json.data.token;
      else if (json.token) token = json.token;
    }
    if (token) {
      const store = loadStore();
      ensureHost(store, host);
      const uid = 'default';
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].token = token;
      store.hosts[host].users[uid].headers = pickHeaders($response.headers);
      saveStore(store);
      console.log('[DeepImg] 捕获 token → ' + host);
      $notification.post('DeepImg 登录成功 ✅', '已获取 token', 'host: ' + host);
    }
  }

  // 捕获 Set-Cookie 中的 auth_token
  if ($response.headers && $response.headers['Set-Cookie']) {
    const raw = $response.headers['Set-Cookie'];
    let cookieStr = '';
    if (Array.isArray(raw)) cookieStr = raw.map(v => v.split(';')[0]).join('; ');
    else cookieStr = raw.split(';')[0];
    const m = cookieStr.match(/auth_token=([^;]+)/);
    if (m) {
      const store = loadStore();
      ensureHost(store, host);
      const uid = 'default';
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].cookie = 'auth_token=' + m[1];
      store.hosts[host].users[uid].headers = pickHeaders($response.headers);
      saveStore(store);
      console.log('[DeepImg] 捕获 cookie → ' + host);
      $notification.post('DeepImg 捕获 Cookie ✅', '已获取 auth_token', 'host: ' + host);
    }
  }
  $done({});
}

// ---------- Task: 每日签到 ----------
if (typeof $request === 'undefined') {
  (async () => {
    const store = loadStore();
    if (!store.hosts || Object.keys(store.hosts).length === 0) {
      $notification.post('DeepImg 签到', '未检测到已保存的登录凭证', '请先打开 DeepImg登录页面完成登录');
      $done();
      return;
    }
    for (const host in store.hosts) {
      const users = store.hosts[host].users || {};
      for (const uid in users) {
        const user = users[uid];
        if (!user) continue;
        const hdr2 = { ...(user.headers || {}) };
        if (user.cookie) hdr2.Cookie = user.cookie;
        if (user.token) hdr2.Authorization = 'Bearer ' + user.token;
        const signUrl = 'https://' + host + '/api/v1/user/signin';
        const req = { url: signUrl, method: 'POST', header: hdr2, body: '{}' };
        let resp;
        try { resp = await $task.fetch(req); }
        catch (e) {
          $notification.post('DeepImg(' + host + ')', '网络错误', String(e));
          continue;
        }
        if (resp.statusCode !== 200) {
          $notification.post('DeepImg(' + host + ')', 'HTTP ' + resp.statusCode, resp.body);
          continue;
        }
        const data = safeParse(resp.body);
        if (!data) {
          $notification.post('DeepImg(' + host + ')', '返回非 JSON', resp.body);
          continue;
        }
        if (data.code === 0) {
          const reward = data.data?.reward ?? 0;
          const total = data.data?.total ?? '未知';
          $notification.post('DeepImg(' + host + ') ✅', '今日 +' + reward + ' | 累计 ' + total,
            '签到成功');
        } else {
          const msg = data.msg ?? '未知错误';
          const codeStr = data.code ?? '?';
          $notification.post('DeepImg(' + host + ') ⚠️', 'code ' + codeStr + ' - ' + msg, resp.body);
        }
      }
    }
    $done();
  })();
}
