import { AssetRecordType, createShapeId, type Editor } from 'tldraw'
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Logical size of a page on the canvas (PDF points × DISPLAY_SCALE).
const DISPLAY_SCALE = 1.5
// Pixel resolution of the rendered image (PDF points × RENDER_SCALE). Higher = crisper
// when zooming in, at the cost of import time / file size.
const RENDER_SCALE = 4
const JPEG_QUALITY = 0.9
const PAGE_GAP = 32

function slugName(name: string): string {
	return (name || 'document')
		.replace(/\.pdf$/i, '')
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.slice(0, 40)
}

/**
 * Import a PDF onto the canvas: each page is rendered (pdf.js) to a high-res JPEG,
 * uploaded to our asset store (/uploads), then placed as a (movable) image shape in a
 * vertical column. You draw normal shapes on top of the pages.
 */
export async function importPdf(
	editor: Editor,
	file: File,
	onProgress?: (done: number, total: number) => void
): Promise<number> {
	const PdfJS = await import('pdfjs-dist')
	PdfJS.GlobalWorkerOptions.workerSrc = PdfWorkerUrl

	const pdf = await PdfJS.getDocument({ data: await file.arrayBuffer() }).promise
	const canvas = document.createElement('canvas')
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('canvas 2d indisponible')

	const slug = slugName(file.name)

	type Rendered = { src: string; w: number; h: number }
	const rendered: Rendered[] = []

	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i)
		const base = page.getViewport({ scale: 1 })
		const vp = page.getViewport({ scale: RENDER_SCALE })
		canvas.width = Math.floor(vp.width)
		canvas.height = Math.floor(vp.height)
		await page.render({ canvasContext: ctx, viewport: vp }).promise

		const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', JPEG_QUALITY))
		if (!blob) continue

		const objectName = `${slug}-p${i}-${Math.random().toString(36).slice(2, 7)}.jpg`
		const src = `/uploads/${objectName}`
		await fetch(src, { method: 'PUT', body: blob })

		rendered.push({
			src,
			w: Math.round(base.width * DISPLAY_SCALE),
			h: Math.round(base.height * DISPLAY_SCALE),
		})
		onProgress?.(i, pdf.numPages)
	}

	canvas.width = 0
	canvas.height = 0

	if (rendered.length === 0) return 0

	// Lay the pages out in a centered vertical column, starting at the top of the viewport.
	const vb = editor.getViewportPageBounds()
	const widest = Math.max(...rendered.map((r) => r.w))
	const x = vb.center.x - widest / 2
	let y = vb.minY + 40

	for (const p of rendered) {
		const assetId = AssetRecordType.createId()
		editor.createAssets([
			{
				id: assetId,
				typeName: 'asset',
				type: 'image',
				meta: {},
				props: {
					name: p.src,
					src: p.src,
					w: p.w,
					h: p.h,
					mimeType: 'image/jpeg',
					isAnimated: false,
				},
			},
		])
		editor.createShape({
			id: createShapeId(),
			type: 'image',
			x: x + (widest - p.w) / 2,
			y,
			props: { assetId, w: p.w, h: p.h },
		})
		y += p.h + PAGE_GAP
	}

	return rendered.length
}

/** Opens the native file picker and imports the chosen PDF. */
export function openPdfPicker(editor: Editor, onDone?: (pages: number, name: string) => void) {
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'application/pdf,.pdf'
	input.addEventListener('change', async () => {
		const file = input.files?.[0]
		if (!file) return
		const pages = await importPdf(editor, file)
		onDone?.(pages, file.name)
	})
	input.click()
}