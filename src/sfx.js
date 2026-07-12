// 音效：全部即時合成（沿用 angrybird 的 blip/noise 兩個基礎音源），不需要額外音檔
import musicUrl from '../sound/indigobunting-autumn-morning-woodland-with-birdsong-and-distant-waterfall-173326.mp3'

let ctx = null, master = null, musicGain = null, noiseBuf = null
let sfxVol = 1.0, musVol = 0.5

export function setSfxVolume(frac) { sfxVol = Math.max(0, Math.min(1, frac)) * 2; if (master) master.gain.value = sfxVol }
export function setMusicVolume(frac) { musVol = Math.max(0, Math.min(1, frac)); if (musicGain) musicGain.gain.value = musVol }

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  ctx = new AC()
  master = ctx.createGain(); master.gain.value = sfxVol; master.connect(ctx.destination)
  musicGain = ctx.createGain(); musicGain.gain.value = musVol; musicGain.connect(ctx.destination)
  const len = Math.floor(ctx.sampleRate * 1.0)
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  loadMusic()
}

const t0 = () => ctx.currentTime

function blip({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, sweep = null, delay = 0, dest = null }) {
  if (!ctx) return
  const t = t0() + delay
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t)
  if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(dest || master); o.start(t); o.stop(t + dur + 0.03)
}

function noise({ dur = 0.3, gain = 0.3, type = 'lowpass', freq = 1000, sweep = null, delay = 0, dest = null }) {
  if (!ctx) return
  const t = t0() + delay
  const src = ctx.createBufferSource(); src.buffer = noiseBuf
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t)
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(dest || master); src.start(t); src.stop(t + dur + 0.03)
}

const HIT_SOUND = {
  light: { freq: 300, dur: 0.08, gain: 0.16, sweep: 150, nFreq: 800, nGain: 0.10 },
  medium: { freq: 190, dur: 0.12, gain: 0.26, sweep: 90, nFreq: 600, nGain: 0.20 },
  heavy: { freq: 110, dur: 0.18, gain: 0.36, sweep: 50, nFreq: 400, nGain: 0.30 },
}

export const sfx = {
  // 開始蓄力：弓臂輕微吱嘎聲
  draw() {
    blip({ freq: 220, type: 'sawtooth', dur: 0.15, gain: 0.07, sweep: 160 })
  },
  // 放箭：弦音 + 箭矢咻聲
  release() {
    blip({ freq: 900, type: 'triangle', dur: 0.08, gain: 0.26, sweep: 220 })
    noise({ dur: 0.22, gain: 0.12, type: 'bandpass', freq: 1300, sweep: 450 })
  },
  // 命中：依分級悶響輕重不同
  hit(tier = 'light') {
    const s = HIT_SOUND[tier] || HIT_SOUND.light
    blip({ freq: s.freq, type: 'sine', dur: s.dur, gain: s.gain, sweep: s.sweep })
    noise({ dur: s.dur * 0.6, gain: s.nGain, type: 'lowpass', freq: s.nFreq })
  },
  // 致命一擊：低沉悶哼
  death() {
    blip({ freq: 150, type: 'sawtooth', dur: 0.5, gain: 0.32, sweep: 55 })
    noise({ dur: 0.4, gain: 0.26, type: 'lowpass', freq: 300, sweep: 110 })
  },
  uiClick() {
    blip({ freq: 600, type: 'triangle', dur: 0.05, gain: 0.14 })
  },
}

// ============================================================
//  背景音樂：sound/ 目錄下的森林環境音（鳥鳴 + 遠方瀑布聲）外部音檔，循環播放
// ============================================================
let musicBuf = null, musicSrc = null, musicOn = false

async function loadMusic() {
  if (musicBuf || !ctx) return
  try {
    const res = await fetch(musicUrl)
    musicBuf = await ctx.decodeAudioData(await res.arrayBuffer())
    if (musicOn) startMusicSource()   // 若在解碼期間已按下播放，解好即接上
  } catch (e) { console.warn('背景音樂載入失敗', e) }
}
function startMusicSource() {
  if (!ctx || !musicBuf || musicSrc) return
  musicSrc = ctx.createBufferSource()
  musicSrc.buffer = musicBuf; musicSrc.loop = true
  musicSrc.connect(musicGain); musicSrc.start()
}

export const music = {
  start() {
    if (!ctx || musicOn) return
    musicOn = true
    if (musicBuf) startMusicSource(); else loadMusic()
  },
  stop() {
    musicOn = false
    if (musicSrc) { try { musicSrc.stop() } catch { /* 已經停止過就忽略 */ } musicSrc.disconnect(); musicSrc = null }
  },
  get playing() { return musicOn },
}
