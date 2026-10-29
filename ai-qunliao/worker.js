// AI 群聊中转站：一个 Cloudflare Worker，做两件事
//   1. /admin            —— 带密码的设置页，填写和更换各家 API key
//   2. /mcp/<MCP_SECRET> —— MCP 连接器入口，claude.ai 的群聊页面通过它调用各家模型
//
// 需要的绑定（在 Cloudflare 后台设置）：
//   KV              KV 命名空间，存配置和 key
//   ADMIN_PASSWORD  机密，设置页密码
//   MCP_SECRET      机密，一串随机字符，拼进连接器网址里当门票

const OPENROUTER = "https://openrouter.ai/api/v1";

// 群成员的初始配置。OpenRouter 的三家 key 留空时用共享的 OpenRouter key。
const DEFAULT_MEMBERS = [
  { id: "gpt", name: "GPT", base_url: OPENROUTER, model: "", via_openrouter: true },
  { id: "gemini", name: "Gemini", base_url: OPENROUTER, model: "", via_openrouter: true },
  { id: "grok", name: "Grok", base_url: OPENROUTER, model: "", via_openrouter: true },
  { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "kimi", name: "Kimi", base_url: "https://api.moonshot.cn/v1", model: "" },
  { id: "qwen", name: "Qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "glm", name: "GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "" },
];

