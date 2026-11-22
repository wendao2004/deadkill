/**
 * 服务端账号档案：金币、已解锁天赋/配件、已付款随身补给。
 *
 * 为什么必须存在：客户端 localStorage 可以是任意字符串。只要 Loadout 还信
 * 客户端的天赋/配件，改 F12 就能带满级三天赋进 PvP；撤离金币也只在客户端
 * 结算，刷新就丢、作弊客户端可自写。这份档案是唯一账本，客户端只做显示缓存。
 *
 * 存储用同步 JSON 文件而不是数据库：当前部署是单进程、512MB 容器、几十个
 * 玩家；一个 20KB 的文件比引入 SQLite 更稳。写入走临时文件 + rename，避免
 * 进程在写一半时被容器杀掉留下半个 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  EXTRAS_COST_AMMO,
  EXTRAS_COST_BANDAGE,
  STARTING_COINS,
  TRAITS,
  TRAIT_MAX_LEVEL,
  setTraitLevel,
  traitLevel,
  traitUpgradeCost,
  attachmentBit,
  attachmentById,
} from '@dk/shared'

export interface Profile {
  id: string
  coins: number
  /** 每 2 bit 一条天赋的已拥有等级（与客户端 packSelection 同一编码）。 */
  traitOwned: number
  /** 按 WEAPON_ATTACHMENTS 下标的位图。 */
  attachmentOwned: number
  /** 已付款、尚未在某一局领取的随身补给：bit1 绷带，bit2 备弹。 */
  extrasOwned: number
  updatedAt: number
}

export interface ProfileView {
  coins: number
  traitOwned: number
  attachmentOwned: number
  extrasOwned: number
}

export type BuyResult =
  | { ok: true; profile: Profile; cost: number }
  | { ok: false; profile: Profile; error: string }

const MAX_COINS = 9_999_999
const MAX_PROFILES = 512

function defaultPath(): string {
  return resolve(process.cwd(), '.data', 'profiles.json')
}

/**
 * 档案键：允许字母数字、下划线、点、冒号、@、短横线；其它字符（宿主可能
 * 用 `/`、`|` 拼复合 userId）用 FNV-1a 折成稳定的 `h_xxxx`。
 *
 * 不能简单拒绝非法 id：生产环境的 userId 是宿主给的，可能带 `@` 或 `:`；
 * 拒绝会让所有用户共用一个 `anon` 档案。也不能直接当文件名/URL 用，
 * 这里是内存/JSON 键，折叠只是为了“同一账号永远得到同一个键”。
 */
export function sanitizeProfileId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const id = raw.trim()
  if (!id) return ''
  if (/^[a-zA-Z0-9_.:@-]{1,128}$/.test(id)) return id
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `h_${(hash >>> 0).toString(36)}`
}

export class ProfileStore {
  private readonly profiles = new Map<string, Profile>()
  private readonly path: string | null
  private dirty = false

  constructor(path: string | null = defaultPath()) {
    this.path = path
    this.load()
  }

  get(id: string): Profile {
    const key = sanitizeProfileId(id) || 'anon'
    const existing = this.profiles.get(key)
    if (existing) return existing

    // 上限保护：恶意客户端可以不停换 profileId；宁可回落到 anon，也不让
    // 一个 512MB 容器被几十万个档案撑爆，更不要让每次请求都落一次盘。
    if (this.profiles.size >= MAX_PROFILES) {
      const fallback = this.profiles.get('anon')
      if (fallback) return fallback
      const anon = this.createProfile('anon')
      this.profiles.set('anon', anon)
      this.dirty = true
      this.save()
      return anon
    }

    const profile = this.createProfile(key)
    this.profiles.set(key, profile)
    this.dirty = true
    this.save()
    return profile
  }

  private createProfile(id: string): Profile {
    return {
      id,
      coins: STARTING_COINS,
      traitOwned: 0,
      attachmentOwned: 0,
      extrasOwned: 0,
      updatedAt: Date.now(),
    }
  }

  view(id: string): ProfileView {
    const p = this.get(id)
    return {
      coins: p.coins,
      traitOwned: p.traitOwned,
      attachmentOwned: p.attachmentOwned,
      extrasOwned: p.extrasOwned,
    }
  }

