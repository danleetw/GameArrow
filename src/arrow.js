import * as THREE from 'three'
import { getWindVector } from './wind.js'
import { getPlatformSpots } from './scene.js'

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
