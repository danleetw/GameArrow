import * as THREE from 'three'
import { CameraRig } from './camera.js'
import { ArrowManager, TrajectoryPreview, CHARGE_TIME, SPEED_MIN, SPEED_MAX, ARROW_RADIUS } from './arrow.js'
import { Archer } from './archer.js'
import { testArrowHit, TIER_AIM_NOISE } from './hitzones.js'
import { AIController } from './ai.js'
import { initAudio, sfx, music } from './sfx.js'
import { buildEnvironment, updateEnvironment, getPlatformSpots, pickGroundSpot, getTerrainHeightAt, isWaterAt, getObstacles, LEVEL_COUNT, getOpponentStandY } from './scene.js'
import { initDayNight, updateDayNight } from './daynight.js'
import { updateWind, getWindSpeed } from './wind.js'
import { updateBirds, spawnBirdFlushNear, spawnBirdOverCorridor, scareAwayBirdsOn, spawnBirdLineup, testArrowHitBird, killBird, clearBirds } from './birds.js'
import { spawnZombie, updateZombies, testArrowHitZombie, resetZombieBiteImmunity, clearZombies } from './zombie.js'

// ============================================================
//  弓箭手對決（第一人稱瞄準 + 站定對戰）— M1+M2: 場景/相機 + 蓄力射箭
// ============================================================

// ---- 關卡系統：Level 1~10，越高關距離越遠、AI 對手命中率越高（15%→65% 線性遞增），
//      每關場景/配色由 scene.js 的 THEMES 決定，Level 1 = 原本預設場景 ----
function levelDuelDistance(level) { return 25 + (level - 1) * 3 }
function levelAiHitChance(level) { return 0.15 + (level - 1) * (0.5 / (LEVEL_COUNT - 1)) }

let currentLevel = 1
let DUEL_DISTANCE = levelDuelDistance(currentLevel)   // 雙方站位間距（公尺），隨關卡改變
const EYE = new THREE.Vector3(0, 1.7, DUEL_DISTANCE / 2)   // 玩家眼睛位置（面向 -z），關卡切換時原地更新座標

// ---- 計分系統：每關依「玩家第幾箭把 AI 射死」給分，加上每打倒一位 AI 對手的固定獎勵分，
//      累加成這次挑戰的總分，最佳關卡/最佳分數存進 localStorage（僅限這台裝置/這個瀏覽器）----
function scoreForShot(n) {
  if (n === 1) return 100
  if (n === 2) return 50
  if (n === 3) return 30
  return Math.max(1, 10 - (n - 4))   // 第 4 箭 10 分，之後每多一箭少 1 分，最低 1 分
}
const DEFEAT_BONUS = 50   // 每打倒一位 AI 對手，額外加這麼多分（跟第幾箭致命的分數疊加）
let levelArrowCount = 0   // 這一關玩家已經射出的箭數（含沒命中的），setupLevel() 時歸零
let runScore = 0          // 這次挑戰（從 Level 1 開始）累積的分數，回 Level 1 重新開始時歸零

const STATS_KEY = 'arraw_stats_v1'
let stats = { bestLevel: 1, bestScore: 0 }
try {
  const savedStats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
  if (typeof savedStats.bestLevel === 'number') stats.bestLevel = savedStats.bestLevel
  if (typeof savedStats.bestScore === 'number') stats.bestScore = savedStats.bestScore
} catch { /* 讀不到就用預設值 */ }
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)) } catch { /* 存不了就算了，不影響遊玩 */ }
}

// ---- 開場空拍機運鏡：起飛遠離 → 繞場地一圈 → 飛回第一人稱視角。每一關都會播放（除非玩家在
//      設定裡關掉），所以環繞半徑/高度要跟著當關的對戰距離等比例縮放，不然高關距離拉遠後，
//      固定半徑的運鏡會直接穿過雙方站位/看台，畫面會很奇怪 ----
const INTRO_DUR = 9.0
const ARENA_CENTER = new THREE.Vector3(0, 1.6, 0)
const ORBIT_R_BASE = 20, ORBIT_H_BASE = 9   // 這兩個數字是照 Level 1（距離 25）調出來的基準值
const ORBIT_START_ANGLE = Math.PI / 2   // 對應 (center.x, H, center.z+R)，在玩家那一側起飛/降落，銜接不跳動
function orbitPoint(angle) {
  const scale = DUEL_DISTANCE / 25
  const r = ORBIT_R_BASE * scale, h = ORBIT_H_BASE * scale
  return new THREE.Vector3(ARENA_CENTER.x + Math.cos(angle) * r, h, ARENA_CENTER.z + Math.sin(angle) * r)
}
const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }

const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window

// ---- three ----
const canvas = document.getElementById('game')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05

const scene = new THREE.Scene()

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 300)

// ---- 天空/霧/主光源/環境光/太陽與月亮視覺，交給 daynight.js 依現實時間 24 倍速換算的
//      遊戲時刻統一管理（現實 1 小時 = 遊戲一整天）----
initDayNight(scene, { shadowMapSize: IS_TOUCH ? 1024 : 2048 })

// ---- 場地佈置（地形起伏 + 湖泊 + 河流 + 樹木 + 石頭 + 草叢 + 觀戰高台），Level 1 主題----
let currentTheme = buildEnvironment(scene, renderer, DUEL_DISTANCE, currentLevel)

// ---- 雙方弓箭手（程序化幾何人形，14 個命中區節段）----
const PLAYER_POS = new THREE.Vector3(0, 0, DUEL_DISTANCE / 2)
// 對手 y 座標大多數關卡是 0（站地面），特定關卡（目前是 Level 3）會站矮台，由 scene.js 決定高度
const OPPONENT_POS = new THREE.Vector3(0, getOpponentStandY(), -DUEL_DISTANCE / 2)

