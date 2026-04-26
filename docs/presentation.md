# AI Study Assistant — Presentation Kit

**Presenter:** Loc (Steve) Nguyen • Troy University
**Presentation date:** 2026-04-27 (Monday)
**Target length:** ~11 minutes (core script). Cut §6 or §9 for 10 min; expand §5 for 14 min.
**Assumed audience:** CS / Data Science peers + professor (moderate technical depth — "RAG" and "embedding" OK, but defined once).
**Assumed demo mode:** Live demo with screenshot fallback on Slide 8.

---

## Part 1 — Speaker Script

> **Delivery notes**
> • Speak at ~140 words/min. Pauses = breathing room, not filler.
> • **Bold** = emphasize. `[brackets]` = stage direction.
> • Slide change markers in `⟦…⟧`.
> • Total time budget: 11:10. Buffer: 50s. (Slide 2 "Hook" removed — straight into substance.)

---

### ⟦Slide 1 — Title⟧  *(20s)*

Good morning, everyone. I'm Loc Nguyen, and today I'm presenting **AI Study Assistant** — a local-first tool I built that turns your lecture notes into an interactive Q&A, quiz, and flashcard generator. Over the next eleven minutes I'll cover what it does, how it works under the hood, one significant architectural pivot I made mid-project, and a live demo at the end.

---

### ⟦Slide 2 — Why existing tools fall short⟧  *(50s)*

You might ask: why not just use ChatGPT? Or Gemini? Or Notion AI? I tried all three, and they fail in three specific ways.

**First, hallucination.** General-purpose LLMs answer from whatever they remember — not from *your professor's slides*. For studying, that's dangerous.

**Second, privacy.** Any cloud AI requires uploading your notes to someone else's server.

**Third, manual effort.** Making flashcards by hand is a chore. Most students skip it.

I wanted a tool that was **grounded in my own notes**, **ran on my own machine**, and **generated study materials automatically**. Nothing off-the-shelf hit all three.

---

### ⟦Slide 3 — The Solution⟧  *(50s)*

So I built AI Study Assistant. You drag a PDF, DOCX, or TXT file into the sidebar. The app chunks it, embeds it, and indexes it locally. Then you get three study modes:

- **Q&A** — ask any question, get an answer drawn from your notes, **with citations** — you can click a number and see the exact paragraph it drew from.
- **Quiz** — give it a topic and a count, get multiple-choice questions with an answer key.
- **Flashcards** — front-and-back study cards, same idea.

Two properties I want to highlight:
- If the answer isn't in your notes, **the app refuses to guess**. It says "I couldn't find this in your notes."
- Nothing leaves your laptop. No API key. No cloud upload.

---

### ⟦Slide 4 — Architecture⟧  *(80s)*

Here's the data flow. Five components, two halves.

*[point to diagram]*

The **frontend** is a React single-page app — served by **FastAPI**, which is also the backend. One origin, no CORS wiring. The middle box labeled "RAG orchestration" is `rag.py` — it's where retrieval, prompt assembly, and the LLM call live. I use a few LangChain primitives inside it (loaders, prompt templates, the OpenAI-compatible client) — so think of LangChain as a library *inside* that box, not a separate service.

On the **backend side**:

1. You upload a file. **Ingestion** saves it, picks the right loader for the extension, and splits it into overlapping chunks of about a thousand characters each — with two hundred characters of overlap.
2. Each chunk goes through an **embedding model** — HuggingFace's MiniLM-L6-v2. Think of it as a function that takes a paragraph and gives it coordinates on a giant map. Paragraphs about similar ideas land near each other. In this case, the map has **384 dimensions** — don't worry about the number; just know that "closer on the map" means "more similar in meaning."
3. Those vectors persist in **ChromaDB**, an on-disk vector database.
4. When you ask a question, the question is embedded the same way. ChromaDB finds the nearest chunks. Those chunks go to **LM Studio**, running Google's **Gemma 4 E4B** model locally — and Gemma streams back an answer grounded in those chunks, token by token, over an NDJSON stream.

