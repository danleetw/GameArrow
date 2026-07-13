import * as THREE from 'three'
import { getWindAngle, getWindSpeed } from './wind.js'

// ============================================================
//  場地佈置：地形起伏 + 湖泊 + 河流 + 樹木 + 石頭 + 草叢 + 觀戰高台 + 風向旗
//  全部程序化生成，不依賴外部素材。對戰走廊（雙方站位/箭矢飛行的走道）
//  強制維持 y=0 完全平坦，因為 arrow.js 的落地判定是寫死 GROUND_Y=0，
//  場景佈置只能動走廊「外面」的地形，避免破壞箭矢物理。
//
//  關卡系統：buildEnvironment(scene, renderer, duelDistance, level) 依 level（1~10）
//  從 THEMES 挑一套配色/密度/特殊道具佈置場景，換關時 clearEnvironment() 會先把上一關
//  的場地物件全部移除並釋放記憶體，才不會越玩物件越堆越多。
// ============================================================

const swayables = []   // { group, phase, freq, amp }：樹木/草叢，每幀依風向風速搖晃
let swayT = 0
const treeTops = []    // { x, y, z }：每棵樹（含水晶叢）概略的樹梢世界座標，供 birds.js 挑選停棲點
const obstacleSpots = []   // { x, z, r }：樹木/石頭的概略碰撞圓，供 zombie.js 繞路判斷
const sceneObjects = []   // 這關加進 scene 的所有頂層物件，換關時用來整批移除＋釋放資源

// ---- 雲：分幾個高度層，越高飄越快，沿風向漂移，飄出範圍就傳送到對面繼續飄 ----
const CLOUD_LAYERS = [
  { y: 30, speedMul: 0.3, count: 6, scale: 3.4 },
  { y: 44, speedMul: 0.6, count: 5, scale: 4.4 },
  { y: 58, speedMul: 1.1, count: 4, scale: 5.4 },
]
const CLOUD_BOUND = 150
const CLOUD_SPEED = 1.4
const clouds = []   // { group, speedMul }

// ---- 可重新播種的亂數：每關用不同種子，讓每個關卡的樹木/石頭佈置固定但彼此不同 ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rand = mulberry32(20260712)

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

