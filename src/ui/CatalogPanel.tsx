import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import starsData from '../data/stars.json'
import { BODIES } from '../data/bodies'

interface StarDef {
  name: string
  con: string
  mag: number
  xyz: number[]
  rgb: number[]
}

const STARS = starsData as unknown as StarDef[]

/** 星座缩写 → 中文名（常见星座，未收录的显示缩写）。 */
const CON_CN: Record<string, string> = {
  Ori: '猎户座', UMa: '大熊座', Sco: '天蝎座', Cyg: '天鹅座', Lyr: '天琴座', Tau: '金牛座',
  Gem: '双子座', Leo: '狮子座', Vir: '室女座', Sgr: '人马座', Car: '船底座', Cen: '半人马座',
  Cru: '南十字座', Cas: '仙后座', And: '仙女座', Peg: '飞马座', Aur: '御夫座', Aql: '天鹰座',
  Boo: '牧夫座', CMa: '大犬座', CMi: '小犬座', Pup: '船尾座', Vel: '船帆座', Mon: '麒麟座',
  Lyn: '天猫座', CVn: '猎犬座', Com: '后发座', CrB: '北冕座', Her: '武仙座', Per: '英仙座',
  Ari: '白羊座', Pis: '双鱼座', Aqr: '宝瓶座', Cap: '摩羯座', PsA: '南鱼座', Cet: '鲸鱼座',
  Eri: '波江座', Lep: '天兔座', Col: '天鸽座', Dor: '剑鱼座', Hyi: '水蛇座', Tuc: '杜鹃座',
  Gru: '天鹤座', Phe: '凤凰座', Pic: '绘架座', For: '天炉座', Scl: '玉夫座', Men: '山案座',
  Vol: '飞鱼座', Cha: '蝘蜓座', Aps: '天燕座', Oct: '南极座', Ind: '印第安座', Pav: '孔雀座',
  Tel: '望远镜座', Mic: '显微镜座', Hor: '时钟座', Ret: '网罟座', Cae: '雕具座', Sex: '六分仪座',
  Ant: '唧筒座', Pyx: '罗盘座', Crt: '巨爵座', Crv: '乌鸦座', Lib: '天秤座', Lup: '豺狼座',
  Oph: '蛇夫座', Ser: '巨蛇座', Sct: '盾牌座', Ara: '天坛座', Dra: '天龙座', Cep: '仙王座',
  UMi: '小熊座', Cam: '鹿豹座', Lac: '蝎虎座', Vul: '狐狸座', Sge: '天箭座', Del: '海豚座',
  Equ: '小马座',
}

/** 恒星显示名（HYG 部分星名为空时退回拜耳/佛氏编号）。 */
function starName(star: StarDef, index: number): string {
  return star.name.length > 0 ? star.name : `HYG ${index + 1}`
}

/** 星距：秒差距 + 光年。 */
function starDistance(star: StarDef): { pc: string; ly: string } {
  const pc = Math.hypot(star.xyz[0]!, star.xyz[1]!, star.xyz[2]!)
  return { pc: pc.toFixed(1), ly: (pc * 3.262).toFixed(1) }
}

interface Props {
  readonly onSelectBody: (id: string) => void
  readonly onFaceStar: (x: number, y: number, z: number) => void
  readonly onClose: () => void
}

/**
 * 图鉴面板：太阳系天体列表 + HYG 亮星表。
 * 点击太阳系条目会聚焦对应天体；恒星只有星表数据（无表面贴图），点击后显示资料并可转向观测。
 */
