// tldraw sync server + Discord OAuth (guild-restricted) + asset storage.
// Single Node process, no Docker. Persistence: SQLite per room + filesystem assets.
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { mkdirSync, existsSync, createReadStream, statfsSync, unlinkSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs'
import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 5858)
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || ''
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || ''
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || ''
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const ASSETS_DIR = join(DATA_DIR, 'assets')
const PUBLIC_DIR = join(__dirname, 'public')
const SECURE = APP_URL.startsWith('https')

mkdirSync(ROOMS_DIR, { recursive: true })
mkdirSync(ASSETS_DIR, { recursive: true })

// ---- per-user token usage tracking (plain text, for auditing) ----
// usage.log  : one TSV line per model call  (iso, pseudo, room, prompt, completion, cost_usd)
// usage-totals.txt : running per-pseudo totals (recomputed from the log)
const USAGE_LOG = join(DATA_DIR, 'usage.log')
const USAGE_TOTALS = join(DATA_DIR, 'usage-totals.txt')
// DeepSeek pricing (USD / 1M tokens) — estimate only.
const PRICE_IN = 0.22
const PRICE_CACHED = 0.007
const PRICE_OUT = 0.66

function recordUsage(userName, room, usage) {
	if (!usage) return
	try {
		const p = Number(usage.prompt_tokens) || 0
		const c = Number(usage.completion_tokens) || 0
		const hit = Number(usage.prompt_cache_hit_tokens) || 0
		const cost = ((p - hit) * PRICE_IN + hit * PRICE_CACHED + c * PRICE_OUT) / 1e6
		const ts = new Date().toISOString()
		const pseudo = String(userName || 'Anonyme').replace(/[\t\n\r]/g, ' ')
		appendFileSync(USAGE_LOG, `${ts}\t${pseudo}\t${room}\t${p}\t${c}\t${cost.toFixed(6)}\n`)
		// Recompute per-user totals from the log (self-healing, file stays small).
		const totals = new Map()
		for (const line of readFileSync(USAGE_LOG, 'utf8').split('\n')) {
			if (!line) continue
			const f = line.split('\t')
			if (f.length < 6) continue
			const t = totals.get(f[1]) || { tokens: 0, cost: 0, last: '' }
			t.tokens += (Number(f[3]) || 0) + (Number(f[4]) || 0)
			t.cost += Number(f[5]) || 0
			t.last = f[0]
			totals.set(f[1], t)
		}
		let out = '# pseudo\ttokens\tcout_usd\tderniere_activite\n'
		for (const [who, t] of [...totals.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
			out += `${who}\t${t.tokens}\t${t.cost.toFixed(4)}\t${t.last}\n`
		}
		writeFileSync(USAGE_TOTALS, out)
	} catch (e) {
		console.warn('[usage] ' + e.message)
	}
}

// ---------------- session (HMAC-signed cookie) ----------------
function sign(v) {
	return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url')
}
function makeSession(payload) {
	const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${data}.${sign(data)}`
}
function parseCookies(header) {
	const out = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i === -1) continue
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
	}
	return out
}
function readSession(header) {
	const raw = parseCookies(header)['wb_session']
	if (!raw) return null
	const [data, sig] = raw.split('.')
	if (!data || !sig || sign(data) !== sig) return null
	try {
		const p = JSON.parse(Buffer.from(data, 'base64url').toString())
		if (p.exp && Date.now() > p.exp) return null
		return p
	} catch {
		return null
	}
}
function cookie(name, value, maxAge) {
	return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`
}

// ---------------- disk-space guard ----------------
// If the root filesystem has less than DISK_WARN_MB free, HTML navigations get a
// 2-second warning page, then are redirected to the app (bypassed via a cookie so
// we don't loop).
const DISK_WARN_MB = Number(process.env.DISK_WARN_MB || 100)
let diskCache = { mb: Infinity, at: 0 }
let lastDiskWarn = 0

function freeDiskMb() {
	const now = Date.now()
	if (now - diskCache.at < 10000) return diskCache.mb
	try {
		const st = statfsSync('/')
		const mb = (st.bavail * Number(st.bsize)) / (1024 * 1024)
		diskCache = { mb, at: now }
		return mb
	} catch {
		return Infinity
	}
}

function diskWarnPage() {
	return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Espace disque faible</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#111;color:#eee;font-family:system-ui,-apple-system,sans-serif}
.box{max-width:520px;padding:32px;border:1px solid #444;border-radius:16px;text-align:center}
h1{font-size:20px;margin:0 0 12px}
p{margin:8px 0;color:#bbb;line-height:1.5}
b{color:#ff5252}
</style></head>
<body><div class="box">
<h1>&#9888;&#65039; Espace disque faible</h1>
<p>Il reste moins de <b>${DISK_WARN_MB} Mo</b> libres sur le serveur.</p>
<p>Les imports d'images risquent d'&eacute;chouer.</p>
<p>Redirection vers le tableau dans <b id="c">2</b>s&hellip;</p>
</div>
<script>
document.cookie = 'diskwarn=1; path=/; max-age=300';
var n = 2, el = document.getElementById('c');
var t = setInterval(function () {
	n--;
	if (el) el.textContent = n;
	if (n <= 0) { clearInterval(t); location.replace(location.pathname + location.search); }
}, 1000);
</script>
</body></html>`
}

// ---------------- rooms (SQLite persistence) ----------------
const rooms = new Map() // roomId -> { room, db }
function makeOrLoadRoom(roomId) {
	roomId = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_')
	const existing = rooms.get(roomId)
	if (existing && !existing.room.isClosed()) return existing.room
	const db = new Database(join(ROOMS_DIR, `${roomId}.db`))
	const sql = new NodeSqliteWrapper(db)
	const storage = new SQLiteSyncStorage({ sql })
	const room = new TLSocketRoom({
		storage,
		onSessionRemoved(room, args) {
			if (args.numSessionsRemaining === 0) {
				room.close()
				try {
					db.close()
				} catch {}
				rooms.delete(roomId)
			}
		},
	})
	rooms.set(roomId, { room, db })
	return room
}

// ---------------- agent (read-only vision assistant, per-room history) ----------------
const agentDb = new Database(join(DATA_DIR, 'agent.db'))
agentDb.exec(`
	CREATE TABLE IF NOT EXISTS agent_messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id TEXT NOT NULL,
		role TEXT NOT NULL,
		content TEXT NOT NULL,
		created_at TEXT DEFAULT (datetime('now'))
	);
	CREATE INDEX IF NOT EXISTS idx_agent_room ON agent_messages(room_id, id);
`)

const AGENT_PROVIDER = process.env.AGENT_PROVIDER || 'openai'
const AGENT_API_KEY = process.env.AGENT_API_KEY || ''
const AGENT_MODEL = process.env.AGENT_MODEL || ''
const AGENT_SYSTEM_PROMPT =
	process.env.AGENT_SYSTEM_PROMPT ||
	"Tu regardes un tableau blanc collaboratif. On te fournit une PREMIERE image qui est une vue d'ensemble de ce que les utilisateurs voient, suivie de PLUSIEURS tuiles (des zooms de cette meme vue), dans l'ordre de gauche a droite puis de haut en bas, pour que tu puisses lire les details. Sers-toi de la vue d'ensemble pour comprendre la disposition (ce qui est a cote de quoi) et des tuiles pour lire l'ecriture. Lis attentivement TOUT ce qui est ecrit, y compris l'ecriture manuscrite au stylet, et reponds a la demande. L'utilisateur travaille en ecrivant ou dessinant sur le tableau, et tu recois une capture de l'ecran : ne lui demande jamais de t'ENVOYER quelque chose. Formule plutot tes demandes en termes d'ecriture sur le tableau (ex. 'ecris la ligne suivante', 'montre-moi en ecrivant...', 'note ton resultat sur le tableau'). Pour des equations, verifie-les pas a pas et signale les erreurs precises. Ton role est d'aider l'utilisateur a progresser, pas de faire le travail a sa place : par defaut, ne donne PAS directement la reponse. Fournis plutot des indices et explique les concepts qui sont peut-etre mal compris ou lies a l'etape ou l'utilisateur est bloque, pour l'aider a trouver par lui-meme. Tu peux donner la solution complete ou faire le calcul a sa place UNIQUEMENT si l'utilisateur le demande explicitement. Avant de conclure a une erreur, verifie que ce n'est pas simplement un symbole ou un signe peu lisible (ex. un '<' lu a la place d'un '=', un '1' pris pour un 'l', un '7' pour un '1', un '0' pour un 'O', un '+' pour un 't'). Si, et seulement si, une alternative VISUELLEMENT TRES PROCHE (facilement confondable) rend l'equation coherente, emets l'hypothese du symbole reellement ecrit et poursuis le calcul avec cette hypothese. Ne remplace jamais une valeur ou un nombre par un autre sans lien visuel (ex. supposer '59' au lieu de '32') dans le seul but de rendre l'equation coherente : dans ce cas, signale l'erreur telle quelle. Ecris les mathematiques en LaTeX : $...$ pour un symbole isole, et $$...$$ (bloc, sur sa propre ligne) pour toute equation complete (fraction, racine, integrale, somme), afin qu'elle soit bien lisible. Pour la multiplication, ecris le point median \\cdot (ex. $2 \\cdot 3$) plutot que \\times ou *. Attention : l'utilisateur ecrit lui aussi la multiplication avec un point (median '·', ou un simple point). Un point place entre deux nombres ou deux termes doit donc etre lu comme une MULTIPLICATION, et non comme un separateur decimal (en notation francaise la decimale s'ecrit avec une virgule). En cas de doute, interprete le point comme une multiplication."

const AGENT_MEMO_PROMPT =
	" Enfin, a chaque fois que tu recois des images, transcris dans ta reponse l'essentiel de ce que tu as lu et verifie, de facon concise et autosuffisante : equations, resultats et verdicts (par ex. 'demonstration que x = y : calculs corrects'). N'y recopie PAS les details non essentiels (mise en page, dessins decoratifs, texte sans rapport). Ce resume texte te sert de MEMOIRE pour les messages suivants, ou les zones deja vues ne sont PAS renvoyees en image : fie-toi a ce que tu as deja verifie (tu l'as deja controle), ne contredis pas ce constat et ne redemande pas de capture des zones inchangees."

const AGENT_UI_PROMPT =
	" Interface : le bouton BLEU (fleche) n'envoie QUE le texte. Le bouton VIOLET (icone 'capture d'ecran') envoie, en plus du texte, une capture de la vue ACTUELLE du tableau, decoupee en plusieurs tuiles haute definition (chaque zone est vue en pleine resolution). Si l'utilisateur te demande de verifier des calculs, de lire ce qu'il a ecrit ou de corriger quelque chose, et que tu n'as recu AUCUNE image pour ce message : ne devine pas et n'invente pas le contenu. Dis-lui d'appuyer sur le bouton VIOLET (icone capture d'ecran) pour t'envoyer sa vue. Tu peux aussi lui expliquer que ce bouton violet envoie la vue actuelle de son ecran au modele, en pleine resolution."

const AGENT_UI_PROMPT_V2 =
	" Outil : tu disposes de l'outil 'request_view' pour demander a l'utilisateur une capture de sa vue du tableau. mode='overview' = SEULEMENT la vue d'ensemble, limitee a l'ecran (suffisant pour comprendre la disposition). mode='tiles' = la vue d'ensemble PLUS des tuiles haute definition (indispensable pour LIRE l'ecriture fine, verifier des calculs ou des equations, corriger). Appelle cet outil des que tu as besoin de VOIR le tableau pour accomplir la demande de l'utilisateur. N'invente JAMAIS le contenu du tableau : si tu as besoin de le voir, appelle request_view. L'utilisateur n'a qu'un seul bouton d'envoi : c'est TOI qui decides quand demander la vue, et le systeme te l'envoie automatiquement."

const AGENT_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'request_view',
			description:
				"Demande une capture de la vue actuelle du tableau de l'utilisateur. mode='overview' = vue d'ensemble seule (limitee a l'ecran) ; mode='tiles' = vue d'ensemble + tuiles haute definition (pour lire l'ecriture fine / verifier des calculs).",
			parameters: {
				type: 'object',
				properties: {
					mode: {
						type: 'string',
						enum: ['overview', 'tiles'],
						description: 'overview = vue globale seule ; tiles = vue globale + tuiles HD',
					},
					reason: { type: 'string', description: 'Pourquoi tu as besoin de cette vue.' },
				},
				required: ['mode'],
			},
		},
	},
]

const AGENT_SYSTEM_PROMPT_FULL =
	(AGENT_SYSTEM_PROMPT || '') + AGENT_MEMO_PROMPT + AGENT_UI_PROMPT_V2

// OpenAI-compatible chat call that (optionally) exposes tools. Returns the assistant
// message pieces we need: text, tool_calls, and reasoning_content (thinking models
// require reasoning_content to be replayed on the assistant tool-call message).
async function callChat(messages, tools) {
	if (!AGENT_API_KEY) throw new Error('Cle API IA non configuree (AGENT_API_KEY)')
	const isDeepseek = AGENT_PROVIDER === 'deepseek'
	const baseUrl = isDeepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'
	const model = AGENT_MODEL || (isDeepseek ? 'deepseek-flash' : 'gpt-4o')
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${AGENT_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({ model, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
	})
	if (!res.ok) throw new Error(`${AGENT_PROVIDER} ${res.status}: ${(await res.text()).slice(0, 300)}`)
	const data = await res.json()
	const msg = (data.choices && data.choices[0] && data.choices[0].message) || {}
	return {
		content: (msg.content || '').trim(),
		toolCalls: msg.tool_calls || [],
		reasoningContent: msg.reasoning_content || '',
		usage: data.usage || null,
	}
}

// Text manifest describing where things are, so the agent can map content to board
// coordinates and know which visible chunks were NOT attached (unchanged/empty).
function buildManifest(view, tiles, chunks) {
	if (!view || typeof view.x !== 'number') return ''
	const r = (n) => Math.round(Number(n) || 0)
	const lines = []
	lines.push('[Vue actuelle du tableau, en coordonnees du tableau (unites tldraw).]')
	lines.push(
		`Region visible : x de ${r(view.x)} a ${r(view.x + view.w)}, y de ${r(view.y)} a ${r(view.y + view.h)}.`
	)
	if (Array.isArray(tiles) && tiles.length) {
		lines.push("Images jointes a ce message (dans l'ordre) :")
		tiles.forEach((t, i) => {
			if (t.kind === 'overview') {
				lines.push(
					`${i + 1}. Vue d'ensemble de toute la region visible (x ${r(t.x)}..${r(t.x + t.w)}, y ${r(
						t.y
					)}..${r(t.y + t.h)}).`
				)
			} else {
				lines.push(`${i + 1}. Tuile x ${r(t.x)}..${r(t.x + t.w)}, y ${r(t.y)}..${r(t.y + t.h)}.`)
			}
		})
	} else {
		lines.push(
			"Aucune image jointe a ce message (rien n'a change dans la vue visible, ou message texte seul)."
		)
	}
	if (Array.isArray(chunks)) {
		const notSent = chunks.filter((c) => c && c.status && c.status !== 'sent')
		if (notSent.length) {
			lines.push('Tuiles de la region visible NON jointes a ce message :')
			for (const c of notSent) {
				const where =
					c.kind === 'overview'
						? "vue d'ensemble"
						: `tuile x ${r(c.x)}..${r(c.x + c.w)}, y ${r(c.y)}..${r(c.y + c.h)}`
				const why =
					c.status === 'empty'
						? 'vide (aucun contenu)'
						: c.status === 'not-attached'
							? 'non jointe (ce message est parti sans capture : appuie sur le bouton violet pour la recevoir)'
							: "inchangee depuis ton dernier envoi (deja vue : fie-toi a ton resume)"
				lines.push(`- ${where} : ${why}.`)
			}
		}
	}
	return lines.join('\n') + '\n\n'
}

async function askVisionModel(prompt, imageDataUrls = [], history = [], manifest = '') {
	if (!AGENT_API_KEY) throw new Error('Cle API IA non configuree (AGENT_API_KEY)')
	const past = Array.isArray(history)
		? history
				.filter((m) => m && m.content)
				.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))
		: []
	// Accept a single data URL or an array of them (the client sends several "tiles"
	// of what the user sees, so each tile gets its own ~800x800 vision budget).
	const images = (Array.isArray(imageDataUrls) ? imageDataUrls : [imageDataUrls]).filter(
		(u) => typeof u === 'string' && u.startsWith('data:')
	)
	const parsed = images
		.map((u) => {
			const m = /^data:(.+?);base64,(.*)$/.exec(u)
			return m ? { mime: m[1], b64: m[2] } : null
		})
		.filter(Boolean)

	if (AGENT_PROVIDER === 'anthropic') {
		const model = AGENT_MODEL || 'claude-sonnet-4-5'
		const content = []
		for (const p of parsed) content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 } })
		content.push({ type: 'text', text: (manifest || '') + prompt })
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': AGENT_API_KEY,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model,
				max_tokens: 8192,
				system: AGENT_SYSTEM_PROMPT_FULL,
				messages: [...past, { role: 'user', content }],
			}),
		})
		if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
		const data = await res.json()
		return (data.content || []).map((c) => c.text).filter(Boolean).join('\n')
	}

	if (AGENT_PROVIDER === 'google') {
		const model = AGENT_MODEL || 'gemini-2.0-flash'
		const parts = []
		for (const p of parsed) parts.push({ inline_data: { mime_type: p.mime, data: p.b64 } })
		parts.push({ text: (manifest || '') + prompt })
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AGENT_API_KEY}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					system_instruction: { parts: [{ text: AGENT_SYSTEM_PROMPT_FULL }] },
					contents: [
						...past.map((m) => ({
							role: m.role === 'assistant' ? 'model' : 'user',
							parts: [{ text: m.content }],
						})),
						{ role: 'user', parts },
					],
				}),
			}
		)
		if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 300)}`)
		const data = await res.json()
		return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n')
	}

	// openai-compatible (OpenAI + DeepSeek)
	const isDeepseek = AGENT_PROVIDER === 'deepseek'
	const baseUrl = isDeepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'
	const model = AGENT_MODEL || (isDeepseek ? 'deepseek-flash' : 'gpt-4o')
	const userContent = [
		...images.map((url) => ({ type: 'image_url', image_url: { url } })),
		{ type: 'text', text: (manifest || '') + prompt },
	]
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${AGENT_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			// no max_tokens: let the model use its full output budget (reasoning + answer)
			model,
			messages: [
				{ role: 'system', content: AGENT_SYSTEM_PROMPT_FULL },
				...past,
				{ role: 'user', content: userContent },
			],
		}),
	})
	if (!res.ok) throw new Error(`${AGENT_PROVIDER} ${res.status}: ${(await res.text()).slice(0, 300)}`)
	const data = await res.json()
	const choice = data.choices?.[0]
	const msg = choice?.message || {}
	const content = (msg.content || '').trim()
	if (!content) {
		console.warn(
			`[agent] empty content — finish_reason=${choice?.finish_reason} reasoning_len=${
				(msg.reasoning_content || '').length
			} usage=${JSON.stringify(data.usage)}`
		)
	}
	return content
}

