import * as THREE from 'three'
import { HIT_ZONES } from './hitzones.js'

// ============================================================
//  程序化幾何弓箭手角色（不依賴外部人形模型/動作素材）
//  用巢狀 THREE.Group 手刻一套「關節鏈」，每個節段的膠囊視覺網格
//  跟命中判定膠囊共用同一組 origin(關節) + endOffset(節段向量) 資料，
//  兩者永遠對齊，不需要另外做除錯線框。
// ============================================================

const SKIN = 0xd9a878

// 弓：用明確的曲線控制點畫出弓臂，握把處往 -Z（前方/目標方向）凸出、
// 上下弓端往 +Z（archer 自己這一側）收，讓彎曲的地方朝前，弦則在 +Z 那一側。
// 弓弦依蓄力往 +Z（archer 方向）拉開。掛在持弓手（左手腕）上。
function buildBow() {
  const g = new THREE.Group()
  const bowMat = new THREE.MeshStandardMaterial({ color: 0x5c4326, roughness: 0.7 })
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.32, 0.05),
    new THREE.Vector3(0, 0.16, -0.04),
    new THREE.Vector3(0, 0, -0.06),
    new THREE.Vector3(0, -0.16, -0.04),
    new THREE.Vector3(0, -0.32, 0.05),
  ])
  const limb = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.014, 6, false), bowMat)
  g.add(limb)

  const stringMat = new THREE.LineBasicMaterial({ color: 0xe8e0c8 })
  const stringGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.32, 0.05), new THREE.Vector3(0, 0, 0.05), new THREE.Vector3(0, -0.32, 0.05),
  ])
  const string = new THREE.Line(stringGeo, stringMat)
  g.add(string)
  g.userData.stringGeo = stringGeo
  return g
}

// 搭在弦上的箭矢視覺（純裝飾，實際命中判定的箭矢是 arrow.js 另外生成的）。
// 右撇子射手：弓跟箭都在左手（持弓手），箭身貼著弓的握把、箭頭朝前，
// 尾端往 +Z 延伸到弦的位置，蓄力時才顯示。
function buildNockedArrow() {
  const g = new THREE.Group()
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.75, 5),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 })
  )
  shaft.rotation.x = Math.PI / 2
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.02, 0.1, 6),
    new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.5, roughness: 0.4 })
  )
  head.rotation.x = -Math.PI / 2
  head.position.z = -0.42
  g.add(shaft, head)
  g.position.set(0.025, 0, 0.05)   // 貼著弓的握把、跟弦同一個深度，稍微偏開避免跟弓桿重疊
  g.visible = false
  return g
}

// 受傷反應：命中部位的關節甩動一下再彈回原位，幅度/持續時間依分級遞增
// （手臂/前臂拉弓關節固定往下甩，模擬中箭手臂下沉；其他部位方向隨機）
const REACTION_KICK = {
  light: { amp: 0.22, dur: 0.18 },
  medium: { amp: 0.5, dur: 0.35 },
  heavy: { amp: 0.85, dur: 0.55 },
}
// 拉弓中「任何部位」中箭都會讓拉弓姿勢整體下沉一點（依傷害分級），不只是打中手臂本身才有反應
const DRAW_DISRUPT = { light: 0.18, medium: 0.45, heavy: 0.8 }
const DRAW_DISRUPT_DUR = 0.5
const DRAW_POSE_JOINTS = ['upperArm_L', 'upperArm_R', 'foreArm_R']
const DEATH_DUR = 0.6
const FACE_SIZE = 128