// 玩家自身模型在第一人稱模式下不加入場景（避免相機卡進人物），M7 第三人稱運鏡時才會顯露
const playerArcher = new Archer(0x3a7d44, 'player')   // 綠色皮衣
playerArcher.setPosition(PLAYER_POS.x, PLAYER_POS.y, PLAYER_POS.z)
playerArcher.setFacing(0)

const aiArcher = new Archer(0x8a2f2f, 'ai')            // 紅色皮衣（治安官風）
aiArcher.setPosition(OPPONENT_POS.x, OPPONENT_POS.y, OPPONENT_POS.z)
aiArcher.setFacing(Math.PI)   // 面向玩家
aiArcher.root.scale.setScalar(1.8)
scene.add(aiArcher.root)
playerArcher.root.scale.setScalar(1.8)
// 玩家模型仍要加入場景才會每幀更新世界矩陣（AI 瞄準需要讀取正確的部位座標），
// 但 visible=false 讓它不會被渲染出來，避免第一人稱視角卡進自己身體
scene.add(playerArcher.root)
playerArcher.root.visible = false

// ---- 第一人稱相機 ----
const cameraRig = new CameraRig(camera, canvas, EYE)

// ---- 蓄力射箭 ----
const arrowManager = new ArrowManager(scene)
const trajectoryPreview = new TrajectoryPreview(scene)
const aiController = new AIController(aiArcher, arrowManager, () => playerArcher, 'easy')
aiController.setHitChance(levelAiHitChance(currentLevel))
const powerEl = document.getElementById('power')
const powerFillEl = document.getElementById('power-fill')
let charging = false
let chargeT = 0
let currentDrawPower = 0   // 每幀更新，蓄力飄動時 fireUp() 要用「當下顯示的」蓄力，不能重算一次乾淨值

// ---- 風速越大，蓄力飄動／準星飄動的幅度越大：兩種飄動共用同一個風速強度係數 ----
const WIND_SPEED_MAX = 4.5   // 要跟 wind.js 的風速上限一致
const WIND_AMP_BONUS = 0.7   // 滿風速時幅度再放大到 1.7 倍
function windAmpFactor() {
  return 1 + Math.min(1, getWindSpeed() / WIND_SPEED_MAX) * WIND_AMP_BONUS
}

// ---- 蓄力飄動：拉弓時蓄力值一律用亂數正弦波上下飄動（不是機率觸發，每箭都會飄），
//      連帶影響箭速/飛行距離；同一箭只在開始拉弓那一刻擲骰決定飄多大/多快，蓄力過程中固定。
//      拉超過 INTENSE_DRIFT_START 秒後（手開始撐不住）幅度/頻率再放大，飄得更劇烈 ----
let chargeDriftPhase = 0, chargeDriftAmp = 0, chargeDriftFreq = 0
const CHARGE_DRIFT_AMP_MIN = 0.08, CHARGE_DRIFT_AMP_MAX = 0.14
const CHARGE_DRIFT_FREQ_MIN = 2.0, CHARGE_DRIFT_FREQ_MAX = 3.6
const INTENSE_DRIFT_START = 3.0
const INTENSE_DRIFT_AMP_MULT = 3.0, INTENSE_DRIFT_FREQ_MULT = 1.6

// ---- 蓄力上限：拉弓超過 4 秒手會撐不住自動放下（這一箭作廢，不會射出），
//      放下後要休息 6 秒才能重新拉弓 ----
const MAX_CHARGE_HOLD = 4.0
const ARMS_REST_DURATION = 6.0
let armsRestT = 0

// ---- 準星飄動：拉弓時準星（視線方向）一律用亂數正弦波持續飄動，水平/垂直各自獨立一組
//      相位/頻率，玩家要自己動滑鼠/拖曳抵銷才能把準星穩定在目標上；飄動幅度由
//      CameraRig.getAimDirection() 自動疊加，預覽彈道跟真正放箭方向都會反映飄動結果 ----
const SWAY_AMP_MIN = 0.012, SWAY_AMP_MAX = 0.028   // 弧度，約 0.7°~1.6°，再依風速放大
const SWAY_FREQ_MIN = 1.1, SWAY_FREQ_MAX = 2.4

function shotOrigin() {
  // 箭矢從眼睛位置往視線方向前移一點出發，避免箭頭一開始卡在相機視野裡
  const dir = cameraRig.getAimDirection()
  return cameraRig.eye.clone().addScaledVector(dir, 0.5)
}

function fireDown() {
  if (!playing || paused || matchOver || cameraRig.cutting || rightMouseDown || armsRestT > 0) return
  if (!IS_TOUCH && !cameraRig.locked) return   // 觸控裝置不用 Pointer Lock，跳過這個檢查
  charging = true
  chargeT = 0
  currentDrawPower = 0
  const amp = windAmpFactor()
  chargeDriftPhase = Math.random() * Math.PI * 2
  chargeDriftAmp = (CHARGE_DRIFT_AMP_MIN + Math.random() * (CHARGE_DRIFT_AMP_MAX - CHARGE_DRIFT_AMP_MIN)) * amp
  chargeDriftFreq = CHARGE_DRIFT_FREQ_MIN + Math.random() * (CHARGE_DRIFT_FREQ_MAX - CHARGE_DRIFT_FREQ_MIN)
  cameraRig.startSway(
    (SWAY_AMP_MIN + Math.random() * (SWAY_AMP_MAX - SWAY_AMP_MIN)) * amp,
    (SWAY_AMP_MIN + Math.random() * (SWAY_AMP_MAX - SWAY_AMP_MIN)) * amp,
    SWAY_FREQ_MIN + Math.random() * (SWAY_FREQ_MAX - SWAY_FREQ_MIN),
    SWAY_FREQ_MIN + Math.random() * (SWAY_FREQ_MAX - SWAY_FREQ_MIN)
  )
  sfx.draw()
}
const FIRE_RECOIL_MIN = 0.08, FIRE_RECOIL_MAX = 0.18   // 放箭後的後座力幅度：蓄力越滿後座力越大

