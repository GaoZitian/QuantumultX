/******************************

脚本功能：DeepImg 每日签到领积分
更新时间：2026-06-12
使用说明：
  1. 打开 Quantumult X，配置好 [MITM] 后访问 deepimg.io 并登录
  2. 登录后脚本自动抓取 Token 并保存
  3. 添加定时任务，每天 00:04 自动签到

[rewrite_local]
^https:\/\/api\.deepimg\.ai\/api\/user\/credits\/stats url script-request-header https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/DeepImg.js

[task_local]
4 0 * * * https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/DeepImg.js, tag=DeepImg签到, img-url=https://raw.githubusercontent.com/Orz-3/mini/master/Color/Kuai.png, enabled=true

查看已保存账号（可选）
4 0 * * * https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/DeepImg.js, tag=DeepImg查看账号, img-url=https://raw.githubusercontent.com/Orz-3/mini/master/Color/Kuai.png, enabled=true, argument=list=1

[MITM]
hostname = %APPEND% api.deepimg.ai

******************************/

const STORE_KEY = "DeepImg_Checkin_Store";
const API_BASE = "https://api.deepimg.ai";

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

function getStore() {
  try {
    if (typeof $prefs === "undefined") return {};
    const raw = $prefs.valueForKey(STORE_KEY);
    if (!raw) return {};
    const obj = safeJsonParse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (e) {
    console.log("[DeepImg] 读取存储失败:", e);
    return {};
  }
}

function saveStore(store) {
  try {
    if (typeof $prefs === "undefined") return false;
    return $prefs.setValueForKey(JSON.stringify(store), STORE_KEY);
  } catch (e) {
    console.log("[DeepImg] 保存存储失败:", e);
    return false;
  }
}

function parseArgs(str) {
  const out = {};
  if (!str) return out;
  const s = String(str).trim();
  if (!s) return out;
  for (const part of s.split("&")) {
    const seg = part.trim();
    if (!seg) continue;
    const idx = seg.indexOf("=");
    if (idx === -1) { out[decodeURIComponent(seg)] = ""; }
    else { out[decodeURIComponent(seg.slice(0, idx))] = decodeURIComponent(seg.slice(idx + 1)); }
  }
  return out;
}

function formatDate(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  } catch (_) { return "未知"; }
}

function fetchTotalCredits(token, callback) {
  $task.fetch({
    url: `${API_BASE}/api/user/credits/stats`,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  }).then((resp) => {
    const data = safeJsonParse(resp.body);
    callback(data?.data?.total_credits || 0);
  }).catch(() => {
    const store = getStore();
    callback(store.lastTotal || 0);
  });
}

// ============ 抓取 Token（rewrite 脚本触发） ============
const isGetHeader = typeof $request !== "undefined" && $request.headers;

if (isGetHeader) {
  const headers = $request.headers;
  const auth = headers["Authorization"] || headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    $notify("DeepImg 签到", "抓取失败", "未找到 Authorization 头，请先登录 deepimg.io");
    return $done({});
  }

  const store = getStore();
  store.token = token;
  store.updatedAt = Date.now();
  saveStore(store);

  console.log("[DeepImg] Token 已保存");
  $notify("DeepImg 签到", "Token 获取成功", "已保存登录凭证，定时任务将自动签到");
  $done({});
} else {
  // ============ 定时签到 / 查看账号 ============
  const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  const store = getStore();

  // 查看已保存账号
  if (String(args.list || "").trim() === "1") {
    const token = store.token;
    if (!token) {
      $notify("DeepImg 签到", "已保存账号", "暂无已保存的 Token，请先登录 deepimg.io");
    } else {
      const updated = store.updatedAt ? formatDate(store.updatedAt) : "未知";
      const masked = token.substring(0, 16) + "..." + token.substring(token.length - 8);
      $notify("DeepImg 签到", "已保存账号", `Token: ${masked}\n更新时间: ${updated}`);
    }
    return $done();
  }

  // 检查是否有 Token
  if (!store.token) {
    $notify("DeepImg 签到", "无可用 Token", "请先访问 deepimg.io 并登录");
    return $done();
  }

  // 执行签到
  const doCheckin = () => {
    $task.fetch({
      url: `${API_BASE}/api/checkin`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${store.token}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Origin": "https://deepimg.io",
        "Referer": "https://deepimg.io/",
      },
      body: "",
    }).then(
      (resp) => {
        const status = resp.statusCode;
        const body = resp.body || "";
        const data = safeJsonParse(body);

        if (!data) {
          console.log(`[DeepImg] 解析失败 | HTTP ${status} | ${body.substring(0, 200)}`);
          $notify("DeepImg 签到", "响应解析失败", `HTTP ${status}`);
          return $done();
        }

        const code = data.code;
        const message = data.message || "";
        const d = data.data || {};

        // 成功
        if (status === 200 && code === 0) {
          const credits = d.single_checkin_credits || 0;
          const day = d.current_day || 0;

          fetchTotalCredits(store.token, (total) => {
            console.log(`[DeepImg] 签到成功 | +${credits}积分 | 连续${day}天 | 总计${total}`);
            $notify("DeepImg 签到 ✓", `签到成功，获得 ${credits} 积分`, `连续签到 ${day} 天\n总积分: ${total}`);

            const cache = getStore();
            cache.lastCredits = credits;
            cache.lastTotal = total;
            cache.lastDay = day;
            saveStore(cache);

            return $done();
          });
          return;
        }

        // 已签到
        if (status === 200 && (message.includes("already") || message.includes("已签到") || message.includes("今日已签到"))) {
          fetchTotalCredits(store.token, (total) => {
            console.log(`[DeepImg] 今日已签到 | 总计${total}`);
            $notify("DeepImg 签到", "今日已签到", message || "今天已经签到过了");
            return $done();
          });
          return;
        }

        // 登录失效
        if (status === 401 || status === 403 || code === 20001) {
          console.log(`[DeepImg] 登录失效 | HTTP ${status} | code=${code}`);
          $notify("DeepImg 签到", "登录失效", "Token 已过期，请重新登录 deepimg.io");
          const s = getStore();
          delete s.token;
          saveStore(s);
          return $done();
        }

        // 其他错误
        console.log(`[DeepImg] 签到失败 | HTTP ${status} | code=${code} | ${message}`);
        $notify("DeepImg 签到", "签到失败", message || `HTTP ${status}`);
        return $done();
      },
      (reason) => {
        const err = reason?.error ? String(reason.error) : String(reason || "");
        console.log(`[DeepImg] 网络错误 | ${err}`);
        $notify("DeepImg 签到", "网络错误", err);
        return $done();
      }
    );
  };

  doCheckin();
}
