import * as THREE from 'three'
import { computeWorldCapsules, HIT_ZONES } from './hitzones.js'
import { GRAVITY, SPEED_MIN, SPEED_MAX, solveBallisticPitch } from './arrow.js'
import { sfx } from './sfx.js'
import { getActiveZombies } from './zombie.js'

const ZOMBIE_ALERT_RADIUS_SQ = 11 * 11   // 殭屍在 AI 對手附近這個距離內，就不蓄力發弓
const _aiEyePos = new THREE.Vector3()

// AI 對手命中機率是可調的固定比例（由關卡系統依 Level 1~10 從 10% 線性調到 60%，見 main.js
// 的 LEVELS 設定）：每次拉弓先擲骰決定這一箭是不是「真的瞄準」的那次，是的話用很小的誤差
// （幾乎一定會中），不是的話直接加一個保證偏出目標範圍的角度，而不是沿用「疊加連續隨機誤差」
// 的做法——那種做法命中率會隨距離/難度飄動，沒辦法保證固定比例
const DEFAULT_HIT_CHANCE = 0.1
const TRUE_AIM_ERROR = 0.03   // 命中那次用的極小誤差
const MISS_ERROR_MIN = 0.35   // 保證偏出目標範圍的誤差下限
const MISS_ERROR_MAX = 0.6

// 難度預設：蓄力時間範圍、出手間隔、瞄準要害的偏好程度（命中率統一由上面的 HIT_CHANCE 控制，不分難度）
const DIFFICULTY = {
  easy:   { chargeMin: 2.5, chargeMax: 3.5, restMin: 0.8, restMax: 1.6, centerBias: 0.06 },
  normal: { chargeMin: 0.55, chargeMax: 0.95, restMin: 0.5, restMax: 1.0, centerBias: 0.25 },
  hard:   { chargeMin: 0.7, chargeMax: 1.0, restMin: 0.3, restMax: 0.7, centerBias: 0.5 },
}

const STATE = { IDLE: 'idle', DRAWING: 'drawing', COOLDOWN: 'cooldown' }

function pickTargetZone(centerBias) {
  if (Math.random() < centerBias) return Math.random() < 0.5 ? 'head' : 'chest'
  const names = Object.keys(HIT_ZONES)
  return names[Math.floor(Math.random() * names.length)]
}

function randRange(a, b) { return a + Math.random() * (b - a) }

// AI 對手：狀態機 IDLE(待機)→DRAWING(鎖定目標蓄力)→COOLDOWN(出手後停頓)。
// 跟玩家共用同一個 Archer 類別，中箭後的瞄準干擾/受傷反應完全對稱，這裡不用特別處理。
export class AIController {
  constructor(archer, arrowManager, getTargetArcher, difficulty = 'normal') {
    this.archer = archer
    this.arrowManager = arrowManager
    this.getTargetArcher = getTargetArcher
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal
    this.state = STATE.IDLE
    this.t = randRange(this.cfg.restMin, this.cfg.restMax)
    this.chargeT = 0
    this.chargeGoal = 0
    this.origin = new THREE.Vector3()
    this.dir = new THREE.Vector3(0, 0, 1)
    this.speed = SPEED_MIN
    this.hitChance = DEFAULT_HIT_CHANCE
    this.headshotThreat = false   // 這一箭是不是「真的瞄準」對手頭部的那一箭，給 main.js 判斷要不要觸發慢動作
    this.headshotTriggerDist = 0   // 飛到離目標頭部還剩這麼多公尺（＝飛行距離過半那一刻）就觸發慢動作
    this.headshotWatchPos = new THREE.Vector3()   // 慢動作觸發距離要拿箭矢位置跟這個點比對（目標頭部世界座標）
  }

  // 關卡切換時呼叫：更新這個 AI 對手的固定命中機率（0~1）
  setHitChance(chance) {
    this.hitChance = Math.max(0, Math.min(1, chance))
  }

  update(dt) {
    const target = this.getTargetArcher()
    if (this.archer.dead || target.dead) return

    // 待機中每幀都檢查附近有沒有殭屍，讓「害怕」表情能即時跟著殭屍是否還在範圍內變化，
    // 不用等到剛好輪到重新擲骰的那一刻才更新
    const blockedByZombie = this.state === STATE.IDLE && this._zombieBlocksDraw()
    this.archer.setScared(blockedByZombie)

    if (this.state === STATE.IDLE) {
      this.t -= dt
      if (this.t <= 0) {
        if (blockedByZombie) {
          this.t = 0.4   // 眼前警戒範圍內有殭屍，先不蓄力，稍等一下再重新檢查
        } else {
          this._beginDraw(target)
        }
      }
    } else if (this.state === STATE.DRAWING) {
      this.chargeT += dt
      this.archer.setDrawPower(this.chargeT / this.chargeGoal)
      if (this.chargeT >= this.chargeGoal) this._release()
    } else if (this.state === STATE.COOLDOWN) {
      this.t -= dt
      if (this.t <= 0) { this.state = STATE.IDLE; this.t = randRange(this.cfg.restMin, this.cfg.restMax) }
    }
  }

