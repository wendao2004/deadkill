# 手感：玩家、镜头、武器、命中、敌人与音频

样本对应：`src/player/player.js`、`src/weapons/weapon.js`、`src/weapons/rig.js`、`src/enemies/*`、`src/effects/*`、`src/audio/*`。

“手感”不是单一参数，而是**输入 → 表现 → 反馈**这条链上每一环的延迟、幅度和层次。任何一环缺失，整体都会显得轻。

---

## 1. 总原则

1. **输入到画面 ≤ 1 帧**。视角、开火、瞄准的第一帧响应必须是即时的；平滑只用于“表现层”（枪模、后坐恢复、镜头晃动）。
2. **每个动作有三段**：预备（anticipation）、冲击（impact）、恢复（recovery）。换弹、开火、受击、落地都要有。
3. **分层叠加，不要互相覆盖**。镜头 = 基础 + 后坐 + 晃动 + 落地下沉 + 侧倾；枪模 = 基础姿态 + 后坐 + 摆动 + 跳跃 + 换弹。
4. **用弹簧-阻尼，不用线性插值**。线性插值像 UI 动画；弹簧有惯性、过冲和回弹。
5. **声音和画面同时发生**。命中反馈至少 5 个通道（见 §5）。
6. **参数命名、集中、可调**。一次只改一个；先改能感知的 20%。

---

## 2. 玩家移动

### 2.1 样本常量

```js
const PLAYER_MOVEMENT = {
  walk: 3.8, sprint: 6.4, crouch: 1.9, ads: 2.4,
  accelGround: 34, decelGround: 26, accelAir: 9,
  gravity: 21, jumpApex: 1.0,
  coyote: 0.12, jumpBuffer: 0.13,
  standHeight: 1.8, crouchHeight: 1.15, eyeRate: 11,
  stride: { walk: 1.55, sprint: 2.1, crouch: 1.05 },
  bobY: 0.024, bobX: 0.013, bobSprint: 1.9, bobAds: 0.22,
  rollStrafe: 0.02, landDip: 0.36, landDipMax: 0.2,
  fovSprint: 6, fovAds: 52, adsLook: 0.6,
  regenDelay: 4, regenRate: 25,
  recoilKeep: 0.35, recoilApply: 34, recoilRecover: 6.5, recoilHold: 0.09,
  shakePitch: 0.03, shakeYaw: 0.03, shakeRoll: 0.045,
  pitchLimit: 1.5,
};
```

### 2.2 水平移动

```js
// 目标速度
const target = new Vector3(inputX, 0, -inputY)
  .normalize()
  .multiplyScalar(speed);

// 朝目标加速，而不是直接赋值
const delta = target.clone().sub(vel);
const accel = onGround
  ? (moving ? accelGround : decelGround)
  : (moving ? accelAir : 0.6);
const step = accel * dt;
if (delta.length() <= step) {
  vel.x = target.x;
  vel.z = target.z;
} else {
  vel.addScaledVector(delta.normalize(), step);
}
```

- 空中控制显著弱于地面（样本 9 vs 34），但不能为 0，否则跳跃不可控。
- 后退速度乘 0.82，冲刺要求“前向输入 + 非瞄准 + 非开火 + 非蹲”。
- 速度用水平分量，不要用 `vel.length()` 把垂直速度算进 bob。

### 2.3 跳跃

```js
const JUMP_SPEED = Math.sqrt(2 * gravity * jumpApex);
```

- `jumpApex` 是设计量：想跳 1m 就填 1.0。
- 土狼时间：离开地面后 `coyote` 秒内仍可跳。
- 跳跃缓冲：落地前 `jumpBuffer` 秒内按跳，落地立即触发。
- 落地：按下落速度产生下沉 `g.v -= min(impact * landDip, 3.2)`、shake、脚步、超过阈值掉血。

### 2.4 蹲起

- 目标 eye 高度 `crouch ? 1.05 : 1.68`，用 `damp(eye, target, 11, dt)`。
- 起身前检查头顶空间；不满足就保持蹲。
- 蹲下不改变碰撞半径，只改高度；避免卡进箱子。

### 2.5 脚步

```js
stride = crouching ? 1.05 : sprinting ? 2.1 : 1.55;
phase += speed * dt / stride;
if (floor(phase) > floor(prev)) emit('player:step', { surface, sprint, pos });
```

步频由速度驱动，不由动画驱动；这样加速/减速自然。

---

## 3. 镜头合成

