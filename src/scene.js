import * as THREE from 'three'
import { getWindAngle, getWindSpeed } from './wind.js'

// ============================================================
//  場地佈置：地形起伏 + 湖泊 + 河流 + 樹木 + 石頭 + 草叢 + 觀戰高台 + 風向旗
//  全部程序化生成，不依賴外部素材。對戰走廊（雙方站位/箭矢飛行的走道）
//  強制維持 y=0 完全平坦，因為 arrow.js 的落地判定是寫死 GROUND_Y=0，
//  場景佈置只能動走廊「外面」的地形，避免破壞箭矢物理。
// ============================================================

const swayables = []   // { group, phase, freq, amp }：樹木/草叢，每幀依風向風速搖晃
let swayT = 0
const treeTops = []    // { x, y, z }：每棵樹概略的樹梢世界座標，供 birds.js 挑選停棲點
const obstacleSpots = []   // { x, z, r }：樹木/石頭的概略碰撞圓，供 zombie.js 繞路判斷

// ---- 雲：分幾個高度層，越高飄越快，沿風向漂移，飄出範圍就傳送到對面繼續飄 ----
const CLOUD_LAYERS = [
  { y: 30, speedMul: 0.3, count: 6, scale: 3.4 },
  { y: 44, speedMul: 0.6, count: 5, scale: 4.4 },
  { y: 58, speedMul: 1.1, count: 4, scale: 5.4 },
]
const CLOUD_BOUND = 150
const CLOUD_SPEED = 1.4
const clouds = []   // { group, speedMul }

// ---- 固定種子亂數，讓場景佈置每次重整都一樣，方便邊調邊看 ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260712)

// ---- 簡易 2D 值噪聲（fBm），純函式不依賴外部函式庫 ----
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}
function noise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
function fbm(x, y, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0
  for (let i = 0; i < octaves; i++) { sum += amp * (noise2D(x * freq, y * freq) * 2 - 1); freq *= 2; amp *= 0.5 }
  return sum
}
const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

// ---- 場地佈局：對戰走廊 + 湖泊 + 河流路徑（座標都在走廊外，安全不重疊）----
const CORRIDOR_HALF_W = 4.2
let corridorHalfLen = 12
let archerZ = 12.5              // 雙方站位的 z 座標（絕對值），依 duelDistance/2 算出
const MIN_ZOMBIE_SPAWN_DIST = 12   // 殭屍生成點離任一方站位至少要這麼遠，避免一出生就貼在人旁邊
const LAKE = { cx: -18, cz: 4, rx: 9, rz: 6.5 }
const RIVER = { points: [[26, -85], [20, -45], [16, -16], [12, -6], [15, 4], [10, 14], [13, 22], [16, 45], [22, 85]], width: 4.5 }

function isInCorridor(x, z) {
  return Math.abs(x) < CORRIDOR_HALF_W && Math.abs(z) < corridorHalfLen
}
function distToLake(x, z) {
  const dx = (x - LAKE.cx) / LAKE.rx, dz = (z - LAKE.cz) / LAKE.rz
  return Math.sqrt(dx * dx + dz * dz)   // < 1 代表在湖泊範圍內
}
function distToRiver(x, z) {
  let best = Infinity
  for (let i = 0; i < RIVER.points.length - 1; i++) {
    const [x1, z1] = RIVER.points[i], [x2, z2] = RIVER.points[i + 1]
    const dx = x2 - x1, dz = z2 - z1
    const len2 = dx * dx + dz * dz
    let t = len2 > 0 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz))
    if (d < best) best = d
  }
  return best
}

// 走廊內強制回傳 0（完全平坦），走廊外才套用噪聲起伏 + 湖泊/河流挖低
function terrainHeight(x, z) {
  if (isInCorridor(x, z)) return 0
  const cMask = Math.max(Math.min(Math.abs(x) / CORRIDOR_HALF_W, 1), Math.min(Math.abs(z) / corridorHalfLen, 1))
  let h = fbm(x * 0.045, z * 0.045, 4) * 2.0 * smoothstep(cMask)
  const lakeD = distToLake(x, z)
  if (lakeD < 1.25) h -= (1.25 - lakeD) * 2.4
  const riverD = distToRiver(x, z)
  if (riverD < RIVER.width * 0.9) h -= (RIVER.width * 0.9 - riverD) * 0.55
  return h
}

