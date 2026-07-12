import * as THREE from 'three'

// ============================================================
//  殭屍：按 G 在空地上生成（會避開樹木/石頭/水域等障礙物），緩慢跳躍前進。
//  行為：每 3~20 秒（沒被激怒時）重新擲骰決定「遠離主角」或「朝離自己最近的一方前進」。
//  貼近目標一步之遙時，改成原地撲咬攻擊，每次扣目標 25 點血：
//    - 一般攻擊模式（自己巡邏靠近咬到的）：咬 1~2 口（隨機）就離開。
//    - 反擊模式（被箭射中觸發，鎖定射他的那個人）：持續攻擊直到把對方咬死才離開。
//  被箭射中：記一次命中、轉為鎖定「目前離殭屍最近的一方」進入/保持反擊模式（不管原本在做什麼），
//  中箭滿 3 箭死亡。移動路上遇到水域/障礙物會被擋住；反擊模式下被擋住會
//  慢慢往固定一邊轉頭繞過去，而不是每次重新亂選方向。
//  另外，只要殭屍還沒進入攻擊/反擊模式，10 公尺警戒範圍內：
//    - 有人正在拉弓蓄力 → 必定被盯上。
//    - 沒人拉弓 → 每秒仍有 1/8 機率盯上附近的人；若殭屍離對方在 5 公尺內，機率提高到 1/4。
//  盯上後轉為一般攻擊模式（跟自己巡邏靠近咬到人一樣，咬 1~2 口就走）；不會直接進入
//  反擊/復仇模式，那個只有被箭射中才會觸發（咬到把對方咬死才離開）。
//  免疫保護：任何一方累積被咬滿 2 口後，接下來 60 秒內所有殭屍（包含正在反擊模式的）
//  都不會再攻擊他，也不會把他列入追蹤/鎖定目標，逼近中的殭屍會直接放棄轉為離開。
// ============================================================

const HOP_PERIOD = 1.0        // 每次跳躍/攻擊的週期（秒）
const HOP_DISTANCE = 1.1      // 每次移動跳躍前進的距離
const HOP_HEIGHT = 0.32       // 移動跳躍的弧線高度
const ATTACK_HOP_HEIGHT = 0.16
const MELEE_RANGE = 1.7       // 貼近到這個距離內，改成原地攻擊而不是繼續跳過去
const ATTACK_DAMAGE = 25
const HITS_TO_DIE = 3         // 中箭滿 3 箭即死亡
const DECIDE_MIN = 3, DECIDE_MAX = 20
const MODEL_SCALE = 1.7       // 殭屍模型整體放大倍率，命中判定的中心高度/半徑要跟著一起放大，否則會對不準模型
const HIT_CENTER_Y = 1.0 * MODEL_SCALE   // 命中判定球中心離地面高度（大致抓軀幹）
const HIT_RADIUS = 0.32 * MODEL_SCALE
const AWARE_RADIUS_SQ = 10 * 10       // 殭屍警戒範圍：這個距離內有人拉弓必定被盯上，沒拉弓也有機率被盯上
const NEAR_RADIUS_SQ = 5 * 5          // 更靠近（5m 內）時，沒拉弓的被動發現機率會提高
const PASSIVE_CHANCE_FAR_PER_SEC = 1 / 8    // 沒人拉弓、5~10m 內，每秒盯上機率
const PASSIVE_CHANCE_NEAR_PER_SEC = 1 / 4   // 沒人拉弓、5m 內，每秒盯上機率
const CORPSE_LIFETIME = 3     // 死亡倒地後停留幾秒才消失
const MAX_ZOMBIES = 10        // 場上同時存在的殭屍上限（只算還活著的，死亡倒地/消失中的不佔名額）
const BITE_IMMUNITY_THRESHOLD = 2   // 累積被咬滿這麼多口，就進入免疫期
const BITE_IMMUNITY_DURATION = 60   // 免疫期長度（秒）
const UP = new THREE.Vector3(0, 1, 0)

