import { useCallback, useEffect, useRef, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import type { BodyDef } from '../data/bodies'
import { textureUrl } from '../data/textures'

interface Props {
  readonly body: BodyDef
  readonly onClose: () => void
}

/** 把天数格式化为"小时/天/年"中最易读的单位。 */
function formatDays(days: number): string {
  if (days < 1) return `${(days * 24).toFixed(1)} 小时`
  if (days < 730) return `${days.toFixed(1)} 天`
  return `${(days / 365.25).toFixed(1)} 年`
}

/** 格式化温度区间。 */
function formatTemp(body: BodyDef): string {
  if (body.tempRangeC && body.tempRangeC.length === 2) {
    return `${body.tempRangeC[0]} ~ ${body.tempRangeC[1]} °C`
  }
  return `${body.meanTempC} °C`
}

/** 格式化质量：太阳用太阳质量，其余用地球质量。 */
function formatMass(body: BodyDef): string {
  if (body.kind === 'star') return '1 M☉'
  if (body.earthMasses >= 100) return `${Math.round(body.earthMasses).toLocaleString()} M⊕`
  return `${body.earthMasses.toFixed(3)} M⊕`
}

/** 格式化与太阳的距离。 */
function formatDistance(body: BodyDef): string {
  if (body.kind === 'star') return '—'
  if (body.kind === 'moon') return '距地球 38.44 万 km'
  return `${body.distanceMillionKm} 百万 km · ${body.au} AU`
}

/** 半径格式化：大天体用千公里，小天体保留小数。 */
function formatRadius(km: number): string {
  return `${km.toLocaleString()} km`
}

/** 天体详情面板：贴图（可拖动旋转）+ 参数表 + 科普文案。 */
export function DetailPanel({ body, onClose }: Props): ReactElement {
  const texRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const offsetRef = useRef(0)
  const dragRef = useRef<{ x: number; offset: number } | null>(null)

  /** 重绘贴图：把等距柱状贴图按高度铺满，横向偏移模拟自转。 */
  const drawTexture = useCallback(() => {
    const canvas = texRef.current
    const img = imgRef.current
    if (!canvas) return
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
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#05070f'
    ctx.fillRect(0, 0, w, h)
    if (!img || img.width === 0) return
    const tileW = (img.width / img.height) * h
    const offset = ((offsetRef.current % tileW) + tileW) % tileW
    for (let x = -offset; x < w; x += tileW) {
      ctx.drawImage(img, x, 0, tileW, h)
    }
  }, [])

  // 切换天体时重新加载贴图并回到 0 相位。
  useEffect(() => {
    offsetRef.current = 0
    const img = new Image()
    img.src = textureUrl(body.texture)
    img.onload = () => {
      imgRef.current = img
      drawTexture()
    }
    return () => {
      imgRef.current = null
    }
  }, [body.id, body.texture, drawTexture])

  useEffect(() => {
    drawTexture()
    window.addEventListener('resize', drawTexture)
    return () => window.removeEventListener('resize', drawTexture)
  }, [drawTexture])

  /** 按下：记录起点与当前相位。 */
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = { x: e.clientX, offset: offsetRef.current }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  /** 拖动：按横向位移推进贴图相位。 */
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    offsetRef.current = drag.offset + (e.clientX - drag.x) * 0.8
    drawTexture()
  }

  /** 抬起：结束拖动。 */
  const onPointerUp = (): void => {
    dragRef.current = null
  }

  const rows: Array<[string, string]> = [
    ['半径', formatRadius(body.radiusKm)],
    ['质量', formatMass(body)],
    ['与太阳距离', formatDistance(body)],
    ['自转周期', `${formatDays(body.rotationDays)}${body.retrograde ? '（逆向）' : ''}`],
    ['公转周期', body.kind === 'planet' || body.kind === 'moon' ? formatDays(body.orbitalDays) : '—'],
    ['表面温度', formatTemp(body)],
    ['表面重力', `${body.gravity} m/s²`],
    ['卫星', `${body.moons} 颗`],
  ]

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <div className="detail-title">{body.name}</div>
          <div className="detail-en">{body.en}{body.kind === 'star' ? ' · 恒星' : body.kind === 'moon' ? ' · 卫星' : ' · 行星'}</div>
        </div>
        <button className="ghost-btn" onClick={onClose} aria-label="关闭详情">×</button>
      </div>

      <canvas
        ref={texRef}
        className="detail-tex"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="detail-tex-hint">拖动贴图可旋转 {body.name}</div>

      <p className="detail-blurb">{body.blurb}</p>
      <table className="detail-table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="detail-label">{label}</td>
              <td className="detail-value">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="detail-fact">
        <span className="detail-fact-tag">冷知识</span>
        {body.fact}
      </div>
    </aside>
  )
}
