# AI Study Assistant

A local-first study tool that turns your lecture notes into an interactive Q&A, quiz, and flashcard generator. Upload a PDF / DOCX / TXT, ask questions, and the app retrieves the most relevant chunks of *your* notes and feeds them to a local LLM. Nothing leaves your machine.

## Why use it

- **Privacy** — runs entirely on your laptop. No OpenAI key, no notes uploaded to the cloud.
- **Grounded answers** — the LLM is forced to answer from your notes via Retrieval-Augmented Generation (RAG), not from its training data. If the answer isn't in your notes, it says so.
- **Three study modes** — Q&A for understanding, quizzes for self-testing, flashcards for spaced repetition.

## Architecture

```
┌──────────────┐  HTTP/NDJSON   ┌──────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│  React UI    │ ─────────────→ │  FastAPI     │ →  │  LangChain   │ →  │   ChromaDB      │ →  │  LM Studio   │
│ (bundle.jsx) │ ←───────────── │  (server.py) │    │   (rag.py)   │    │ (vectorstore.py)│    │  Gemma 4 E4B │
└──────────────┘  tokens stream └──────────────┘    └──────────────┘    └─────────────────┘    └──────────────┘
                                       ↑                                         ↑
                                       │                                         │
                                  user upload  →  ingestion.py (chunk)  →  HuggingFace embeddings (MiniLM-L6-v2)
```

| Module | Responsibility |
|---|---|
| `frontend/index.html` + `src/bundle.jsx` | React 18 UI (Babel-in-browser, no build step): sidebar, Q&A, quiz, flashcards, citations drawer |
| `server.py` | FastAPI HTTP layer — `/api/ask` streams NDJSON, `/api/quiz` & `/api/flashcards` return JSON, plus doc CRUD |
| `parsers.py` | Tolerant markdown→JSON parsers for quiz and flashcard LLM output |
| `ingestion.py` | Save uploads, dispatch the right loader (PDF/DOCX/TXT), chunk |
| `vectorstore.py` | Embedding model + ChromaDB persistence |
| `rag.py` | Retrieve top-k chunks → fill prompt → call LM Studio |
| `prompts.py` | Q&A / quiz / flashcard prompt templates |

## Prerequisites