One detail worth explaining: *why the overlap in chunking?* Because if a concept straddles a chunk boundary, without overlap, retrieval returns one half without the other. Two hundred characters of overlap means the full concept survives either way.

---

### ⟦Slide 5 — RAG Deep Dive⟧  *(110s)*

This pattern has a name: **Retrieval-Augmented Generation**, or **RAG**. It's the most important idea in this project, and I want to spend two minutes on it.

And here's why — even if you never touch this app: if you understand RAG, you understand **the dominant pattern behind nearly every AI product shipping in 2026** — chatbots, copilots, enterprise search. Same three steps everywhere.

A traditional LLM answers from its **parameters** — weights learned during training. It doesn't know where its answers came from, and it can't cite sources. That's why it hallucinates.

RAG flips this. Let me make it concrete. Say my notes contain this paragraph: *"Cache coherence ensures all CPU cores see the same value when one writes to shared memory."* That paragraph is one **chunk**. Now I ask *"what is cache coherence?"* RAG does three things:

1. **Retrieve** — find the most relevant chunks of the user's notes using vector similarity.
2. **Augment** — inject those chunks into the prompt as context.
3. **Generate** — the LLM writes an answer using that context as the source of truth.

In my prompt template, I literally tell Gemma: *"Use ONLY the context below. If the notes don't cover it, say 'I couldn't find this in your notes' and stop — don't invent."* That one line is the **anti-hallucination guard**.

One question that comes up: *"Is retrieval just keyword search?"* No. Because we're comparing embeddings — not words — something interesting happens.

*[pause]*

If I ask *"how does the CPU remember things?"*, the retriever finds a paragraph titled *"registers and cache hierarchy."*

*[pause]*

Those two phrases share **zero keywords**. That's the difference between Ctrl-F and semantic search.

---

### ⟦Slide 6 — The Architectural Pivot⟧  *(60s)*

I want to tell you about one significant decision I made mid-project.

I shipped v1 in **Streamlit** — a Python-only UI framework. Great for prototyping: I had the three tabs working in a weekend. But as I used it, two things bothered me. First, Streamlit reruns the entire script on every button click, which made the UX feel **flickery**. Second, I couldn't build the one feature I really wanted: **clickable citation pills** that pop open the chunk that grounded an answer.

So I rebuilt the frontend in **React**, served by **FastAPI**. Token streaming uses NDJSON — newline-delimited JSON frames: first a citation map, then tokens as they arrive.

The key win wasn't the UI itself — it was that **I didn't have to rewrite the RAG core**. My retrieval, chunking, prompts, and vector-store code were already independent of any framework. All I had to do was replace Streamlit's caching with `lru_cache`, and the same code drove both UIs.

*[beat]*

That's a lesson that generalizes: **if your domain logic depends on your UI framework, you've coupled the wrong layers**.

---

### ⟦Slide 7 — Key Engineering Decisions⟧  *(60s)*

Every component was chosen for a specific reason. Three worth calling out.

**Why Gemma 4 E4B via LM Studio?** I have an 18-gigabyte M3 MacBook. E4B is a compressed **4-billion-parameter model** — small enough to fit in memory, fast enough to read along with. LM Studio exposes the same API as OpenAI, which means if I want to upgrade later, I swap the model file — **no code changes**.

**Why ChromaDB instead of Pinecone or FAISS?** Chroma runs embedded — no server process, no network calls, persists to a local folder. Perfect for a single-user app.

**Why MiniLM-L6-v2 for embeddings?** Eighty megabytes, 384-dimensional vectors, sweet spot between quality and RAM — and critically, no API key, so the "local" promise holds.

---

### ⟦Slide 8 — Live Demo⟧  *(110s)*

Let me show it live.

*[Demo sequence — rehearse this flow three times before the talk]*

