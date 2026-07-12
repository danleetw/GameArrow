import * as THREE from 'three'
import { getTreeTops, getTerrainHeightAt, getPlatformSpots, pickGroundSpot } from './scene.js'

// ============================================================
//  天空中的小鳥：
//  - 隨機環境鳥：每隔一段時間擲骰決定要不要從場外飛過（純氛圍）
//  - 開場驚飛：對決開始時從主角附近飛起一隻
//  - 定時掠過：每隔一段時間安排一隻直直飛越主角與對手上空
//  - 行為 AI：每隻鳥飛一段時間後會重新決定行為——繼續飛（可能轉向）、
//    原地盤旋一陣子、飛到附近樹梢/空地/觀戰高台停棲，或飛到主角、對手
//    頭上/身邊落地，棲息一段時間後再起飛決定下一步
//  - 停棲時會收起翅膀、伸出雙腳站立在停棲面上；起飛時腳收回、翅膀展開
//  同時最多 5 隻，飛出範圍或飛太久就消失。純裝飾，不影響玩法。
// ============================================================

const STATE = {
  FLY: 'fly', CIRCLE: 'circle', APPROACH: 'approach', PERCHED: 'perched',
  APPROACH_ARCHER: 'approach_archer', PERCH_ARCHER: 'perch_archer', DEAD: 'dead',
}
const UP = new THREE.Vector3(0, 1, 0)
const FWD = new THREE.Vector3(0, 0, 1)
const BIRD_HIT_RADIUS = 0.22
const _flatDir = new THREE.Vector3()

const MAX_BIRDS = 5
const SPAWN_CHECK_MIN = 15, SPAWN_CHECK_MAX = 25   // 每 15~25 秒檢查一次，配合 1/3 機率平均約每分鐘一隻
const SPAWN_CHANCE = 1 / 3
const FLY_HEIGHT_MIN = 14, FLY_HEIGHT_MAX = 26
const FLY_HEIGHT_LOW_MIN = 5, FLY_HEIGHT_LOW_MAX = 11   // 低空變化，讓部分鳥飛得比較低、比較看得清楚
const LOW_FLIGHT_CHANCE = 0.4
const FLY_SPEED_MIN = 4, FLY_SPEED_MAX = 7
const SPAWN_RADIUS = 70
const MAX_LIFETIME = 40
const LEG_LENGTH = 0.1   // 腳的長度，停棲時用來把身體墊高，讓腳掌貼齊停棲面

function makeWingGeometry() {
  // 弧形收尖的翼形，沿局部 +X 延伸（貼身側往外展開），比單純長方形更像羽翼
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.quadraticCurveTo(0.05, 0.025, 0.32, -0.03)
  s.quadraticCurveTo(0.16, -0.1, 0, 0)
  return new THREE.ShapeGeometry(s, 8)
}

function makeTailGeometry() {
  const s = new THREE.Shape()
  s.moveTo(-0.05, 0.02)
  s.lineTo(0.05, 0.02)
  s.lineTo(0.018, -0.05)
  s.lineTo(-0.018, -0.05)
  s.closePath()
  return new THREE.ShapeGeometry(s, 6)
}

// 大部分鳥飛正常高度，一部分（LOW_FLIGHT_CHANCE）飛比較低，增加高度變化
function pickFlightHeight() {
  if (Math.random() < LOW_FLIGHT_CHANCE) return FLY_HEIGHT_LOW_MIN + Math.random() * (FLY_HEIGHT_LOW_MAX - FLY_HEIGHT_LOW_MIN)
  return FLY_HEIGHT_MIN + Math.random() * (FLY_HEIGHT_MAX - FLY_HEIGHT_MIN)
}