- **Python 3.14** (other 3.11+ versions likely work but untested)
- **LM Studio** ([download](https://lmstudio.ai)) with a Gemma 4 E4B model loaded and the local server started on port `1234`
- A modern browser (Chrome/Safari/Firefox) — the frontend uses Babel Standalone to transpile JSX in-browser, so there's **no Node / npm build step**
- ~1 GB free disk for the embedding model + ChromaDB index

<details>
<summary><b>LM Studio setup (one-time, ~5 min)</b></summary>

1. Open LM Studio
2. **Discover** tab → search `gemma-4-e4b` → download (~3 GB)
3. **Developer** tab → load the model → click **Start Server**
4. Confirm it's running: `curl http://localhost:1234/v1/models` should return JSON

</details>

## Install

```bash
git clone <this-repo>
cd ai-study-assistant
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

First run downloads the embedding model (`all-MiniLM-L6-v2`, ~80 MB) from HuggingFace.

## Run

```bash
uvicorn server:app --reload --port 8000
```

Open <http://localhost:8000>. FastAPI serves the React UI from `frontend/` and the JSON/NDJSON API from `/api/*` — single origin, no CORS setup needed.

## Usage

1. Click **Upload** (or press `U`) and drop in PDFs, DOCX, or TXT files. Each is chunked (1000 chars / 200 overlap), embedded, and stored in `chroma_db/`.
2. Switch study mode with the number keys or tabs:
   - **1 — Q&A** — type a question. Answers stream token-by-token (NDJSON); click the numbered citation pills to see the exact chunk it drew from.
   - **2 — Quiz** — pick a topic and a question count (3 / 5 / 10) → multiple-choice quiz scored inline.
   - **3 — Flashcards** — pick a topic and a card count → flip through front/back pairs (arrow keys / space).
3. The sidebar shows every indexed file with its chunk count and size. The trash icon removes one file; **Clear All** wipes the whole index.

Notes persist across restarts. The citations drawer (top right of a Q&A turn) lists the chunks, page numbers (for PDFs), and excerpts that grounded the answer.

## Configuration

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | LM Studio server endpoint — change for remote hosts |
| `LM_STUDIO_MODEL` | `google/gemma-4-e4b` | Model identifier (LM Studio ignores this — uses currently-loaded model) |

Example:

```bash
export LM_STUDIO_URL=http://192.168.1.10:1234/v1
uvicorn server:app --reload --port 8000
```

### Tunable constants

Inference parameters live in `rag.py`:

| Setting | Default | Notes |
|---|---|---|
| `temperature` | `0.2` | Low → factual, sticks to source notes |
| `max_tokens` | `4096` | **Output** cap (not total). Must satisfy `input + max_tokens ≤ ctx_window`. 4096 covers up to a 25-question quiz inside an 8k context window. |
| `RETRIEVAL_K` | `5` | How many chunks to retrieve per query (shared by Q&A, quiz, flashcards) |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `200` | Set in `ingestion.py` |

## Testing

```bash
pip install -r requirements-dev.txt
pytest
```

23 tests cover file ingestion (chunking, collision handling, path-traversal protection), RAG orchestration (retrieval, streaming, error handling), and vector store lifecycle (add, clear, similarity search). Tests use `tmp_path` fixtures for isolation, mocks for the LLM layer, and a real ChromaDB instance for integration coverage.

> **Behind a proxy?** If your environment uses a SOCKS proxy, HuggingFace may try to re-check the embedding model and fail. The embedding model is cached after first use — force offline mode to skip the network check:
> ```bash
> HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 pytest
> ```

## Project layout

```
ai-study-assistant/
├── server.py             # FastAPI app: /api/* + static frontend mount
├── rag.py                # Retrieval + LLM calls + structured quiz/flashcards
├── parsers.py            # LLM markdown → JSON (quiz, flashcards)
├── ingestion.py          # File loading + chunking
├── vectorstore.py        # ChromaDB + embeddings
├── prompts.py            # Prompt templates
├── frontend/
│   ├── index.html        # React shell, loads Babel Standalone + bundle.jsx
│   └── src/bundle.jsx    # Single-file React app (sidebar, Q&A, quiz, flashcards)
├── docs/                 # Project docs (presentation, justification guide)
├── tests/
├── requirements.txt
├── chroma_db/            # Persisted vector index (gitignored)
└── uploads/              # Uploaded originals (gitignored)
```

### HTTP API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/documents` | — | `{documents: [{id, name, chunks, size, addedAt, status}]}` |
| `POST` | `/api/upload` | multipart `file` | `{ok, name, chunks}` |
| `DELETE` | `/api/documents/{name}` | — | `{removed}` |
| `POST` | `/api/clear` | — | `{ok}` |
| `POST` | `/api/ask` | `{question}` | NDJSON stream: `{type:"chunks",data}`, `{type:"token",text}`, `{type:"done"\|"error"}` |
| `POST` | `/api/quiz` | `{topic, count}` | `{questions:[...], chunks:{c1:{...}}}` |
| `POST` | `/api/flashcards` | `{topic, count}` | `{cards:[...], chunks:{c1:{...}}}` |
| `GET` | `/api/topics?n=5` | — | `{topics: [string, ...]}` |

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| "Cannot reach LM Studio" | Server not running. LM Studio → Developer → Start Server |
| First run hangs | Downloading the embedding model. Check `~/.cache/huggingface/` |
| "No relevant content found" | Retrieval missed; try a more specific query or upload more notes |
| Slow on first question | LM Studio cold-start; subsequent queries are faster |
| Blank page at <http://localhost:8000> | Browser couldn't load Babel / React from CDN. Check devtools network tab — CDN host blocked or offline. |
| `/api/upload` returns 500 at startup | `python-multipart` missing. Run `pip install -r requirements.txt` again. |
| NDJSON stream hangs | LM Studio's `max_tokens` in `rag.py` + retrieval context hit the 8k ctx window. Shorten the question or reduce `RETRIEVAL_K`. |

## License

MIT
