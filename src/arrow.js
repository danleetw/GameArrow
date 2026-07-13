import * as THREE from 'three'
import { getWindVector } from './wind.js'
import { getPlatformSpots, getSpecialObstacle } from './scene.js'

export const GRAVITY = -9.82
export const CHARGE_TIME = 0.9
export const SPEED_MIN = 26, SPEED_MAX = 52
export const ARROW_RADIUS = 0.06
const GROUND_Y = 0
const WIND_ACCEL = 0.8   // 風速轉換成箭矢側向加速度的係數，箭矢飛越久累積的偏移越明顯
const _windTmp = new THREE.Vector3()
const FLIGHT_TIMEOUT = 6      // 飛太久（脫靶飛出場外）強制清除
const STUCK_LIFETIME = 10     // 插地/插人後停留幾秒再清除
const MAX_ARROWS = 40         // 場上箭矢上限，超過時清最舊的已插地箭

// 查詢 (x,z) 正下方有沒有看台之類的檯面，有的話回傳它（含 surfaceY 頂面高度），
// 讓箭矢落地判定除了走廊地面外也認得這些額外的立體物件，不會直接穿過去
function findPlatformUnder(x, z) {
  for (const p of getPlatformSpots()) {
    if (Math.abs(x - p.x) < p.halfW && Math.abs(z - p.z) < p.halfD) return p
  }
  return null
}

// 3D 線段（p0→p1）跟一個 AABB 包圍盒相不相交（slab method）：用整段掃過的路徑測試，
// 不是只測終點座標，避免箭矢速度太快、一幀之內直接「穿過」障礙物那層薄薄的厚度（tunneling）
function segmentIntersectsBox(p0, p1, boxMin, boxMax) {
  let tmin = 0, tmax = 1
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z
  const axes = [
    [p0.x, dx, boxMin.x, boxMax.x],
    [p0.y, dy, boxMin.y, boxMax.y],
    [p0.z, dz, boxMin.z, boxMax.z],
  ]
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return false
    } else {
      let t1 = (mn - o) / d, t2 = (mx - o) / d
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return false
    }
  }
  return true
}

// Level 6 專屬的移動障礙物：測這一幀掃過的路徑有沒有撞進去，有的話箭矢卡在障礙物上
// （回傳障礙物本身，呼叫端要負責把箭矢 attach 上去，才會跟著障礙物一起滑動）
function findObstacleHit(prevPos, currPos) {
  const obs = getSpecialObstacle()
  if (!obs) return null
  const boxMin = { x: obs.x - obs.halfW - ARROW_RADIUS, y: obs.y0, z: obs.z - obs.halfD - ARROW_RADIUS }
  const boxMax = { x: obs.x + obs.halfW + ARROW_RADIUS, y: obs.y0 + obs.height, z: obs.z + obs.halfD + ARROW_RADIUS }
  return segmentIntersectsBox(prevPos, currPos, boxMin, boxMax) ? obs : null
}

// 羽毛用弧形收尖的形狀，比單純長方形細緻，末端尖、根部圓潤貼著箭身
function makeFeatherGeometry() {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.quadraticCurveTo(0.034, 0.05, 0.016, 0.135)
  s.quadraticCurveTo(0.005, 0.085, 0, 0)
  const geo = new THREE.ShapeGeometry(s, 10)
  geo.center()
  return geo
}

function buildArrowMesh() {
  const g = new THREE.Group()
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 })
  )
  shaft.rotation.x = Math.PI / 2
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.032, 0.18, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.6, roughness: 0.3 })
  )
  head.rotation.x = Math.PI / 2   // 錐尖朝 +Z（箭矢前進方向），先前反了變成寬的那端朝前
  head.position.z = 0.53
  const fletchMat = new THREE.MeshStandardMaterial({ color: 0xf0392b, side: THREE.DoubleSide, roughness: 0.9 })
  const featherGeo = makeFeatherGeometry()
  const fletchA = new THREE.Mesh(featherGeo, fletchMat)
  fletchA.position.z = -0.44
  const fletchB = fletchA.clone()
  fletchB.rotation.z = Math.PI / 2
  g.add(shaft, head, fletchA, fletchB)
  g.scale.setScalar(1.76)
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true } })
  return g
}

// 手動積分運動學箭矢（不用 cannon-es Body）：位置+速度+重力，
// 命中偵測改由 M4 的掃描式線段測試負責，這裡只做飛行與落地/場外清除
export class Arrow {
  constructor(startPos, dir, speed, ownerSide) {
    this.mesh = buildArrowMesh()
    this.mesh.position.copy(startPos)
    this.velocity = dir.clone().normalize().multiplyScalar(speed)
    this.prevPos = startPos.clone()
    this.ownerSide = ownerSide   // 'player' | 'ai'，M4 用來判斷該測試哪一方的命中區
    this.stuck = false
    this.age = 0
    this.dead = false
    this._orient()
  }

