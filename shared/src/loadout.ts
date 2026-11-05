/**
 * 槽位、弹药与切枪计时：**两端必须一致的规则，所以放在 shared**。
 *
 * 为什么不是"服务端自己记一个 currentSlot 就完了"：客户端要预测
 * "我现在按左键会不会开火"（否则切枪时按左键会先播枪口火光、再被服务端的
 * 快照打回来），还要在 HUD 上画切枪进度条、在近战范围里画提示。这些判断
 * 必须和判定用的是同一份数字，否则玩家看到的就是"能开火却不开火"。
 *
 * 这里只放纯函数与状态形状，不碰物理世界、不碰 socket —— 服务端 World 持有
 * 一个 LoadoutState，测试也可以直接构造一个来验证规则。
 */

import {
  DEFAULT_WEAPON_ID,
  DEFAULT_SLOT_ORDER,
  TICK_MS,
  WEAPONS,
  weaponForSlot,
  type WeaponSpec,
} from './constants.ts'

/** 一个玩家的装备状态。服务端权威，客户端拿快照里的 slot/flags 复现同一套判断。 */
export interface LoadoutState {
  /** 玩家选定的主武器 id（副武器与刀走默认配装）。 */
  primaryId: number
  /** 当前举在手里的槽位。 */
  currentSlot: number
  /** 每个槽位还剩多少发。近战槽恒为 0：**近战不消耗弹药**。 */
  ammoBySlot: number[]
  /** 每个槽位的备弹（弹匣外）。换弹从这里扣，刀恒为 0。 */
  reserveBySlot: number[]
  /** 举枪完成的 tick；在这之前开火与换弹都会被拒绝。 */
  switchDoneTick: number
  /** 上一次开火的 tick。 */
  lastFireTick: number
}

/** 一套全新的配装（出生、重生都用它）。 */
export function createLoadout(primaryId: number = DEFAULT_WEAPON_ID): LoadoutState {
  return {
    primaryId,
    currentSlot: 0,
    ammoBySlot: filledAmmo(primaryId),
    reserveBySlot: filledReserve(primaryId),
    switchDoneTick: 0,
    // 必须显式设成"很久以前"，不能用 0：射速判定是
    // `tick - lastFireTick >= fireIntervalMs/TICK_MS`，用 0 等于让每个新玩家
    // 开局白等一整个射击间隔（温菲尔德 0.9 秒）才能打出第一枪 —— 出生就
    // 遇敌时表现为"按了左键没反应"。
    lastFireTick: -1e9,
  }
}

/** 每个槽位满弹时的弹药表。 */
export function filledAmmo(primaryId: number): number[] {
  return DEFAULT_SLOT_ORDER.map((_, slot) => WEAPONS[weaponForSlot(primaryId, slot)]!.magazine)
}

/** 每个槽位出生时的备弹表；刀没有备弹。 */
export function filledReserve(primaryId: number): number[] {
  return DEFAULT_SLOT_ORDER.map((_, slot) => {
    const spec = WEAPONS[weaponForSlot(primaryId, slot)]!
    if (spec.kind === 'knife') return 0
    return spec.reserve ?? spec.magazine * 4
  })
}

/** 槽位对应的武器 id。 */
export function slotWeaponId(state: LoadoutState, slot: number): number {
  return weaponForSlot(state.primaryId, slot)
}

/** 当前手上的武器。 */
export function heldWeapon(state: LoadoutState): WeaponSpec {
  return WEAPONS[slotWeaponId(state, state.currentSlot)]!
}

/** 当前手上的弹药。近战返回 0，调用方不该据此拦下挥砍（见 canFire）。 */
export function heldAmmo(state: LoadoutState): number {
  return state.ammoBySlot[state.currentSlot] ?? 0
}

export function isKnife(spec: WeaponSpec): boolean {
  return spec.kind === 'knife'
}

/**
 * 切到这把武器需要多少 tick。ceil 而不是 round：宁可多等半个 tick 也不让切枪白给。
 *
 * scale 是天赋倍率（左右开工 0.6）：乘在毫秒上再向上取整，所以"快 40%"在
 * 6 tick 的切枪上是 10→6，不会因为先取整而白送或白扣。
 */
