import * as THREE from 'three'
import { CameraRig } from './camera.js'
import { ArrowManager, TrajectoryPreview, CHARGE_TIME, SPEED_MIN, SPEED_MAX, ARROW_RADIUS } from './arrow.js'
import { Archer } from './archer.js'
import { testArrowHit, TIER_AIM_NOISE } from './hitzones.js'
import { AIController } from './ai.js'
import { initAudio, sfx, music } from './sfx.js'
import { buildEnvironment, updateEnvironment, getPlatformSpots, pickGroundSpot, getTerrainHeightAt, isWaterAt, getObstacles } from './scene.js'
import { initDayNight, updateDayNight } from './daynight.js'
import { updateWind } from './wind.js'
import { updateBirds, spawnBirdFlushNear, spawnBirdOverCorridor, scareAwayBirdsOn, spawnBirdLineup, testArrowHitBird, killBird } from './birds.js'
import { spawnZombie, updateZombies, testArrowHitZombie, resetZombieBiteImmunity } from './zombie.js'

// ============================================================
//  弓箭手對決（第一人稱瞄準 + 站定對戰）— M1+M2: 場景/相機 + 蓄力射箭
// ============================================================

const DUEL_DISTANCE = 25          // 雙方站位間距（公尺）
const EYE = new THREE.Vector3(0, 1.7, DUEL_DISTANCE / 2)   // 玩家眼睛位置（固定，面向 -z）

// ---- 開場空拍機運鏡：起飛遠離 → 繞場地一圈 → 飛回第一人稱視角 ----
const INTRO_DUR = 9.0
const ARENA_CENTER = new THREE.Vector3(0, 1.6, 0)
const ORBIT_R = 20, ORBIT_H = 9
const ORBIT_START_ANGLE = Math.PI / 2   // 對應 (center.x, H, center.z+R)，在玩家那一側起飛/降落，銜接不跳動
function orbitPoint(angle) {
  return new THREE.Vector3(ARENA_CENTER.x + Math.cos(angle) * ORBIT_R, ORBIT_H, ARENA_CENTER.z + Math.sin(angle) * ORBIT_R)
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

// ---- 場地佈置（地形起伏 + 湖泊 + 河流 + 樹木 + 石頭 + 草叢 + 觀戰高台）----
buildEnvironment(scene, renderer, DUEL_DISTANCE)

// ---- 雙方弓箭手（程序化幾何人形，14 個命中區節段）----
const PLAYER_POS = new THREE.Vector3(0, 0, DUEL_DISTANCE / 2)
const OPPONENT_POS = new THREE.Vector3(0, 0, -DUEL_DISTANCE / 2)

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
const powerEl = document.getElementById('power')
const powerFillEl = document.getElementById('power-fill')
let charging = false
let chargeT = 0

function shotOrigin() {
  // 箭矢從眼睛位置往視線方向前移一點出發，避免箭頭一開始卡在相機視野裡
  const dir = cameraRig.getAimDirection()
  return cameraRig.eye.clone().addScaledVector(dir, 0.5)
}

function fireDown() {
  if (!playing || paused || matchOver || cameraRig.cutting || !cameraRig.locked) return
  charging = true
  chargeT = 0
  sfx.draw()
}
function fireUp() {
  if (!charging) return
  charging = false
  trajectoryPreview.hide()
  powerFillEl.style.width = '0%'
  const power = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
  const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  const dir = cameraRig.getAimDirection()
  arrowManager.spawn(shotOrigin(), dir, speed, 'player')
  sfx.release()
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

// ---- 望遠縮放：按住右鍵 + 滾輪調整視野（不影響實際瞄準方向，純視覺放大） ----
const FOV_DEFAULT = 65, FOV_MIN = 13, FOV_MAX = 65
let rightMouseDown = false
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('mousedown', (e) => { if (e.button === 2) rightMouseDown = true })
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
const hitLabelEl = document.getElementById('hit-label')

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
// 命中方無論哪一邊都會觸發第三人稱運鏡看反應；致命則進入勝負流程
function handleHit(target, hit) {
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

function endMatch(winnerSide) {
  matchOver = true
  charging = false; trajectoryPreview.hide(); powerFillEl.style.width = '0%'
  setTimeout(() => {
    resultEl.classList.remove('hidden')
    resultEl.classList.toggle('win', winnerSide === 'player')
    resultEl.classList.toggle('lose', winnerSide === 'ai')
    resultTitleEl.textContent = winnerSide === 'player' ? '🏆 你贏了！' : '💀 你被擊倒了'
    document.exitPointerLock()
  }, 2200)
}

function restartMatch() {
  matchOver = false
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
  if (!IS_TOUCH) cameraRig.requestLock()
}
document.getElementById('result-retry').addEventListener('click', () => { sfx.uiClick(); restartMatch() })

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
let introPlayedOnce = false   // 只在這個瀏覽器工作階段的第一次開始對決播放運鏡，之後一律跳過

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 存不了就算了，不影響遊玩 */ }
}

function _revealGameplayHud() {
  crosshairEl.classList.remove('hidden')
  powerEl.classList.remove('hidden')
  pauseHintEl.classList.remove('hidden')
  portraitWrapEl.classList.remove('hidden')
  playerHudEl.classList.remove('hidden')
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

  if (settings.introEnabled && !introPlayedOnce) {
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
  introPlayedOnce = true
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
  playing = false
  music.stop()
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
    let drawPower = 0
    if (charging && !cameraRig.cutting) {
      chargeT += dt
      drawPower = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
      powerFillEl.style.width = (drawPower * 100) + '%'
      const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * drawPower
      trajectoryPreview.show(shotOrigin(), cameraRig.getAimDirection(), speed)
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
      handleHit(target, hit)
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
