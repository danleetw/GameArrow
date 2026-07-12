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

  _applyRotation() {
    this.camera.position.copy(this.eye)
    this.camera.rotation.set(this.pitch + this.aimNoise.pitch, this.yaw + this.aimNoise.yaw, 0)
  }

  // 中箭時呼叫：往隨機方向注入一次性瞄準偏移衝量，幅度由命中部位分級決定
  addAimNoise(magnitude) {
    this.aimNoise.yaw += (Math.random() - 0.5) * 2 * magnitude
    this.aimNoise.pitch += (Math.random() - 0.5) * 2 * magnitude
  }

  // 每幀呼叫：讓瞄準偏移隨時間指數衰減回 0（約 0.3 秒內平息），並推進運鏡狀態
  update(dt) {
    const decay = Math.pow(0.01, dt / 0.3)
    this.aimNoise.yaw *= decay
    this.aimNoise.pitch *= decay

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

  // 目前視線方向的單位向量（供瞄準/彈道使用）
  getAimDirection(target = new THREE.Vector3()) {
    return target.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    )
  }
}