// 用 2D canvas 畫一張簡易卡通臉貼到頭上：平常笑臉，偶爾緊張/挑釁，中箭時痛苦
function drawFace(ctx, expr) {
  const s = FACE_SIZE, cx = s / 2, eyeY = s * 0.42, eyeDX = s * 0.16, eyeR = s * 0.055
  ctx.clearRect(0, 0, s, s)
  ctx.save()
  ctx.beginPath(); ctx.arc(cx, s / 2, s / 2, 0, Math.PI * 2); ctx.clip()
  ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillRect(0, 0, s, s)
  ctx.strokeStyle = '#2a1c10'; ctx.fillStyle = '#2a1c10'
  ctx.lineWidth = s * 0.035; ctx.lineCap = 'round'; ctx.lineJoin = 'round'

  if (expr === 'pain') {
    // 緊閉的眼睛（下彎弧線）+ 皺眉 + 咬牙嘴
    for (const dx of [-eyeDX, eyeDX]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx - eyeR, eyeY); ctx.quadraticCurveTo(cx + dx, eyeY - eyeR * 1.5, cx + dx + eyeR, eyeY)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY - s * 0.11); ctx.lineTo(cx - eyeR * 0.4, eyeY - s * 0.02); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX + eyeR, eyeY - s * 0.11); ctx.lineTo(cx + eyeR * 0.4, eyeY - s * 0.02); ctx.stroke()
    const mw = s * 0.2, my = s * 0.67
    ctx.beginPath(); ctx.moveTo(cx - mw, my)
    ctx.lineTo(cx - mw * 0.4, my + s * 0.05); ctx.lineTo(cx, my); ctx.lineTo(cx + mw * 0.4, my + s * 0.05); ctx.lineTo(cx + mw, my)
    ctx.stroke()
  } else if (expr === 'nervous') {
    // 睜大眼睛 + 擔心挑眉 + 小 O 嘴 + 一滴汗
    for (const dx of [-eyeDX, eyeDX]) { ctx.beginPath(); ctx.arc(cx + dx, eyeY, eyeR * 0.85, 0, Math.PI * 2); ctx.fill() }
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY - s * 0.14); ctx.lineTo(cx - eyeDX + eyeR, eyeY - s * 0.18); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX - eyeR, eyeY - s * 0.18); ctx.lineTo(cx + eyeDX + eyeR, eyeY - s * 0.14); ctx.stroke()
    ctx.beginPath(); ctx.ellipse(cx, s * 0.68, s * 0.045, s * 0.06, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#7ec8e3'
    const sx = cx + eyeDX + eyeR * 2.1, sy = eyeY - s * 0.04
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.quadraticCurveTo(sx + s * 0.045, sy + s * 0.09, sx, sy + s * 0.14)
    ctx.quadraticCurveTo(sx - s * 0.045, sy + s * 0.09, sx, sy)
    ctx.fill()
  } else if (expr === 'taunt') {
    // 一邊瞇眼一邊挑眉 + 嘴角上揚的挑釁笑
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY); ctx.lineTo(cx - eyeDX + eyeR, eyeY); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx + eyeDX, eyeY, eyeR * 0.8, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX - eyeR, eyeY - s * 0.2); ctx.lineTo(cx + eyeDX + eyeR, eyeY - s * 0.1); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - s * 0.16, s * 0.66); ctx.quadraticCurveTo(cx + s * 0.02, s * 0.71, cx + s * 0.2, s * 0.58); ctx.stroke()
  } else if (expr === 'effort') {
    // 拉弓出力：兩眼半瞇用力 + 眉頭深鎖 + 咬緊牙關的一字嘴
    for (const dx of [-eyeDX, eyeDX]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx - eyeR, eyeY - eyeR * 0.3); ctx.lineTo(cx + dx + eyeR, eyeY - eyeR * 0.3)
      ctx.stroke()
    }
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY - s * 0.14); ctx.lineTo(cx - eyeR * 0.3, eyeY - s * 0.06); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX + eyeR, eyeY - s * 0.14); ctx.lineTo(cx + eyeR * 0.3, eyeY - s * 0.06); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - s * 0.16, s * 0.66); ctx.lineTo(cx + s * 0.16, s * 0.66); ctx.stroke()
  } else if (expr === 'aim') {
    // 拉滿弓瞄準：閉右眼、睜左眼瞇著看（右撇子瞄準姿勢）+ 專注眉 + 抿緊的嘴
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY); ctx.lineTo(cx - eyeDX + eyeR, eyeY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX - eyeR * 0.9, eyeY); ctx.lineTo(cx + eyeDX + eyeR * 0.9, eyeY - eyeR * 0.3); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx + eyeDX, eyeY - eyeR * 0.15, eyeR * 0.55, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(cx - eyeDX - eyeR, eyeY - s * 0.13); ctx.lineTo(cx - eyeDX + eyeR, eyeY - s * 0.11); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx + eyeDX - eyeR, eyeY - s * 0.16); ctx.lineTo(cx + eyeDX + eyeR, eyeY - s * 0.12); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx - s * 0.12, s * 0.65); ctx.lineTo(cx + s * 0.12, s * 0.65); ctx.stroke()
  } else {
    // happy（預設微笑）
    for (const dx of [-eyeDX, eyeDX]) { ctx.beginPath(); ctx.arc(cx + dx, eyeY, eyeR * 0.8, 0, Math.PI * 2); ctx.fill() }
    ctx.beginPath(); ctx.moveTo(cx - s * 0.17, s * 0.62); ctx.quadraticCurveTo(cx, s * 0.75, cx + s * 0.17, s * 0.62); ctx.stroke()
  }
  ctx.restore()
}

