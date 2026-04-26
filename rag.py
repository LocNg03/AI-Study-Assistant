"""
RAG (Retrieval-Augmented Generation) Module
============================================
This is the core AI logic. Instead of asking the LLM to answer from its
general knowledge, we first RETRIEVE relevant chunks from the user's notes,
then pass those chunks as CONTEXT to the LLM so it answers based on the notes.

Flow: User question -> similarity search in ChromaDB -> top-k chunks retrieved
      -> chunks + question inserted into prompt template -> LLM generates answer

Backend: LM Studio running locally on port 1234 (OpenAI-compatible API).
Load the Gemma 4 E4B model in LM Studio and click "Start Server".
"""

import os
import random
from functools import lru_cache
from typing import Iterator

from httpx import ConnectError, ReadTimeout
from langchain_core.documents import Document
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIStatusError
from prompts import (
    FLASHCARD_TEMPLATE,
    QA_TEMPLATE,
    QUIZ_TEMPLATE,
    TOPIC_SUGGESTION_TEMPLATE,
)
from vectorstore import COLLECTION_NAME, get_chroma_client, get_vectorstore

# Type alias for the streaming return type. Bound at module scope so autoflake-style
# formatters don't strip the import thinking it's unused (it only appears in annotations).
StreamChunks = Iterator[str]

# Retrieval depth for all features. k=5 keeps context ~1.2k tokens, leaving
# headroom inside an 8k ctx window. Single knob today — split into per-feature
# constants only if quiz/flashcard generation ever needs a different depth.
RETRIEVAL_K = 5

# LM Studio's OpenAI-compatible endpoint. The `model` field is ignored by LM Studio —
# it always uses whichever model is currently loaded in the UI.
# Override via env vars, e.g.: `export LM_STUDIO_URL=http://192.168.1.10:1234/v1`
LM_STUDIO_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234/v1")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "google/gemma-4-e4b")


@lru_cache(maxsize=1)
def get_llm() -> ChatOpenAI:
    """Connect to LM Studio's local OpenAI-compatible server.

    Sampling is owned here, not by the LM Studio UI preset: when an external
    client sends explicit values, llama.cpp ignores the preset for that call.
    Keeping the knobs in code makes behavior reproducible across machines.

    - temperature=0.2: factual — quote the notes, don't invent.
    - top_p=0.9: nucleus sampling for focused output.
    - max_tokens=4096: OUTPUT cap only — NOT the total budget. llama.cpp
      enforces `input + max_tokens <= ctx_window`, so setting this equal to
      the 8k context window would leave zero room for the prompt. A typical
      call uses ~1.5k input (template + 5 retrieved chunks + question);
      4096 covers the worst-case 25-question quiz (~3k tokens out) while
      still leaving ~1k of headroom inside an 8k context window.
    - timeout=300: tolerates first-token latency on cold start.

    Note: no `frequency_penalty` — it compounds with llama.cpp's default
    repeat_penalty (1.1) and causes awkward word-avoidance in flashcards.
    """
    return ChatOpenAI(
        base_url=LM_STUDIO_URL,
        api_key="lm-studio",  # LM Studio accepts any non-empty string
        model=LM_STUDIO_MODEL,
        temperature=0.2,
        top_p=0.9,
        max_tokens=4096,
        timeout=300,
    )


NO_CONTEXT_MSG = (
    "⚠️ No relevant content found in your notes for that query. "
    "Try rephrasing, or upload notes that cover this topic."
)


def retrieve_context(query: str, k: int = 4) -> str:
    """Find the k most relevant chunks from the vector store.

    1. The query is converted to a vector (same embedding model used during ingestion)
    2. ChromaDB finds the k nearest vectors (most semantically similar chunks)
    3. The chunk texts are joined into a single context string

    Returns an empty string if the store has no matches; callers should guard.
    """
    return "\n\n".join(doc.page_content for doc in retrieve_docs(query, k=k))


def retrieve_docs(query: str, k: int = 4) -> list[Document]:
    """Return the k most relevant Document objects with their metadata intact.

    Used by API callers that need page numbers / source filenames for citations,
    not just the joined text that retrieve_context returns.
    """
    return get_vectorstore().similarity_search(query, k=k)


