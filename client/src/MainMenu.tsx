import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
	DefaultMainMenu,
	DefaultMainMenuContent,
	DefaultToolbar,
	DefaultToolbarContent,
	TLUiOverrides,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	TldrawUiMenuSubmenu,
	TldrawUiToolbar,
	TldrawUiToolbarButton,
	defaultHandleExternalFileContent,
	useEditor,
	useToasts,
	useTranslation,
	type TLComponents,
} from 'tldraw'
import { importPdf } from './pdfImport'
import { roomId } from './room'
import { agentPanel } from './agentPanelStore'

const aiIconStyle: React.CSSProperties = {
	display: 'inline-block',
	width: 26,
	height: 26,
	backgroundColor: 'currentColor',
	WebkitMaskImage: 'url(/ai-icon.png)',
	maskImage: 'url(/ai-icon.png)',
	WebkitMaskSize: 'contain',
	maskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
	maskRepeat: 'no-repeat',
	WebkitMaskPosition: 'center',
	maskPosition: 'center',
}

/** Toolbar button (proper toolbar item, not a menu item) that toggles the AI panel. */
function AiToolbarButton() {
	return (
		<TldrawUiToolbarButton type="icon" title="Assistant IA" onClick={() => agentPanel.toggle()}>
			<span className="wb-ai-icon" style={aiIconStyle} />
		</TldrawUiToolbarButton>
	)
}

/** Toolbar = default tools + AI button. The AI button is wrapped in a
 *  TldrawUiToolbar (Radix Toolbar.Root) because TldrawUiToolbarButton requires one. */
function CustomToolbar() {
	return (
		<DefaultToolbar>
			<DefaultToolbarContent />
			<TldrawUiToolbar label="Assistant IA">
				<AiToolbarButton />
			</TldrawUiToolbar>
		</DefaultToolbar>
	)
}

function MainMenuExtras() {
	const toasts = useToasts()
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [boards, setBoards] = useState<string[]>([])

	// Fetch the existing boards (rooms) for the navigation submenu.
	useEffect(() => {
		fetch('/api/rooms')
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((d) => setBoards(d.rooms || []))
			.catch(() => {})
	}, [confirmOpen])

	async function doReset() {
		if (busy) return
		setBusy(true)
		try {
			const res = await fetch('/api/room/reset', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ room: roomId }),
			})
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			// Go back to the shared default board.
			window.location.href = '/default'
		} catch (e) {
			setBusy(false)
			setConfirmOpen(false)
			toasts.addToast({
				title: 'Échec de la suppression',
				description: (e as Error).message,
				severity: 'error',
			})
		}
	}

	return (
		<>
			<DefaultMainMenu>
				<DefaultMainMenuContent />
				<TldrawUiMenuSubmenu id="boards" label="Tableaux">
					<TldrawUiMenuGroup id="boards-list">
						{boards.length === 0 && (
							<TldrawUiMenuItem id="board-none" label="(aucun)" disabled onSelect={() => {}} />
						)}
						{boards.map((b) => (
							<TldrawUiMenuItem
								key={b}
								id={`board-${b}`}
								label={b === roomId ? `${b}  ✓` : b}
								onSelect={() => {
									if (b !== roomId) window.location.href = `/${b}`
								}}
							/>
						))}
					</TldrawUiMenuGroup>
				</TldrawUiMenuSubmenu>
				<TldrawUiMenuGroup id="reset-board">
					<TldrawUiMenuItem
						id="reset-board"
						label="Supprimer ce tableau…"
						iconLeft="trash"
						onSelect={() => setConfirmOpen(true)}
					/>
				</TldrawUiMenuGroup>
			</DefaultMainMenu>
			{confirmOpen &&
				createPortal(
					<div
						style={overlayStyle}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() => !busy && setConfirmOpen(false)}
					>
						<div style={dialogStyle} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
							<h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Supprimer ce tableau ?</h3>
							<p style={{ margin: '0 0 18px', color: '#555', fontSize: 13, lineHeight: 1.5 }}>
								Tout le contenu du tableau <b>« {roomId} »</b> sera définitivement effacé (formes,
								dessins, images) <b>pour tout le monde</b>. Cette action est irréversible.
							</p>
							<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
								<button
									type="button"
									style={cancelBtnStyle}
									onClick={() => setConfirmOpen(false)}
									disabled={busy}
								>
									Annuler
								</button>
								<button type="button" style={dangerBtnStyle} onClick={doReset} disabled={busy}>
									{busy ? 'Suppression…' : 'Supprimer'}
								</button>
							</div>
						</div>
					</div>,
					document.body
				)}
		</>
	)
}

/**
 * Routes uploaded files: PDFs are rendered to page images; everything else goes
 * through tldraw's default file handler. Rendered inside <Tldraw> for the hooks.
 */
export function MediaFileHandler() {
	const editor = useEditor()
	const toasts = useToasts()
	const msg = useTranslation()

	useEffect(() => {
		editor.registerExternalContentHandler('files', async (content) => {
			const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
			const pdfs = content.files.filter(isPdf)
			const rest = content.files.filter((f) => !isPdf(f))
			for (const f of pdfs) {
				const id = toasts.addToast({ title: 'Import du PDF…', description: f.name })
				try {
					const pages = await importPdf(editor, f)
					toasts.removeToast(id)
					toasts.addToast({
						title: 'PDF importé',
						description: `${pages} page(s) — ${f.name}`,
						severity: 'success',
					})
				} catch (e) {
					toasts.removeToast(id)
					toasts.addToast({
						title: 'Échec de l’import PDF',
						description: (e as Error).message,
						severity: 'error',
					})
				}
			}
			if (rest.length) {
				await defaultHandleExternalFileContent(editor, { point: content.point, files: rest }, { toasts, msg })
			}
		})
	}, [editor, toasts, msg])

	return null
}

/** Custom action: "Upload media…" also accepts PDFs. */
export const uiOverrides: TLUiOverrides = {
	actions(editor, actions) {
		actions['insert-media'] = {
			...actions['insert-media'],
			onSelect() {
				const input = editor.getContainerDocument().createElement('input')
				input.type = 'file'
				input.multiple = true
				input.accept = 'image/*,video/*,application/pdf,.pdf'
				input.addEventListener('change', async () => {
					const files = Array.from(input.files || [])
					if (!files.length) return
					await editor.putExternalContent({
						type: 'files',
						files,
						point: editor.getViewportPageBounds().center,
					})
				})
				input.click()
			},
		}
		return actions
	},
}

export const uiComponents: TLComponents = { MainMenu: MainMenuExtras, Toolbar: CustomToolbar }

const overlayStyle: React.CSSProperties = {
	position: 'fixed',
	inset: 0,
	zIndex: 20000,
	background: 'rgba(0,0,0,.45)',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
}

const dialogStyle: React.CSSProperties = {
	width: 380,
	maxWidth: '92vw',
	background: '#fff',
	color: '#111',
	borderRadius: 12,
	padding: '18px 20px',
	boxShadow: '0 20px 50px rgba(0,0,0,.35)',
}

const cancelBtnStyle: React.CSSProperties = {
	border: '1px solid #ddd',
	background: '#fff',
	color: '#333',
	borderRadius: 8,
	padding: '7px 14px',
	fontSize: 13,
	cursor: 'pointer',
}

const dangerBtnStyle: React.CSSProperties = {
	border: 'none',
	background: '#e03131',
	color: '#fff',
	borderRadius: 8,
	padding: '7px 14px',
	fontSize: 13,
	fontWeight: 600,
	cursor: 'pointer',
}