import { invoke } from '@tauri-apps/api/core'
import { appCacheDir, join } from '@tauri-apps/api/path'
import { writeBinaryFile, createDir } from '@tauri-apps/api/fs'

export type ExportOptions = {
	fps: number
	resolution: { width: number; height: number }
	aspectRatio: '16:9' | '9:16'
	quality: 'alta' | 'media' | 'baja'
	includeAudio: boolean
	outputPath: string
}

async function renderFrameToPng(canvas: HTMLCanvasElement, width: number, height: number): Promise<Uint8Array> {
	const tmp = document.createElement('canvas')
	tmp.width = width
	tmp.height = height
	const ctx = tmp.getContext('2d')!
	ctx.fillStyle = '#000'
	ctx.fillRect(0, 0, width, height)
	ctx.drawImage(canvas, 0, 0, width, height)
	return await new Promise<Uint8Array>((resolve, reject) => {
		tmp.toBlob((blob) => {
			if (!blob) return reject(new Error('no-blob'))
			const reader = new FileReader()
			reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
			reader.onerror = () => reject(new Error('blob-read'))
			reader.readAsArrayBuffer(blob)
		}, 'image/png')
	})
}

export async function exportVideo(options: ExportOptions & { getCanvas: () => HTMLCanvasElement; durationSec: number }) {
	const { fps, resolution, aspectRatio, quality, includeAudio, outputPath, getCanvas, durationSec } = options

	const framesDirBase = await appCacheDir()
	const framesDir = await join(framesDirBase, 'exportFrames')
	await createDir(framesDir, { recursive: true })

	const totalFrames = Math.max(1, Math.round(durationSec * fps))
	for (let i = 0; i < totalFrames; i++) {
		const canvas = getCanvas()
		// Aquí se asume que el canvas ya refleja el estado (texto/subtítulos/efectos) del tiempo i/fps
		const png = await renderFrameToPng(canvas, resolution.width, resolution.height)
		const name = String(i + 1).padStart(4, '0') + '.png'
		const path = await join(framesDir, name)
		await writeBinaryFile(path, png)
	}

	await invoke('export_video', {
		fps,
		width: resolution.width,
		height: resolution.height,
		aspect: aspectRatio,
		quality,
		includeAudio,
		framesDir,
		outputPath,
		pixFmt: 'yuv420p',
	})
}