function buildBirdMesh() {
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a342c, roughness: 0.75 })
  const bellyMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, roughness: 0.8 })
  const beakMat = new THREE.MeshStandardMaterial({ color: 0xd99a2b, roughness: 0.5 })
  const legMat = new THREE.MeshStandardMaterial({ color: 0xe8992e, roughness: 0.5 })

  // 除了雙腳以外的部位都掛在 bodyGroup 底下：飛行時貼地（y=0），
  // 停棲站立時整組墊高 LEG_LENGTH，讓腳掌（固定在 g 原點）貼齊停棲面
  const bodyGroup = new THREE.Group()
  g.add(bodyGroup)
  g.userData.bodyGroup = bodyGroup

  // 身體：紡錘形（球體壓扁拉長），比圓錐更圓潤像鳥的軀幹
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), bodyMat)
  body.scale.set(0.82, 0.78, 1.7)
  bodyGroup.add(body)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), bellyMat)
  belly.scale.set(0.7, 0.55, 1.3)
  belly.position.y = -0.02
  bodyGroup.add(belly)

  // 頭 + 鳥喙
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), bodyMat)
  head.position.z = 0.15
  bodyGroup.add(head)
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 6), beakMat)
  beak.rotation.x = Math.PI / 2
  beak.position.z = 0.2
  bodyGroup.add(beak)

  // 雙翼：貼身側往外展開的羽翼形，用旋轉模擬振翅（拍動時繞 Z 軸讓翼尖上下擺）
  const wingGeo = makeWingGeometry()
  const wingL = new THREE.Mesh(wingGeo, bodyMat)
  wingL.position.x = -0.02
  const wingR = new THREE.Mesh(wingGeo, bodyMat)
  wingR.scale.x = -1
  wingR.position.x = 0.02
  bodyGroup.add(wingL, wingR)
  g.userData.wingL = wingL
  g.userData.wingR = wingR

  // 尾羽：貼在身體後方的小扇形
  const tail = new THREE.Mesh(makeTailGeometry(), bodyMat)
  tail.position.z = -0.16
  bodyGroup.add(tail)

  // 雙腳：細長圓柱腿 + 扁平小腳掌，固定在 g 原點正上方（原點＝停棲面接觸點）。
  // 平常飛行時整組隱藏，停棲站立時才顯示，並把 bodyGroup 墊高讓腳掌貼地
  const legs = new THREE.Group()
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, LEG_LENGTH, 6), legMat)
    leg.position.set(sx * 0.03, LEG_LENGTH / 2, 0.012)
    legs.add(leg)
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 4), legMat)
    foot.scale.set(1, 0.35, 1.8)
    foot.position.set(sx * 0.03, 0.01, 0.03)
    legs.add(foot)
  }
  legs.visible = false
  g.add(legs)
  g.userData.legs = legs

  g.traverse((o) => { if (o.isMesh) o.castShadow = true })
  return g
}

class Bird {
  // opts.near = {x,y,z}：從該點附近「驚飛」，貼地起飛往上爬升同時飛離
  // opts.over = {duelDistance}：從對戰走廊一端直直飛越雙方上空到另一端
  // opts.hover = {x,y,z,facing,holdTime}：定點懸停（除錯用，方便近距離檢查外觀），停留 holdTime 秒後自動起飛
  constructor(scene, opts = {}) {
    this.mesh = buildBirdMesh()
    if (opts.hover) {
      this.mesh.position.set(opts.hover.x, opts.hover.y, opts.hover.z)
      this.dir = (opts.hover.facing || new THREE.Vector3(1, 0, 0)).clone().normalize()
      this.speed = FLY_SPEED_MIN
    } else if (opts.near) {
      // 偏向主角左右兩側起飛（避免直接朝向/背對玩家），這樣玩家看到的是側身，翅膀才不會因為正對鏡頭而變成一條細線
      const angle = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.7
      this.mesh.position.set(opts.near.x + Math.cos(angle) * 1.4, (opts.near.y || 0) + 0.4, opts.near.z + Math.sin(angle) * 1.4)
      this.dir = new THREE.Vector3(Math.cos(angle), 0.55, Math.sin(angle)).normalize()
      this.speed = 5.5 + Math.random() * 1.5
    } else if (opts.over) {
      const half = opts.over.duelDistance / 2
      const dirSign = Math.random() < 0.5 ? 1 : -1
      const x = (Math.random() - 0.5) * 2
      const y = pickFlightHeight()
      this.mesh.position.set(x, y, dirSign * (half + 15))
      this.dir = new THREE.Vector3(0, 0, -dirSign)
      this.speed = 7 + Math.random() * 2
    } else {
      const angle = Math.random() * Math.PI * 2
      const y = pickFlightHeight()
      this.mesh.position.set(Math.cos(angle) * SPAWN_RADIUS, y, Math.sin(angle) * SPAWN_RADIUS)
      // 大致朝場地方向飛，帶一點隨機偏角，飛過場地後會繼續飛遠直到超出範圍消失
      const toCenter = new THREE.Vector3(-this.mesh.position.x, 0, -this.mesh.position.z).normalize()
      const spread = (Math.random() - 0.5) * 0.8
      this.dir = toCenter.applyAxisAngle(new THREE.Vector3(0, 1, 0), spread)
      this.speed = FLY_SPEED_MIN + Math.random() * (FLY_SPEED_MAX - FLY_SPEED_MIN)
    }
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    this.age = 0
    this.dead = false
    this.flapT = Math.random() * 10
    this.state = STATE.FLY
    this.behaviorT = 3 + Math.random() * 4   // 這個行為（目前是直線飛）還要多久才重新決定
    this.turnT = 1.5 + Math.random() * 2
    if (opts.hover) {
      this.state = STATE.PERCHED
      this.perchT = opts.hover.holdTime || 5
      this._foldWings()
      this._extendLegs()
    }
    scene.add(this.mesh)
  }

