import { previewBlob } from '../lib/download'

export async function normalizeWorkspaceIcon(input: Blob | string) {
  const blob = typeof input === 'string' ? await previewBlob(input) : input
  if (blob.size > 16 * 1024 * 1024 || !/^image\/(png|webp|jpeg|x-icon|vnd.microsoft.icon)$/.test(blob.type)) throw new Error('Choose a PNG or WebP image with a transparent background (up to 16 MB).')
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width * bitmap.height > 36000000) throw new Error('Choose an image under 36 megapixels.')
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })!
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let transparent = 0, visible = 0
    for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] === 0) transparent++; if (pixels[index] > 0) visible++ }
    if (transparent < pixels.length / 4 * .01 || !visible) throw new Error('This image needs a real transparent background and a visible subject. Choose another image or regenerate it.')
    let dataUrl = canvas.toDataURL('image/png')
    if (dataUrl.length > 96000) {
      canvas.width = Math.max(1, Math.round(canvas.width / 2)); canvas.height = Math.max(1, Math.round(canvas.height / 2))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); dataUrl = canvas.toDataURL('image/png')
    }
    if (dataUrl.length > 96000) throw new Error('Choose a simpler image for this small workspace icon.')
    return dataUrl
  } finally { bitmap.close() }
}
