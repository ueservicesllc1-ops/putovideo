# Karaoke Studio (putoeditor)

Aplicación web para generar subtítulos tipo karaoke a partir de un archivo de video/audio usando un backend FastAPI con `faster-whisper`.

## Estructura

- `web/`: interfaz web estática (`index.html`, `app.js`, `styles.css`).
- `server/`: API FastAPI (`main.py`) y `requirements.txt`.

## Requisitos

- Python 3.10+
- ffmpeg (recomendado para una mejor lectura de medios)

## Backend (FastAPI)

1. Crear y activar un entorno virtual (opcional, recomendado).
2. Instalar dependencias:

```bash
pip install -r server/requirements.txt
```

3. Ejecutar el servidor de desarrollo:

```bash
uvicorn server.main:app --reload --host 127.0.0.1 --port 8000
```

El API quedará disponible en `http://127.0.0.1:8000`.

## Frontend (estático)

Abrir `web/index.html` en el navegador (doble clic o con un servidor estático). Por defecto se conecta al backend en `http://127.0.0.1:8000`.

## Notas

- Los proyectos guardados por el backend se persisten en `server/projects/` (carpeta ignorada por git).
- Si deseas exponer el backend a otra red, ajusta el host de uvicorn y/o la variable `apiBase` en `web/app.js`.


