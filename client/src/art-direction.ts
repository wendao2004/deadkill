/**
 * 每张猎场的美术配置（色彩脚本 + 世界观字段）。
 *
 * 为什么把"画面参数"和"文案"放在同一张表里：它们描述的是同一件事 ——
 * 这一局是什么天气、什么情绪、玩家该有什么感觉。分开写就一定会漂：
 * 文案说在下雨，画面却是干净的月光；或者反过来，雾很重但简报说"天晴"。
 *
 * 雾的颜色与密度**不在这里**：那是关卡几何的一部分（`LevelDef.fogColor`），
 * 跟着地图数据走，改图的人应该顺手改雾。这里只管"同一张图的调色"。
 *
 * 参数含义：
 * - `exposure`：色调映射前的线性辐射度倍率。越开阔的图越亮。
 * - `grain`：胶片颗粒。跟"空气里有什么"有关 —— 粉尘 > 雾 > 干净。
 * - `vignette`：暗角。跟"退路多少"有关，退路越少的图越重。
 * - `chromatic`：四角色差，只在大暗角图上开一点点，模拟廉价镜头。
 * - `bloom`：泛光强度，火多的图略高。
 *
 * 调参验收：`node tools/qa-shot.mjs --url "…?map=<id>&shot=1"`，
 * 五张图应该是五个不同的"天气"，而不是同一张图换了个雾色。
 */

export interface ArtProfile {
  /** 情绪词，只用于文档与调试，不进 UI。 */
  mood: string
  /** 这张图的"尖"：40m 外能认出的地标，A4 阶段按它做资产。 */
  landmark: string
  /** 世界观：中文地名（首页环境行用）。 */
  place: string
  /** 世界观：括号里的洋名。 */
  placeEn: string
  /** 世界观：这一局是哪一天。 */
  date: string
  /** 世界观：天气。必须和雾/颗粒的观感对得上。 */
  weather: string
  /** 世界观：当天流传的一句话。不解释、不指向玩法。 */
  rumor: string
  exposure: number
  /**
   * 月光/天空补光/边缘光/环境光的整体倍率。
   *
   * 墓园的石碑是白石材，同样的月光会比其他图亮一整档；只压曝光会把
   * 雾和火光一起压死，所以单独给"光"一个每图旋钮。
   */
  lightScale: number
  bloom: number
  grain: number
  vignette: number
  chromatic: number
}

/**
 * 默认档 = 沼泽农舍。未登记的关卡（新图还没写 profile 时）落到这里，
 * 保证任何情况下都有可用参数，而不是渲染成一片死黑。
 */
const FALLBACK: ArtProfile = {
  mood: '贪婪',
  landmark: '半沉的谷仓尖顶',
  place: '沼泽农舍',
  placeEn: 'SUNKEN FARMSTEAD',
  date: '11 月 18 日',
  weather: '小雨转雾',
  rumor: '糖浆罐里结的不是糖。',
  exposure: 1.22,
  lightScale: 1,
  bloom: 0.07,
  grain: 0.014,
  vignette: 0.3,
  chromatic: 0.0007,
}

const PROFILES: Record<string, ArtProfile> = {
  'marsh-p0': FALLBACK,

  // 教堂：退路只有一条，暗角最重；浓雾 + 高颗粒，画面像被泡过。
  // 曝光压到 1.12 是刻意的 —— 这里的白来自石头和蜡，不来自天空。
  'chapel-night': {
    mood: '哀悼',
    landmark: '没有钟的钟楼',
    place: '空钟教堂',
    placeEn: 'CHAPEL OF HOLLOW BELLS',
    date: '11 月 21 日',
    weather: '浓雾，无风',
    rumor: '钟没人敲，但夜里有人数拍子。',
    exposure: 1.05,
    // 白石材 + 浓雾会把月光反射成一片白；墓园单独压到 0.62，只留轮廓与烛光。
    lightScale: 0.62,
    bloom: 0.075,
    grain: 0.02,
    vignette: 0.36,
    chromatic: 0.001,
  },

  // 采石场：粉尘把空气变成介质，颗粒拉满；曝光最高（开阔 + 灰白石头反光）。
  'quarry-dust': {
    mood: '窒息',
    landmark: '塌了一半的井架',
    place: '灰烬采坑',
    placeEn: 'ASHEN PIT',
    date: '11 月 24 日',
    weather: '浮尘',
    rumor: '坑底的水照不出你。',
    exposure: 1.3,
    lightScale: 1,
    bloom: 0.065,
    grain: 0.024,
    vignette: 0.24,
    chromatic: 0.0006,
  },

  // 车站：冷蓝 + 唯一一盏黄灯，是全项目"橙只属于活物"的最佳示范。
  'station-dusk': {
    mood: '等待',
    landmark: '还能看见的月台雨棚',
    place: '沉轨站',
    placeEn: 'DROWNED SIDING',
    date: '11 月 27 日',
    weather: '细雨',
    rumor: '末班车三年前就开走了，月台上还有人排队。',
    exposure: 1.18,
    lightScale: 1,
    bloom: 0.08,
    grain: 0.012,
    vignette: 0.34,
    chromatic: 0.0008,
  },

  // 松林：黑绿 + 篝火。火多所以 bloom 最高，但整体仍是所有图里最暗的一档。
  'pine-camp-night': {
    mood: '围困',
    landmark: '烧过又立起来的水塔',
    place: '松木营地',
    placeEn: 'PINEWOOD CAMP',
    date: '11 月 30 日',
    weather: '霜',
    rumor: '树桩上的年轮，比砍它的人记得更多。',
    exposure: 1.16,
    lightScale: 0.95,
    bloom: 0.09,
    grain: 0.018,
    vignette: 0.32,
    chromatic: 0.0007,
  },
}

/** 按关卡 id 取美术配置；未登记的关卡回落到默认档。 */
export function artProfile(levelId: string | null | undefined): ArtProfile {
  if (!levelId) return FALLBACK
  return PROFILES[levelId] ?? FALLBACK
}

/**
 * 首页环境行："盐线沼泽 · 1890 年 11 月 18 日 · 小雨转雾"。
 *
 * 首页还没有选定地图，用默认档的日期与天气 —— 它代表"你在这间屋子里的今天"，
 * 而不是某张图。图里的天气在出击标题卡上再报一次。
 */
export const SALT_LINE = '盐线沼泽'

export function worldLine(levelId?: string | null): string {
  const profile = artProfile(levelId)
  return `${SALT_LINE} · 1890 年 ${profile.date} · ${profile.weather}`
}

/** 出击标题卡的第二行："11 月 18 日 · 小雨转雾 · 合同：清剿"。 */
export function deployBrief(levelId: string, contractName: string | null): string {
  const profile = artProfile(levelId)
  const parts = [profile.date, profile.weather]
  if (contractName) parts.push(`合同：${contractName}`)
  return parts.join(' · ')
}
