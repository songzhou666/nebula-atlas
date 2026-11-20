import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { UniverseScene } from './three/UniverseScene'
import { bodyById, matchBody } from './data/bodies'
import { Launcher } from './launcher/Launcher'
import { readSeed, writeSeed } from './launcher/seed'
import { NebulaOverlay } from './semantic/NebulaOverlay'
import { DetailPanel } from './ui/DetailPanel'
import { CatalogPanel } from './ui/CatalogPanel'

/** 根组件：三维场景 + 发射台 + 详情面板 + 文字星图覆盖层。 */
export default function App(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<UniverseScene | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const [semantic, setSemantic] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [orbitScale, setOrbitScale] = useState(1)
  const [spinScale, setSpinScale] = useState(1)
  // 移动端默认收起图鉴：窄屏先展示三维太阳系，点右上角「图鉴」再打开。
  const [catalogOpen, setCatalogOpen] = useState(() => window.innerWidth > 720)

  /** 初始化三维场景（StrictMode 下会挂载两次，dispose 负责清理）。 */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new UniverseScene(host, {
      // 在三维视图里点中天体时收起图鉴，避免面板挡住刚定位的天体。
      onSelect: (id) => {
        setSelectedId(id)
        if (id !== null) setCatalogOpen(false)
      },
      onHover: (id, x, y) => setHover(id === null ? null : { id, x, y }),
    })
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [setCatalogOpen])

  /**
   * 选中并聚焦某天体：发射台点名与图鉴列表共用。
   * @param id 天体 id
   */
  const pickBody = useCallback((id: string): void => {
    setSelectedId(id)
    sceneRef.current?.setSelected(id)
    sceneRef.current?.focusBody(id)
  }, [])

  /**
   * 转向某颗恒星（只改变视线方向，不移动相机）。
   * @param x 恒星世界坐标 x
   * @param y 恒星世界坐标 y
   * @param z 恒星世界坐标 z
   */
  const faceStar = useCallback((x: number, y: number, z: number): void => {
    sceneRef.current?.faceDirection(x, y, z)
  }, [])

  /** 发射：写入 URL 种子、打开文字星图、若指名天体则聚焦。 */
  const launch = useCallback((text: string): void => {
    writeSeed(text)
    setSemantic(text)
    const body = matchBody(text)
    if (body) pickBody(body.id)
  }, [pickBody])

  /** 首次带种子打开时自动发射一次。 */
  useEffect(() => {
    const seed = readSeed()
    if (seed.length === 0) return
    const timer = window.setTimeout(() => launch(seed), 700)
    return () => window.clearTimeout(timer)
  }, [launch])

  /** 暂停/速度/复位的场景同步。 */
  useEffect(() => {
    sceneRef.current?.setPaused(paused)
  }, [paused])
  useEffect(() => {
    sceneRef.current?.setOrbitScale(orbitScale)
  }, [orbitScale])
  useEffect(() => {
    sceneRef.current?.setSpinScale(spinScale)
  }, [spinScale])

  const selected = selectedId === null ? undefined : bodyById(selectedId)
  const hoverBody = hover === null ? undefined : bodyById(hover.id)
  // 窄屏下图鉴/详情面板为浮层，打开时用该类名收起发射台，避免两层叠在一起。
  const panelOpen = catalogOpen || selected !== undefined

  return (
    <div className={`app${panelOpen ? ' app--panel' : ''}`}>
      <div ref={hostRef} className="scene-host" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <div>
            <h1>太阳系图鉴</h1>
            <p>真实天体数据驱动 · 天体大小为示意比例，非真实尺度</p>
          </div>
        </div>
        <div className="topbar-meta">
          <span
            className="scale-note"
            title="行星大小按半径的 0.55 次方压缩，HYG 恒星按秒差距缩放，两套坐标系叠加，仅作示意"
          >
            比例示意 · 非真实尺度
          </span>
          <button className="ctrl-btn topbar-btn" onClick={() => setCatalogOpen((v) => !v)}>
            {catalogOpen ? '隐藏图鉴' : '图鉴'}
          </button>
          <span>2034 颗亮星</span>
          <span>10 个天体</span>
        </div>
      </header>

      {hoverBody && hoverBody.id !== selectedId && (
        <div className="tooltip" style={{ left: hover!.x + 14, top: hover!.y + 14 }}>
          {hoverBody.name}
        </div>
      )}

      <Launcher onLaunch={launch} />

      {catalogOpen && (
        <CatalogPanel
          onSelectBody={(id) => {
            pickBody(id)
            // 点选后收起图鉴，避免面板挡住刚聚焦的天体。
            setCatalogOpen(false)
          }}
          onFaceStar={(x, y, z) => {
            faceStar(x, y, z)
            // 转向恒星后收起图鉴，否则移动端整屏抽屉会挡住转向后的星空。
            setCatalogOpen(false)
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}

      <div className="controls">
        <button className="ctrl-btn" onClick={() => setPaused((v) => !v)}>
          {paused ? '继续' : '暂停'}
        </button>
        <label className="ctrl-slider">
          <span>公转</span>
          <input
            type="range"
            min={0}
            max={4}
            step={0.05}
            value={orbitScale}
            onChange={(e) => setOrbitScale(Number(e.target.value))}
            aria-label="公转速度"
          />
          <em>{orbitScale.toFixed(2)}×</em>
        </label>
        <label className="ctrl-slider">
          <span>自转</span>
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={spinScale}
            onChange={(e) => setSpinScale(Number(e.target.value))}
            aria-label="自转速度"
          />
          <em>{spinScale.toFixed(2)}×</em>
        </label>
        <button className="ctrl-btn" onClick={() => sceneRef.current?.resetView()}>复位视角</button>
      </div>

      {/* 文字星图浮层打开时收起详情面板，避免两层面板叠在右侧。 */}
      {selected && semantic === null && <DetailPanel body={selected} onClose={() => {
        setSelectedId(null)
        sceneRef.current?.setSelected(null)
      }} />}

      {semantic !== null && <NebulaOverlay text={semantic} onClose={() => setSemantic(null)} />}
    </div>
  )
}
