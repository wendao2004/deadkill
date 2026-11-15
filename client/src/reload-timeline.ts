/**
 * 换弹时间轴：把"枪机/击锤/转轮在第几成进度该到哪"写成数据，而不是在
 * update() 里用一条 sin(phase·π) 糊过去。
 *
 * ## 为什么需要它
 *
 * 单段正弦能表达"整把枪压下去再抬回来"，但表达不了杠杆枪"压杆→推弹→
 * 回杆"、双管"掰开→装填→合上"、转轮"甩巢→逐发装填→归位"这些**分段**
 * 动作。手册要求换弹是时间轴关键帧，而不是一段插值；实现上就是这里的
 * 轨道数据 + 一个零分配的采样器。
 *
 * ## 为什么不引 AnimationMixer
 *
 * 整个视图模型是标量驱动的：没有骨骼、没有 clip、没有播放器。为了三段
 * 换弹引一个 AnimationMixer，会把"零分配、可复现、暂停即停"全部打破。
 * 轨道只是 `{ part, keys }` 数组，采样一次是几次比较和一次 smoothstep。
 *
 * ## 约定
 *
 * - `t` 是归一化换弹进度 0..1（服务端给的 reloadProgress / 100）。
 * - `v` 是**相对静止位的增量**：杠杆/击锤是弧度，转轮是累计角度（弧度）。
 * - 段内用 smoothstep：关键帧之间也必须是缓入缓出，线性插值会读成机械臂。
 * - 越界夹在首/尾键上；没有轨道就写 0，调用方可以无脑叠加。
 */

export type ReloadPart = 'lever' | 'hammer' | 'cylinder'

export interface ReloadKey {
  /** 归一化进度 0..1。 */
  t: number
  /** 相对静止位的增量（弧度）。 */
  v: number
}

export interface ReloadTrack {
  part: ReloadPart
  keys: readonly ReloadKey[]
}

export interface ReloadTimeline {
  tracks: readonly ReloadTrack[]
}

/** 采样输出；调用方复用一个对象，避免每帧分配。 */
export interface ReloadPose {
  lever: number
  hammer: number
  cylinder: number
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

function sampleTrack(keys: readonly ReloadKey[], t: number): number {
  if (keys.length === 0) return 0
  const first = keys[0]!
  if (t <= first.t) return first.v
  const last = keys[keys.length - 1]!
  if (t >= last.t) return last.v
  let index = 0
  while (index < keys.length - 2 && keys[index + 1]!.t < t) index++
  const a = keys[index]!
  const b = keys[index + 1]!
  const span = b.t - a.t
  if (span <= 1e-9) return b.v
  return a.v + (b.v - a.v) * smoothstep01((t - a.t) / span)
}

/**
 * 采样整条时间轴。`out` 由调用方持有并复用；每次都先归零，所以没有
 * 轨道的武器拿到的就是三个 0，不需要额外的 if。
 */
export function sampleReloadTimeline(
  timeline: ReloadTimeline | undefined,
  phase: number,
  out: ReloadPose,
): ReloadPose {
  out.lever = 0
  out.hammer = 0
  out.cylinder = 0
  if (timeline === undefined) return out
  const t = phase < 0 ? 0 : phase > 1 ? 1 : phase
  const tracks = timeline.tracks
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!
    out[track.part] = sampleTrack(track.keys, t)
  }
  return out
}

/**
 * 杠杆步枪/卡宾：两次压杆。
 *
 * 第一次在 0.2 附近把空壳顶出来（杠杆向后），第二次在 0.78 附近把新弹
 * 推进膛（再压一次）—— 这是杠杆枪换弹最容易被认出来的两个动作。击锤
 * 在整个装填段保持半 cock，最后一拍才落回。
 */
export const LEVER_RELOAD: ReloadTimeline = {
  tracks: [
    {
      part: 'lever',
      keys: [
        { t: 0, v: 0 },
        { t: 0.12, v: 0 },
        { t: 0.2, v: -0.55 },
        { t: 0.3, v: 0 },
        { t: 0.7, v: 0 },
        { t: 0.78, v: -0.62 },
        { t: 0.88, v: 0 },
      ],
    },
    {
      part: 'hammer',
      keys: [
        { t: 0, v: 0 },
        { t: 0.1, v: -0.5 },
        { t: 0.72, v: -0.5 },
        { t: 0.8, v: 0.08 },
        { t: 0.88, v: 0 },
      ],
    },
  ],
}

/**
 * 双管：击锤先扳开，装填段保持，合枪时落回。
 *
 * 炮管折开由整枪姿态（reloadK 的 pitch/roll）承担：模型里的炮管是合并
 * 几何，没有独立铰链节点；这里只驱动确实存在的两只击锤。
 */
export const SHOTGUN_RELOAD: ReloadTimeline = {
  tracks: [
    {
      part: 'hammer',
      keys: [
        { t: 0, v: 0 },
        { t: 0.12, v: -0.6 },
        { t: 0.82, v: -0.6 },
        { t: 0.9, v: 0.1 },
        { t: 1, v: 0 },
      ],
    },
  ],
}

/**
 * 转轮：弹巢分三段转，装一发停一下。
 *
 * 终点用 2π 而不是 0：视觉上回到同一格，但 `cylinderTarget` 继续从
 * 2π 叠加射击时的 +60°，不会在换弹结束那一帧倒着转回去。
 */
export const REVOLVER_RELOAD: ReloadTimeline = {
  tracks: [
    {
      part: 'cylinder',
      keys: [
        { t: 0, v: 0 },
        { t: 0.12, v: 0 },
        { t: 0.3, v: Math.PI * 0.67 },
        { t: 0.44, v: Math.PI * 0.67 },
        { t: 0.62, v: Math.PI * 1.33 },
        { t: 0.76, v: Math.PI * 1.33 },
        { t: 0.9, v: Math.PI * 2 },
        { t: 1, v: Math.PI * 2 },
      ],
    },
    {
      part: 'hammer',
      keys: [
        { t: 0, v: 0 },
        { t: 0.08, v: -0.45 },
        { t: 0.9, v: -0.45 },
        { t: 0.96, v: 0.05 },
        { t: 1, v: 0 },
      ],
    },
  ],
}
