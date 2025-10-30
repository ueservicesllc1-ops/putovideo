import React, { useEffect, useRef, useState } from 'react'
import { ExportModal } from './ExportModal'

export function App() {
	const [openExport, setOpenExport] = useState(false)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const [t, setT] = useState(0)

	// Demo: dibujar algo en el canvas como placeholder del preview
	useEffect(() => {
		const id = setInterval(() => setT((v) => (v + 1) % 300), 33)
		return () => clearInterval(id)
	}, [])
	useEffect(() => {
		const c = canvasRef.current
		if (!c) return
		const ctx = c.getContext('2d')!
		ctx.fillStyle = '#000'
		ctx.fillRect(0, 0, c.width, c.height)
		ctx.fillStyle = '#0f0'
		ctx.font = '24px sans-serif'
		ctx.fillText('Vista previa (demo)', 20, 40)
		ctx.fillText('t=' + t, 20, 70)
	}, [t])

	return (
		<div className="w-screen h-screen bg-black text-white flex flex-col items-center justify-center gap-4">
			<canvas ref={canvasRef} width={640} height={360} className="border border-neutral-700" />
			<div className="flex gap-2">
				<button className="px-3 py-2 bg-neutral-800 border border-neutral-700" onClick={()=>setOpenExport(true)}>Exportar...</button>
			</div>
			<ExportModal
				open={openExport}
				onClose={()=>setOpenExport(false)}
				getCanvas={()=>canvasRef.current!}
				durationSec={10}
			/>
		</div>
	)
}
