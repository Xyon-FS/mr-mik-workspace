import { useMemo } from 'react'
import { svgImage } from './svgImage'
export default function SvgDocument({ text }: { text: string }) {
  const image = useMemo(() => svgImage(text), [text])
  return image ? <><img draggable={false} className="svg-document" alt="SVG output" src={image} />{/<(?:[\w.-]+:)?foreignObject\b/i.test(text) && <details className="svg-source-note"><summary>Preview omits embedded HTML. View SVG source</summary><pre>{text}</pre></details>}</> : <pre>{text}</pre>
}