  buyTrait(id: string, bit: number): BuyResult {
    const p = this.get(id)
    if (!TRAITS.some((spec) => spec.bit === bit)) {
      return { ok: false, profile: p, error: '未知天赋' }
    }
    const level = traitLevel(p.traitOwned, bit)
    if (level >= TRAIT_MAX_LEVEL) return { ok: false, profile: p, error: '已满级' }
    const cost = traitUpgradeCost(level)
    if (cost <= 0) return { ok: false, profile: p, error: '不可升级' }
    if (p.coins < cost) return { ok: false, profile: p, error: `金币不足（需要 $${cost}）` }
    p.coins -= cost
    p.traitOwned = setTraitLevel(p.traitOwned, bit, level + 1)
    p.updatedAt = Date.now()
    this.dirty = true
    this.save()
    return { ok: true, profile: p, cost }
  }

  buyAttachment(id: string, attachmentId: number): BuyResult {
    const p = this.get(id)
    const spec = attachmentById(attachmentId)
    if (!spec) return { ok: false, profile: p, error: '未知配件' }
    const bit = attachmentBit(attachmentId)
    if (bit === 0) return { ok: false, profile: p, error: '未知配件' }
    if (spec.cost <= 0 || (p.attachmentOwned & bit) !== 0) {
      return { ok: true, profile: p, cost: 0 }
    }
    if (p.coins < spec.cost) return { ok: false, profile: p, error: `金币不足（需要 $${spec.cost}）` }
    p.coins -= spec.cost
    p.attachmentOwned = (p.attachmentOwned | bit) >>> 0
    p.updatedAt = Date.now()
    this.dirty = true
    this.save()
    return { ok: true, profile: p, cost: spec.cost }
  }

  buyExtras(id: string, bit: number): BuyResult {
    const p = this.get(id)
    const cost = bit === 1 ? EXTRAS_COST_BANDAGE : bit === 2 ? EXTRAS_COST_AMMO : 0
    if (cost <= 0) return { ok: false, profile: p, error: '未知补给' }
    if ((p.extrasOwned & bit) !== 0) return { ok: true, profile: p, cost: 0 }
    if (p.coins < cost) return { ok: false, profile: p, error: `金币不足（需要 $${cost}）` }
    p.coins -= cost
    p.extrasOwned |= bit
    p.updatedAt = Date.now()
    this.dirty = true
    this.save()
    return { ok: true, profile: p, cost }
  }

  /**
   * 领取已付款的随身补给：只发客户端这次选中的位，发完即清。
   *
   * 不清的话同一份补给会在每次 Loadout/重连时重复发放；全清又会把玩家
   * 买了但这次没选的补给吞掉。按交集清是最小惊讶。
   */
  consumeExtras(id: string, selectedMask: number): number {
    const p = this.get(id)
    const granted = p.extrasOwned & selectedMask & 0b11
    if (granted === 0) return 0
    p.extrasOwned &= ~granted
    p.updatedAt = Date.now()
    this.dirty = true
    this.save()
    return granted
  }

  settle(id: string, earned: number): Profile {
    const p = this.get(id)
    const gain = Math.max(0, Math.min(MAX_COINS, Math.round(earned)))
    p.coins = Math.min(MAX_COINS, p.coins + gain)
    p.updatedAt = Date.now()
    this.dirty = true
    this.save()
    return p
  }

  /** 测试/诊断：当前档案数。 */
  get size(): number {
    return this.profiles.size
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { profiles?: Profile[] }
      for (const profile of raw.profiles ?? []) {
        const id = sanitizeProfileId(profile.id)
        if (!id) continue
        this.profiles.set(id, {
          id,
          coins: Math.max(0, Math.min(MAX_COINS, Math.round(profile.coins ?? STARTING_COINS))),
          traitOwned: (profile.traitOwned ?? 0) >>> 0,
          attachmentOwned: (profile.attachmentOwned ?? 0) >>> 0,
          extrasOwned: (profile.extrasOwned ?? 0) & 0b11,
          updatedAt: profile.updatedAt ?? Date.now(),
        })
      }
    } catch {
      // 损坏的档案文件不阻塞服务启动：从空档案开始，玩家最多丢一次本地进度。
      this.profiles.clear()
    }
  }

  private save(): void {
    if (!this.path || !this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      const payload = JSON.stringify({ version: 1, profiles: [...this.profiles.values()] })
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, this.path)
    } catch (error) {
      // 落盘失败不该把一局游戏打断；内存账本仍然有效，下一次写入会再试。
      console.warn('[profile] 档案落盘失败', error)
      this.dirty = true
    }
  }
}
