"""
Document Ingestion Module
=========================
Saves uploaded files to disk, loads them with the right LangChain loader,
and splits them into overlapping chunks for vector storage.
"""

import os
from typing import Callable

from langchain_community.document_loaders import Docx2txtLoader, PyPDFLoader, TextLoader
from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

# Chunking params tuned for study notes:
# - 1000 chars ≈ 1-2 paragraphs: enough context per chunk to be self-contained,
#   small enough that a top-k retrieval fits the LLM's prompt budget.
# - 200-char overlap preserves cross-boundary context (a concept straddling two
#   chunks stays recoverable from either side).
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP
)

upload_dir = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(upload_dir, exist_ok=True)

# Factories (not classes) so TextLoader can carry extra kwargs like encoding detection.
LOADERS: dict[str, Callable[[str], BaseLoader]] = {
    ".pdf": PyPDFLoader,
    ".txt": lambda p: TextLoader(p, autodetect_encoding=True),
    ".docx": Docx2txtLoader,
}


def save_uploaded_file(name: str, data: bytes) -> str:
    """Persist uploaded bytes to the local uploads/ dir and return the path.

    Decoupled from any specific web framework's file type — Streamlit passes
    `(f.name, f.getbuffer())` and FastAPI passes `(file.filename, await file.read())`.

    Collisions get a numeric suffix so re-uploading a same-named file doesn't
    silently overwrite the previous copy.
    """
    # basename() strips path components to block traversal like "../../etc/passwd"
    safe_name = os.path.basename(name)
    path = os.path.join(upload_dir, safe_name)
    stem, ext = os.path.splitext(safe_name)
    counter = 1
    while os.path.exists(path):
        path = os.path.join(upload_dir, f"{stem}_{counter}{ext}")
        counter += 1
    with open(path, "wb") as f:
        f.write(data)
    return path


def load_and_chunk(file_path: str) -> list[Document]:
    """Load a file with the appropriate loader and split into overlapping chunks."""
    ext = os.path.splitext(file_path)[1].lower()
    loader_factory = LOADERS.get(ext)
    if loader_factory is None:
        raise ValueError(f"Unsupported file type: {ext}")

    documents = loader_factory(file_path).load()
    return text_splitter.split_documents(documents)


def clear_uploads() -> None:
    """Remove all saved upload originals.

    Chunks in ChromaDB carry their own text, so the on-disk copies are only
    needed transiently during ingestion. Pruning them prevents uploads/ from
    growing unbounded across re-ingest cycles.
    """
    if not os.path.isdir(upload_dir):
        return
    for name in os.listdir(upload_dir):
        path = os.path.join(upload_dir, name)
        if os.path.isfile(path):
            os.remove(path)
