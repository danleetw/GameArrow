import * as THREE from 'three'

// ============================================================
//  風：風向/風速用帶阻尼的隨機漫步緩慢漂移（不會忽快忽慢地跳動）
//  影響：箭矢飛行側向加速度、風向旗、樹木/草叢搖晃幅度
// ============================================================

let windAngle = Math.random() * Math.PI * 2   // 風吹往的方位角（弧度，0 = +X 方向，逆時針）
let windSpeed = 1.2 + Math.random() * 1.6     // m/s
let angleVel = 0, speedVel = 0

export function updateWind(dt) {
  angleVel += (Math.random() - 0.5) * 0.4 * dt
  angleVel *= 0.985
  windAngle += angleVel * dt

  speedVel += (Math.random() - 0.5) * 1.1 * dt
  speedVel *= 0.98
  windSpeed = Math.max(0, Math.min(4.5, windSpeed + speedVel * dt))
}

export function getWindAngle() { return windAngle }
export function getWindSpeed() { return windSpeed }

export function getWindVector(target = new THREE.Vector3()) {
  return target.set(Math.cos(windAngle) * windSpeed, 0, Math.sin(windAngle) * windSpeed)
}
