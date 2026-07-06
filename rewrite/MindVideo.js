/******************************

脚本功能：MindVideo AI 每日签到领积分
更新时间：2026-07-07
使用说明：
  1. 打开 Quantumult X，配置好 [MITM] 后访问 mindvideo.ai 并登录
  2. 登录后脚本自动抓取 Cookie 并保存
  3. 添加定时任务，每天 00:04 自动签到

[rewrite_local]
^https?:\/\/.*mindvideo.* url script-request-header https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/MindVideo.js

[task_local]
4 0 * * * https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/rewrite/MindVideo.js, tag=MindVideo签到, img-url=https://raw.githubusercontent.com/GaoZitian/QuantumultX/main/icons/MindVideo.png, enabled=true

[MITM]
hostname = %APPEND% mindvideo.ai, *.mindvideo.ai, *api-app.mindvideo.ai

******************************/

const STORE_KEY = "MindVideo_Checkin_Store";
const API_BASE = "https://api-app.mindvideo.ai";

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
    console.log("[MindVideo] 读取存储失败:", e);
    return {};
  }
}

function saveStore(store) {
  try {
    if (typeof $prefs === "undefined") return false;
    return $prefs.setValueForKey(JSON.stringify(store), STORE_KEY);
  } catch (e) {
    console.log("[MindVideo] 保存存储失败:", e);
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

// ============ 抓取 Cookie（rewrite 脚本触发） ============
const isGetHeader = typeof $request !== "undefined" && $request.headers;

if (isGetHeader) {
  const headers = $request.headers;
  const url = $request.url || "";
  const cookie = headers["Cookie"] || headers["cookie"] || "";
  const auth = headers["Authorization"] || headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  // 每次请求都弹窗——诊断 rewrite 是否触发
  console.log(`[MindVideo] === Rewrite 脚本被触发 ===`);
  console.log(`[MindVideo] 请求URL: ${url}`);
  console.log(`[MindVideo] Cookie: ${cookie ? cookie.substring(0, 50) + "..." : "无"}`);
  console.log(`[MindVideo] Auth: ${token ? token.substring(0, 20) + "..." : "无"}`);

  // 无条件弹窗确认 rewrite 已生效（每个匹配请求都弹一次）
  $notify("MindVideo 签到", "脚本被触发", `URL: ${url.substring(0, 40)}...`);

  // 首次触发时记录（用于后续逻辑），但弹窗已经在上面发了
  const store = getStore();
  if (!store._firstTriggered) {
    store._firstTriggered = true;
    saveStore(store);
  }

  if (!cookie && !token) {
    console.log("[MindVideo] 无认证信息，跳过 (登录前的请求/SPA 渲染请求本就没有)");
    return $done({});
  }

  if (cookie) store.cookie = cookie;
  if (token) store.token = token;
  store.updatedAt = Date.now();
  saveStore(store);

  console.log("[MindVideo] 认证信息已保存");
  $notify("MindVideo 签到", "认证信息获取成功", `已保存登录凭证\n来源: ${url.substring(0, 50)}...`);
  $done({});
} else {
  // ============ 定时签到 / 查看账号 ============
  const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  const store = getStore();

  // 查看已保存账号
  if (String(args.list || "").trim() === "1") {
    const cookie = store.cookie || "";
    const token = store.token || "";
    if (!cookie && !token) {
      $notify("MindVideo 签到", "已保存账号", "暂无已保存的认证信息，请先登录 mindvideo.ai");
    } else {
      const updated = store.updatedAt ? formatDate(store.updatedAt) : "未知";
      let info = `更新时间: ${updated}`;
      if (cookie) {
        const masked = cookie.substring(0, 20) + "...";
        info += `\nCookie: ${masked}`;
      }
      if (token) {
        const masked = token.substring(0, 16) + "..." + token.substring(token.length - 8);
        info += `\nToken: ${masked}`;
      }
      $notify("MindVideo 签到", "已保存账号", info);
    }
    return $done();
  }

  // 检查是否有认证信息
  if (!store.cookie && !store.token) {
    $notify("MindVideo 签到", "无可用认证信息", "请先访问 mindvideo.ai 并登录");
    return $done();
  }

  // 构建请求头
  function buildHeaders() {
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Origin": "https://www.mindvideo.ai",
      "Referer": "https://www.mindvideo.ai/",
    };
    if (store.cookie) headers["Cookie"] = store.cookie;
    if (store.token) headers["Authorization"] = `Bearer ${store.token}`;
    return headers;
  }

  // 查询积分
  const queryCredits = () => {
    return new Promise((resolve) => {
      $task.fetch({
        url: `${API_BASE}/api/credits`,
        method: "GET",
        headers: buildHeaders(),
      }).then((resp) => {
        const data = safeJsonParse(resp.body);
        resolve(data);
      }).catch(() => {
        resolve(null);
      });
    });
  };

  // 执行签到
  const doCheckin = () => {
    $task.fetch({
      url: `${API_BASE}/api/checkin`,
      method: "POST",
      headers: {
        ...buildHeaders(),
        "Content-Type": "application/json",
      },
      body: "",
    }).then(
      (resp) => {
        const status = resp.statusCode;
        const body = resp.body || "";
        const data = safeJsonParse(body);

        if (!data) {
          console.log(`[MindVideo] 解析失败 | HTTP ${status} | ${body.substring(0, 200)}`);
          $notify("MindVideo 签到", "响应解析失败", `HTTP ${status}`);
          return $done();
        }

        const code = data.code;
        const message = data.message || data.msg || "";
        const d = data.data || {};

        if (status === 200 && (code === 0 || code === 200 || code === "0" || code === "200")) {
          const credits = parseInt(d.credits || d.reward_credits || d.points || 0);
          const total = parseInt(d.total_credits || d.total_points || d.balance || 0);
          console.log(`[MindVideo] 签到成功 | +${credits}积分 | 总计${total}`);
          $notify("MindVideo 签到 ✓", `签到成功，获得 ${credits} 积分`, `总积分: ${total}`);
          return $done();
        }

        if (status === 200 && (message.includes("already") || message.includes("已签到") || message.includes("今日已签到") || message.includes("Already"))) {
          queryCredits().then((creditData) => {
            const total = creditData?.data?.total_credits || creditData?.data?.total_points || creditData?.data?.balance || 0;
            console.log(`[MindVideo] 今日已签到 | 总计${total}`);
            $notify("MindVideo 签到", "今日已签到", `今天已经签到过了\n总积分: ${total}`);
          });
          return $done();
        }

        if (status === 401 || status === 403) {
          console.log(`[MindVideo] 登录失效 | HTTP ${status} | code=${code}`);
          $notify("MindVideo 签到", "登录失效", "认证信息已过期，请重新登录 mindvideo.ai");
          const s = getStore();
          delete s.cookie;
          delete s.token;
          saveStore(s);
          return $done();
        }

        console.log(`[MindVideo] 签到失败 | HTTP ${status} | code=${code} | ${message}`);
        $notify("MindVideo 签到", "签到失败", message || `HTTP ${status}`);
        return $done();
      },
      (reason) => {
        const err = reason?.error ? String(reason.error) : String(reason || "");
        console.log(`[MindVideo] 网络错误 | ${err}`);
        $notify("MindVideo 签到", "网络错误", err);
        return $done();
      }
    );
  };

  doCheckin();
}