// 放棄這一箭：跟 fireUp() 不同，不會真的射出箭矢（望遠鏡打斷蓄力、手機拖出畫面外、
// 拉弓超過上限手放下，都會走這條）
function cancelCharge() {
  if (!charging) return
  charging = false
  trajectoryPreview.hide()
  powerFillEl.style.width = '0%'
  cameraRig.stopSway()
}

function fireUp() {
  if (!charging) return
  charging = false
  trajectoryPreview.hide()
  powerFillEl.style.width = '0%'
  cameraRig.stopSway()
  // 用當下顯示的蓄力值（已經被飄動修正過），但保底 0.12——極快速點放連 loop 都還沒跑到一次時，
  // currentDrawPower 還停在 fireDown() 剛重置的 0，不加保底會打出去等於沒蓄力的箭
  const power = Math.max(0.12, currentDrawPower)
  const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  const dir = cameraRig.getAimDirection()   // 已內建目前的準星飄動偏移
  levelArrowCount++
  const arrow = arrowManager.spawn(shotOrigin(), dir, speed, 'player')
  arrow.shotNumber = levelArrowCount   // 這一關的第幾箭，命中/致命時算分要用
  sfx.release()
  // 放箭後座力：把準星震開，逼玩家重新瞄準才能打下一箭，不能連續兩箭都用同一個準心點連發
  cameraRig.addAimNoise(FIRE_RECOIL_MIN + (FIRE_RECOIL_MAX - FIRE_RECOIL_MIN) * power)
}
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (!cameraRig.locked) {
    if (playing && !paused && !introActive) cameraRig.requestLock()
    return
  }
  fireDown()
})
window.addEventListener('mouseup', (e) => { if (e.button === 0) fireUp() })

// ---- 手機觸控：長按＝蓄力拉弓（跟按住左鍵一樣），拖曳＝移動準星（視角），
//      拖出畫面外＝放棄這一箭不發射，手指放開＝放箭 ----
let touchId = null, touchLastX = 0, touchLastY = 0
function withinViewport(x, y) {
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight
}
canvas.addEventListener('touchstart', (e) => {
  if (touchId !== null) return   // 已經有一根手指在操作了，忽略其他手指
  const t = e.changedTouches[0]
  touchId = t.identifier
  touchLastX = t.clientX; touchLastY = t.clientY
  fireDown()
  e.preventDefault()
}, { passive: false })
canvas.addEventListener('touchmove', (e) => {
  if (touchId === null) return
  const t = Array.from(e.changedTouches).find((x) => x.identifier === touchId)
  if (!t) return
  if (!withinViewport(t.clientX, t.clientY)) {
    cancelCharge()
    touchId = null
    return
  }
  cameraRig.applyTouchDelta(t.clientX - touchLastX, t.clientY - touchLastY)
  touchLastX = t.clientX; touchLastY = t.clientY
  e.preventDefault()
}, { passive: false })
function endTouch(e) {
  if (touchId === null) return
  if (!Array.from(e.changedTouches).some((x) => x.identifier === touchId)) return
  touchId = null
  fireUp()
}
canvas.addEventListener('touchend', endTouch)
canvas.addEventListener('touchcancel', () => { if (touchId !== null) { cancelCharge(); touchId = null } })

// ---- 望遠縮放：按住右鍵 + 滾輪調整視野（不影響實際瞄準方向，純視覺放大）。望遠中不能發射，
//      拉弓拉到一半按右鍵望遠也會直接打斷蓄力，不能靠先拉弓、再放大視野瞄得更準 ----
const FOV_DEFAULT = 65, FOV_MIN = 13, FOV_MAX = 65
let rightMouseDown = false
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return
  rightMouseDown = true
  cancelCharge()
})
window.addEventListener('mouseup', (e) => {
  if (e.button !== 2) return
  rightMouseDown = false
  camera.fov = FOV_DEFAULT   // 放開右鍵立即恢復正常視野，不用手動滾回來
  camera.updateProjectionMatrix()
})
canvas.addEventListener('wheel', (e) => {
  if (!rightMouseDown || !playing || paused || introActive) return
  e.preventDefault()
  const delta = e.deltaY < 0 ? -3 : 3   // 往前滾（deltaY<0）放大視野，往回滾則拉遠
  camera.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, camera.fov + delta))
  camera.updateProjectionMatrix()
}, { passive: false })