每帧固定顺序，避免互相覆盖：

```js
// 1. 基础
eye = pos.y + eyeHeight + bobY + landDip;
yaw = baseYaw + recoilYaw + shakeYaw;
pitch = clamp(basePitch + recoilPitch, -1.55, 1.55);

// 2. 后坐：一部分永久，一部分弹簧
pitch += recoilSpring.x;    // 施加后 damp 回 0
yaw   += recoilSpring.y;

// 3. shake：强度平方 × 多频正弦
const s = shake * shake;
camera.rotation.x += s * 0.03 * (sin(t*43.1) + 0.6*sin(t*71.7+1.3));
camera.rotation.y += s * 0.03 * (sin(t*37.3+2.1) + 0.6*sin(t*83.9));
camera.rotation.z += s * 0.045 * (sin(t*29.7+0.7) + 0.5*sin(t*61.3+4));

// 4. 落地下沉与侧倾
camera.position.y += landDip;
camera.rotation.z += strafeRoll + bobX;

// 5. FOV
camera.fov = damp(camera.fov, targetFov, adsMid ? 30 : 7, dt);
```

要点：

- shake 用 `s²` 而不是 `s`，衰减更自然。
- 多个正弦不同频率，避免机械感。
- 横移侧倾与 bob X 分开，不要合成一个 sin。
- ADS 时 look scale 0.6，bob/roll 大幅衰减，FOV 到 52。
- 死亡：eye 降到 0.22，roll 增加，pitch 下坠；用 `smoothstep` 控制。

---

## 4. 武器

### 4.1 样本常量

```js
const WEAPON = {
  magSize: 30, reserve: 150, rpm: 720, damage: 26, range: 300,
  reloadHip: 2.1, reloadEmpty: 2.72,
  spread: {
    hip: 0.0125, ads: 0.0012,
    moveHip: 0.013, moveAds: 0.004,
    bloomHip: 0.0065, bloomAds: 0.0022,
    air: 0.022, crouch: 0.002,
  },
  recoil: {
    pitch: 0.0068, shake: 0.12,
    keep: 0.35, apply: 34, recover: 6.5, hold: 0.09,
  },
};
```

### 4.2 散布模型

```js
spread = lerp(hip, ads, adsE)
       + moveRatio * lerp(moveHip, moveAds, adsE)
       + bloom * lerp(bloomHip, bloomAds, adsE)
       + (onGround ? 0 : air)
       - (crouching ? crouch * (1 - adsE) : 0);
spreadSmooth = damp(spreadSmooth, spread, 18, dt);
```

- 散布和后坐分开：散布决定弹着点随机锥，后坐决定镜头/枪口上跳。
- `bloom` 随连射增加（每发 +0.17），停火按 1.5/s 衰减。
- 瞄准不是瞬间：`adsLin += (ads ? dt : -dt) / 0.18`，用 smootherstep 映射。

### 4.3 后坐

```js
// 开火
player.addRecoil(pitchKick * burstFactor * adsFactor * (0.85 + rnd()*0.3), yawJitter);
player.addShake(0.12 * adsFactor);
// 视图模型通道
v.kZ += 1.5 * lerp(1, 0.6, adsE);
v.kP += 1.5 * adsFactor;
v.kY += (rnd()-0.5) * adsFactor;
v.kR += (rnd()-0.5) * 1.8 * adsFactor;
bloom = min(1, bloom + 0.17);
```

- 前 9 发后坐完整，之后乘 0.38（连射惩罚曲线）。
- 水平后坐用 `sin(burst * 0.57 + phase) * 0.0042 + jitter`，避免纯随机。
- 停火 0.24s 后重置 burst；`recPhase` 随机化，下一次连射形状不同。

### 4.4 换弹时间轴

```text
t=0.47  mag out        bump -0.25
t=0.86  新弹匣出现
t=1.345 mag in         bump +0.55，弹药结算
t=1.50  拍弹匣         bump +0.4
t=2.14-2.19 拉栓（空仓换弹） bump +0.3
t=2.10 / 2.72 完成
```

- 空仓换弹多 0.62s 拉栓；非空仓不拉。
- 弹匣是独立 Group，按弧线关键帧移动/旋转；不要只做位置插值。
- `inspect`：待机 24s 后触发 3.5s 检查动画；任何输入打断。
- `heat`：连射升温，超过 0.45 开始冒烟；枪口闪光有短 TTL。

### 4.5 视图模型弹簧