  update(dt, scene, archers) {
    this.age += dt
    if (this.state === STATE.DEAD) { this._updateDead(dt); return }
    if (this.state === STATE.PERCHED) this._updatePerched(dt)
    else if (this.state === STATE.PERCH_ARCHER) this._updatePerchArcher(dt)
    else if (this.state === STATE.CIRCLE) this._updateCircle(dt)
    else if (this.state === STATE.APPROACH) this._updateApproach(dt)
    else if (this.state === STATE.APPROACH_ARCHER) this._updateApproachArcher(dt)
    else this._updateFly(dt, scene, archers)
    // 棲息在人物身上時不受存活期限影響，等牠自己被嚇飛或停夠了再算
    if (this.age > MAX_LIFETIME && this.state !== STATE.PERCH_ARCHER) this.dead = true
  }

  _flapWings(ampScale = 1) {
    const flap = Math.sin(this.flapT * 9) * 0.9 * ampScale
    this.mesh.userData.wingL.rotation.set(0, 0, flap)
    this.mesh.userData.wingR.rotation.set(0, 0, -flap)
  }

  // 停棲/死亡時翅膀收起貼著身體，而不是攤平張開
  _foldWings() {
    this.mesh.userData.wingL.rotation.set(0, Math.PI / 2, 0)
    this.mesh.userData.wingR.rotation.set(0, -Math.PI / 2, 0)
  }

  // 起飛前把翅膀攤開回飛行姿勢，交給 _flapWings() 接手拍動
  _unfoldWings() {
    this.mesh.userData.wingL.rotation.set(0, 0, 0)
    this.mesh.userData.wingR.rotation.set(0, 0, 0)
  }

  // 降落站穩時把姿勢轉正：接近停棲點時 this.dir 通常帶著俯衝的下降角度（尤其是往地面/角色
  // 身邊降落），如果直接沿用那個朝向，站定之後會維持「頭低尾巴高」的俯衝姿勢，看起來像
  // 摔死在地上而不是站著。落地那一刻改用只保留水平分量的方向定向，站姿就會是頭尾等高、
  // 自然面向剛剛飛來的水平方向
  _levelOrientation() {
    _flatDir.set(this.dir.x, 0, this.dir.z)
    if (_flatDir.lengthSq() < 1e-6) _flatDir.copy(FWD)
    _flatDir.normalize()
    this.mesh.quaternion.setFromUnitVectors(FWD, _flatDir)
  }

  // 降落站穩：伸出雙腳，並把身體墊高 LEG_LENGTH 讓腳掌貼齊停棲面（地面/樹梢/平台/角色）
  _extendLegs() {
    this.mesh.userData.legs.visible = true
    this.mesh.userData.bodyGroup.position.y = LEG_LENGTH
  }

  // 起飛：腳收回貼身，身體回到原本的飛行姿勢高度
  _retractLegs() {
    this.mesh.userData.legs.visible = false
    this.mesh.userData.bodyGroup.position.y = 0
  }

  // 被箭射死：不再受 AI 控制，若還在空中會直直落到地面後完全靜止
  kill() {
    const airborne = this.state === STATE.FLY || this.state === STATE.CIRCLE ||
      this.state === STATE.APPROACH || this.state === STATE.APPROACH_ARCHER
    this.state = STATE.DEAD
    this.falling = airborne
    this.fallVel = 0
    this.deadT = 0
    this._foldWings()
    this._retractLegs()
  }

  _updateDead(dt) {
    this.deadT += dt
    if (this.deadT > 18) { this.dead = true; return }
    if (!this.falling) return
    const groundY = getTerrainHeightAt(this.mesh.position.x, this.mesh.position.z)
    this.fallVel -= 9.8 * dt
    this.mesh.position.y += this.fallVel * dt
    if (this.mesh.position.y <= groundY) {
      this.mesh.position.y = groundY
      this.falling = false
      this.mesh.rotation.z = (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random() * 0.5)
    }
  }