// ---- pointer lock / 覆蓋層流程 ----
const overlayEl = document.getElementById('overlay')
const pauseEl = document.getElementById('pause')
const settingsEl = document.getElementById('settings')
const setIntroCheckbox = document.getElementById('set-intro')
const crosshairEl = document.getElementById('crosshair')
const crosshairForbiddenEl = document.getElementById('crosshair-forbidden')
const pauseHintEl = document.getElementById('pause-hint')
const loadingEl = document.getElementById('loading')
const portraitWrapEl = document.getElementById('portrait-wrap')
const playerHudEl = document.getElementById('player-hud')
const hpPlayerFillEl = document.getElementById('hp-player-fill')
const hpAiFillEl = document.getElementById('hp-ai-fill')
const hpPlayerPctEl = document.getElementById('hp-player-pct')
const hpAiPctEl = document.getElementById('hp-ai-pct')
const resultEl = document.getElementById('result')
const resultTitleEl = document.getElementById('result-title')
const resultRetryBtn = document.getElementById('result-retry')
const hitLabelEl = document.getElementById('hit-label')
const levelLabelEl = document.getElementById('level-label')
const statsLabelEl = document.getElementById('stats-label')

function updateLevelHud() {
  levelLabelEl.textContent = `Level ${currentLevel} · ${currentTheme.name}`
}
updateLevelHud()

// 最佳達成關卡／最佳分數／本次分數，畫面最上方常駐顯示
function updateStatsHud() {
  statsLabelEl.innerHTML = `最佳關卡：Level ${stats.bestLevel}<br>最佳分數：${stats.bestScore}<br>本次分數：${runScore}`
}
updateStatsHud()

// ---- 版本標示：畫面上方顯示最後一次 git commit 的時間（build 時寫死進來，見 vite.config.js），
//      直接切字串取原始時區的年月日時分，不用 Date 物件轉換，避免跟瀏覽器所在時區換算後跑掉 ----
;(() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(__LAST_UPDATE_ISO__)
  if (!m) return
  const [, yyyy, mm, dd, hh, min] = m
  document.getElementById('version-label').textContent = `v${yyyy.slice(2)}.${mm}.${dd} ${hh}:${min}`
})()

const ZONE_NAME_ZH = {
  head: '頭', chest: '胸',
  upperArm_L: '左大臂', upperArm_R: '右大臂', foreArm_L: '左小臂', foreArm_R: '右小臂',
  hand_L: '左手掌', hand_R: '右手掌',
  thigh_L: '左大腿', thigh_R: '右大腿', shin_L: '左小腿', shin_R: '右小腿',
  foot_L: '左腳掌', foot_R: '右腳掌',
}
let hitLabelTimer = null
function showHitLabel(target, hit) {
  const who = target === playerArcher ? '你的' : '對手的'
  hitLabelEl.textContent = `命中 ${who}${ZONE_NAME_ZH[hit.name] || hit.name}`
  hitLabelEl.classList.add('show')
  clearTimeout(hitLabelTimer)
  hitLabelTimer = setTimeout(() => hitLabelEl.classList.remove('show'), 900)
}

function updateHpHud() {
  const p = Math.max(0, Math.ceil(playerArcher.hp))
  const a = Math.max(0, Math.ceil(aiArcher.hp))
  hpPlayerFillEl.style.width = p + '%'
  hpAiFillEl.style.width = a + '%'
  hpPlayerPctEl.textContent = p + '%'
  hpAiPctEl.textContent = a + '%'
}

// 觸發命中運鏡：鏡頭切到目標archer前方側邊、拉遠一點看向身體中心（骨盆），
// 這樣不管命中頭還是腳都能完整入鏡，不會只框到臉
const _hcMid = new THREE.Vector3()
const _hcFwd = new THREE.Vector3(), _hcSide = new THREE.Vector3(), _hcCamPos = new THREE.Vector3()
function triggerHitCut(target, isFatal) {
  target.pelvis.getWorldPosition(_hcMid)
  _hcFwd.set(0, 0, -1).applyQuaternion(target.root.quaternion)
  _hcSide.set(1, 0, 0).applyQuaternion(target.root.quaternion)
  _hcCamPos.copy(_hcMid).addScaledVector(_hcFwd, 4.2).addScaledVector(_hcSide, 1.8)
  _hcCamPos.y += 0.9
  if (target === playerArcher) playerArcher.root.visible = true
  cameraRig.startCut(_hcCamPos, _hcMid, isFatal ? 2.3 : 1.2)
}

let matchOver = false

// 套用一次命中：扣血+關節反應動畫（Archer 內部處理），
// 若中箭的是玩家自己，還要打亂視角瞄準，中/重傷並中斷正在進行的蓄力；
// 命中方無論哪一邊都會觸發第三人稱運鏡看反應；致命則進入勝負流程。arrow 是打中的那支箭，
// 只有打中 AI 對手的致命一箭才需要用到（算「第幾箭致命」的分數）
function handleHit(target, hit, arrow) {
  const result = target.applyDamage(hit.name, hit.damage, hit.tier)
  updateHpHud()
  showHitLabel(target, hit)
  if (target === playerArcher) {
    cameraRig.addAimNoise(TIER_AIM_NOISE[hit.tier] || 0)
    if (!result.fatal && (hit.tier === 'medium' || hit.tier === 'heavy') && charging) {
      charging = false; trajectoryPreview.hide(); powerFillEl.style.width = '0%'
    }
  } else if (target === aiArcher && !result.fatal) {
    aiController.onHit(hit.tier)
  }
  if (target === aiArcher && result.fatal && arrow) {
    runScore += scoreForShot(arrow.shotNumber) + DEFEAT_BONUS
    if (runScore > stats.bestScore) { stats.bestScore = runScore; saveStats() }
    updateStatsHud()
  }
  triggerHitCut(target, result.fatal)
  if (result.fatal) sfx.death()
  else sfx.hit(hit.tier)
  if (result.fatal && !matchOver) endMatch(target === playerArcher ? 'ai' : 'player')
}

