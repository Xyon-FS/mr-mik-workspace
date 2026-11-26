function hasNonlocalUrl(value: string) {
  const urls = /url\(\s*(?:"#([^"]+)"|'#([^']+)'|#([^\s)'"]+))\s*\)/gi
  return /url\s*\(/i.test(value.replace(urls, ''))
}

export function svgImage(source: string) {
  if (source.length > 200000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return null
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') return null
  const root = document.documentElement
  if (!root.namespaceURI) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  if (!root.hasAttribute('width') && !root.hasAttribute('height')) {
    const [, , width, height] = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const scale = Math.min(1, 8192 / Math.max(width, height))
      root.setAttribute('width', String(width * scale)); root.setAttribute('height', String(height * scale))
    }
  }
  for (const node of document.querySelectorAll('script,foreignObject,iframe,audio,video,animate,set,animateTransform')) node.remove()
  for (const node of document.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
    if (/^on/i.test(attribute.name) || /(?:href|src)$/i.test(attribute.name) && !attribute.value.startsWith('#') || hasNonlocalUrl(attribute.value)) node.removeAttribute(attribute.name)
  }
  for (const style of document.querySelectorAll('style')) if (/@import/i.test(style.textContent || '') || hasNonlocalUrl(style.textContent || '')) style.remove()
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
}
