import { Box, FileHelpers, type Editor } from 'tldraw'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { agentPanel, useAgentPanelOpen } from './agentPanelStore'

type Msg = { id?: number; role: 'user' | 'assistant' | 'system'; content: string; created_at?: string; memo?: string }

// DeepSeek pricing (USD per 1M tokens), used only to give the user a rough estimate.
const PRICE_IN = 0.22
const PRICE_CACHED = 0.007
const PRICE_OUT = 0.66
type UsageTotals = { prompt: number; completion: number; cost: number }
function addUsage(tot: UsageTotals, u: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | null): UsageTotals {
	if (!u) return tot
	const p = Number(u.prompt_tokens) || 0
	const c = Number(u.completion_tokens) || 0
	const hit = Number(u.prompt_cache_hit_tokens) || 0
	return {
		prompt: tot.prompt + p,
		completion: tot.completion + c,
		cost: tot.cost + ((p - hit) * PRICE_IN + hit * PRICE_CACHED + c * PRICE_OUT) / 1e6,
	}
}

// Capture what the user currently SEES — their viewport region ONLY, so the agent
// never reads parts of the board that weren't intended. We send, in order:
//   1) an OVERVIEW image of the whole view (so the model understands the layout:
//      what is next to what), then
//   2) high-detail TILES of that same view (so handwriting is legible).
// DeepSeek downscales every image to ~800x800 before inference, so a single image
// gives the whole view one 800px budget only; several tiles give each part of the
// view its own budget. We render tiles at 1600px (supersampling) so the model's
// internal 800px downscale is crisp. Each tile is exported at a fixed pixel density
// (like a board export), independent of the user's screen/zoom.
const TILE_PX = 1600 // render size target (model sees ~800 -> 2x supersampling)
const CHUNK_UNITS = 450 // fixed square chunk size (board units), anchored at (0,0)
// DeepSeek accepts up to 600 images per request: that is the hard ceiling here.
// We also stop early if the payload would reach the 48 MiB request-body limit.
const MAX_TILES = 600 // max tiles (+1 overview image)
const MAX_UPSCALE = 4
const MAX_BYTES = 200 * 1024 * 1024 // client-side base64 budget (200 MB)

function shapesIn(editor: Editor, box: { minX: number; maxX: number; minY: number; maxY: number }) {
	return editor.getCurrentPageShapesSorted().filter((shape) => {
		const sb = editor.getShapeMaskedPageBounds(shape)
		if (!sb) return false
		// INTERSECT: a shape straddling a seam appears (clipped) in both tiles.
		return sb.maxX > box.minX && sb.minX < box.maxX && sb.maxY > box.minY && sb.minY < box.maxY
	})
}

function hashStr(s: string): string {
	let h = 5381
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
	return (h >>> 0).toString(36)
}

// A tile's signature = ids + props of the shapes it contains. Unchanged tile => same
// signature => we skip re-rendering AND re-sending it (saves tokens/bandwidth).
function boxSig(editor: Editor, box: Box): string {
	const parts: string[] = []
	for (const shape of shapesIn(editor, box)) {
		parts.push(shape.id + '#' + hashStr(JSON.stringify((shape as { props?: unknown }).props ?? {})))
	}
	return hashStr(parts.sort().join('|'))
}

type Tile = { key: string; box: Box; sig: string }