const ZOMBIE_ATTACK_DAMAGE = 25
// 殭屍撲咬：跟 handleHit 走一樣的傷害/反應/勝負流程，命中提示文字換成殭屍咬人；
// 若被咬的是對手（AI），畫面焦點不切走（不觸發第三人稱運鏡），只顯示文字提示，
// 讓玩家有機會在殭屍攻擊對手的當下自己動手把殭屍射死；玩家自己被咬則維持原本運鏡
function applyZombieBite(target) {
  const result = target.applyDamage('chest', ZOMBIE_ATTACK_DAMAGE, 'heavy')
  updateHpHud()
  hitLabelEl.textContent = `${target === playerArcher ? '你' : '他'}被殭屍咬了一口！`
  hitLabelEl.classList.add('show')
  clearTimeout(hitLabelTimer)
  hitLabelTimer = setTimeout(() => hitLabelEl.classList.remove('show'), 900)
  if (target === playerArcher) {
    cameraRig.addAimNoise(TIER_AIM_NOISE.heavy)
    if (!result.fatal && charging) { charging = false; trajectoryPreview.hide(); powerFillEl.style.width = '0%' }
    triggerHitCut(target, result.fatal)
  } else if (!result.fatal) {
    aiController.onHit('heavy')
  }
  if (result.fatal) sfx.death()
  else sfx.hit('heavy')
  if (result.fatal && !matchOver) endMatch(target === playerArcher ? 'ai' : 'player')
}

// 這次按下「result-retry」按鈕該做什麼：贏了且還有下一關→前往下一關；贏了是最終關或輸了
// →都是從 Level 1 重新開始（被打倒不能原地重來同一關，要從頭挑戰）
let resultAction = 'restart-campaign'

function endMatch(winnerSide) {
  matchOver = true
  charging = false; trajectoryPreview.hide(); powerFillEl.style.width = '0%'
  setTimeout(() => {
    resultEl.classList.remove('hidden')
    resultEl.classList.toggle('win', winnerSide === 'player')
    resultEl.classList.toggle('lose', winnerSide === 'ai')
    if (winnerSide === 'player') {
      if (currentLevel < LEVEL_COUNT) {
        resultTitleEl.textContent = `🎉 恭喜過關！Level ${currentLevel} 完成`
        resultRetryBtn.textContent = `▶ 前往 Level ${currentLevel + 1}`
        resultAction = 'next'
      } else {
        resultTitleEl.textContent = '👑 恭喜全破！你擊敗了所有關卡'
        resultRetryBtn.textContent = '↺ 從頭開始挑戰'
        resultAction = 'restart-campaign'
      }
    } else {
      // 被打倒不能原地重來，要從 Level 1 重新挑戰——跟全破後想再玩一次是同一個動作
      resultTitleEl.textContent = `💀 你在 Level ${currentLevel} 被擊倒了`
      resultRetryBtn.textContent = '↺ 回到 Level 1 重新挑戰'
      resultAction = 'restart-campaign'
    }
    document.exitPointerLock()
  }, 2200)
}

// 切換到指定關卡：重建場景（新配色/新距離）、重新擺位雙方站位與攝影機、更新 AI 命中率，
// 並清掉上一關殘留的鳥/殭屍（新場地的座標系不一樣，留著位置會對不上）
function setupLevel(level) {
  currentLevel = level
  DUEL_DISTANCE = levelDuelDistance(level)
  levelArrowCount = 0
  clearBirds()
  clearZombies()
  currentTheme = buildEnvironment(scene, renderer, DUEL_DISTANCE, level)

  PLAYER_POS.set(0, 0, DUEL_DISTANCE / 2)
  OPPONENT_POS.set(0, getOpponentStandY(), -DUEL_DISTANCE / 2)   // buildEnvironment() 剛跑完，這關的站台高度已經算好了
  EYE.set(0, 1.7, DUEL_DISTANCE / 2)
  playerArcher.setPosition(PLAYER_POS.x, PLAYER_POS.y, PLAYER_POS.z)
  aiArcher.setPosition(OPPONENT_POS.x, OPPONENT_POS.y, OPPONENT_POS.z)
  cameraRig.eye.copy(EYE)
  cameraRig.yaw = 0; cameraRig.pitch = 0
  cameraRig.update(0)

  aiController.setHitChance(levelAiHitChance(level))
  if (level > stats.bestLevel) { stats.bestLevel = level; saveStats() }
  updateLevelHud()
  updateStatsHud()
}

function restartMatch(level = currentLevel, { requestLock = true } = {}) {
  const levelChanged = level !== currentLevel
  matchOver = false
  setupLevel(level)
  playerArcher.reset()
  aiArcher.reset()
  aiController.reset()
  resetZombieBiteImmunity()
  arrowManager.clear()
  cameraRig.cancelCut()
  camera.fov = FOV_DEFAULT
  camera.updateProjectionMatrix()
  resultEl.classList.add('hidden')
  updateHpHud()
  armsRestT = 0   // 中途重開/換關不該延續上一局剩下的休息懲罰
  crosshairForbiddenEl.classList.remove('show')
  if (!requestLock) return   // 回選單用的重置：不搶滑鼠鎖定、不播運鏡，維持在選單畫面
  if (!IS_TOUCH) cameraRig.requestLock()
  if (levelChanged) {
    spawnBirdFlushNear(scene, PLAYER_POS)   // 進新關卡比照開場，來一隻鳥驚飛增加臨場感
    beginGameplayView()   // 換到新關卡：比照開場，播一次空拍運鏡（除非玩家關掉）
  } else {
    _revealGameplayHud()   // 重新挑戰同一關：不用再飛一次，直接留在第一人稱
  }
}
resultRetryBtn.addEventListener('click', () => {
  sfx.uiClick()
  if (resultAction !== 'next') { runScore = 0; updateStatsHud() }   // 回 Level 1 重新開始，本次分數歸零
  restartMatch(resultAction === 'next' ? currentLevel + 1 : 1)
})

