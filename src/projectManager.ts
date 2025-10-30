import { save as saveDialog, open as openDialog } from '@tauri-apps/api/dialog'
import { readTextFile, writeTextFile, createDir, readDir, removeFile, BaseDirectory } from '@tauri-apps/api/fs'
import { appDataDir, documentDir, join } from '@tauri-apps/api/path'

export type Segment = {
	id: number
	start: number
	end: number
	text: string
}

export type Project = {
	id: string
	name: string
	createdAt: string
	language?: string
	target?: string
	quality?: string
	maxWords?: number | string
	style?: Record<string, unknown>
	box?: Record<string, unknown>
	segments: Segment[]
}

const APP_FOLDER = 'PutoEditor'

async function ensureBaseDir(): Promise<string> {
	const docs = await documentDir()
	const base = await join(docs, APP_FOLDER)
	try {
		await createDir(base, { recursive: true })
	} catch {}
	return base
}

export async function defaultProjectPath(name: string): Promise<string> {
	const base = await ensureBaseDir()
	const safe = (name || 'Proyecto').replace(/[^a-z0-9-_]+/gi, '_')
	return join(base, `${safe}.json`)
}

export async function saveProject(project: Project, filePath?: string): Promise<string> {
	let target = filePath
	if (!target) {
		const suggested = await defaultProjectPath(project.name || 'Proyecto')
		target = (await saveDialog({
			title: 'Guardar proyecto',
			filters: [{ name: 'Proyecto JSON', extensions: ['json'] }],
			defaultPath: suggested,
		})) as string | null
		if (!target) throw new Error('Guardado cancelado')
	}
	const data = JSON.stringify(project, null, 2)
	await writeTextFile(target, data)
	return target
}

export async function openProject(filePath?: string): Promise<Project> {
	let target = filePath
	if (!target) {
		const picked = await openDialog({
			title: 'Abrir proyecto',
			multiple: false,
			filters: [{ name: 'Proyecto JSON', extensions: ['json'] }],
		})
		if (!picked) throw new Error('Apertura cancelada')
		target = picked as string
	}
	const content = await readTextFile(target)
	return JSON.parse(content) as Project
}

export async function listProjects(): Promise<{ path: string; meta?: Project }[]> {
	const base = await ensureBaseDir()
	const entries = await readDir(base)
	const results: { path: string; meta?: Project }[] = []
	for (const e of entries) {
		if (!e.path?.toLowerCase().endsWith('.json')) continue
		try {
			const content = await readTextFile(e.path)
			const meta = JSON.parse(content) as Project
			results.push({ path: e.path, meta })
		} catch {
			results.push({ path: e.path })
		}
	}
	// Orden más recientes primero si hay createdAt
	results.sort((a, b) => (b.meta?.createdAt || '').localeCompare(a.meta?.createdAt || ''))
	return results
}

export async function deleteProject(path: string): Promise<void> {
	await removeFile(path)
}
