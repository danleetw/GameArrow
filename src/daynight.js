import * as THREE from 'three'

// ============================================================
//  日夜循環：現實時間 128 倍速換算成遊戲時間，現實每 11.25 分鐘 = 遊戲一整天（24 小時）。
//  用目前這個週期內已經過的秒數，算出對應的遊戲時刻（0~24，0/24=午夜、12=正午），
//  太陽與月亮永遠在天空弧線的兩端（互為正對面），只有仰角在地平線以上的那個會發光、投影，
//  仰角越低強度越低、越接近日出日落的暖色調。負責投影的主光源永遠是仰角較高的那個天體
//  ——白天用太陽、夜晚用月亮，換手發生在兩者仰角都貼近 0 的地平線瞬間，那一刻強度也接近
//  0，所以陰影方向切換不會有明顯跳動。夜晚會保留亮度下限，避免畫面全黑看不清場景。
// ============================================================

const CYCLE_REAL_SECONDS = 675      // 現實 11.25 分鐘 = 遊戲 1 天（128 倍速）
const SKY_DISTANCE = 200            // 太陽/月亮貼圖離場景中心的距離（純視覺用，不影響陰影）
const SHADOW_LIGHT_DISTANCE = 25    // 負責投影的主光源離場景中心的距離，需落在 shadow camera 的 near~far 範圍內

const NIGHT_SKY_TOP = new THREE.Color(0x050912)
const NIGHT_SKY_MID = new THREE.Color(0x1c3050)
const NIGHT_SKY_HORIZON = new THREE.Color(0x33456b)
const DAY_SKY_TOP = new THREE.Color(0x3f7fc9)
const DAY_SKY_MID = new THREE.Color(0x8fb8d8)
const DAY_SKY_HORIZON = new THREE.Color(0xd8c9a3)
const TWILIGHT_MID = new THREE.Color(0xd98a7a)
const TWILIGHT_HORIZON = new THREE.Color(0xff9a56)

const FOG_NIGHT = new THREE.Color(0x1a2740)
const FOG_DAY = new THREE.Color(0xcfd8ea)
const FOG_TWILIGHT = new THREE.Color(0xe08a5c)

const HEMI_SKY_NIGHT = new THREE.Color(0x30456e)
const HEMI_GROUND_NIGHT = new THREE.Color(0x212f24)
const HEMI_SKY_DAY = new THREE.Color(0xbfd4ea)
const HEMI_GROUND_DAY = new THREE.Color(0x6b7a4a)

const SUN_COLOR = new THREE.Color(0xfff0d0)
const SUNSET_COLOR = new THREE.Color(0xff9552)
const MOON_COLOR = new THREE.Color(0xaac0ff)

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// 取得目前遊戲時刻（0~24，0/24=午夜、12=正午）。CYCLE_REAL_SECONDS 小於一小時（3600 秒）時，
// 一個現實時鐘小時內會跑好幾輪，所以要先對 CYCLE_REAL_SECONDS 取餘數，再換算成 0~24 的時刻，
// 不能直接假設一小時只跑一輪（那是 24 倍速、CYCLE_REAL_SECONDS=3600 時的特例）。
export function getGameHour(date = new Date()) {
  const s = date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000
  return ((s % CYCLE_REAL_SECONDS) / CYCLE_REAL_SECONDS) * 24
}

// ---- 月相：依「今天的真實日期」算出目前是農曆哪一天對應的月相，跟遊戲時刻（日夜循環）無關 ----
const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0)   // 已知的一次新月（朔）時刻，UTC
const SYNODIC_MONTH_DAYS = 29.530588853                 // 朔望月週期