// Fixed, ABSOLUTE chunks anchored at the board origin (0,0) — like Minecraft
// chunks. A chunk's key AND its content are independent of the user's viewport, so
// panning/zooming does NOT make an already-sent chunk look "changed": only chunks
// whose content actually changed (or newly-visible chunks) are re-sent.
function tilesForView(editor: Editor): Tile[] {
	const vp = editor.getViewportPageBounds()
	if (vp.w <= 0 || vp.h <= 0) return []
	const vpBox = Box.From(vp)
	// Image 1 = overview of what the user sees (layout context).
	const tiles: Tile[] = [{ key: 'overview', box: vpBox, sig: boxSig(editor, vpBox) }]

	const i0 = Math.floor(vp.minX / CHUNK_UNITS)
	const i1 = Math.floor(vp.maxX / CHUNK_UNITS)
	const j0 = Math.floor(vp.minY / CHUNK_UNITS)
	const j1 = Math.floor(vp.maxY / CHUNK_UNITS)
	for (let j = j0; j <= j1; j++) {
		for (let i = i0; i <= i1; i++) {
			if (tiles.length >= MAX_TILES) return tiles
			const box = Box.From({ x: i * CHUNK_UNITS, y: j * CHUNK_UNITS, w: CHUNK_UNITS, h: CHUNK_UNITS })
			tiles.push({ key: `c${i}_${j}`, box, sig: boxSig(editor, box) })
		}
	}
	return tiles
}

async function renderTile(editor: Editor, box: Box): Promise<string | null> {
	const shapes = shapesIn(editor, box)
	if (shapes.length === 0) return null
	const scale = Math.min(MAX_UPSCALE, TILE_PX / Math.max(box.w, box.h))
	const result = await editor.toImage(shapes, {
		format: 'jpeg',
		background: true,
		bounds: box,
		padding: 0,
		pixelRatio: 1,
		scale,
	})
	return await FileHelpers.blobToDataUrl(result.blob)
}

// Signatures of the tiles we last sent (tile key -> signature). Lets us send ONLY
// the regions that changed since the previous message instead of the whole view.
const sentSigs = new Map<string, string>()

// Snapshot of the last capture: what the agent currently has in its "image reading
// memory" (chunks + their status). Shown only in the hidden "mémoire lecture image".
let lastCaptureChunks: ChunkMeta[] = []

type Box4 = { x: number; y: number; w: number; h: number }
type TileMeta = Box4 & { key: string; kind: 'overview' | 'chunk' }
type ChunkMeta = TileMeta & { status: 'sent' | 'unchanged' | 'empty' | 'not-attached' }
const STATUS_LABEL: Record<ChunkMeta['status'], string> = {
	sent: 'envoyée',
	unchanged: 'inchangée (en mémoire)',
	empty: 'vide',
	'not-attached': 'non jointe',
}
const STATUS_COLOR: Record<ChunkMeta['status'], string> = {
	sent: '#16a34a',
	unchanged: '#6b7280',
	empty: '#9ca3af',
	'not-attached': '#d97706',
}
export type Capture = { images: string[]; tiles: TileMeta[]; view: Box4; chunks: ChunkMeta[] }

// Returns the images to attach PLUS a manifest describing, in board coordinates:
// the visible region, the coordinates of every attached image, and every chunk of
// the view that was NOT attached (unchanged, empty, or skipped) — so the agent knows
// exactly where each content is, and that an un-sent chunk still exists in the view.
// `mode`: 'none' = manifest only (no image), 'overview' = global view image only,
// 'tiles' = global view + HD chunks.
type CaptureMode = 'none' | 'overview' | 'tiles'
async function captureView(editor: Editor, mode: CaptureMode): Promise<Capture> {
	const tiles = tilesForView(editor)
	const vp = editor.getViewportPageBounds()
	const view = { x: vp.x, y: vp.y, w: vp.w, h: vp.h }
	const images: string[] = []
	const sentTiles: TileMeta[] = []
	const chunks: ChunkMeta[] = []
	let bytes = 0

	for (const t of tiles) {
		const isOverview = t.key === 'overview'
		// NB: we deliberately KEEP signatures of chunks that scrolled out of view, so
		// panning back to an unchanged region does NOT re-send it.
		const changed = sentSigs.get(t.key) !== t.sig
		const renderable = mode === 'tiles' || (mode === 'overview' && isOverview)
		if (renderable) sentSigs.set(t.key, t.sig)

		const meta: TileMeta = {
			key: t.key,
			x: t.box.x,
			y: t.box.y,
			w: t.box.w,
			h: t.box.h,
			kind: isOverview ? 'overview' : 'chunk',
		}
		if (!changed) {
			chunks.push({ ...meta, status: 'unchanged' })
			continue
		}
		if (!renderable) {
			chunks.push({ ...meta, status: 'not-attached' })
			continue
		}
		const budgetOk = images.length < MAX_TILES && bytes < MAX_BYTES
		const img = budgetOk ? await renderTile(editor, t.box) : null
		if (img && bytes + img.length <= MAX_BYTES) {
			bytes += img.length
			images.push(img)
			sentTiles.push(meta)
			chunks.push({ ...meta, status: 'sent' })
		} else {
			// Empty tile, or skipped for budget: still report it so the agent knows
			// this chunk is in the view but was not attached.
			chunks.push({ ...meta, status: 'empty' })
		}
	}
	lastCaptureChunks = chunks
	return { images, tiles: sentTiles, view, chunks }
}

