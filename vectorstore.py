"""
Vector Store Module
===================
Converts text chunks into vector embeddings and stores them in ChromaDB
for similarity search (finding relevant notes when a question is asked).

Architecture:
  Text chunks -> HuggingFace embedding model -> numerical vectors -> ChromaDB

Uses persistent on-disk storage so embeddings survive app restarts.
"""

import os
from functools import lru_cache

import chromadb
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings

# Collection name used to group all study note vectors together in ChromaDB.
COLLECTION_NAME = "study_notes"

# On-disk location for the ChromaDB data. Resolved relative to this file so the
# path is stable regardless of the working directory the server is launched from.
CHROMA_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")


# lru_cache(maxsize=1) on a no-arg function = thread-safe lazy singleton. Same
# "load once" behavior as Streamlit's @st.cache_resource, but with no Streamlit
# dependency — so the module works from FastAPI, pytest, or a plain REPL.
@lru_cache(maxsize=1)
def get_embedding_model() -> HuggingFaceEmbeddings:
    """Load the HuggingFace sentence-transformer model.

    "all-MiniLM-L6-v2" converts text into 384-dimensional vectors.
    It's lightweight (~80MB) and good for semantic similarity tasks.
    First run downloads the model from HuggingFace; surface a clearer
    error so the user knows it's a network/install problem, not a bug.
    """
    try:
        return HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    except Exception as e:
        raise RuntimeError(
            "Failed to load embedding model 'all-MiniLM-L6-v2'. "
            "First run requires internet access to download ~80MB from HuggingFace. "
            f"Original error: {e}"
        ) from e


@lru_cache(maxsize=1)
def get_chroma_client() -> chromadb.ClientAPI:
    """Create a persistent ChromaDB client backed by the local filesystem.

    PersistentClient writes embeddings to CHROMA_DIR, so uploaded notes
    survive across process restarts — no need to re-ingest every session.
    """
    return chromadb.PersistentClient(path=CHROMA_DIR)


def add_documents(chunks: list[Document]) -> Chroma:
    """Embed text chunks and store them in the vector database.

    Chroma.from_documents() does three things:
    1. Passes each chunk's text through the embedding model
    2. Converts the text into numerical vectors
    3. Stores the vectors + original text in ChromaDB
    """
    return Chroma.from_documents(
        chunks,
        get_embedding_model(),
        client=get_chroma_client(),
        collection_name=COLLECTION_NAME,
    )


def get_vectorstore() -> Chroma:
    """Get a reference to the existing vector store for querying.

    Unlike add_documents(), this doesn't add data — it just connects
    to the existing collection so we can run similarity searches.
    """
    return Chroma(
        embedding_function=get_embedding_model(),
        client=get_chroma_client(),
        collection_name=COLLECTION_NAME,
    )


def _get_collection_or_none():
    """Return the study_notes collection, or None on a fresh install.

    Centralizes the "exists?" check so callers (clear/stats/remove) don't
    each re-implement the list-and-membership dance. Annotation dropped to
    avoid importing chromadb's internal Collection type just for a helper.
    """
    client = get_chroma_client()
    existing = {c.name for c in client.list_collections()}
    if COLLECTION_NAME not in existing:
        return None
    return client.get_collection(COLLECTION_NAME)


def clear_vectorstore() -> None:
    """Delete all stored vectors. Called before re-processing files.

    Checks collection existence first — avoids raising on a fresh install
    where the collection has never been created.
    """
    if _get_collection_or_none() is not None:
        get_chroma_client().delete_collection(COLLECTION_NAME)


def collection_stats() -> tuple[int, list[str]]:
    """Return (chunk_count, sorted_unique_source_filenames) for the persisted store.

    Used on app startup to auto-detect previously ingested notes so users
    don't need to re-upload every time Streamlit restarts.

    Note: pulls all metadatas to dedupe sources — O(n) memory. Fine at
    study-notes scale; revisit if collections grow past ~100k chunks.
    """
    col = _get_collection_or_none()
    if col is None:
        return 0, []

    count = col.count()
    if count == 0:
        return 0, []

    result = col.get(include=["metadatas"])
    sources = {
        os.path.basename(md["source"])
        for md in (result.get("metadatas") or [])
        if md and md.get("source")
    }
    return count, sorted(sources)


def remove_document(filename: str) -> int:
    """Delete all vectors whose source basename equals `filename`.

    Returns the number of chunks removed (0 if the collection or file is absent).
    Callers decrement any cached chunk count by this value.
    """
    col = _get_collection_or_none()
    if col is None:
        return 0
    result = col.get(include=["metadatas"])
    ids_to_delete = [
        cid
        for cid, md in zip(result["ids"], result.get("metadatas") or [])
        if md and os.path.basename(md.get("source", "")) == filename
    ]
    if ids_to_delete:
        col.delete(ids=ids_to_delete)
    return len(ids_to_delete)