  _updateFly(dt, scene, archers) {
    this.flapT += dt
    this.mesh.position.addScaledVector(this.dir, this.speed * dt)
    // 振翅起伏：下拍有升力往上飛，上拍（回收）略微下沉，讓飛行路徑有一拱一沉的節奏
    const lift = Math.cos(this.flapT * 9)
    this.mesh.position.y += (lift > 0 ? lift * 1.6 : lift * 0.7) * dt
    this._flapWings(1)

    // 偶爾小幅度改變前進角度，不會死板地一直走直線
    this.turnT -= dt
    if (this.turnT <= 0) {
      this.turnT = 1.5 + Math.random() * 2.5
      this.dir.applyAxisAngle(UP, (Math.random() - 0.5) * 0.6)
      this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    }

    this.behaviorT -= dt
    if (this.behaviorT <= 0) this._decideNextBehavior(scene, archers)

    const d2 = this.mesh.position.x * this.mesh.position.x + this.mesh.position.z * this.mesh.position.z
    if (d2 > (SPAWN_RADIUS * 1.3) ** 2) this.dead = true
  }

  _decideNextBehavior(scene, archers) {
    const r = Math.random()
    if (r < 0.18) {
      this._startCircle()
    } else if (r < 0.3 && archers && archers.length) {
      this._startApproachArcher(archers)
    } else if (r < 0.48) {
      this._startApproachTree()
    } else if (r < 0.6) {
      this._startApproachGround()
    } else if (r < 0.68) {
      this._startApproachPlatform()
    } else {
      // 繼續飛，換個新方向、新的持續時間
      this.dir.applyAxisAngle(UP, (Math.random() - 0.5) * Math.PI * 0.7)
      this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
      this.behaviorT = 4 + Math.random() * 5
    }
  }

  // 共用：朝一個定點（樹梢/空地/平台）飛去，抵達後在 _updateApproach() 收翅膀＋伸腳站好
  _beginApproachTo(target) {
    this.perchTarget = target
    this.dir = new THREE.Vector3(
      target.x - this.mesh.position.x, target.y - this.mesh.position.y, target.z - this.mesh.position.z
    ).normalize()
    this.speed = FLY_SPEED_MIN * 0.8
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    this.state = STATE.APPROACH
  }

