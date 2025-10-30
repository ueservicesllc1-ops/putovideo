import React, { useEffect, useMemo, useState } from 'react'
import { save } from '@tauri-apps/api/dialog'
import { listen } from '@tauri-apps/api/event'
import type { ExportOptions } from '../lib/exporter'
import { exportVideo } from '../lib/exporter'

type Props = {
	open: boolean
	onClose: () => void
	getCanvas: () => HTMLCanvasElement
	// Duración total en segundos del proyecto
	durationSec: number
}

const presets = [
	{ name: '720p (1280x720)', w: 1280, h: 720 },
	{ name: '1080p (1920x1080)', w: 1920, h: 1080 },
	{ name: '4K (3840x2160)', w: 3840, h: 2160 },
]

export function ExportModal({ open, onClose, getCanvas, durationSec }: Props) {
	const [presetIdx, setPresetIdx] = useState(1)
	const [aspect, setAspect] = useState<'16:9'|'9:16'>('16:9')
	const [fps, setFps] = useState(30)
	const [quality, setQuality] = useState<'alta'|'media'|'baja'>('alta')
	const [includeAudio, setIncludeAudio] = useState(true)
	const [outputPath, setOutputPath] = useState('')
	const [busy, setBusy] = useState(false)
	const [progressPct, setProgressPct] = useState(0)
	const [logs, setLogs] = useState<string[]>([])

	const resolution = useMemo(() => {
		const p = presets[presetIdx]
		return aspect === '16:9' ? { width: p.w, height: p.h } : { width: p.h, height: p.w }
	}, [presetIdx, aspect])

	useEffect(() => {
		if (!open) return
		let unsubs: Array<() => void> = []
		listen<string>('export:log', (e) => {
			setLogs((prev) => (prev.length > 400 ? prev.slice(-400) : prev).concat(e.payload))
		}).then((un) => unsubs.push(un))
		listen<string>('export:progress', (e) => {
			const m = /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/.exec(e.payload || '')
			if (m) {
				const h = parseInt(m[1], 10)
				const mi = parseInt(m[2], 10)
				const s = parseInt(m[3], 10)
				const ms = parseInt(m[4], 10) * 10
				const t = h * 3600 + mi * 60 + s + ms / 1000
				if (durationSec > 0) setProgressPct(Math.min(100, Math.round((t / durationSec) * 100)))
			}
		}).then((un) => unsubs.push(un))
		return () => { unsubs.forEach((u) => u()) }
	}, [open, durationSec])

	async function pickOutput() {
		const file = await save({
			title: 'Ruta de exportación',
			filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
		})
		if (file) setOutputPath(file as string)
	}

	async function onExport() {
		if (!outputPath) { await pickOutput(); if (!outputPath) return }
		setBusy(true)
		setProgressPct(0)
		setLogs([])
		try {
			const opts: ExportOptions & { getCanvas: () => HTMLCanvasElement; durationSec: number } = {
				fps,
				resolution,
				aspectRatio: aspect,
				quality,
				includeAudio,
				outputPath,
				getCanvas,
				durationSec,
			}
			await exportVideo(opts)
			setProgressPct(100)
		} catch (e: any) {
			setLogs((prev) => prev.concat(String(e?.message || e)))
		} finally {
			setBusy(false)
		}
	}

	if (!open) return null
	return (
		<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
			<div className="bg-neutral-900 border border-neutral-700 w-[560px] p-4 grid gap-3">
				<h2 className="text-white text-lg">Exportar video</h2>
				<div className="grid grid-cols-2 gap-3 text-sm text-neutral-200">
					<label className="grid gap-1">Resolución
						<select className="bg-neutral-800 border border-neutral-700 p-2" value={presetIdx} onChange={(e)=>setPresetIdx(parseInt(e.target.value,10))}>
							{presets.map((p, i)=>(<option key={i} value={i}>{p.name}</option>))}
						</select>
					</label>
					<label className="grid gap-1">Relación
						<select className="bg-neutral-800 border border-neutral-700 p-2" value={aspect} onChange={(e)=>setAspect(e.target.value as any)}>
							<option value="16:9">16:9</option>
							<option value="9:16">9:16</option>
						</select>
					</label>
					<label className="grid gap-1">FPS
						<input className="bg-neutral-800 border border-neutral-700 p-2" type="number" min={15} max={60} value={fps} onChange={(e)=>setFps(parseInt(e.target.value,10)||30)} />
					</label>
					<label className="grid gap-1">Calidad
						<select className="bg-neutral-800 border border-neutral-700 p-2" value={quality} onChange={(e)=>setQuality(e.target.value as any)}>
							<option value="alta">Alta</option>
							<option value="media">Media</option>
							<option value="baja">Baja</option>
						</select>
					</label>
					<label className="flex items-center gap-2 col-span-2"><input type="checkbox" checked={includeAudio} onChange={(e)=>setIncludeAudio(e.target.checked)} /> Incluir audio</label>
					<div className="col-span-2 grid grid-cols-[1fr_auto] gap-2">
						<input className="bg-neutral-800 border border-neutral-700 p-2" placeholder="Ruta de salida .mp4" value={outputPath} onChange={(e)=>setOutputPath(e.target.value)} />
						<button className="px-3 py-2 bg-neutral-800 border border-neutral-700" onClick={pickOutput}>Elegir…</button>
					</div>
				</div>
				<div className="grid gap-2">
					<div className="h-2 bg-neutral-800"><div className="h-2 bg-emerald-500" style={{ width: `${progressPct}%` }} /></div>
					<div className="text-xs text-neutral-400">{progressPct}%</div>
				</div>
				<div className="flex gap-2 justify-end">
					<button className="px-3 py-2 bg-neutral-800 border border-neutral-700" disabled={busy} onClick={onClose}>Cerrar</button>
					<button className="px-3 py-2 bg-emerald-600 text-white" disabled={busy} onClick={onExport}>Exportar</button>
				</div>
				<div className="max-h-32 overflow-auto text-xs text-neutral-400 bg-neutral-950 p-2 border border-neutral-800">
					{logs.slice(-50).map((l,i)=>(<div key={i}>{l}</div>))}
				</div>
			</div>
		</div>
	)
}
