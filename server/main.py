import os
import tempfile
from typing import List, Optional, Dict

from fastapi import FastAPI, UploadFile, File, Form, Body, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
import json
from pydantic import BaseModel
from faster_whisper import WhisperModel
import av
import uuid
from deep_translator import GoogleTranslator
from datetime import datetime

# Carpeta para proyectos persistentes
PROJECTS_DIR = os.path.join(os.path.dirname(__file__), "projects")
os.makedirs(PROJECTS_DIR, exist_ok=True)


# Forzar CPU para evitar fallos de CUDA/cuDNN en entornos sin GPU lista
os.environ.setdefault("CT2_FORCE_CPU", "1")
os.environ.setdefault("ORT_DISABLE_CUDA", "1")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

app = FastAPI()
app.add_middleware(
	CORSMiddleware,
	allow_origins=["*"],
	allow_credentials=True,
	allow_methods=["*"],
	allow_headers=["*"],
)


MODEL_CACHE: dict[str, WhisperModel] = {}
JOBS: Dict[str, dict] = {}


def get_model(model_size: str, compute_type: str) -> WhisperModel:
	key = f"{model_size}:{compute_type}"
	if key in MODEL_CACHE:
		return MODEL_CACHE[key]

	# Resolver compute_type compatible con CPU
	requested = compute_type or "int8"
	candidates: list[str] = [requested]
	if requested == "int8_float16":
		candidates += ["int8", "float32"]
	elif requested == "float16":
		candidates += ["float32", "int8"]
	else:
		candidates += ["int8", "float32"]

	last_error: Exception | None = None
	for ct in candidates:
		try:
			model = WhisperModel(
				model_size,
				device="cpu",
				compute_type=ct,
			)
			MODEL_CACHE[f"{model_size}:{ct}"] = model
			return model
		except Exception as e:
			last_error = e

	raise RuntimeError(f"No se pudo cargar el modelo con types {candidates}: {last_error}")


class Segment(BaseModel):
	id: int
	start: float
	end: float
	text: str


class TranscriptionResponse(BaseModel):
	language: str
	segments: List[Segment]


def _get_media_duration_seconds(path: str) -> float:
    try:
        c = av.open(path)
        if c.duration:
            return float(c.duration) / 1_000_000.0
        # fallback: first stream
        for s in c.streams:
            if s.duration and s.time_base:
                return float(s.duration * s.time_base)
    except Exception:
        pass
    return 0.0


def _translate_segments(segments: List[Segment], src_lang: Optional[str], target_lang: Optional[str]) -> List[Segment]:
    if not target_lang or target_lang.strip() == "":
        return segments
    # Whisper solo traduce a EN; para otros idiomas usamos traductor externo
    try:
        # normalizar idioma
        target = (target_lang or "").strip().lower()
        translator = GoogleTranslator(source=(src_lang or "auto"), target=target)
        out: List[Segment] = []
        for s in segments:
            txt = s.text or ""
            try:
                t = translator.translate(txt) if txt else txt
            except Exception:
                t = txt
            out.append(Segment(id=s.id, start=s.start, end=s.end, text=t))
        return out
    except Exception:
        return segments

def _split_segments_by_max_words(segments: List[Segment], max_words: Optional[int]) -> List[Segment]:
    if not max_words or max_words <= 0:
        return segments
    # Enforce mínimo 3 palabras por bloque
    if max_words < 3:
        max_words = 3
    new_segments: List[Segment] = []
    next_id = 0
    for seg in segments:
        words = (seg.text or "").split()
        if len(words) <= max_words or seg.end <= seg.start:
            new_segments.append(Segment(id=next_id, start=seg.start, end=seg.end, text=seg.text))
            next_id += 1
            continue
        # dividir en bloques de max_words y repartir el tiempo proporcionalmente
        total_words = len(words)
        total_duration = max(0.001, seg.end - seg.start)
        num_chunks = (total_words + max_words - 1) // max_words
        for i in range(num_chunks):
            chunk_words = words[i*max_words:(i+1)*max_words]
            # duración proporcional por palabras
            portion = len(chunk_words) / total_words
            chunk_duration = total_duration * portion
            chunk_start = (new_segments[-1].end if new_segments and new_segments[-1].id >= 0 and new_segments[-1].end > seg.start and new_segments[-1].start >= seg.start else seg.start)
            # asegurar no solapar
            if i == 0:
                chunk_start = seg.start
            chunk_end = min(seg.end, chunk_start + chunk_duration)
            new_segments.append(Segment(id=next_id, start=chunk_start, end=chunk_end, text=" ".join(chunk_words)))
            next_id += 1
    return new_segments