export function switchTicks(spec: WeaponSpec, scale = 1): number {
  return Math.ceil((spec.switchMs * scale) / TICK_MS)
}

/** 切枪动作是否还没做完。快照里的 Switching 位与"能不能开火"都看它。 */
export function isSwitching(state: LoadoutState, tick: number): boolean {
  return tick < state.switchDoneTick
}

/**
 * 请求切槽，返回这次切枪是否被接受。
 *
 * currentSlot 立刻生效（服务端从这一刻起就按新武器的判定结算），只有"举好"
 * 要等到 switchDoneTick。这样连点两个槽只会停在最后按的那个，不会排队做两段
 * 动画——排队会让玩家觉得"我按了 3 还没切完"。
 */
export function requestSwitch(
  state: LoadoutState,
  slot: number,
  tick: number,
  switchScale = 1,
): boolean {
  if (slot !== 0 && slot !== 1 && slot !== 2) return false
  if (slot === state.currentSlot) return false
  state.currentSlot = slot
  state.switchDoneTick = tick + switchTicks(heldWeapon(state), switchScale)
  return true
}

/**
 * 这一 tick 能不能开火（换弹由调用方另算，那是另一套计时器）。
 *
 * 三个条件缺一不可：枪已举好、射速间隔已过、这个槽位还有弹。刀不参与弹药
 * 判断，否则 magazine 0 会让它永远挥不出去。
 */
export function canFire(state: LoadoutState, tick: number, intervalScale = 1): boolean {
  if (isSwitching(state, tick)) return false
  const spec = heldWeapon(state)
  if (tick - state.lastFireTick < (spec.fireIntervalMs * intervalScale) / TICK_MS) return false
  if (isKnife(spec)) return true
  return heldAmmo(state) > 0
}

/** 消耗一发。近战刀不消耗任何东西。 */
export function consumeAmmo(state: LoadoutState): void {
  if (isKnife(heldWeapon(state))) return
  state.ammoBySlot[state.currentSlot] = Math.max(0, heldAmmo(state) - 1)
}

/**
 * 换弹完成：从当前槽位的备弹里补满弹匣。
 *
 * 没有备弹时什么都不做；调用方应该先用 canReload() 拦住。返回实际装进去的
 * 发数，方便服务端/HUD 判断是否真的补了。
 */
export function refillSlot(state: LoadoutState): number {
  const slot = state.currentSlot
  const spec = heldWeapon(state)
  if (isKnife(spec)) return 0
  const current = state.ammoBySlot[slot] ?? 0
  const reserve = state.reserveBySlot[slot] ?? 0
  const take = Math.min(Math.max(0, spec.magazine - current), reserve)
  state.ammoBySlot[slot] = current + take
  state.reserveBySlot[slot] = reserve - take
  return take
}

/** 这个槽位现在能不能开始换弹（刀/满弹/没备弹都不行）。 */
export function canReload(state: LoadoutState): boolean {
  const spec = heldWeapon(state)
  if (isKnife(spec)) return false
  const current = state.ammoBySlot[state.currentSlot] ?? 0
  const reserve = state.reserveBySlot[state.currentSlot] ?? 0
  return current < spec.magazine && reserve > 0
}

/** 捡到弹药：按"一个弹匣"往当前槽位备弹里加。 */
export function addReserve(state: LoadoutState, rounds: number): void {
  const spec = heldWeapon(state)
  if (isKnife(spec) || rounds <= 0) return
  state.reserveBySlot[state.currentSlot] = (state.reserveBySlot[state.currentSlot] ?? 0) + rounds
}

/** 重生：回到主武器并补满所有槽位 —— 上一命打空的弹匣不该跨命继承。 */
export function resetLoadout(state: LoadoutState): void {
  state.currentSlot = 0
  state.switchDoneTick = 0
  state.ammoBySlot = filledAmmo(state.primaryId)
  state.reserveBySlot = filledReserve(state.primaryId)
}