let gameClock = 0
const biteTally = new Map()   // archer -> { count, immuneUntil }：累積被咬次數與免疫到期的遊戲時間

// 這次咬擊算在 archer 頭上：累積次數滿門檻就進入免疫期（並歸零計數，下次要重新咬滿才會再免疫）
function registerBite(archer) {
  let rec = biteTally.get(archer)
  if (!rec) { rec = { count: 0, immuneUntil: 0 }; biteTally.set(archer, rec) }
  rec.count++
  if (rec.count >= BITE_IMMUNITY_THRESHOLD) {
    rec.immuneUntil = gameClock + BITE_IMMUNITY_DURATION
    rec.count = 0
  }
}

function isArcherImmune(archer) {
  const rec = biteTally.get(archer)
  return !!rec && gameClock < rec.immuneUntil
}

// 給生成/重新開局用：清掉所有累積的被咬紀錄與免疫期
export function resetZombieBiteImmunity() {
  biteTally.clear()
}

// 在玩家與 AI 之間挑一個「目前可以被鎖定」的攻擊/追蹤目標：排除死亡與還在免疫期的一方，
// 兩個都可選時取離殭屍較近的；兩個都不能選時回傳 null（保留原本行為，不勉強鎖定）
function pickAggroTarget(zbPos, ctx) {
  const pOk = ctx.playerArcher && !ctx.playerArcher.dead && !isArcherImmune(ctx.playerArcher)
  const aOk = ctx.aiArcher && !ctx.aiArcher.dead && !isArcherImmune(ctx.aiArcher)
  if (!pOk && !aOk) return null
  if (pOk && !aOk) return { archer: ctx.playerArcher, pos: ctx.playerPos }
  if (aOk && !pOk) return { archer: ctx.aiArcher, pos: ctx.aiPos }
  const dp = zbPos.distanceToSquared(ctx.playerPos)
  const da = zbPos.distanceToSquared(ctx.aiPos)
  return dp <= da ? { archer: ctx.playerArcher, pos: ctx.playerPos } : { archer: ctx.aiArcher, pos: ctx.aiPos }
}

function buildZombieMesh() {
  const g = new THREE.Group()
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x5c6e3d, roughness: 0.92 })
  const clothMat = new THREE.MeshStandardMaterial({ color: 0x39352a, roughness: 0.95 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff3018, emissive: 0x8a1400, emissiveIntensity: 0.7 })

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 8), clothMat)
  torso.position.y = 1.02
  g.add(torso)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), skinMat)
  head.position.y = 1.55
  g.add(head)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 6), eyeMat)
    eye.position.set(side * 0.06, 1.57, 0.14)
    g.add(eye)
  }

  // 雙臂向前伸直，經典殭屍姿勢
  const armGroupL = new THREE.Group(); armGroupL.position.set(-0.28, 1.32, 0)
  const armGroupR = new THREE.Group(); armGroupR.position.set(0.28, 1.32, 0)
  for (const ag of [armGroupL, armGroupR]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.5, 4, 6), skinMat)
    arm.rotation.x = Math.PI / 2
    arm.position.z = 0.28
    ag.add(arm)
    g.add(ag)
  }

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.6, 4, 6), clothMat)
    leg.position.set(side * 0.13, 0.42, 0)
    g.add(leg)
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = true })
  g.scale.setScalar(MODEL_SCALE)
  return g
}

function flashMesh(mesh, on) {
  mesh.traverse((o) => {
    if (!o.isMesh) return
    o.material.emissive.setHex(on ? 0xffffff : 0x000000)
    o.material.emissiveIntensity = 1
  })
}