// ============================================================
//  關卡主題：10 關由淺入深——森林 → 秋楓 → 雪原 → 荒漠 → 熔岩 → 櫻花 → 沼澤 → 極光雪峰
//  → 水晶秘境 → 終焉競技場。越高關越華麗（發光道具、更密的植被、專屬造景），
//  第 1 關維持跟原本一模一樣的種子與配色，畫面完全不變。
// ============================================================
export const LEVEL_COUNT = 10
const THEMES = [
  null, // index 0 不用，關卡從 1 開始
  { // Lv1 翠綠森林
    name: '翠綠森林', seed: 20260712,
    ground: ['#7a9a4e', 'rgba(160,190,110,0.30)', 'rgba(60,90,40,0.28)'],
    trunk: 0x5c4326, pineTrunk: 0x4a3420, foliage: 0x3d7a34, pineFoliage: 0x2d5c33,
    rock: 0x8a8478, grass: 0x5fae3f, water: 0x3f7ea8,
    treeCount: 20, rockClusterCount: 8, grassCount: 30, treeMode: 'normal',
  },
  { // Lv2 楓紅秋林
    name: '楓紅秋林', seed: 20260713,
    ground: ['#8a6a3a', 'rgba(224,140,54,0.32)', 'rgba(150,60,24,0.28)'],
    trunk: 0x5c4326, pineTrunk: 0x4a3420, foliage: 0xd2691e, pineFoliage: 0x8a5a1e,
    rock: 0x9a7a5a, grass: 0xc9962f, water: 0x4f8ea8,
    treeCount: 22, rockClusterCount: 8, grassCount: 28, treeMode: 'normal',
  },
  { // Lv3 銀白雪原
    name: '銀白雪原', seed: 20260714,
    ground: ['#dfe6ec', 'rgba(255,255,255,0.40)', 'rgba(180,200,220,0.30)'],
    trunk: 0x4a3a2c, pineTrunk: 0x3a2e22, foliage: 0xcfe0e8, pineFoliage: 0x28503e,
    rock: 0xb8c4cc, grass: 0xd8e4ea, water: 0x6fb8d8,
    treeCount: 20, rockClusterCount: 9, grassCount: 20, treeMode: 'normal',
  },
  { // Lv4 荒漠峽谷
    name: '荒漠峽谷', seed: 20260715,
    ground: ['#c9a15a', 'rgba(224,180,110,0.30)', 'rgba(150,100,50,0.28)'],
    trunk: 0x5a4020, pineTrunk: 0x5a4020, foliage: 0x6a8a3a, pineFoliage: 0x5a7a2a,
    rock: 0xa85a3a, grass: 0x8a7a3a, water: 0x3a9a8a,
    treeCount: 10, rockClusterCount: 12, grassCount: 15, treeMode: 'normal', extra: 'cactus',
  },
  { // Lv5 熔岩地獄
    name: '熔岩地獄', seed: 20260716,
    ground: ['#3a2a28', 'rgba(120,40,20,0.35)', 'rgba(20,10,10,0.30)'],
    trunk: 0x2a1e18, pineTrunk: 0x2a1e18, foliage: 0x3a2822, pineFoliage: 0x2a1e18,
    rock: 0x4a2a1e, rockEmissive: 0xaa3300, grass: 0x5a2a18, grassEmissive: 0x882200,
    water: 0xb8441a,
    treeCount: 8, rockClusterCount: 14, grassCount: 18, treeMode: 'normal', extra: 'embers',
  },
  { // Lv6 粉櫻樂園
    name: '粉櫻樂園', seed: 20260717,
    ground: ['#8fae5a', 'rgba(255,200,220,0.30)', 'rgba(120,170,90,0.25)'],
    trunk: 0x6a4a3a, pineTrunk: 0x5c4326, foliage: 0xf4a8c4, pineFoliage: 0x3d7a34,
    rock: 0x9a9488, grass: 0x6fbf4f, water: 0x5aa8c8,
    treeCount: 24, rockClusterCount: 6, grassCount: 34, treeMode: 'normal',
  },
  { // Lv7 迷霧沼澤
    name: '迷霧沼澤', seed: 20260718,
    ground: ['#4a5a3a', 'rgba(90,110,60,0.30)', 'rgba(30,40,20,0.32)'],
    trunk: 0x3a3226, pineTrunk: 0x2e281e, foliage: 0x4a5a2a, pineFoliage: 0x3a4a22,
    rock: 0x5a5a48, grass: 0x6a8a3a, grassEmissive: 0x2a6a3a, water: 0x3a4a2a,
    treeCount: 26, rockClusterCount: 6, grassCount: 36, treeMode: 'normal', extra: 'mushrooms',
  },
  { // Lv8 極光雪峰
    name: '極光雪峰', seed: 20260719,
    ground: ['#5a6a8a', 'rgba(140,160,220,0.32)', 'rgba(60,50,120,0.28)'],
    trunk: 0x3a3a4a, pineTrunk: 0x2e2e3e, foliage: 0x7a8ac8, pineFoliage: 0x4a5a9a,
    rock: 0x8a94b8, rockEmissive: 0x4444aa, grass: 0x6a7ab8, water: 0x4a6ab8,
    treeCount: 18, rockClusterCount: 10, grassCount: 22, treeMode: 'normal',
  },
  { // Lv9 水晶秘境
    name: '水晶秘境', seed: 20260720,
    ground: ['#2a2438', 'rgba(140,90,220,0.32)', 'rgba(60,30,90,0.30)'],
    crystalColors: [0x9a4fe8, 0x4fc8e8, 0xe84f9a],
    rock: 0x6a3a9a, rockEmissive: 0x8844cc, grass: 0x7a4ac0, grassEmissive: 0x9a5ae0,
    water: 0x5a2a8a,
    treeCount: 22, rockClusterCount: 10, grassCount: 26, treeMode: 'crystal',
  },
  { // Lv10 終焉競技場
    name: '終焉競技場', seed: 20260721,
    ground: ['#1a1414', 'rgba(200,40,20,0.35)', 'rgba(10,5,5,0.30)'],
    trunk: 0x1a1414, pineTrunk: 0x1a1414, foliage: 0x2a1010, pineFoliage: 0x1a0808,
    rock: 0x2a1818, rockEmissive: 0xdd2200, grass: 0x3a1414, grassEmissive: 0xaa2200,
    water: 0xdd3300,
    treeCount: 10, rockClusterCount: 16, grassCount: 20, treeMode: 'normal', extra: 'braziers',
  },
]