function resetSentSigs() {
	sentSigs.clear()
}

// ---- keep the tab awake while the agent works -------------------------------
// Browsers throttle then FREEZE background tabs (JS paused, rAF stopped). Our agent
// needs the page (it renders the chunks with editor.toImage), so while a turn is
// running we hold a Web Lock (Chrome won't freeze a tab holding a lock) + a screen
// Wake Lock. Result: switching tabs no longer interrupts the agent.
let releaseWebLock: (() => void) | null = null
let screenWakeLock: { release: () => Promise<void> } | null = null
function holdAwake() {
	try {
		navigator.locks
			?.request(
				'esi-whiteboard-agent',
				() =>
					new Promise<void>((res) => {
						releaseWebLock = res
					})
			)
			.catch(() => {})
	} catch {
		/* Web Locks unsupported */
	}
	try {
		type WakeLockNav = {
			wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> }
		}
		;(navigator as unknown as WakeLockNav).wakeLock
			?.request('screen')
			.then((w) => {
				screenWakeLock = w
			})
			.catch(() => {})
	} catch {
		/* Wake Lock unsupported */
	}
}
function releaseAwake() {
	try {
		releaseWebLock?.()
	} catch {}
	releaseWebLock = null
	try {
		screenWakeLock?.release()
	} catch {}
	screenWakeLock = null
}

// Force the (re)reading of chunks given their numbers (i, j): chunk (i,j) is the
// 450x450 area at x=i*450, y=j*450. Used by the `read_chunks` tool, bypassing the
// incremental cache (always re-renders, even if the chunk is already "in memory").
async function captureChunks(editor: Editor, chunks: { i: number; j: number }[]): Promise<Capture> {
	const seen = new Set<string>()
	const boxes: Box[] = []
	for (const c of Array.isArray(chunks) ? chunks : []) {
		const i = Math.floor(Number(c.i))
		const j = Math.floor(Number(c.j))
		if (!Number.isFinite(i) || !Number.isFinite(j)) continue
		const key = `${i}_${j}`
		if (seen.has(key)) continue
		seen.add(key)
		boxes.push(Box.From({ x: i * CHUNK_UNITS, y: j * CHUNK_UNITS, w: CHUNK_UNITS, h: CHUNK_UNITS }))
	}
	const vp = editor.getViewportPageBounds()
	const view = { x: vp.x, y: vp.y, w: vp.w, h: vp.h }
	const images: string[] = []
	const tiles: TileMeta[] = []
	const outChunks: ChunkMeta[] = []
	let bytes = 0
	for (const box of boxes) {
		const meta: TileMeta = {
			key: `c${box.x / CHUNK_UNITS}_${box.y / CHUNK_UNITS}`,
			x: box.x,
			y: box.y,
			w: box.w,
			h: box.h,
			kind: 'chunk',
		}
		const img = bytes < MAX_BYTES ? await renderTile(editor, box) : null
		if (img && bytes + img.length <= MAX_BYTES) {
			bytes += img.length
			images.push(img)
			tiles.push(meta)
			outChunks.push({ ...meta, status: 'sent' })
		} else {
			outChunks.push({ ...meta, status: 'empty' })
		}
	}
	lastCaptureChunks = outChunks
	return { images, tiles, view, chunks: outChunks }
}

