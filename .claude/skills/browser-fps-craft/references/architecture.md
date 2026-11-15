# 架构：系统边界、启动、循环与降级

样本对应：`src/app/runtime.js`、`src/core/fallbacks.js`、`src/core/events.js`、`src/input/input.js`、`src/game/flow.js`。

---

## 1. 系统边界：context 注入，而不是模块互相 import

每个系统是一个工厂：

```js
createX(context) -> {
  update?(dt),
  // 其他公开方法，按需
}
```

- 系统只从 `context` 读取其他运行中的系统（`context.player`、`context.physics`、`context.fx`…）。
- 系统之间不 import 彼此的实现文件。
- 共享的纯函数/常量可以 import（数学、配置、几何工具、协议）。
- 跨系统通知走 `context.events`，不直接调用表现层。

好处：

1. 单系统可以替换成 fallback 或 stub。
2. 单系统可以 `showcase(context)`，只搭自己的最小场景。
3. 依赖图无环；初始化顺序集中可读。
4. 测试时能注入假玩家/假输入。

反例（不要这样）：

```js
import { spawnImpact } from '../effects/effects.js'; // 武器直接依赖特效实现
```

正确：

```js
context.events.emit('impact', { point, normal, surface, dir, from });
// effects.js 自己订阅
```

---

## 2. 启动：顺序、进度、降级、计时

### 2.1 顺序

样本顺序（有依赖关系，不要随意换）：

```
render         场景/相机/光照/后处理/自检
materials      程序化纹理与材质缓存
physics        碰撞/射线/导航网格
props          道具注册表
input          键鼠/触屏/手柄
level          关卡几何、目标点、碰撞盒
backdrop       远景（船、吊机、天际线）
ground         地面、沥青、积水、水面
fx             粒子/贴花/弹壳/碎片池
audio          合成音库/IR/混音
player         移动/镜头/生命
combat         射线命中/伤害
weapon         视图模型/射击/换弹
enemies        模型/池/AI/投射物
hud            DOM HUD
game           任务状态机/菜单
```

原则：**被依赖的在前，表现层在后；重资源（音频/纹理）尽量靠后，但必须在玩家进入前完成。**

### 2.2 分步推进

```js
async function setBootProgress(label, t) {
  bootMessage.textContent = label;
  bootFill.style.width = `${Math.round(t * 100)}%`;
  await new Promise(r => setTimeout(r, 0));   // 让浏览器画一帧
}
```

文案用世界观语言，进度用真实值。不要用假进度条。

### 2.3 初始化隔离

```js
async function initializeSystem(name, factory, required = false) {
  const t0 = performance.now();
  try {
    context[name] = await factory();
  } catch (err) {
    console.error(`[boot] module "${name}" failed`, err);
    if (required || !FALLBACKS[name]) throw err;
    context[name] = FALLBACKS[name]();
  }
  const ms = performance.now() - t0;
  if (ms > 150) console.log(`[boot] ${name} ${ms.toFixed(0)}ms`);
}
```

“required”只给真正无法降级的系统：渲染器、关卡。其余全部可降级。

### 2.4 启动自检（渲染器）

样本在启动时渲染一个 1×1×1 的盒子：

1. 用真实后处理链渲染一次。
2. 捕获 shader 编译错误，按 `SALTLINE_POST` / `SALTLINE_SKY` / 软阴影标记分类。
3. 如果后处理失败 → 永久切前向渲染，`resize()` 重算目标。
4. 如果软阴影 chunk 被驱动拒绝 → 换回 `PCFSoftShadowMap`，重建测试材质再试。
5. 成功后移除测试物体并释放几何/材质。

这段代码的价值：**把“某台机器上黑屏”变成“自动降级 + 一条可读日志”。**

### 2.5 首帧完成标记

```js
window.__frames++;
if (window.__frames === 2) window.__ready = true;
```

两帧而不是一帧：第一帧可能还在编译/上传纹理，第二帧才代表稳定出图。

---

## 3. 帧循环与更新顺序

