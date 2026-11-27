import { createClient } from "jsr:@supabase/supabase-js@2";

// 部署时保持公开访问（--no-verify-jwt），账户身份由本函数签发的 HS256 JWT 校验。
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let supabase: ReturnType<typeof createClient> | undefined;
let signingKey: Promise<CryptoKey> | undefined;

function allowedOrigin(origin: string | null): string {
  if (!origin) return "*";
  try {
    const { protocol, hostname } = new URL(origin);
    const githubPages = protocol === "https:" && hostname.endsWith(".github.io");
    const local = (protocol === "http:" || protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1");
    return githubPages || local ? origin : "null";
  } catch {
    return "null";
  }
}

function respond(req: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allowedOrigin(req.headers.get("Origin")),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    },
  });
}

function db() {
  if (!supabase) {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("Supabase 服务端环境变量未配置");
    supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function jwtSecret(): string {
  const secret = Deno.env.get("CATBALL_JWT_SECRET") || Deno.env.get("JWT_SECRET") ||
    Deno.env.get("SUPABASE_JWT_SECRET");
  if (!secret || secret.length < 32) throw new Error("请配置至少 32 字节的 CATBALL_JWT_SECRET");
  return secret;
}

async function getSigningKey(): Promise<CryptoKey> {
  if (!signingKey) {
    signingKey = crypto.subtle.importKey(
      "raw",
      encoder.encode(jwtSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return signingKey;
}

async function signToken(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const configuredTtl = Number(Deno.env.get("CATBALL_JWT_TTL_SECONDS"));
  const ttl = Number.isSafeInteger(configuredTtl) && configuredTtl >= 300
    ? configuredTtl
    : DEFAULT_TTL_SECONDS;
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    sub: email,
    email,
    iat: now,
    exp: now + ttl,
  })));
  const content = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await getSigningKey(), encoder.encode(content));
  return `${content}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function authenticate(token: unknown): Promise<string> {
  if (typeof token !== "string") throw new Error("UNAUTHORIZED");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("UNAUTHORIZED");
  try {
    const header = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
    if (header.alg !== "HS256") throw new Error("UNAUTHORIZED");
    const content = `${parts[0]}.${parts[1]}`;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await getSigningKey(),
      base64UrlDecode(parts[2]),
      encoder.encode(content),
    );
    if (!valid) throw new Error("UNAUTHORIZED");
    const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
    const email = normalizeEmail(payload.sub || payload.email);
    if (!validEmail(email) || !Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) {
      throw new Error("UNAUTHORIZED");
    }
    return email;
  } catch {
    throw new Error("UNAUTHORIZED");
  }
}

async function sendEmail(email: string, code: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM") || "猫球小站 <onboarding@resend.dev>";
  if (!apiKey) throw new Error("RESEND_API_KEY 未配置");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "猫球小站登录验证码",
      html: `<div style="font-family:system-ui,sans-serif"><h2>猫球小站</h2><p>你的登录验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>验证码 5 分钟内有效。若非本人操作，请忽略本邮件。</p></div>`,
      text: `你的猫球小站登录验证码是 ${code}，5 分钟内有效。`,
    }),
  });
  if (!response.ok) {
    console.error("Resend 发送失败", response.status, await response.text());
    throw new Error("验证码邮件发送失败，请稍后重试");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负整数`);
  return Number(value);
}