export function getTheme(level) {
  return THEMES[Math.max(1, Math.min(LEVEL_COUNT, level))]
}

// ---- 場地佈局：對戰走廊 + 湖泊 + 河流路徑（座標都在走廊外，安全不重疊）----
const CORRIDOR_HALF_W = 4.2
let corridorHalfLen = 12
let archerZ = 12.5              // 雙方站位的 z 座標（絕對值），依 duelDistance/2 算出
const MIN_ZOMBIE_SPAWN_DIST = 12   // 殭屍生成點離任一方站位至少要這麼遠，避免一出生就貼在人旁邊
// Level 1 固定用這組（跟原本一模一樣）；Level 2 以後每關重新隨機產生一組不同的湖泊/河流，
// 見 buildEnvironment() 開頭的重新指派，湖泊固定在走廊左側（負 X）、河流固定在右側（正 X，
// 跟觀戰高台同側但保留安全間距），跟原本場地佈局的安全假設一致，只是形狀/位置/流向換了
const LEVEL1_LAKE = { cx: -18, cz: 4, rx: 9, rz: 6.5 }
const LEVEL1_RIVER = { points: [[26, -85], [20, -45], [16, -16], [12, -6], [15, 4], [10, 14], [13, 22], [16, 45], [22, 85]], width: 4.5 }
let LAKE = LEVEL1_LAKE
let RIVER = LEVEL1_RIVER
export const WATER_SURFACE_Y = 0.03

function generateLake(rand) {
  const rx = 5 + rand() * 6   // 5~11
  const rz = 4 + rand() * 5   // 4~9
  const cx = -(CORRIDOR_HALF_W + rx + 4 + rand() * 12)   // 固定在走廊左側，保證離走廊夠遠
  const cz = (rand() * 2 - 1) * 35
  return { cx, cz, rx, rz }
}

function generateRiver(rand) {
  const width = 3.5 + rand() * 2.5   // 3.5~6
  const baseX = 14 + rand() * 8       // 14~22，固定在走廊右側，跟原本的安全間距一致
  const wobble = 2 + rand() * 3       // 2~5，河流蜿蜒幅度
  const zs = [-85, -45, -16, -6, 4, 14, 22, 45, 85]
  const points = zs.map((z) => [Math.max(10, baseX + (rand() - 0.5) * 2 * wobble), z])
  return { points, width }
}

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
let opponentStandY = 0   // Level 3 專用：對手站的矮台頂面高度，其餘關卡是 0（站地面）

// Level 6 專用：雙方之間來回滑動的障礙物，製造視線遮蔽——箭矢飛太遠彈道太難預判，
// 距離拉到這關就不再往上加（見 main.js 的 DUEL_DISTANCE_CAP_LEVEL），改用這個機制增加難度
const MOVING_OBSTACLE_AMPLITUDE = 3      // 沿走廊 X 軸左右滑動的振幅（公尺），走廊半寬 4.2，留一點邊界
const MOVING_OBSTACLE_PERIOD = 6         // 來回一次的週期（秒）
let movingObstacle = null   // { mesh, halfW, halfD, y0, height, t, x }，其他關卡是 null（沒有障礙物）

function buildMovingObstacle(scene) {
  const w = 2.2, d = 0.6, h = 2.3
  const mat = new THREE.MeshStandardMaterial({ color: 0xc98aa0, roughness: 0.8 })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  mesh.position.set(0, h / 2, 0)
  mesh.castShadow = true
  mesh.receiveShadow = true
  track(scene, mesh)
  movingObstacle = { mesh, halfW: w / 2, halfD: d / 2, y0: 0, height: h, t: Math.random() * MOVING_OBSTACLE_PERIOD, x: 0 }
}

// 每幀呼叫：讓 Level 6 的移動障礙物沿走廊左右滑動（其他關卡是 no-op）
export function updateSpecialObstacle(dt) {
  if (!movingObstacle) return
  movingObstacle.t += dt
  const x = Math.sin(movingObstacle.t * (Math.PI * 2 / MOVING_OBSTACLE_PERIOD)) * MOVING_OBSTACLE_AMPLITUDE
  movingObstacle.mesh.position.x = x
  movingObstacle.x = x
}

// 給 arrow.js 用：目前這關的移動障礙物包圍盒（沒有就回傳 null），連 mesh 一起給，
// 箭矢插進去時要 attach 上去，才會跟著障礙物一起滑動，而不是插在半空中一個固定點
export function getSpecialObstacle() {
  return movingObstacle
}
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