def _process_transcription_job(job_id: str, tmp_path: str, language: Optional[str], quality: str, precision: str, target: Optional[str], max_words: Optional[int]) -> None:
    try:
        JOBS[job_id] = {"status": "processing", "progress": 0}
        total_seconds = _get_media_duration_seconds(tmp_path)
        model = get_model(quality, precision)
        segments_iter, info = model.transcribe(
            tmp_path,
            language=language,
            vad_filter=True,
            beam_size=5,
            best_of=5,
        )
        out_segments: List[Segment] = []
        last_progress = 0
        for i, seg in enumerate(segments_iter):
            out_segments.append(
                Segment(
                    id=i,
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text.strip(),
                )
            )
            if total_seconds > 0:
                prog = int(min(100, max(last_progress, (float(seg.end) / total_seconds) * 100.0)))
                last_progress = prog
                JOBS[job_id]["progress"] = prog
        # Post-procesado: división por palabras y posible traducción
        detected_lang = getattr(info, "language", language or "auto")
        final_segments = _split_segments_by_max_words(out_segments, max_words)
        final_lang = detected_lang
        if target and target != "" and target != detected_lang:
            final_segments = _translate_segments(final_segments, detected_lang, target)
            final_lang = target

        JOBS[job_id] = {
            "status": "done",
            "progress": 100,
            "result": {
                "language": final_lang,
                "segments": [s.dict() for s in final_segments],
            },
        }
    except Exception as e:
        JOBS[job_id] = {"status": "error", "progress": 0, "message": str(e)}
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


@app.post("/transcribe")
async def transcribe(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    quality: str = Form("medium"),
    precision: str = Form("int8_float16"),
    target: Optional[str] = Form(None),
    max_words: Optional[int] = Form(None),
):
    suffix = os.path.splitext(file.filename)[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "queued", "progress": 0}
    background_tasks.add_task(_process_transcription_job, job_id, tmp_path, language, quality, precision, target, max_words)
    return {"jobId": job_id}


@app.get("/progress/{job_id}")
def get_progress(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"jobId": job_id, "status": job.get("status"), "progress": job.get("progress", 0), "message": job.get("message")}


