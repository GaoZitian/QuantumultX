
//    Quantumult X – DeepImg 登录凭证自动抓取

//    功能：
//      1️⃣ 抓取登录接口返回的 token（JSON 里） → 保存为 deepimg_token
//      2️⃣ 抓取 Set‑Cookie（auth_token） → 保存为 deepimg_cookie

//    只需要一次手动登录或打开每日签到弹窗，凭证会自动写入本地
//    后续签到脚本直接读取 $prefs 中的这两个键即可。


function setKey(key, value) {
    if (value) {
        $prefs.setValueForKey(value, key);
        console.log("[DeepImg] 保存 " + key + " → " + value);
    }
}


// ① 处理登录接口（返回 JSON，里面可能包含 token）

if ($request && $request.method === "POST" && /\/api\/v[0-9]+\/auth\/login/.test($request.url)) {
    try {
        const obj = JSON.parse($response.body);
        // ── 根据实际返回结构自行修改下面的取值路径 ────────
        // 常见形态：{ data:{ token:"xxxxx" } }   或   { token:"xxxxx" }
        const token = obj?.data?.token || obj?.token || null;
        if (token) {
            setKey("deepimg_token", token);   // 供后续签到脚本使用
        } else {
            console.warn("[DeepImg] 登录响应未检测到 token，请核实返回结构");
        }
    } catch (e) {
        console.error("[DeepImg] 登录 JSON 解析错误 → " + e);
    }
}


//    ② 处理登录后或打开签到弹窗时返回的 Set‑Cookie

if ($response && $response.headers && $response.headers["Set-Cookie"]) {
    const raw = $response.headers["Set-Cookie"]; // 可能是数组或字符串
    let cookieStr = "";

    if (Array.isArray(raw)) {
        cookieStr = raw.map(v => v.split(";")[0]).join("; ");
    } else {
        cookieStr = raw.split(";")[0];
    }

    // DeepImg 常用的关键 cookie 为 auth_token
    const match = cookieStr.match(/auth_token=([^;]+)/);
    if (match) {
        setKey("deepimg_cookie", "auth_token=" + match[1]);
    } else {
        // 未匹配到 auth_token，直接把整条 cookie 保存（兜底）
        setKey("deepimg_cookie", cookieStr);
    }
}

$done({});

// 3️⃣ 每日签到脚本 deepimg_sign.js

//   Quantumult X – DeepImg 每日签到

//   读取 deepimg_auth.js 保存的 token / cookie，发起签到请求并弹出通知。

//   只要一次手动登录后本脚本即可每天自动运行，配合 Cron 定时任务即可。



const SIGN_URL = "https://deepimg.io/api/v1/user/signin";   // ← 实际签到 API（请确认）
const SIGN_METHOD = "POST";                                   // ← POST / GET 根据实际情况修改

// ------------------- 读取本地凭证 -------------------
const bearerToken = $prefs.valueForKey("deepimg_token"); // Bearer token（如果登录返回了 token）
const cookie = $prefs.valueForKey("deepimg_cookie"); // Cookie（如果登录用了 Set‑Cookie）

if (!bearerToken && !cookie) {
    $notification.post(
        "DeepImg 签到 ❗️",
        "未检测到登录凭证",
        "请先手动登录一次，脚本会自动抓取并保存 token / cookie"
    );
    $done();
    return;
}

// ------------------- 组装请求 Header -------------------
let headers = {
    "User-Agent": "Quantumult X", // 可自行改成浏览器的 UA，提升成功率
    "Accept": "application/json, text/plain, /",
    "Content-Type": "application/json"
};

if (bearerToken) {
    headers["Authorization"] = "Bearer " + bearerToken;
} else if (cookie) {
    headers["Cookie"] = cookie;
}

// ------------------- 发起签到请求 -------------------
(async () => {
    const req = {
        url: SIGN_URL,
        method: SIGN_METHOD,
        header: headers,
        // 若接口不需要 body，保持空对象即可；如需其它字段自行修改
        body: SIGN_METHOD === "GET" ? undefined : JSON.stringify({})
    };

    let resp;
    try {
        resp = await $task.fetch(req);
    } catch (e) {
        $notification.post("DeepImg 签到 ❌", "网络请求失败", String(e));
        $done(); return;
    }

    // ------------------- 状态码判断 -------------------
    if (resp.statusCode !== 200) {
        $notification.post("DeepImg 签到 ❌", "HTTP " + resp.statusCode, resp.body);
        $done(); return;
    }

    // ------------------- 解析返回体 -------------------
    let data;
    try {
        data = JSON.parse(resp.body);
    } catch (e) {
        $notification.post("DeepImg 签到 ❌", "返回非 JSON", resp.body);
        $done(); return;
    }

    // ---------- 根据实际返回结构自行修改这里 ----------
    // 示例返回：{ code:0, data:{ reward:10, total:120 } }
    if (data.code === 0) {
        const todayReward = data?.data?.reward ?? 0;
        const totalReward = data?.data?.total ?? "未知";

        // 持久化本次奖励（后续可以在别的脚本里读取）
        $prefs.setValueForKey(todayReward, "deepimg_today_reward");
        $prefs.setValueForKey(totalReward, "deepimg_total_reward");

        $notification.post(
            "DeepImg 签到 ✅",
            "今日奖励 " + todayReward + " 枚\n累计 " + totalReward,
            "签到成功"
        );
    } else {
        const msg = data.msg ?? "未知错误";
        $notification.post(
            "DeepImg 签到 ⚠️",
            "code " + data.code + " - " + msg,
            resp.body
        );
    }

    $done();
})();