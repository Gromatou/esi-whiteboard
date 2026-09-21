// --- Room id from the URL (shared by the app and the UI menus) ---
//   https://host/<roomId>          -> room "roomId"
//   https://host/?room=<roomId>    -> room "roomId"
//   https://host/                  -> redirects to the shared "default" room
function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

export function resolveRoomId(): string {
	// 1) path: a single segment is the room id
	const path = window.location.pathname.replace(/^\/+|\/+$/g, '')
	if (path && !path.includes('/')) return safeDecode(path)
	// 2) query param: ?room=<roomId>
	const param = new URLSearchParams(window.location.search).get('room')
	if (param) return param
	// 3) root: fall back to the shared "default" room
	window.history.replaceState(null, '', '/default')
	return 'default'
}

// Resolved once at startup (module scope avoids React StrictMode double-invocation).
export const roomId = resolveRoomId()

// Tab title: "wb <room>", with underscores turned into spaces (e.g. /equipe_projet -> "wb equipe projet").
document.title = `wb ${roomId.replace(/_/g, ' ')}`