// phase：0~1，0=新月(朔)、0.5=滿月(望)、1 回到新月。illum：0~1 月面被照亮的比例（0=全暗、1=全亮）
export function getMoonPhase(date = new Date()) {
  const days = (date.getTime() - REF_NEW_MOON) / 86400000
  let phase = (days % SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS
  if (phase < 0) phase += 1
  const illum = (1 - Math.cos(phase * Math.PI * 2)) / 2
  return { phase, illum }
}

function makeSunTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,240,1)')
  g.addColorStop(0.22, 'rgba(255,247,205,0.95)')
  g.addColorStop(0.55, 'rgba(255,222,140,0.35)')
  g.addColorStop(1, 'rgba(255,222,140,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// 把目前月相畫成真實的月牙/半月/凸月/滿月形狀（北半球／台灣視角：漸盈時右側亮、漸虧時左側亮）。
// 用參數式取樣描邊而不是 canvas 內建的橢圓弧線方向參數，避免弧線方向搞錯導致形狀左右/盈虧顛倒。
function drawMoonTexture(ctx, size, phase) {
  const r = size / 2 * 0.86, cx = size / 2, cy = size / 2
  ctx.clearRect(0, 0, size, size)

  // 外圍柔光暈
  const glow = ctx.createRadialGradient(cx, cy, r * 0.75, cx, cy, size / 2)
  glow.addColorStop(0, 'rgba(210,222,255,0.5)')
  glow.addColorStop(1, 'rgba(210,222,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // 月球暗面（底）
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#232c42'
  ctx.fill()

  // 亮面：外緣半圓（固定在亮側）＋明暗界線橢圓（凸向亮側=眉月/弦月，凸向暗側=凸月/滿月）
  const theta = phase * Math.PI * 2
  const dir = phase < 0.5 ? 1 : -1        // +1=漸盈右側亮，-1=漸虧左側亮
  const ew = dir * Math.cos(theta) * r     // 明暗界線橢圓的水平半徑（含正負號＝凸出方向）
  const steps = 40

  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps
    const x = cx + dir * r * Math.cos(a), y = cy + r * Math.sin(a)
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI / 2 - (Math.PI * i) / steps
    ctx.lineTo(cx + ew * Math.cos(a), cy + r * Math.sin(a))
  }
  ctx.closePath()
  ctx.fillStyle = '#f2f4ff'
  ctx.fill()
}

let hemiLight, ambientLight, keyLight, sunSprite, moonSprite, fog, skyCtx, skyTexture
let moonCtx, moonTexture, lastDrawnMoonPhase = -1

// 建立日夜循環用到的所有場景物件（天空／霧／主光源／環境光／太陽與月亮貼圖），並加入 scene。
// 回傳 keyLight 供需要參考光源方向的地方使用（目前沒有其他模組需要，先留著備用）。
export function initDayNight(scene, { shadowMapSize = 2048 } = {}) {
  const skyCanvas = document.createElement('canvas'); skyCanvas.width = 2; skyCanvas.height = 256
  skyCtx = skyCanvas.getContext('2d')
  skyTexture = new THREE.CanvasTexture(skyCanvas)
  skyTexture.colorSpace = THREE.SRGBColorSpace
  scene.background = skyTexture

  fog = new THREE.Fog(0xcfd8ea, 40, 120)
  scene.fog = fog

  hemiLight = new THREE.HemisphereLight(0xbfd4ea, 0x6b7a4a, 0.95)
  scene.add(hemiLight)

  ambientLight = new THREE.AmbientLight(0xffffff, 0.3)
  scene.add(ambientLight)

  keyLight = new THREE.DirectionalLight(0xfff0d0, 2.6)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(shadowMapSize, shadowMapSize)
  keyLight.shadow.bias = -0.0004
  Object.assign(keyLight.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 60 })
  scene.add(keyLight)

  // ---- 太陽/月亮視覺（跟光源方向對應的發光圓盤，會隨視角正確移動，不是貼死畫面的假太陽）----
  sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeSunTexture(), transparent: true, depthWrite: false, fog: false }))
  sunSprite.scale.set(50, 50, 1)
  scene.add(sunSprite)

  const moonCanvas = document.createElement('canvas'); moonCanvas.width = moonCanvas.height = 256
  moonCtx = moonCanvas.getContext('2d')
  moonTexture = new THREE.CanvasTexture(moonCanvas)
  moonTexture.colorSpace = THREE.SRGBColorSpace
  drawMoonTexture(moonCtx, 256, getMoonPhase().phase)
  moonTexture.needsUpdate = true

  moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture, transparent: true, depthWrite: false, fog: false }))
  moonSprite.scale.set(26, 26, 1)
  scene.add(moonSprite)

  updateDayNight()   // 立刻套用一次目前時刻的樣子，避免開場先閃一幀預設值
  return { keyLight }
}

const _sunDir = new THREE.Vector3()
const _moonDir = new THREE.Vector3()
const _colorA = new THREE.Color()
const _colorB = new THREE.Color()
const _colorC = new THREE.Color()

const _zero = new THREE.Vector3()

