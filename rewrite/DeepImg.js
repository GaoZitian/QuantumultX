const STORE_KEY = "DeepImg_Store";

// 工具函数
function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}
function normHost(host) {
  return String(host || "").trim().toLowerCase();
}
function pickHeaders(src) {
  var out = {};
  var lower = {};
  if (!src) return out;
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      lower[String(k).toLowerCase()] = src[k];
    }
  }
  var need = [
    "Host", "User-Agent", "Accept", "Accept-Language", "Accept-Encoding",
    "Origin", "Referer", "Cookie"
  ];
  for (var i = 0; i < need.length; i++) {
    var key = need[i];
    var val = src[key] !== undefined ? src[key] : lower[String(key).toLowerCase()];
    if (val !== undefined) out[key] = val;
  }
  return out;
}

// 本地存取
function loadStore() {
  try {
    var raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) return { hosts: {} };
    var obj = safeParse(raw);
    if (!obj || typeof obj !== "object") return { hosts: {} };
    if (!obj.hosts) obj.hosts = {};
    return obj;
  } catch (e) {
    console.log("[DeepImg] loadStore error: " + e);
    return { hosts: {} };
  }
}
function saveStore(st) {
  try {
    $prefs.setValueForKey(JSON.stringify(st), STORE_KEY);
    return true;
  } catch (e) {
    console.log("[DeepImg] saveStore error: " + e);
    return false;
  }
}
function ensureHost(st, h) {
  if (!st.hosts[h] || typeof st.hosts[h] !== "object") {
    st.hosts[h] = { users: {} };
  }
}

// ① Rewrite：捕获凭证
if (typeof $request !== "undefined") {
  var url = $request.url || "";
  var hdr = $request.headers || {};

  // 从请求本身解析 host，避免 MITM 里写死域名
  var host = hdr.Host || hdr.host;
  if (!host) {
    try { host = normHost(new URL(url).hostname); } catch (e) { host = ""; }
  } else {
    host = normHost(host);
  }

  // ---------- 捕获登录返回的 token ----------
  if (/\/api\/v[0-9]+\/auth\/login/.test(url)) {
    var json = safeParse($response.body);
    var token = null;
    if (json) {
      if (json.data && json.data.token) token = json.data.token;
      else if (json.token) token = json.token;
    }
    if (token) {
      var store = loadStore();
      ensureHost(store, host);
      var uid = "default";
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].token = token;
      store.hosts[host].users[uid].headers = pickHeaders($response.headers);
      saveStore(store);
    }
  }

  // ---------- 捕获 Set‑Cookie（auth_token） ----------
  if ($response.headers && $response.headers["Set-Cookie"]) {
    var raw = $response.headers["Set-Cookie"]; // 可能是数组或字符串
    var cookieStr = "";
    if (Array.isArray(raw)) {
      cookieStr = raw.map(function (v) { return v.split(";")[0]; }).join("; ");
    } else {
      cookieStr = raw.split(";")[0];
    }
    var m = cookieStr.match(/auth_token=([^;]+)/);
    if (m) {
      var store = loadStore();
      ensureHost(store, host);
      var uid = "default";
      if (!store.hosts[host].users[uid]) store.hosts[host].users[uid] = {};
      store.hosts[host].users[uid].cookie = "auth_token=" + m[1];
      store.hosts[host].users[uid].headers = pickHeaders($response.headers);
      saveStore(store);
    }
  }

  $done({});
}

// ② Task（Cron）
if (typeof $request === "undefined") {
  (async function () {
    var store = loadStore();
    if (!store.hosts || Object.keys(store.hosts).length === 0) {
      $notification.post("DeepImg 签到", "未检测到已保存的登录凭证", "请先手动登录一次 DeepImg");
      $done();
      return;
    }

    // 遍历所有已保存的 host（理论上只有 deepimg.io）
    for (var host in store.hosts) {
      if (!Object.prototype.hasOwnProperty.call(store.hosts, host)) continue;
      var users = store.hosts[host].users || {};
      for (var uid in users) {
        if (!Object.prototype.hasOwnProperty.call(users, uid)) continue;
        var user = users[uid];
        if (!user) continue;

        // 合并请求头：Cookie > Authorization
        var hdr2 = {};
        if (user.headers) {
          for (var k in user.headers) {
            if (Object.prototype.hasOwnProperty.call(user.headers, k)) {
              hdr2[k] = user.headers[k];
            }
          }
        }
        if (user.cookie) hdr2.Cookie = user.cookie;
        if (user.token) hdr2.Authorization = "Bearer " + user.token;

        var signUrl = "https://" + host + "/api/v1/user/signin";
        var req = {
          url: signUrl,
          method: "POST",
          header: hdr2,
          body: "{}"
        };

        var resp;
        try { resp = await $task.fetch(req); }
        catch (e) {
          $notification.post("DeepImg(" + host + ")", "网络错误", String(e));
          continue;
        }

        if (resp.statusCode !== 200) {
          $notification.post("DeepImg(" + host + ")", "HTTP " + resp.statusCode, resp.body);
          continue;
        }

        var data = safeParse(resp.body);
        if (!data) {
          $notification.post("DeepImg(" + host + ")", "返回非 JSON", resp.body);
          continue;
        }

        // 预期返回结构 { code:0, data:{ reward:10, total:120 } }
        if (data.code === 0) {
          var reward = (data.data && data.data.reward !== undefined) ? data.data.reward : 0;
          var total = (data.data && data.data.total !== undefined) ? data.data.total : "未知";
          $notification.post("DeepImg(" + host + ") ✅", "今日 +" + reward + " | 累计 " + total,
            "签到成功");
        } else {
          var msg = data.msg !== undefined ? data.msg : "未知错误";
          var codeStr = (data.code !== undefined) ? data.code : "?";
          $notification.post("DeepImg(" + host + ") ⚠️", "code " + codeStr + " - " + msg, resp.body);
        }
      }
    }
    $done();
  })();
}