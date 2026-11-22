/**
 * 本机档案 id：跨标签页、跨浏览器重启稳定的随机串。
 *
 * 它不是账号，也不承担安全职责；它的作用只是让开发模式的匿名玩家在关掉
 * 页面后还能拿回同一份服务端进度。生产环境由宿主 `authenticate` 的 userId
 * 覆盖它。
 */
const KEY = 'dk.profileId'

function makeId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid.replace(/-/g, '').slice(0, 24)
  } catch {
    // 非安全上下文/旧浏览器没有 randomUUID，退回时间 + 随机数。
  }
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  ).slice(0, 24)
}

/** 大厅好友码：与 menu.ts 的 `dk.friendCode` 同一个键，用于队伍成员校验。 */
export function getPartyCode(): string {
  try {
    const saved = localStorage.getItem('dk.friendCode')
    return saved && /^[a-z0-9-]{4,24}$/.test(saved) ? saved : ''
  } catch {
    return ''
  }
}

export function getProfileId(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && /^[a-z0-9_-]{4,64}$/.test(saved)) return saved
    const id = makeId()
    localStorage.setItem(KEY, id)
    return id
  } catch {
    // 隐私模式/localStorage 被禁：至少在同一次页面生命周期里稳定。
    return makeId()
  }
}
