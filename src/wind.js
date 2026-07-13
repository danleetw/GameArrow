import * as THREE from 'three'

// ============================================================
//  風：風向每 WIND_ANGLE_INTERVAL 秒重新抽一次新目標角度，風速每 WIND_SPEED_INTERVAL 秒
//  重新抽一次新目標速度；抽到新目標後不是瞬間跳變，而是花 WIND_TRANSITION 秒平滑過渡過去，
//  角度過渡固定走最短路徑（例如 350°→10° 是 +20°，不會硬繞遠路轉一大圈）
//  影響：箭矢飛行側向加速度、風向旗、樹木/草叢搖晃幅度、Level 8 營火煙霧飄移方向
// ============================================================

const WIND_ANGLE_INTERVAL = 15   // 風向多久重抽一次目標（秒）
const WIND_SPEED_INTERVAL = 45   // 風速多久重抽一次目標（秒）
const WIND_TRANSITION = 4        // 抽到新目標後，花多久平滑過渡過去（秒）
const WIND_SPEED_MAX = 4.5       // 要跟 main.js 的 WIND_SPEED_MAX 一致

let windAngle = Math.random() * Math.PI * 2   // 風吹往的方位角（弧度，0 = +X 方向，逆時針）
let windSpeed = 1.2 + Math.random() * 1.6     // m/s

let angleFrom = windAngle, angleTo = windAngle, angleTransT = WIND_TRANSITION, angleTimer = 0
let speedFrom = windSpeed, speedTo = windSpeed, speedTransT = WIND_TRANSITION, speedTimer = 0

const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

export function updateWind(dt) {
  angleTimer += dt
  if (angleTimer >= WIND_ANGLE_INTERVAL) {
    angleTimer = 0
    angleFrom = windAngle
    angleTo = Math.random() * Math.PI * 2
    angleTransT = 0
  }
  if (angleTransT < WIND_TRANSITION) {
    angleTransT = Math.min(WIND_TRANSITION, angleTransT + dt)
    const diff = ((angleTo - angleFrom + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
    windAngle = angleFrom + diff * smoothstep(angleTransT / WIND_TRANSITION)
  }

  speedTimer += dt
  if (speedTimer >= WIND_SPEED_INTERVAL) {
    speedTimer = 0
    speedFrom = windSpeed
    speedTo = Math.random() * WIND_SPEED_MAX
    speedTransT = 0
  }
  if (speedTransT < WIND_TRANSITION) {
    speedTransT = Math.min(WIND_TRANSITION, speedTransT + dt)
    windSpeed = speedFrom + (speedTo - speedFrom) * smoothstep(speedTransT / WIND_TRANSITION)
  }
}

export function getWindAngle() { return windAngle }
export function getWindSpeed() { return windSpeed }

export function getWindVector(target = new THREE.Vector3()) {
  return target.set(Math.cos(windAngle) * windSpeed, 0, Math.sin(windAngle) * windSpeed)
}