let platformSpots = []   // {x, z, r}：觀戰高台位置，依 duelDistance 算出，避免樹木長到高台上
function isFreeSpot(x, z) {
  if (isInCorridor(x, z)) return false
  if (distToLake(x, z) < 1.4) return false
  if (distToRiver(x, z) < RIVER.width * 1.1) return false
  for (const p of platformSpots) {
    const dx = x - p.x, dz = z - p.z
    if (dx * dx + dz * dz < p.r * p.r) return false
  }
  return true
}
function pickSpot(rangeX, rangeZ, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const x = (rand() * 2 - 1) * rangeX
    const z = (rand() * 2 - 1) * rangeZ
    if (isFreeSpot(x, z)) return { x, z, y: terrainHeight(x, z) }
  }
  return null
}

function buildGroundTexture(renderer) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#7a9a4e'; ctx.fillRect(0, 0, s, s)
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * s, y = Math.random() * s
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(160,190,110,0.30)' : 'rgba(60,90,40,0.28)'
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(40, 40)
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return tex
}

function buildGround(scene, renderer) {
  const size = 160, seg = 100
  const geo = new THREE.PlaneGeometry(size, size, seg, seg)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i)   // 旋轉前局部座標：world x = lx, world z = -ly
    pos.setZ(i, terrainHeight(lx, -ly))
  }
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: buildGroundTexture(renderer), roughness: 1 }))
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  scene.add(mesh)
}

function buildWater(scene) {
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x3f7ea8, roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.88 })
  const lakeGeo = new THREE.CircleGeometry(1, 48)
  lakeGeo.scale(LAKE.rx, LAKE.rz, 1)
  const lake = new THREE.Mesh(lakeGeo, waterMat)
  lake.rotation.x = -Math.PI / 2
  lake.position.set(LAKE.cx, 0.03, LAKE.cz)
  scene.add(lake)

  // 河流：沿路徑點串出一連串重疊的水面色塊，避免用複雜曲線幾何
  for (let i = 0; i < RIVER.points.length - 1; i++) {
    const [x1, z1] = RIVER.points[i], [x2, z2] = RIVER.points[i + 1]
    const dx = x2 - x1, dz = z2 - z1
    const len = Math.hypot(dx, dz)
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(RIVER.width, len + RIVER.width * 0.6), waterMat)
    seg.rotation.x = -Math.PI / 2
    seg.rotation.z = -Math.atan2(dz, dx) + Math.PI / 2
    seg.position.set((x1 + x2) / 2, 0.03, (z1 + z2) / 2)
    scene.add(seg)
  }
  return waterMat
}

function buildRoundTree() {
  const g = new THREE.Group()
  const trunkH = 1.6 + rand() * 0.6
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.18, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: 0x5c4326, roughness: 0.9 })
  )
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  g.add(trunk)
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x3d7a34, roughness: 0.85 })
  const clumps = 3 + Math.floor(rand() * 2)
  for (let i = 0; i < clumps; i++) {
    const r = 0.9 + rand() * 0.5
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), foliageMat)
    m.position.set((rand() - 0.5) * 1.1, trunkH + r * 0.6 + rand() * 0.5, (rand() - 0.5) * 1.1)
    m.castShadow = true
    g.add(m)
  }
  g.userData.topY = trunkH + 1.9   // 樹梢概略高度，供鳥停棲使用
  return g
}

function buildPineTree() {
  const g = new THREE.Group()
  const trunkH = 1.2 + rand() * 0.4
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.16, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.9 })
  )
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  g.add(trunk)
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2d5c33, roughness: 0.85 })
  let y = trunkH * 0.5
  for (let i = 0; i < 3; i++) {
    const h = 1.5 - i * 0.35, r = 1.0 - i * 0.25
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), foliageMat)
    m.position.y = y + h * 0.4
    m.castShadow = true
    g.add(m)
    y += h * 0.55
  }
  g.userData.topY = trunkH + 1.85   // 樹梢概略高度，供鳥停棲使用
  return g
}

function buildRock() {
  const s = 0.35 + rand() * 0.5
  const m = new THREE.Mesh(
    new THREE.DodecahedronGeometry(s, 0),
    new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.95, flatShading: true })
  )
  m.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function buildGrassTuft() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0x5fae3f, roughness: 0.9, side: THREE.DoubleSide })
  for (let i = 0; i < 5; i++) {
    const h = 0.25 + rand() * 0.2
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.02, h, 3), mat)
    blade.position.set((rand() - 0.5) * 0.2, h / 2, (rand() - 0.5) * 0.2)
    blade.rotation.z = (rand() - 0.5) * 0.3
    g.add(blade)
  }
  return g
}