const MODEL_HINTS = {
  gpt: "例：openai/gpt-5（去 openrouter.ai/models 复制 ID）",
  gemini: "例：google/gemini-2.5-pro",
  grok: "例：x-ai/grok-4",
  deepseek: "例：deepseek-chat",
  kimi: "例：kimi-k2-0905-preview",
  qwen: "例：qwen-plus",
  glm: "例：glm-4.6",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/" || path === "/admin") return html(ADMIN_PAGE);
      if (path.startsWith("/admin/api/")) return await handleAdmin(request, env, path.slice(11), url);
      if (path.startsWith("/mcp/")) {
        if (!env.MCP_SECRET || !(await same(path.slice(5), env.MCP_SECRET))) return new Response("Not found", { status: 404 });
        return await handleMcp(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

// ---------- 配置读写 ----------

async function loadConfig(env) {
  if (!env.KV) throw new Error("没有绑定 KV：请在 Worker 设置 → 绑定 里添加名为 KV 的 KV 命名空间");
  const saved = (await env.KV.get("config", "json")) || {};
  const byId = Object.fromEntries((saved.members || []).map((m) => [m.id, m]));
  return {
    openrouter_key: saved.openrouter_key || "",
    members: DEFAULT_MEMBERS.map((d) => ({ enabled: true, api_key: "", ...d, ...(byId[d.id] || {}) })),
  };
}

function resolveKey(cfg, m) {
  return m.api_key || (m.via_openrouter ? cfg.openrouter_key : "");
}

function isReady(cfg, m) {
  return Boolean(m.enabled && m.base_url && m.model && resolveKey(cfg, m));
}

function mask(key) {
  return key ? "••••" + key.slice(-4) : "";
}

// ---------- 调用各家模型（OpenAI 兼容接口）----------

async function callModel(cfg, m, messages, opts = {}) {
  const key = resolveKey(cfg, m);
  if (!m.enabled) throw new Error(`${m.name} 已被关闭`);
  if (!key) throw new Error(`${m.name} 还没有填 key`);
  if (!m.model) throw new Error(`${m.name} 还没有填模型名`);
  let endpoint = m.base_url.trim().replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";

  const body = { model: m.model, messages, stream: false };
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  if (endpoint.startsWith(OPENROUTER)) headers["X-Title"] = "AI Group Chat";

  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(110000) });
  } catch (e) {
    throw new Error(`${m.name} 连不上（${e.name === "TimeoutError" ? "超时" : "网络错误"}），检查接口地址`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const detail = (data && (data.error?.message || data.message || data.msg)) || raw.slice(0, 200);
    throw new Error(`${m.name} ${explainStatus(res.status)}（HTTP ${res.status}：${detail}）`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${m.name} 返回了空内容`);
  return { text: text.trim(), model: data.model || m.model, usage: data.usage || null };
}

function explainStatus(s) {
  if (s === 401 || s === 403) return "key 无效或已过期";
  if (s === 402) return "余额不足";
  if (s === 404) return "接口地址或模型名不对";
  if (s === 429) return "被限速了，或额度用完";
  if (s >= 500) return "服务器出错";
  return "请求失败";
}

// ---------- 设置页 API ----------

async function handleAdmin(request, env, action, url) {
  if (!env.ADMIN_PASSWORD) return json({ error: "还没设置 ADMIN_PASSWORD 机密" }, 500);
  if (!(await same(request.headers.get("X-Admin-Password") || "", env.ADMIN_PASSWORD))) return json({ error: "密码不对" }, 401);
  const cfg = await loadConfig(env);

  if (action === "config" && request.method === "GET") {
    return json({
      openrouter_key: mask(cfg.openrouter_key),
      members: cfg.members.map((m) => ({ ...m, api_key: mask(m.api_key), ready: isReady(cfg, m), hint: MODEL_HINTS[m.id] })),
      connector_url: env.MCP_SECRET ? `${url.origin}/mcp/${env.MCP_SECRET}` : null,
    });
  }

  if (action === "config" && request.method === "POST") {
    const input = await request.json();
    // key 字段：undefined 表示不改，"" 表示清空，其余为新 key
    if (typeof input.openrouter_key === "string") cfg.openrouter_key = input.openrouter_key.trim();
    for (const patch of input.members || []) {
      const m = cfg.members.find((x) => x.id === patch.id);
      if (!m) continue;
      if (typeof patch.name === "string" && patch.name.trim()) m.name = patch.name.trim().slice(0, 20);
      if (typeof patch.base_url === "string") m.base_url = patch.base_url.trim();
      if (typeof patch.model === "string") m.model = patch.model.trim();
      if (typeof patch.enabled === "boolean") m.enabled = patch.enabled;
      if (typeof patch.api_key === "string") m.api_key = patch.api_key.trim();
    }
    const stored = { openrouter_key: cfg.openrouter_key, members: cfg.members.map(({ hint, ready, ...m }) => m) };
    await env.KV.put("config", JSON.stringify(stored));
    return json({ ok: true });
  }

  if (action === "test" && request.method === "POST") {
    const { id } = await request.json();
    const m = cfg.members.find((x) => x.id === id);
    if (!m) return json({ error: "没有这个成员" }, 400);
    try {
      const r = await callModel({ ...cfg }, { ...m, enabled: true }, [{ role: "user", content: "用一句话打个招呼，不超过15个字。" }], { max_tokens: 60 });
      return json({ ok: true, text: r.text, model: r.model });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  }

  return json({ error: "未知操作" }, 404);
}

// ---------- MCP（Streamable HTTP，无状态，只用 JSON 响应）----------

const TOOLS = [
  {
    name: "list_members",
    description: "列出群聊里除 Claude 外的 AI 成员：id、显示名、模型名、是否可用（ready）。不含 key。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chat",
    description: "让一个 AI 成员根据给定的对话回一条消息。messages 用 OpenAI 格式（system/user/assistant），返回它的回复文本。",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "成员 id，如 deepseek、gpt" },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: { role: { type: "string", enum: ["system", "user", "assistant"] }, content: { type: "string" } },
            required: ["role", "content"],
          },
        },
        max_tokens: { type: "integer", minimum: 1, maximum: 8000 },
        temperature: { type: "number", minimum: 0, maximum: 2 },
      },
      required: ["member", "messages"],
    },
  },
];

async function handleMcp(request, env) {
  if (request.method === "GET" || request.method === "DELETE") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let payload;
  try { payload = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }

  const batch = Array.isArray(payload);
  const replies = [];
  for (const msg of batch ? payload : [payload]) {
    if (msg && msg.id !== undefined && msg.id !== null) replies.push(await handleRpc(msg, env));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

async function handleRpc(msg, env) {
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: params.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-qunliao", version: "1.0.0" },
          instructions: "AI 群聊中转站：用 list_members 查看成员，用 chat 让某个成员回复。",
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return rpcResult(id, await callTool(params.name, params.arguments || {}, env));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, String(e && e.message || e));
  }
}

async function callTool(name, args, env) {
  const cfg = await loadConfig(env);
  if (name === "list_members") {
    const members = cfg.members.map((m) => ({ id: m.id, name: m.name, model: m.model, enabled: m.enabled, ready: isReady(cfg, m) }));
    return toolOk({ members });
  }
  if (name === "chat") {
    const m = cfg.members.find((x) => x.id === args.member);
    if (!m) return toolErr(`没有成员 ${args.member}`);
    const messages = Array.isArray(args.messages)
      ? args.messages.filter((x) => x && ["system", "user", "assistant"].includes(x.role) && typeof x.content === "string" && x.content)
      : [];
    if (!messages.length) return toolErr("messages 是空的");
    try {
      const r = await callModel(cfg, m, messages, { max_tokens: args.max_tokens, temperature: args.temperature });
      return toolOk({ member: m.id, name: m.name, text: r.text, model: r.model });
    } catch (e) {
      return toolErr(e.message);
    }
  }
  return toolErr(`未知工具 ${name}`);
}

function toolOk(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj };
}
function toolErr(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------- 小工具 ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function html(body) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
}
// 比较两个字符串的哈希，避免按字符逐个比较泄露时间信息
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// ---------- 设置页 ----------

const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>群聊中转站设置</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#22211f;--muted:#6f6b64;--line:#e3e0d9;--accent:#c4622d;--ok:#2f7d4f;--bad:#b3362c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1a1918;--card:#242321;--fg:#ecebe8;--muted:#a19d95;--line:#3a3835;--accent:#e08350;--ok:#5fbf86;--bad:#ef7a6f;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px;display:grid;gap:16px}
h1{font-size:22px;margin:0}
p.sub{margin:4px 0 0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;display:grid;gap:10px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row>label{flex:1 1 200px;display:grid;gap:4px;font-size:13px;color:var(--muted);min-width:0}
input[type=text],input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{padding:8px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.small{padding:5px 10px;font-size:13px}
.head{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap}
.head b{font-size:16px}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.no{color:var(--muted)}
.msg{font-size:13px;color:var(--muted);word-break:break-all}
.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;background:var(--bg);padding:6px 8px;border-radius:6px;display:block}
.bar{position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent,var(--bg) 30%);display:flex;gap:10px;align-items:center}
[hidden]{display:none!important}
</style></head><body><main>
<div><h1>群聊中转站</h1><p class="sub">在这里填写和更换各家 API key。key 只存在你自己的 Cloudflare 里。</p></div>

<form id="login" class="card">
  <div class="row"><label>设置页密码<input id="pw" type="password" autocomplete="current-password" required></label></div>
  <div class="row"><button class="primary" type="submit">进入</button><span id="loginMsg" class="msg"></span></div>
</form>

<div id="app" hidden style="display:grid;gap:16px">
  <div class="card">
    <div class="head"><b>连接器网址</b></div>
    <p class="msg">在 claude.ai → 设置 → 连接器 → 添加自定义连接器，把下面这串粘进去。不要发给别人。</p>
    <code id="connUrl"></code>
    <div class="row"><button type="button" class="small" id="copyConn">复制</button></div>
  </div>
  <div class="card">
    <div class="head"><b>OpenRouter 共享 key</b></div>
    <p class="msg">GPT、Gemini、Grok 自己的 key 留空时，用这个。</p>
    <div class="row"><label>key<input id="orKey" type="text" autocomplete="off"></label></div>
    <div class="row"><button type="button" class="small" id="orClear">清除这个 key</button></div>
  </div>
  <div id="members" style="display:grid;gap:16px"></div>
  <div class="bar"><button class="primary" type="button" id="save">保存</button><span id="saveMsg" class="msg"></span></div>
</div>

<script>
let pw = sessionStorage.getItem("pw") || "";
const $ = (s) => document.querySelector(s);
let state = null;
let cleared = new Set();

async function api(path, opts = {}) {
  const res = await fetch("/admin/api/" + path, { ...opts, headers: { "Content-Type": "application/json", "X-Admin-Password": pw } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

async function load() {
  state = await api("config");
  cleared = new Set();
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#connUrl").textContent = state.connector_url || "还没设置 MCP_SECRET 机密";
  $("#orKey").value = "";
  $("#orKey").placeholder = state.openrouter_key ? "已保存 " + state.openrouter_key + "，留空不改" : "sk-or-...";
  const box = $("#members");
  box.innerHTML = "";
  for (const m of state.members) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = m.id;
    el.innerHTML =
      '<div class="head"><b></b><span class="pill"></span></div>' +
      '<div class="row"><label>显示名<input type="text" data-f="name"></label><label>模型名<input type="text" data-f="model"></label></div>' +
      '<div class="row"><label>接口地址<input type="text" data-f="base_url"></label></div>' +
      '<div class="row"><label>key<input type="text" data-f="api_key" autocomplete="off"></label></div>' +
      '<div class="row"><label style="flex:0 0 auto;display:flex;gap:6px;align-items:center;color:var(--fg)"><input type="checkbox" data-f="enabled">在群里</label>' +
      '<button type="button" class="small" data-act="test">测试</button><button type="button" class="small" data-act="clear">清除 key</button></div>' +
      '<div class="msg" data-out></div>';
    el.querySelector("b").textContent = m.name;
    const pill = el.querySelector(".pill");
    pill.textContent = m.ready ? "可用" : "未就绪";
    pill.className = "pill " + (m.ready ? "ok" : "no");
    el.querySelector('[data-f=name]').value = m.name;
    el.querySelector('[data-f=model]').value = m.model;
    el.querySelector('[data-f=model]').placeholder = m.hint || "";
    el.querySelector('[data-f=base_url]').value = m.base_url;
    const k = el.querySelector('[data-f=api_key]');
    k.placeholder = m.api_key ? "已保存 " + m.api_key + "，留空不改" : (m.via_openrouter ? "留空则用 OpenRouter 共享 key" : "sk-...");
    el.querySelector('[data-f=enabled]').checked = m.enabled;
    el.querySelector('[data-act=clear]').onclick = () => { cleared.add(m.id); k.value = ""; k.placeholder = "保存后清除"; };
    el.querySelector('[data-act=test]').onclick = async () => {
      const out = el.querySelector("[data-out]");
      out.className = "msg"; out.textContent = "先保存，再测试…";
      try {
        await save(true);
        const r = await api("test", { method: "POST", body: JSON.stringify({ id: m.id }) });
        out.className = "msg " + (r.ok ? "ok" : "bad");
        out.textContent = r.ok ? "通了（" + r.model + "）：" + r.text : r.error;
      } catch (e) { out.className = "msg bad"; out.textContent = e.message; }
    };
    box.append(el);
  }
}

function collect() {
  const body = { members: [] };
  const or = $("#orKey").value.trim();
  if (or) body.openrouter_key = or;
  if (cleared.has("__or")) body.openrouter_key = "";
  for (const el of document.querySelectorAll("#members .card")) {
    const id = el.dataset.id;
    const v = (f) => el.querySelector("[data-f=" + f + "]");
    const patch = { id, name: v("name").value, model: v("model").value, base_url: v("base_url").value, enabled: v("enabled").checked };
    const key = v("api_key").value.trim();
    if (key) patch.api_key = key; else if (cleared.has(id)) patch.api_key = "";
    body.members.push(patch);
  }
  return body;
}

async function save(quiet) {
  const msg = $("#saveMsg");
  msg.className = "msg"; msg.textContent = "保存中…";
  try {
    await api("config", { method: "POST", body: JSON.stringify(collect()) });
    msg.className = "msg ok"; msg.textContent = "已保存";
    if (!quiet) await load();
  } catch (e) { msg.className = "msg bad"; msg.textContent = e.message; throw e; }
}

$("#orClear").onclick = () => { cleared.add("__or"); $("#orKey").value = ""; $("#orKey").placeholder = "保存后清除"; };
$("#save").onclick = () => save(false).catch(() => {});
$("#copyConn").onclick = async () => {
  try { await navigator.clipboard.writeText($("#connUrl").textContent); $("#copyConn").textContent = "已复制"; }
  catch { getSelection().selectAllChildren($("#connUrl")); }
};
$("#login").onsubmit = async (e) => {
  e.preventDefault();
  pw = $("#pw").value;
  try { await load(); sessionStorage.setItem("pw", pw); }
  catch (err) { $("#loginMsg").className = "msg bad"; $("#loginMsg").textContent = err.message; }
};
if (pw) load().catch(() => { sessionStorage.removeItem("pw"); pw = ""; });
</script>
</main></body></html>`;
