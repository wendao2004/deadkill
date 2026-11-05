import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径导入：仓库根 node_modules 下没有 @dk/* 的 workspace 链接。
import {
  clamp,
  dequantizeAngle,
  lookDirection,
  quantizeAngle,
  vecCross,
  vecDot,
  vecLength,
  vecNormalize,
  vecNormalizeXZ,
  wrapAngle,
  yawToForward,
  yawToRight,
  type Vec3,
} from '../shared/src/index.ts'

const UP: Vec3 = { x: 0, y: 1, z: 0 }

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, label + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual)
}

function assertVecClose(actual: Vec3, expected: Vec3, tolerance: number, label: string): void {
  assertClose(actual.x, expected.x, tolerance, label + '.x')
  assertClose(actual.y, expected.y, tolerance, label + '.y')
  assertClose(actual.z, expected.z, tolerance, label + '.z')
}

test('vecNormalizeXZ: 零向量返回零向量，不是 NaN', () => {
  // 这个位置一旦出 NaN，会顺着速度 -> 位置 -> 命中判定一路污染下去，
  // 且症状是"角色消失了"而不是报错。必须显式钉死。
  const zero = vecNormalizeXZ({ x: 0, y: 0, z: 0 })
  assert.deepEqual(zero, { x: 0, y: 0, z: 0 })
  assert.ok(!Object.values(zero).some((component) => Number.isNaN(component)))
  assert.ok(Object.values(zero).every((component) => Object.is(component, 0)))

  // 只有 y 有值也算水平零向量（y 不参与 XZ 归一化）。
  assert.deepEqual(vecNormalizeXZ({ x: 0, y: 5, z: 0 }), { x: 0, y: 0, z: 0 })
  // 低于 1e-6 的极短向量同样走零分支，避免放大成噪声。
  assert.deepEqual(vecNormalizeXZ({ x: 1e-9, y: 0, z: -1e-9 }), { x: 0, y: 0, z: 0 })
})

test('vecNormalizeXZ: 归一化后水平长度为 1 且 y 恒为 0', () => {
  for (const source of [{ x: 3, y: 9, z: 4 }, { x: -7, y: 0, z: 0 }, { x: 0, y: 1, z: 2.5 }]) {
    const normalized = vecNormalizeXZ(source)
    assert.equal(normalized.y, 0)
    assertClose(Math.hypot(normalized.x, normalized.z), 1, 1e-12, 'length')
  }
})

test('vecNormalize: 零向量同样返回零向量', () => {
  assert.deepEqual(vecNormalize({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 })
  assertClose(vecLength(vecNormalize({ x: 1, y: 2, z: 3 })), 1, 1e-12, 'length')
})

test('yawToForward / yawToRight 构成水平面上的正交单位基', () => {
  for (const yaw of [-Math.PI, -2.1, -0.3, 0, 0.001, 0.9, Math.PI / 2, 3.0]) {
    const forward = yawToForward(yaw)
    const right = yawToRight(yaw)

    assert.equal(forward.y, 0, 'forward.y @' + yaw)
    assert.equal(right.y, 0, 'right.y @' + yaw)
    assertClose(vecLength(forward), 1, 1e-12, '|forward| @' + yaw)
    assertClose(vecLength(right), 1, 1e-12, '|right| @' + yaw)
    assertClose(vecDot(forward, right), 0, 1e-12, 'forward·right @' + yaw)
    // 顺序不能反：这组基满足 right x forward = +Y（等价于 right = forward x up）。
    // 手性反了的话 yaw=0 时右方会变成 -X，玩家左右移动会镜像。
    assertVecClose(vecCross(right, forward), UP, 1e-12, 'right x forward @' + yaw)
  }
})

test('yawToRight 是 forward 绕 +Y 顺时针 90 度（右手 Y-up 世界）', () => {
  // 右手系绕 +Y 转 -90 度：(x, z) -> (-z, x)。
  for (const yaw of [-2.5, -0.4, 0, 1.1, 2.9]) {
    const forward = yawToForward(yaw)
    const clockwise = { x: -forward.z, y: 0, z: forward.x }
    assertVecClose(yawToRight(yaw), clockwise, 1e-12, 'yaw=' + yaw)
    // 同样地：right = forward x up。这是"顺时针 90 度"在右手系里的叉积写法。
    assertVecClose(vecCross(forward, UP), yawToRight(yaw), 1e-12, 'forward x up @' + yaw)
  }
})

test('yaw 约定与 three.js 相机一致：yaw = 0 看向 -Z，正 yaw 朝 -X 偏', () => {
  assertVecClose(yawToForward(0), { x: 0, y: 0, z: -1 }, 1e-12, 'yaw=0')
  assertVecClose(yawToRight(0), { x: 1, y: 0, z: 0 }, 1e-12, 'yaw=0 right')
  assertVecClose(yawToForward(Math.PI / 2), { x: -1, y: 0, z: 0 }, 1e-12, 'yaw=PI/2')
  assertVecClose(yawToForward(-Math.PI / 2), { x: 1, y: 0, z: 0 }, 1e-12, 'yaw=-PI/2')
})

test('lookDirection: 水平分量是 forward 乘以 cos(pitch)，y 是 sin(pitch)', () => {
  for (const yaw of [0, 0.8, -2.2]) {
    for (const pitch of [-1.2, -0.5, 0, 0.4, 1.2]) {
      const look = lookDirection(yaw, pitch)
      const forward = yawToForward(yaw)
      assertClose(look.y, Math.sin(pitch), 1e-12, 'y @' + yaw + '/' + pitch)
      assertClose(look.x, forward.x * Math.cos(pitch), 1e-12, 'x @' + yaw + '/' + pitch)
      assertClose(look.z, forward.z * Math.cos(pitch), 1e-12, 'z @' + yaw + '/' + pitch)
      assertClose(vecLength(look), 1, 1e-12, '|look|')
    }
  }
})

test('wrapAngle: 归一到 [-PI, PI]，且不改变等价角度', () => {
  assertClose(wrapAngle(0), 0, 1e-12, '0')
  // 观测到的行为：3PI 折叠到 +PI，-3PI 折叠到 -PI —— 实现是先取模再夹到
  // 区间内，两个端点都保留，不是统一折到 +PI。两者模 2PI 都等价。
  assertClose(wrapAngle(Math.PI * 3), Math.PI, 1e-12, '3PI')
  assertClose(wrapAngle(-Math.PI * 3), -Math.PI, 1e-12, '-3PI')
  assert.ok(Math.abs(wrapAngle(Math.PI * 5)) <= Math.PI + 1e-12, '5PI 越界')
  assert.ok(Math.abs(wrapAngle(-Math.PI * 5)) <= Math.PI + 1e-12, '-5PI 越界')
  assertClose(wrapAngle(Math.PI * 2 + 0.5), 0.5, 1e-12, '2PI+0.5')
  for (let turns = -5; turns <= 5; turns++) {
    const base = 0.7
    assertClose(wrapAngle(base + turns * Math.PI * 2), base, 1e-9, 'turns=' + turns)
  }
})

test('clamp: 边界内原样返回，边界外夹住', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
  assert.equal(clamp(0, 0, 10), 0)
  assert.equal(clamp(10, 0, 10), 10)
})

test('角度量化往返误差不超过一个量化步长', () => {
  const tolerance = (2 * Math.PI) / 65535
  for (let i = 0; i <= 512; i++) {
    const angle = -Math.PI + (2 * Math.PI * i) / 512
    const quantized = quantizeAngle(angle)
    assert.ok(quantized >= 0 && quantized <= 0xffff, 'quantize 越界 ' + quantized)
    const restored = dequantizeAngle(quantized)
    assert.ok(restored >= -Math.PI - 1e-12 && restored <= Math.PI + 1e-12, 'dequantize 越界 ' + restored)
    assertClose(restored, angle, tolerance, 'angle=' + angle)
  }
  // 满量程两端映射到 u16 的两个端点。
  assert.equal(quantizeAngle(-Math.PI), 0)
  assert.equal(quantizeAngle(Math.PI), 0xffff)
})