```js
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const raw = (now - prev) / 1000;
  prev = now;
  fpsEma = fpsEma ? fpsEma * 0.95 + raw * 0.05 : raw;

  let dt = Math.min(raw, 0.05);       // 后台切回/断点后不跳帧
  if (params.dt) dt = +params.dt;     // QA：固定步长
  context.time.dt = dt;
  context.time.t += dt;
  context.time.real = now / 1000;
  context.time.frame++;

  updateSystem('input', dt);

  const active = context.game.update(dt) !== false
    && context.game.state !== 'title'
    && context.game.state !== 'paused';

  if (active) {
    updateSystem('player', dt);
    updateSystem('weapon', dt);
    updateSystem('enemies', dt);
  }

  if (context.game.state !== 'paused') {
    updateSystem('fx', dt);
    updateSystem('ground', dt);
    updateSystem('level', dt);
    updateSystem('backdrop', dt);
    updateSystem('mats', dt);
  }

  updateSystem('audio', dt);
  updateSystem('hud', dt);

  // 相机覆盖（QA）
  if (cameraOverride) {
    camera.position.copy(cameraOverride.pos);
    camera.lookAt(cameraOverride.look);
  }

  try { context.render.frame(dt); }
  catch (err) { reportOnce('render', err); }

  context.input.endFrame?.();
  window.__frames++;
  if (window.__frames === 2) window.__ready = true;
});
```

要点：

- **输入最先**，因为其他系统都读输入状态。
- **游戏状态机先决定本帧是否 active**；标题/暂停时不更新玩家/武器/敌人，但相机/UI/音频仍可能需要更新。
- **表现层最后**（fx/ground/level/backdrop/mats），音频/HUD 在其后，渲染最后。
- `dt` 上限 0.05s；不要用 `requestAnimationFrame` 的原始时间差直接积分。
- 固定 `dt` 只用于截图/回放，不用于正常游玩。

### 3.1 单系统错误隔离

```js
const updateSystem = (name, dt) => {
  const sys = context[name];
  if (!sys?.update) return;
  try {
    sys.update(dt);
  } catch (err) {
    if (!updateSystem.reported[name]) {
      updateSystem.reported[name] = true;
      console.error(`[loop] ${name}.update threw`, err);
    }
  }
};
updateSystem.reported = {};
```

每系统只报一次，避免每帧日志拖死页面。错误同时进 `window.__errors`（见诊断）。

---

## 4. 事件总线

```js
function createEventBus() {
  const map = new Map();
  return {
    on(name, fn) {
      (map.get(name) ?? map.set(name, []).get(name)).push(fn);
      return () => this.off(name, fn);
    },
    off(name, fn) {
      const list = map.get(name);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit(name, payload) {
      const list = map.get(name);
      if (!list) return;
      for (const fn of list) {
        try { fn(payload); }
        catch (err) { console.error(`[events] handler for "${name}" threw`, err); }
      }
    },
  };
}
```

订阅者抛错不能影响其他订阅者，更不能影响发事件的玩法系统。

常用事件（样本）：

| 事件 | 载荷 | 订阅者 |
|---|---|---|
| `weapon:fire` | origin/dir/muzzle/ads | 音频、敌人听觉、光照、HUD |
| `weapon:reload` | phase/empty | 音频、HUD |
| `impact` | point/normal/surface/dir/from/enemy | 特效、贴花、音频、HUD |
| `player:hit` | amount/fromPos | 后处理、HUD、音频 |
| `player:dead` | {} | 状态机、菜单 |
| `enemy:hit` / `enemy:killed` | enemy/point/part | 特效、音频、HUD、任务 |
| `objective:progress` / `done` / `all` | id/t/index/total | HUD、音频、状态机 |
| `game:state` | state/prev | 菜单、敌人清理、音频 |
| `quality:auto` | name | HUD/日志 |
| `explosion` | pos/size | 音频、敌人 alert、玩家 shake |

命名约定：`域:动作`。载荷是普通对象，不要传系统实例（`enemy` 对象可以，但只读）。

---

## 5. 输入抽象

### 5.1 统一状态

```js
const input = {
  move: { x, y },
  look: { dx, dy },
  fire, ads, sprint, crouch,
  locked, touch, gamepad,
  down(action), pressed(action),   // 持续/本帧按下
  requestLock(), exitLock(),
  setGameplay(on),
  update(dt), endFrame(),
  mode: 'lock' | 'drag' | 'touch',
  describeMode(),
  onModeChange(fn),
};
```

玩法只读 `input.move/fire/ads/pressed(...)`，不关心来源是键盘、触屏还是手柄。

### 5.2 三种视角模式

