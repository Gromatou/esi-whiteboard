import { useSyncExternalStore } from 'react'

// Shared open/closed state for the AI panel, so it can be toggled from the toolbar
// (and closed from within the panel) without prop drilling.
let open = false
const listeners = new Set<() => void>()

export const agentPanel = {
	isOpen: () => open,
	set(v: boolean) {
		if (open === v) return
		open = v
		for (const l of listeners) l()
	},
	toggle() {
		agentPanel.set(!open)
	},
	subscribe(l: () => void) {
		listeners.add(l)
		return () => {
			listeners.delete(l)
		}
	},
}

export function useAgentPanelOpen() {
	return useSyncExternalStore(agentPanel.subscribe, agentPanel.isOpen)
}