function addSegmentMesh(originGroup, endOffset, radius, color) {
  const length = endOffset.length()
  const capLen = Math.max(length - radius * 2, 0.02)
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, capLen, 2, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75 })
  )
  const dir = endOffset.clone().normalize()
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  mesh.position.copy(endOffset).multiplyScalar(0.5)
  mesh.castShadow = true
  originGroup.add(mesh)
  return mesh
}

function joint(parent, x, y, z) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

export class Archer {
  constructor(teamColor, side) {
    this.side = side              // 'player' | 'ai'
    this.hp = 100
    this.dead = false
    this.parts = {}               // name -> { origin: Group, endOffset: Vector3 }
    this._t = Math.random() * 10  // idle 搖擺相位錯開，兩邊動作不會同步

    const trouser = 0x5c4326
    const boot = 0x2e2018

    this.root = new THREE.Group()

    // ---- 軀幹 ----
    const pelvis = joint(this.root, 0, 0.9, 0)
    this.pelvis = pelvis
    this._zone('chest', pelvis, new THREE.Vector3(0, 0.5, 0), teamColor)
    const neck = joint(pelvis, 0, 0.5, 0)
    this.neck = neck
    const headOffset = new THREE.Vector3(0, 0.18, 0)
    this._zone('head', neck, headOffset, SKIN, true)
    this._buildFace(neck, headOffset, HIT_ZONES.head.radius)

    // ---- 雙臂（肩膀掛在頸部關節上）----
    this._buildArm(neck, -1, teamColor)
    this._buildArm(neck, 1, teamColor)

    // ---- 弓 + 搭在弦上的箭：右撇子射手，兩者都掛在持弓手（左手腕）上 ----
    // rotation.x 會在 setDrawPower() 依拉弓手臂的擺動角度即時抵銷，讓弓/箭方向
    // 固定跟著身體軀幹、不會因為手臂從垂下擺到平舉就跟著轉來轉去
    this.bow = buildBow()
    this.bow.position.set(0, -0.06, 0)
    this.wristL.add(this.bow)
    this.nockedArrow = buildNockedArrow()
    this.wristL.add(this.nockedArrow)

    // ---- 雙腿（髖關節掛在骨盆上）----
    this._buildLeg(pelvis, -1, trouser, boot)
    this._buildLeg(pelvis, 1, trouser, boot)
  }

