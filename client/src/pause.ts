/**
 * 局内 Esc 暂停/退出层。
 *
 * 多人对局**不会真的暂停**：层上必须写清楚"游戏仍在继续"，否则玩家会以为
 * 自己安全了。它只提供"继续"和"放弃本局"两个出口；设置复用主菜单，不在
 * 这里重复一套滑条。
 */
export interface PauseOverlay {
  readonly visible: boolean
  show(): void
  hide(): void
  dispose(): void
}

export function createPauseOverlay(options: {
  onResume: () => void
  onQuit: () => void
}): PauseOverlay {
  const host = document.createElement('div')
  host.className = 'dk-pause'
  host.setAttribute('aria-hidden', 'true')

  const card = document.createElement('div')
  card.className = 'dk-pause__card'

  const title = document.createElement('div')
  title.className = 'dk-pause__title'
  title.textContent = '暂 停'
  const sub = document.createElement('div')
  sub.className = 'dk-pause__sub'
  sub.textContent = '多人对局不会暂停 · 你仍然暴露在危险里'
  const hint = document.createElement('div')
  hint.className = 'dk-pause__hint'
  hint.textContent = '按 Esc 继续 · 放弃本局会丢掉这一趟带出来的东西'

  const row = document.createElement('div')
  row.className = 'dk-pause__actions'
  const resume = document.createElement('button')
  resume.type = 'button'
  resume.className = 'dk-pause__btn dk-pause__btn--primary'
  resume.textContent = '继 续'
  resume.addEventListener('click', () => {
    hide()
    options.onResume()
  })
  const quit = document.createElement('button')
  quit.type = 'button'
  quit.className = 'dk-pause__btn'
  quit.textContent = '放 弃 本 局'
  quit.addEventListener('click', () => options.onQuit())
  row.append(resume, quit)

  card.append(title, sub, hint, row)
  host.append(card)
  document.body.append(host)

  let visible = false
  function show(): void {
    if (visible) return
    visible = true
    host.classList.add('is-on')
    resume.focus()
  }
  function hide(): void {
    if (!visible) return
    visible = false
    host.classList.remove('is-on')
  }
  function dispose(): void {
    hide()
    host.remove()
  }

  return {
    get visible(): boolean {
      return visible
    },
    show,
    hide,
    dispose,
  }
}