let playing = false
let paused = false
let introActive = false
let introT = 0
let overheadBirdT = 10   // 每 10 秒安排一隻鳥飛越對戰走廊上空

// ---- 遊戲設定：開場運鏡開關（存 localStorage，記住玩家上次的選擇）----
const SETTINGS_KEY = 'arraw_settings_v1'
let settings = { introEnabled: true }
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
  if (typeof saved.introEnabled === 'boolean') settings.introEnabled = saved.introEnabled
} catch { /* 讀不到就用預設值 */ }

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 存不了就算了，不影響遊玩 */ }
}

function _revealGameplayHud() {
  crosshairEl.classList.remove('hidden')
  powerEl.classList.remove('hidden')
  pauseHintEl.classList.remove('hidden')
  portraitWrapEl.classList.remove('hidden')
  playerHudEl.classList.remove('hidden')
  levelLabelEl.classList.remove('hidden')
  statsLabelEl.classList.remove('hidden')
}

// 依設定決定要播放開場空拍運鏡還是直接進第一人稱：每一關開始都會呼叫一次
// （開場、換到下一關、全破後重新開始都算），只有玩家自己在設定裡關掉才會跳過
function beginGameplayView() {
  if (settings.introEnabled) {
    introActive = true
    introT = 0
    playerArcher.root.visible = true   // 開場運鏡要拍到主角背影，結束後才切回第一人稱隱藏自己
    updateIntroCamera(0)
  } else {
    introActive = false
    cameraRig.yaw = 0; cameraRig.pitch = 0
    cameraRig.update(0)
    _revealGameplayHud()
  }
}

function startDuel() {
  initAudio()
  music.start()
  overlayEl.classList.add('hidden')
  playing = true
  paused = false
  camera.fov = FOV_DEFAULT
  camera.updateProjectionMatrix()
  updateHpHud()
  spawnBirdFlushNear(scene, PLAYER_POS)   // 開場就有一隻鳥從主角附近驚飛，馬上看得到效果
  // 瀏覽器只允許在使用者「直接點擊」當下鎖定滑鼠，晚一點用計時器觸發會被悄悄擋掉，
  // 所以要在這個按鈕點擊的當下就先鎖定，不管有沒有播運鏡都不用再鎖一次
  if (!IS_TOUCH) cameraRig.requestLock()
  beginGameplayView()
}

// 開場運鏡結束：交還操控權給玩家（重置視角方向、顯示準星/血條等 HUD）
function endIntro() {
  introActive = false
  playerArcher.root.visible = false
  cameraRig.yaw = 0; cameraRig.pitch = 0   // 忽略運鏡期間玩家亂動滑鼠累積的角度，重新面向對手
  cameraRig.update(0)
  _revealGameplayHud()
}

// 開場運鏡：0~0.22 從主角後上方拉遠起飛、0.22~0.82 繞場地一圈、0.82~1 飛回第一人稱視角
function updateIntroCamera(kRaw) {
  const k = Math.max(0, Math.min(1, kRaw))
  const orbitStart = orbitPoint(ORBIT_START_ANGLE)
  if (k < 0.22) {
    const e = smoothstep(k / 0.22)
    // 起飛點：貼在主角後上方（像跟拍鏡頭），再慢慢拉遠拉高飛到環繞起點
    const takeoffFrom = new THREE.Vector3(PLAYER_POS.x, EYE.y + 1.0, PLAYER_POS.z + 3.2)
    camera.position.lerpVectors(takeoffFrom, orbitStart, e)
    const lookNear = new THREE.Vector3(PLAYER_POS.x, EYE.y - 0.3, PLAYER_POS.z)
    camera.lookAt(lookNear.lerp(ARENA_CENTER, e))
  } else if (k < 0.82) {
    const e = (k - 0.22) / 0.6
    camera.position.copy(orbitPoint(ORBIT_START_ANGLE + e * Math.PI * 2))
    camera.lookAt(ARENA_CENTER)
  } else {
    const e = smoothstep((k - 0.82) / 0.18)
    camera.position.lerpVectors(orbitStart, EYE, e)
    const look = new THREE.Vector3().lerpVectors(ARENA_CENTER, EYE.clone().add(new THREE.Vector3(0, 0, -1)), e)
    camera.lookAt(look)
  }
}

function showPause() {
  paused = true
  charging = false; trajectoryPreview.hide(); powerFillEl.style.width = '0%'
  pauseEl.classList.remove('hidden')
}
function hidePause() {
  paused = false
  pauseEl.classList.add('hidden')
  if (!IS_TOUCH) cameraRig.requestLock()
}
function quitToMenu() {
  paused = false
  pauseEl.classList.add('hidden')
  overlayEl.classList.remove('hidden')
  crosshairEl.classList.add('hidden')
  powerEl.classList.add('hidden')
  pauseHintEl.classList.add('hidden')
  portraitWrapEl.classList.add('hidden')
  playerHudEl.classList.add('hidden')
  levelLabelEl.classList.add('hidden')
  statsLabelEl.classList.add('hidden')
  playing = false
  music.stop()
  // 回選單前先把這關重置乾淨（HP/位置/殘留箭矢等），下次按「開始對決」才不會接著中途的殘局，
  // 不搶著鎖滑鼠（選單畫面不該鎖）也不留著結算畫面
  restartMatch(currentLevel, { requestLock: false })
}