export class Zombie {
  constructor(scene, x, z, y = 0) {
    this.mesh = buildZombieMesh()
    this.mesh.position.set(x, y, z)
    this.hitCount = 0
    this.state = 'active'   // 'active' | 'dying' | 'corpse'
    this.removed = false
    this.mode = 'wander'    // 'wander'（遠離主角） | 'seek'（追離自己最近的一方） | 'attack'（鎖定射他的人）
    this.aggroArcher = null
    this.seekTarget = null   // 'seek' 模式鎖定的目標：選定後這次追逐/撲咬都咬同一個人，不會每跳重算
    this.decideT = DECIDE_MIN + Math.random() * (DECIDE_MAX - DECIDE_MIN)
    this.hopT = 0
    this.isAttackHop = false
    this.attackTargetArcher = null   // 這一跳實際要打的人（seek 模式下臨時算出來的）
    this.hopFrom = this.mesh.position.clone()
    this.hopTo = this.mesh.position.clone()
    this.hopFromY = y   // 起跳/落地地形高度，避免剛生成在非平地時第一跳飛在半空或陷進地面
    this.hopToY = y
    this.steerSign = 0   // 攻擊模式被擋住時，繞路要往哪邊偏（左/右），選定後盡量保持一致不要來回抖動
    this.seekBiteCount = 0   // 一般攻擊模式（seek 咬到的）已經咬了幾口
    this.seekBiteLimit = 1
    this._flashT = 0
    this.corpseT = 0
    scene.add(this.mesh)
  }

  _decideMode(ctx) {
    if (this.aggroArcher) { this.mode = 'attack'; return }
    const wantsSeek = Math.random() < 0.5
    const pick = wantsSeek ? pickAggroTarget(this.mesh.position, ctx) : null
    if (pick) {
      this.mode = 'seek'
      this.seekTarget = pick.archer   // 選定當下最近的人（排除免疫中的），鎖定到這次接觸結束
      this.seekBiteCount = 0
      this.seekBiteLimit = Math.random() < 0.5 ? 1 : 2   // 一般攻擊模式咬一口或兩口就離開
    } else {
      this.mode = 'wander'   // 想追人但雙方都免疫中/死亡，改成先閒晃
    }
    this.decideT = DECIDE_MIN + Math.random() * (DECIDE_MAX - DECIDE_MIN)
  }

  // 這次接觸結束（一般模式咬夠次數、或反擊模式殺死目標）：轉為離開，不再重新擲骰，
  // 除非又被射中（onHitByArrow 會直接切回反擊模式鎖定新的射手）
  _startLeaving() {
    this.mode = 'leave'
    this.aggroArcher = null
    this.seekTarget = null
    this.decideT = Infinity
  }

  _facePoint(px, pz) {
    const dir = new THREE.Vector3(px - this.mesh.position.x, 0, pz - this.mesh.position.z)
    if (dir.lengthSq() < 1e-6) return
    this.mesh.rotation.y = Math.atan2(dir.x, dir.z)
  }

  update(dt, ctx) {
    if (this._flashT > 0) { this._flashT -= dt; if (this._flashT <= 0) flashMesh(this.mesh, false) }

    if (this.state === 'dying') { this._updateDying(dt, ctx); return }
    if (this.state === 'corpse') {
      this.corpseT += dt
      if (this.corpseT > CORPSE_LIFETIME) this.removed = true
      return
    }

    // 鎖定的目標死掉了，或是被咬滿 2 口進入免疫期了（不管是反擊模式的 aggroArcher
    // 還是一般攻擊模式的 seekTarget，也不管是不是殭屍自己咬的）→ 放棄，離開
    if ((this.aggroArcher && (this.aggroArcher.dead || isArcherImmune(this.aggroArcher))) ||
        (this.seekTarget && (this.seekTarget.dead || isArcherImmune(this.seekTarget)))) {
      this._startLeaving()
    }
    // 攻擊模式會持續鎖定同一個目標，不會重新擲骰換行為，直到目標死亡、
    // 或被別人射中（onHitByArrow 會轉去鎖定最後打他的人）才會改變
    if (this.mode !== 'attack') {
      this.decideT -= dt
      if (this.decideT <= 0) this._decideMode(ctx)
      if (this.mode !== 'seek') this._checkDrawAggro(dt, ctx)
    }

    this.hopT += dt
    const t = Math.min(1, this.hopT / HOP_PERIOD)
    // 弧線的基準高度沿著起跳/落地兩點的地形高度內插，避免地形起伏時飛在半空或陷進地面
    const baseY = this.hopFromY + (this.hopToY - this.hopFromY) * t
    if (this.isAttackHop) {
      this.mesh.position.y = baseY + Math.sin(t * Math.PI) * ATTACK_HOP_HEIGHT
    } else {
      this.mesh.position.x = this.hopFrom.x + (this.hopTo.x - this.hopFrom.x) * t
      this.mesh.position.z = this.hopFrom.z + (this.hopTo.z - this.hopFrom.z) * t
      this.mesh.position.y = baseY + Math.sin(t * Math.PI) * HOP_HEIGHT
    }

    if (this.hopT >= HOP_PERIOD) {
      this.hopT = 0
      if (this.isAttackHop) this._doAttack(ctx)
      this._planNextHop(ctx)
    }
  }

