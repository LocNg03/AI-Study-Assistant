"""
AI Study Assistant — Streamlit Web Interface
=============================================
This is the main entry point. Streamlit reruns this entire file top-to-bottom
every time the user interacts with a widget (button click, text input, etc.).

App structure:
  - Sidebar: file upload + processing
  - Main area: three tabs (Q&A, Quiz, Flashcards)

Key Streamlit concepts used:
  - st.session_state: persists data across reruns (like a global dict)
  - st.cache_resource: caches expensive objects (models, DB clients)
  - st.spinner: shows a loading indicator during slow operations
  - st.rerun: forces a fresh rerun of the script
"""

import streamlit as st

from ingestion import clear_uploads, load_and_chunk, save_uploaded_file
from rag import ask_question, generate_flashcards, generate_quiz
from vectorstore import add_documents, clear_vectorstore, collection_stats

# Must be the first Streamlit command — configures the browser tab title and layout.
st.set_page_config(page_title="AI Study Assistant", page_icon="📚", layout="wide")

# ── Custom CSS for better styling ──
# unsafe_allow_html=True is safe here because this is static CSS, not user input.
st.markdown(
    """
<style>
    .main-header {
        font-size: 2.5rem;
        font-weight: 700;
        background: linear-gradient(90deg, #4CAF50, #2196F3);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin-bottom: 0;
    }
    .sub-header {
        color: #888;
        font-size: 1.1rem;
        margin-bottom: 2rem;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 2rem;
    }
    .stTabs [data-baseweb="tab"] {
        font-size: 1.1rem;
        font-weight: 600;
    }
</style>
""",
    unsafe_allow_html=True,
)

st.markdown('<p class="main-header">📚 AI Study Assistant</p>', unsafe_allow_html=True)
st.markdown(
    '<p class="sub-header">Upload your notes, then ask questions, generate quizzes, or create flashcards.</p>',
    unsafe_allow_html=True,
)

# Bootstrap session from the persisted vector store on first load of each browser
# session, so previously ingested notes are usable without re-uploading.
if "docs_ready" not in st.session_state:
    num_chunks, file_names = collection_stats()
    if num_chunks > 0:
        st.session_state["docs_ready"] = True
        st.session_state["num_chunks"] = num_chunks
        st.session_state["file_names"] = file_names

# ── Sidebar: File Upload ──
# st.sidebar creates a collapsible panel on the left side of the app.
with st.sidebar:
    st.markdown("### 📁 Upload Notes")
    uploaded_files = st.file_uploader(
        "Upload PDF, DOCX, or TXT files",
        type=["pdf", "docx", "txt"],
        accept_multiple_files=True,
    )

    # disabled=not uploaded_files: button is greyed out until files are selected.
    if st.button(
        "🚀 Process Files",
        type="primary",
        disabled=not uploaded_files,
        use_container_width=True,
    ):
        # Ingest into memory first, then swap the store. This way a mid-batch
        # failure (e.g. a corrupt PDF) leaves existing notes intact.
        progress = st.progress(0.0, text="Processing documents...")
        try:
            # Prune orphan files from prior Process Files clicks before writing new
            # ones. Originals are only needed transiently; chunks live in ChromaDB.
            clear_uploads()
            all_chunks = []
            total = len(uploaded_files)
            for i, uploaded_file in enumerate(uploaded_files):
                progress.progress(i / total, text=f"Processing {uploaded_file.name}...")
                path = save_uploaded_file(uploaded_file)  # Save to disk
                chunks = load_and_chunk(path)  # Split into chunks
                all_chunks.extend(chunks)  # Collect all chunks

            progress.progress(1.0, text="Embedding and indexing...")
            clear_vectorstore()  # Only wipe once ingestion has succeeded
            add_documents(all_chunks)  # Embed and store in ChromaDB
            # Save state so the UI knows docs are ready (survives reruns)
            st.session_state["docs_ready"] = True
            st.session_state["num_chunks"] = len(all_chunks)
            st.session_state["file_names"] = [f.name for f in uploaded_files]
            progress.empty()
        except Exception as e:
            progress.empty()
            st.error(f"Failed to process files: {e}. Previous notes were not modified.")

    # Show file info in sidebar if docs have been processed
    if st.session_state.get("docs_ready"):
        st.markdown("---")
        st.metric("Files loaded", len(st.session_state["file_names"]))
        st.markdown(f"**{st.session_state['num_chunks']}** chunks indexed")
        for name in st.session_state["file_names"]:
            st.markdown(f"✅ {name}")
        st.markdown("---")

    # Two-click confirm: first click arms the confirm flag, second click wipes.
    # Avoids accidental data loss on a destructive, unrecoverable action.
    if st.session_state.get("confirm_clear"):
        st.warning("This will delete all indexed notes. Click again to confirm.")
        if st.button("⚠️ Confirm Clear", type="primary", use_container_width=True):
            clear_vectorstore()
            clear_uploads()
            for key in ("docs_ready", "num_chunks", "file_names", "confirm_clear"):
                st.session_state.pop(key, None)
            st.rerun()
        if st.button("Cancel", use_container_width=True):
            st.session_state.pop("confirm_clear", None)
            st.rerun()
    else:
        if st.button("🗑️ Clear All Notes", use_container_width=True):
            st.session_state["confirm_clear"] = True
            st.rerun()

