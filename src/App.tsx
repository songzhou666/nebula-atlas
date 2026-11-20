import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { UniverseScene } from './three/UniverseScene'
import { bodyById } from './data/bodies'
import { DetailPanel } from './ui/DetailPanel'
import { CatalogPanel } from './ui/CatalogPanel'

/** 根组件：三维太阳系场景 + 图鉴列表 + 详情面板。 */
export default function App(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<UniverseScene | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
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
   * 选中并聚焦某天体：图鉴列表与三维视图共用同一条入口。
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

  return (
    <div className="app">
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
            title="行星大小按真实半径的 0.82 次方压缩，恒星只取天区方向，均仅作示意"
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

      {selected && <DetailPanel body={selected} onClose={() => {
        setSelectedId(null)
        sceneRef.current?.setSelected(null)
      }} />}
    </div>
  )
}
