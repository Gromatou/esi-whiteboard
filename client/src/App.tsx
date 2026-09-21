import { useSync } from '@tldraw/sync'
import {
	AssetRecordType,
	getHashForString,
	TLAssetStore,
	TLBookmarkAsset,
	Tldraw,
	uniqueId,
	type Editor,
} from 'tldraw'
import { useEffect, useState } from 'react'
import AgentPanel from './AgentPanel'
import { uiComponents, uiOverrides, MediaFileHandler } from './MainMenu'
import { roomId } from './room'

function App() {
	const [userName, setUserName] = useState<string | null>(null)
	const [editor, setEditor] = useState<Editor | null>(null)

	// The username is provided by the server (nginx injects X-Forwarded-User
	// after Discord auth + guild check). We read it and put it in the presence.
	useEffect(() => {
		fetch('/api/me')
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((d) => setUserName(d?.name || 'Anonyme'))
			.catch(() => setUserName('Anonyme'))
	}, [])

	// Apply the Discord pseudo to the tldraw user (shows above the cursor).
	useEffect(() => {
		if (editor && userName) {
			editor.user.updateUserPreferences({ name: userName })
		}
	}, [editor, userName])

	const store = useSync({
		uri: `${window.location.origin}/connect/${roomId}`,
		assets: multiplayerAssets,
	})

	return (
		<>
			<div style={{ position: 'fixed', inset: 0 }}>
				<Tldraw
					store={store}
					licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
					maxAssetSize={Infinity}
					maxImageDimension={Infinity}
					components={uiComponents}
					overrides={uiOverrides}
					onMount={(e) => {
						setEditor(e)
						e.registerExternalAssetHandler('url', unfurlBookmarkUrl)
					}}
				>
					<MediaFileHandler />
				</Tldraw>
			</div>
			<AgentPanel editor={editor} roomId={roomId} />
		</>
	)
}

// Asset upload/retrieval goes through our server (no size limit server-side).
const multiplayerAssets: TLAssetStore = {
	async upload(_asset, file) {
		const objectName = `${uniqueId()}-${file.name}`
		const url = `/uploads/${encodeURIComponent(objectName)}`
		const response = await fetch(url, { method: 'PUT', body: file })
		if (!response.ok) {
			throw new Error(`Failed to upload asset: ${response.statusText}`)
		}
		return { src: url }
	},
	resolve(asset) {
		return asset.props.src
	},
}

async function unfurlBookmarkUrl({ url }: { url: string }): Promise<TLBookmarkAsset> {
	const asset: TLBookmarkAsset = {
		id: AssetRecordType.createId(getHashForString(url)),
		typeName: 'asset',
		type: 'bookmark',
		meta: {},
		props: { src: url, description: '', image: '', favicon: '', title: '' },
	}
	try {
		const response = await fetch(`/unfurl?url=${encodeURIComponent(url)}`)
		const data = await response.json()
		asset.props.description = data?.description ?? ''
		asset.props.image = data?.image ?? ''
		asset.props.favicon = data?.favicon ?? ''
		asset.props.title = data?.title ?? ''
	} catch (e) {
		console.error(e)
	}
	return asset
}

export default App