```js
function spring(state, target, dt) {
  const steps = dt > 0.012 ? Math.ceil(dt / 0.008) : 1;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    state.v += ((target - state.x) * state.k - state.v * state.c) * h;
    state.x += state.v * h;
  }
  return state.x;
}
```

样本通道（k, c）：

| 通道 | k | c | 用途 |
|---|---|---|---|
| kZ | 520 | 30 | 前后 |
| kP | 380 | 26 | 俯仰 |
| kY | 300 | 22 | 偏航 |
| kR | 300 | 20 | 滚转 |
| swY/swP | 110 | 15 | 鼠标摆动 |
| jY/jP | 140 | 13 | 跳跃 |
| bump | 600 | 30 | 换弹/拍弹匣 |

- 每个通道独立积分，最后相加。
- 鼠标摆动：`v += lookDelta * 3.2`，然后弹簧回 0；限制 ±0.09。
- 跳跃：起跳 `jY -= 0.22, jP += 0.7`；落地按 `-vy * 0.06` 下沉。
- 行走 bob：`sin(phase)` 和 `sin(2*phase)` 叠加，ADS 时乘 0.12。

### 4.6 枪模细节

- 视图模型用独立材质（枪金属、聚合物、哑光、黄铜），三平面 + 顶点色。
- 刻字/编号用 canvas 生成的贴花几何，十几条小平面，成本低但近看很贵。
- 手部是骨骼网格：手指有多个姿势（握持/扣扳机），用顶点插值切换；换弹时左手按关键帧移动。
- 枪口闪光用 shader 面片 + 点光源池；不是简单 sprite。
- 进入室内枪身 `wetness` 从 1 平滑到 0.3；离开回升。

---

## 5. 命中反馈链

一次 `impact` 事件，至少五个订阅者：

```js
context.events.emit('impact', { point, normal, surface, dir, from, enemy, part, killed });
```

| 通道 | 做法 |
|---|---|
| 粒子 | 按 surface 选配方：金属火花、混凝土粉尘、木屑、水花、玻璃碎片；法线方向喷射 |
| 贴花 | 预生成 atlas，池化 160 个四边形，随机旋转/尺寸，polygonOffset 防 z-fight |
| 声音 | `impact_<surface>` + 距离衰减 + 室内/室外卷积；击杀加 `enemy_die` |
| 光照 | 短 TTL 点光源脉冲（枪口/爆炸） |
| HUD | 命中标记四段闪白；弱点/击杀变红；受击显示方向弧 |
| 后处理 | 玩家受击红边 + 低血量去饱和/暗角 |
| 顿帧 | 仅击杀/爆炸：0.03–0.06s 时间缩放或直接跳帧 |

别把五个通道写在一个函数里；让玩法只发事件。

---

## 6. 敌人 AI

### 6.1 感知

```js
const TUNING = {
  sightRange: 45, sightCone: 200,       // 度
  loseSight: 4, searchTime: 8,
  hearRadius: 45,
  maxTokens: 2, maxTokensCrowd: 3, tokenGap: 1.25,
  exposureUp: 0.1, exposureDown: 0.45,
};
```

- 检测间隔 0.11–0.19s（带随机抖动），不要每帧 raycast。
- 视锥：`dot(forward, toPlayerXZ) > cos(cone/2)`；距离 < 3.5m 时无视锥。
- LOS：`physics.lineOfSight(sensor, playerEye)`。
- 听觉：`weapon:fire` / `explosion` 事件 → `alert(pos, radius)`。
- 暴露度 `exposure` 随可见时间上升、丢失下降；可用于 UI/仇恨。

### 6.2 状态机

```text
patrol → investigate → engage → search → patrol
```

- `patrol`：沿巡逻点/半径游走。
- `investigate`：去 `lastKnown`，搜索 8–12s。
- `engage`：可见且 `seeT` 超过阈值；丢失 4s → `search`。
- `search`：在最后已知位置附近找；超时回 `patrol`。
- 一个敌人进入 `engage` 时，附近同伴 `rally` 转 `investigate`。

### 6.3 攻击令牌

```js
requestToken(enemy) {
  if (enemy.hasToken) return true;
  const alive = list.filter(e => e.alive).length;
  const cap = alive > 5 ? maxTokensCrowd : maxTokens;
  if (tokens >= cap) return false;
  if (now - lastToken < tokenGap) return false;
  tokens++; enemy.hasToken = true;
  return true;
}
```

