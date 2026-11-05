/**
 * 同步事件总线。
 *
 * 只做最少的语义，够内核用就行：
 * - `on` 返回取消订阅函数，调用方不需要保存 handler 引用；
 * - 派发前复制订阅集合，允许 handler 在回调里退订；
 * - 单个 handler 抛错只记录，不中断其它订阅者 —— 一个音频节点参数写错，
 *   不该让整张快照的处理链停在那里。
 *
 * 事件负载是普通对象。跨系统只通过事件和公开 getter 通信，不要在 handler
 * 里反向 import 发送方。
 */

export type EventMap = Record<string, unknown>

/**
 * `M extends object` 而不是 `Record<string, unknown>`：事件表通常写成 interface
 * （`{ resize: {...} }`），它没有字符串索引签名，会被后者拒绝。运行时只按
 * `keyof M & string` 取键，所以 object 约束已经足够。
 */
export class EventBus<M extends object = EventMap> {
  private readonly handlers = new Map<keyof M & string, Set<(payload: never) => void>>()

  on<K extends keyof M & string>(type: K, handler: (payload: M[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as (payload: never) => void)
    return () => this.off(type, handler)
  }

  once<K extends keyof M & string>(type: K, handler: (payload: M[K]) => void): () => void {
    const off = this.on(type, (payload) => {
      off()
      handler(payload)
    })
    return off
  }

  off<K extends keyof M & string>(type: K, handler: (payload: M[K]) => void): void {
    this.handlers.get(type)?.delete(handler as (payload: never) => void)
  }

  emit<K extends keyof M & string>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type)
    if (set === undefined || set.size === 0) return
    // 复制一份再遍历：handler 里 on/off 是正常写法（比如一次性特效的清理）。
    const snapshot = [...set]
    for (const handler of snapshot) {
      try {
        ;(handler as (value: M[K]) => void)(payload)
      } catch (error) {
        console.error(`[events] "${type}" handler threw`, error)
      }
    }
  }

  /** 某个事件当前有多少订阅者。诊断面板用。 */
  count<K extends keyof M & string>(type: K): number {
    return this.handlers.get(type)?.size ?? 0
  }

  clear(): void {
    this.handlers.clear()
  }
}
