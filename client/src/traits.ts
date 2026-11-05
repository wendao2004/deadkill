/**
 * 天赋徽记：一套"会动"的 SVG 图标，大厅和局内 HUD 共用。
 *
 * ## 为什么是 SVG 而不是图片
 * 图标要跟着锁血/开枪这类事件变亮变快，位图只能换帧；SVG 一条 CSS 动画就能让
 * 所有徽记按同一节奏呼吸，还能在超采样屏上保持墨线锐利。
 *
 * ## 为什么动效写在 CSS 而不是这里
 * 动画只跟"哪个图层"有关（描线 / 呼吸 / 脉冲），跟具体是哪个天赋无关。写在
 * traits.css 里，六个天赋自动共享同一套节奏；这里只负责画出形状并给图层命名。
 */

import { Trait } from '@dk/shared'

import './traits.css'

/** 图层的名字就是动效的名字，见 client/src/traits.css。 */
const LAYER_DRAW = 'tk-a'
const LAYER_BREATH = 'tk-b'
const LAYER_PULSE = 'tk-c'

/**
 * 每个天赋的墨线形状（48×48 坐标系）。
 *
 * 统一"两笔主体 + 一个点睛"：主体细描线，点睛是实心小圆或短线 —— 和游戏里
 * 那套漫画墨线（粗黑边 + 硬阴影）放一起不会显得像另一个游戏的 UI。
 */
const GLYPHS: Record<number, string> = {
  // 百臂巨人：一圈向外张开的弧（手臂）+ 中心实心点（身体）。
  [Trait.HundredHands]: `
    <path class="${LAYER_DRAW}" d="M8 30a16 16 0 0 1 32 0"/>
    <path class="${LAYER_BREATH}" d="M14 30a10 10 0 0 1 20 0"/>
    <path class="${LAYER_DRAW}" d="M24 14V6M12 20l-6-4M36 20l6-4"/>
    <circle class="${LAYER_PULSE}" cx="24" cy="34" r="4"/>`,
  // 左右开工：两支对峙的枪（左右各一条折线）+ 中间的点。
  [Trait.Ambidextrous]: `
    <path class="${LAYER_DRAW}" d="M6 30h13v-7h-5"/>
    <path class="${LAYER_DRAW}" d="M42 18H29v7h5"/>
    <path class="${LAYER_BREATH}" d="M20 24h8"/>
    <circle class="${LAYER_PULSE}" cx="24" cy="24" r="3"/>`,
  // 铁腕：准星 + 向内收紧的环。
  [Trait.IronGrip]: `
    <path class="${LAYER_DRAW}" d="M24 6v8M24 34v8M6 24h8M34 24h8"/>
    <circle class="${LAYER_BREATH}" cx="24" cy="24" r="11"/>
    <circle class="${LAYER_PULSE}" cx="24" cy="24" r="4.5"/>`,
  // 硬皮：盾牌轮廓 + 两道斜纹。
  [Trait.Bulwark]: `
    <path class="${LAYER_DRAW}" d="M24 6l14 6v12c0 9-6 15-14 18-8-3-14-9-14-18V12z"/>
    <path class="${LAYER_BREATH}" d="M17 20l14 10M31 20L17 30"/>
    <circle class="${LAYER_PULSE}" cx="24" cy="25" r="3"/>`,
  // 快手：表盘 + 转动的指针 + 外圈的速度弧。
  [Trait.QuickHand]: `
    <circle class="${LAYER_DRAW}" cx="24" cy="24" r="13"/>
    <path class="tk-hand" d="M24 24V15M24 24l7 5"/>
    <path class="${LAYER_BREATH}" d="M24 6a18 18 0 0 1 12 5"/>`,
  // 拾荒者：钱币 + 中间的 S 形铸纹。
  [Trait.Scavenger]: `
    <circle class="${LAYER_DRAW}" cx="24" cy="24" r="14"/>
    <path class="${LAYER_BREATH}" d="M30 17c-2-2-10-2-11 2-1 5 12 3 11 8-1 4-9 4-11 1"/>
    <circle class="${LAYER_PULSE}" cx="24" cy="24" r="2.4"/>`,
  // 强健：心形轮廓 + 心跳折线（常驻大血量的天赋，形状就是血量本身）。
  [Trait.Vigor]: `
    <path class="${LAYER_DRAW}" d="M24 40S8 31 8 20a9 9 0 0 1 16-5 9 9 0 0 1 16 5c0 11-16 20-16 20z"/>
    <path class="${LAYER_PULSE}" d="M11 24h6l3-5 4 10 3-5h6"/>`,
  // 处刑者：断头台斜刃 + 落下的重力线（处决残血的意象）。
  [Trait.Executioner]: `
    <path class="${LAYER_DRAW}" d="M10 12h20M10 12v16h20V12"/>
    <path class="${LAYER_BREATH}" d="M30 34l12-12"/>
    <path class="${LAYER_DRAW}" d="M18 40V26M24 40V30"/>
    <circle class="${LAYER_PULSE}" cx="36" cy="34" r="3"/>`,
  // 铁石心肠：山形轮廓 + 底部一道冷线（挨打不掉那么多，像石头一样）。
  [Trait.Stoic]: `
    <path class="${LAYER_DRAW}" d="M6 36l10-16 7 9 6-12 9 19z"/>
    <path class="${LAYER_BREATH}" d="M6 42h36"/>
    <circle class="${LAYER_PULSE}" cx="16" cy="20" r="2.6"/>`,
  // 食腐者：乌鸦剪影 + 一根露出的骨头（打死怪才回血的那条天赋）。
  [Trait.Carrion]: `
    <path class="${LAYER_DRAW}" d="M8 34l8-8 10-2 6 6-8 4z"/>
    <path class="${LAYER_BREATH}" d="M24 24l10-8 6 2"/>
    <path class="${LAYER_DRAW}" d="M28 40l8-6M36 40l-8-6"/>
    <circle class="${LAYER_PULSE}" cx="14" cy="30" r="2.4"/>`,
}

/** 浅色（大厅卡片/HUD 亮态）与深色都用 currentColor，所以不设 fill/stroke 颜色。 */
export function traitGlyph(bit: number): string {
  const body = GLYPHS[bit] ?? GLYPHS[Trait.HundredHands]!
  return `<svg viewBox="0 0 48 48" role="presentation" focusable="false">${body}</svg>`
}

/**
 * 造一个徽记元素。size > 0 时把像素尺寸直接写在 style 上：
 * HUD 与大厅的尺寸不同，靠 class 各写一份会分裂成两套动效。
 */
export function createTraitIcon(bit: number, size = 0, level = 0): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'dk-trait-icon'
  span.dataset.traitBit = String(bit)
  span.innerHTML = traitGlyph(bit)
  if (size > 0) {
    span.style.width = `${size}px`
    span.style.height = `${size}px`
  }
  // 等级用一排小方块而不是数字：HUD 上徽记只有 26px，写 "Lv.3" 会糊成一团。
  if (level > 0) {
    span.dataset.level = String(level)
    for (let i = 0; i < level; i++) {
      const pip = document.createElement('i')
      pip.className = 'dk-trait-pip'
      span.append(pip)
    }
  }
  return span
}
