const apiBase = "http://127.0.0.1:8000";
let projectsApiDownUntil = 0;

const $video = document.getElementById("video");
const $file = document.getElementById("videoFile");
const $size = document.getElementById("size");
const $aspect = document.getElementById("aspect");
const $fillMode = document.getElementById("fillMode");
const $quality = document.getElementById("quality");
const $language = document.getElementById("language");
const $targetLang = document.getElementById("targetLang");
const $maxWords = document.getElementById("maxWords");
const $btnTranscribe = document.getElementById("btnTranscribe");
const $btnExportSRT = document.getElementById("btnExportSRT");
const $status = document.getElementById("status");
const $segmentsBody = document.getElementById("segmentsBody");
const $previewBox = document.getElementById("previewBox");
const $progress = document.getElementById("progress");
const $progressText = document.getElementById("progressText");
const $subtitleOverlay = document.getElementById("subtitleOverlay");
const $subtitleBox = document.getElementById("subtitleBox");
const $subtitleText = document.getElementById("subtitleText");
const $savedList = document.getElementById("savedList");
const $menuFile = document.getElementById("menuFile");
const $importProjectFile = document.getElementById("importProjectFile");
const $fileDropdown = document.getElementById("fileDropdown");
const $saveModal = document.getElementById("saveModal");
const $saveName = document.getElementById("saveName");
const $saveDirectory = document.getElementById("saveDirectory");
const $saveCancel = document.getElementById("saveCancel");
const $saveConfirm = document.getElementById("saveConfirm");
const $chooseFolder = document.getElementById("chooseFolder");
let chosenDirHandle = null;
let lastFileHandle = null; // Para sobrescribir con "Guardar"
// Controles de estilo Karaoke
const $styleFont = document.getElementById("styleFont");
const $styleSize = document.getElementById("styleSize");
const $styleDoneColor = document.getElementById("styleDoneColor");
const $styleRestColor = document.getElementById("styleRestColor");
const $styleBgColor = document.getElementById("styleBgColor");
const $styleBgOpacity = document.getElementById("styleBgOpacity");
const $styleBorder = document.getElementById("styleBorder");
const $styleBorderColor = document.getElementById("styleBorderColor");
const $styleBorderWidth = document.getElementById("styleBorderWidth");
const $styleShadow = document.getElementById("styleShadow");

let segments = [];
let rafId = null;
let karaokeStyle = null;

$file.addEventListener("change", () => {
	const f = $file.files?.[0];
	if (!f) return;
	const url = URL.createObjectURL(f);
	$video.src = url;
	$status.textContent = "";
	segments = [];
	renderSegments();
	renderKaraokeOverlay(0);
    applyKaraokeStyles();
});

$size.addEventListener("change", () => {
	$previewBox.classList.remove("size-s", "size-m", "size-l");
	const v = $size.value;
	if (v === "s" || v === "m" || v === "l") {
		$previewBox.classList.add(`size-${v}`);
	}
});

// Selector de relación de aspecto (sin bordes negros en 16:9 o 9:16)
$aspect?.addEventListener("change", () => {
    $previewBox.classList.remove("ratio-16-9", "ratio-9-16");
    if ($aspect.value === "16-9") {
        $previewBox.classList.add("ratio-16-9");
    } else if ($aspect.value === "9-16") {
        $previewBox.classList.add("ratio-9-16");
    }
});

$fillMode.addEventListener("change", () => {
	$previewBox.classList.toggle("cover", $fillMode.checked);
});

// Estado inicial: pequeño
$previewBox.classList.add("size-s");

// Menú File
$menuFile?.addEventListener("click", (e) => {
    e.preventDefault();
    $fileDropdown?.classList.toggle("open");
});

document.addEventListener("click", (e) => {
    if (!$fileDropdown) return;
    if (!e.target.closest?.('.fileMenu')) {
        $fileDropdown.classList.remove('open');
    }
});

$fileDropdown?.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-file-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-file-act');
    $fileDropdown.classList.remove('open');
    if (act === 'new') newProject();
    if (act === 'save') saveProject();
    if (act === 'saveas') openSaveModal(true);
    if (act === 'open') openProject();
    if (act === 'exportimg') exportPreviewImage();
});

