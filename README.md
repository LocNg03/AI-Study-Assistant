# AI Study Assistant

A local-first study tool that turns your lecture notes into an interactive Q&A, quiz, and flashcard generator. Upload a PDF / DOCX / TXT, ask questions, and the app retrieves the most relevant chunks of *your* notes and feeds them to a local LLM. Nothing leaves your machine.

## Why use it

- **Privacy** — runs entirely on your laptop. No OpenAI key, no notes uploaded to the cloud.
- **Grounded answers** — the LLM is forced to answer from your notes via Retrieval-Augmented Generation (RAG), not from its training data. If the answer isn't in your notes, it says so.
- **Three study modes** — Q&A for understanding, quizzes for self-testing, flashcards for spaced repetition.

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│  Streamlit   │ →  │  LangChain   │ →  │   ChromaDB      │ →  │  LM Studio   │
│   (app.py)   │    │   (rag.py)   │    │ (vectorstore.py)│    │  Gemma 4 E4B │
└──────────────┘    └──────────────┘    └─────────────────┘    └──────────────┘
       ↑                                         ↑
       │                                         │
   user upload  →  ingestion.py (chunk)  →  HuggingFace embeddings (MiniLM-L6-v2)
```

| Module | Responsibility |
|---|---|
| `app.py` | Streamlit UI: file upload, three feature tabs, session state |
| `ingestion.py` | Save uploads, dispatch the right loader (PDF/DOCX/TXT), chunk |
| `vectorstore.py` | Embedding model + ChromaDB persistence |
| `rag.py` | Retrieve top-k chunks → fill prompt → call LM Studio |
| `prompts.py` | Q&A / quiz / flashcard prompt templates |

## Prerequisites

- **Python 3.14** (other 3.11+ versions likely work but untested)
- **LM Studio** ([download](https://lmstudio.ai)) with a Gemma 4 E4B model loaded and the local server started on port `1234`
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
streamlit run app.py
```

App opens at <http://localhost:8501>.

## Usage

1. **Upload** PDFs, DOCX, or TXT files in the sidebar
2. Click **Process Files** — the app chunks the text (1000 chars / 200 overlap), embeds each chunk, and stores the vectors in `chroma_db/`
3. Use the tabs:
   - **Q&A** — ask a question; the app retrieves the 4 most relevant chunks and generates an answer
   - **Quiz** — give a topic + question count → multiple-choice quiz with answer key
   - **Flashcards** — give a topic + card count → front/back study cards

Notes persist across restarts. Use **Clear All Notes** in the sidebar to reset.

## Configuration

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | LM Studio server endpoint — change for remote hosts |
| `LM_STUDIO_MODEL` | `google/gemma-4-e4b` | Model identifier (LM Studio ignores this — uses currently-loaded model) |

Example:

```bash
export LM_STUDIO_URL=http://192.168.1.10:1234/v1
streamlit run app.py
```

### Tunable constants

Inference parameters live in `rag.py`:

| Setting | Default | Notes |
|---|---|---|
| `temperature` | `0.2` | Low → factual, sticks to source notes |
| `max_tokens` | `2048` | Output cap — fits 5–10 quiz questions within 8192 context |
| `QA_K` / `QUIZ_K` / `FLASH_K` | `4` / `5` / `5` | How many chunks to retrieve per query |
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
├── app.py              # Streamlit UI
├── rag.py              # Retrieval + LLM calls
├── ingestion.py        # File loading + chunking
├── vectorstore.py      # ChromaDB + embeddings
├── prompts.py          # Prompt templates
├── requirements.txt
├── chroma_db/          # Persisted vector index (gitignored)
└── uploads/            # Uploaded originals (gitignored)
```

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| "Cannot reach LM Studio" | Server not running. LM Studio → Developer → Start Server |
| First run hangs | Downloading the embedding model. Check `~/.cache/huggingface/` |
| "No relevant content found" | Retrieval missed; try a more specific query or upload more notes |
| Slow on first question | LM Studio cold-start; subsequent queries are faster |

## License

MIT
