// 常量 & 环境判断
const STORE_KEY = "DeepImg_Store";                 // 本地持久化键
const isRewrite = typeof $request !== "undefined"; // true → 正在执行 Rewrite 阶段

// 工具函数
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}
function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}
function pickNeedHeaders(src) {
  var dst = {};
  var lower = {};
  var i, k, v;
  if (!src) return dst;
  for (k in src) {
    if (src.hasOwnProperty(k)) {
      lower[String(k).toLowerCase()] = src[k];
    }
  }
  var NEED_KEYS = [
    "Host",
    "User-Agent",
    "Accept",
    "Accept-Language",
    "Accept-Encoding",
    "Origin",
    "Referer",
    "Cookie",
  ];
  for (i = 0; i < NEED_KEYS.length; i++) {
    k = NEED_KEYS[i];
    v = src[k] !== undefined ? src[k] : lower[String(k).toLowerCase()];
    if (v !== undefined) {
      dst[k] = v;
    }
  }
  return dst;
}

// 本地存取
function loadStore() {
  try {
    var raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) {
      return { hosts: {} };
    }
    var obj = safeJsonParse(raw);
    if (!obj || typeof obj !== "object") {
      return { hosts: {} };
    }
    if (!obj.hosts) obj.hosts = {};
    return obj;
  } catch (e) {
    console.error("[DeepImg] loadStore error:", e);
    return { hosts: {} };
  }
}
function saveStore(store) {
  try {
    $prefs.setValueForKey(JSON.stringify(store), STORE_KEY);
    return true;
  } catch (e) {
    console.error("[DeepImg] saveStore error:", e);
    return false;
  }
}
function ensureHostNode(store, host) {
  if (!store.hosts[host] || typeof store.hosts[host] !== "object") {
    store.hosts[host] = { users: {} };
  }
}

// ① Rewrite：捕获登录信息
if (isRewrite) {
  var url = $request.url || "";
  var host = (function () {
    var hdr = $request.headers || {};
    if (hdr.Host) return normalizeHost(hdr.Host);
    if (hdr.host) return normalizeHost(hdr.host);
    try {
      return normalizeHost(new URL($request.url).hostname);
    } catch (e) {
      return "";
    }
  })();

  // ---- 捕获 token（登录返回的 JSON） ----
  if (/\/api\/v[0-9]+\/auth\/login/.test(url)) {
    var json = safeJsonParse($response.body);
    var token = null;
    if (json) {
      if (json.data && json.data.token) token = json.data.token;
      else if (json.token) token = json.token;
    }
    if (token) {
      var store = loadStore();
      ensureHostNode(store, host);
      var uid = "default";
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].token = token;
      // 保存一次完整请求头，后面签到直接复用
      store.hosts[host].users[uid].headers = pickNeedHeaders($response.headers);
      saveStore(store);
    }
  }

  // ---- 捕获 Set‑Cookie（auth_token） ----
  if ($response.headers && $response.headers["Set-Cookie"]) {
    var raw = $response.headers["Set-Cookie"]; // 可能是数组或字符串
    var cookieStr = "";
    if (Array.isArray(raw)) {
      cookieStr = raw.map(function (v) {
        return v.split(";")[0];
      }).join("; ");
    } else {
      cookieStr = raw.split(";")[0];
    }
    var m = cookieStr.match(/auth_token=([^;]+)/);
    if (m) {
      var store = loadStore();
      ensureHostNode(store, host);
      var uid = "default";
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].cookie = "auth_token=" + m[1];
      store.hosts[host].users[uid].headers = pickNeedHeaders($response.headers);
      saveStore(store);
    }
  }

  // Rewrite 阶段结束
  $done({});
}

// ② Task（Cron）
if (!isRewrite) {
  // 读取本地已保存的全部 host/uid，遍历执行签到
  var store = loadStore();
  if (!store.hosts || Object.keys(store.hosts).length === 0) {
    $notification.post("DeepImg 签到", "未检测到已保存的登录凭证", "请先手动登录一次 DeepImg");
    $done();
    return;
  }

  // 遍历每个 host
  for (var hostKey in store.hosts) {
    if (!store.hosts.hasOwnProperty(hostKey)) continue;
    var users = store.hosts[hostKey].users || {};
    // 遍历该 host 下的每个 uid（DeepImg 只会有一个 uid，默认 default）
    for (var uidKey in users) {
      if (!users.hasOwnProperty(uidKey)) continue;
      var user = users[uidKey];
      if (!user) continue;

      // 合并请求头：优先使用 cookie，其次 token
      var hdr = {};
      // 复制保存的 headers（如果有的话）
      if (user.headers) {
        for (var hk in user.headers) {
          if (user.headers.hasOwnProperty(hk)) hdr[hk] = user.headers[hk];
        }
      }
      if (user.cookie) hdr.Cookie = user.cookie;
      if (user.token) hdr.Authorization = "Bearer " + user.token;

      var signUrl = "https://" + hostKey + "/api/v1/user/signin";
      var req = {
        url: signUrl,
        method: "POST",
        header: hdr,
        body: "{}",
      };

      (function (hostDisplay) {
        (async function () {
          var resp;
          try {
            resp = await $task.fetch(req);
          } catch (e) {
            $notification.post("DeepImg(" + hostDisplay + ")", "网络错误", String(e));
            return;
          }

          if (resp.statusCode !== 200) {
            $notification.post("DeepImg(" + hostDisplay + ")", "HTTP " + resp.statusCode, resp.body);
            return;
          }

          var data = safeJsonParse(resp.body);
          if (!data) {
            $notification.post("DeepImg(" + hostDisplay + ")", "返回非 JSON", resp.body);
            return;
          }

          // 假设返回结构：{ code:0, data:{ reward:10, total:120 } }
          if (data.code === 0) {
            var reward = data.data && data.data.reward !== undefined ? data.data.reward : 0;
            var total = data.data && data.data.total !== undefined ? data.data.total : "未知";
            $notification.post("DeepImg(" + hostDisplay + ") ✅", "今日 +" + reward + " | 累计 " + total,
              "签到成功");
          } else {
            var msg = data.msg !== undefined ? data.msg : "未知错误";
            $notification.post("DeepImg(" + hostDisplay + ") ⚠️", "code " + (data.code !== undefined ?
              data.code : "?") + " - " + msg, resp.body);
          }
        })();
      })(hostKey);
    }
  }

  $done({});
}