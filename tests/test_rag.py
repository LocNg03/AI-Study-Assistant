"""Tests for rag.py — retrieval, streaming, and error handling.

Unlike test_vectorstore.py (which hits a real ChromaDB + real embeddings),
these tests mock the LLM and vectorstore. This is the correct boundary:
we're testing that rag.py handles responses and errors properly, not
testing the LLM or embedding model themselves.
"""

from unittest.mock import MagicMock, patch

from httpx import ConnectError, ReadTimeout

import rag


# ── retrieve_context ──


def test_retrieve_context_empty_store_returns_empty_string():
    """No similar chunks found → empty string, not None."""
    with patch.object(rag, "get_vectorstore") as mock_vs:
        mock_vs.return_value.similarity_search.return_value = []
        result = rag.retrieve_context("any question")
        assert result == ""


def test_retrieve_context_joins_chunks_with_double_newline():
    with patch.object(rag, "get_vectorstore") as mock_vs:
        doc1 = MagicMock(page_content="chunk one")
        doc2 = MagicMock(page_content="chunk two")
        mock_vs.return_value.similarity_search.return_value = [doc1, doc2]

        result = rag.retrieve_context("test", k=2)

        assert result == "chunk one\n\nchunk two"


def test_retrieve_context_passes_k_to_similarity_search():
    with patch.object(rag, "get_vectorstore") as mock_vs:
        mock_vs.return_value.similarity_search.return_value = []
        rag.retrieve_context("query", k=7)

        mock_vs.return_value.similarity_search.assert_called_once_with("query", k=7)


# ── No-context fallback (all three features) ──


def test_ask_question_no_context_yields_warning():
    with patch.object(rag, "retrieve_context", return_value=""):
        result = list(rag.ask_question("unknown topic"))
        assert result == [rag.NO_CONTEXT_MSG]


def test_generate_quiz_no_context_yields_warning():
    with patch.object(rag, "retrieve_context", return_value=""):
        result = list(rag.generate_quiz("unknown"))
        assert result == [rag.NO_CONTEXT_MSG]


def test_generate_flashcards_no_context_yields_warning():
    with patch.object(rag, "retrieve_context", return_value=""):
        result = list(rag.generate_flashcards("unknown"))
        assert result == [rag.NO_CONTEXT_MSG]


# ── _safe_stream: normal flow ──


def test_safe_stream_yields_content_chunks():
    """Normal path: LLM streams chunks, each yielded to the caller."""
    with patch.object(rag, "get_llm") as mock_llm:
        chunk1 = MagicMock(content="Hello ")
        chunk2 = MagicMock(content="world")
        mock_llm.return_value.stream.return_value = [chunk1, chunk2]

        result = list(rag._safe_stream("test prompt"))

        assert result == ["Hello ", "world"]


def test_safe_stream_skips_empty_chunks():
    """Empty content chunks (keepalives) must not be yielded."""
    with patch.object(rag, "get_llm") as mock_llm:
        chunk1 = MagicMock(content="data")
        chunk2 = MagicMock(content="")
        chunk3 = MagicMock(content="more")
        mock_llm.return_value.stream.return_value = [chunk1, chunk2, chunk3]

        result = list(rag._safe_stream("prompt"))

        assert result == ["data", "more"]


# ── _safe_stream: error handling ──


def test_safe_stream_connect_error_yields_friendly_message():
    """LM Studio offline → ConnectError → user sees actionable message."""
    with patch.object(rag, "get_llm") as mock_llm:
        mock_llm.return_value.stream.side_effect = ConnectError("refused")

        result = list(rag._safe_stream("prompt"))

        assert len(result) == 1
        assert "Cannot reach LM Studio" in result[0]


def test_safe_stream_timeout_yields_friendly_message():
    """LLM too slow → ReadTimeout → user sees timeout message."""
    with patch.object(rag, "get_llm") as mock_llm:
        mock_llm.return_value.stream.side_effect = ReadTimeout("timed out")

        result = list(rag._safe_stream("prompt"))

        assert len(result) == 1
        assert "timed out" in result[0]