  // 只要有活著的殭屍在 AI 對手 11 公尺內，就先別蓄力發箭，避免被殭屍的拉弓吸引判定盯上
  // （跟 zombie.js 的 _checkDrawAggro 是同一套規則的對手視角）
  _zombieBlocksDraw() {
    const zombies = getActiveZombies()
    if (zombies.length === 0) return false
    this.archer.root.getWorldPosition(_aiEyePos)
    for (const zb of zombies) {
      const dx = zb.mesh.position.x - _aiEyePos.x
      const dz = zb.mesh.position.z - _aiEyePos.z
      if (dx * dx + dz * dz <= ZOMBIE_ALERT_RADIUS_SQ) return true
    }
    return false
  }

  _beginDraw(target) {
    const zoneName = pickTargetZone(this.cfg.centerBias)
    const caps = computeWorldCapsules(target)
    const cap = caps.find((c) => c.name === zoneName) || caps[0]
    const targetPoint = cap.p0.clone().add(cap.p1).multiplyScalar(0.5)

    this.archer.parts.head.origin.getWorldPosition(this.origin)

    const power = randRange(0.5, 1)
    this.speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power

    const dxz = Math.hypot(targetPoint.x - this.origin.x, targetPoint.z - this.origin.z)
    const dy = targetPoint.y - this.origin.y
    const pitch = solveBallisticPitch(dxz, dy, this.speed, -GRAVITY)

    const flat = new THREE.Vector3(targetPoint.x - this.origin.x, 0, targetPoint.z - this.origin.z).normalize()
    let dir
    if (pitch === null) {
      dir = targetPoint.clone().sub(this.origin).normalize()
    } else {
      dir = flat.multiplyScalar(Math.cos(pitch))
      dir.y = Math.sin(pitch)
    }

    // 每次拉弓只擲骰一次（不連續抖動），決定這一箭是命中機率裡「真的瞄準」的那次，
    // 還是刻意偏出去的那次；同一箭全程用同一組誤差，讀起來像刻意瞄準/失手而不是手抖
    const isTrueAim = Math.random() < this.hitChance
    if (isTrueAim) {
      dir.x += (Math.random() - 0.5) * 2 * TRUE_AIM_ERROR
      dir.y += (Math.random() - 0.5) * 2 * TRUE_AIM_ERROR
      dir.z += (Math.random() - 0.5) * 2 * TRUE_AIM_ERROR
    } else {
      const missErr = randRange(MISS_ERROR_MIN, MISS_ERROR_MAX)
      const missAngle = Math.random() * Math.PI * 2
      dir.x += Math.cos(missAngle) * missErr
      dir.y += (Math.random() - 0.5) * missErr
      dir.z += Math.sin(missAngle) * missErr
    }
    dir.normalize()
    this.dir.copy(dir)
    // 真的瞄準頭部、大概率會命中的那一箭，main.js 會在箭飛到半路時觸發慢動作；
    // 用出手當下到目標頭部的直線距離算「半路」是多遠，而不是寫死固定公尺數，
    // 這樣不管關卡把雙方距離拉多長，慢動作都固定在「飛行進度過半」的那一刻開始
    this.headshotThreat = isTrueAim && zoneName === 'head'
    this.headshotTriggerDist = this.origin.distanceTo(targetPoint) / 2
    this.headshotWatchPos.copy(targetPoint)

    this.chargeGoal = randRange(this.cfg.chargeMin, this.cfg.chargeMax)
    this.chargeT = 0
    this.state = STATE.DRAWING
  }

  _release() {
    const arrow = this.arrowManager.spawn(this.origin.clone(), this.dir, this.speed, 'ai')
    arrow.headshotThreat = this.headshotThreat
    arrow.headshotTriggerDist = this.headshotTriggerDist
    arrow.headshotWatchPos = this.headshotWatchPos.clone()
    sfx.release()
    this.archer.setDrawPower(0)
    this.state = STATE.COOLDOWN
    this.t = randRange(this.cfg.restMin, this.cfg.restMax)
  }

  // 拉弓中被射中：嚇一跳，讓還沒放出去的這一箭方向往上偏一點（分級決定偏多少），模擬瞄準被打亂
  onHit(tier) {
    if (this.state !== STATE.DRAWING) return
    const bump = { light: 0.03, medium: 0.08, heavy: 0.16 }[tier] || 0
    if (!bump) return
    this.dir.y += bump
    this.dir.normalize()
  }

  // 再來一局：回到待機狀態，重新擲骰一次出手前的停頓時間
  reset() {
    this.state = STATE.IDLE
    this.chargeT = 0
    this.t = randRange(this.cfg.restMin, this.cfg.restMax)
  }
}