function track(scene, obj) {
  scene.add(obj)
  sceneObjects.push(obj)
  return obj
}

function buildGroundTexture(renderer, theme) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const [base, speckA, speckB] = theme.ground
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s)
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * s, y = Math.random() * s
    ctx.fillStyle = Math.random() < 0.5 ? speckA : speckB
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(40, 40)
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return tex
}

function buildGround(scene, renderer, theme) {
  const size = 160, seg = 100
  const geo = new THREE.PlaneGeometry(size, size, seg, seg)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i)   // 旋轉前局部座標：world x = lx, world z = -ly
    pos.setZ(i, terrainHeight(lx, -ly))
  }
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: buildGroundTexture(renderer, theme), roughness: 1 }))
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  track(scene, mesh)
}

function buildWater(scene, theme) {
  const waterMat = new THREE.MeshStandardMaterial({ color: theme.water, roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.88 })
  const lakeGeo = new THREE.CircleGeometry(1, 48)
  lakeGeo.scale(LAKE.rx, LAKE.rz, 1)
  const lake = new THREE.Mesh(lakeGeo, waterMat)
  lake.rotation.x = -Math.PI / 2
  lake.position.set(LAKE.cx, WATER_SURFACE_Y, LAKE.cz)
  track(scene, lake)

  // 河流：沿路徑點串出一連串重疊的水面色塊，避免用複雜曲線幾何
  for (let i = 0; i < RIVER.points.length - 1; i++) {
    const [x1, z1] = RIVER.points[i], [x2, z2] = RIVER.points[i + 1]
    const dx = x2 - x1, dz = z2 - z1
    const len = Math.hypot(dx, dz)
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(RIVER.width, len + RIVER.width * 0.6), waterMat)
    seg.rotation.x = -Math.PI / 2
    seg.rotation.z = -Math.atan2(dz, dx) + Math.PI / 2
    seg.position.set((x1 + x2) / 2, WATER_SURFACE_Y, (z1 + z2) / 2)
    track(scene, seg)
  }
}

function buildRoundTree(theme) {
  const g = new THREE.Group()
  const trunkH = 1.6 + rand() * 0.6
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.18, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 0.9 })
  )
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  g.add(trunk)
  const foliageMat = new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.85 })
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

function buildPineTree(theme) {
  const g = new THREE.Group()
  const trunkH = 1.2 + rand() * 0.4
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.16, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: theme.pineTrunk, roughness: 0.9 })
  )
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  g.add(trunk)
  const foliageMat = new THREE.MeshStandardMaterial({ color: theme.pineFoliage, roughness: 0.85 })
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

// Lv9 水晶秘境專用：拿一叢會發光的水晶尖柱取代樹木，站位效果（樹梢座標/碰撞圓）跟一般樹一樣，
// 鳥照樣能停在上面
function buildCrystalCluster(theme) {
  const g = new THREE.Group()
  const colors = theme.crystalColors
  const spikes = 3 + Math.floor(rand() * 3)
  let maxTop = 0
  for (let i = 0; i < spikes; i++) {
    const color = colors[Math.floor(rand() * colors.length)]
    const h = 1.4 + rand() * 1.8
    const r = 0.16 + rand() * 0.14
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.25, metalness: 0.1, emissive: color, emissiveIntensity: 0.55, flatShading: true,
    })
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), mat)
    m.position.set((rand() - 0.5) * 0.9, h / 2, (rand() - 0.5) * 0.9)
    m.rotation.set((rand() - 0.5) * 0.3, rand() * Math.PI * 2, (rand() - 0.5) * 0.3)
    m.castShadow = true
    g.add(m)
    maxTop = Math.max(maxTop, m.position.y + h / 2)
  }
  g.userData.topY = maxTop + 0.3
  return g
}

function buildRock(theme) {
  const s = 0.35 + rand() * 0.5
  const mat = new THREE.MeshStandardMaterial({ color: theme.rock, roughness: 0.95, flatShading: true })
  if (theme.rockEmissive) { mat.emissive.setHex(theme.rockEmissive); mat.emissiveIntensity = 0.5 }
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat)
  m.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function buildGrassTuft(theme) {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: theme.grass, roughness: 0.9, side: THREE.DoubleSide })
  if (theme.grassEmissive) { mat.emissive.setHex(theme.grassEmissive); mat.emissiveIntensity = 0.6 }
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