export function CatalogPanel({ onSelectBody, onFaceStar, onClose }: Props): ReactElement {
  const [tab, setTab] = useState<'system' | 'stars'>('system')
  const [query, setQuery] = useState('')
  const [starIndex, setStarIndex] = useState<number | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)

  /** 恒星过滤：按名称 / 星座缩写 / 星座中文名匹配。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return STARS.map((_, i) => i)
    return STARS.map((s, i) => ({ s, i }))
      .filter(({ s }) => {
        const cn = CON_CN[s.con] ?? ''
        return (
          s.name.toLowerCase().includes(q) ||
          s.con.toLowerCase().includes(q) ||
          cn.includes(query.trim())
        )
      })
      .map(({ i }) => i)
  }, [query])

  const star = starIndex === null ? null : STARS[starIndex]!

  /** 画恒星预览：按星表的 RGB 色画径向光晕。 */
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !star) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#04060e'
    ctx.fillRect(0, 0, w, h)
    const [r, g, b] = star.rgb
    const color = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
    const cx = w / 2
    const cy = h / 2
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) / 2)
    grad.addColorStop(0, 'rgba(255,255,255,0.95)')
    grad.addColorStop(0.18, color)
    grad.addColorStop(0.5, `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.18)`)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }, [star])

  return (
    <aside className="catalog">
      <div className="catalog-head">
        <span className="overlay-title">图鉴</span>
        <button className="ghost-btn" onClick={onClose} aria-label="关闭图鉴">×</button>
      </div>
      <div className="catalog-tabs">
        <button className={tab === 'system' ? 'tab active' : 'tab'} onClick={() => setTab('system')}>
          太阳系 · {BODIES.length}
        </button>
        <button className={tab === 'stars' ? 'tab active' : 'tab'} onClick={() => setTab('stars')}>
          恒星 · {STARS.length}
        </button>
      </div>

      {tab === 'system' ? (
        <div className="catalog-list">
          {BODIES.map((b) => (
            <button key={b.id} className="catalog-row" onClick={() => onSelectBody(b.id)}>
              <span className="dot" style={{ background: b.color }} />
              <span className="catalog-name">
                {b.name}
                <em>{b.en}</em>
              </span>
              <span className="catalog-meta">
                {b.kind === 'star' ? '恒星' : b.kind === 'moon' ? '卫星' : '行星'} · {b.radiusKm.toLocaleString()} km
              </span>
            </button>
          ))}
          <p className="catalog-note">点击条目聚焦天体，可直接拖动旋转查看贴图与资料。</p>
        </div>
      ) : (
        <div className="catalog-stars">
          <input
            className="catalog-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索恒星 / 星座，如 Sirius、Ori、猎户"
          />
          {star && (
            <div className="star-card">
              <div className="star-card-head">
                <span className="star-card-name">{starName(star, starIndex!)}</span>
                <button className="ghost-btn" onClick={() => setStarIndex(null)} aria-label="关闭恒星详情">×</button>
              </div>
              <canvas ref={previewRef} className="star-preview" />
              <div className="star-card-rows">
                <div><span>星座</span><b>{CON_CN[star.con] ?? star.con}{CON_CN[star.con] ? ` (${star.con})` : ''}</b></div>
                <div><span>星等</span><b>{star.mag.toFixed(2)}</b></div>
                <div><span>距离</span><b>{starDistance(star).pc} pc · {starDistance(star).ly} 光年</b></div>
                <div><span>颜色</span><b>{star.rgb.map((v) => Math.round(v * 255)).join(', ')}</b></div>
              </div>
              <button className="launch-btn star-face" onClick={() => onFaceStar(star.xyz[0]!, star.xyz[1]!, star.xyz[2]!)}>
                转向该恒星
              </button>
              <p className="catalog-note">恒星只有星表数据，没有表面贴图；可关闭后在星空中拖动查看。</p>
            </div>
          )}
          <div className="catalog-list">
            {filtered.slice(0, 300).map((i) => {
              const s = STARS[i]!
              return (
                <button key={i} className="catalog-row" onClick={() => setStarIndex(i)}>
                  <span className="dot" style={{ background: `rgb(${Math.round(s.rgb[0]! * 255)}, ${Math.round(s.rgb[1]! * 255)}, ${Math.round(s.rgb[2]! * 255)})` }} />
                  <span className="catalog-name">
                    {starName(s, i)}
                    <em>{CON_CN[s.con] ?? s.con}</em>
                  </span>
                  <span className="catalog-meta">{s.mag.toFixed(2)} 等</span>
                </button>
              )
            })}
            {filtered.length > 300 && <p className="catalog-note">仅显示前 300 条，请用搜索缩小范围。</p>}
            {filtered.length === 0 && <p className="catalog-note">没有匹配的恒星。</p>}
          </div>
        </div>
      )}
    </aside>
  )
}