// ---------------- app ----------------
// bodyLimit only applies to parsed bodies (JSON); uploads use a raw stream parser
// with no size limit. 1 GiB is effectively unlimited for the small JSON payloads.
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 1024 })
await app.register(websocketPlugin)
// Serve the built client. @fastify/static's default wildcard route handles any
// path under '/' and falls through to the notFound handler (SPA) when missing.
await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' })

// Disk-space guard: only intercept HTML document navigations (not assets, API or WS).
app.addHook('onRequest', async (req, reply) => {
	if (req.method !== 'GET') return
	if (!String(req.headers['accept'] || '').includes('text/html')) return
	const dest = req.headers['sec-fetch-dest']
	if (dest && dest !== 'document') return
	if (parseCookies(req.headers.cookie)['diskwarn'] === '1') return
	const mb = freeDiskMb()
	if (mb >= DISK_WARN_MB) return
	const now = Date.now()
	if (now - lastDiskWarn > 5 * 60 * 1000) {
		lastDiskWarn = now
		console.warn(`[disk] low space: ${mb.toFixed(0)} MB free (< ${DISK_WARN_MB} MB)`)
	}
	return reply.type('text/html').send(diskWarnPage())
})

app.get('/health', async () => ({ ok: true }))
app.get('/api/status', async () => ({
	diskFreeMb: Math.round(freeDiskMb()),
	diskWarnThresholdMb: DISK_WARN_MB,
}))

