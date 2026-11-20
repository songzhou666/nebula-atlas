/** 行星贴图地址与回退策略。 */

/**
 * 返回某天体贴图的地址。
 * 贴图已本地化到 public/textures（solarsystemscope 既无 CORS 头、原文件名也失效），
 * 用相对路径保证部署到子路径时依然可用。
 */
export function textureUrl(file: string): string {
  return `./textures/${file}`
}

/**
 * 生成一张程序化fallback纹理：按基色做径向渐变并叠加噪声斑块。
 * 仅在外部贴图加载失败时使用，保证行星永远不会是纯色平面。
 */
export function fallbackTexture(color: string, seed: number): HTMLCanvasElement {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size / 2
  const ctx = canvas.getContext('2d')
  if (ctx === null) return canvas

  const rng = (() => {
    let s = seed >>> 0
    return () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()

  const base = ctx.createLinearGradient(0, 0, size, 0)
  base.addColorStop(0, shade(color, -0.35))
  base.addColorStop(0.5, color)
  base.addColorStop(1, shade(color, -0.35))
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size / 2)

  // 横向条带，模拟气态行星或地表纹理。
  for (let i = 0; i < 90; i++) {
    const y = rng() * (size / 2)
    const h = 1 + rng() * 5
    ctx.fillStyle = `rgba(${rng() > 0.5 ? '255,255,255' : '0,0,0'},${0.03 + rng() * 0.08})`
    ctx.fillRect(0, y, size, h)
  }
  return canvas
}

/** 把 #rrggbb 调亮/调暗 amount（-1..1）。 */
function shade(hex: string, amount: number): string {
  const body = hex.replace('#', '')
  const int = Number.parseInt(body, 16)
  if (Number.isNaN(int)) return hex
  const channel = (shift: number): number => {
    const v = (int >> shift) & 0xff
    const next = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount)
    return Math.max(0, Math.min(255, Math.round(next)))
  }
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`
}
