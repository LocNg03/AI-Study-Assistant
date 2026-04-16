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
from typing import Iterator

import streamlit as st
from httpx import ConnectError, ReadTimeout
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIStatusError

from prompts import FLASHCARD_TEMPLATE, QA_TEMPLATE, QUIZ_TEMPLATE
from vectorstore import get_vectorstore

# Type alias for the streaming return type. Bound at module scope so autoflake-style
# formatters don't strip the import thinking it's unused (it only appears in annotations).
StreamChunks = Iterator[str]

# Retrieval depth per feature. Lower k = smaller prompt = less RAM during generation.
QA_K = 4
QUIZ_K = 5
FLASH_K = 5

# LM Studio's OpenAI-compatible endpoint. The `model` field is ignored by LM Studio —
# it always uses whichever model is currently loaded in the UI.
# Override via env vars, e.g.: `export LM_STUDIO_URL=http://192.168.1.10:1234/v1`
LM_STUDIO_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234/v1")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "google/gemma-4-e4b")


@st.cache_resource  # Cache so the LLM connection is created only once
def get_llm() -> ChatOpenAI:
    """Connect to LM Studio's local OpenAI-compatible server.

    Inference parameters tuned for RAG over study notes on an M3 18 GB Mac:
    - temperature=0.2: highly factual — LLM should quote the notes, not invent
    - top_p=0.9: nucleus sampling for focused output
    - frequency_penalty=0.3: reduce word repetition in long flashcard lists
    - presence_penalty=0.0: don't force topic diversity (we want notes-aligned answers)
    - max_tokens=2048: cap output length to save RAM and latency
    - timeout=120: generous timeout for first-token latency after model cold-start
    """
    return ChatOpenAI(
        base_url=LM_STUDIO_URL,
        api_key="lm-studio",  # LM Studio accepts any non-empty string
        model=LM_STUDIO_MODEL,
        temperature=0.2,
        top_p=0.9,
        frequency_penalty=0.3,
        presence_penalty=0.0,
        max_tokens=2048,
        timeout=120,
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
    vectorstore = get_vectorstore()
    docs = vectorstore.similarity_search(query, k=k)
    return "\n\n".join(doc.page_content for doc in docs)


def ask_question(question: str) -> StreamChunks:
    """Stream a RAG answer chunk-by-chunk from the LLM."""
    context = retrieve_context(question, k=QA_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = QA_TEMPLATE.format(context=context, question=question)
    yield from _safe_stream(prompt)


def generate_quiz(topic: str, num_questions: int = 10) -> StreamChunks:
    """Stream multiple-choice quiz questions from the notes."""
    context = retrieve_context(topic, k=QUIZ_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = QUIZ_TEMPLATE.format(
        topic=topic, context=context, num_questions=num_questions
    )
    yield from _safe_stream(prompt)


def generate_flashcards(topic: str, num_cards: int = 10) -> StreamChunks:
    """Stream study flashcards (front/back pairs) from the notes."""
    context = retrieve_context(topic, k=FLASH_K)
    if not context:
        yield NO_CONTEXT_MSG
        return
    prompt = FLASHCARD_TEMPLATE.format(
        topic=topic, context=context, num_cards=num_cards
    )
    yield from _safe_stream(prompt)


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