# ── Main Area ──
# If no docs are processed yet, show a landing page with feature descriptions.
# st.stop() halts script execution so the tabs below don't render.
if not st.session_state.get("docs_ready"):
    st.markdown("---")
    col1, col2, col3 = st.columns(3)
    with col1:
        st.markdown("### 💬 Q&A")
        st.markdown("Ask questions about your notes and get accurate answers.")
    with col2:
        st.markdown("### 📝 Quiz")
        st.markdown("Generate multiple-choice quizzes to test your knowledge.")
    with col3:
        st.markdown("### 🗂️ Flashcards")
        st.markdown("Create flashcards for quick review of key concepts.")
    st.markdown("---")
    st.info("👈 Upload your notes in the sidebar to get started!")
    st.stop()

# Once docs are ready, show the three feature tabs.
# Each tab follows the same pattern: input -> button -> call RAG function -> display result.
tab_qa, tab_quiz, tab_flash = st.tabs(["💬 Q&A", "📝 Quiz", "🗂️ Flashcards"])

# ── Q&A Tab ──
with tab_qa:
    st.markdown("#### Ask a question about your notes")
    question = st.text_input("Type your question:", label_visibility="collapsed")
    if st.button("Get Answer", key="qa_btn", type="primary", disabled=not question):
        try:
            # st.write_stream consumes the generator, rendering tokens as they arrive.
            # No spinner needed — the streaming text itself is the progress indicator.
            st.write_stream(ask_question(question))
        except Exception as e:
            st.error(f"Couldn't answer that: {e}")

# ── Quiz Tab ──
with tab_quiz:
    st.markdown("#### Generate a quiz from your notes")
    topic = st.text_input(
        "Enter a topic:",
        placeholder="e.g. CPU performance",
        key="quiz_topic",
        label_visibility="collapsed",
    )
    num_q = st.slider("Number of questions", 3, 10, 5, key="quiz_num")
    if st.button("Generate Quiz", key="quiz_btn", type="primary", disabled=not topic):
        try:
            st.write_stream(generate_quiz(topic, num_q))
        except Exception as e:
            st.error(f"Couldn't generate quiz: {e}")

# ── Flashcards Tab ──
with tab_flash:
    st.markdown("#### Generate flashcards from your notes")
    topic_fc = st.text_input(
        "Enter a topic:",
        placeholder="e.g. memory hierarchy",
        key="fc_topic",
        label_visibility="collapsed",
    )
    num_fc = st.slider("Number of flashcards", 3, 10, 5, key="fc_num")
    if st.button(
        "Generate Flashcards", key="fc_btn", type="primary", disabled=not topic_fc
    ):
        try:
            st.write_stream(generate_flashcards(topic_fc, num_fc))
        except Exception as e:
            st.error(f"Couldn't generate flashcards: {e}")
