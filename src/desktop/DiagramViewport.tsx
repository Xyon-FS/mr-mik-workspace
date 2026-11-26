import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { previewMemory, rememberPreview, usePreviewViewport } from './previewMemory'
import { svgImage } from './svgImage'
import { PreviewButton } from './PreviewChrome'

export default function DiagramViewport({ identity, children, inline = false }: { identity: string; children: ReactNode; inline?: boolean }) {
  const key = `diagram:${identity}`, [zoom, setZoom] = useState(() => Number(previewMemory(key).zoom) || 1)
  const [size, setSize] = useState({ fitWidth: 0, aspect: 1 })
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0, width: 100, height: 100 })
  const [pan, setPan] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const view = usePreviewViewport(key), content = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const updatePosition = useCallback((element: HTMLDivElement) => {
    if (inline) return
    setOverflow(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
    const diagram = content.current?.querySelector('svg,img.svg-document')?.getBoundingClientRect(), canvas = element.getBoundingClientRect()
    if (!diagram?.width || !diagram.height) return
    const x = Math.max(0, canvas.left - diagram.left), y = Math.max(0, canvas.top - diagram.top)
    const width = Math.max(0, Math.min(canvas.right, diagram.right) - Math.max(canvas.left, diagram.left))
    const height = Math.max(0, Math.min(canvas.bottom, diagram.bottom) - Math.max(canvas.top, diagram.top))
    setPosition({ x: x / diagram.width * 100, y: y / diagram.height * 100, width: width / diagram.width * 100, height: height / diagram.height * 100 })
  }, [inline])
  useLayoutEffect(() => {
    const canvas = view.current, element = content.current
    if (!canvas || !element) return
    const dimensions = () => {
      const svg = element.querySelector('svg'), image = element.querySelector<HTMLImageElement>('img.svg-document')
      const width = svg?.viewBox.baseVal.width || image?.naturalWidth || 0
      const height = svg?.viewBox.baseVal.height || image?.naturalHeight || 0
      const maxHeight = Number.parseFloat(getComputedStyle(canvas).maxHeight)
      const aspect = width && height ? width / height : 1
      const fitWidth = width && canvas.clientWidth ? Math.max(1, Math.min(width, canvas.clientWidth - 24, (maxHeight - 24) * aspect)) : 0
      setSize(previous => previous.fitWidth === fitWidth && previous.aspect === aspect ? previous : { fitWidth, aspect })
      updatePosition(canvas)
    }
    const changed = () => {
      if (!inline) {
        const svg = element.querySelector('svg'), image = element.querySelector<HTMLImageElement>('img.svg-document')
        setThumbnail(svg ? svgImage(svg.outerHTML) : image?.src || null)
      }
      dimensions()
    }
    const resize = new ResizeObserver(dimensions), mutations = new MutationObserver(changed)
    resize.observe(canvas); resize.observe(element)
    mutations.observe(element, { subtree: true, childList: true })
    element.addEventListener('load', changed, true)
    window.addEventListener('resize', dimensions)
    changed()
    return () => { resize.disconnect(); mutations.disconnect(); element.removeEventListener('load', changed, true); window.removeEventListener('resize', dimensions) }
  }, [inline, updatePosition, view])
  const change = (value: number) => { setZoom(value); rememberPreview(key, { zoom: value }) }
  const fit = () => {
    drag.current = null; setPan(false); change(1)
    view.current?.scrollTo(0, 0)
    rememberPreview(key, { top: 0, left: 0 })
  }
  const shownWidth = size.fitWidth ? size.fitWidth * zoom : undefined
  return <section className={`diagram-viewport${inline ? ' inline-diagram' : ''}`}>
    <nav className="diagram-navigation" aria-label="Diagram controls">
      <PreviewButton label="Zoom out" icon="zoomOut" disabled={zoom <= .25} onClick={() => change(Math.max(.25, zoom - .25))} />
      <PreviewButton label="Fit" icon="layout" onClick={fit} />
      <span role="status" aria-label="Diagram zoom">{Math.round(zoom * 100)}%</span>
      <PreviewButton label="Zoom in" icon="zoomIn" disabled={zoom >= 4} onClick={() => change(Math.min(4, zoom + .25))} />
      <PreviewButton label="Pan diagram" icon="pan" aria-pressed={pan} title="Drag to pan or use the arrow keys in the diagram" onClick={() => { drag.current = null; setPan(value => !value); view.current?.focus({ preventScroll: true }) }} />
    </nav>
    <div ref={view} className={`diagram-pan${pan ? ' pan-enabled' : ''}`} aria-label="Diagram canvas" tabIndex={0} onDragStart={event => event.preventDefault()}
      onScroll={event => updatePosition(event.currentTarget)}
      onKeyDown={event => {
        if (event.key === 'Escape' && pan) {
          event.preventDefault(); event.stopPropagation(); drag.current = null; setPan(false)
        } else if (['+', '=', '-', '0'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
          event.preventDefault(); event.stopPropagation()
          if (event.key === '0') fit()
          else change(Math.max(.25, Math.min(4, zoom + (event.key === '-' ? -.25 : .25))))
        }
      }}
      onPointerDown={event => {
        if (!pan || event.button !== 0 || (event.target as Element).closest('button,input,select,a')) return
        const element = event.currentTarget
        drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
        element.setPointerCapture(event.pointerId)
        element.closest('.graphical-messages')?.dispatchEvent(new CustomEvent('graphical-content-interaction', { detail: { held: true } }))
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (drag.current && event.buttons !== 1) drag.current = null
        if (drag.current) event.currentTarget.scrollTo(drag.current.left + drag.current.x - event.clientX, drag.current.top + drag.current.y - event.clientY)
      }}
      onLostPointerCapture={() => { drag.current = null }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <div className="diagram-stage"><div ref={content} className="workspace-diagram-content" style={{ width: shownWidth }}>{children}</div></div>
    </div>
    {thumbnail && !inline && overflow && <button type="button" className="diagram-minimap" aria-label="Diagram minimap" title="Click or use arrow keys to navigate the diagram"
      onKeyDown={event => {
        const step = 60
        const direction: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
        const delta = direction[event.key]
        if (delta) { event.preventDefault(); view.current?.scrollBy(...delta) }
      }}
      onClick={event => {
        const map = event.currentTarget.querySelector('img')?.getBoundingClientRect()
        const element = view.current, diagram = content.current?.querySelector('svg,img.svg-document')?.getBoundingClientRect()
        if (!element || !map?.width || !map.height || !diagram) return
        const canvas = element.getBoundingClientRect()
        const x = event.detail ? Math.max(0, Math.min(1, (event.clientX - map.left) / map.width)) : .5
        const y = event.detail ? Math.max(0, Math.min(1, (event.clientY - map.top) / map.height)) : .5
        element.scrollBy(diagram.left - canvas.left + x * diagram.width - element.clientWidth / 2, diagram.top - canvas.top + y * diagram.height - element.clientHeight / 2)
      }}>
      <span className="diagram-minimap-map" style={{ width: Math.min(132, 77 * size.aspect), height: Math.min(77, 132 / size.aspect) }}>
        <img draggable={false} src={thumbnail} alt="" />
        <span className="diagram-minimap-position" style={{ left: `${position.x}%`, top: `${position.y}%`, width: `${position.width}%`, height: `${position.height}%` }} />
      </span>
    </button>}
  </section>
}