没有令牌的敌人可以追击、绕后、找掩体，但**不开火**。这是“可玩”和“被集火秒杀”的分界线。

### 6.4 投射物

- 定容池（样本 32 发），每发记录 `pos/dir/from/len/life`。
- 每帧推进 `speed * dt`，用 `physics.raycast(pos, dir, step)` 检测命中。
- 命中玩家用“线段到胶囊最近距离”，半径约 0.36，不是逐帧球体。
- 命中环境发 `impact`；命中玩家 `player.damage`；超时/超距回收。
- 渲染用 `InstancedMesh`，一次 draw call。

### 6.5 死亡

- 掉旋翼/失稳/旋转/坠落/沉没，wreck 有上限（样本 5），旧的自沉。
- 死亡瞬间发 `enemy:killed`，特效/音频/HUD/任务各自订阅。
- 尸体不要留在碰撞列表；`alive=false` 后 raycast 跳过。

---

## 7. 音频

### 7.1 全程序化

样本 63 个音效，全部在运行时用 WebAudio 生成缓冲：

```js
const LIBRARY = {
  rifle_shot: { gen: rifleShot, n: 4, sr: 44100, peak: 0.97,
                bus: 'near', max: 5, pri: 9, boot: 1 },
  rifle_tail_in: { gen: tailIndoor, n: 2, sr: 32000, peak: 0.62,
                   bus: 'dry', max: 3, pri: 8, boot: 1 },
  // …
};
```

字段含义：

- `gen(sr, seed, variant)`：返回 `Float32Array[]`（单声道或立体声）。
- `n`：变体数；每次播放随机选一个，避免“机关枪复读”。
- `sr`：采样率（44.1k 近场、32k/22.05k 节省内存）。
- `peak`：归一化峰值。
- `bus`：`near` / `dry` 等总线。
- `max`：同时发声上限。
- `pri`：抢占优先级。
- `boot`：启动时预生成。

### 7.2 合成配方

- 枪声：噪声脉冲 + 低频 thump + 高频 crack + 短混响尾；分层拼。
- 尾部：室外/室内两套卷积 IR（`ir_outdoor` / `ir_shed`），按玩家位置切换。
- 脚步/撞击：按 surface 选配方（混凝土/金属/木/水/玻璃/泥）。
- 机械：换弹的 magout/magin/bolt 是不同频段的金属敲击 + 弹簧。
- 敌人：旋翼是低频调制噪声，伺服是窄带扫频。
- 环境：雨（室内外两套）、风、海、中继电流声。
- 音乐：drone / ost / perc / brass / motif 分层，按 `setIntensity(0.15/0.6/1.0)` 混音。

### 7.3 3D 与混音

- `PannerNode`（HRTF 或 equalpower）+ 距离衰减；循环体（旋翼/伺服/电流）返回 `{ stop, setPos, setGain, setPitch }` 句柄。
- 总线：近场/干声/环境/音乐；`setPaused` 暂停；用户手势后 `resume()`。
- 并发上限按 `max`，超过时按优先级抢占，避免爆音。
- UI 音效不走 3D。

---

## 8. 调参流程

1. **先定基准**：固定 seed、固定相机、固定输入脚本（前进 2s、开火 10 发、换弹、跳跃）。
2. **一次只改一个常量**，记录旧值/新值/主观变化。
3. **先改大感知量**：移动速度、后坐、FOV、枪模摆动、命中音量。
4. **再改细节**：bob、roll、落地下沉、颗粒、暗角。
5. **盲测**：闭眼听 10 秒，能否分辨动作；睁眼 10 秒，能否感到重量。
6. **回滚**：任何“感觉更好但截图变差”的改动都要复核；画面和手感不应互相牺牲。

### 手感检查表

- [ ] 移动起步/停止没有“滑冰”或“急刹”。
- [ ] 跳跃高度可重复；落下有下沉但不过度。
- [ ] 瞄准有明确 FOV/灵敏度/散布变化，不是只放大。
- [ ] 开火第一发即时；连射有可读的后坐pattern。
- [ ] 换弹有预备/插入/收尾三段，空仓多拉栓。
- [ ] 命中五通道同时发生；击杀有额外确认。
- [ ] 受击能判断来源方向；低血量有可读反馈但不遮挡。
- [ ] 敌人不会同时集火；有接近、绕后、开火、撤退的节奏。
- [ ] 音频没有爆音/复读；室内外有明显空间差异。