| 模式 | 触发 | 行为 |
|---|---|---|
| `lock` | 浏览器支持 Pointer Lock 且请求成功 | 相对位移，锁定光标 |
| `drag` | 不支持/请求失败/用户 Esc | 按住拖拽，或方向键/IJKL 持续转向 |
| `touch` | 检测到触摸 | 左半屏虚拟摇杆，右半屏拖动视角，屏幕按钮 |

`requestLock()` 失败要自动进入 `drag`，并在 HUD 提示“鼠标捕获不可用——拖动或方向键转向”。不要静默失败。

### 5.3 手柄

轮询 `navigator.getGamepads()`，映射左摇杆/右摇杆/扳机/按键；死区与曲线单独处理。检测到手柄时切到 `gamepad` 提示，但不强制抢占键鼠。

### 5.4 按键映射

```js
const KEY_BINDINGS = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', KeyC: 'crouch',
  KeyR: 'reload', KeyE: 'interact', KeyF: 'melee',
  Escape: 'pause', KeyP: 'pause',
  Enter: 'fire', ArrowLeft: 'turnL', ArrowRight: 'turnR',
};
```

一个动作可映射多个键；`pressed` 只在按下的那一帧为真；`endFrame()` 清空本帧集合。

---

## 6. 游戏流程状态机

```js
state: title | intro | playing | paused | dead | complete
```

- `title`：相机沿样条巡游，菜单显示，输入不驱动玩家。
- `intro`：淡入、地点卡、无线电、玩家禁用；到时 `playing`。
- `playing`：玩家/武器/敌人更新；目标推进；暂停键可用。
- `paused`：玩家/敌人停；菜单；恢复时重新请求指针锁。
- `dead`：去饱和、淡出、死亡面板；重试/重开。
- `complete`：结算（时间/命中率/击杀/重试/评级）、淡出。

`setState(next)` 统一发 `game:state` 事件；敌人在 `title` 时清空；音频按状态切强度。

流程层还要处理：

- 页面 `visibilitychange` → 自动暂停。
- 指针锁丢失 → 暂停（可选，取决于游戏）。
- `Esc` 第一次关面板，第二次恢复/暂停。
- 重开重置：敌人、特效、战斗统计、武器、任务计数、玩家位置、后处理状态。

---

## 7. 诊断

启动时安装：

```js
window.__fatal = null;
window.__errors = [];

function showFatalError(err) {
  window.__fatal = String(err);
  console.error('[fatal]', err);
  // 在 #app 里显示可读错误，而不是让用户看黑屏
}

window.addEventListener('error', e => window.__errors.push(String(e.message)));

const origError = console.error.bind(console);
console.error = (...args) => {
  try { window.__errors.push(args.map(a => a?.stack || String(a)).join(' ').slice(0, 400)); }
  catch {}
  origError(...args);
};
```

`__stats()` 至少返回：

```js
{
  calls, tris, geos, tex, programs,
  res: [w, h], scale,
  advanced: true, softShadows: true,
  fps, state
}
```

`__G` 暴露 context，便于控制台检查 `__G.player.pos`、`__G.enemies.list.length`。**只用于诊断，不作为存档格式。**

---

## 8. 改造一个已有项目（落地顺序）

1. 找主循环，把“每帧调用一堆东西”改成 `updateSystem(name, dt)` 表驱动。
2. 把全局变量收进 `context`；先保留 `window.__G = context` 过渡。
3. 给每个系统补 fallback（空实现），先不接降级逻辑，只保证接口完整。
4. 加 `initializeSystem` 的 try/catch，按依赖标注 required。
5. 加 `setBootProgress` + `__ready`。
6. 加 URL 参数：`seed/dt/cam/shot/q/noaudio`。
7. 加 `__stats()` 与 `__errors`。
8. 最后再加动态分辨率与质量降档（见 `qa-and-performance.md`）。

每一步都能独立提交并验证，不要一次改完。

---

## 9. 最小文件骨架

```text
src/
  game.js                  entry：注册表 + 诊断 + startGame
  app/
    runtime.js             context + 启动 + 主循环
    boot-screen.js         进度/让出主线程
    diagnostics.js         错误捕获
    benchmark.js           巡游基准
    showcases.js           系统 showcase 注册表
  core/
    config.js              世界/光照/玩家/质量预设
    events.js              事件总线
    random.js              种子 RNG
    math.js                clamp/lerp/smoothstep/damp
    quality.js             设备探测
    fallbacks.js           空实现
    geometry.js            共享几何/合批
```
