import * as THREE from 'three'

// 14 個命中判定區：頭部致命，胸口/大臂+大腿重傷，小臂+小腿中傷，手掌+腳掌輕傷
// radius 對應 archer.js 建構身體節段時使用的膠囊半徑，兩邊必須一致（視覺模型本身就是命中框）
export const HIT_ZONES = {
  head:       { tier: 'fatal',  damage: Infinity, radius: 0.15 },
  chest:      { tier: 'heavy',  damage: 50, radius: 0.20 },
  upperArm_L: { tier: 'heavy',  damage: 45, radius: 0.08 },
  upperArm_R: { tier: 'heavy',  damage: 45, radius: 0.08 },
  thigh_L:    { tier: 'heavy',  damage: 45, radius: 0.11 },
  thigh_R:    { tier: 'heavy',  damage: 45, radius: 0.11 },
  foreArm_L:  { tier: 'medium', damage: 22, radius: 0.065 },
  foreArm_R:  { tier: 'medium', damage: 22, radius: 0.065 },
  shin_L:     { tier: 'medium', damage: 22, radius: 0.08 },
  shin_R:     { tier: 'medium', damage: 22, radius: 0.08 },
  hand_L:     { tier: 'light',  damage: 10, radius: 0.06 },
  hand_R:     { tier: 'light',  damage: 10, radius: 0.06 },
  foot_L:     { tier: 'light',  damage: 10, radius: 0.065 },
  foot_R:     { tier: 'light',  damage: 10, radius: 0.065 },
}

// 中箭時注入攝影機瞄準的隨機偏移幅度（弧度），依分級遞增
export const TIER_AIM_NOISE = { light: 0.05, medium: 0.12, heavy: 0.25 }

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3()

// 讀取角色目前姿勢下，每個命中區在世界座標的膠囊端點（p0=關節原點, p1=節段末端）
// 每幀呼叫；箭矢會拿這份清單做掃描式線段命中測試
export function computeWorldCapsules(archer) {
  const list = []
  for (const name in HIT_ZONES) {
    const part = archer.parts[name]
    if (!part) continue
    part.origin.getWorldPosition(_v0)
    part.origin.localToWorld(_v1.copy(part.endOffset))
    const zone = HIT_ZONES[name]
    list.push({ name, tier: zone.tier, damage: zone.damage, radius: zone.radius, origin: part.origin, p0: _v0.clone(), p1: _v1.clone() })
  }
  return list
}

function clamp01(x) { return Math.max(0, Math.min(1, x)) }

// 兩線段最近距離（Ericson, Real-Time Collision Detection）
// 回傳 s = 命中點在 [p1,q1]（箭矢掃描段）上的參數，供「取最先命中」排序用
function closestPtSegmentSegment(p1, q1, p2, q2) {
  const d1 = new THREE.Vector3().subVectors(q1, p1)
  const d2 = new THREE.Vector3().subVectors(q2, p2)
  const r = new THREE.Vector3().subVectors(p1, p2)
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r)
  const EPS = 1e-9
  let s, t
  if (a <= EPS && e <= EPS) { s = 0; t = 0 }
  else if (a <= EPS) { s = 0; t = clamp01(f / e) }
  else {
    const c = d1.dot(r)
    if (e <= EPS) { t = 0; s = clamp01(-c / a) }
    else {
      const b = d1.dot(d2)
      const denom = a * e - b * b
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = clamp01(-c / a) }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a) }
    }
  }
  const c1 = p1.clone().addScaledVector(d1, s)
  const c2 = p2.clone().addScaledVector(d2, t)
  return { s, distSq: c1.distanceToSquared(c2), point: c1 }
}

// 箭矢本幀移動視為線段 prevPos->currPos，測試對手 14 個命中區膠囊
// 命中多個區時取 s 最小（離 prevPos 最近，等同最先命中）者
export function testArrowHit(prevPos, currPos, archer, arrowRadius) {
  if (archer.dead) return null
  const caps = computeWorldCapsules(archer)
  let best = null
  for (const cap of caps) {
    const res = closestPtSegmentSegment(prevPos, currPos, cap.p0, cap.p1)
    if (Math.sqrt(res.distSq) <= arrowRadius + cap.radius) {
      if (!best || res.s < best.s) best = { ...cap, s: res.s, point: res.point }
    }
  }
  return best
}