  _zone(name, origin, endOffset, color, isSphere = false) {
    const radius = HIT_ZONES[name].radius
    let mesh
    if (isSphere) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
      )
      mesh.position.copy(endOffset)
      mesh.castShadow = true
      origin.add(mesh)
    } else {
      mesh = addSegmentMesh(origin, endOffset, radius, color)
    }
    this.parts[name] = { origin, endOffset: endOffset.clone(), mesh }
  }

  // 臉貼在頭部球體正前方（角色面朝的 -Z 方向），用 CanvasTexture 畫表情
  _buildFace(neck, headOffset, radius) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = FACE_SIZE
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.05, 28), mat)
    mesh.rotation.y = Math.PI
    mesh.position.copy(headOffset)
    mesh.position.z -= radius * 0.97
    neck.add(mesh)
    this._face = { ctx, texture, expr: '' }
    this._faceTimer = 2 + Math.random() * 3
    this._painT = 0
    this._scared = false   // AI 附近有殭屍、暫緩蓄力時外部設成 true，表情固定顯示害怕
    this._setExpression('happy')
  }

  // 外部（目前是 AI 對手的殭屍警戒判斷）呼叫：附近有殭屍不敢蓄力時表情固定顯示害怕，
  // 蓋過待機時的隨機表情循環，直到呼叫 setScared(false) 解除（中箭痛苦表情優先權更高）
  setScared(active) {
    this._scared = active
  }

  _setExpression(expr) {
    if (!this._face || this._face.expr === expr) return
    this._face.expr = expr
    drawFace(this._face.ctx, expr)
    this._face.texture.needsUpdate = true
  }

  // 命中閃白回饋：材質短暫變白再淡回原色，不需要額外的除錯線框就能確認打中哪一區
  flashPart(name, duration = 0.18) {
    const part = this.parts[name]
    if (!part) return
    this._flash = this._flash || {}
    this._flash[name] = { t: duration, dur: duration }
  }

  _buildArm(neck, side, color) {
    const tag = side < 0 ? 'L' : 'R'
    const shoulder = joint(neck, 0.20 * side, -0.05, 0)
    this._zone(`upperArm_${tag}`, shoulder, new THREE.Vector3(0, -0.28, 0), color)
    const elbow = joint(shoulder, 0, -0.28, 0)
    this._zone(`foreArm_${tag}`, elbow, new THREE.Vector3(0, -0.26, 0), color)
    const wrist = joint(elbow, 0, -0.26, 0)
    this._zone(`hand_${tag}`, wrist, new THREE.Vector3(0, -0.19, 0), SKIN)
    if (side < 0) { this.shoulderL = shoulder; this.elbowL = elbow; this.wristL = wrist }
    else { this.shoulderR = shoulder; this.elbowR = elbow; this.wristR = wrist }
  }

  _buildLeg(pelvis, side, trouser, boot) {
    const tag = side < 0 ? 'L' : 'R'
    const hip = joint(pelvis, 0.11 * side, -0.02, 0)
    this._zone(`thigh_${tag}`, hip, new THREE.Vector3(0, -0.42, 0), trouser)
    const knee = joint(hip, 0, -0.42, 0)
    this._zone(`shin_${tag}`, knee, new THREE.Vector3(0, -0.40, 0), trouser)
    const ankle = joint(knee, 0, -0.40, 0)
    this._zone(`foot_${tag}`, ankle, new THREE.Vector3(0, -0.04, -0.18), boot)   // -Z 朝臉的前方，先前正負號打反了
  }

  setPosition(x, y, z) { this.root.position.set(x, y, z) }
  setFacing(yRad) { this.root.rotation.y = yRad }

  // 依蓄力進度（0~1）驅動拉弓姿勢：左臂（持弓手）舉平前伸，右臂（拉弦手）舉平後把前臂折回靠近肩頭
  // 存成「基準姿勢」角度，實際套用時會疊加受傷甩動反應（見 _applyPose），
  // 這樣中箭時是在拉弓姿勢上抖一下，甩動結束後會自然接回目前的拉弓進度，不會整隻手臂彈回原點
  setDrawPower(power) {
    this._drawPower = Math.max(0, Math.min(1, power))
    const p = this._drawPower
    this._basePose = this._basePose || {}
    this._basePose.upperArm_L = (Math.PI / 2) * p
    this._basePose.upperArm_R = (Math.PI / 2) * p
    this._basePose.foreArm_R = Math.PI * p
    this._applyPose('upperArm_L')
    this._applyPose('upperArm_R')
    this._applyPose('foreArm_R')

    // 表情跟著蓄力進度走：拉弓出力 → 拉滿瞇眼瞄準 → 放開後回到平常表情；
    // 中箭痛苦表情（_painT）優先，不要被這裡搶走
    if (this._painT <= 0) {
      if (p > 0.85) this._setExpression('aim')
      else if (p > 0.03) this._setExpression('effort')
      else if (!this._scared) { this._setExpression('happy'); this._faceTimer = 2 + Math.random() * 3 }
    }

    // 抵銷持弓手肩膀的擺動角度，弓/箭的方向固定跟著軀幹，不會因為手臂平舉起來而跟著轉向
    const counterRot = -this._basePose.upperArm_L
    this.bow.rotation.x = counterRot
    this.nockedArrow.rotation.x = counterRot

    // 弓弦跟著蓄力往後拉開，搭箭視覺蓄力時才顯示、放開後收起
    const pts = this.bow.userData.stringGeo.attributes.position
    pts.setZ(1, 0.05 + p * 0.24)
    pts.needsUpdate = true
    this.nockedArrow.visible = p > 0.02
  }

  // 把「基準姿勢角度」+「該關節自己的受傷甩動」+「拉弓整體下沉（任何部位中箭都算）」合成後寫入 rotation.x
  _applyPose(zoneName) {
    const part = this.parts[zoneName]
    if (!part) return
    const base = (this._basePose && this._basePose[zoneName]) || 0
    const r = this._reactions && this._reactions[zoneName]
    const kick = r ? r.axis * r.amp * (r.t / r.dur) : 0
    let disrupt = 0
    if (DRAW_POSE_JOINTS.includes(zoneName) && this._drawDisruptT > 0) {
      disrupt = -this._drawDisruptAmt * (this._drawDisruptT / DRAW_DISRUPT_DUR)
    }
    part.origin.rotation.x = base + kick + disrupt
  }

  // 拉弓中被射中（不論打到哪個部位）都呼叫這個，讓拉弓姿勢整體往下沉一點，依傷害分級決定沉多少
  disruptDraw(tier) {
    const amt = DRAW_DISRUPT[tier]
    if (!amt) return
    this._drawDisruptAmt = amt
    this._drawDisruptT = DRAW_DISRUPT_DUR
  }

  // 再來一局：血量/存活狀態/動畫全部復原（掛在身上的箭矢由外部呼叫 ArrowManager.clear() 一併清除）
  reset() {
    this.hp = 100
    this.dead = false
    this._deathT = 0
    this.root.rotation.x = 0
    this._flash = {}
    this._reactions = {}
    this._drawDisruptT = 0
    this._drawDisruptAmt = 0
    for (const name in this.parts) {
      const part = this.parts[name]
      part.origin.rotation.set(0, 0, 0)
      part.mesh.material.emissive.setHex(0x000000)
    }
    this._painT = 0
    this._scared = false
    this._faceTimer = 2 + Math.random() * 3
    this._setExpression('happy')
    this.setDrawPower(0)
  }

  // 命中部位的關節甩一下再彈回，讓不同部位、不同分級的受傷反應看起來不一樣
  triggerReaction(zoneName, tier) {
    const cfg = REACTION_KICK[tier]
    if (!cfg || !this.parts[zoneName]) return
    this._reactions = this._reactions || {}
    this._reactions[zoneName] = {
      dur: cfg.dur, t: cfg.dur,
      axis: DRAW_POSE_JOINTS.includes(zoneName) ? -1 : (Math.random() < 0.5 ? 1 : -1),
      amp: cfg.amp,
    }
  }

  update(dt) {
    this._decayFlash(dt)

    if (this.dead) {
      this._deathT = (this._deathT || 0) + dt
      const k = Math.min(1, this._deathT / DEATH_DUR)
      const eased = 1 - (1 - k) * (1 - k)   // ease-out：倒下前段快、快倒地時變慢
      this.root.rotation.x = -eased * 1.3
      return
    }

    // 待機時的細微搖擺，讓角色不會像塑膠模型一樣完全靜止不動
    this._t += dt
    this.pelvis.rotation.z = Math.sin(this._t * 1.3) * 0.02
    this.neck.rotation.y = Math.sin(this._t * 0.9) * 0.03

    // 表情優先順序：中箭痛苦 > 附近有殭屍害怕（外部 setScared 設定）> 待機隨機循環的笑臉/緊張/挑釁
    if (this._painT > 0) {
      this._painT -= dt
      if (this._painT <= 0) this._setExpression(this._scared ? 'nervous' : 'happy')
    } else if (this._scared) {
      this._setExpression('nervous')
    } else {
      this._faceTimer -= dt
      if (this._faceTimer <= 0) {
        const pool = ['happy', 'happy', 'happy', 'nervous', 'taunt']
        this._setExpression(pool[Math.floor(Math.random() * pool.length)])
        this._faceTimer = 2.5 + Math.random() * 4
      }
    }

    if (this._reactions) {
      for (const name in this._reactions) {
        const r = this._reactions[name]
        r.t -= dt
        if (r.t <= 0) delete this._reactions[name]
        this._applyPose(name)
      }
    }

    if (this._drawDisruptT > 0) {
      this._drawDisruptT -= dt
      for (const name of DRAW_POSE_JOINTS) this._applyPose(name)
    }
  }

  _decayFlash(dt) {
    if (!this._flash) return
    for (const name in this._flash) {
      const f = this._flash[name]
      f.t -= dt
      const mat = this.parts[name].mesh.material
      if (f.t <= 0) { mat.emissive.setHex(0x000000); delete this._flash[name] }
      else { mat.emissive.setHex(0xffffff); mat.emissiveIntensity = f.t / f.dur }
    }
  }

  // 套用傷害：致命區直接歸零並觸發倒地動畫；非致命依分級扣血+關節甩動反應
  // 回傳 { fatal, tier } 供上層（main.js）決定要不要打亂視角瞄準/中斷蓄力
  applyDamage(zoneName, damage, tier) {
    if (this.dead) return { fatal: false, tier }
    this.hp = damage === Infinity ? 0 : Math.max(0, this.hp - damage)
    this.flashPart(zoneName)
    this._setExpression('pain')
    this._painT = 0.55
    if (this.hp <= 0) {
      this.dead = true
      this._deathT = 0
      return { fatal: true, tier }
    }
    this.triggerReaction(zoneName, tier)
    this.disruptDraw(tier)
    return { fatal: false, tier }
  }
}
