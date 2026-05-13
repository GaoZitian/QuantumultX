
//  DeepImg – 通用签到脚本（兼容 Rewrite 捕获与 Cron 定时）

//  功能：
//    1️⃣ 捕获登录成功返回的 token（JSON）或 Set‑Cookie（auth_token），保存到本地 $prefs；
//    2️⃣ 定时任务读取本地凭证，向 https://deepimg.io/api/v1/user/signin 发起签到；
//    3️⃣ 支持可选参数（通过 Task 的 argument）：
//         host=deepimg.io            → 只针对指定域名执行（默认遍历全部已保存域名）；
//         uid=default                → DeepImg 只会有一个用户，默认 “default”；
//         delete=1                  → 删除指定 host/uid 的凭证；
//         list=1                     → 列出当前已保存的 host/uid（调试用）；

//  使用步骤（仅需一次手动登录后）：
//    1. 打开 MITM，加入 deepimg.io；
//    2. 将 DeepImg.conf 导入 Quantumult X 的 “Rewrite”；
//    3. 手动登录 DeepImg 一次，脚本会自动抓取 token / cookie；
//    4. 添加一天一次的 Cron（Task）指向本脚本，即可实现每日自动签到。


//  常量
const STORE_KEY = "DeepImg_Store"; // 本地持久化键名
const isRequest = typeof $request !== "undefined"; // true → 当前是 Rewrite 阶段

//  工具函数
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}
function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}
function pickNeedHeaders(src = {}) {
  const dst = {};
  const lower = {};
  for (const k of Object.keys(src || {})) lower[String(k).toLowerCase()] = src[k];
  const get = (n) => src[n] ?? lower[String(n).toLowerCase()];
  const NEED_KEYS = ["Host", "User-Agent", "Accept", "Accept-Language", "Accept-Encoding", "Origin",
    "Referer", "Cookie"];
  for (const k of NEED_KEYS) {
    const v = get(k);
    if (v !== undefined) dst[k] = v;
  }
  return dst;
}

//  本地存储
function loadStore() {
  try {
    const raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) return { hosts: {} };
    const obj = safeJsonParse(raw);
    if (!obj || typeof obj !== "object") return { hosts: {} };
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

//  辅助：解析 Task 参数
function parseArgs(str) {
  const out = {};
  if (!str) return out;
  const s = String(str).trim();
  if (!s) return out;
  for (const part of s.split("&")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq === -1) {
      out[decodeURIComponent(seg)] = "";
    } else {
      const k = decodeURIComponent(seg.slice(0, eq));
      const v = decodeURIComponent(seg.slice(eq + 1));
      out[k] = v;
    }
  }
  return out;
}

//  ① Rewrite：捕获登录信息
if (isRequest) {
  const url = $request.url || "";
  const host = (() => {
    const hdr = $request.headers || {};
    if (hdr.Host) return normalizeHost(hdr.Host);
    if (hdr.host) return normalizeHost(hdr.host);
    try {
      return normalizeHost(new URL($request.url).hostname);
    } catch (_) {
      return "";
    }
  })();

  // ==== 捕获 token（登录返回的 JSON） ====
  if (/\/api\/v[0-9]+\/auth\/login/.test(url)) {
    // 登录成功后返回类似 { data:{ token:"xxxx" } } 或 { token:"xxxx" }
    const body = $response.body;
    const json = safeJsonParse(body);
    const token = json?.data?.token || json?.token;
    if (token) {
      const store = loadStore();
      ensureHostNode(store, host);
      const uid = "default";
      store.hosts[host].users[uid] = store.hosts[host].users[uid] || {};
      store.hosts[host].users[uid].token = token;
      // 记录一次通用请求头，后面签到会复用
      store.hosts[host].users[uid].headers = pickNeedHeaders($response.headers || {});
      saveStore(store);
    }
  }

  // ==== 捕获 Set‑Cookie（auth_token） ====
  if ($response.headers && $response.headers["Set-Cookie"]) {
    const raw = $response.headers["Set-Cookie"]; // 可能是数组或字符串
    let cookieStr = "";
    if (Array.isArray(raw)) {
      cookieStr = raw.map(v => v.split(";")[0]).join("; ");
    } else {
      cookieStr = raw.split(";")[0];
    }
    const m = cookieStr.match(/auth_token=([^;]+)/);
    if (m) {
      const store = loadStore();
      ensureHostNode(store, host);
      const uid = "default";
      store.hosts[host].users[uid] = store.hosts[host].users[uid] || {};
      store.hosts[host].users[uid].cookie = `auth_token=${m[1]}`;
      store.hosts[host].users[uid].headers = pickNeedHeaders($response.headers);
      saveStore(store);
    }
  }

  // Rewrite 阶段结束
  $done({});
}

