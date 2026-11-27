# Supabase 全站登录与猫球云同步

## Context

小站目前由多个独立 HTML 页面组成，猫球名字、装扮、猫粮、积分和 PVP 背包都只存在浏览器 `localStorage`；`giftcard.html` 可直接匿名兑换，首页和 PVP 的积分购买也没有账号门槛。

目标是给全站接入邮箱验证码注册/登录、跨设备同步猫球数据，并限制未登录用户使用兑换码和积分购买。按用户确认的方案：**只复用并扩展 `send-verify-code` 一个 Edge Function**，不新增第二个函数，不建立用户表或会话表。登录身份由该函数签发的 JWT 承载，过期后自动失效。

## 实施方案

### 1. 扩展现有 `send-verify-code`

保留现有 `send`、`verify`、`check-token` 逻辑，只新增云存档、兑换和登出分支；后端改动提供在 `supabase/functions/send-verify-code/index.ts`，邮件发送及 JWT 签发逻辑不在前端重复实现。

统一接口地址：
`https://sshcmvydvckqkbmvdjvj.supabase.co/functions/v1/send-verify-code`

请求均为 `POST + application/json`：
- `send`：`{type,email}`，发送验证码。
- `verify`：`{type,email,code}`，成功返回 `{ok:true,msg,token,email}`。
- `check-token`：`{type,token}`，校验签名、有效期并返回身份邮箱。
- `load`：`{type,token}`，读取该邮箱对应的云端存档。
- `sync`：`{type,token,state,baseRevision}`，校验数据后同步，用 `revision` 防止旧页面覆盖新存档。
- `redeem`：`{type,token,code,requestId}`，登录后兑换；以幂等记录防止重试重复加分，返回服务端权威存档。
- `logout`：`{type,token}`，返回成功并由前端删除令牌；JWT 为无状态凭据，到期自动失效，不额外建立会话/黑名单表。

仅保留数据表：
- `verify_code`：沿用现有表，不改验证码规则。
- `catball_profiles`：`email text primary key`、`pet_name`、`food`、`points`、`inventory jsonb`、`revision`、`updated_at`，约束积分/猫粮非负。
- `catball_redemptions`：`code`、`email`、`request_id`、积分、创建时间；兑换码全局唯一、请求 ID 幂等，避免重复兑换和重复加分。

新增 `supabase/migrations/20261127_catball_profiles.sql` 建立上述两张新表及必要索引/约束。

安全规则：JWT 密钥只存在 Edge Function 环境变量；所有账户操作从已验证 JWT 中取邮箱，不信任请求另外传入的邮箱或用户 ID；校验存档字段、非负数值、背包结构和大小上限。CORS 允许 `*.github.io` 与本地测试源。前端和仓库均不出现 service role。

### 2. 新建全站共用账户模块

新增 `js/account.js` 与 `css/account.css`，并在所有用户可访问 HTML 页面引入（`super-mona/` 下使用 `../js/...`、`../css/...`；备份文件不改）。

账号模块自动注入：
- 全站统一账号按钮、当前邮箱和同步状态。
- 注册/登录弹窗：邮箱格式校验、6 位纯数字验证码、发送后 60 秒倒计时、防重复提交、统一展示后端 `msg`，并提醒检查垃圾箱。
- 首次登录存档导入确认、退出登录、网络/同步失败提示。

对外 API：`ready`、`ensureLogin(reason)`、`getUser()`、`getSnapshot()`、`markDirty()`、`refresh()`、`signOut()`、`redeem(code)`，并派发 `catball:account-state` 事件供页面重新读取现有数据。

所有接口调用都指向同一个 `send-verify-code`；前端仅保存 `{token,email}`，启动时先 `check-token`，失效则清除并回到未登录状态。

### 3. 复用现有 localStorage 做云端适配

统一映射：
- `catball_economy_v1`：积分、装扮期限、已装备装扮、PVP 背包和职业。
- `catball_food_v1`：猫粮。
- `catball_pet_name_v1`：猫球名字。

规则：
- 登录及打开页面时先加载云端；云端写回原有键并派发事件，复用各页面已有渲染逻辑。
- 本地修改成功后调用 `markDirty()`，约 800ms 防抖执行 `sync`；断网保留修改，恢复网络/窗口聚焦时重试。
- `sync` 携带 `baseRevision`；冲突时重新 `load` 并提示，不静默覆盖。
- 首次且云端无存档时，经确认导入当前浏览器数据；云端已有存档时使用云端，不把积分/猫粮相加，避免复制资产。
- 覆盖本地前保留备份；退出或切换账号时恢复登录前的游客数据，防止串号。
- 已登录状态下忽略 `?newpoints=` 调试加分，避免测试参数污染云存档。

### 4. 接入业务与登录拦截

- `index.html`
  - `buyProduct()` 入口等待 `ensureLogin()`，覆盖抽奖、猫粮、装扮、VIP 等积分购买。
  - 在 `persistEconomy()`、猫粮写入、`saveInventory()`、保存猫名等成功写入点触发同步。
  - 云端事件到达后刷新 `pointsBalance/storeInventory`，复用 `renderEconomy()`、`updateFoodUI()` 和装扮渲染。
- `giftcard.html`
  - 兑换前 `ensureLogin()`，再调用账户模块 `redeem()`，由同一个后端函数校验 JWT。
  - 删除前端直接 `save.points += data.points` 的加分逻辑，改用服务端返回的权威存档。
- `pvpgame.html`
  - 给 `buyItem()`、宠物修复、`unlockProfession()` 和积分押注入口加登录等待。
  - `persistArenaChanges()` 保持本地结算职责，成功后通知账户模块同步；云端事件到达后复用 `readProfile()` 刷新积分、装扮、背包和职业。
- `connect.html`
  - 普通串门不强制登录；云端状态到达后重新读取猫名和装扮。
  - 数学比赛积分奖励成功写入后触发同步。
- `card.html` 及其他工具/展示页
  - 只接全站账号状态，不修改各自业务逻辑。

## 验证

1. 对新增/修改的内联脚本、`account.js` 和 Edge Function TypeScript 做语法检查。
2. 本地静态服务器配合模拟接口验证：邮箱/验证码格式、60 秒倒计时、错误提示、刷新保持登录、JWT 失效和退出。
3. 后端部署后做双浏览器测试：首次本地导入、已有云端优先、猫粮/积分/装扮/名字/PVP 背包跨设备同步及 revision 冲突处理。
4. 验证未登录时首页积分购买、PVP 购买/职业解锁/修复/押注及礼品码兑换均被拦截；无令牌或过期令牌直接请求云端同样被拒绝。
5. 验证余额不足、重复点击、断网重试不会重复扣分或兑换；在 GitHub Pages 实际域名检查 CORS。
6. 回归原有人机、联机、猫球拖拽喂食和装扮显示，确认控制台无新增错误。