  // 10 公尺警戒範圍內：有人正在拉弓蓄力就必定被盯上；沒人拉弓的話，每秒仍有機率被動發現
  // 附近的人（5 公尺內機率更高），轉為一般攻擊模式（咬 1~2 口就走，不是咬到死的反擊模式）
  _checkDrawAggro(dt, ctx) {
    const candidates = []
    if (ctx.playerArcher && !ctx.playerArcher.dead && !isArcherImmune(ctx.playerArcher)) {
      candidates.push({ archer: ctx.playerArcher, pos: ctx.playerPos, charging: !!ctx.playerCharging })
    }
    if (ctx.aiArcher && !ctx.aiArcher.dead && !isArcherImmune(ctx.aiArcher)) {
      candidates.push({ archer: ctx.aiArcher, pos: ctx.aiPos, charging: !!ctx.aiCharging })
    }
    for (const c of candidates) {
      const distSq = this.mesh.position.distanceToSquared(c.pos)
      if (distSq > AWARE_RADIUS_SQ) continue
      let triggered = c.charging
      if (!triggered) {
        const chance = distSq <= NEAR_RADIUS_SQ ? PASSIVE_CHANCE_NEAR_PER_SEC : PASSIVE_CHANCE_FAR_PER_SEC
        triggered = Math.random() < chance * dt
      }
      if (triggered) {
        this.mode = 'seek'
        this.seekTarget = c.archer   // 鎖定被盯上的那個人，不會被另一個離殭屍更近但條件不符的人搶走目標
        this.seekBiteCount = 0
        this.seekBiteLimit = Math.random() < 0.5 ? 1 : 2
        this.decideT = DECIDE_MIN + Math.random() * (DECIDE_MAX - DECIDE_MIN)
        return
      }
    }
  }