//  ② Task（Cron）
if (!isRequest) {
  // 读取 Task 传入的 argument（如 host=..., delete=1, list=1 等）
  const args = parseArgs($argument);
  const targetHost = args.host ? normalizeHost(args.host) : ""; // 空串 → 所有已保存 host
  const targetUid = args.uid ? args.uid : "default";
  const doDelete = args.delete === "1";
  const doList = args.list === "1";

  const store = loadStore();

  // ---------- 列表或删除 ----------
  if (doList) {
    // list=1  (可额外限定 host=xxx)
    let out = "";
    for (const h of Object.keys(store.hosts)) {
      if (targetHost && h !== targetHost) continue;
      const users = store.hosts[h].users;
      out += `\n === ${h} ===`;
      for (const u of Object.keys(users)) {
        out += `\n  uid: ${u} token: ${users[u].token ? "✅" : "❌"} cookie: ${users[u].cookie ? "✅" : "❌"}`;
      }
    }
    $notification.post("DeepImg 账户列表", "", out || "暂无已保存账户");
    $done({});
  }

  if (doDelete) {
    // delete=1 & host=... & uid=...
    if (!targetHost) {
      $notification.post("DeepImg 删除", "缺少 host 参数", "请使用 argument=host=deepimg.io&uid=default&delete=1");
      $done({});
    }
    const users = store.hosts[targetHost]?.users;
    if (!users) {
      $notification.post("DeepImg 删除", `未找到 host ${targetHost}`, "");
      $done({});
    }
    if (users[targetUid]) {
      delete users[targetUid];
      // 若该 host 已无用户，直接删除整个 host 节点
      if (Object.keys(users).length === 0) delete store.hosts[targetHost];
      saveStore(store);
      $notification.post("DeepImg 删除", `已删除 ${targetHost} / ${targetUid}`, "");
    } else {
      $notification.post("DeepImg 删除", `未找到 uid ${targetUid}，host: ${targetHost}`);
    }
    $done({});
  }

  // ---------- 正式签到 ----------
  // 需要遍历：满足（host 匹配） && （uid 匹配或全部 uid）
  const hostsToRun = targetHost ? [targetHost] : Object.keys(store.hosts);
  for (const h of hostsToRun) {
    const hostNode = store.hosts[h];
    if (!hostNode) continue;

    const uidList = targetUid ? [targetUid] : Object.keys(hostNode.users);
    for (const uid of uidList) {
      const user = hostNode.users[uid];
      if (!user) continue;

      // 组合请求头，优先使用保存的 cookie，其次是 token
      const hdr = Object.assign({}, user.headers || {});
      if (user.cookie) hdr.Cookie = user.cookie;
      if (user.token) hdr.Authorization = `Bearer ${user.token}`;

      const signUrl = `https://${h}/api/v1/user/signin`;
      const req = {
        url: signUrl,
        method: "POST",
        header: hdr,
        body: "{}", // DeepImg 的签到接口不需要额外参数
      };

      (async () => {
        let resp;
        try {
          resp = await $task.fetch(req);
        } catch (e) {
          $notification.post(`DeepImg(${h})`, "网络错误", String(e));
          return;
        }

        if (resp.statusCode !== 200) {
          $notification.post(`DeepImg(${h})`, `HTTP ${resp.statusCode}`, resp.body);
          return;
        }

        let data;
        try {
          data = safeJsonParse(resp.body);
        } catch (_) {
          $notification.post(`DeepImg(${h})`, "响应非 JSON", resp.body);
          return;
        }

        // 常见返回结构：{ code:0, data:{ reward:10, total:120 } }
        if (data && data.code === 0) {
          const reward = data?.data?.reward ?? 0;
          const total = data?.data?.total ?? "未知";
          $notification.post(`DeepImg(${h}) ✅`, `今日 + ${reward} | 累计 ${total}`, "签到成功");
        } else {
          const msg = data?.msg ?? "未知错误";
          $notification.post(`DeepImg(${h}) ⚠️`, `code ${data?.code ?? "?"} - ${msg}`, resp.body);
        }
      })();
    }
  }

  // Task 结束
  $done({});
}