"""
FastAPI server — bridges the React frontend to the RAG modules.

Serves static assets from frontend/ and exposes a small JSON/NDJSON API:
  GET    /api/documents           list indexed docs
  POST   /api/upload              multipart: add a file to the index
  DELETE /api/documents/{name}    remove a single doc
  POST   /api/clear               wipe all indexed notes
  POST   /api/ask                 NDJSON stream: citations + answer tokens
  POST   /api/quiz                generate and parse a quiz (JSON)
  POST   /api/flashcards          generate and parse flashcards (JSON)
  GET    /api/topics              suggested study topics

Run: uvicorn server:app --reload --port 8000
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from ingestion import clear_uploads, load_and_chunk, save_uploaded_file, upload_dir
from rag import (
    NO_CONTEXT_MSG,
    RETRIEVAL_K,
    ask_question,
    chunks_to_citations,
    generate_flashcards_structured,
    generate_quiz_structured,
    retrieve_docs,
    suggest_topics,
)
from vectorstore import (
    COLLECTION_NAME,
    add_documents,
    clear_vectorstore,
    get_chroma_client,
)

HERE = Path(__file__).parent
FRONTEND = HERE / "frontend"

app = FastAPI(title="AI Study Assistant")


class AskBody(BaseModel):
    question: str


class TopicBody(BaseModel):
    topic: str
    count: int = Field(default=5, ge=1, le=25)


# --- Document metadata helpers ---------------------------------------------


def _per_file_stats() -> dict[str, int]:
    """chunks-per-source-filename, in one ChromaDB pass."""
    client = get_chroma_client()
    existing = {c.name for c in client.list_collections()}
    if COLLECTION_NAME not in existing:
        return {}
    col = client.get_collection(COLLECTION_NAME)
    metas = col.get(include=["metadatas"]).get("metadatas") or []
    counts: dict[str, int] = {}
    for md in metas:
        if md and md.get("source"):
            name = os.path.basename(md["source"])
            counts[name] = counts.get(name, 0) + 1
    return counts


def _file_size_display(path: str) -> str:
    """Human-friendly size string for the sidebar, e.g. '0.3MB' or '18KB'."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return "—"
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f}MB"
    if size >= 1024:
        return f"{size // 1024}KB"
    return f"{size}B"


def _document_list() -> list[dict]:
    """One row per indexed file: name, chunk count, on-disk size, mtime date."""
    counts = _per_file_stats()
    rows: list[dict] = []
    for name, n_chunks in sorted(counts.items()):
        on_disk = os.path.join(upload_dir, name)
        mtime = os.path.getmtime(on_disk) if os.path.exists(on_disk) else None
        rows.append(
            {
                "id": name,
                "name": name,
                "chunks": n_chunks,
                "size": _file_size_display(on_disk),
                "addedAt": _format_mtime(mtime),
                "status": "indexed",
            }
        )
    return rows


def _format_mtime(ts: float | None) -> str:
    if ts is None:
        return ""
    import datetime as _dt

    return _dt.datetime.fromtimestamp(ts).strftime("%b %d")


# --- Routes -----------------------------------------------------------------


@app.get("/api/documents")
def list_documents() -> dict:
    return {"documents": _document_list()}


@app.get("/api/topics")
def get_topics(n: int = 5) -> dict:
    return {"topics": suggest_topics(n=n)}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".pdf", ".docx", ".txt"):
        raise HTTPException(415, f"Unsupported file type: {ext}")

    data = await file.read()
    path = save_uploaded_file(file.filename, data)
    try:
        chunks = load_and_chunk(path)
    except Exception as e:
        # Leave the raw file on disk for debugging, but surface the error.
        raise HTTPException(422, f"Could not parse {file.filename}: {e}") from e

    add_documents(chunks)
    return {
        "ok": True,
        "name": os.path.basename(path),
        "chunks": len(chunks),
    }


@app.delete("/api/documents/{name}")
def delete_document(name: str) -> dict:
    from vectorstore import (
        remove_document,
    )  # local import to avoid heavy top-level load

    removed = remove_document(os.path.basename(name))  # strip any path tricks
    on_disk = os.path.join(upload_dir, os.path.basename(name))
    if os.path.exists(on_disk):
        os.remove(on_disk)
    return {"removed": removed}


@app.post("/api/clear")
def clear_all() -> dict:
    clear_vectorstore()
    clear_uploads()
    return {"ok": True}


@app.post("/api/ask")
def ask(body: AskBody):
    """Stream an answer as NDJSON.

    Frame 1: {"type":"chunks","data":{c1:{...},...}}  — citations for the drawer
    Frame 2+: {"type":"token","text":"..."}            — model output, token-by-token
    Final:  {"type":"done"}
    Errors mid-stream are emitted as {"type":"error","message":"..."} instead of tokens.
    """

    def gen():
        docs = retrieve_docs(body.question, k=RETRIEVAL_K)
        if not docs:
            yield json.dumps({"type": "error", "message": NO_CONTEXT_MSG}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
            return

        citations = chunks_to_citations(docs)
        yield json.dumps({"type": "chunks", "data": citations}) + "\n"

        # ask_question re-runs retrieval internally — acceptable duplication for V1
        # (ChromaDB similarity search on a hot index is ~10ms).
        for token in ask_question(body.question):
            yield json.dumps({"type": "token", "text": token}) + "\n"
        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.post("/api/quiz")
def quiz(body: TopicBody) -> dict:
    return generate_quiz_structured(body.topic, num_questions=body.count)


@app.post("/api/flashcards")
def flashcards(body: TopicBody) -> dict:
    return generate_flashcards_structured(body.topic, num_cards=body.count)


# --- Static frontend --------------------------------------------------------


# Explicit route for "/" because StaticFiles(html=True) needs the file at /index.html
# and we want /favicon.ico + friends to 404 cleanly instead of falling through.
@app.get("/")
def root() -> FileResponse:
    return FileResponse(FRONTEND / "index.html")


# Mount last so /api/* takes precedence.
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