function buildPlatform(w, d, h) {
  const g = new THREE.Group()
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(w, 0.25, d),
    new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.85 })
  )
  top.position.y = h
  top.castShadow = true
  top.receiveShadow = true
  g.add(top)
  const legMat = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.9 })
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, h, 6), legMat)
    leg.position.set(sx * (w / 2 - 0.3), h / 2, sz * (d / 2 - 0.3))
    leg.castShadow = true
    g.add(leg)
  }
  return g
}

// 主入口：建立整個場地（地形/水面/植被/道具）。duelDistance 用來算對戰走廊要留多長。
export function buildEnvironment(scene, renderer, duelDistance) {
  corridorHalfLen = duelDistance / 2 + 3
  archerZ = duelDistance / 2
  const platformZ = duelDistance * 0.3
  platformSpots = [
    { x: 6.8, z: platformZ, r: 3.2 },
    { x: 6.8, z: -platformZ, r: 3.2 },
  ].map((p) => {
    const y = terrainHeight(p.x, p.z)
    const surfaceY = y + 1.1 + 0.125   // 檯面實際頂面高度：板厚 0.25（半厚 0.125）疊在 h=1.1 上
    // halfW/halfD 對應 buildPlatform(3.2, 2.2, ...) 的檯面尺寸一半，給箭矢碰撞判定用
    return { ...p, y, surfaceY, topY: surfaceY + 0.08, halfW: 1.6, halfD: 1.1 }
  })

  buildGround(scene, renderer)
  buildWater(scene)

  for (let i = 0; i < 20; i++) {
    const spot = pickSpot(38, 38)
    if (!spot) continue
    const tree = rand() < 0.5 ? buildRoundTree() : buildPineTree()
    tree.position.set(spot.x, spot.y, spot.z)
    tree.rotation.y = rand() * Math.PI * 2
    const s = 0.85 + rand() * 0.5
    tree.scale.setScalar(s)
    scene.add(tree)
    swayables.push({ group: tree, phase: rand() * 10, freq: 0.7 + rand() * 0.3, amp: 0.11 })
    treeTops.push({ x: spot.x, y: spot.y + tree.userData.topY * s, z: spot.z })
    obstacleSpots.push({ x: spot.x, z: spot.z, r: 0.45 * s })
  }

  for (let i = 0; i < 8; i++) {
    const spot = pickSpot(35, 35)
    if (!spot) continue
    const n = 2 + Math.floor(rand() * 3)
    for (let j = 0; j < n; j++) {
      const rock = buildRock()
      rock.position.set(spot.x + (rand() - 0.5) * 1.2, spot.y, spot.z + (rand() - 0.5) * 1.2)
      obstacleSpots.push({ x: rock.position.x, z: rock.position.z, r: 0.4 })
      scene.add(rock)
    }
  }

  for (let i = 0; i < 30; i++) {
    const spot = pickSpot(30, 20)
    if (!spot) continue
    const tuft = buildGrassTuft()
    tuft.position.set(spot.x, spot.y, spot.z)
    tuft.rotation.y = rand() * Math.PI * 2
    scene.add(tuft)
    swayables.push({ group: tuft, phase: rand() * 10, freq: 1.4 + rand() * 0.6, amp: 0.4 })
  }

  // 兩座觀戰高台，分別在場地兩側，貼著該處的地形高度放置避免浮空/插地
  for (const p of platformSpots) {
    const plat = buildPlatform(3.2, 2.2, 1.1)
    plat.position.set(p.x, terrainHeight(p.x, p.z), p.z)
    scene.add(plat)
  }

  // 風向旗：主角右邊 5 公尺、再往對手方向前移 2 公尺，站在主角視野內比較看得到飄動
  const vaneX = 5, vaneZ = duelDistance / 2 - 2
  buildWindVane(scene, vaneX, vaneZ)
  buildClouds(scene)
}

// 給 birds.js 用：所有樹梢的世界座標，鳥要停棲時從這裡挑
export function getTreeTops() {
  return treeTops
}

// 給 main.js 用：觀戰高台的位置與地面高度/檯面高度，方便算出檯面上的世界座標
export function getPlatformSpots() {
  return platformSpots
}