function sanitizeInventory(value: unknown) {
  if (value === undefined) value = {};
  if (!isPlainObject(value)) throw new Error("装扮库存格式无效");
  const result: Record<string, unknown> = {};
  for (const key of ["signUntil", "scooterUntil", "speedPotionUntil", "ingotUntil", "glassesUntil", "vipUntil"]) {
    const item = value[key] ?? 0;
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 8640000000000000) {
      throw new Error("装扮期限格式无效");
    }
    result[key] = item;
  }
  const equipped = value.equipped ?? "";
  if (typeof equipped !== "string" || !["", "sign", "scooter", "ingot", "glasses"].includes(equipped)) {
    throw new Error("已装备装扮格式无效");
  }
  result.equipped = equipped;
  const professions = value.pvpProfessions ?? [];
  if (!Array.isArray(professions) || professions.length > 64 ||
    professions.some((id) => typeof id !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(id))) {
    throw new Error("PVP 职业数据格式无效");
  }
  result.pvpProfessions = [...new Set(professions)];
  const bag = value.pvpBag ?? [];
  if (!Array.isArray(bag) || bag.length > 8) throw new Error("PVP 背包格式无效");
  result.pvpBag = bag.map((item) => {
    if (!isPlainObject(item) || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 80 ||
      typeof item.type !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(item.type)) {
      throw new Error("PVP 背包物品格式无效");
    }
    const clean: Record<string, unknown> = { id: item.id, type: item.type };
    if (item.hp !== undefined) {
      if (typeof item.hp !== "number" || !Number.isFinite(item.hp) || item.hp < 0 || item.hp > 1000000) {
        throw new Error("PVP 宠物生命值格式无效");
      }
      clean.hp = item.hp;
    }
    return clean;
  });
  return result;
}

function sanitizeState(value: unknown) {
  if (!isPlainObject(value) || JSON.stringify(value).length > 100000) throw new Error("云存档格式或大小无效");
  const petName = value.petName === undefined ? "猫球" : value.petName;
  if (typeof petName !== "string") throw new Error("猫球名字格式无效");
  return {
    petName: petName.trim().slice(0, 16) || "猫球",
    food: nonNegativeInteger(value.food ?? 0, "猫粮"),
    points: nonNegativeInteger(value.points ?? 0, "积分"),
    inventory: sanitizeInventory(value.inventory),
  };
}

const PROFILE_SELECT = "email,pet_name,food,points,inventory,revision,updated_at";

function rowState(row: Record<string, unknown>) {
  return {
    petName: row.pet_name,
    food: Number(row.food),
    points: Number(row.points),
    inventory: row.inventory,
  };
}

async function loadProfile(email: string) {
  const { data, error } = await db().from("catball_profiles").select(PROFILE_SELECT).eq("email", email).maybeSingle();
  if (error) throw error;
  return data;
}

function conflict(req: Request, profile: Record<string, unknown> | null) {
  return respond(req, {
    ok: false,
    code: "REVISION_CONFLICT",
    msg: "其他设备已更新存档，请使用最新云端数据",
    state: profile ? rowState(profile) : null,
    revision: profile ? Number(profile.revision) : 0,
  });
}

async function handleSync(req: Request, email: string, body: Record<string, unknown>) {
  const baseRevision = nonNegativeInteger(body.baseRevision ?? 0, "存档版本");
  const state = sanitizeState(body.state);
  const current = await loadProfile(email);
  if ((current && Number(current.revision) !== baseRevision) || (!current && baseRevision !== 0)) {
    return conflict(req, current);
  }
  const values = {
    pet_name: state.petName,
    food: state.food,
    points: state.points,
    inventory: state.inventory,
    updated_at: new Date().toISOString(),
  };
  if (current) {
    const { data, error } = await db().from("catball_profiles").update({
      ...values,
      revision: baseRevision + 1,
    }).eq("email", email).eq("revision", baseRevision).select(PROFILE_SELECT).maybeSingle();
    if (error) throw error;
    if (!data) return conflict(req, await loadProfile(email));
    return respond(req, { ok: true, msg: "存档已同步", state: rowState(data), revision: Number(data.revision) });
  }
  const { data, error } = await db().from("catball_profiles").insert({
    email,
    ...values,
    revision: 1,
  }).select(PROFILE_SELECT).single();
  if (error) {
    if (error.code === "23505") return conflict(req, await loadProfile(email));
    throw error;
  }
  return respond(req, { ok: true, msg: "存档已同步", state: rowState(data), revision: Number(data.revision) });
}