// ---- 各關專屬造景：荒漠仙人掌／熔岩餘燼／沼澤發光菇／終焉競技場火盆，讓場景不只是換色 ----
function buildCactus() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.8 })
  const trunkH = 1.0 + rand() * 0.8
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, trunkH, 8), mat)
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  g.add(trunk)
  for (let i = 0; i < 2; i++) {
    const armH = 0.5 + rand() * 0.4
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, armH, 6), mat)
    const side = i === 0 ? 1 : -1
    arm.position.set(side * 0.22, trunkH * (0.45 + rand() * 0.3), 0)
    arm.rotation.z = side * 0.9
    arm.castShadow = true
    g.add(arm)
  }
  return g
}

function buildEmberGlow() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0xff5500, emissiveIntensity: 1.2, roughness: 0.4 })
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.08 + rand() * 0.06, 6, 6), mat)
  m.position.y = 0.06
  return m
}

function buildGlowMushroom() {
  const g = new THREE.Group()
  const stemMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.8 })
  const capMat = new THREE.MeshStandardMaterial({ color: 0x6fe0a0, emissive: 0x2fb070, emissiveIntensity: 0.9, roughness: 0.5 })
  const n = 2 + Math.floor(rand() * 3)
  for (let i = 0; i < n; i++) {
    const h = 0.12 + rand() * 0.14
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, h, 6), stemMat)
    stem.position.set((rand() - 0.5) * 0.3, h / 2, (rand() - 0.5) * 0.3)
    g.add(stem)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.06 + rand() * 0.04, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), capMat)
    cap.position.copy(stem.position)
    cap.position.y = h
    g.add(cap)
  }
  return g
}

function buildBrazier() {
  const g = new THREE.Group()
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.7, metalness: 0.4 })
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.1, 6), poleMat)
  pole.position.y = 0.55
  pole.castShadow = true
  g.add(pole)
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.14, 0.22, 8), poleMat)
  bowl.position.y = 1.12
  g.add(bowl)
  const flameMat = new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff5a00, emissiveIntensity: 1.6, roughness: 0.3 })
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 8), flameMat)
  flame.position.y = 1.35
  g.add(flame)
  const light = new THREE.PointLight(0xff6a1a, 6, 7, 2)
  light.position.y = 1.3
  g.add(light)
  return g
}

// 依主題的 extra 標記，在場地外圍空地上加幾個專屬造景（找不到空位就少放幾個，不強求）
function buildThemeExtras(scene, theme) {
  if (!theme.extra) return
  const builders = { cactus: buildCactus, embers: buildEmberGlow, mushrooms: buildGlowMushroom, braziers: buildBrazier }
  const build = builders[theme.extra]
  if (!build) return
  const count = theme.extra === 'braziers' ? 4 : 10
  for (let i = 0; i < count; i++) {
    const spot = pickSpot(30, 24)
    if (!spot) continue
    const obj = build()
    obj.position.set(spot.x, spot.y, spot.z)
    obj.rotation.y = rand() * Math.PI * 2
    track(scene, obj)
    if (theme.extra !== 'braziers') obstacleSpots.push({ x: spot.x, z: spot.z, r: 0.3 })
  }
}

// 把上一關加進場景的所有物件移除並釋放幾何/材質/貼圖記憶體，同時清空各種追蹤陣列
function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) { m?.map?.dispose(); m?.dispose() }
    }
  })
}
export function clearEnvironment() {
  for (const obj of sceneObjects) {
    obj.removeFromParent()
    disposeObject(obj)
  }
  sceneObjects.length = 0
  swayables.length = 0
  treeTops.length = 0
  obstacleSpots.length = 0
  clouds.length = 0
  platformSpots = []
  opponentStandY = 0
  movingObstacle = null
}