// 每幀呼叫：依照目前現實時間換算出的遊戲時刻，更新太陽/月亮角度、主光源、環境光、天空、霧。
// viewerPos：目前攝影機的世界座標，太陽/月亮貼圖要以它為錨點才不會有視差（見下方說明），
// 不傳的話退回世界原點（僅供 initDayNight() 內第一次呼叫時使用）。
export function updateDayNight(viewerPos = _zero) {
  const hour = getGameHour()
  // hour6=日出(0) hour12=正午(π/2) hour18=日落(π) hour0/24=午夜(-π/2，天體在正下方)
  const angle = ((hour - 6) / 24) * Math.PI * 2
  _sunDir.set(Math.cos(angle), Math.sin(angle), 0.35).normalize()
  _moonDir.copy(_sunDir).negate()
  const sunElevation = _sunDir.y
  const moonElevation = _moonDir.y

  // 貼圖要錨在攝影機上、而不是場地原點：太陽/月亮理論上無限遠，方向不該隨玩家站位改變。
  // 之前錨在原點、又只有 200 距離，玩家站位偏離原點時貼圖會出現視差，跟真正的光源方向
  // （水面反光就是照這個方向算的）對不齊，看起來「太陽跟湖面反光沒有連成一直線」。
  sunSprite.position.copy(viewerPos).addScaledVector(_sunDir, SKY_DISTANCE)
  moonSprite.position.copy(viewerPos).addScaledVector(_moonDir, SKY_DISTANCE)
  sunSprite.material.opacity = smoothstep(-0.06, 0.05, sunElevation)
  moonSprite.material.opacity = smoothstep(-0.06, 0.05, moonElevation)

  // 月相依「今天的真實日期」算，變化很慢（一個月才走完一輪），差異夠大才重畫貼圖，不用每幀重畫
  const { phase: moonPhase, illum: moonIllum } = getMoonPhase()
  if (Math.abs(moonPhase - lastDrawnMoonPhase) > 0.0005) {
    drawMoonTexture(moonCtx, 256, moonPhase)
    moonTexture.needsUpdate = true
    lastDrawnMoonPhase = moonPhase
  }

  const daylight = smoothstep(-0.05, 0.2, sunElevation)             // 0=夜晚 1=白天，日出日落前後平滑過渡
  const twilight = 1 - smoothstep(0, 0.28, Math.abs(sunElevation))   // 越接近地平線越大，正午/半夜接近 0

  // 主光源（負責投影）永遠是仰角較高的那個天體：白天太陽、夜晚月亮
  const usingSun = sunElevation >= moonElevation
  const activeDir = usingSun ? _sunDir : _moonDir
  const activeElevation = Math.max(0, usingSun ? sunElevation : moonElevation)
  keyLight.position.copy(activeDir).multiplyScalar(SHADOW_LIGHT_DISTANCE)

  if (usingSun) keyLight.color.copy(SUN_COLOR).lerp(SUNSET_COLOR, twilight)
  else keyLight.color.copy(MOON_COLOR)
  // 月光強度跟著月相走：滿月最亮、新月最暗，但保留下限（1.1），不會因為沒有月亮就整個變暗——
  // 真的沒有月亮時主要靠下面的 hemiLight/ambientLight 撐住畫面亮度
  const moonIntensity = 1.1 + moonIllum * 0.9
  keyLight.intensity = (usingSun ? 2.6 : moonIntensity) * Math.min(1, activeElevation * 3.5)

  hemiLight.color.copy(_colorA.copy(HEMI_SKY_NIGHT).lerp(HEMI_SKY_DAY, daylight))
  hemiLight.groundColor.copy(_colorB.copy(HEMI_GROUND_NIGHT).lerp(HEMI_GROUND_DAY, daylight))
  hemiLight.intensity = 1.0 + daylight * -0.05     // 夜晚保留下限，避免全黑（>=白天的 0.95），跟月相無關

  ambientLight.intensity = 0.3 + (1 - daylight) * 0.6

  const top = _colorA.copy(NIGHT_SKY_TOP).lerp(DAY_SKY_TOP, daylight)
  const mid = _colorB.copy(NIGHT_SKY_MID).lerp(DAY_SKY_MID, daylight).lerp(TWILIGHT_MID, twilight * 0.5)
  const horizon = _colorC.copy(NIGHT_SKY_HORIZON).lerp(DAY_SKY_HORIZON, daylight).lerp(TWILIGHT_HORIZON, twilight * 0.7)
  const g = skyCtx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#' + top.getHexString())
  g.addColorStop(0.55, '#' + mid.getHexString())
  g.addColorStop(1, '#' + horizon.getHexString())
  skyCtx.fillStyle = g
  skyCtx.fillRect(0, 0, 2, 256)
  skyTexture.needsUpdate = true

  fog.color.copy(_colorA.copy(FOG_NIGHT).lerp(FOG_DAY, daylight).lerp(FOG_TWILIGHT, twilight * 0.5))
}
