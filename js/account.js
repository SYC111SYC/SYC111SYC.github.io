(() => {
  "use strict";

  const API_URL = "https://sshcmvydvckqkbmvdjvj.supabase.co/functions/v1/send-verify-code";
  const REDEEM_URL = "https://sshcmvydvckqkbmvdjvj.supabase.co/functions/v1/redeem";
  const SESSION_KEY = "catball_account_session_v1";
  const GUEST_BACKUP_KEY = "catball_account_guest_backup_v1";
  const PENDING_GIFTS_KEY = "catball_pending_gifts_v1";
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
  let nickname = "";
  let authMode = "code";
  let resetOrigin = "login";
  let resetCountdown = 0;
  let resetCountdownTimer = null;
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
    return session ? { email: session.email, nickname: nickname || "" } : null;
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
    const displayName = session ? (nickname || session.email) : "登录 / 注册";
    const avatarSource = session ? (nickname || session.email) : "猫";
    const avatarText = Array.from(avatarSource)[0] || "猫";
    ui.launcher.classList.toggle("authenticated", Boolean(session));
    ui.label.textContent = displayName;
    ui.avatar.textContent = avatarText.toUpperCase();
    ui.profileAvatar.textContent = avatarText.toUpperCase();
    ui.profileNickname.textContent = session ? (nickname || "未设置昵称") : "";
    ui.accountEmail.textContent = session ? session.email : "";
    if (ui.nicknameInput && document.activeElement !== ui.nicknameInput) ui.nicknameInput.value = nickname;
    ui.sync.textContent = syncStatus;
  }

  function buildUi() {
    const root = document.createElement("div");
    root.id = "catballAccountRoot";
    root.innerHTML = `
      <button class="cb-account-launcher" type="button" aria-haspopup="dialog" aria-label="账号与个人中心">
        <span class="cb-account-avatar" aria-hidden="true">猫</span>
        <span class="cb-account-label">登录 / 注册</span>
      </button>
      <div class="cb-account-overlay" hidden>
        <section class="cb-account-dialog" role="dialog" aria-modal="true" aria-labelledby="cbAccountTitle">
          <div class="cb-account-head">
            <h2 class="cb-account-title" id="cbAccountTitle">猫球账号</h2>
            <button class="cb-account-close" type="button" aria-label="关闭">×</button>
          </div>
          <form class="cb-account-login" novalidate>
            <div class="cb-account-tabs" role="tablist" aria-label="登录方式">
              <button class="cb-account-tab active" type="button" data-auth-mode="code" role="tab">验证码登录</button>
              <button class="cb-account-tab" type="button" data-auth-mode="password" role="tab">密码登录</button>
            </div>
            <p class="cb-account-description cb-account-reason">邮箱验证码即可注册或登录，猫球数据会同步到云端。</p>
            <div class="cb-account-code-mode">
              <label class="cb-account-field">邮箱
                <span class="cb-account-input-row">
                  <input class="cb-account-input" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="name@example.com">
                  <button class="cb-account-send" type="button">获取验证码</button>
                </span>
              </label>
              <label class="cb-account-field">6 位数字验证码
                <input class="cb-account-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000">
              </label>
            </div>
            <div class="cb-account-password-mode" hidden>
              <label class="cb-account-field">邮箱
                <input class="cb-account-input" name="passwordEmail" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="name@example.com">
              </label>
              <label class="cb-account-field">密码
                <input class="cb-account-input" name="loginPassword" type="password" autocomplete="current-password" minlength="6" maxlength="72" placeholder="输入密码">
              </label>
              <button class="cb-account-link cb-account-forgot" type="button">忘记密码？</button>
              <p class="cb-account-hint">还没有密码？先用验证码登录，再点击头像设置。</p>
            </div>
            <button class="cb-account-primary cb-account-login-submit" type="submit">验证并登录</button>
            <p class="cb-account-message" role="status"></p>
          </form>
          <div class="cb-account-profile" hidden>
            <div class="cb-account-profile-head">
              <span class="cb-account-avatar cb-account-avatar-large" aria-hidden="true">猫</span>
              <div class="cb-account-profile-identity">
                <strong class="cb-account-profile-nickname">未设置昵称</strong>
                <p class="cb-account-email"></p>
              </div>
            </div>
            <form class="cb-account-nickname-form" novalidate>
              <label class="cb-account-field">账号昵称（与猫球名字分开）
                <span class="cb-account-input-row">
                  <input class="cb-account-input" name="nickname" type="text" maxlength="16" placeholder="输入 1~16 个字符">
                  <button class="cb-account-send" type="submit">保存昵称</button>
                </span>
              </label>
            </form>
            <p class="cb-account-sync"></p>
            <div class="cb-account-actions">
              <button class="cb-account-secondary cb-account-refresh" type="button">刷新云端</button>
              <button class="cb-account-primary cb-account-logout" type="button">退出登录</button>
            </div>
            <button class="cb-account-secondary cb-account-wide-action cb-account-open-set-password" type="button">设置 / 修改密码</button>
            <p class="cb-account-message cb-account-profile-message" role="status"></p>
          </div>
          <form class="cb-account-reset" novalidate hidden>
            <p class="cb-account-description">通过邮箱验证码重置密码，验证码 5 分钟内有效。</p>
            <label class="cb-account-field">邮箱
              <span class="cb-account-input-row">
                <input class="cb-account-input" name="resetEmail" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="name@example.com">
                <button class="cb-account-send cb-account-reset-send" type="button">获取重置码</button>
              </span>
            </label>
            <label class="cb-account-field">6 位重置验证码
              <input class="cb-account-input" name="resetCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
            </label>
            <label class="cb-account-field">新密码
              <input class="cb-account-input" name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="72" placeholder="6~72 位密码">
            </label>
            <label class="cb-account-field">确认新密码
              <input class="cb-account-input" name="confirmNewPassword" type="password" autocomplete="new-password" minlength="6" maxlength="72" placeholder="再次输入新密码">
            </label>
            <button class="cb-account-primary" type="submit">确认重置密码</button>
            <button class="cb-account-secondary cb-account-wide-action cb-account-reset-back" type="button">返回</button>
            <p class="cb-account-message cb-account-reset-message" role="status"></p>
          </form>
          <form class="cb-account-set-password" novalidate hidden>
            <p class="cb-account-description">验证码注册的账号可以直接设置密码。已经设置过密码的账号，请使用邮箱验证码修改。</p>
            <label class="cb-account-field">新密码
              <input class="cb-account-input" name="setPassword" type="password" autocomplete="new-password" minlength="6" maxlength="72" placeholder="6~72 位密码">
            </label>
            <label class="cb-account-field">确认新密码
              <input class="cb-account-input" name="setPasswordConfirm" type="password" autocomplete="new-password" minlength="6" maxlength="72" placeholder="再次输入新密码">
            </label>
            <button class="cb-account-primary" type="submit">保存密码</button>
            <button class="cb-account-link cb-account-set-to-reset" type="button">已设置过密码？用邮箱验证码修改</button>
            <button class="cb-account-secondary cb-account-wide-action cb-account-set-back" type="button">返回个人中心</button>
            <p class="cb-account-message cb-account-set-message" role="status"></p>
          </form>
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
      avatar: root.querySelector(".cb-account-launcher .cb-account-avatar"),
      profileAvatar: root.querySelector(".cb-account-avatar-large"),
      profileNickname: root.querySelector(".cb-account-profile-nickname"),
      overlay: root.querySelector(".cb-account-overlay"),
      close: root.querySelector(".cb-account-close"),
      title: root.querySelector(".cb-account-title"),
      login: root.querySelector(".cb-account-login"),
      tabs: [...root.querySelectorAll("[data-auth-mode]")],
      codeMode: root.querySelector(".cb-account-code-mode"),
      passwordMode: root.querySelector(".cb-account-password-mode"),
      email: root.querySelector("input[name=email]"),
      code: root.querySelector("input[name=code]"),
      send: root.querySelector(".cb-account-code-mode .cb-account-send"),
      passwordEmail: root.querySelector("input[name=passwordEmail]"),
      loginPassword: root.querySelector("input[name=loginPassword]"),
      loginSubmit: root.querySelector(".cb-account-login-submit"),
      forgot: root.querySelector(".cb-account-forgot"),
      reason: root.querySelector(".cb-account-reason"),
      message: root.querySelector(".cb-account-login .cb-account-message"),
      profile: root.querySelector(".cb-account-profile"),
      accountEmail: root.querySelector(".cb-account-email"),
      nicknameForm: root.querySelector(".cb-account-nickname-form"),
      nicknameInput: root.querySelector("input[name=nickname]"),
      sync: root.querySelector(".cb-account-sync"),
      refresh: root.querySelector(".cb-account-refresh"),
      logout: root.querySelector(".cb-account-logout"),
      openSetPassword: root.querySelector(".cb-account-open-set-password"),
      profileMessage: root.querySelector(".cb-account-profile-message"),
      reset: root.querySelector(".cb-account-reset"),
      resetEmail: root.querySelector("input[name=resetEmail]"),
      resetCode: root.querySelector("input[name=resetCode]"),
      resetSend: root.querySelector(".cb-account-reset-send"),
      newPassword: root.querySelector("input[name=newPassword]"),
      confirmNewPassword: root.querySelector("input[name=confirmNewPassword]"),
      resetBack: root.querySelector(".cb-account-reset-back"),
      resetMessage: root.querySelector(".cb-account-reset-message"),
      setPassword: root.querySelector(".cb-account-set-password"),
      setPasswordInput: root.querySelector("input[name=setPassword]"),
      setPasswordConfirm: root.querySelector("input[name=setPasswordConfirm]"),
      setToReset: root.querySelector(".cb-account-set-to-reset"),
      setBack: root.querySelector(".cb-account-set-back"),
      setMessage: root.querySelector(".cb-account-set-message"),
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
      if (session) {
        openPanel("profile");
        loadNickname();
      } else {
        ensureLogin("登录后可同步猫球装扮、猫粮、积分与 PVP 背包。");
      }
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
    ui.resetCode.addEventListener("input", () => {
      ui.resetCode.value = ui.resetCode.value.replace(/\D/g, "").slice(0, 6);
    });
    ui.tabs.forEach(tab => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
    ui.send.addEventListener("click", sendCode);
    ui.login.addEventListener("submit", verifyLogin);
    ui.forgot.addEventListener("click", () => openResetPanel("login"));
    ui.resetSend.addEventListener("click", sendResetCode);
    ui.reset.addEventListener("submit", resetPassword);
    ui.resetBack.addEventListener("click", () => {
      if (resetOrigin === "set") openPanel("set-password");
      else if (resetOrigin === "profile") openPanel("profile");
      else openPanel("login");
    });
    ui.nicknameForm.addEventListener("submit", saveNickname);
    ui.openSetPassword.addEventListener("click", () => openPanel("set-password"));
    ui.setPassword.addEventListener("submit", setAccountPassword);
    ui.setToReset.addEventListener("click", () => openResetPanel("set"));
    ui.setBack.addEventListener("click", () => openPanel("profile"));
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
        (dirty ? syncNow() : refresh()).then(() => flushPendingGifts());
      }
    });
    window.addEventListener("focus", () => {
      if (session && hydrated) {
        (dirty ? syncNow() : refresh()).then(() => flushPendingGifts());
      }
    });
    window.addEventListener("storage", event => {
      if (event.key === SESSION_KEY && event.newValue !== event.oldValue) window.location.reload();
    });
  }

  function setAuthMode(mode) {
    authMode = mode === "password" ? "password" : "code";
    if (authMode === "password" && !ui.passwordEmail.value) ui.passwordEmail.value = ui.email.value;
    if (authMode === "code" && !ui.email.value) ui.email.value = ui.passwordEmail.value;
    ui.codeMode.hidden = authMode !== "code";
    ui.passwordMode.hidden = authMode !== "password";
    ui.loginSubmit.textContent = authMode === "password" ? "使用密码登录" : "验证并登录";
    ui.tabs.forEach(tab => {
      const active = tab.dataset.authMode === authMode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
  }

  function openResetPanel(origin) {
    resetOrigin = origin;
    const currentEmail = session && origin !== "login" ? session.email : ui.passwordEmail.value || ui.email.value;
    ui.resetEmail.value = currentEmail.trim();
    ui.resetEmail.readOnly = Boolean(session && origin !== "login");
    ui.resetCode.value = "";
    ui.newPassword.value = "";
    ui.confirmNewPassword.value = "";
    openPanel("reset");
  }

  function openPanel(panel, reason) {
    ui.login.hidden = panel !== "login";
    ui.profile.hidden = panel !== "profile";
    ui.reset.hidden = panel !== "reset";
    ui.setPassword.hidden = panel !== "set-password";
    ui.importPanel.hidden = panel !== "import";
    const titles = {
      profile: "个人中心",
      import: "初始化云存档",
      reset: "重置密码",
      "set-password": "设置密码",
      login: "登录 / 注册"
    };
    ui.title.textContent = titles[panel] || "猫球账号";
    if (reason) ui.reason.textContent = reason;
    ui.message.textContent = "";
    ui.profileMessage.textContent = "";
    ui.resetMessage.textContent = "";
    ui.setMessage.textContent = "";
    ui.overlay.hidden = false;
    updateUi();
    setAuthMode(authMode);
    if (panel === "login") setTimeout(() => (authMode === "password" ? ui.passwordEmail : ui.email).focus(), 0);
    if (panel === "reset") setTimeout(() => ui.resetEmail.focus(), 0);
    if (panel === "set-password") setTimeout(() => ui.setPasswordInput.focus(), 0);
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
    const passwordLogin = authMode === "password";
    const email = (passwordLogin ? ui.passwordEmail.value : ui.email.value).trim().toLowerCase();
    const code = ui.code.value.trim();
    const password = ui.loginPassword.value;
    if (!validEmail(email)) return setLoginMessage("请输入正确的邮箱地址。", true);
    if (passwordLogin && (password.length < 6 || password.length > 72)) {
      return setLoginMessage("密码长度需为 6~72 位。", true);
    }
    if (!passwordLogin && !/^\d{6}$/.test(code)) return setLoginMessage("验证码必须是 6 位数字。", true);
    ui.loginSubmit.disabled = true;
    setLoginMessage(passwordLogin ? "正在使用密码登录…" : "正在验证…");
    try {
      const data = await request(passwordLogin ? "login-password" : "verify", passwordLogin
        ? { email, password }
        : { email, code });
      await completeAuthentication(data, email);
    } catch (error) {
      console.error("登录或云存档读取失败", error);
      setLoginMessage(error.message === "UNAUTHORIZED" ? "登录状态无效，请重新验证" : networkMessage(error), true);
    } finally {
      ui.loginSubmit.disabled = false;
    }
  }

  async function completeAuthentication(data, email) {
    if (!data.ok || !data.token) {
      setLoginMessage(data.msg || "登录失败", true);
      return false;
    }
    captureGuestState();
    session = { token: data.token, email: data.email || email };
    nickname = "";
    saveSession();
    hydrated = false;
    updateUi();
    setLoginMessage("登录成功，正在读取云存档…");
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
      return false;
    }
    await loadNickname();
    ui.loginPassword.value = "";
    ui.overlay.hidden = true;
    notify("登录成功，猫球数据已同步");
    await flushPendingGifts();
    finishLogin(true);
    return true;
  }

  function showResetMessage(message, error = false) {
    ui.resetMessage.textContent = message || "";
    ui.resetMessage.classList.toggle("error", error);
  }

  function startResetCountdown() {
    clearInterval(resetCountdownTimer);
    resetCountdown = 60;
    ui.resetSend.disabled = true;
    ui.resetSend.textContent = `${resetCountdown}s 后重发`;
    resetCountdownTimer = setInterval(() => {
      resetCountdown -= 1;
      ui.resetSend.textContent = resetCountdown > 0 ? `${resetCountdown}s 后重发` : "获取重置码";
      if (resetCountdown <= 0) {
        clearInterval(resetCountdownTimer);
        ui.resetSend.disabled = false;
      }
    }, 1000);
  }

  async function sendResetCode() {
    const email = ui.resetEmail.value.trim().toLowerCase();
    if (!validEmail(email)) return showResetMessage("请输入正确的邮箱地址。", true);
    if (resetCountdown > 0) return;
    ui.resetSend.disabled = true;
    showResetMessage("正在发送重置验证码…");
    try {
      const data = await request("send-reset-code", { email });
      showResetMessage(data.msg || "重置验证码已发送，请查收", !data.ok);
      if (data.ok) startResetCountdown();
    } catch (error) {
      showResetMessage(networkMessage(error), true);
    } finally {
      ui.resetSend.disabled = resetCountdown > 0;
    }
  }

  async function resetPassword(event) {
    event.preventDefault();
    const email = ui.resetEmail.value.trim().toLowerCase();
    const code = ui.resetCode.value.trim();
    const newPassword = ui.newPassword.value;
    if (!validEmail(email) || !/^\d{6}$/.test(code)) {
      return showResetMessage("请输入正确邮箱和 6 位重置验证码。", true);
    }
    if (newPassword.length < 6 || newPassword.length > 72) {
      return showResetMessage("新密码长度需为 6~72 位。", true);
    }
    if (newPassword !== ui.confirmNewPassword.value) return showResetMessage("两次输入的新密码不一致。", true);
    const submit = ui.reset.querySelector("button[type=submit]");
    submit.disabled = true;
    showResetMessage("正在重置密码…");
    try {
      const data = await request("reset-password", { email, code, newPassword });
      showResetMessage(data.msg || "密码重置失败", !data.ok);
      if (data.ok) {
        ui.newPassword.value = "";
        ui.confirmNewPassword.value = "";
        ui.resetCode.value = "";
        notify(data.msg || "密码重置成功");
        if (session) {
          openPanel("profile");
        } else {
          ui.passwordEmail.value = email;
          setAuthMode("password");
          openPanel("login");
        }
      }
    } catch (error) {
      showResetMessage(networkMessage(error), true);
    } finally {
      submit.disabled = false;
    }
  }

  async function setAccountPassword(event) {
    event.preventDefault();
    if (!session) {
      openPanel("login");
      return;
    }
    const password = ui.setPasswordInput.value;
    if (password.length < 6 || password.length > 72) {
      ui.setMessage.textContent = "密码长度需为 6~72 位。";
      ui.setMessage.classList.add("error");
      return;
    }
    if (password !== ui.setPasswordConfirm.value) {
      ui.setMessage.textContent = "两次输入的密码不一致。";
      ui.setMessage.classList.add("error");
      return;
    }
    const submit = ui.setPassword.querySelector("button[type=submit]");
    submit.disabled = true;
    ui.setMessage.textContent = "正在保存密码…";
    ui.setMessage.classList.remove("error");
    try {
      const data = await request("register", { email: session.email, password });
      ui.setMessage.textContent = data.msg || "密码保存失败";
      ui.setMessage.classList.toggle("error", !data.ok);
      if (data.ok) {
        ui.setPasswordInput.value = "";
        ui.setPasswordConfirm.value = "";
        notify("密码设置成功，下次可以使用邮箱和密码登录");
        openPanel("profile");
      }
    } catch (error) {
      ui.setMessage.textContent = networkMessage(error);
      ui.setMessage.classList.add("error");
    } finally {
      submit.disabled = false;
    }
  }

  async function loadNickname() {
    if (!session) return false;
    try {
      const data = await request("get-nickname", { token: session.token });
      if (data.code === "UNAUTHORIZED") {
        expireSession();
        return false;
      }
      if (!data.ok) return false;
      nickname = typeof data.nickname === "string" ? data.nickname : "";
      updateUi();
      return true;
    } catch (error) {
      console.error("账号昵称读取失败", error);
      return false;
    }
  }

  async function saveNickname(event) {
    event.preventDefault();
    if (!session) return;
    const value = ui.nicknameInput.value.trim();
    if (!value || Array.from(value).length > 16) {
      ui.profileMessage.textContent = "昵称需为 1~16 个字符。";
      ui.profileMessage.classList.add("error");
      return;
    }
    const submit = ui.nicknameForm.querySelector("button[type=submit]");
    submit.disabled = true;
    ui.profileMessage.textContent = "正在保存昵称…";
    ui.profileMessage.classList.remove("error");
    try {
      const data = await request("set-nickname", { token: session.token, nickname: value });
      if (data.code === "UNAUTHORIZED") {
        expireSession();
        return;
      }
      ui.profileMessage.textContent = data.msg || "昵称保存失败";
      ui.profileMessage.classList.toggle("error", !data.ok);
      if (data.ok) {
        nickname = data.nickname || value;
        updateUi();
        emit("nickname-updated");
        notify("账号昵称已同步");
      }
    } catch (error) {
      ui.profileMessage.textContent = networkMessage(error);
      ui.profileMessage.classList.add("error");
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
    nickname = "";
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
      try {
        const loaded = await hydrate(true);
        if (loaded) await loadNickname();
        return loaded;
      } catch { return false; }
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
      await loadNickname();
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
    nickname = "";
    saveSession();
    restoreGuestState();
    setSyncStatus("未登录");
    updateUi();
    ui.overlay.hidden = true;
    emit("logout");
    notify("已退出登录，已恢复本机游客数据");
    return true;
  }

  // ---------- 未登录礼品码：先存本机，登录后自动同步 ----------
  function makeRequestId() {
    return window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  function readPendingGifts() {
    try {
      const list = JSON.parse(storageGet(PENDING_GIFTS_KEY) || "[]");
      return Array.isArray(list) ? list.filter(item => item && typeof item.code === "string") : [];
    } catch {
      return [];
    }
  }

  function writePendingGifts(list) {
    if (list.length) storageSet(PENDING_GIFTS_KEY, JSON.stringify(list.slice(0, 50)));
    else storageRemove(PENDING_GIFTS_KEY);
  }

  function getPendingGiftCount() {
    return readPendingGifts().length;
  }

  function queueGift(code) {
    const list = readPendingGifts();
    if (list.some(item => item.code === code)) return false;
    list.push({ code, requestId: makeRequestId(), savedAt: Date.now() });
    writePendingGifts(list);
    emit("pending-gift-queued");
    return true;
  }

  // 登录后把本机暂存的礼品码逐个交给兑换接口并入账
  async function flushPendingGifts() {
    if (!session) return 0;
    const list = readPendingGifts();
    if (!list.length) return 0;
    const remain = [];
    const failed = [];
    let credited = 0;
    for (const item of list) {
      try {
        const data = await redeemOnServer(item.code);
        if (data.success) {
          credited += Number(data.points) || 0;
        } else {
          // 无效或已兑换的礼品码不再重试，只提示用户
          failed.push(`${item.code}（${data.message || "无法兑换"}）`);
        }
      } catch (error) {
        remain.push(item);
      }
    }
    writePendingGifts(remain);
    if (credited > 0) creditPoints(credited);
    if (failed.length) notify(`礼品码同步失败：${failed.join("；")}`);
    else if (credited > 0) notify(`本机礼品码已同步，共 +${credited} 积分`);
    else if (remain.length) notify(`还有 ${remain.length} 个礼品码等待同步`);
    return credited;
  }

  // 调用独立的 redeem 函数：服务端只校验并核销礼品码，积分需要前端写入存档再同步
  async function redeemOnServer(code) {
    const res = await fetch(REDEEM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, email: session ? session.email : "" })
    });
    const data = await res.json().catch(() => ({}));
    return data && typeof data === "object" ? data : {};
  }

  // 兑换成功后把积分写入本地存档并触发云同步
  function creditPoints(amount) {
    const value = Math.floor(Number(amount) || 0);
    if (value <= 0) return;
    const state = readLocalState();
    state.points = Math.max(0, Number(state.points) || 0) + value;
    applyLocalState(state);
    snapshot = normalizeState(state);
    emit("points-credited");
    markDirty();
  }

  async function redeem(code) {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,64}$/.test(normalized)) return { ok: false, msg: "礼品码格式无效" };
    // 未登录也能兑换：先存在本机，登录后自动同步入账
    if (!session) {
      const added = queueGift(normalized);
      return {
        ok: true,
        queued: true,
        msg: added ? "礼品码已保存到本机，登录后会自动同步到账号" : "这个礼品码已在待同步列表，登录后会自动入账",
        pending: getPendingGiftCount()
      };
    }
    await ready;
    if (dirty && !await syncNow()) return { ok: false, msg: "请先让当前修改同步到云端，再兑换礼品码" };
    try {
      const data = await redeemOnServer(normalized);
      if (!data.success) return { ok: false, msg: data.message || "兑换失败" };
      const points = Number(data.points) || 0;
      creditPoints(points);
      return { ok: true, msg: data.message || `兑换成功，获得 ${points} 积分`, points };
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
      if (loaded) await loadNickname();
      if (loaded) await flushPendingGifts();
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
    getPendingGiftCount,
    hasSession: () => Boolean(session && session.token)
  };

  function start() {
    buildUi();
    initialize();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
