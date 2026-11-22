/**
 * 服务端档案的客户端缓存与购买入口。
 *
 * 权威在服务端：`/api/profile` 返回金币/已解锁天赋/已解锁配件/已付款补给；
 * localStorage 只做“服务端暂时连不上时大厅还能显示上次数值”的缓存。
 * 任何购买都走 `/api/profile/buy`，本地不再自行扣款。
 */

import { getProfileId } from './identity.ts'

export interface ProfileView {
  coins: number
  traitOwned: number
  attachmentOwned: number
  extrasOwned: number
}

const COIN_KEY = 'dk.coins'
const TRAIT_KEY = 'dk.traitOwned'
const ATTACH_KEY = 'dk.attachmentOwned'

function numberOr(value: string | null, fallback = 0): number {
  const n = value === null ? NaN : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function readCachedProfile(): ProfileView {
  try {
    return {
      coins: numberOr(localStorage.getItem(COIN_KEY)),
      traitOwned: numberOr(localStorage.getItem(TRAIT_KEY)) >>> 0,
      attachmentOwned: numberOr(localStorage.getItem(ATTACH_KEY)) >>> 0,
      extrasOwned: 0,
    }
  } catch {
    return { coins: 0, traitOwned: 0, attachmentOwned: 0, extrasOwned: 0 }
  }
}

export function cacheProfile(profile: ProfileView): void {
  try {
    localStorage.setItem(COIN_KEY, String(Math.max(0, Math.floor(profile.coins))))
    localStorage.setItem(TRAIT_KEY, String(profile.traitOwned >>> 0))
    localStorage.setItem(ATTACH_KEY, String(profile.attachmentOwned >>> 0))
  } catch {
    // 缓存失败不影响服务端权威；下次进大厅再拉。
  }
}

/**
 * 档案接口必须跟着页面挂载点走：开发在 `/`，宿主部署在 `/dead-kill/`。
 * 写死 `/api/profile` 会让线上请求打到宿主根路由（404），菜单只能退回缓存。
 */
function apiUrl(path: string): string {
  const base = location.pathname.replace(/[^/]*$/, '')
  return `${base}${path}`
}

export async function fetchProfile(): Promise<ProfileView | null> {
  try {
    const res = await fetch(apiUrl(`api/profile?profileId=${encodeURIComponent(getProfileId())}`), {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; profile?: ProfileView }
    if (!body.ok || !body.profile) return null
    const profile: ProfileView = {
      coins: Math.max(0, Math.floor(body.profile.coins ?? 0)),
      traitOwned: (body.profile.traitOwned ?? 0) >>> 0,
      attachmentOwned: (body.profile.attachmentOwned ?? 0) >>> 0,
      extrasOwned: (body.profile.extrasOwned ?? 0) & 3,
    }
    cacheProfile(profile)
    return profile
  } catch {
    return null
  }
}

export type BuyKind = 'trait' | 'attachment' | 'extras'

export async function buyProfile(
  kind: BuyKind,
  id: number,
): Promise<{ ok: true; profile: ProfileView; cost: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl('api/profile/buy'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: getProfileId(), kind, id }),
    })
    const body = (await res.json()) as {
      ok?: boolean
      cost?: number
      profile?: ProfileView
      error?: string
    }
    if (!res.ok || !body.ok || !body.profile) {
      return { ok: false, error: body.error ?? '购买失败' }
    }
    const profile: ProfileView = {
      coins: Math.max(0, Math.floor(body.profile.coins ?? 0)),
      traitOwned: (body.profile.traitOwned ?? 0) >>> 0,
      attachmentOwned: (body.profile.attachmentOwned ?? 0) >>> 0,
      extrasOwned: (body.profile.extrasOwned ?? 0) & 3,
    }
    cacheProfile(profile)
    return { ok: true, profile, cost: body.cost ?? 0 }
  } catch {
    return { ok: false, error: '无法连接服务器' }
  }
}
