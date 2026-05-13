

// Quantumult X 识别块
/**
[rewrite_local]
   捕获任意域名下的 DeepImg 登录或签到返回（token / auth_token）
   ^ https ?://[^/]+/api/v[0-9]+/(auth/login|user/signin) url script-response-body
https://raw.githubusercontent.com/GaoZitian/QuantumultX/refs/heads/main/rewrite/DeepImg.js

[task_local]
每天自动执行一次签到（使用同一脚本）
0 0    https://raw.githubusercontent.com/GaoZitian/QuantumultX/refs/heads/main/rewrite/DeepImg.js,
tag = DeepImg 每日签到, enabled = true
 */
//  常量 & 工具
const STORE_KEY = "DeepImg_Store";


//  安全 JSON 解析

function safeParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

//  归一化 host
function normHost(h) {
  return String(h || "").trim().toLowerCase();
}

// 只保留我们需要的请求头字段
function pickHeaders(src) {
  var dst = {};
  var lower = {};
  if (!src) return dst;
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
    if (val !== undefined) dst[key] = val;
  }
  return dst;
}

// / -------------------  ------------------- /
function loadStore() {
  try {
    var raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) return { hosts: {} };
    var obj = safeParse(raw);
    if (!obj || typeof obj !== "object") return { hosts: {} };
    if (!obj.hosts) obj.hosts = {};
    return obj;
  } catch (e) {
    return { hosts: {} };
  }
}
function saveStore(st) {
  try {
    $prefs.setValueForKey(JSON.stringify(st), STORE_KEY);
    return true;
  } catch (e) {
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

  // 直接从请求 URL 中拿 host（不依赖 MITM 配置的域名列表）
  var host = hdr.Host || hdr.host;
  if (!host) {
    try { host = normHost(new URL(url).hostname); }
    catch (e) { host = ""; }
  } else {
    host = normHost(host);
  }

  // ----- 捕获登录返回的 token -----
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

  // ----- 捕获 Set‑Cookie（auth_token） -----
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

//  ② Task（Cron）
if (typeof $request === "undefined") {
  (async () => {
    var store = loadStore();
    if (!store.hosts || Object.keys(store.hosts).length === 0) {
      $notification.post("DeepImg 签到", "未检测到已保存的登录凭证", "请先手动登录一次 DeepImg");
      $done();
      return;
    }

    // 遍历所有已保存的 host / uid 执行签到
    for (var h in store.hosts) {
      if (!Object.prototype.hasOwnProperty.call(store.hosts, h)) continue;
      var users = store.hosts[h].users || {};
      for (var uid in users) {
        if (!Object.prototype.hasOwnProperty.call(users, uid)) continue;
        var user = users[uid];
        if (!user) continue;

        // 合并请求头：Cookie > Authorization
        var hdr2 = {};
        if (user.headers) {
          for (var hk in user.headers) {
            if (Object.prototype.hasOwnProperty.call(user.headers, hk)) hdr2[hk] = user.headers[hk];
          }
        }
        if (user.cookie) hdr2.Cookie = user.cookie;
        if (user.token) hdr2.Authorization = "Bearer " + user.token;

        var signUrl = "https://" + h + "/api/v1/user/signin";
        var req = {
          url: signUrl,
          method: "POST",
          header: hdr2,
          body: "{}",   // DeepImg 签到不需要额外参数
        };

        var resp;
        try {
          resp = await $task.fetch(req);
        } catch (e) {
          $notification.post("DeepImg(" + h + ")", "网络错误", String(e));
          continue;
        }

        if (resp.statusCode !== 200) {
          $notification.post("DeepImg(" + h + ")", "HTTP " + resp.statusCode, resp.body);
          continue;
        }

        var data = safeParse(resp.body);
        if (!data) {
          $notification.post("DeepImg(" + h + ")", "返回非 JSON", resp.body);
          continue;
        }

        // 假设返回结构 { code:0, data:{ reward:10, total:120 } }
        if (data.code === 0) {
          var reward = (data.data && data.data.reward !== undefined) ? data.data.reward : 0;
          var total = (data.data && data.data.total !== undefined) ? data.data.total : "未知";
          $notification.post("DeepImg(" + h + ") ✅", "今日 +" + reward + " | 累计 " + total,
            "签到成功");
        } else {
          var msg = data.msg !== undefined ? data.msg : "未知错误";
          $notification.post("DeepImg(" + h + ") ⚠️", "code " + (data.code !== undefined ? data.code :
            "?") + " - " + msg, resp.body);
        }
      }
    }
    $done();
  })();
}