// 主入口：建立整個場地（地形/水面/植被/道具）。duelDistance 用來算對戰走廊要留多長，
// level（1~10）決定要套用哪一套關卡主題（配色/密度/專屬造景），未傳則用第 1 關
export function buildEnvironment(scene, renderer, duelDistance, level = 1) {
  clearEnvironment()
  const theme = getTheme(level)
  rand = mulberry32(theme.seed)

  // Level 1 維持原本固定的湖泊/河流，Level 2 開始每關重新隨機產生一組不同的形狀/流向
  LAKE = level === 1 ? LEVEL1_LAKE : generateLake(rand)
  RIVER = level === 1 ? LEVEL1_RIVER : generateRiver(rand)

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

  buildGround(scene, renderer, theme)
  buildWater(scene, theme)

  for (let i = 0; i < theme.treeCount; i++) {
    const spot = pickSpot(38, 38)
    if (!spot) continue
    const tree = theme.treeMode === 'crystal'
      ? buildCrystalCluster(theme)
      : (rand() < 0.5 ? buildRoundTree(theme) : buildPineTree(theme))
    tree.position.set(spot.x, spot.y, spot.z)
    tree.rotation.y = rand() * Math.PI * 2
    const s = 0.85 + rand() * 0.5
    tree.scale.setScalar(s)
    track(scene, tree)
    swayables.push({ group: tree, phase: rand() * 10, freq: 0.7 + rand() * 0.3, amp: 0.11 })
    treeTops.push({ x: spot.x, y: spot.y + tree.userData.topY * s, z: spot.z })
    obstacleSpots.push({ x: spot.x, z: spot.z, r: 0.45 * s })
  }

  for (let i = 0; i < theme.rockClusterCount; i++) {
    const spot = pickSpot(35, 35)
    if (!spot) continue
    const n = 2 + Math.floor(rand() * 3)
    for (let j = 0; j < n; j++) {
      const rock = buildRock(theme)
      rock.position.set(spot.x + (rand() - 0.5) * 1.2, spot.y, spot.z + (rand() - 0.5) * 1.2)
      obstacleSpots.push({ x: rock.position.x, z: rock.position.z, r: 0.4 })
      track(scene, rock)
    }
  }

  for (let i = 0; i < theme.grassCount; i++) {
    const spot = pickSpot(30, 20)
    if (!spot) continue
    const tuft = buildGrassTuft(theme)
    tuft.position.set(spot.x, spot.y, spot.z)
    tuft.rotation.y = rand() * Math.PI * 2
    track(scene, tuft)
    swayables.push({ group: tuft, phase: rand() * 10, freq: 1.4 + rand() * 0.6, amp: 0.4 })
  }

  buildThemeExtras(scene, theme)

  // 兩座觀戰高台，分別在場地兩側，貼著該處的地形高度放置避免浮空/插地
  for (const p of platformSpots) {
    const plat = buildPlatform(3.2, 2.2, 1.1)
    plat.position.set(p.x, terrainHeight(p.x, p.z), p.z)
    track(scene, plat)
  }

  // Level 3 專屬：對手改站在一個矮台上，比玩家（站地面，root.y=0）略高一點。矮台也註冊進
  // platformSpots，才會跟觀戰高台一樣享有箭矢碰撞判定（射偏的箭會插在台面上，不會直接穿過去）
  if (level === 3) {
    const oppH = 0.5
    const oppX = 0, oppZ = -archerZ
    const y = terrainHeight(oppX, oppZ)
    const surfaceY = y + oppH + 0.125
    platformSpots.push({ x: oppX, z: oppZ, r: 1.6, y, surfaceY, topY: surfaceY + 0.08, halfW: 1.1, halfD: 1.1 })
    const oppPlat = buildPlatform(2.2, 2.2, oppH)
    oppPlat.position.set(oppX, y, oppZ)
    track(scene, oppPlat)
    opponentStandY = surfaceY
  }

  // Level 6 專屬：雙方之間的移動障礙物，沿走廊左右滑動，週期性擋住視線
  if (level === 6) buildMovingObstacle(scene)

  // 風向旗：固定在玩家右前方 4 公尺（45 度角），跟站位距離無關，不會因為關卡拉開對戰距離而跑位
  const vaneOffset = 4 / Math.SQRT2
  buildWindVane(scene, vaneOffset, archerZ - vaneOffset)
  buildClouds(scene)

  return theme
}

// 給 birds.js 用：所有樹梢（含水晶叢頂端）的世界座標，鳥要停棲時從這裡挑
export function getTreeTops() {
  return treeTops
}

// 給 main.js 用：觀戰高台的位置與地面高度/檯面高度，方便算出檯面上的世界座標
export function getPlatformSpots() {
  return platformSpots
}

// 給 main.js 用：這關對手應該站的高度（大多數關卡是 0，Level 3 是矮台頂面高度）
export function getOpponentStandY() {
  return opponentStandY
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
      track(scene, puff)
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
  track(scene, g)

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