document.getElementById('start-btn').addEventListener('click', startDuel)
document.getElementById('resume-btn').addEventListener('click', () => { sfx.uiClick(); hidePause() })
document.getElementById('pause-retry-btn').addEventListener('click', () => {
  sfx.uiClick()
  paused = false
  pauseEl.classList.add('hidden')
  restartMatch()
})
document.getElementById('quit-btn').addEventListener('click', () => { sfx.uiClick(); quitToMenu() })

document.getElementById('settings-btn').addEventListener('click', () => {
  sfx.uiClick()
  setIntroCheckbox.checked = settings.introEnabled
  pauseEl.classList.add('hidden')
  settingsEl.classList.remove('hidden')
})
document.getElementById('settings-close').addEventListener('click', () => {
  sfx.uiClick()
  settingsEl.classList.add('hidden')
  pauseEl.classList.remove('hidden')
})
setIntroCheckbox.addEventListener('change', () => {
  settings.introEnabled = setIntroCheckbox.checked
  saveSettings()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') { if (music.playing) music.stop(); else music.start() }
  // 除錯用：按 B 在主角面前排開 5 隻鳥懸停，方便近距離檢查外觀
  if ((e.key === 'b' || e.key === 'B') && playing) {
    const spots = getPlatformSpots()
    let nearest = spots[0], bestD = Infinity
    for (const p of spots) {
      const d = (p.x - PLAYER_POS.x) ** 2 + (p.z - PLAYER_POS.z) ** 2
      if (d < bestD) { bestD = d; nearest = p }
    }
    if (nearest) spawnBirdLineup(scene, new THREE.Vector3(nearest.x, nearest.topY, nearest.z))
  }
  // 按 G 在空地上生成一隻殭屍
  if ((e.key === 'g' || e.key === 'G') && playing) {
    const spot = pickGroundSpot(35, 35, true)
    if (spot) spawnZombie(scene, spot.x, spot.z, getTerrainHeightAt(spot.x, spot.z))
  }
  // ESC 或空白鍵都可以從暫停畫面直接恢復（只有暫停選單本身顯示時才生效，設定子選單開著時不算）
  if ((e.key === 'Escape' || e.key === ' ') && paused && !pauseEl.classList.contains('hidden')) {
    e.preventDefault()
    sfx.uiClick()
    hidePause()
  }
})

// windowFocused 涵蓋「切到其他應用程式視窗」（只有 window.blur/focus 會觸發，
// document.hidden 不一定會變），document.hidden 涵蓋「切瀏覽器分頁」，兩個都要擋
let windowFocused = true
cameraRig.onLockChange = (locked) => {
  // 切分頁/切視窗會被瀏覽器強制解除滑鼠鎖定，這種情況不跳暫停選單，
  // 讓玩家點回畫面時能直接接續操作，不用先按「繼續」
  if (!locked && playing && !paused && !matchOver && !document.hidden && windowFocused) showPause()
}

function suspendChargeForBackground() {
  charging = false
  trajectoryPreview.hide()
  powerFillEl.style.width = '0%'
}
// 分頁被切到背景、或整個瀏覽器視窗失去焦點時，先把正在蓄力的動作收掉，
// 避免切回來時蓄力時間算得莫名其妙
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendChargeForBackground() })
window.addEventListener('blur', () => { windowFocused = false; suspendChargeForBackground() })
window.addEventListener('focus', () => { windowFocused = true })

loadingEl.classList.add('hidden')

// ---- 左上角對手肖像：用 scissor 在同一張畫布挖一小塊，另外用一台相機即時渲染 AI 全身 ----
// 拉遠 + 看向骨盆（身體中心）才能同時看到頭到腳，方便一眼看出中箭部位
const portraitCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 20)
const PORTRAIT_RECT = { x: 19, yTop: 19, w: 230, h: 230 }
const _pcMid = new THREE.Vector3(), _pcFwd = new THREE.Vector3()
const _scareTmp = new THREE.Vector3()
const _playerPosTmp = new THREE.Vector3(), _aiPosTmp = new THREE.Vector3()
const SCARE_RADIUS_SQ = 4 * 4   // 箭矢進入角色 4 公尺內就嚇飛停在他身上的鳥
function updatePortraitCamera() {
  aiArcher.pelvis.getWorldPosition(_pcMid)
  _pcFwd.set(0, 0, -1).applyQuaternion(aiArcher.root.quaternion)
  portraitCamera.position.copy(_pcMid).addScaledVector(_pcFwd, 5.4)
  portraitCamera.position.y += 0.15
  portraitCamera.lookAt(_pcMid)
}
function renderPortrait() {
  const w = window.innerWidth, h = window.innerHeight
  const sy = h - PORTRAIT_RECT.yTop - PORTRAIT_RECT.h
  renderer.setScissorTest(true)
  renderer.setViewport(PORTRAIT_RECT.x, sy, PORTRAIT_RECT.w, PORTRAIT_RECT.h)
  renderer.setScissor(PORTRAIT_RECT.x, sy, PORTRAIT_RECT.w, PORTRAIT_RECT.h)
  renderer.render(scene, portraitCamera)
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, w, h)
}

