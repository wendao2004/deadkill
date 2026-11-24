# 1080p 性能基线（2026-11-22）

环境：Windows 10 / Chrome headless（新 headless）/ NVIDIA GTX 1660 SUPER /
quality 档 / 1920×1080（`Emulation.setDeviceMetricsOverride` 钉死）/
`scale=1&dt=16.67` / 600 帧 / 无音频 / 完整绕 360° 预热后再采样；
数据在 Week 8 代码上重跑（`week8-quality-*`）。

| 地图 | 天气（本次抽到） | avg | p99 | max | >50ms | calls | tris |
|---|---|---:|---:|---:|---:|---:|---:|
| 沼泽农舍 `marsh-p0` | 19:00 浓雾 | 16.67 | 16.8 | 16.8 | 0 | 275 | 195,706 |
| 教堂墓园 `chapel-night` | 07:00 白昼 | 16.67 | 16.8 | 16.8 | 0 | 162 | 173,724 |
| 采石场 `quarry-dust` | 07:00 白昼 | 16.67 | 16.8 | 16.8 | 0 | 316 | 184,642 |
| 火车站 `station-dusk` | 19:00 骤雨 | 16.67 | 16.8 | 16.8 | 0 | 180 | 132,041 |
| 松林营地 `pine-camp-night` | 19:00 浓雾 | 16.67 | 16.8 | 16.8 | 0 | 213 | 232,888 |

结论：五图在 1080p quality 档均锁 60fps，p99 16.8ms，无 >50ms 卡顿。
本次在 Week 8 代码（兴趣管理/RTT/计时器修复）上重跑，最大 draw calls 316
（采石场白昼），松林浓雾 213；天气按 matchId 抽取，跨版本比较时看 JSON 里的
`stats.modifier`。

## balanced 档（同一环境，固定上限 0.85）

| 地图 | avg | p99 | max | >50ms | calls | tris |
|---|---:|---:|---:|---:|---:|---:|
| 沼泽农舍 | 16.67 | 16.8 | 16.8 | 0 | 279 | 195,127 |
| 教堂墓园 | 16.67 | 16.8 | 16.8 | 0 | 257 | 193,988 |
| 采石场 | 16.67 | 16.8 | 16.8 | 0 | 256 | 186,722 |
| 火车站 | 16.67 | 16.8 | 16.8 | 0 | 261 | 150,513 |
| 松林营地 | 16.78 | 17.0 | 33.4 | 0 | 300 | 251,001 |

balanced 的 `scale=0.85` 是画质档固定上限，不是动态降档；`qa-bench` 现在只拒绝
采样期发生升降档/画质降档，不再要求 scale 必须等于 1。

## 复现

```bash
# 先启动 server/client
pnpm --filter @dk/server dev
pnpm --filter @dk/client dev

# 逐图跑；--out 会把 gpuName/scale/calls/tris/errors 一起归档
node tools/qa-bench.mjs --w 1920 --h 1080 --require-gpu \
  --out docs/perf/marsh-quality-1080-final.json \
  --url "http://localhost:5173/?bench=1&q=quality&seed=4207&noaudio=1&map=marsh-p0&match=perf-marsh&scale=1&dt=16.67"
```

注意：

- 天气按 `matchId` 哈希抽取；两次跑同一张图可能抽到不同天气，calls/tris 会变。
  对比性能时固定 `match=` 或记录 JSON 里的 `stats.modifier`。
- 旧版 `qa-bench` 只预热 90 帧（约 80°），背面材质会在采样阶段首次编译，
  station/pine 曾出现 100/50ms 尖峰。现在预热至少绕满 360°，并要求
  `hitches === 0`（>50ms 的帧）才算通过。
- 这是 GTX 1660 SUPER 的单机基线，不代表核显/移动端。核显默认进 balanced；
  用 `?q=balanced` 另跑一份。

## 2026-11-24 画面打磨后复核（marsh / pine）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish3-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |
| pine-camp-night | `polish3-pine-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮把草窝密度提到 200/图、新增 150 块小碎石、`pine_dead` 从 192 增到 448
三角形、树冠棱球从 20 面细分到 80 面 —— 两图仍在 60fps 上限内、无 >50ms 尖峰。

## 2026-11-24 第三轮打磨后复核（marsh）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish4-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮新增：7 栋建筑各 +12 个立面盒子（合并成 2 次绘制）、枯树 448 → 556 三角形、
芦苇 3 → 6 片叶（18 三角形）、石墙着色器多一次噪声采样。仍在 60fps 上限内、无 >50ms 尖峰。

## 2026-11-24 第四轮打磨后复核（marsh）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish5-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮新增：7 栋房子各 +5~6 个合并批次（门扇/门套/石础/雨棚/封檐板，按材质各一次绘制）、
封檐板与檐下封板各 5 个盒子。近景截图 draw call 204 → 227（同一机位不同天气，
含怪物数量差异），仍在 60fps 上限内、无 >50ms 尖峰。

## 2026-11-24 第五轮打磨后复核（marsh）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish7-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮新增：室内压暗（8 个净空盒子的片元判据，纯 uniform，无额外绘制）、木墙改为
板条 + 压条、门扇摆开的几何（仍是 4 个合并批次）。满场景 draw call 274，
60fps 上限内、无 >50ms 尖峰（`hitches 0`）。

## 2026-11-24 第六轮打磨后复核（marsh）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish8-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮只改泥地/石作的着色器分支（多 2 次 warp 噪声 + 1 次遮罩 + 3 个加性项），
零新增绘制；基准路径 600 帧 `hitches 0`，与上一轮持平。

## 2026-11-24 第七轮打磨后复核（marsh）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish9-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮把树干从 0.8m 方柱换成锥形圆柱（7 边 × 3 段 = 14 三角形/棵，marsh 97 棵），
并给 13 棵"界树"补三层锥冠（约 3 × 40 三角形/棵）。两者各自合并成 1 个 mesh、
各 1 个新材质（`bark`），所以 draw call 不变；场景三角形 249.5k → 253.9k（+1.8%）。
600 帧基准与上一轮完全一致。

## 2026-11-24 时段选择 + 滑铲修复后复核（marsh，白昼）

| 图 | 文件 | avg | median | p99 | hitches |
|---|---|---|---|---|---|
| marsh-p0 | `polish10-marsh-quality-1080.json` | 16.67 | 16.7 | 16.8 | 0 |

本轮没有加任何逐帧渲染开销：时段选择只影响 `modifier` 的抽签范围（同一份
`setDaylight` 两套光照早已存在），大厅的时段条是纯 DOM。600 帧基准与前三轮
完全一致。滑铲修复只动 `Character` 的状态机，与渲染无关。