def ask_question(question: str) -> StreamChunks:
    """Stream a RAG answer chunk-by-chunk from the LLM."""
    context = retrieve_context(question, k=RETRIEVAL_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = QA_TEMPLATE.format(context=context, question=question)
    yield from _safe_stream(prompt)


def generate_quiz(topic: str, num_questions: int = 10) -> StreamChunks:
    """Stream multiple-choice quiz questions from the notes."""
    context = retrieve_context(topic, k=RETRIEVAL_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = QUIZ_TEMPLATE.format(
        topic=topic, context=context, num_questions=num_questions
    )
    yield from _safe_stream(prompt)


def generate_flashcards(topic: str, num_cards: int = 10) -> StreamChunks:
    """Stream study flashcards (front/back pairs) from the notes."""
    context = retrieve_context(topic, k=RETRIEVAL_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = FLASHCARD_TEMPLATE.format(
        topic=topic, context=context, num_cards=num_cards
    )
    yield from _safe_stream(prompt)


def chunks_to_citations(docs: list[Document]) -> dict[str, dict]:
    """Build a citation map ({id: {doc, page, excerpt}}) from retrieved documents.

    The frontend renders citation pills by id and looks up rich info in this map.
    `page` may be missing (non-PDF loaders don't set it) — the UI falls back to
    just the filename in that case.
    """
    out: dict[str, dict] = {}
    for i, doc in enumerate(docs, start=1):
        meta = doc.metadata or {}
        source = os.path.basename(meta.get("source", "")) or "source"
        # PyPDFLoader sets page as 0-based int. Present to users as 1-based.
        page = meta.get("page")
        out[f"c{i}"] = {
            "doc": source,
            "page": (page + 1) if isinstance(page, int) else None,
            "excerpt": doc.page_content[:600],
        }
    return out


def generate_quiz_structured(topic: str, num_questions: int = 5) -> dict:
    """Run generate_quiz, parse the markdown, and attach chunk citations.

    Returns {"questions": [...], "chunks": {c1: {...}, ...}} or {"error": msg}.
    Citations are round-robin'd across retrieved chunks — the model doesn't
    tell us which chunk each question came from, so this is a best-effort map.
    """
    from parsers import parse_quiz

    docs = retrieve_docs(topic, k=RETRIEVAL_K)
    if not docs:
        return {"error": NO_CONTEXT_MSG}

    context = "\n\n".join(d.page_content for d in docs)
    prompt = QUIZ_TEMPLATE.format(
        topic=topic, context=context, num_questions=num_questions
    )
    text = _safe_invoke(prompt)
    questions = parse_quiz(text)

    chunk_ids = [f"c{i + 1}" for i in range(len(docs))]
    for i, q in enumerate(questions):
        q["cite"] = chunk_ids[i % len(chunk_ids)] if chunk_ids else ""

    return {"questions": questions, "chunks": chunks_to_citations(docs)}


def generate_flashcards_structured(topic: str, num_cards: int = 5) -> dict:
    """Run generate_flashcards, parse, and attach citations. Same shape as quiz."""
    from parsers import parse_flashcards

    docs = retrieve_docs(topic, k=RETRIEVAL_K)
    if not docs:
        return {"error": NO_CONTEXT_MSG}

    context = "\n\n".join(d.page_content for d in docs)
    prompt = FLASHCARD_TEMPLATE.format(
        topic=topic, context=context, num_cards=num_cards
    )
    text = _safe_invoke(prompt)
    cards = parse_flashcards(text, tag=topic[:24])

    chunk_ids = [f"c{i + 1}" for i in range(len(docs))]
    for i, c in enumerate(cards):
        c["cite"] = chunk_ids[i % len(chunk_ids)] if chunk_ids else ""

    return {"cards": cards, "chunks": chunks_to_citations(docs)}


def _safe_invoke(prompt: str) -> str:
    """Non-streaming LLM call that returns a single string (empty on failure).

    Parsers need the whole response before they can split it, so we block here
    rather than streaming. Errors become empty strings — the parser then yields
    zero items and the API layer reports a friendly message.
    """
    try:
        response = get_llm().invoke(prompt)
        return response.content if hasattr(response, "content") else str(response)
    except (ConnectError, APIConnectionError, APIStatusError, ReadTimeout):
        return ""


def _safe_stream(prompt: str) -> StreamChunks:
    """Stream LLM output chunk-by-chunk, converting errors into user-friendly messages.

    Exceptions must be caught *inside* the generator because the network call
    only runs during iteration — not when the generator object is created.
    """
    try:
        for chunk in get_llm().stream(prompt):
            content = chunk.content if hasattr(chunk, "content") else str(chunk)
            if content:
                yield content
    except (ConnectError, APIConnectionError):
        yield (
            "⚠️ Cannot reach LM Studio. Open LM Studio → Developer tab → Start Server."
        )
    except APIStatusError as e:
        yield f"⚠️ LM Studio error: {e.message}"
    except ReadTimeout:
        yield "⚠️ LLM response timed out. Try a shorter question or smaller k."


def suggest_topics(n: int = 5) -> list[str]:
    """Ask the LLM for the n most prominent study topics in the corpus.

    Samples up to 10 chunks for broad coverage (not top-k of a query, which
    would bias toward one theme), sends them to Gemma with a minimal-format
    prompt, and parses the comma-separated reply. Returns [] on any failure —
    this is a UI nicety, not a core path, so the app must not crash when it
    misfires (LM Studio offline, empty store, malformed LLM output, etc.).
    """
    try:
        client = get_chroma_client()
        existing = {c.name for c in client.list_collections()}
        if COLLECTION_NAME not in existing:
            return []
        col = client.get_collection(COLLECTION_NAME)
        if col.count() == 0:
            return []

        docs = col.get(include=["documents"]).get("documents") or []
        if not docs:
            return []

        # random.sample can't take more than len(docs); guard with min().
        sample = random.sample(docs, min(10, len(docs)))
        context = "\n\n".join(sample)
        prompt = TOPIC_SUGGESTION_TEMPLATE.format(n=n, context=context)

        response = get_llm().invoke(prompt)
        raw = response.content if hasattr(response, "content") else str(response)
        return _parse_topics(raw, n)
    except (ConnectError, APIConnectionError, APIStatusError, ReadTimeout):
        return []
    except Exception:
        return []


def _parse_topics(raw: str, n: int) -> list[str]:
    """Extract a clean list of topic strings from the LLM's reply.

    Robust against the model disobeying the "comma-separated only" instruction:
    also splits on newlines, strips bullets / numbering / leading labels, and
    drops runaway output longer than 60 chars (a sign the model wrote prose).
    """
    text = raw.strip()
    # Strip a leading "Topics:" label if the model echoed it.
    for prefix in ("Topics:", "topics:", "Output:"):
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix) :].strip()
            break

    parts = text.replace("\n", ",").split(",")
    topics: list[str] = []
    for p in parts:
        cleaned = p.strip(" -•*\t").lstrip("0123456789.)").strip()
        if cleaned and 2 <= len(cleaned) <= 60:
            topics.append(cleaned)
    return topics[:n]