app.get('/auth/login', async (req, reply) => {
	const state = crypto.randomBytes(16).toString('base64url')
	const params = new URLSearchParams({
		client_id: DISCORD_CLIENT_ID,
		redirect_uri: `${APP_URL}/auth/callback`,
		response_type: 'code',
		scope: 'identify guilds.members.read',
		state,
	})
	reply.header('Set-Cookie', cookie('wb_state', state, 600))
	return reply.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`)
})

app.get('/auth/callback', async (req, reply) => {
	const { code, state } = req.query
	const cookies = parseCookies(req.headers.cookie)
	if (!code) {
		return reply.code(400).type('text/plain').send('Code manquant. Reessaie le login.')
	}
	// CSRF: if a state cookie was stored, it must match. If it is absent (direct
	// authorize link, or a browser/extension blocking the cross-site cookie), we
	// still proceed — the code is exchanged with our client secret, which is the
	// real security check.
	if (cookies['wb_state'] && state !== cookies['wb_state']) {
		return reply.code(400).type('text/plain').send('State invalide. Reessaie.')
	}
	const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: DISCORD_CLIENT_ID,
			client_secret: DISCORD_CLIENT_SECRET,
			grant_type: 'authorization_code',
			code: String(code),
			redirect_uri: `${APP_URL}/auth/callback`,
		}),
	})
	if (!tokenRes.ok) {
		return reply.code(401).type('text/plain').send('Echec echange token Discord.')
	}
	const token = await tokenRes.json()
	const auth = { Authorization: `Bearer ${token.access_token}` }
	// /users/@me/guilds/{guild}/member returns the current user's member object
	// (incl. the per-server nickname `nick`). 404 => not a member of the guild.
	const [userRes, memberRes] = await Promise.all([
		fetch('https://discord.com/api/users/@me', { headers: auth }),
		fetch(`https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`, {
			headers: auth,
		}),
	])
	if (!memberRes.ok) {
		return reply
			.code(403)
			.type('text/html')
			.send(
				'<meta charset="utf-8"><h1>403 — Acces refuse</h1><p>Tu n\'es pas membre du serveur Discord requis.</p>'
			)
	}
	const user = await userRes.json()
	const member = await memberRes.json()
	// Prefer the server nickname, then the global display name, then the username.
	const name = member.nick || user.global_name || user.username || 'Anonyme'
	const session = makeSession({ id: user.id, name, exp: Date.now() + 30 * 24 * 3600 * 1000 })
	reply.header('Set-Cookie', cookie('wb_session', session, 30 * 24 * 3600))
	return reply.redirect('/')
})

app.get('/auth/logout', async (req, reply) => {
	reply.header('Set-Cookie', cookie('wb_session', '', 0))
	return reply.redirect('/')
})

// nginx auth_request target
app.get('/auth/verify', async (req, reply) => {
	const session = readSession(req.headers.cookie)
	if (!session) return reply.code(401).send('Unauthorized')
	reply.header('X-Auth-User', encodeURIComponent(session.name))
	return reply.code(200).send('OK')
})

// username for the client (from nginx X-Forwarded-User, or session)
app.get('/api/me', async (req, reply) => {
	let name = req.headers['x-forwarded-user']
	if (name) {
		try {
			name = decodeURIComponent(String(name))
		} catch {}
	} else {
		name = readSession(req.headers.cookie)?.name
	}
	if (!name) return reply.code(401).send({ error: 'unauthorized' })
	return { name }
})

// ---------------- agent endpoints (history bound to the room, not the user) ----------------
const sanitizeRoom = (r) => String(r || '').replace(/[^a-zA-Z0-9_-]/g, '_')

app.get('/api/agent/history', async (req) => {
	const room = sanitizeRoom(req.query.room)
	const messages = agentDb
		.prepare('SELECT id, role, content, created_at FROM agent_messages WHERE room_id=? ORDER BY id')
		.all(room)
	return {
		messages,
		provider: AGENT_PROVIDER,
		model: AGENT_MODEL || null,
		configured: Boolean(AGENT_API_KEY),
	}
})

app.post('/api/agent/ask', async (req, reply) => {
	const body = req.body || {}
	const room = sanitizeRoom(body.room)
	const prompt = String(body.prompt || '').trim().slice(0, 4000)
	const toolResult = body.toolResult && typeof body.toolResult === 'object' ? body.toolResult : null
	if (!room) return reply.code(400).send({ error: 'room requis' })
	if (!prompt && !toolResult) return reply.code(400).send({ error: 'prompt requis' })

	const insert = agentDb.prepare('INSERT INTO agent_messages(room_id, role, content) VALUES(?,?,?)')
	const history = agentDb
		.prepare('SELECT role, content FROM agent_messages WHERE room_id=? ORDER BY id DESC LIMIT 24')
		.all(room)
		.reverse()

	const isOpenAICompatible = AGENT_PROVIDER !== 'anthropic' && AGENT_PROVIDER !== 'google'

	// ---- legacy single-shot path for non OpenAI-compatible providers ----
	if (!isOpenAICompatible) {
		insert.run(room, 'user', prompt)
		try {
			const images = Array.isArray(body.images) ? body.images : body.image ? [body.image] : []
			const manifest = buildManifest(body.view, body.tiles, body.chunks)
			const answer = await askVisionModel(prompt, images, history, manifest)
			insert.run(room, 'assistant', answer || '(reponse vide)')
			return { answer: answer || '(reponse vide)' }
		} catch (e) {
			const msg = `⚠️ ${e.message}`
			insert.run(room, 'assistant', msg)
			return reply.code(200).send({ answer: msg, error: true })
		}
	}

	// ---- OpenAI-compatible path: tool-driven, the model decides when to see ----
	const messages = [
		{ role: 'system', content: AGENT_SYSTEM_PROMPT_FULL },
		...history.map((m) => ({ role: m.role, content: m.content })),
	]

	if (toolResult) {
		// Replay the assistant tool-call turn (with reasoning_content, required by
		// thinking models) then deliver the screenshot as a user message.
		const tc = toolResult.toolCall || {}
		const callId = String(tc.id || 'call_1')
		messages.push({
			role: 'assistant',
			content: '',
			...(tc.reasoningContent ? { reasoning_content: String(tc.reasoningContent) } : {}),
			tool_calls: [
				{
					id: callId,
					type: 'function',
					function: { name: 'request_view', arguments: String(tc.arguments || '{"mode":"tiles"}') },
				},
			],
		})
		messages.push({ role: 'tool', tool_call_id: callId, content: 'Vue jointe dans le message suivant.' })
		const images = Array.isArray(toolResult.images) ? toolResult.images : []
		const manifest = buildManifest(toolResult.view, toolResult.tiles, toolResult.chunks)
		messages.push({
			role: 'user',
			content: [
				...images.map((url) => ({ type: 'image_url', image_url: { url } })),
				{ type: 'text', text: (manifest || '') + '(Voici la vue que tu as demandee.)' },
			],
		})
	} else {
		insert.run(room, 'user', prompt)
		messages.push({ role: 'user', content: prompt })
	}

	try {
		const { content, toolCalls, reasoningContent, usage } = await callChat(messages, AGENT_TOOLS)
		recordUsage((readSession(req.headers.cookie) || {}).name, room, usage)
		if (toolCalls && toolCalls.length) {
			const tc = toolCalls[0]
			return {
				toolCall: {
					id: tc.id,
					name: (tc.function && tc.function.name) || 'request_view',
					arguments: (tc.function && tc.function.arguments) || '{}',
					reasoningContent: reasoningContent || '',
				},
				usage: usage || null,
			}
		}
		const answer = content || '(reponse vide)'
		insert.run(room, 'assistant', answer)
		return { answer, usage: usage || null }
	} catch (e) {
		const msg = `⚠️ ${e.message}`
		insert.run(room, 'assistant', msg)
		return reply.code(200).send({ answer: msg, error: true })
	}
})

app.post('/api/agent/clear', async (req) => {
	const room = sanitizeRoom((req.body && req.body.room) || '')
	agentDb.prepare('DELETE FROM agent_messages WHERE room_id=?').run(room)
	return { ok: true }
})

// List the boards (rooms) that exist on disk, for the navigation menu.
app.get('/api/rooms', async () => {
	let rooms = []
	try {
		rooms = readdirSync(ROOMS_DIR)
			.filter((f) => f.endsWith('.db'))
			.map((f) => f.replace(/\.db$/, ''))
			.filter((r) => !r.startsWith('.'))
			.sort((a, b) => a.localeCompare(b))
	} catch {}
	return { rooms }
})

// Wipe a whole board: close the live room (disconnects clients so it reloads empty),
// delete the persisted document, and clear the AI conversation bound to it.
app.post('/api/room/reset', async (req, reply) => {
	const room = sanitizeRoom((req.body && req.body.room) || '')
	if (!room) return reply.code(400).send({ error: 'room requis' })
	const live = rooms.get(room)
	if (live) {
		try {
			live.room.close()
		} catch {}
		try {
			live.db.close()
		} catch {}
		rooms.delete(room)
	}
	for (const suffix of ['', '-journal', '-wal', '-shm']) {
		try {
			unlinkSync(join(ROOMS_DIR, `${room}.db${suffix}`))
		} catch {}
	}
	agentDb.prepare('DELETE FROM agent_messages WHERE room_id=?').run(room)
	return { ok: true }
})

// ---------------- tldraw sync websocket ----------------
await app.register(async (instance) => {
	instance.get('/connect/:roomId', { websocket: true }, (socket, req) => {
		const roomId = req.params.roomId
		const sessionId = req.query.sessionId
		const caught = []
		const collect = (m) => caught.push(m)
		socket.on('message', collect)
		const room = makeOrLoadRoom(roomId)
		room.handleSocketConnect({ sessionId, socket })
		socket.off('message', collect)
		for (const m of caught) socket.emit('message', m)
	})
})

// ---------------- assets (no size limit) ----------------
app.addContentTypeParser('*', (req, payload, done) => done(null))
app.put('/uploads/:id', async (req, reply) => {
	const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '_')
	await mkdir(ASSETS_DIR, { recursive: true })
	await writeFile(join(ASSETS_DIR, id), req.raw)
	return { ok: true }
})
app.get('/uploads/:id', async (req, reply) => {
	const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '_')
	const p = join(ASSETS_DIR, id)
	if (!existsSync(p)) return reply.code(404).send('Not found')
	reply.header('Content-Security-Policy', "default-src 'none'")
	reply.header('X-Content-Type-Options', 'nosniff')
	return reply.send(createReadStream(p))
})

// ---------------- SPA fallback ----------------
app.setNotFoundHandler((req, reply) => {
	const url = req.raw.url || ''
	if (
		url.startsWith('/connect') ||
		url.startsWith('/uploads') ||
		url.startsWith('/auth') ||
		url.startsWith('/api') ||
		url.startsWith('/health')
	) {
		return reply.code(404).send('Not found')
	}
	return reply.sendFile('index.html')
})

app.listen({ port: PORT, host: '127.0.0.1' }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
	console.log(`[tldraw] listening on 127.0.0.1:${PORT}`)
})