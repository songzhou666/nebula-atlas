import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { analyze, constellationId, schemeOf } from './engine'

const TAU = Math.PI * 2
/** 旋臂外卷方向（与真实旋涡星系一致的拖尾方向）。 */
const WIND = -4
const ARM_COUNT = 4
const PARTICLES_PER_ARM = 420

interface Particle {
  arm: number
  t: number
  radius: number
  angle: number
  size: number
  tint: number
  tintColor: string
  jitter: number
}

/** 缓存柔和光点贴图，避免每帧重建渐变。 */
function useSpriteCache() {
  const cache = useRef(new Map<string, HTMLCanvasElement>())
  return (color: string): HTMLCanvasElement => {
    const hit = cache.current.get(color)
    if (hit) return hit
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.2, color)
    g.addColorStop(0.55, withAlpha(color, 0.22))
    g.addColorStop(1, withAlpha(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    cache.current.set(color, canvas)
    return canvas
  }
}

/** 给 #rrggbb 叠加透明度。 */
function withAlpha(hex: string, alpha: number): string {
  const body = hex.replace('#', '')
  const int = Number.parseInt(body, 16)
  if (Number.isNaN(int)) return hex
  return `rgba(${(int >> 16) & 0xff},${(int >> 8) & 0xff},${int & 0xff},${alpha})`
}

/** 稳定随机数，保证同一文字每次生成的粒子布局一致。 */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Props {
  readonly text: string
  readonly onClose: () => void
}

/**
 * 文字星图覆盖层：把一段文字按字符特征哈希投射成星云（引擎几何 + 配色），
 * 作为"发射"的仪式感画面。纯本地计算，无网络请求，也不做语义理解。
 */
export function NebulaOverlay({ text, onClose }: Props): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const profileRef = useRef<HTMLCanvasElement>(null)
  const spriteOf = useSpriteCache()

  // 文字几何：profile 决定旋臂半径，schemeBase 决定配色。
  const { particles, scheme, profile, callSign } = useMemo(() => {
    const analysis = analyze(text)
    const scheme = schemeOf(analysis.schemeBase, 0)
    const rng = mulberry(analysis.profile[12]! * 1e6 + text.length * 7919)
    const particles: Particle[] = []
    for (let arm = 0; arm < ARM_COUNT; arm++) {
      for (let i = 0; i < PARTICLES_PER_ARM; i++) {
        const t = 0.05 + Math.pow(rng(), 0.72) * 0.95
        const band = Math.max(0, Math.min(255, Math.floor(t * 255 + (rng() - 0.5) * 12)))
        const energy = analysis.profile[band]!
        const radius = (0.12 + energy * 0.88) * (10 + rng() * 2.4)
        const angle = t * WIND + (arm * TAU) / ARM_COUNT + energy * 0.1 + (rng() - 0.5) * 0.3
        const tint = Math.max(0, Math.min(3, Math.floor(t * 3.15 + (rng() - 0.5) * 0.8)))
        particles.push({
          arm,
          t,
          radius,
          angle,
          size: 0.5 + Math.pow(rng(), 1.7) * 2.6 + (rng() > 0.985 ? 2.4 : 0),
          tint,
          tintColor: scheme.arms[tint]!,
          jitter: (rng() - 0.5) * 0.35,
        })
      }
    }
    return { particles, scheme, profile: analysis.profile, callSign: constellationId(text) }
  }, [text])

  // 静态绘制：发射结果以一张文字星图呈现，不再逐帧动画（省性能，也避免空框感）。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = (): void => {
      const dpr = Math.min(window.devicePixelRatio, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      const targetW = Math.round(w * dpr)
      const targetH = Math.round(h * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cx = w / 2
      const cy = h / 2
      const base = Math.min(w, h) * 0.42
      ctx.clearRect(0, 0, w, h)

      // 中心辉光：高亮核 + 配色晕，让静态图有"星云照片"的观感。
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * 1.25)
      core.addColorStop(0, withAlpha('#ffffff', 0.9))
      core.addColorStop(0.16, withAlpha(scheme.core, 0.8))
      core.addColorStop(0.42, withAlpha(scheme.accent, 0.3))
      core.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = core
      ctx.fillRect(0, 0, w, h)

      ctx.globalCompositeOperation = 'lighter'
      for (const p of particles) {
        const a = p.angle
        const r = p.radius * base
        const x = cx + Math.cos(a) * r + p.jitter * 14
        const y = cy + Math.sin(a) * r * 0.86 + p.jitter * 10
        const size = p.size * (base / 78)
        const sprite = spriteOf(p.tintColor)
        ctx.globalAlpha = 0.85 + p.t * 0.15
        ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [particles, scheme, spriteOf])

  // 能量剖面小图。
  useEffect(() => {
    const canvas = profileRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const barWidth = w / profile.length
    for (let i = 0; i < profile.length; i++) {
      const v = profile[i]!
      ctx.fillStyle = withAlpha(scheme.arms[i % 4]!, 0.28 + v * 0.7)
      const barHeight = Math.max(1, v * h)
      ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 0.5), barHeight)
    }
  }, [profile, scheme])

  /** Esc 关闭浮层。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 浮层不铺满全屏：太阳系保持可见，发射结果以卡片形式呈现。
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-head">
          <span className="call-sign">{callSign}</span>
          <span className="overlay-title">文字星图 · 生成完成</span>
          <button className="ghost-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <canvas ref={canvasRef} className="overlay-canvas" />
        <div className="overlay-foot">
          <span className="overlay-text">{text}</span>
          <canvas ref={profileRef} width={256} height={40} className="profile-chart" />
          <span className="overlay-hint">字符特征哈希 · 256 段能量分布 · Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
