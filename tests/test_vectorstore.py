"""Tests for vectorstore.py — ChromaDB persistence and stats.

These tests hit a real ChromaDB instance in a tmp dir and load the real
embedding model. First run downloads ~80MB; subsequent runs use the
HuggingFace cache. Slower than mocks but tests real integration behavior.
"""

import pytest
from langchain_core.documents import Document

import vectorstore


@pytest.fixture
def isolated_chroma(tmp_path, monkeypatch):
    """Redirect ChromaDB to a tmp dir and reset the lru_cache singletons.

    @lru_cache caches the client at module level, so without clearing it
    after the path swap, subsequent tests would still use the cached
    client pointing at the previous test's tmp dir.
    """
    monkeypatch.setattr(vectorstore, "CHROMA_DIR", str(tmp_path / "chroma"))
    vectorstore.get_chroma_client.cache_clear()
    vectorstore.get_embedding_model.cache_clear()
    yield
    vectorstore.get_chroma_client.cache_clear()
    vectorstore.get_embedding_model.cache_clear()


def test_collection_stats_empty_returns_zero(isolated_chroma):
    count, sources = vectorstore.collection_stats()
    assert count == 0
    assert sources == []


def test_clear_vectorstore_no_collection_is_noop(isolated_chroma):
    """Fresh install: no collection exists yet. Should not raise."""
    vectorstore.clear_vectorstore()


def test_add_documents_then_stats_reports_count_and_sources(isolated_chroma):
    docs = [
        Document(
            page_content="The CPU executes instructions sequentially.",
            metadata={"source": "/notes/cpu.txt"},
        ),
        Document(
            page_content="Cache memory is faster than main memory.",
            metadata={"source": "/notes/cache.txt"},
        ),
        Document(
            page_content="Pipelining overlaps instruction execution stages.",
            metadata={"source": "/notes/cpu.txt"},
        ),
    ]

    vectorstore.add_documents(docs)
    count, sources = vectorstore.collection_stats()

    assert count == 3
    # Sources are deduped by basename and sorted
    assert sources == ["cache.txt", "cpu.txt"]


def test_clear_vectorstore_removes_added_documents(isolated_chroma):
    docs = [
        Document(page_content="Test chunk", metadata={"source": "/notes/x.txt"}),
    ]
    vectorstore.add_documents(docs)
    assert vectorstore.collection_stats()[0] == 1

    vectorstore.clear_vectorstore()

    assert vectorstore.collection_stats() == (0, [])


def test_similarity_search_returns_relevant_chunks(isolated_chroma):
    """End-to-end: add docs, query, expect the most relevant chunk back."""
    docs = [
        Document(page_content="Photosynthesis converts light into chemical energy."),
        Document(page_content="The mitochondria is the powerhouse of the cell."),
        Document(page_content="CPUs execute machine instructions."),
    ]
    vectorstore.add_documents(docs)

    store = vectorstore.get_vectorstore()
    results = store.similarity_search("how do plants make food?", k=1)

    assert len(results) == 1
    assert "Photosynthesis" in results[0].page_content