@app.get("/result/{job_id}", response_model=TranscriptionResponse)
def get_result(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "done":
        raise HTTPException(status_code=202, detail="Not ready")
    data = job.get("result") or {}
    return TranscriptionResponse(language=data.get("language", "auto"), segments=[Segment(**s) for s in data.get("segments", [])])


def _ndjson(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


@app.post("/transcribe_stream")
async def transcribe_stream(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    quality: str = Form("medium"),
    precision: str = Form("int8_float16"),
    target: Optional[str] = Form(None),
    max_words: Optional[int] = Form(None),
):
    suffix = os.path.splitext(file.filename)[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    def generator():
        try:
            total_seconds = _get_media_duration_seconds(tmp_path)
            # Envía inicio lo antes posible para abrir el stream en el cliente
            yield _ndjson({"type": "start", "totalSeconds": total_seconds})

            # Carga del modelo (puede tardar). Si falla, informar al cliente.
            try:
                model = get_model(quality, precision)
            except Exception as e:
                yield _ndjson({"type": "error", "message": f"model_load: {str(e)}"})
                return
            segments_iter, info = model.transcribe(
                tmp_path,
                language=language,
                vad_filter=True,
                beam_size=5,
                best_of=5,
            )
            out_segments: List[Segment] = []
            last_progress = 0
            for i, seg in enumerate(segments_iter):
                s = Segment(
                    id=i,
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text.strip(),
                )
                out_segments.append(s)
                if total_seconds > 0:
                    prog = int(min(100, max(last_progress, (float(seg.end) / total_seconds) * 100.0)))
                    last_progress = prog
                yield _ndjson({"type": "progress", "progress": last_progress, "lastEnd": s.end})
            detected_lang = getattr(info, "language", language or "auto")
            final_segments = out_segments
            final_lang = detected_lang
            if target and target != "" and target != detected_lang:
                try:
                    final_segments = _translate_segments(out_segments, detected_lang, target)
                    final_lang = target
                except Exception as e:
                    # si falla la traducción, devolver original
                    pass
            # dividir por palabras si se solicita
            final_segments = _split_segments_by_max_words(final_segments, max_words)
            result = {
                "language": final_lang,
                "segments": [s.dict() for s in final_segments],
            }
            yield _ndjson({"type": "done", "result": result})
        except Exception as e:
            # Intenta mandar un evento de error antes de cerrar
            try:
                yield _ndjson({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    return StreamingResponse(
        generator(),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            # Evitar problemas con proxies y clientes que reinician la conexión
            # No forzar "Connection: keep-alive"; el servidor lo gestiona
            # Sugerir no bufferizar en proxies como nginx
            "X-Accel-Buffering": "no",
        },
    )


def to_srt_timestamp(t: float) -> str:
	hours = int(t // 3600)
	minutes = int((t % 3600) // 60)
	seconds = int(t % 60)
	millis = int((t - int(t)) * 1000)
	return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


@app.post("/export/srt", response_class=PlainTextResponse)
async def export_srt(segments: List[Segment] = Body(...)):
	lines: list[str] = []
	for i, s in enumerate(segments, start=1):
		start = to_srt_timestamp(s.start)
		end = to_srt_timestamp(s.end)
		lines.append(str(i))
		lines.append(f"{start} --> {end}")
		lines.append(s.text)
		lines.append("")
	return "\n".join(lines)


# ===================== PROYECTOS (persistencia en disco) =====================
class ProjectPayload(BaseModel):
    name: str
    language: Optional[str] = None
    target: Optional[str] = None
    quality: Optional[str] = None
    maxWords: Optional[int] = None
    style: Optional[dict] = None
    box: Optional[dict] = None
    segments: List[Segment] = []
    # Ruta absoluta (opcional) donde guardar en disco además de la copia en projects/
    directory: Optional[str] = None


def _project_path(project_id: str) -> str:
    return os.path.join(PROJECTS_DIR, f"{project_id}.json")


@app.post("/projects/save")
async def save_project(payload: ProjectPayload):
    project_id = uuid.uuid4().hex
    data = {
        "id": project_id,
        "name": payload.name or "Proyecto",
        "createdAt": datetime.utcnow().isoformat() + "Z",
        "language": payload.language,
        "target": payload.target,
        "quality": payload.quality,
        "maxWords": payload.maxWords,
        "style": payload.style or {},
        "box": payload.box or {},
        "segments": [s.dict() for s in payload.segments],
        "path": None,
    }
    with open(_project_path(project_id), "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
    # Si se especifica un directorio, guardar una copia allí también
    if payload.directory:
        try:
            os.makedirs(payload.directory, exist_ok=True)
            out_path = os.path.join(payload.directory, f"{(payload.name or 'Proyecto')}.json")
            with open(out_path, "w", encoding="utf-8") as f2:
                f2.write(json.dumps(data, ensure_ascii=False, indent=2))
            data["path"] = out_path
            # actualizar copia local con path
            with open(_project_path(project_id), "w", encoding="utf-8") as f3:
                f3.write(json.dumps(data, ensure_ascii=False, indent=2))
        except Exception as e:
            # no romper por fallo de ruta
            pass
    return {"id": project_id, "path": data.get("path")}


@app.get("/projects/list")
async def list_projects():
    items = []
    for fn in os.listdir(PROJECTS_DIR):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(PROJECTS_DIR, fn), "r", encoding="utf-8") as f:
                d = json.load(f)
            items.append({
                "id": d.get("id") or fn.replace(".json", ""),
                "name": d.get("name", "Proyecto"),
                "createdAt": d.get("createdAt"),
                "language": d.get("language"),
                "target": d.get("target"),
            })
        except Exception:
            continue
    # más recientes primero
    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return {"projects": items}


@app.get("/projects/{project_id}")
async def load_project(project_id: str):
    p = _project_path(project_id)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="Not found")
    with open(p, "r", encoding="utf-8") as f:
        d = json.load(f)
    # normalizar segmentos a modelo
    d["segments"] = [Segment(**s).dict() for s in d.get("segments", [])]
    return d


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    p = _project_path(project_id)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="Not found")
    os.remove(p)
    return {"ok": True}