  _startCircle() {
    this.state = STATE.CIRCLE
    this.circleCx = this.mesh.position.x
    this.circleCz = this.mesh.position.z
    this.circleR = 2.5 + Math.random() * 3
    this.circleAngSpeed = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.4)
    this.circleAngle = Math.atan2(this.mesh.position.z - this.circleCz, this.mesh.position.x - this.circleCx)
    this.circleY = this.mesh.position.y
    this.circleT = 4 + Math.random() * 5
  }

  _updateCircle(dt) {
    this.flapT += dt
    this.circleAngle += this.circleAngSpeed * dt
    const nx = this.circleCx + Math.cos(this.circleAngle) * this.circleR
    const nz = this.circleCz + Math.sin(this.circleAngle) * this.circleR
    const moveDir = new THREE.Vector3(nx - this.mesh.position.x, 0, nz - this.mesh.position.z)
    this.mesh.position.set(nx, this.circleY, nz)
    if (moveDir.lengthSq() > 1e-6) {
      moveDir.normalize()
      this.dir.copy(moveDir)
      this.mesh.quaternion.setFromUnitVectors(FWD, moveDir)
    }
    this._flapWings(0.45)   // 盤旋比較像滑翔，拍動幅度小一點

    this.circleT -= dt
    if (this.circleT <= 0) {
      this.state = STATE.FLY
      this.speed = FLY_SPEED_MIN + Math.random() * (FLY_SPEED_MAX - FLY_SPEED_MIN)
      this.behaviorT = 4 + Math.random() * 5
      this.turnT = 1.5 + Math.random() * 2
    }
  }

  // 飛到附近一棵樹的樹梢停棲
  _startApproachTree() {
    const tops = getTreeTops()
    if (!tops || !tops.length) { this.behaviorT = 3 + Math.random() * 3; return }
    // 找一棵離目前位置不太遠的樹，避免鳥突然飛去老遠的地方
    let best = null, bestD = Infinity
    for (let i = 0; i < 8; i++) {
      const t = tops[Math.floor(Math.random() * tops.length)]
      const dx = t.x - this.mesh.position.x, dz = t.z - this.mesh.position.z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = t }
    }
    this._beginApproachTo(best)
  }

  // 飛到附近一塊空地上落地（避開走廊/水域/樹木石頭/雙方站位）
  _startApproachGround() {
    let best = null, bestD = Infinity
    for (let i = 0; i < 5; i++) {
      const spot = pickGroundSpot(32, 32, true)
      if (!spot) continue
      const dx = spot.x - this.mesh.position.x, dz = spot.z - this.mesh.position.z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = spot }
    }
    if (!best) { this.behaviorT = 3 + Math.random() * 3; return }
    this._beginApproachTo(best)
  }

  // 飛到觀戰高台上找個地方落地（在檯面範圍內隨機取點，避免每次都停在正中間）
  _startApproachPlatform() {
    const spots = getPlatformSpots()
    if (!spots || !spots.length) { this.behaviorT = 3 + Math.random() * 3; return }
    const p = spots[Math.floor(Math.random() * spots.length)]
    const ox = (Math.random() - 0.5) * 2 * p.halfW * 0.7
    const oz = (Math.random() - 0.5) * 2 * p.halfD * 0.7
    this._beginApproachTo({ x: p.x + ox, y: p.surfaceY, z: p.z + oz })
  }

  _updateApproach(dt) {
    this.flapT += dt
    this.mesh.position.addScaledVector(this.dir, this.speed * dt)
    this._flapWings(1)
    const dx = this.perchTarget.x - this.mesh.position.x
    const dy = this.perchTarget.y - this.mesh.position.y
    const dz = this.perchTarget.z - this.mesh.position.z
    if (dx * dx + dy * dy + dz * dz < 0.35 * 0.35) {
      this.mesh.position.set(this.perchTarget.x, this.perchTarget.y, this.perchTarget.z)
      this._levelOrientation()
      this._foldWings()
      this._extendLegs()
      this.state = STATE.PERCHED
      this.perchT = 3 + Math.random() * 7
    }
  }

  _updatePerched(dt) {
    this.perchT -= dt
    if (this.perchT <= 0) this._flushOff()
  }

  // 飛到主角或對手的頭上、或身邊的地上停棲，箭矢接近時會被 scareAwayBirdsOn() 嚇飛
  _startApproachArcher(archers) {
    const candidates = archers.filter((a) => !a.dead)
    if (!candidates.length) { this.behaviorT = 3 + Math.random() * 3; return }
    this.perchArcher = candidates[Math.floor(Math.random() * candidates.length)]
    this.perchOnHead = Math.random() < 0.5
    this.perchOffset = this.perchOnHead
      ? new THREE.Vector3((Math.random() - 0.5) * 0.15, 0.16, (Math.random() - 0.5) * 0.15)
      : (() => {
        const ang = Math.random() * Math.PI * 2, r = 1.2 + Math.random() * 1.3
        return new THREE.Vector3(Math.cos(ang) * r, 0.05, Math.sin(ang) * r)
      })()

    const anchor = new THREE.Vector3()
    this._getPerchArcherAnchor(anchor)
    this.dir = anchor.clone().sub(this.mesh.position).normalize()
    this.speed = FLY_SPEED_MIN * 0.8
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    this.state = STATE.APPROACH_ARCHER
  }

  _getPerchArcherAnchor(target) {
    if (this.perchOnHead) this.perchArcher.parts.head.origin.getWorldPosition(target)
    else this.perchArcher.root.getWorldPosition(target)
    target.add(this.perchOffset)
    return target
  }

  _updateApproachArcher(dt) {
    if (this.perchArcher.dead) { this._flushOff(); return }
    this.flapT += dt
    const anchor = new THREE.Vector3()
    this._getPerchArcherAnchor(anchor)
    const toAnchor = anchor.clone().sub(this.mesh.position)
    const dist = toAnchor.length()
    if (dist < 0.35) {
      this.mesh.position.copy(anchor)
      this._levelOrientation()
      this._foldWings()
      this._extendLegs()
      this.state = STATE.PERCH_ARCHER
      this.perchT = 2.5 + Math.random() * 5
      return
    }
    this.dir = toAnchor.normalize()
    this.mesh.position.addScaledVector(this.dir, this.speed * dt)
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    this._flapWings(1)
  }

  _updatePerchArcher(dt) {
    if (this.perchArcher.dead) { this._flushOff(); return }
    this._getPerchArcherAnchor(this.mesh.position)
    this.perchT -= dt
    if (this.perchT <= 0) this._flushOff()
  }

  // 驚飛：不管目前是趨近還是停棲在人物身上，立刻起飛離開（射到附近的箭矢會觸發這個）
  _flushOff() {
    const angle = Math.random() * Math.PI * 2
    this.dir = new THREE.Vector3(Math.cos(angle), 0.6, Math.sin(angle)).normalize()
    this.speed = 6.5 + Math.random() * 2
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir)
    this._unfoldWings()
    this._retractLegs()
    this.state = STATE.FLY
    this.behaviorT = 4 + Math.random() * 5
    this.turnT = 1.5 + Math.random() * 2
    this.perchArcher = null
  }
}

