/**
 * 线索文本与"解语"。
 *
 * 三条线索不是三个进度条，是三段能读的东西：每条给一个字，集齐之后拼成
 * 一句只有这一局的人才看得懂的话。文本按关卡分开，因为同一个字放在教堂
 * 和放在采石场应该是两种意思。
 *
 * 这里只放文本，不放任何判定：谁能读、读多久、读到第几条全在服务端。
 * 客户端拿 objective.clueMask 的位决定弹哪一段，所以**不需要新协议字节**。
 */
export interface ClueLore {
  /** 文献卡标题。 */
  title: string
  /** 正文，一到两句话。 */
  body: string
  /** 这条线索给出的字，集齐后拼成解语。 */
  glyph: string
}

export interface SealLore {
  title: string
  body: string
  /** 三条线索拼出来的那句话。 */
  word: string
}

export interface LevelLore {
  clues: readonly [ClueLore, ClueLore, ClueLore]
  seal: SealLore
}

export const LORE: Record<string, LevelLore> = {
  'marsh-p0': {
    clues: [
      {
        title: '浸水的账本',
        body: '最后一笔账：三车谷物换一箱"药"，收货人只按了一个墨点。页脚被人反复描过一个字 —— 「沉」。',
        glyph: '沉',
      },
      {
        title: '墓园木牌',
        body: '新坟一共十一个，木牌上都没有名字，只钉着一小截人骨。雨水泡开的墨迹里能认出「骨」。',
        glyph: '骨',
      },
      {
        title: '锅炉房的灰',
        body: '炉膛里没烧完的是衣物，不是柴。铁钩上挂着一张字条：「别埋，烧。」落款处只剩「于火」两个字。',
        glyph: '火',
      },
    ],
    seal: {
      title: '解语 · 沉骨于火',
      body: '沉骨于火 —— 十一个不是埋的，是烧的。血巢就在锅炉房底下，那东西靠的不是尸体，是灰。',
      word: '沉骨于火',
    },
  },
  'chapel-night': {
    clues: [
      {
        title: '祭坛下的血书',
        body: '有人在祭坛石缝里塞了一张纸，字是用血按出来的：「我们不是被咬的。」末尾一笔拖得很长，是个「血」。',
        glyph: '血',
      },
      {
        title: '钟楼的誓词',
        body: '撞钟绳上系着一张誓词，签名栏整齐地空着。空着不是没人签，是签的人不敢留名 —— 旁边写着「誓」。',
        glyph: '誓',
      },
      {
        title: '烛台的蜡泪',
        body: '九根蜡烛全烧到了底，只有第十根是新的，烛身上刻着一个「烛」。它今天被人点过。',
        glyph: '烛',
      },
    ],
    seal: {
      title: '解语 · 血誓烛',
      body: '血誓烛 —— 这不是弥撒，是一场自愿的仪式。第十根蜡烛的位置就是血巢，而点烛的人还在这座教堂里。',
      word: '血誓烛',
    },
  },
  'quarry-dust': {
    clues: [
      {
        title: '爆破员的笔记',
        body: '最后一页写着「第七层不能炸」，笔迹越写越轻。页边用凿子刻了一个「石」。',
        glyph: '石',
      },
      {
        title: '工头的眼罩',
        body: '眼罩内侧缝着一小片玻璃，玻璃背面磨出了一个「眼」。他们不是在采石头，是在找什么。',
        glyph: '眼',
      },
      {
        title: '井口的绳',
        body: '绳子放到 40 米就不再往下放，绳结上绑着一个铜牌，牌上是「深」。往上拉的人回来说绳子变重了。',
        glyph: '深',
      },
    ],
    seal: {
      title: '解语 · 石眼之下',
      body: '石眼之下 —— 采石场挖开的不是矿脉，是一只闭着的眼。血巢在第七层，那层他们不敢炸。',
      word: '石眼之下',
    },
  },
  'station-dusk': {
    clues: [
      {
        title: '停摆的站钟',
        body: '钟停在 19:47，指针被人掰弯成「末」字的形状。站台上没有行李，只有一排向外走的脚印。',
        glyph: '末',
      },
      {
        title: '车长的值勤表',
        body: '最后一班车的编号被涂掉了，只剩下「班」。备注栏写着：车上没有乘客，只有货。',
        glyph: '班',
      },
      {
        title: '行李房的锁',
        body: '锁是从里面锁上的。铁皮上用钉子一点点刻出一个「车」，刻完最后一笔就停了。',
        glyph: '车',
      },
    ],
    seal: {
      title: '解语 · 末班车',
      body: '末班车 —— 19:47 那趟车没有开走，它停在了货场底下。血巢就是那个车厢，门上还挂着昨夜的锁。',
      word: '末班车',
    },
  },
}

/** 未知关卡回落到沼泽的文本，宁可给错的年代感也不要让文献卡空白。 */
export function loreOf(levelId: string): LevelLore {
  return LORE[levelId] ?? LORE['marsh-p0']
}