function loadPref<T>(key: string, fallback: T): T {
	try {
		const s = localStorage.getItem(key)
		if (s) return { ...fallback, ...JSON.parse(s) }
	} catch {
		/* ignore */
	}
	return fallback
}

// Normalize LaTeX delimiters so KaTeX can render them: \( \) -> $ $, \[ \] -> $$ $$.
// Inline $...$ is also upgraded to block $$...$$ when it contains a "big" construct
// (fraction/root/integral/sum...), because KaTeX renders those tiny in text style.
function normalizeMath(s: string): string {
	if (!s) return s
	let out = s
		.replace(/\\\[/g, () => '$$')
		.replace(/\\\]/g, () => '$$')
		.replace(/\\\(/g, () => '$')
		.replace(/\\\)/g, () => '$')
	// $$...$$ already fine. Upgrade single-$ spans that contain big math constructs.
	out = out.replace(/(^|[^$])\$([^$\n]+)\$(?!\$)/g, (m, pre, body) => {
		if (/(\\frac|\\dfrac|\\sqrt|\\int|\\sum|\\prod|\\lim|\\begin\{|\\binom|\\over)/.test(body)) {
			return `${pre}\n\n$$${body}$$\n\n`
		}
		return m
	})
	return out
}

function ShotIcon() {
	return (
		<svg
			width="17"
			height="17"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 8V5a2 2 0 0 1 2-2h3" />
			<path d="M16 3h3a2 2 0 0 1 2 2v3" />
			<path d="M21 16v3a2 2 0 0 1-2 2h-3" />
			<path d="M8 21H5a2 2 0 0 1-2-2v-3" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	)
}

export default function AgentPanel({ editor, roomId }: { editor: Editor | null; roomId: string }) {
	const open = useAgentPanelOpen()
	const [messages, setMessages] = useState<Msg[]>([])
	const [input, setInput] = useState('')
	const [busy, setBusy] = useState(false)
	const [configured, setConfigured] = useState(true)
	const [usage, setUsage] = useState<UsageTotals>({ prompt: 0, completion: 0, cost: 0 })
	// Hidden by default: the agent's "image reading memory" (visible debug/info panel).
	const [showMemory, setShowMemory] = useState(false)
	// The model's hidden text memory of the tiles (<memo>), shown only in that panel.
	const [modelMemo, setModelMemo] = useState('')
	const listRef = useRef<HTMLDivElement>(null)

	// Floating window geometry (draggable + resizable), persisted locally.
	const [pos, setPos] = useState(() =>
		loadPref('agent.pos', { x: Math.max(8, window.innerWidth - 432), y: 72 })
	)
	const [size, setSize] = useState(() =>
		loadPref('agent.size', { w: 400, h: Math.min(640, window.innerHeight - 120) })
	)
	const drag = useRef<{ dx: number; dy: number } | null>(null)

	useEffect(() => {
		try {
			localStorage.setItem('agent.pos', JSON.stringify(pos))
		} catch {}
	}, [pos])
	useEffect(() => {
		try {
			localStorage.setItem('agent.size', JSON.stringify(size))
		} catch {}
	}, [size])

	useEffect(() => {
		fetch(`/api/agent/history?room=${encodeURIComponent(roomId)}`)
			.then((r) => r.json())
			.then((d) => {
				setMessages(d.messages || [])
				if (typeof d.configured === 'boolean') setConfigured(d.configured)
				const last = (d.messages || []).filter((m: Msg) => m.role === 'assistant' && m.memo).pop()
				if (last?.memo) setModelMemo(last.memo)
			})
			.catch(() => {})
	}, [roomId])

	useEffect(() => {
		if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
	}, [messages, open])

	function onDragStart(e: React.MouseEvent) {
		drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
		const move = (ev: MouseEvent) => {
			if (!drag.current) return
			setPos({
				x: Math.min(Math.max(0, ev.clientX - drag.current.dx), window.innerWidth - 80),
				y: Math.min(Math.max(0, ev.clientY - drag.current.dy), window.innerHeight - 40),
			})
		}
		const up = () => {
			drag.current = null
			window.removeEventListener('mousemove', move)
			window.removeEventListener('mouseup', up)
		}
		window.addEventListener('mousemove', move)
		window.addEventListener('mouseup', up)
	}

	function onResizeStart(e: React.MouseEvent) {
		e.stopPropagation()
		const startX = e.clientX
		const startY = e.clientY
		const w0 = size.w
		const h0 = size.h
		const move = (ev: MouseEvent) => {
			setSize({
				w: Math.max(300, Math.min(w0 + (ev.clientX - startX), window.innerWidth - 16)),
				h: Math.max(260, Math.min(h0 + (ev.clientY - startY), window.innerHeight - 16)),
			})
		}
		const up = () => {
			window.removeEventListener('mousemove', move)
			window.removeEventListener('mouseup', up)
		}
		window.addEventListener('mousemove', move)
		window.addEventListener('mouseup', up)
	}

	// Single send. The model itself decides (via the `request_view` tool) whether it
	// needs to see the board and with which detail; we transparently answer the tool
	// call by capturing the view, then ask again for the final answer.
	async function send() {
		const text = input.trim()
		if (!text || busy) return
		setInput('')
		setBusy(true)
		// Prevent the browser from freezing/throttling this tab during the turn.
		holdAwake()
		setMessages((m) => [...m, { role: 'user', content: text }])
		try {
			let payload: Record<string, unknown> = { room: roomId, prompt: text }
			// If a screenshot request fails, retry lighter ('overview') before giving up.
			let downgraded = false
			for (let round = 0; round < 4; round++) {
				const res = await fetch('/api/agent/ask', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				})
				const raw = await res.text()
				let d: {
					answer?: string
					memo?: string
					usage?: unknown
					toolCall?: { id?: string; name?: string; arguments?: string; reasoningContent?: string }
				} = {}
				try {
					d = raw ? JSON.parse(raw) : {}
				} catch {
					// Never choke on a non-JSON body (proxy 413/502, empty): explain instead.
					setMessages((m) => [
						...m,
						{
							role: 'assistant',
							content: `⚠️ Réponse inattendue du serveur (${res.status}). Réessaie, ou zoome un peu (moins d'images à envoyer).`,
						},
					])
					break
				}
				if (d.usage) setUsage((u) => addUsage(u, d.usage))
				if (d.memo) setModelMemo(d.memo)
				if (d.toolCall) {
					// The server sends `arguments` as a JSON string — parse it (do NOT read `args`).
					let args: { mode?: string; chunks?: { i: number; j: number }[] } = {}
					try {
						args = d.toolCall.arguments ? JSON.parse(d.toolCall.arguments) : {}
					} catch {
						/* ignore malformed args */
					}
					let cap: Capture = { images: [], tiles: [], view: { x: 0, y: 0, w: 0, h: 0 }, chunks: [] }
					try {
						if (editor) {
							if (d.toolCall.name === 'read_chunks' && Array.isArray(args.chunks)) {
								cap = await captureChunks(editor, args.chunks)
							} else {
								const mode: CaptureMode = args.mode === 'overview' ? 'overview' : 'tiles'
								cap = await captureView(editor, downgraded ? 'overview' : mode)
							}
						}
					} catch {
						/* ignore capture errors */
					}
					payload = { room: roomId, toolResult: { toolCall: d.toolCall, ...cap } }
					downgraded = true
					setMessages((m) => [
						...m,
						{
							role: 'system',
							content: `📷 Le modèle a téléchargé ta vue, étalée sur ${cap.images.length} image${
								cap.images.length > 1 ? 's' : ''
							}`,
						},
					])
					continue
				}
				setMessages((m) => [...m, { role: 'assistant', content: d.answer || '(vide)' }])
				break
			}
		} catch (e) {
			setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${(e as Error).message}` }])
		} finally {
			releaseAwake()
			setBusy(false)
		}
	}

	async function clearHistory() {
		if (!window.confirm("Effacer l'historique de ce tableau ?")) return
		await fetch('/api/agent/clear', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ room: roomId }),
		})
		// The agent's memory of the tiles lives in the chat history (its text summary).
		// So wiping the history MUST also forget which chunks were sent, otherwise the
		// agent would lose its memory AND stop receiving images. Reset => the next
		// send re-sends everything visible and rebuilds the memo.
		resetSentSigs()
		setMessages([])
	}

	if (!open) return null

	return (
		<>
			<style>{markdownCss}</style>
			<div style={{ ...panelStyle, left: pos.x, top: pos.y, width: size.w, height: size.h }}>
				<div style={headerStyle} onMouseDown={onDragStart} title="Glisser pour déplacer">
					<span style={{ fontWeight: 600, cursor: 'move', userSelect: 'none' }}>🤖 Assistant</span>
					<div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onMouseDown={(e) => e.stopPropagation()}>
						<span style={{ fontSize: 11, color: '#999' }}>{roomId}</span>
						<button onClick={clearHistory} style={smallBtnStyle} title="Effacer l'historique de cette room">
							Effacer
						</button>
						<button onClick={() => agentPanel.set(false)} style={smallBtnStyle} title="Fermer">
							✕
						</button>
					</div>
				</div>
				{!configured && (
					<div style={warnStyle}>
						Clé API IA non configurée sur le serveur (<code>AGENT_API_KEY</code>). Les réponses échoueront.
					</div>
				)}
				<div ref={listRef} style={listStyle}>
					{messages.length === 0 && (
						<div style={{ color: '#888', fontSize: 13, padding: 8 }}>
							Demande par ex. « vérifie mes équations ». L'agent voit une capture de ta vue.
						</div>
					)}
					{messages.map((m, i) =>
						m.role === 'system' ? (
							<div key={m.id ?? i} style={noticeStyle}>
								{m.content}
							</div>
						) : m.role === 'user' ? (
							<div key={m.id ?? i} style={userMsgStyle}>
								{m.content}
							</div>
						) : (
							<div key={m.id ?? i} style={botMsgStyle} className="agent-md">
								<ReactMarkdown
									remarkPlugins={[remarkGfm, remarkMath]}
									rehypePlugins={[rehypeKatex]}
								>
									{normalizeMath(m.content)}
								</ReactMarkdown>
							</div>
						)
					)}
					{busy && <div style={{ ...botMsgStyle, color: '#888' }}>…</div>}
				</div>
				<div style={inputRowStyle}>
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault()
								send()
							}
						}}
						placeholder="Ex : vérifie mes équations…"
						rows={2}
						style={textareaStyle}
						disabled={busy}
					/>
					<button
						onClick={send}
						disabled={busy || !input.trim()}
						style={sendBtnStyle}
						title="Envoyer (l'assistant demandera la vue du tableau s'il en a besoin)"
					>
						{busy ? '…' : '↑'}
					</button>
				</div>
				{showMemory && (
					<div style={memoryListStyle}>
						<div style={{ fontWeight: 600, color: '#444' }}>🧠 Mémoire texte du modèle</div>
						{modelMemo ? (
							<div style={{ whiteSpace: 'pre-wrap', color: '#555' }}>{modelMemo}</div>
						) : (
							<div style={{ color: '#999' }}>Vide pour l'instant.</div>
						)}
						<div style={{ fontWeight: 600, color: '#444', marginTop: 8 }}>🖼️ Tuiles en mémoire</div>
						{lastCaptureChunks.length === 0 && (
							<div style={{ color: '#999' }}>Aucune tuile en mémoire pour l'instant.</div>
						)}
						{lastCaptureChunks.map((c, i) => (
							<div key={i} style={memoryRowStyle}>
								<span>
									{c.kind === 'overview'
										? "vue d'ensemble"
										: `chunk (${Math.round(c.x / CHUNK_UNITS)},${Math.round(c.y / CHUNK_UNITS)})`}
								</span>
								<span style={{ color: STATUS_COLOR[c.status] }}>{STATUS_LABEL[c.status]}</span>
							</div>
						))}
					</div>
				)}
				<div style={footerStyle}>
					<span>{(usage.prompt + usage.completion).toLocaleString('fr-FR')} tokens</span>
					<span style={{ opacity: 0.5 }}>·</span>
					<span title="Estimation de coût (deepseek-flash)">~${usage.cost.toFixed(4)}</span>
					<span style={{ flex: 1 }} />
					<button onClick={() => setShowMemory((v) => !v)} style={memoryToggleStyle}>
						🧠 mémoire lecture image {showMemory ? '▲' : '▼'}
					</button>
				</div>
				<div style={resizeHandleStyle} onMouseDown={onResizeStart} title="Redimensionner" />
			</div>
		</>
	)
}

const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

const markdownCss = `
.agent-md { font-size: 13.5px; line-height: 1.5; }
.agent-md p { margin: 0 0 8px; }
.agent-md p:last-child { margin-bottom: 0; }
.agent-md h1, .agent-md h2, .agent-md h3, .agent-md h4 { margin: 10px 0 6px; line-height: 1.25; }
.agent-md h1 { font-size: 17px; } .agent-md h2 { font-size: 15.5px; } .agent-md h3 { font-size: 14px; }
.agent-md ul, .agent-md ol { margin: 6px 0; padding-left: 20px; }
.agent-md li { margin: 2px 0; }
.agent-md code { background: #e7e7e7; padding: 1px 4px; border-radius: 4px; font-size: 12.5px; font-family: ui-monospace, Menlo, monospace; }
.agent-md pre { background: #f6f6f6; border: 1px solid #e2e2e2; border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 8px 0; }
.agent-md pre code { background: none; padding: 0; }
.agent-md blockquote { border-left: 3px solid #ccc; margin: 6px 0; padding: 2px 10px; color: #555; }
.agent-md table { border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
.agent-md th, .agent-md td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
.agent-md th { background: #f3f3f3; }
.agent-md a { color: #2b6cff; }
.agent-md hr { border: none; border-top: 1px solid #e0e0e0; margin: 10px 0; }
.agent-md strong { font-weight: 700; }
/* Math (KaTeX): render formulas larger and more legible, especially display math. */
.agent-md .katex { font-size: 1.42em; line-height: 1.1; }
.agent-md .katex-display { font-size: 1.85em; margin: 16px 0; }
.agent-md .katex-display > .katex { font-size: 1em; }
.agent-md .katex .base { margin: 1px 0; }
`

const panelStyle: React.CSSProperties = {
	position: 'fixed',
	zIndex: 10000,
	display: 'flex',
	flexDirection: 'column',
	background: '#fff',
	color: '#111',
	border: '1px solid #e0e0e0',
	borderRadius: 12,
	boxShadow: '0 12px 40px rgba(0,0,0,.22)',
	fontFamily,
	overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	padding: '8px 10px',
	borderBottom: '1px solid #eee',
	background: '#fafafa',
	cursor: 'move',
}

const smallBtnStyle: React.CSSProperties = {
	border: '1px solid #ddd',
	background: '#fff',
	borderRadius: 6,
	padding: '3px 8px',
	fontSize: 12,
	cursor: 'pointer',
	color: '#333',
}

const warnStyle: React.CSSProperties = {
	background: '#fff3cd',
	color: '#7a5b00',
	fontSize: 12,
	padding: '8px 12px',
	borderBottom: '1px solid #f0e0a0',
}

const listStyle: React.CSSProperties = {
	flex: 1,
	overflowY: 'auto',
	padding: 10,
	display: 'flex',
	flexDirection: 'column',
	gap: 8,
}

const baseMsg: React.CSSProperties = {
	padding: '8px 10px',
	borderRadius: 10,
	fontSize: 13.5,
	lineHeight: 1.45,
	wordBreak: 'break-word',
	maxWidth: '94%',
}

const userMsgStyle: React.CSSProperties = {
	...baseMsg,
	alignSelf: 'flex-end',
	background: '#2b6cff',
	color: '#fff',
	borderBottomRightRadius: 3,
	whiteSpace: 'pre-wrap',
}

const botMsgStyle: React.CSSProperties = {
	...baseMsg,
	alignSelf: 'flex-start',
	background: '#f1f1f1',
	color: '#111',
	borderBottomLeftRadius: 3,
}

const inputRowStyle: React.CSSProperties = {
	display: 'flex',
	gap: 8,
	padding: 10,
	borderTop: '1px solid #eee',
	background: '#fafafa',
	alignItems: 'flex-end',
	flexShrink: 0,
}

const textareaStyle: React.CSSProperties = {
	flex: 1,
	resize: 'none',
	border: '1px solid #ddd',
	borderRadius: 8,
	padding: '8px 10px',
	fontSize: 13.5,
	fontFamily,
	outline: 'none',
}

const sendBtnStyle: React.CSSProperties = {
	width: 40,
	height: 40,
	borderRadius: 8,
	border: 'none',
	background: '#2b6cff',
	color: '#fff',
	fontSize: 18,
	cursor: 'pointer',
}

// Small centered pill used for system notices (e.g. "the model downloaded your view").
const noticeStyle: React.CSSProperties = {
	alignSelf: 'center',
	background: '#eef2ff',
	color: '#4b5563',
	border: '1px solid #dbe3ff',
	borderRadius: 999,
	padding: '3px 10px',
	fontSize: 11.5,
	textAlign: 'center',
	maxWidth: '96%',
}

// Conversation cost / token footer, like a CLI status line.
const footerStyle: React.CSSProperties = {
	display: 'flex',
	gap: 6,
	justifyContent: 'center',
	alignItems: 'center',
	padding: '4px 10px',
	borderTop: '1px solid #f0f0f0',
	background: '#fff',
	fontSize: 11,
	color: '#888',
	flexShrink: 0,
}

const memoryToggleStyle: React.CSSProperties = {
	border: 'none',
	background: 'none',
	color: '#6b7280',
	fontSize: 11,
	cursor: 'pointer',
	padding: 0,
}

const memoryListStyle: React.CSSProperties = {
	maxHeight: 170,
	overflowY: 'auto',
	borderTop: '1px solid #f0f0f0',
	background: '#fbfbfd',
	padding: '6px 10px',
	fontSize: 11,
	color: '#555',
	display: 'flex',
	flexDirection: 'column',
	gap: 3,
	flexShrink: 0,
}

const memoryRowStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: 8,
}

const resizeHandleStyle: React.CSSProperties = {
	position: 'absolute',
	right: 0,
	bottom: 0,
	width: 16,
	height: 16,
	cursor: 'nwse-resize',
	background:
		'linear-gradient(135deg, transparent 0 50%, #bbb 50% 60%, transparent 60% 70%, #bbb 70% 80%, transparent 80%)',
}