const birds = []
let nextCheckT = SPAWN_CHECK_MIN + Math.random() * (SPAWN_CHECK_MAX - SPAWN_CHECK_MIN)

// 讓一隻鳥從指定位置附近「驚飛」，不受同時上限/隨機計時器影響（開場想馬上看到效果時用）
export function spawnBirdFlushNear(scene, position) {
  birds.push(new Bird(scene, { near: position }))
}

// 讓一隻鳥直直飛越對戰走廊上空（主角跟對手都會被飛過），不受同時上限影響
export function spawnBirdOverCorridor(scene, duelDistance) {
  birds.push(new Bird(scene, { over: { duelDistance } }))
}

// 除錯用：在指定檯面（例如附近看臺）上排開幾隻鳥定點懸停，各自面向不同方向，
// 方便近距離檢查外觀，幾秒後自動起飛散開。center 為檯面上的世界座標。
export function spawnBirdLineup(scene, center, count = 5) {
  const r = 0.55
  for (let i = 0; i < count; i++) {
    const posAngle = (i / count) * Math.PI * 2
    const facingAngle = posAngle + Math.PI * 0.37 + Math.random() * 0.6   // 面向角度跟位置角度錯開，看起來各自朝不同方向
    birds.push(new Bird(scene, {
      hover: {
        x: center.x + Math.cos(posAngle) * r,
        y: center.y,
        z: center.z + Math.sin(posAngle) * r,
        facing: new THREE.Vector3(Math.cos(facingAngle), 0, Math.sin(facingAngle)),
        holdTime: 5,
      },
    }))
  }
}

// 箭矢接近某個角色時呼叫：把停在他頭上/身邊、或正要飛過去的鳥立刻嚇飛
export function scareAwayBirdsOn(archer) {
  for (const b of birds) {
    if (b.perchArcher === archer && (b.state === STATE.PERCH_ARCHER || b.state === STATE.APPROACH_ARCHER)) {
      b._flushOff()
    }
  }
}

// 測試箭矢本幀掃過的路徑（prevPos→currPos）有沒有打中任何一隻活著的鳥，回傳最近的一隻（沒打中回傳 null）
export function testArrowHitBird(prevPos, currPos, arrowRadius) {
  const seg = new THREE.Vector3().subVectors(currPos, prevPos)
  const len2 = seg.lengthSq()
  let best = null, bestDist = Infinity
  for (const b of birds) {
    if (b.state === STATE.DEAD) continue
    let t = len2 > 1e-8 ? new THREE.Vector3().subVectors(b.mesh.position, prevPos).dot(seg) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const closest = prevPos.clone().addScaledVector(seg, t)
    const d = closest.distanceTo(b.mesh.position)
    if (d <= arrowRadius + BIRD_HIT_RADIUS && d < bestDist) { bestDist = d; best = b }
  }
  return best
}

// 射死一隻鳥：從此不再受 AI 控制，若還在空中會直直落地後完全靜止
export function killBird(bird) {
  bird.kill()
}

// 每幀呼叫：計時到了就擲骰決定要不要生新的環境鳥，並更新所有現存鳥的飛行/振翅
// archers：[playerArcher, aiArcher]，讓鳥有機會飛去停在他們頭上或身邊
export function updateBirds(dt, scene, archers) {
  nextCheckT -= dt
  if (nextCheckT <= 0) {
    nextCheckT = SPAWN_CHECK_MIN + Math.random() * (SPAWN_CHECK_MAX - SPAWN_CHECK_MIN)
    if (birds.length < MAX_BIRDS && Math.random() < SPAWN_CHANCE) {
      birds.push(new Bird(scene))
    }
  }
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i]
    b.update(dt, scene, archers)
    if (b.dead) { b.mesh.removeFromParent(); birds.splice(i, 1) }
  }
}
