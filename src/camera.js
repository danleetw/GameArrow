import * as THREE from 'three'

const SENS = 0.0022
const PITCH_MIN = -1.3, PITCH_MAX = 1.3

// 第一人稱指標鎖定視角控制（沿用 angrybird 的固定 EYE + yaw/pitch 模式）
// 另外支援命中時短暫切到第三人稱運鏡看反應動作，結束後平滑切回第一人稱
export class CameraRig {
  constructor(camera, canvas, eye) {
    this.camera = camera
    this.canvas = canvas
    this.eye = eye.clone()
    this.yaw = 0
    this.pitch = 0
    this.locked = false
    this.sensitivity = 1

    this.aimNoise = { yaw: 0, pitch: 0 }   // 被命中時注入，每幀指數衰減，模擬中箭的瞄準後座反應
    this.cutting = false                   // 是否正處於命中運鏡（第三人稱）

    // 拉弓時的持續性準星飄動（跟 aimNoise 不同：不會自動衰減，玩家要自己動滑鼠/拖曳抵銷，
    // 放開弓或取消蓄力時才會歸零）——見 startSway()/stopSway()
    this.sway = { yaw: 0, pitch: 0 }
    this.swayActive = false
    this.swayT = 0

    camera.rotation.order = 'YXZ'
    camera.position.copy(this.eye)
    this._applyRotation()

    this._onPointerLockChange = this._onPointerLockChange.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
    document.addEventListener('pointerlockchange', this._onPointerLockChange)
    document.addEventListener('mousemove', this._onMouseMove)
  }

  requestLock() {
    this.canvas.requestPointerLock()
  }

  _onPointerLockChange() {
    this.locked = document.pointerLockElement === this.canvas
    if (this.onLockChange) this.onLockChange(this.locked)
  }

  _onMouseMove(e) {
    if (!this.locked) return
    this.yaw -= e.movementX * SENS * this.sensitivity
    this.pitch -= e.movementY * SENS * this.sensitivity
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch))
    this._applyRotation()
  }

  // 觸控拖曳版視角調整：跟滑鼠版同一套換算，但不經過 Pointer Lock（觸控裝置不支援/不需要這個
  // 機制），由呼叫端直接算好這一幀的位移量（像素）餵進來
  applyTouchDelta(dx, dy) {
    this.yaw -= dx * SENS * this.sensitivity
    this.pitch -= dy * SENS * this.sensitivity
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch))
    this._applyRotation()
  }

  _applyRotation() {
    this.camera.position.copy(this.eye)
    this.camera.rotation.set(
      this.pitch + this.aimNoise.pitch + this.sway.pitch,
      this.yaw + this.aimNoise.yaw + this.sway.yaw,
      0
    )
  }

  // 中箭時呼叫：往隨機方向注入一次性瞄準偏移衝量，幅度由命中部位分級決定
  addAimNoise(magnitude) {
    this.aimNoise.yaw += (Math.random() - 0.5) * 2 * magnitude
    this.aimNoise.pitch += (Math.random() - 0.5) * 2 * magnitude
  }

  // 開始拉弓時呼叫：準星進入持續飄動狀態，水平/垂直各自用獨立的正弦波（不同相位/頻率/幅度），
  // 讓飄動軌跡不是單純的圓形/對角線，玩家得一直修正滑鼠才能把準星維持在目標上
  startSway(ampYaw, ampPitch, freqYaw, freqPitch) {
    this.swayActive = true
    this.swayT = 0
    this.swayPhaseYaw = Math.random() * Math.PI * 2
    this.swayPhasePitch = Math.random() * Math.PI * 2
    this.swayAmpYaw = ampYaw
    this.swayAmpPitch = ampPitch
    this.swayFreqYaw = freqYaw
    this.swayFreqPitch = freqPitch
  }

  // 放箭/取消蓄力時呼叫：飄動立刻歸零，準星回到玩家滑鼠實際指向的位置
  stopSway() {
    this.swayActive = false
    this.sway.yaw = 0
    this.sway.pitch = 0
  }

  // 每幀呼叫：讓瞄準偏移隨時間指數衰減回 0（約 0.3 秒內平息），推進拉弓飄動與運鏡狀態
  update(dt) {
    const decay = Math.pow(0.01, dt / 0.3)
    this.aimNoise.yaw *= decay
    this.aimNoise.pitch *= decay

    if (this.swayActive) {
      this.swayT += dt
      this.sway.yaw = Math.sin(this.swayT * this.swayFreqYaw + this.swayPhaseYaw) * this.swayAmpYaw
      this.sway.pitch = Math.sin(this.swayT * this.swayFreqPitch + this.swayPhasePitch) * this.swayAmpPitch
    }

    if (this.cutting) {
      this.cutT += dt
      let k
      if (this.cutT < this.cutEnter) k = this.cutT / this.cutEnter
      else if (this.cutT > this.cutDuration - this.cutExit) k = (this.cutDuration - this.cutT) / this.cutExit
      else k = 1
      k = Math.max(0, Math.min(1, k))
      const e = k * k * (3 - 2 * k)   // smoothstep
      this.camera.position.lerpVectors(this._cutFromPos, this._cutToPos, e)
      this.camera.quaternion.copy(this._cutFromQuat).slerp(this._cutToQuat, e)
      if (this.cutT >= this.cutDuration) { this.cutting = false; this._applyRotation() }
      return
    }
    this._applyRotation()
  }

  // 觸發一次命中運鏡：從目前鏡頭平滑切到 targetPos 看向 lookAtPos，停留後再切回第一人稱
  startCut(targetPos, lookAtPos, duration) {
    this.cutting = true
    this.cutT = 0
    this.cutDuration = duration
    this.cutEnter = Math.min(0.18, duration * 0.25)
    this.cutExit = Math.min(0.18, duration * 0.25)
    this._cutFromPos = this.camera.position.clone()
    this._cutFromQuat = this.camera.quaternion.clone()
    this._cutToPos = targetPos.clone()
    const m = new THREE.Matrix4().lookAt(targetPos, lookAtPos, new THREE.Vector3(0, 1, 0))
    this._cutToQuat = new THREE.Quaternion().setFromRotationMatrix(m)
  }

  cancelCut() {
    this.cutting = false
    this._applyRotation()
  }

  // 目前視線方向的單位向量（供瞄準/彈道使用）。自動疊加拉弓時的持續飄動（this.sway），
  // 所以蓄力中的預覽彈道、跟真正放箭當下算出來的方向，都會反映玩家有沒有成功用滑鼠抵銷飄動。
  // extraYaw/extraPitch 可再疊加額外角度偏移，不會動到 this.yaw/this.pitch 本身；
  // swayScale 可縮放飄動的影響幅度（例如放箭瞬間想讓飄動的影響打折，見 main.js 的 fireUp()）
  getAimDirection(target = new THREE.Vector3(), extraYaw = 0, extraPitch = 0, swayScale = 1) {
    const yaw = this.yaw + this.sway.yaw * swayScale + extraYaw
    const pitch = this.pitch + this.sway.pitch * swayScale + extraPitch
    return target.set(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    )
  }
}
