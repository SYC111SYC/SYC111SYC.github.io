(() => {
  "use strict";

  const API_URL = "https://sshcmvydvckqkbmvdjvj.supabase.co/functions/v1/send-verify-code";
  const SESSION_KEY = "catball_account_session_v1";
  const GUEST_BACKUP_KEY = "catball_account_guest_backup_v1";
  const ECONOMY_KEY = "catball_economy_v1";
  const FOOD_KEY = "catball_food_v1";
  const NAME_KEY = "catball_pet_name_v1";
  const DEFAULT_INVENTORY = {
    signUntil: 0,
    scooterUntil: 0,
    speedPotionUntil: 0,
    ingotUntil: 0,
    glassesUntil: 0,
    vipUntil: 0,
    equipped: "",
    pvpBag: [],
    pvpProfessions: []
  };

  let session = readSession();
  let snapshot = null;
  let revision = 0;
  let hydrated = false;
  let dirty = false;
  let changeVersion = 0;
  let syncTimer = null;
  let syncPromise = null;
  let hydrationPromise = null;
  let syncStatus = session ? "正在检查登录状态" : "未登录";
  let loginPromise = null;
  let resolveLogin = null;
  let importResolver = null;
  let countdown = 0;
  let countdownTimer = null;
  let toastTimer = null;
  let ui = {};
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.error("猫球账号无法写入本地存档", error);
      return false;
    }
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* 浏览器禁用存储时忽略 */ }
  }

  function readSession() {
    try {
      const value = JSON.parse(storageGet(SESSION_KEY) || "null");
      if (value && typeof value.token === "string" && typeof value.email === "string") {
        return { token: value.token, email: value.email };
      }
    } catch { /* 无效会话按未登录处理 */ }
    return null;
  }

  function saveSession() {
    if (session) storageSet(SESSION_KEY, JSON.stringify({ token: session.token, email: session.email }));
    else storageRemove(SESSION_KEY);
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const points = Number(source.points);
    const food = Number(source.food);
    const inventory = source.inventory && typeof source.inventory === "object" && !Array.isArray(source.inventory)
      ? { ...DEFAULT_INVENTORY, ...source.inventory }
      : { ...DEFAULT_INVENTORY };
    inventory.pvpBag = Array.isArray(inventory.pvpBag) ? inventory.pvpBag : [];
    inventory.pvpProfessions = Array.isArray(inventory.pvpProfessions) ? inventory.pvpProfessions : [];
    return {
      petName: String(source.petName || "猫球").trim().slice(0, 16) || "猫球",
      food: Number.isSafeInteger(food) && food >= 0 ? food : 0,
      points: Number.isSafeInteger(points) && points >= 0 ? points : 0,
      inventory
    };
  }

  function readLocalState() {
    let economy = {};
    try {
      const parsed = JSON.parse(storageGet(ECONOMY_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) economy = parsed;
    } catch { /* 损坏的经济数据使用默认值 */ }
    return normalizeState({
      petName: storageGet(NAME_KEY) || "猫球",
      food: Number.parseInt(storageGet(FOOD_KEY) || "0", 10),
      points: economy.points,
      inventory: economy.inventory
    });
  }

  function applyLocalState(value) {
    const state = normalizeState(value);
    const results = [
      storageSet(NAME_KEY, state.petName),
      storageSet(FOOD_KEY, String(state.food)),
      storageSet(ECONOMY_KEY, JSON.stringify({ points: state.points, inventory: state.inventory }))
    ];
    if (results.includes(false)) notify("浏览器存储失败，请检查可用空间");
  }

  function captureGuestState() {
    if (!storageGet(GUEST_BACKUP_KEY)) storageSet(GUEST_BACKUP_KEY, JSON.stringify(readLocalState()));
  }

  function restoreGuestState() {
    const backup = storageGet(GUEST_BACKUP_KEY);
    if (backup) {
      try { applyLocalState(JSON.parse(backup)); } catch { applyLocalState(null); }
    }
    storageRemove(GUEST_BACKUP_KEY);
  }

  function emit(reason) {
    window.dispatchEvent(new CustomEvent("catball:account-state", {
      detail: { reason, user: getUser(), snapshot: getSnapshot(), syncStatus }
    }));
  }

  function getUser() {
    return session ? { email: session.email } : null;
  }

  function getSnapshot() {
    return snapshot ? { state: JSON.parse(JSON.stringify(snapshot)), revision } : null;
  }

  function setSyncStatus(value) {
    syncStatus = value;
    if (ui.sync) ui.sync.textContent = value;
    if (ui.launcher) ui.launcher.title = session ? `${session.email}\n${value}` : "登录后同步猫球数据";
  }

  function notify(message) {
    if (!ui.toast) return;
    clearTimeout(toastTimer);
    ui.toast.textContent = String(message || "");
    ui.toast.hidden = !message;
    if (message) toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4200);
  }

  function updateUi() {
    if (!ui.launcher) return;
    ui.launcher.classList.toggle("authenticated", Boolean(session));
    ui.label.textContent = session ? session.email : "登录 / 注册";
    ui.accountEmail.textContent = session ? session.email : "";
    ui.sync.textContent = syncStatus;
  }

  function buildUi() {
    const root = document.createElement("div");
    root.id = "catballAccountRoot";
    root.innerHTML = `
      <button class="cb-account-launcher" type="button" aria-haspopup="dialog">
        <span class="cb-account-dot" aria-hidden="true"></span>
        <span class="cb-account-label">登录 / 注册</span>
      </button>
      <div class="cb-account-overlay" hidden>
        <section class="cb-account-dialog" role="dialog" aria-modal="true" aria-labelledby="cbAccountTitle">
          <div class="cb-account-head">
            <h2 class="cb-account-title" id="cbAccountTitle">猫球账号</h2>
            <button class="cb-account-close" type="button" aria-label="关闭">×</button>
          </div>
          <form class="cb-account-login" novalidate>
            <p class="cb-account-description cb-account-reason">邮箱验证码即可注册或登录，猫球数据会同步到云端。</p>
            <label class="cb-account-field">邮箱
              <span class="cb-account-input-row">
                <input class="cb-account-input" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="name@example.com" required>
                <button class="cb-account-send" type="button">获取验证码</button>
              </span>
            </label>
            <label class="cb-account-field">6 位数字验证码
              <input class="cb-account-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required>
            </label>
            <button class="cb-account-primary" type="submit">验证并登录</button>
            <p class="cb-account-message" role="status"></p>
          </form>
          <div class="cb-account-profile" hidden>
            <p class="cb-account-email"></p>
            <p class="cb-account-sync"></p>
            <div class="cb-account-actions">
              <button class="cb-account-secondary cb-account-refresh" type="button">刷新云端</button>
              <button class="cb-account-primary cb-account-logout" type="button">退出登录</button>
            </div>
            <p class="cb-account-message cb-account-profile-message" role="status"></p>
          </div>
          <div class="cb-account-import" hidden>
            <p class="cb-account-description">这个邮箱还没有云端存档。是否把当前浏览器的猫球数据作为初始存档？不会与云端数据相加。</p>
            <div class="cb-account-import-summary"></div>
            <div class="cb-account-import-options">
              <button class="cb-account-primary cb-account-import-local" type="button">导入本机数据并登录</button>
              <button class="cb-account-secondary cb-account-import-empty" type="button">使用空存档并登录</button>
            </div>
            <button class="cb-account-cancel" type="button">取消</button>
          </div>
        </section>
      </div>
      <div class="cb-account-toast" role="status" hidden></div>`;
    document.body.appendChild(root);
    ui = {
      launcher: root.querySelector(".cb-account-launcher"),
      label: root.querySelector(".cb-account-label"),
      overlay: root.querySelector(".cb-account-overlay"),
      close: root.querySelector(".cb-account-close"),
      title: root.querySelector(".cb-account-title"),
      login: root.querySelector(".cb-account-login"),
      email: root.querySelector("input[name=email]"),
      code: root.querySelector("input[name=code]"),
      send: root.querySelector(".cb-account-send"),
      reason: root.querySelector(".cb-account-reason"),
      message: root.querySelector(".cb-account-login .cb-account-message"),
      profile: root.querySelector(".cb-account-profile"),
      accountEmail: root.querySelector(".cb-account-email"),
      sync: root.querySelector(".cb-account-sync"),
      refresh: root.querySelector(".cb-account-refresh"),
      logout: root.querySelector(".cb-account-logout"),
      profileMessage: root.querySelector(".cb-account-profile-message"),
      importPanel: root.querySelector(".cb-account-import"),
      importSummary: root.querySelector(".cb-account-import-summary"),
      importLocal: root.querySelector(".cb-account-import-local"),
      importEmpty: root.querySelector(".cb-account-import-empty"),
      importCancel: root.querySelector(".cb-account-cancel"),
      toast: root.querySelector(".cb-account-toast")
    };
    bindUi();
    updateUi();
  }

  function bindUi() {
    ui.launcher.addEventListener("click", () => {
      if (session) openPanel("profile");
      else ensureLogin("登录后可同步猫球装扮、猫粮、积分与 PVP 背包。");
    });
    ui.close.addEventListener("click", closeModal);
    ui.overlay.addEventListener("click", event => {
      if (event.target === ui.overlay) closeModal();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !ui.overlay.hidden) closeModal();
    });
    ui.code.addEventListener("input", () => {
      ui.code.value = ui.code.value.replace(/\D/g, "").slice(0, 6);
    });
    ui.send.addEventListener("click", sendCode);
    ui.login.addEventListener("submit", verifyLogin);
    ui.refresh.addEventListener("click", async () => {
      ui.refresh.disabled = true;
      ui.profileMessage.textContent = "正在读取云端存档…";
      const ok = await refresh();
      ui.profileMessage.textContent = ok ? "已加载最新云端存档。" : "读取失败，请检查网络后重试。";
      ui.refresh.disabled = false;
    });
    ui.logout.addEventListener("click", async () => {
      if (!window.confirm("退出后会恢复登录前的本机游客数据，确定退出吗？")) return;
      ui.logout.disabled = true;
      const ok = await signOut();
      if (!ok) ui.profileMessage.textContent = "当前修改尚未同步，请恢复网络后再退出。";
      ui.logout.disabled = false;
    });
    ui.importLocal.addEventListener("click", () => finishImport("import"));
    ui.importEmpty.addEventListener("click", () => finishImport("empty"));
    ui.importCancel.addEventListener("click", () => finishImport("cancel"));
    window.addEventListener("online", () => {
      if (session && hydrated) {
        if (dirty) syncNow();
        else refresh();
      }
    });
    window.addEventListener("focus", () => {
      if (session && hydrated) {
        if (dirty) syncNow();
        else refresh();
      }
    });
    window.addEventListener("storage", event => {
      if (event.key === SESSION_KEY && event.newValue !== event.oldValue) window.location.reload();
    });
  }

  function openPanel(panel, reason) {
    ui.login.hidden = panel !== "login";
    ui.profile.hidden = panel !== "profile";
    ui.importPanel.hidden = panel !== "import";
    ui.title.textContent = panel === "profile" ? "账号与云存档" : panel === "import" ? "初始化云存档" : "登录 / 注册";
    if (reason) ui.reason.textContent = reason;
    ui.message.textContent = "";
    ui.profileMessage.textContent = "";
    ui.overlay.hidden = false;
    updateUi();
    if (panel === "login") setTimeout(() => ui.email.focus(), 0);
  }

  function closeModal() {
    if (importResolver) finishImport("cancel");
    ui.overlay.hidden = true;
    finishLogin(false);
  }

  function finishLogin(result) {
    if (!resolveLogin) return;
    const resolve = resolveLogin;
    resolveLogin = null;
    loginPromise = null;
    resolve(result);
  }

  function finishImport(choice) {
    if (!importResolver) return;
    const resolve = importResolver;
    importResolver = null;
    resolve(choice);
  }

  function setLoginMessage(message, error = false) {
    ui.message.textContent = message || "";
    ui.message.classList.toggle("error", error);
  }

  function validEmail(value) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function request(type, payload = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...payload }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && !data.msg) throw new Error(`服务器返回 ${response.status}`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function networkMessage(error) {
    return error && error.name === "AbortError" ? "请求超时，请稍后重试" : "网络请求失败，请检查网络后重试";
  }

  async function sendCode() {
    const email = ui.email.value.trim().toLowerCase();
    if (!validEmail(email)) {
      setLoginMessage("请输入正确的邮箱地址。", true);
      ui.email.focus();
      return;
    }
    if (countdown > 0) return;
    ui.send.disabled = true;
    setLoginMessage("正在发送验证码…");
    try {
      const data = await request("send", { email });
      setLoginMessage(data.msg || (data.ok ? "验证码已发送，请查收（垃圾箱也看一下）" : "发送失败"), !data.ok);
      if (data.ok) startCountdown();
    } catch (error) {
      setLoginMessage(networkMessage(error), true);
    } finally {
      ui.send.disabled = countdown > 0;
    }
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    countdown = 60;
    ui.send.disabled = true;
    ui.send.textContent = `${countdown}s 后重发`;
    countdownTimer = setInterval(() => {
      countdown -= 1;
      ui.send.textContent = countdown > 0 ? `${countdown}s 后重发` : "获取验证码";
      if (countdown <= 0) {
        clearInterval(countdownTimer);
        ui.send.disabled = false;
      }
    }, 1000);
  }

  async function verifyLogin(event) {
    event.preventDefault();
    const email = ui.email.value.trim().toLowerCase();
    const code = ui.code.value.trim();
    if (!validEmail(email)) return setLoginMessage("请输入正确的邮箱地址。", true);
    if (!/^\d{6}$/.test(code)) return setLoginMessage("验证码必须是 6 位数字。", true);
    const submit = ui.login.querySelector("button[type=submit]");
    submit.disabled = true;
    setLoginMessage("正在验证…");
    try {
      const data = await request("verify", { email, code });
      if (!data.ok || !data.token) {
        setLoginMessage(data.msg || "验证失败", true);
        return;
      }
      captureGuestState();
      session = { token: data.token, email: data.email || email };
      saveSession();
      hydrated = false;
      updateUi();
      setLoginMessage("验证成功，正在读取云存档…");
      const loaded = await hydrate(true);
      if (!loaded) {
        session = null;
        hydrated = false;
        saveSession();
        restoreGuestState();
        emit("login-cancelled");
        setLoginMessage("已取消登录。", true);
        updateUi();
        finishLogin(false);
        return;
      }
      ui.overlay.hidden = true;
      notify("登录成功，猫球数据已同步");
      finishLogin(true);
    } catch (error) {
      console.error("登录或云存档读取失败", error);
      setLoginMessage(error.message === "UNAUTHORIZED" ? "登录状态无效，请重新验证" : networkMessage(error), true);
    } finally {
      submit.disabled = false;
    }
  }

  function askImport(localState) {
    ui.importSummary.textContent = `本机数据：${localState.petName} · 猫粮 ${localState.food} · 积分 ${localState.points}`;
    openPanel("import");
    return new Promise(resolve => { importResolver = resolve; });
  }

  function applyRemoteState(state, nextRevision, reason = "cloud") {
    clearTimeout(syncTimer);
    snapshot = normalizeState(state);
    revision = Number.isSafeInteger(Number(nextRevision)) ? Number(nextRevision) : 0;
    dirty = false;
    changeVersion += 1;
    hydrated = true;
    applyLocalState(snapshot);
    setSyncStatus("云端存档已同步");
    updateUi();
    emit(reason);
  }

  function hydrate(allowImport) {
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = performHydration(allowImport).finally(() => { hydrationPromise = null; });
    return hydrationPromise;
  }

  async function performHydration(allowImport) {
    const data = await request("load", { token: session.token });
    if (data.code === "UNAUTHORIZED") {
      expireSession();
      return false;
    }
    if (!data.ok) throw new Error(data.msg || "云端存档读取失败");
    if (data.state) {
      applyRemoteState(data.state, data.revision, "cloud-loaded");
      return true;
    }
    revision = 0;
    if (!allowImport) return false;
    const localState = readLocalState();
    const choice = await askImport(localState);
    if (choice === "cancel") {
      ui.overlay.hidden = true;
      return false;
    }
    const initialState = choice === "import" ? localState : normalizeState(null);
    applyLocalState(initialState);
    setSyncStatus("正在创建云端存档…");
    const synced = await pushState(initialState, 0);
    if (!synced) {
      if (hydrated) return true;
      throw new Error(syncStatus || "云存档创建失败");
    }
    hydrated = true;
    updateUi();
    emit("cloud-created");
    return true;
  }

  function expireSession() {
    clearTimeout(syncTimer);
    session = null;
    snapshot = null;
    revision = 0;
    hydrated = false;
    dirty = false;
    saveSession();
    restoreGuestState();
    setSyncStatus("登录已过期");
    updateUi();
    emit("expired");
    notify("登录已过期，请重新登录");
  }

  async function ensureLogin(reason = "此操作需要先登录猫球账号。") {
    await ready;
    if (session && hydrated) return true;
    if (session) {
      try {
        const loaded = await hydrate(true);
        if (loaded) return true;
      } catch (error) {
        console.error("云存档初始化失败", error);
        notify(error.message || networkMessage(error));
        return false;
      }
    }
    if (loginPromise) return loginPromise;
    openPanel("login", reason);
    loginPromise = new Promise(resolve => { resolveLogin = resolve; });
    return loginPromise;
  }

  function markDirty() {
    if (!session || !hydrated) return;
    dirty = true;
    changeVersion += 1;
    setSyncStatus("有修改等待同步");
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 800);
  }

  async function pushState(state, baseRevision) {
    const data = await request("sync", { token: session.token, state, baseRevision });
    if (data.code === "UNAUTHORIZED") {
      expireSession();
      return false;
    }
    if (data.code === "REVISION_CONFLICT") {
      if (data.state) applyRemoteState(data.state, data.revision, "revision-conflict");
      setSyncStatus("已加载其他设备的最新存档");
      notify("检测到其他设备的修改，已加载最新云端存档，本次未覆盖云端");
      return false;
    }
    if (!data.ok) {
      setSyncStatus(data.msg || "同步失败");
      return false;
    }
    snapshot = normalizeState(data.state || state);
    revision = Number(data.revision);
    setSyncStatus("云端存档已同步");
    return true;
  }

  function syncNow() {
    if (!session || !hydrated) return Promise.resolve(false);
    if (syncPromise) return syncPromise;
    if (!dirty) return Promise.resolve(true);
    clearTimeout(syncTimer);
    const versionAtStart = changeVersion;
    const state = readLocalState();
    setSyncStatus("正在同步…");
    syncPromise = (async () => {
      try {
        const ok = await pushState(state, revision);
        if (ok) {
          dirty = changeVersion !== versionAtStart;
          if (dirty) syncTimer = setTimeout(syncNow, 800);
        }
        return ok;
      } catch (error) {
        dirty = true;
        setSyncStatus("同步失败，联网后自动重试");
        console.error("猫球云存档同步失败", error);
        return false;
      } finally {
        syncPromise = null;
      }
    })();
    return syncPromise;
  }

  async function refresh() {
    if (!session) return false;
    if (!hydrated) {
      try { return await hydrate(true); } catch { return false; }
    }
    if (dirty && !await syncNow()) return false;
    try {
      const data = await request("load", { token: session.token });
      if (data.code === "UNAUTHORIZED") {
        expireSession();
        return false;
      }
      if (!data.ok) throw new Error(data.msg || "读取失败");
      if (data.state) applyRemoteState(data.state, data.revision, "cloud-refreshed");
      return Boolean(data.state);
    } catch (error) {
      console.error("猫球云存档刷新失败", error);
      setSyncStatus("云端刷新失败");
      return false;
    }
  }

  async function signOut() {
    if (!session) return true;
    if (dirty && !await syncNow()) return false;
    const token = session.token;
    try { await request("logout", { token }); } catch { /* 无状态 JWT 可直接在本机退出 */ }
    clearTimeout(syncTimer);
    session = null;
    snapshot = null;
    revision = 0;
    hydrated = false;
    dirty = false;
    saveSession();
    restoreGuestState();
    setSyncStatus("未登录");
    updateUi();
    ui.overlay.hidden = true;
    emit("logout");
    notify("已退出登录，已恢复本机游客数据");
    return true;
  }

  async function redeem(code) {
    if (!await ensureLogin("登录后才能兑换礼品码。")) return { ok: false, msg: "请先登录后再兑换" };
    if (dirty && !await syncNow()) return { ok: false, msg: "请先让当前修改同步到云端，再兑换礼品码" };
    const requestId = window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    try {
      const data = await request("redeem", { token: session.token, code, requestId });
      if (data.code === "UNAUTHORIZED") {
        expireSession();
        return { ok: false, msg: "登录已过期，请重新登录" };
      }
      if (data.ok && data.state) applyRemoteState(data.state, data.revision, "redeemed");
      return data;
    } catch (error) {
      console.error("礼品码兑换失败", error);
      return { ok: false, msg: networkMessage(error) };
    }
  }

  async function initialize() {
    if (!session) {
      setSyncStatus("未登录");
      updateUi();
      emit("ready");
      readyResolve(true);
      return;
    }
    try {
      const checked = await request("check-token", { token: session.token });
      if (!checked.ok) {
        expireSession();
        readyResolve(false);
        return;
      }
      session.email = checked.email || session.email;
      saveSession();
      setSyncStatus("正在读取云存档…");
      updateUi();
      const loaded = await hydrate(true);
      emit("ready");
      readyResolve(loaded);
    } catch (error) {
      console.error("账号初始化失败", error);
      setSyncStatus("暂时无法连接云端，修改会在恢复后同步");
      updateUi();
      emit("offline");
      readyResolve(true);
    }
  }

  window.CatballAccount = {
    ready,
    ensureLogin,
    getUser,
    getSnapshot,
    markDirty,
    refresh,
    signOut,
    redeem,
    hasSession: () => Boolean(session && session.token)
  };

  function start() {
    buildUi();
    initialize();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