  _planNextHop(ctx) {
    this.hopFrom.copy(this.mesh.position)

    if (this.mode === 'wander' || this.mode === 'leave') {
      const away = new THREE.Vector3(this.mesh.position.x - ctx.playerPos.x, 0, this.mesh.position.z - ctx.playerPos.z)
      if (away.lengthSq() < 1e-4) away.set(Math.random() - 0.5, 0, Math.random() - 0.5)
      away.normalize()
      this.isAttackHop = false
      let dest = this.mesh.position.clone().addScaledVector(away, HOP_DISTANCE)
      if (this._isBlocked(dest.x, dest.z, ctx)) {
        let found = false
        for (let i = 0; i < 4; i++) {
          const dir2 = away.clone().applyAxisAngle(UP, (Math.random() - 0.5) * Math.PI)
          const cand = this.mesh.position.clone().addScaledVector(dir2, HOP_DISTANCE)
          if (!this._isBlocked(cand.x, cand.z, ctx)) { dest = cand; found = true; break }
        }
        if (!found) dest = this.mesh.position.clone()   // 四面都被擋住，這跳先原地不動
      }
      this._finishHopPlan(ctx, dest)
      this._facePoint(this.hopTo.x, this.hopTo.z)
      return
    }

    // seek / attack：算出目前要追的那個人。兩種模式都是「選定後鎖定到這次接觸結束」，
    // 不會每跳重新比較距離，避免殭屍自己移動時因為相對距離變化而追到一半換目標
    let targetArcher, targetPos
    if (this.mode === 'attack' && this.aggroArcher) {
      targetArcher = this.aggroArcher
      targetPos = this.aggroArcher === ctx.playerArcher ? ctx.playerPos : ctx.aiPos
    } else if (this.mode === 'seek' && this.seekTarget) {
      targetArcher = this.seekTarget
      targetPos = this.seekTarget === ctx.playerArcher ? ctx.playerPos : ctx.aiPos
    } else {
      // 理論上不會走到這裡（seek 進場時一定會選好 seekTarget），保底選一個可攻擊的目標
      const pick = pickAggroTarget(this.mesh.position, ctx)
      targetArcher = pick && pick.archer
      targetPos = pick && pick.pos
    }
    this.attackTargetArcher = targetArcher
    if (!targetArcher || targetArcher.dead) {
      this.isAttackHop = false
      this._finishHopPlan(ctx, this.mesh.position)
      return
    }

    const toTarget = new THREE.Vector3(targetPos.x - this.mesh.position.x, 0, targetPos.z - this.mesh.position.z)
    const dist = toTarget.length()
    this._facePoint(targetPos.x, targetPos.z)
    if (dist <= MELEE_RANGE) {
      this.isAttackHop = true
      this._finishHopPlan(ctx, this.mesh.position)
      return
    }

    this.isAttackHop = false
    toTarget.normalize()
    let dest = this.mesh.position.clone().addScaledVector(toTarget, Math.min(HOP_DISTANCE, dist))
    if (this._isBlocked(dest.x, dest.z, ctx)) {
      // 攻擊模式被水/障礙物擋住：慢慢往固定一邊轉頭繞過去，而不是每次重新亂選方向
      if (!this.steerSign) this.steerSign = Math.random() < 0.5 ? 1 : -1
      let steered = null
      for (let i = 1; i <= 3; i++) {
        const dir2 = toTarget.clone().applyAxisAngle(UP, this.steerSign * 0.45 * i)
        const cand = this.mesh.position.clone().addScaledVector(dir2, HOP_DISTANCE)
        if (!this._isBlocked(cand.x, cand.z, ctx)) { steered = cand; break }
      }
      dest = steered || this.mesh.position.clone()
    } else {
      this.steerSign = 0   // 前方暢通，清掉繞路偏向，下次被擋住再重新選邊
    }
    this._finishHopPlan(ctx, dest)
  }

  _isBlocked(x, z, ctx) {
    if (ctx.isWaterAt && ctx.isWaterAt(x, z)) return true
    if (ctx.obstacles) {
      for (const o of ctx.obstacles) {
        const dx = x - o.x, dz = z - o.z
        if (dx * dx + dz * dz < o.r * o.r) return true
      }
    }
    return false
  }

  _finishHopPlan(ctx, dest) {
    this.hopTo.copy(dest)
    this.hopFromY = ctx.getGroundHeight(this.hopFrom.x, this.hopFrom.z)
    this.hopToY = ctx.getGroundHeight(this.hopTo.x, this.hopTo.z)
  }

  _doAttack(ctx) {
    const target = this.attackTargetArcher
    if (!target) return
    const isRetaliation = this.mode === 'attack'
    // 這一跳是不是真的要咬下去，撲咬動作規劃時就決定了（isAttackHop），但免疫狀態隨時可能
    // 因為「別隻殭屍剛好也在這幾幀咬中同一個人」而中途變化，所以真正咬下去這一刻要重新檢查
    // 一次免疫，不能只看規劃當下的狀態，否則免疫生效前已經排定的攻擊還是會多咬進去
    const canBite = !target.dead && !isArcherImmune(target)
    if (canBite) { ctx.onZombieAttack(target); registerBite(target) }
    const shouldLeave = target.dead || isArcherImmune(target)

    if (isRetaliation) {
      // 反擊模式：持續鎖定同一個人，直到咬死他才離開（見 update() 的解除鎖定判斷）
      if (shouldLeave) this._startLeaving()
    } else {
      // 一般攻擊模式（seek 巡邏靠近咬到的）：咬到擲骰決定的次數（1~2 口）就離開
      if (canBite) this.seekBiteCount++
      if (shouldLeave || this.seekBiteCount >= this.seekBiteLimit) this._startLeaving()
    }
  }