$importProjectFile?.addEventListener("change", async () => {
    const f = $importProjectFile.files?.[0];
    if (!f) return;
    try {
        const txt = await f.text();
        const proj = JSON.parse(txt);
        loadProject(proj);
        // No guardar automáticamente
    } catch (e) {
        alert("Archivo inválido");
    } finally {
        $importProjectFile.value = "";
    }
});

$btnTranscribe.addEventListener("click", async () => {
	const f = $file.files?.[0];
	if (!f) {
		$status.textContent = "Selecciona un archivo primero.";
		return;
	}
	try {
        $status.textContent = "Subiendo y preparando transcripción...";
        if ($progress) $progress.value = 0;
        if ($progressText) $progressText.textContent = "0%";
		const form = new FormData();
		form.append("file", f);
		if ($language.value) form.append("language", $language.value);
		form.append("quality", $quality.value);
		// Forzar máxima precisión estable en CPU
		form.append("precision", "float32");
        if ($targetLang && $targetLang.value) form.append("target", $targetLang.value);
        if ($maxWords && $maxWords.value) form.append("max_words", $maxWords.value);

        try {
            const res = await fetch(`${apiBase}/transcribe_stream`, {
                method: "POST",
                body: form,
                headers: { "Accept": "application/x-ndjson" }
            });
            if (!res.ok) {
                const t = await res.text();
                throw new Error(t || "Error al transcribir");
            }
            if (!res.body) throw new Error("Streaming no soportado en este navegador");
            await readNdjsonStream(res.body);
        } catch (streamErr) {
            console.warn("Streaming no disponible, usando fallback de progreso.", streamErr);
            await transcribeWithPolling(form);
        }
	} catch (err) {
		console.error(err);
		$status.textContent = `Error: ${err.message || err}`;
	}
});

async function readNdjsonStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let language = "auto";
    segments = [];
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const evt = JSON.parse(line);
                if (evt.type === "start") {
                    $status.textContent = "Procesando...";
                } else if (evt.type === "progress") {
                    const pct = Number(evt.progress || 0);
                    if ($progress) $progress.value = pct;
                    if ($progressText) $progressText.textContent = `${pct}%`;
                } else if (evt.type === "done") {
                    language = evt.result?.language || language;
                    segments = evt.result?.segments || [];
                } else if (evt.type === "error") {
                    throw new Error(evt.message || "Error en el servidor");
                }
                renderSegments();
                $btnExportSRT.disabled = segments.length === 0;
            } catch (e) {
                console.warn("Invalid line", line);
            }
        }
    }
    $status.textContent = `Listo. Idioma: ${language}. Segmentos: ${segments.length}`;
    if ($progress) $progress.value = 100;
    if ($progressText) $progressText.textContent = "100%";
    // Forzar una actualización del overlay al terminar
    renderKaraokeOverlay($video.currentTime || 0);
}

async function transcribeWithPolling(form) {
    $status.textContent = "Procesando (fallback)...";
    const res = await fetch(`${apiBase}/transcribe`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.jobId) throw new Error("Respuesta inválida del servidor (sin jobId)");
    await pollProgressAndFetchResult(data.jobId);
}