1. Open **http://localhost:8000**. Click **Upload**, drop in a PDF of lecture notes. Watch the chunk count appear in the sidebar.
2. **Q&A mode** — type a specific question your audience can verify. Show tokens streaming in. Then **click a citation pill** — the drawer slides in with the exact chunk and page number. *This is the money shot. Pause here.*
3. **Quiz mode** — topic + 5 questions → generate. Point out the answer key.
4. **Flashcards mode** — topic + 3 cards → generate. Arrow-key through front/back.
5. Ask a **negative-control question** — something *not* in the notes. Show the app's refusal. This sells the "no hallucination" claim better than any slide.

*[If LM Studio drops mid-demo: fall back to screenshots on this slide, narrate what they'd be seeing. Do not panic. Say: "Networking hiccup — here's what you'd see."]*

---

### ⟦Slide 9 — Engineering Challenges⟧  *(80s)*

Three challenges worth sharing.

**One — chunk size tuning.** My first attempt used 500-character chunks. Retrieval returned fragments missing their context. I bumped to 2000 — the prompt overflowed an 8K context window. **1000 with 200 overlap** was the sweet spot. Empirical, not theoretical.

**Two — error handling inside Python generators.** Picture this: I wrap my LLM call in a try/except. The LLM crashes — and the error blows past my except block anyway. Why? Because the network call doesn't happen when you *write* the function — it happens when something *reads* from it. My try/except was guarding the wrong moment. Fix was three lines; finding it took an afternoon.

**Three — tolerant parsing of LLM output.** Small models like Gemma don't always obey format instructions perfectly — they'll drop an "Answer:" line or split a question across malformed newlines. My parsers are deliberately forgiving: they split on anchors I can trust, extract what matches, drop what doesn't. Losing one malformed question out of ten is fine; rejecting the whole batch is not.

---

### ⟦Slide 10 — Learnings & Future Work⟧  *(40s)*

**What I learned:**
- RAG is more **architecture** than machine learning. Most of the hard work is retrieval and prompt design, not model training.
- **Streaming output** dramatically changes perceived speed, even when total latency is identical.
- Decouple your **core logic from your UI framework** from day one. You will thank yourself when you rebuild the UI.

**What's next:**
- Conversational memory — multi-turn Q&A with follow-ups.
- OCR for handwritten notes.
- Spaced-repetition scheduling on top of flashcards.

---

### ⟦Slide 11 — Thank You / Q&A⟧  *(10s)*

Thank you. I'm happy to take questions.

---

## Part 2 — Slide-by-Slide Deck Content

> Paste these into PowerPoint / Keynote / Google Slides. Keep slides **visually sparse** — the audience should listen, not read.
> Rule of thumb: **max 6 bullets × max 8 words each**. If you need more, split into two slides.

---

### Slide 1 — Title
- **Title:** AI Study Assistant
- **Subtitle:** A Local-First RAG Tool for Turning Lecture Notes into Study Materials
- **Author line:** Loc (Steve) Nguyen • Troy University • 2026-04-27
- **Course tag:** [TODO: replace with your real course code — e.g. "CS 4420 · Final Project"] (top-left eyebrow label, monospace, uppercase)
- **Visual:** App hero screenshot — the React UI with sidebar + Q&A panel + open citation drawer.
- **Speaker note:** Introduce self, state duration, preview structure.

### Slide 2 — Why existing tools fall short
- **Title:** Why existing tools fail
- **Table:**

  | Tool | Fails because |
  |---|---|
  | ChatGPT / Gemini | Hallucinates, cloud-only |
  | Notion AI | Cloud upload required |
  | Manual flashcards | Tedious — most skip it |
  | Ctrl-F | Keyword-only, no semantics |

- **Visuals (use 2–3, not all — keep slide breathable):**
  1. **Logo strip** across the top: ChatGPT • Gemini • Notion AI • 📇 (flashcard) • 🔍 (Ctrl-F) — grayscale at 60% opacity to read as "the field," not endorsements.
  2. **Hallucination screenshot** (top-right, ~30% slide width): a real ChatGPT response confidently citing a fake page number or invented fact, with a red underline on the wrong span. *This is the strongest visual — proof beats assertion.*
  3. **Cloud-vs-local diagram** (bottom-left): a laptop icon with an arrow labeled *"your notes"* going up to a cloud labeled *"someone else's server"* — red dashed arrow + 🔒 broken-padlock icon.
  4. **Criteria grid** (right side, replaces plain red X's):

     |  | Grounded | Local | Auto-generates |
     |---|:---:|:---:|:---:|
     | ChatGPT / Gemini | ❌ | ❌ | ✅ |
     | Notion AI | ⚠️ | ❌ | ✅ |
     | Manual flashcards | ✅ | ✅ | ❌ |
     | Ctrl-F | ✅ | ✅ | ❌ |
     | **AI Study Assistant** | **✅** | **✅** | **✅** |

     Highlight the bottom row in the project's accent color — this is the **payoff visual** that sets up Slide 3.
- **Layout tip:** Title top → logo strip → split body (hallucination screenshot + cloud diagram on the left, criteria grid on the right) → no footer text. Resist adding the table *and* the grid — pick one. The grid is stronger because the last row previews the solution.
- **Speaker note:** Keep this tight. Point to the hallucination screenshot when you say "hallucination" — let the image do the work. The audience wants the "so what" on the next slide.

### Slide 3 — The Solution
- **Title:** AI Study Assistant — what it does
- **Bullets:**
  - Upload PDF / DOCX / TXT
  - Ask questions — answered *from your notes*, with citations
  - Auto-generate multiple-choice quizzes
  - Auto-generate flashcards
  - **Local. Grounded. Three study modes.**
- **Visual:** Animated GIF or screenshot stack showing the three modes.
- **Speaker note:** This is the "product pitch" slide. Confident delivery.

### Slide 4 — Architecture
- **Title:** How the data flows
- **Visual:** Cleaned-up diagram from README:
  ```
  ┌───────────┐  HTTP/NDJSON  ┌────────────┐    ┌────────────────┐    ┌───────────┐    ┌───────────┐
  │  React UI │ ────────────→ │  FastAPI   │ →  │ RAG orchestration│→ │ ChromaDB  │ →  │ LM Studio │
  │(bundle.jsx)│ ←──────────── │ (server.py)│    │    (rag.py)     │  │(vectorstore)│  │Gemma 4 E4B│
  └───────────┘  tokens stream └────────────┘    └────────────────┘    └───────────┘    └───────────┘
                                    ↑                                         ↑
                               user upload  →  ingestion.py  →  MiniLM-L6-v2 (embed)
  ```
- **Bullets (small, right margin):**
  - Chunks: 1000 chars, 200 overlap
  - Embeddings: 384-dim vectors
  - LLM: Gemma 4 E4B, local
  - Streaming: NDJSON frames
- **Speaker note:** Point to each box as you narrate. Don't read the diagram — walk through it.

### Slide 5 — RAG Deep Dive
- **Title:** Retrieval-Augmented Generation
- **Visual:** Three-step numbered flow:
  > **1. Retrieve** — find relevant chunks
  > **2. Augment** — inject chunks into prompt
  > **3. Generate** — LLM answers *from context*
- **Callout box:**
  > *"Use ONLY the context below. If the notes don't cover it, say 'I couldn't find this in your notes' and stop — don't invent."* — the anti-hallucination guard, verbatim from the Q&A prompt template (`prompts.py`).
- **Speaker note:** This is your **deepest technical slide**. Speak slowly. Look at the audience, not the slide.

### Slide 6 — The Architectural Pivot
- **Title:** Why I rebuilt the frontend
- **Two-column comparison:**

  **v1 — Streamlit**
  - Python-only, fast to prototype
  - Full-page rerun per click = flicker
  - No clickable citation drawer

  **v2 — React + FastAPI**
  - Token streaming via NDJSON
  - Interactive citation pills + drawer
  - Core RAG code **unchanged**
- **Callout:** "Decoupling RAG from the UI framework made the rebuild a UI swap, not a rewrite."
- **Speaker note:** This slide shows engineering judgment, not just execution. Deliver it with some pride — this is the slide that separates a homework project from a thought-through build.

### Slide 7 — Key Engineering Decisions
- **Title:** Key engineering decisions
- **Table:**

  | Component | Choice | Why |
  |---|---|---|
  | UI | React + FastAPI | Streaming, citation drawer, single-origin |
  | Vector DB | ChromaDB | Embedded, persistent, no server |
  | Embeddings | MiniLM-L6-v2 | 80 MB, local, no API key |
  | LLM | Gemma 4 E4B via LM Studio | Fits 18 GB, OpenAI-compatible API |
  | Orchestration | `rag.py` (uses LangChain primitives) | Swappable loaders + prompts |
- **Speaker note:** Don't read the table. Pick 2–3 rows and explain the *why*. Skip the rest.

### Slide 8 — Live Demo
- **Title:** Live Demo
- **Content:** Intentionally blank — or a single "Demo" in large font.
- **Visual:** Have **three backup screenshots** hidden on this slide so you can reveal them if the demo fails:
  - Q&A streaming output with citation drawer open
  - Quiz with answer key
  - Flashcard front/back pair
- **Speaker note:** Open the app **before** the talk. LM Studio server running. Model already warm (run one warm-up query beforehand). Have a sample PDF pre-indexed.

### Slide 9 — Engineering Challenges
- **Title:** What I wrestled with
- **Bullets:**
  - Chunk size: 500 → 2000 → **1000** (200 overlap)
  - Exception handling **inside** Python generators
  - Tolerant parsing of malformed LLM markdown
  - Path-traversal protection on uploads (`os.path.basename`)
  - Pydantic bounds on request counts (`ge=1, le=25`)
- **Visual:** Small code snippet — the try/except inside the yield loop.
- **Speaker note:** Builds credibility. Shows you thought about edge cases, not just the happy path.

### Slide 10 — Learnings & Future Work
- **Title:** Takeaways
- **Two columns:**

  **Learned**
  - RAG is architecture, not model training
  - Streaming changes perceived latency
  - Decouple core logic from UI framework
  - Mocking LLMs enables real tests (23 of them)

  **Next**
  - Conversational memory (multi-turn)
  - OCR for handwritten notes
  - Spaced-repetition scheduler
- **Speaker note:** Short and punchy. Don't read every bullet.

### Slide 11 — Thank You / Q&A
- **Title:** Thank You — Questions?
- **Content:**
  - GitHub: [TODO: paste your repo URL here before Monday — e.g. `github.com/<your-handle>/ai-study-assistant`]
  - Email: trilocn24032@gmail.com
- **Visual:** QR code linking to the repo (optional, looks polished).
- **Speaker note:** Stand relaxed. Repeat each question before answering — gives you thinking time and helps the audience hear.

---

## Part 3 — Q&A Danger Zone

> The ten questions most likely to come from a technically sharp audience. Rehearse these answers out loud.

| # | Likely Question | Answer Sketch |
|---|---|---|
| 1 | *"How do you know the answers are actually correct?"* | Two safeguards: (a) the prompt instructs Gemma to say "I couldn't find this" if missing; (b) low temperature (0.2) reduces creative inventing. **I have not done a formal faithfulness benchmark** — that's future work. I'd use RAGAS or a manual faithfulness score over a held-out question set. |
| 2 | *"What happens when retrieval returns the wrong chunks?"* | Then the answer is wrong — retrieval quality is the ceiling. Mitigations: chunk-size tuning, k=5 to give the LLM multiple chances, and the prompt's "say if you can't find it" instruction so garbage retrieval doesn't turn into confident wrong answers. |
| 3 | *"Why not use OpenAI? It would be better."* | Quality-wise, probably yes — but breaks three design goals: privacy, no API cost, and offline capability. The architecture supports it: I can swap `LM_STUDIO_URL` to OpenAI's endpoint with one env var. |
| 4 | *"What's the latency?"* | Cold start: ~10–15 seconds (model loads into RAM). Warm query: 2–5 seconds for first token, then tokens stream at reading speed. The `lru_cache` singleton on `get_llm()` means the model loads once per process, not per request. |
| 5 | *"Does it scale to many users?"* | **No — by design.** Single-user, single-machine. Scaling would mean moving ChromaDB to server mode, splitting embeddings per user, and swapping LM Studio for a GPU-backed inference server. Out of scope for a study tool. |
| 6 | *"How big can the notes get before it breaks?"* | Designed for a few hundred pages of lecture notes — I haven't formally benchmarked the upper limit. The bottleneck isn't ChromaDB (handles millions of vectors); it's the **8K context window**, which is a *shared* budget: `input + max_tokens ≤ 8192`. A typical call uses ~1.5k for the prompt template, the five retrieved chunks, and the question, leaving ~6.5k for generation. I cap `max_tokens` at 4096 to reserve headroom and still fit a 25-question quiz. Scaling past that would mean streaming ingestion plus a reranker to keep the top-k prompt budget tight — or swapping to a larger-context model. |
| 7 | *"Why these specific chunking parameters?"* | Empirical. 500 was too fragmented; 2000 overflowed context. 1000 × 200 overlap balanced coherence and retrieval granularity. I'd formalize with an ablation study if I productized it. |
| 8 | *"How did you test an LLM-based app?"* | 23 pytest tests. **Mocked LLM at the `get_llm()` boundary**, real ChromaDB for integration. Tests cover: retrieval correctness, stream error handling, parser tolerance against malformed output, chunk-collision logic. |
| 9 | *"Can it handle non-English notes?"* | MiniLM-L6-v2 is English-primary. Non-English embeddings degrade. For multilingual support I'd swap to `paraphrase-multilingual-MiniLM` or `e5-multilingual`. Gemma itself handles many languages fine. |
| 10 | *"Why did you rebuild the frontend? Couldn't you have stuck with Streamlit?"* | Two reasons: the click-to-see-citation UX wasn't buildable in Streamlit's rerun model, and I wanted token-level streaming without a full-page flash. Because my RAG core had no Streamlit dependencies, the rebuild was a ~1.3k-line React bundle plus a thin FastAPI layer — not a rewrite. That decoupling was worth more than any individual feature. |

---

## Part 4 — Pre-Presentation Checklist

**Night before:**
- [ ] Rehearse full script out loud, timed. Target: 11:50 ± 0:30.
- [ ] Start LM Studio, load Gemma 4 E4B, run one warm-up query.
- [ ] Start the server: `uvicorn server:app --port 8000` and confirm `http://localhost:8000` loads.
- [ ] Upload a **clean sample PDF** and keep it indexed (audience-impressive: your OS textbook chapter).
- [ ] Prepare **3 demo questions** on a sticky note on the side of the screen.
- [ ] Prepare **1 negative-control question** (not in the notes) for the hallucination demo.
- [ ] Export screenshots as a backup — save to desktop in case live demo fails.

**Morning of:**
- [ ] Close all apps except Terminal, LM Studio, Chrome (localhost:8000 tab), and PowerPoint.
- [ ] Disable notifications (macOS: Focus mode).
- [ ] Plug in power. Don't run on battery.
- [ ] Test the projector connection 15 minutes early.
- [ ] Pre-run the full demo once, then leave the app at the Q&A panel with no question typed.
- [ ] Confirm internet works — the React bundle fetches Babel Standalone from a CDN on first load. If offline, load the page once while online so it's cached.

**During:**
- [ ] Stand, don't hide behind the laptop.
- [ ] Look at the back of the room, not the slide.
- [ ] Repeat each Q&A question before answering.
- [ ] If something breaks: say "Networking hiccup — let me show you the screenshot" and keep moving.

**If the demo fails entirely:**
- [ ] Don't troubleshoot live. Flip to backup screenshots on Slide 8.
- [ ] Finish the talk. Offer to show the working app in the hallway after.