  // 被箭射中呼叫：記一次命中，不管是誰射的，一律鎖定「目前離殭屍最近」且不在免疫期的那一方
  // 進入/保持復仇（攻擊）模式，超過 3 次就死亡。ctx = { playerArcher, aiArcher, playerPos, aiPos }
  onHitByArrow(ctx) {
    if (this.state !== 'active') return
    this.hitCount++
    const pick = pickAggroTarget(this.mesh.position, ctx)
    if (pick) {
      this.aggroArcher = pick.archer
      this.mode = 'attack'
    }
    this._flashT = 0.18
    flashMesh(this.mesh, true)
    if (this.hitCount >= HITS_TO_DIE) this._die()
  }

  _die() {
    this.state = 'dying'
    this.fallVel = 0
  }

  _updateDying(dt, ctx) {
    const groundY = ctx.getGroundHeight ? ctx.getGroundHeight(this.mesh.position.x, this.mesh.position.z) : 0
    this.fallVel -= 9.8 * dt
    this.mesh.position.y += this.fallVel * dt
    this.mesh.rotation.x = Math.min(Math.PI / 2, (this.mesh.rotation.x || 0) + dt * 2.4)
    if (this.mesh.position.y <= groundY) {
      this.mesh.position.y = groundY
      this.state = 'corpse'
      this.corpseT = 0
    }
  }
}

const zombies = []

// 按 G 生成一隻殭屍（呼叫端自己找空地座標）。上限只算還活著的（state==='active'），
// 死亡倒地／等待消失中的屍體不佔名額，才不會因為一堆屍體還沒消失就卡住生不出新的
export function spawnZombie(scene, x, z, y = 0) {
  if (getActiveZombies().length >= MAX_ZOMBIES) return null
  const zb = new Zombie(scene, x, z, y)
  zombies.push(zb)
  return zb
}

// 給 AI 用：目前場上還活著（非死亡倒地/屍體）的殭屍列表，讓 AI 判斷要不要先別蓄力發箭
export function getActiveZombies() {
  return zombies.filter((z) => z.state === 'active')
}

// 測試箭矢本幀掃過的路徑有沒有打中任何一隻活著的殭屍，回傳最近的一隻（沒打中回傳 null）
export function testArrowHitZombie(prevPos, currPos, arrowRadius) {
  const seg = new THREE.Vector3().subVectors(currPos, prevPos)
  const len2 = seg.lengthSq()
  let best = null, bestDist = Infinity
  for (const zb of zombies) {
    if (zb.state !== 'active') continue
    const center = zb.mesh.position.clone(); center.y += HIT_CENTER_Y
    let t = len2 > 1e-8 ? new THREE.Vector3().subVectors(center, prevPos).dot(seg) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const closest = prevPos.clone().addScaledVector(seg, t)
    const d = closest.distanceTo(center)
    if (d <= arrowRadius + HIT_RADIUS && d < bestDist) { bestDist = d; best = zb }
  }
  return best
}

// 每幀呼叫。ctx = { playerArcher, aiArcher, playerPos, aiPos, onZombieAttack(archer), getGroundHeight(x,z) }
export function updateZombies(dt, ctx) {
  gameClock += dt
  for (let i = zombies.length - 1; i >= 0; i--) {
    const zb = zombies[i]
    zb.update(dt, ctx)
    if (zb.removed) { zb.mesh.removeFromParent(); zombies.splice(i, 1) }
  }
}