async function handleRedeem(req: Request, email: string, body: Record<string, unknown>) {
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[A-Z0-9_-]{1,64}$/.test(code)) return respond(req, { ok: false, msg: "礼品码格式无效" });
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) return respond(req, { ok: false, msg: "请求标识无效" });
  const { data, error } = await db().rpc("catball_redeem", {
    p_email: email,
    p_code: code,
    p_request_id: requestId,
  }).single();
  if (error) throw error;
  return respond(req, {
    ok: Boolean(data.ok),
    msg: data.msg,
    state: data.state,
    revision: Number(data.revision || 0),
    points: Number(data.awarded || 0),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return respond(req, { ok: true }, 204);
  if (req.method !== "POST") return respond(req, { ok: false, msg: "仅支持 POST 请求" }, 405);
  try {
    const body = await req.json() as Record<string, unknown>;
    const type = body.type;
    if (type === "send") {
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) return respond(req, { ok: false, msg: "邮箱格式不正确" });
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const { error } = await db().from("verify_code").upsert({
        email,
        code,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      if (error) throw error;
      await sendEmail(email, code);
      return respond(req, { ok: true, msg: "验证码已发送，请查收（垃圾箱也看一下）" });
    }
    if (type === "verify") {
      const email = normalizeEmail(body.email);
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!validEmail(email) || !/^\d{6}$/.test(code)) {
        return respond(req, { ok: false, msg: "邮箱或验证码格式不正确" });
      }
      const { data, error } = await db().from("verify_code").select("code,expires_at").eq("email", email).maybeSingle();
      if (error) throw error;
      if (!data || !data.expires_at || new Date(data.expires_at).getTime() <= Date.now()) {
        return respond(req, { ok: false, msg: "验证码不存在或已过期" });
      }
      if (String(data.code) !== code) return respond(req, { ok: false, msg: "验证码错误" });
      await db().from("verify_code").delete().eq("email", email);
      return respond(req, { ok: true, msg: "✅ 验证成功", token: await signToken(email), email });
    }
    if (type === "create-code") {
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      const points = Number(body.points);
      if (!/^[A-Z0-9_-]{4,64}$/.test(code) || !Number.isSafeInteger(points) || points < 15 || points > 40) {
        return respond(req, { ok: false, msg: "礼品码或积分档位无效" });
      }
      const { error } = await db().from("catball_redemptions").insert({ code, points });
      if (error) {
        if (error.code === "23505") return respond(req, { ok: false, msg: "礼品码重复，请重新生成" });
        throw error;
      }
      return respond(req, { ok: true, msg: "礼品码已生成", code, points });
    }
    if (type === "check-token") {
      try {
        const email = await authenticate(body.token);
        return respond(req, { ok: true, msg: "身份有效", email });
      } catch {
        return respond(req, { ok: false, code: "UNAUTHORIZED", msg: "登录已过期，请重新登录" }, 401);
      }
    }
    if (["load", "sync", "redeem", "logout"].includes(String(type))) {
      let email: string;
      try {
        email = await authenticate(body.token);
      } catch {
        return respond(req, { ok: false, code: "UNAUTHORIZED", msg: "登录已过期，请重新登录" }, 401);
      }
      if (type === "load") {
        const profile = await loadProfile(email);
        return respond(req, {
          ok: true,
          msg: profile ? "存档已读取" : "暂无云端存档",
          state: profile ? rowState(profile) : null,
          revision: profile ? Number(profile.revision) : 0,
          email,
        });
      }
      if (type === "sync") return await handleSync(req, email, body);
      if (type === "redeem") return await handleRedeem(req, email, body);
      return respond(req, { ok: true, msg: "已退出登录（令牌到期后自动失效）", email });
    }
    return respond(req, { ok: false, msg: "不支持的请求类型" }, 400);
  } catch (error) {
    console.error("send-verify-code", error);
    return respond(req, { ok: false, msg: error instanceof Error ? error.message : "服务器暂时不可用" }, 500);
  }
});