  _orient() {
    const dir = this.velocity.lengthSq() > 0 ? this.velocity.clone().normalize() : new THREE.Vector3(0, 0, 1)
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
  }

  update(dt) {
    this.age += dt
    if (this.stuck) {
      if (this.age > STUCK_LIFETIME) this.dead = true
      return
    }
    this.prevPos.copy(this.mesh.position)
    const wind = getWindVector(_windTmp)
    this.velocity.x += wind.x * WIND_ACCEL * dt
    this.velocity.z += wind.z * WIND_ACCEL * dt
    this.velocity.y += GRAVITY * dt
    this.mesh.position.addScaledVector(this.velocity, dt)
    this._orient()

    // Level 6 的移動障礙物：這一幀掃過的路徑撞進去了，箭矢卡在障礙物上，並且 attach 上去
    // （障礙物本身會滑動，attach 之後箭矢會保持相對位置跟著一起動，不會插在半空中的固定點）
    const obstacle = findObstacleHit(this.prevPos, this.mesh.position)
    if (obstacle) {
      this.stuck = true
      this.age = 0
      obstacle.mesh.attach(this.mesh)
      return
    }

    // 看台這類額外的檯面：這一幀從檯面上方掉到檯面高度以下，就卡在檯面上，不會直接穿過去
    const plat = findPlatformUnder(this.mesh.position.x, this.mesh.position.z)
    if (plat && this.prevPos.y > plat.surfaceY && this.mesh.position.y <= plat.surfaceY + ARROW_RADIUS) {
      this.mesh.position.y = plat.surfaceY + ARROW_RADIUS
      this.stuck = true
      this.age = 0
      return
    }

    if (this.mesh.position.y <= GROUND_Y + ARROW_RADIUS) {
      this.mesh.position.y = GROUND_Y + ARROW_RADIUS
      this.stuck = true
      this.age = 0
    } else if (this.age > FLIGHT_TIMEOUT) {
      this.dead = true
    }
  }
}

export class ArrowManager {
  constructor(scene) {
    this.scene = scene
    this.arrows = []
  }

  spawn(startPos, dir, speed, ownerSide) {
    const a = new Arrow(startPos, dir, speed, ownerSide)
    this.scene.add(a.mesh)
    this.arrows.push(a)
    this._enforceCap()
    return a
  }

  _enforceCap() {
    while (this.arrows.length > MAX_ARROWS) {
      const idx = this.arrows.findIndex((a) => a.stuck)
      const victim = idx >= 0 ? this.arrows.splice(idx, 1)[0] : this.arrows.shift()
      victim.mesh.removeFromParent()   // 命中人物的箭矢會被 attach() 改掛到骨骼上，不一定是 scene 的直接子節點
    }
  }

  update(dt) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i]
      a.update(dt)
      if (a.dead) {
        a.mesh.removeFromParent()
        this.arrows.splice(i, 1)
      }
    }
  }

  clear() {
    for (const a of this.arrows) a.mesh.removeFromParent()
    this.arrows.length = 0
  }
}

// 蓄力中的彈道預測弧線（純運動學模擬，和實際飛行用同一組公式，不吃物理世界）
export class TrajectoryPreview {
  constructor(scene, dotCount = 22) {
    this.scene = scene
    this.dots = []
    const geo = new THREE.SphereGeometry(0.035, 6, 6)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.85 })
    for (let i = 0; i < dotCount; i++) {
      const m = new THREE.Mesh(geo, mat)
      m.visible = false
      scene.add(m)
      this.dots.push(m)
    }
  }

  show(origin, dir, speed) {
    const v = dir.clone().normalize().multiplyScalar(speed)
    const p = origin.clone()
    const wind = getWindVector(_windTmp)
    const step = 0.06
    let i = 0
    let prevY = p.y
    while (i < this.dots.length) {
      v.x += wind.x * WIND_ACCEL * step
      v.z += wind.z * WIND_ACCEL * step
      v.y += GRAVITY * step
      prevY = p.y
      p.addScaledVector(v, step)
      const plat = findPlatformUnder(p.x, p.z)
      if (plat && prevY > plat.surfaceY && p.y <= plat.surfaceY) break
      if (p.y <= GROUND_Y) break
      this.dots[i].position.copy(p)
      this.dots[i].visible = true
      i++
    }
    for (; i < this.dots.length; i++) this.dots[i].visible = false
  }

  hide() {
    for (const d of this.dots) d.visible = false
  }
}
