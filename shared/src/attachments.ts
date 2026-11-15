/**
 * 武器配件：出击前给主武器装一件，整局生效。
 *
 * 为什么是"一件"而不是四槽：四槽等于四组数值相乘，平衡曲线会立刻失控；
 * 一件配件让玩家做的是**取舍**（要倍镜还是消音），而不是堆叠。
 *
 * 解锁用金币一次性买断（局外经济），之后每局免费选择。
 */

export const ATTACHMENT_NONE = 0
export const ATTACHMENT_SCOPE = 1
export const ATTACHMENT_SUPPRESSOR = 2
export const ATTACHMENT_EXTENDED = 3
export const ATTACHMENT_STOCK = 4

export type AttachmentKey = 'none' | 'scope' | 'suppressor' | 'extended' | 'stock'

export interface AttachmentSpec {
  id: number
  key: AttachmentKey
  name: string
  /** 解锁价格（金币）。0 = 默认拥有。 */
  cost: number
  /** 开镜倍率乘数。 */
  zoomScale: number
  /** 枪声传播/音量乘数（消音器）。 */
  soundScale: number
  /** 弹匣容量加成。 */
  magazineBonus: number
  /** 后坐力（视觉）乘数。 */
  recoilScale: number
  desc: string
}

export const ATTACHMENTS: readonly AttachmentSpec[] = [
  {
    id: ATTACHMENT_NONE,
    key: 'none',
    name: '不装',
    cost: 0,
    zoomScale: 1,
    soundScale: 1,
    magazineBonus: 0,
    recoilScale: 1,
    desc: '保持原厂状态。',
  },
  {
    id: ATTACHMENT_SCOPE,
    key: 'scope',
    name: '2× 镜',
    cost: 600,
    zoomScale: 1.35,
    soundScale: 1,
    magazineBonus: 0,
    recoilScale: 1,
    desc: '开镜视野再收 35%，远距离更好点，近战更难受。',
  },
  {
    id: ATTACHMENT_SUPPRESSOR,
    key: 'suppressor',
    name: '消音器',
    cost: 800,
    zoomScale: 1,
    soundScale: 0.45,
    magazineBonus: 0,
    recoilScale: 1,
    desc: '枪声传得更近。别人更难靠声音找你。',
  },
  {
    id: ATTACHMENT_EXTENDED,
    key: 'extended',
    name: '加长弹仓',
    cost: 500,
    zoomScale: 1,
    soundScale: 1,
    magazineBonus: 2,
    recoilScale: 1,
    desc: '弹匣容量 +2，少一次换弹就是多一条命。',
  },
  {
    id: ATTACHMENT_STOCK,
    key: 'stock',
    name: '加固枪托',
    cost: 400,
    zoomScale: 1,
    soundScale: 1,
    magazineBonus: 0,
    recoilScale: 0.8,
    desc: '后坐力视觉幅度降低 20%，连射更稳。',
  },
]

/**
 * 配件系统总开关。
 *
 * 现在先把旧的一件式配件整块收起来，准备重做成塔科夫式的多槽位系统
 * （规划见 `docs/武器配件系统-塔科夫式.md`）。关掉时：
 *  - `clampAttachment` 一律返回"不装"，服务端不会再算弹匣/声音/后坐加成；
 *  - `attachmentOf` 一律返回 0 号规格，客户端的倍率/音量/后坐全部回到 1；
 *  - 菜单不再画配件选择器，枪模上的镜筒/消音器外观也不显示。
 *
 * 协议字段（Loadout 里的 attachment）和 localStorage 键原样保留：重做时
 * 不用再动二进制协议，也不会把玩家已有的解锁记录抹掉。
 */
export const ATTACHMENTS_ENABLED = false

export function attachmentOf(id: number): AttachmentSpec {
  if (!ATTACHMENTS_ENABLED) return ATTACHMENTS[0]!
  return ATTACHMENTS[id] ?? ATTACHMENTS[0]!
}

export function clampAttachment(id: number): number {
  if (!ATTACHMENTS_ENABLED) return ATTACHMENT_NONE
  return Number.isFinite(id) && id >= 0 && id < ATTACHMENTS.length ? Math.floor(id) : ATTACHMENT_NONE
}