async function pollProgressAndFetchResult(jobId) {
    let done = false;
    while (!done) {
        const r = await fetch(`${apiBase}/progress/${jobId}`);
        if (!r.ok) throw new Error(await r.text());
        const p = await r.json();
        const pct = Number(p.progress || 0);
        if ($progress) $progress.value = pct;
        if ($progressText) $progressText.textContent = `${pct}%`;
        if (p.status === "done") {
            done = true;
            break;
        }
        if (p.status === "error") {
            throw new Error(p.message || "Error en el servidor");
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    const rr = await fetch(`${apiBase}/result/${jobId}`);
    if (!rr.ok) throw new Error(await rr.text());
    const data = await rr.json();
    segments = data.segments || [];
    renderSegments();
    $status.textContent = `Listo. Idioma: ${data.language}. Segmentos: ${segments.length}`;
    $btnExportSRT.disabled = segments.length === 0;
    if ($progress) $progress.value = 100;
    if ($progressText) $progressText.textContent = "100%";
}

$btnExportSRT.addEventListener("click", async () => {
	try {
		$status.textContent = "Generando SRT...";
		const res = await fetch(`${apiBase}/export/srt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(segments),
		});
		if (!res.ok) {
			const t = await res.text();
			throw new Error(t || "Error al exportar SRT");
		}
		const srt = await res.text();
		downloadText("subtitulos.srt", srt);
		$status.textContent = "SRT generado y descargado.";
	} catch (err) {
		console.error(err);
		$status.textContent = `Error: ${err.message || err}`;
	}
});

function renderSegments() {
	$segmentsBody.innerHTML = "";
	segments.forEach((s, idx) => {
		// Fila principal con #, inicio y fin
		const trMain = document.createElement("tr");
		trMain.className = "segRowMain";
		trMain.innerHTML = `
			<td class="colIndex">${idx + 1}</td>
			<td class="colStart"><input class="timeInput" type="number" step="0.01" value="${Number(s.start).toFixed(2)}" /></td>
			<td class="colEnd"><input class="timeInput" type="number" step="0.01" value="${Number(s.end).toFixed(2)}" /></td>
			<td class="colText placeholder">Texto</td>
		`;
		const [inputStart, inputEnd] = trMain.querySelectorAll("input");
		inputStart.addEventListener("change", () => {
			segments[idx].start = Number(inputStart.value);
		});
		inputEnd.addEventListener("change", () => {
			segments[idx].end = Number(inputEnd.value);
		});

		// Segunda fila con textarea a lo ancho
		const trText = document.createElement("tr");
		trText.className = "segRowText";
		const td = document.createElement("td");
		td.colSpan = 4;
		td.innerHTML = `<textarea class="segTextarea">${s.text || ""}</textarea>`;
		const textArea = td.querySelector("textarea");
		textArea.addEventListener("input", () => {
			segments[idx].text = textArea.value;
		});
		trText.appendChild(td);

		$segmentsBody.appendChild(trMain);
		$segmentsBody.appendChild(trText);
	});
	$btnExportSRT.disabled = segments.length === 0;
}

// ====== Guardar/Exportar/Importar proyectos ======
function getStyleStateCurrent() {
    if (typeof getStyleState === "function") return getStyleState();
    return {};
}

function getSubtitleBoxState() {
    if (!$subtitleBox || !$previewBox) return {};
    const pb = $previewBox.getBoundingClientRect();
    const sb = $subtitleBox.getBoundingClientRect();
    return {
        width: sb.width / pb.width,
        height: sb.height / pb.height,
        left: (sb.left - pb.left) / pb.width,
        bottom: (pb.bottom - sb.bottom) / pb.height,
    };
}

function applySubtitleBoxState(state) {
    if (!$subtitleBox || !$previewBox || !state) return;
    $subtitleBox.style.width = `${Math.max(0.2, Math.min(0.95, state.width || 0.7)) * 100}%`;
    $subtitleBox.style.height = `${Math.max(0.05, Math.min(0.8, state.height || 0.1)) * 100}%`;
    $subtitleBox.style.left = `calc(50% + ${(Math.max(-0.45, Math.min(0.45, (state.left || 0.5) - 0.5)) * 100)}%)`;
    $subtitleBox.style.bottom = `${Math.max(0, Math.min(0.8, state.bottom || 0)) * 100}%`;
}

function getProjectState(opts) {
    const shouldPrompt = !(opts && opts.promptName === false);
    const defaultName = $file.files?.[0]?.name || "Proyecto";
    const name = shouldPrompt ? (prompt("Nombre del proyecto:", defaultName) || "Proyecto") : defaultName;
    return {
        id: Date.now().toString(36),
        name,
        createdAt: new Date().toISOString(),
        language: $language?.value || "",
        target: $targetLang?.value || "",
        quality: $quality?.value || "medium",
        maxWords: $maxWords?.value || "0",
        style: getStyleStateCurrent(),
        box: getSubtitleBoxState(),
        segments: segments || [],
    };
}

function writeBackendList(proj){
    // persiste sólo para listado backend/localStorage, no toca archivo del usuario
    fetch(`${apiBase}/projects/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: proj.name,
            language: proj.language,
            target: proj.target,
            quality: proj.quality,
            maxWords: Number(proj.maxWords||0),
            style: proj.style,
            box: proj.box,
            segments: proj.segments,
        })
    }).then(()=>renderSavedProjects()).catch(()=>{
        const key = "karaoke_projects";
        const all = JSON.parse(localStorage.getItem(key) || "[]");
        all.unshift(proj);
        localStorage.setItem(key, JSON.stringify(all));
        renderSavedProjects();
    });
}

function openSaveModal(forceName) {
    if (!$saveModal) { saveProject(); return; }
    const last = JSON.parse(localStorage.getItem('karaoke_last_save')||'{}');
    $saveName.value = forceName ? (getProjectState({ promptName: false }).name||'Proyecto') : (last.name||getProjectState({ promptName: false }).name||'Proyecto');
    $saveDirectory.value = last.directory || '';
    chosenDirHandle = null;
    $saveModal.style.display = 'flex';
}

$saveCancel?.addEventListener('click', ()=>{ if($saveModal) $saveModal.style.display='none'; });
$saveConfirm?.addEventListener('click', ()=>{
    const proj = getProjectState();
    proj.name = $saveName.value || proj.name;
    proj.directory = $saveDirectory.value || null;
    localStorage.setItem('karaoke_last_save', JSON.stringify({ name: proj.name, directory: proj.directory }));
    saveProjectFlow(proj);
    if ($saveModal) $saveModal.style.display='none';
});

$chooseFolder?.addEventListener('click', async ()=>{
    try {
        if (window.showDirectoryPicker) {
            chosenDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            $saveDirectory.value = '[Carpeta seleccionada]';
        } else {
            alert('Tu navegador no permite elegir carpeta nativa. Usa el campo de ruta o exporta JSON.');
        }
    } catch (e) { /* cancelado */ }
});

async function writeProjectToFileHandle(fileHandle, proj){
    const writable = await fileHandle.createWritable();
    await writable.write(new Blob([JSON.stringify({
        name: proj.name,
        language: proj.language,
        target: proj.target,
        quality: proj.quality,
        maxWords: Number(proj.maxWords||0),
        style: proj.style,
        box: proj.box,
        segments: proj.segments,
    }, null, 2)], { type: 'application/json' }));
    await writable.close();
}

function saveProject() {
    const proj = getProjectState({ promptName: false });
    const last = JSON.parse(localStorage.getItem('karaoke_last_save')||'{}');
    proj.name = last.name || proj.name;
    proj.directory = last.directory || null;

    // Si ya hubo "Guardar como..." con file handle, sobrescribir
    if (window.showSaveFilePicker && lastFileHandle) {
        writeProjectToFileHandle(lastFileHandle, proj).then(()=>{
            $status.textContent = 'Guardado';
            writeBackendList(proj);
        }).catch(()=>{
            // Si falla, forzar Guardar como
            openSaveModal(true);
        });
        return;
    }
    // Si no hay file handle, forzar Guardar como
    openSaveModal(true);
}

async function saveProjectFlow(proj){
    try {
        // Preferir diálogo nativo de Guardar como cuando esté disponible
        if (window.showSaveFilePicker) {
            const fh = await window.showSaveFilePicker({
                suggestedName: `${(proj.name||'Proyecto').replace(/[^a-z0-9-_]+/gi,'_')}.json`,
                types: [{ description: 'Proyecto JSON', accept: { 'application/json': ['.json'] } }]
            });
            await writeProjectToFileHandle(fh, proj);
            lastFileHandle = fh;
            $status.textContent = 'Guardado';
            writeBackendList(proj);
            return;
        }
    } catch (e) {
        console.warn('saveFilePicker failed', e);
    }
    // Fallback: selector de carpeta
    try {
        if (!proj.directory && (chosenDirHandle || window.showDirectoryPicker)) {
            const dirHandle = chosenDirHandle || await window.showDirectoryPicker({ mode: 'readwrite' });
            const fname = `${(proj.name||'Proyecto').replace(/[^a-z0-9-_]+/gi,'_')}.json`;
            const fileHandle = await dirHandle.getFileHandle(fname, { create: true });
            await writeProjectToFileHandle(fileHandle, proj);
            lastFileHandle = fileHandle;
            $status.textContent = `Guardado en carpeta elegida: ${fname}`;
            writeBackendList(proj);
        }
    } catch (e) {
        console.warn('save to chosen folder failed', e);
    }
}

function exportProject() {
    const proj = getProjectState();
    const txt = JSON.stringify(proj, null, 2);
    downloadText(`${proj.name.replace(/[^a-z0-9-_]+/gi,'_') || 'proyecto'}.json`, txt);
}

function exportPreviewImage() {
    if (!window.html2canvas || !$previewBox) { alert('html2canvas no disponible'); return; }
    html2canvas($previewBox, { backgroundColor: null }).then(canvas => {
        canvas.toBlob((blob)=>{
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'vista_previa.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    });
}

function saveAsProject() {
    const proj = getProjectState();
    const newName = prompt("Guardar como:", proj.name) || proj.name;
    proj.name = newName;
    // Redirigir a flujo Guardar como
    saveProjectFlow(proj);
}

async function openProject() {
    try {
        const resp = await fetch(`${apiBase}/projects/list`);
        if (!resp.ok) throw new Error('no-list');
        const { projects } = await resp.json();
        if (!projects || projects.length === 0) { alert('No hay proyectos en disco'); return; }
        const listado = projects.map((p,i)=>`${i+1}) ${p.name}`).join('\n');
        const ans = prompt(`Abrir proyecto:\n${listado}\nIngresa número:`, '1');
        const idx = Math.max(1, Math.min(projects.length, parseInt(ans||'1',10))) - 1;
        const d = await (await fetch(`${apiBase}/projects/${projects[idx].id}`)).json();
        loadProject(d);
    } catch {
        // fallback: importar archivo
        $importProjectFile?.click();
    }
}

function newProject() {
    segments = [];
    renderSegments();
    $status.textContent = 'Proyecto nuevo';
    renderKaraokeOverlay($video.currentTime || 0);
}

function renderSavedProjects() {
    if (!$savedList) return;
    $savedList.innerHTML = "Cargando...";
    if (Date.now() < projectsApiDownUntil) {
        // backend silenciado temporalmente → usar localStorage
        const key = "karaoke_projects";
        const all = JSON.parse(localStorage.getItem(key) || "[]");
        $savedList.innerHTML = "";
        all.forEach((p) => {
            const div = document.createElement("div");
            div.className = "savedItem";
            div.innerHTML = `
                <div class="name">${escapeHtml(p.name || 'Proyecto')} · <span style="color:#8aa">${new Date(p.createdAt||Date.now()).toLocaleString()}</span></div>
                <div><button data-act="load">Cargar</button></div>
                <div><button data-act="export">Exportar</button></div>
                <div><button data-act="delete">Borrar</button></div>
            `;
            div.querySelector('[data-act="load"]').addEventListener('click',()=>loadProject(p));
            div.querySelector('[data-act="export"]').addEventListener('click',()=>{
                const txt = JSON.stringify(p, null, 2);
                downloadText(`${(p.name||'proyecto')}.json`, txt);
            });
            div.querySelector('[data-act="delete"]').addEventListener('click',()=>{
                const newAll = JSON.parse(localStorage.getItem(key) || "[]").filter(x=>x!==p);
                localStorage.setItem(key, JSON.stringify(newAll));
                renderSavedProjects();
            });
            $savedList.appendChild(div);
        });
        return;
    }
    fetch(`${apiBase}/projects/list`).then(r=>{
        if (!r.ok) throw new Error('projects/list not ok');
        return r.json();
    }).then(({projects})=>{
        const all = projects || [];
        $savedList.innerHTML = "";
        all.forEach((p) => {
            const div = document.createElement("div");
            div.className = "savedItem";
            div.innerHTML = `
                <div class="name">${escapeHtml(p.name || 'Proyecto')} · <span style="color:#8aa">${new Date(p.createdAt||Date.now()).toLocaleString()}</span></div>
                <div><button data-act="load">Cargar</button></div>
                <div><button data-act="export">Exportar</button></div>
                <div><button data-act="delete">Borrar</button></div>
            `;
            div.querySelector('[data-act="load"]').addEventListener('click',async()=>{
                const d = await (await fetch(`${apiBase}/projects/${p.id}`)).json();
                loadProject(d);
            });
            div.querySelector('[data-act="export"]').addEventListener('click',async()=>{
                const d = await (await fetch(`${apiBase}/projects/${p.id}`)).json();
                const txt = JSON.stringify(d, null, 2);
                downloadText(`${(d.name||'proyecto')}.json`, txt);
            });
            div.querySelector('[data-act="delete"]').addEventListener('click',async()=>{
                await fetch(`${apiBase}/projects/${p.id}`, { method: 'DELETE' });
                renderSavedProjects();
            });
            $savedList.appendChild(div);
        });
    }).catch(()=>{
        // marcar backend caído por 60s para no spamear
        projectsApiDownUntil = Date.now() + 60000;
        // fallback: localStorage
        const key = "karaoke_projects";
        const all = JSON.parse(localStorage.getItem(key) || "[]");
        $savedList.innerHTML = "";
        all.forEach((p) => {
            const div = document.createElement("div");
            div.className = "savedItem";
            div.innerHTML = `
                <div class="name">${escapeHtml(p.name || 'Proyecto')} · <span style="color:#8aa">${new Date(p.createdAt||Date.now()).toLocaleString()}</span></div>
                <div><button data-act="load">Cargar</button></div>
                <div><button data-act="export">Exportar</button></div>
                <div><button data-act="delete">Borrar</button></div>
            `;
            div.querySelector('[data-act="load"]').addEventListener('click',()=>loadProject(p));
            div.querySelector('[data-act="export"]').addEventListener('click',()=>{
                const txt = JSON.stringify(p, null, 2);
                downloadText(`${(p.name||'proyecto')}.json`, txt);
            });
            div.querySelector('[data-act="delete"]').addEventListener('click',()=>{
                const newAll = JSON.parse(localStorage.getItem(key) || "[]").filter(x=>x!==p);
                localStorage.setItem(key, JSON.stringify(newAll));
                renderSavedProjects();
            });
            $savedList.appendChild(div);
        });
    });
}

function loadProject(p) {
    try {
        segments = Array.isArray(p.segments) ? p.segments : [];
        renderSegments();
        if ($language) $language.value = p.language || "";
        if ($targetLang) $targetLang.value = p.target || "";
        if ($quality) $quality.value = p.quality || "medium";
        if ($maxWords) $maxWords.value = String(p.maxWords || "0");
        if (p.style) {
            if ($styleFont && p.style.fontFamily) $styleFont.value = p.style.fontFamily;
            if ($styleSize && p.style.fontSizePx) $styleSize.value = p.style.fontSizePx;
            if ($styleDoneColor && p.style.doneColor) $styleDoneColor.value = p.style.doneColor;
            if ($styleRestColor && p.style.restColor) $styleRestColor.value = p.style.restColor;
            if ($styleBorder) $styleBorder.checked = !!p.style.borderOn;
            if ($styleBorderColor && p.style.borderColor) $styleBorderColor.value = p.style.borderColor;
            if ($styleBorderWidth && p.style.borderWidth) $styleBorderWidth.value = p.style.borderWidth;
            if ($styleShadow) $styleShadow.checked = !!p.style.shadowOn;
            applyKaraokeStyles();
        }
        if (p.box) applySubtitleBoxState(p.box);
        renderKaraokeOverlay($video.currentTime || 0);
    } catch(e) { console.error(e); }
}

renderSavedProjects();
$video.addEventListener("play", () => startKaraokeLoop());
$video.addEventListener("pause", () => stopKaraokeLoop());
$video.addEventListener("seeking", () => renderKaraokeOverlay($video.currentTime || 0));
$video.addEventListener("timeupdate", () => renderKaraokeOverlay($video.currentTime || 0));

function startKaraokeLoop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
        renderKaraokeOverlay($video.currentTime || 0);
        if (!$video.paused && !$video.ended) {
            rafId = requestAnimationFrame(tick);
        }
    };
    rafId = requestAnimationFrame(tick);
}

function stopKaraokeLoop() {
    cancelAnimationFrame(rafId);
}

function findCurrentSegment(t) {
    if (!Array.isArray(segments) || segments.length === 0) return null;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const start = Number(s.start) || 0;
        const end = Number(s.end) || 0;
        if (t >= start && t <= end) return s;
    }
    // Si no cae dentro de ninguno, buscar el más cercano anterior para mostrar texto reciente
    let prev = null;
    for (let i = segments.length - 1; i >= 0; i--) {
        if ((Number(segments[i].end) || 0) < t) { prev = segments[i]; break; }
    }
    return prev;
}

function renderKaraokeOverlay(currentTime) {
    if (!$subtitleOverlay) return;
    if (!Array.isArray(segments) || segments.length === 0) {
        $subtitleOverlay.innerHTML = "";
        return;
    }
    const seg = findCurrentSegment(currentTime);
    if (!seg) {
        $subtitleOverlay.innerHTML = "";
        return;
    }
    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || 0;
    const total = Math.max(0.01, end - start);
    const ratio = Math.max(0, Math.min(1, (currentTime - start) / total));
    const text = String(seg.text || "");
    if (!text) {
        $subtitleOverlay.innerHTML = "";
        return;
    }
    // Progreso aprox. por caracteres
    const splitAt = Math.floor(text.length * ratio);
    const done = text.slice(0, splitAt);
    const rest = text.slice(splitAt);

    const st = karaokeStyle || getStyleState();
    const lineStyle = [
        `font-size:${st.fontSizePx}px`,
        `font-family:${st.fontFamily}`,
        `background:${st.backgroundRgba}`,
        // El borde debe ser contorno de letras, no caja
        "border:none",
        "border-radius:0",
        "padding:2px 6px",
        st.shadowOn ? "text-shadow:0 2px 4px rgba(0,0,0,0.9),0 0 6px rgba(0,0,0,0.7)" : "text-shadow:none",
    ].join(";");
    const strokeCss = buildStrokeCss(st.borderOn, st.borderWidth, st.borderColor);
    const doneStyle = `color:${st.doneColor};${strokeCss}`;
    const restStyle = `color:${st.restColor};${strokeCss}`;
    if (window.$subtitleText) {
        $subtitleText.innerHTML = `<span class="line" style="${lineStyle}"><span class="done" style="${doneStyle}">${escapeHtml(done)}</span><span class="rest" style="${restStyle}">${escapeHtml(rest)}</span></span>`;
    } else {
        $subtitleOverlay.innerHTML = `<span class="line" style="${lineStyle}"><span class="done" style="${doneStyle}">${escapeHtml(done)}</span><span class="rest" style="${restStyle}">${escapeHtml(rest)}</span></span>`;
    }
}

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#039;");
}

// Aplicar estilos desde los controles
[$styleFont,$styleSize,$styleDoneColor,$styleRestColor,$styleBgColor,$styleBgOpacity,$styleBorder,$styleBorderColor,$styleBorderWidth,$styleShadow]
    .forEach(el => el && el.addEventListener("input", applyKaraokeStyles));

function getStyleState() {
    const fontFamily = $styleFont?.value || "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    const fontSizePx = Number($styleSize?.value || 28);
    const doneColor = $styleDoneColor?.value || "#ffea00";
    const restColor = $styleRestColor?.value || "#ffffff";
    const bgHex = $styleBgColor?.value || "#000000";
    const bgOpacity = Math.max(0, Math.min(100, Number($styleBgOpacity?.value || 15))) / 100;
    const borderOn = !!$styleBorder?.checked;
    const borderColor = $styleBorderColor?.value || "#000000";
    const borderWidth = Number($styleBorderWidth?.value || 0);
    const shadowOn = !!$styleShadow?.checked;
    const backgroundRgba = hexToRgba(bgHex, bgOpacity);
    return { fontFamily, fontSizePx, doneColor, restColor, backgroundRgba, borderOn, borderColor, borderWidth, shadowOn };
}

function applyKaraokeStyles() {
    karaokeStyle = getStyleState();
    // También aplicar fuente al overlay contenedor por consistencia
    if ($subtitleOverlay) {
        $subtitleOverlay.style.fontFamily = karaokeStyle.fontFamily;
    }
    renderKaraokeOverlay($video.currentTime || 0);
}

function buildStrokeCss(on, width, color) {
    if (!on || !width || width <= 0) return "";
    // Contorno hacia afuera usando solo sombras (no usa -webkit-text-stroke para no "comer" relleno)
    const w = Math.max(1, Math.round(width));
    const layers = [];
    // Anillos concéntricos desde 1 hasta w píxeles
    for (let r = 1; r <= w; r++) {
        for (let a = 0; a < 360; a += 30) {
            const rad = a * Math.PI / 180;
            const x = Math.round(Math.cos(rad) * r);
            const y = Math.round(Math.sin(rad) * r);
            layers.push(`${x}px ${y}px 0 ${color}`);
        }
    }
    return `text-shadow: ${layers.join(', ')};`;
}

function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


function downloadText(filename, text) {
	const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}