// ---- resize ----
function onResize() {
  const w = window.innerWidth, h = window.innerHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', onResize)
onResize()

// ---- 主迴圈 ----
const clock = new THREE.Clock()
function loop() {
  requestAnimationFrame(loop)
  const dt = Math.min(clock.getDelta(), 0.05)

  updateDayNight(camera.position)
  updateWind(dt)
  updateEnvironment(dt)
  updateBirds(dt, scene, [playerArcher, aiArcher])

  if (playing && !paused) {
    overheadBirdT -= dt
    if (overheadBirdT <= 0) {
      overheadBirdT = 10
      spawnBirdOverCorridor(scene, DUEL_DISTANCE)
    }
  }

  if (playing && introActive) {
    if (!paused) {
      introT += dt
      updateIntroCamera(introT / INTRO_DUR)
      if (introT >= INTRO_DUR) endIntro()
    }
    renderer.render(scene, camera)
    return
  }

  if (playing && !paused) {
    if (armsRestT > 0) armsRestT = Math.max(0, armsRestT - dt)
    crosshairForbiddenEl.classList.toggle('show', armsRestT > 0)

    let drawPower = 0
    if (charging && !cameraRig.cutting) {
      chargeT += dt
      if (chargeT > MAX_CHARGE_HOLD) {
        // 撐太久拉不住，手放下，這一箭作廢，休息一段時間才能重新拉弓
        cancelCharge()
        armsRestT = ARMS_REST_DURATION
        hitLabelEl.textContent = '手臂撐不住了，先休息一下…'
        hitLabelEl.classList.add('show')
        clearTimeout(hitLabelTimer)
        hitLabelTimer = setTimeout(() => hitLabelEl.classList.remove('show'), 900)
      } else {
        // 蓄力飄動：一律疊加正弦波動，讓蓄力值（連帶箭速/飛行距離）在拉弓過程中上下飄，
        // 玩家看得到蓄力條在飄、預覽彈道弧線也會跟著變長變短；拉超過 INTENSE_DRIFT_START 秒後
        // 手開始撐不住，飄動幅度/頻率再放大，蓄力條會劇烈上下亂跳
        const intense = chargeT > INTENSE_DRIFT_START
        const amp = intense ? chargeDriftAmp * INTENSE_DRIFT_AMP_MULT : chargeDriftAmp
        const freq = intense ? chargeDriftFreq * INTENSE_DRIFT_FREQ_MULT : chargeDriftFreq
        drawPower = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
        drawPower = Math.max(0.12, Math.min(1, drawPower + Math.sin(chargeT * freq + chargeDriftPhase) * amp))
        currentDrawPower = drawPower
        powerFillEl.style.width = (drawPower * 100) + '%'
        const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * drawPower
        trajectoryPreview.show(shotOrigin(), cameraRig.getAimDirection(), speed)
      }
    }
    if (!matchOver) aiController.update(dt)
    arrowManager.update(dt)
    aiArcher.update(dt)
    playerArcher.update(dt)
    playerArcher.setDrawPower(drawPower)

    playerArcher.root.getWorldPosition(_playerPosTmp)
    aiArcher.root.getWorldPosition(_aiPosTmp)

    // 命中偵測：箭矢本幀掃過的線段 vs 目標的 14 個命中區膠囊
    for (const a of arrowManager.arrows) {
      if (a.stuck) continue
      // 先測試這發箭有沒有打中鳥：命中就插在鳥身上、鳥死掉，這發箭這幀就不用再測角色了
      const birdHit = testArrowHitBird(a.prevPos, a.mesh.position, ARROW_RADIUS)
      if (birdHit) {
        a.stuck = true
        a.age = 0
        a.mesh.position.copy(birdHit.mesh.position)
        birdHit.mesh.attach(a.mesh)
        killBird(birdHit)
        continue
      }
      // 再測試有沒有打中殭屍：命中會插在殭屍身上、記一次命中並讓殭屍鎖定射手
      const zombieHit = testArrowHitZombie(a.prevPos, a.mesh.position, ARROW_RADIUS)
      if (zombieHit) {
        a.stuck = true
        a.age = 0
        a.mesh.position.copy(zombieHit.mesh.position)
        zombieHit.mesh.attach(a.mesh)
        zombieHit.onHitByArrow({ playerArcher, aiArcher, playerPos: _playerPosTmp, aiPos: _aiPosTmp })
        continue
      }
      const target = a.ownerSide === 'player' ? aiArcher : playerArcher
      // 箭矢飛近目標時，先把停在他身上/頭上的鳥嚇飛
      target.pelvis.getWorldPosition(_scareTmp)
      if (a.mesh.position.distanceToSquared(_scareTmp) < SCARE_RADIUS_SQ) scareAwayBirdsOn(target)
      const hit = testArrowHit(a.prevPos, a.mesh.position, target, ARROW_RADIUS)
      if (!hit) continue
      a.stuck = true
      a.age = 0
      a.mesh.position.copy(hit.point)
      hit.origin.attach(a.mesh)
      handleHit(target, hit, a)
    }

    updateZombies(dt, {
      playerArcher, aiArcher, playerPos: _playerPosTmp, aiPos: _aiPosTmp,
      playerCharging: charging, aiCharging: aiController.state === 'drawing',
      onZombieAttack: applyZombieBite, getGroundHeight: getTerrainHeightAt,
      isWaterAt, obstacles: getObstacles(),
    })

    const wasCutting = cameraRig.cutting
    cameraRig.update(dt)
    if (cameraRig.cutting) {
      crosshairEl.classList.add('hidden')
      powerEl.classList.add('hidden')
    } else if (wasCutting) {
      playerArcher.root.visible = false
      crosshairEl.classList.remove('hidden')
      powerEl.classList.remove('hidden')
    }
  }

  renderer.render(scene, camera)
  if (playing) { updatePortraitCamera(); renderPortrait() }
}
loop()