// 給 main.js 用：找一塊不在湖泊河流/看台範圍內的空地座標；avoidObstacles=true 時
// 還會額外排開樹木/石頭的碰撞圓，確保不會生成在無法行走的障礙物上面或裡面（例如生成殭屍時用）。
// 另外強制離雙方站位至少 MIN_ZOMBIE_SPAWN_DIST 公尺，避免對戰走廊只用窄窄的走道寬度隔開，
// 導致生成點剛好貼在走廊外緣、又跟某一方站位同一個 z，一出生就幾乎黏在人旁邊。
export function pickGroundSpot(rangeX = 35, rangeZ = 35, avoidObstacles = false) {
  for (let i = 0; i < 30; i++) {
    const spot = pickSpot(rangeX, rangeZ)
    if (!spot) return null
    const dPlayer = Math.hypot(spot.x, spot.z - archerZ)
    const dOpponent = Math.hypot(spot.x, spot.z + archerZ)
    if (dPlayer < MIN_ZOMBIE_SPAWN_DIST || dOpponent < MIN_ZOMBIE_SPAWN_DIST) continue
    if (!avoidObstacles) return spot
    let blocked = false
    for (const o of obstacleSpots) {
      const dx = spot.x - o.x, dz = spot.z - o.z
      if (dx * dx + dz * dz < (o.r + 0.5) ** 2) { blocked = true; break }
    }
    if (!blocked) return spot
  }
  return null
}

// 給 zombie.js 用：(x,z) 是否在湖泊或河流的水域範圍內
export function isWaterAt(x, z) {
  return distToLake(x, z) < 1.25 || distToRiver(x, z) < RIVER.width * 0.5
}

// 給 zombie.js 用：樹木/石頭的概略碰撞圓陣列，供繞路判斷
export function getObstacles() {
  return obstacleSpots
}

// 給 birds.js 用：查詢任意座標的地形高度（例如鳥被射落要掉到地面時）
export function getTerrainHeightAt(x, z) {
  return terrainHeight(x, z)
}

function buildCloudPuff(scale) {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.88 })
  const n = 4 + Math.floor(rand() * 3)
  for (let i = 0; i < n; i++) {
    const r = (0.5 + rand() * 0.5) * scale
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat)
    m.position.set((rand() - 0.5) * scale * 1.6, (rand() - 0.5) * scale * 0.3, (rand() - 0.5) * scale * 1.2)
    g.add(m)
  }
  return g
}

function buildClouds(scene) {
  for (const layer of CLOUD_LAYERS) {
    for (let i = 0; i < layer.count; i++) {
      const puff = buildCloudPuff(layer.scale)
      puff.position.set((rand() * 2 - 1) * CLOUD_BOUND, layer.y, (rand() * 2 - 1) * CLOUD_BOUND)
      scene.add(puff)
      clouds.push({ group: puff, speedMul: layer.speedMul })
    }
  }
}

function buildWindVane(scene, x, z) {
  const g = new THREE.Group()
  g.position.set(x, terrainHeight(x, z), z)

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.05, 2.2, 6),
    new THREE.MeshStandardMaterial({ color: 0x5c4326, roughness: 0.85 })
  )
  pole.position.y = 1.1
  pole.castShadow = true
  g.add(pole)

  const flagGroup = new THREE.Group()
  flagGroup.position.y = 1.9
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.36, 5, 2),
    new THREE.MeshStandardMaterial({ color: 0xd8432f, roughness: 0.8, side: THREE.DoubleSide })
  )
  flag.position.x = 0.32
  flag.castShadow = true
  flagGroup.add(flag)
  g.add(flagGroup)
  scene.add(g)

  const basePos = flag.geometry.attributes.position.array.slice()
  swayables.push({ flagGroup, flag, basePos, isFlag: true })
}

// 每幀呼叫：讓樹木/草叢依風向風速搖晃，風向旗轉向並飄動
export function updateEnvironment(dt) {
  swayT += dt
  const angle = getWindAngle()
  const speed = getWindSpeed()
  const strength = Math.min(1, speed / 3)
  const cosA = Math.cos(angle), sinA = Math.sin(angle)

  for (const s of swayables) {
    if (s.isFlag) {
      s.flagGroup.rotation.y = angle
      const pos = s.flag.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const bx = s.basePos[i * 3]
        pos.setZ(i, Math.sin(swayT * 6 + bx * 5) * 0.05 * strength)
      }
      pos.needsUpdate = true
      s.flag.rotation.z = Math.sin(swayT * 3) * 0.05 * strength
      continue
    }
    const wob = Math.sin(swayT * s.freq + s.phase) * s.amp * strength
    s.group.rotation.x = sinA * wob
    s.group.rotation.z = cosA * wob
  }

  for (const c of clouds) {
    c.group.position.x += cosA * CLOUD_SPEED * c.speedMul * dt
    c.group.position.z += sinA * CLOUD_SPEED * c.speedMul * dt
    const d2 = c.group.position.x * c.group.position.x + c.group.position.z * c.group.position.z
    if (d2 > CLOUD_BOUND * CLOUD_BOUND) {
      c.group.position.x *= -0.98
      c.group.position.z *= -0.98
    }
  }
}
