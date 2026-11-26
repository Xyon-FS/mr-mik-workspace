export async function previewBlob(url: string) {
  const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
  if (data) {
    const decoded = atob(data[2]), bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
    return new Blob([bytes], { type: data[1] })
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Image download failed (${response.status}).`)
  return response.blob()
}
export function imageDownloadName(url: string, name: string) {
  const imageFile = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i
  if (imageFile.test(name)) return name
  if (!url.startsWith('data:')) { try { const file = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); if (imageFile.test(file)) return file } catch { /* Use the caption below. */ } }
  const extension = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml)/i.exec(url)?.[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
  const caption = [...(name || 'image')].map(char => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char).join('').slice(0, 180)
  return `${caption}.${extension}`
}
export async function downloadImage(url: string, name?: string) {
  const blob = await previewBlob(url), objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = objectUrl
  link.download = name || decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'image')
  link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
}
