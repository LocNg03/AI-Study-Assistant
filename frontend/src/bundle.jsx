// AI Study Assistant — single-file React bundle.
// Talks to the FastAPI backend in server.py via fetch (NDJSON for /ask,
// JSON for everything else). UI components are adapted from the original
// mockup (src/*.jsx in the Downloads version) with mock data swapped for
// real API calls and the Claude-Artifacts edit-mode protocol removed.

// ============================================================================
// Shared state: the chunk citation map is populated incrementally as answers,
// quizzes, and flashcards come back. Components read from it at render time;
// writers call bumpChunks() so subscribers re-render.
// ============================================================================

const CHUNKS = {};
let chunkTick = 0;
const chunkListeners = new Set();
const mergeChunks = (map) => {
  if (!map) return;
  Object.assign(CHUNKS, map);
  chunkTick += 1;
  chunkListeners.forEach((fn) => fn(chunkTick));
};
const useChunkTick = () => {
  const [, set] = React.useState(0);
  React.useEffect(() => {
    chunkListeners.add(set);
    return () => chunkListeners.delete(set);
  }, []);
};

// ============================================================================
// API helpers — thin wrappers around fetch, one per endpoint.
// ============================================================================

const api = {
  documents: async () => {
    const r = await fetch("/api/documents");
    if (!r.ok) throw new Error("Could not load documents");
    return (await r.json()).documents;
  },
  topics: async (n = 5) => {
    const r = await fetch(`/api/topics?n=${n}`);
    if (!r.ok) return [];
    return (await r.json()).topics || [];
  },
  upload: async (file, onPhase) => {
    // fetch() doesn't expose upload progress, and for local use the bottleneck is
    // embedding, not network. Phase callback reports idle -> uploading -> indexing -> done.
    onPhase && onPhase("uploading");
    const form = new FormData();
    form.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: form });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || "Upload failed");
    }
    onPhase && onPhase("done");
    return r.json();
  },
  remove: async (name) => {
    const r = await fetch(`/api/documents/${encodeURIComponent(name)}`, { method: "DELETE" });
    return r.json();
  },
  clearAll: async () => fetch("/api/clear", { method: "POST" }),
  ask: async (question, onFrame) => {
    // Reads NDJSON frames from the /api/ask streaming response. Each frame is
    // one JSON object per line: {type:"chunks",...} | {type:"token",...} | {type:"done"} | {type:"error",...}
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!r.ok) throw new Error("Ask request failed");
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      // Buffer can receive partial lines, so only parse up to the last \n.
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { onFrame(JSON.parse(line)); } catch (_e) { /* ignore malformed frame */ }
      }
    }
  },
  quiz: async (topic, count) => {
    const r = await fetch("/api/quiz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, count }),
    });
    if (!r.ok) throw new Error("Quiz failed");
    return r.json();
  },
  flashcards: async (topic, count) => {
    const r = await fetch("/api/flashcards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, count }),
    });
    if (!r.ok) throw new Error("Flashcards failed");
    return r.json();
  },
};

// ============================================================================
// UI primitives — unchanged from the mockup. Icon library, button, kbd, eyebrow,
// and the Citation pill (now reads from the live CHUNKS object).
// ============================================================================

const Icon = ({ name = "AI Study Assistant", size = 35, stroke = 1.5 }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "chat": return <svg {...common}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.3A8 8 0 1 1 21 12Z"/></svg>;
    case "quiz": return <svg {...common}><path d="M9 11h6M9 15h4"/><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 8h6"/></svg>;
    case "cards": return <svg {...common}><rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h14v14"/></svg>;
    case "upload": return <svg {...common}><path d="M12 3v12M6 9l6-6 6 6"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>;
    case "file": return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "x": return <svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case "check": return <svg {...common}><path d="m5 12 5 5L20 7"/></svg>;
    case "arrow-right": return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case "arrow-left": return <svg {...common}><path d="M19 12H5M11 5l-7 7 7 7"/></svg>;
    case "sparkle": return <svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>;
    case "book": return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2Z"/><path d="M4 17h15"/></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>;
    case "trash": return <svg {...common}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>;
    case "sun": return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case "moon": return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>;
    case "copy": return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>;
    case "thumb-up": return <svg {...common}><path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2l-1 6a2 2 0 0 1-2 2H7"/></svg>;
    case "refresh": return <svg {...common}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>;
    case "flip": return <svg {...common}><path d="M4 12a8 8 0 0 1 13-6.2L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13 6.2L4 16"/><path d="M4 20v-4h4"/></svg>;
    case "dot": return <svg {...common}><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>;
    default: return null;
  }
};

const Citation = ({ id, onOpen }) => {
  useChunkTick();
  const chunk = CHUNKS[id];
  const [open, setOpen] = React.useState(false);
  if (!chunk) return null;
  const num = Object.keys(CHUNKS).indexOf(id) + 1;
  return (
    <span
      style={{ position: "relative", display: "inline-block", verticalAlign: "baseline" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => onOpen && onOpen(id)}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          minWidth: 18, height: 18, padding: "0 5px", marginLeft: 2, marginRight: 1,
          fontSize: 10.5, fontFamily: '"IBM Plex Mono", monospace', fontWeight: 500,
          background: open ? "var(--accent)" : "var(--surface-2)",
          color: open ? "var(--accent-ink)" : "var(--fg-2)",
          border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer",
          verticalAlign: "super", lineHeight: 1, transition: "all 0.12s ease",
        }}
      >{num}</button>
      {open && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
          transform: "translateX(-50%)", width: 320, padding: 12,
          background: "var(--surface)", color: "var(--fg)",
          border: "1px solid var(--border-strong)", borderRadius: 8,
          boxShadow: "0 18px 40px -16px oklch(0 0 0 / 0.5)",
          zIndex: 100, fontSize: 12, lineHeight: 1.55,
          animation: "fadeIn 0.15s ease-out", pointerEvents: "none",
        }}>
          <div className="mono" style={{ color: "var(--muted)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            {chunk.doc}{chunk.page ? ` · p.${chunk.page}` : ""}
          </div>
          <div style={{ color: "var(--fg-2)", fontStyle: "italic" }}>"{(chunk.excerpt || "").slice(0, 260)}{chunk.excerpt && chunk.excerpt.length > 260 ? "…" : ""}"</div>
        </span>
      )}
    </span>
  );
};

const Button = ({ variant = "secondary", size = "md", children, icon, iconRight, ...rest }) => {
  const sizes = {
    sm: { padding: "5px 10px", fontSize: 12, gap: 6, height: 28 },
    md: { padding: "8px 14px", fontSize: 13, gap: 8, height: 34 },
    lg: { padding: "10px 18px", fontSize: 14, gap: 8, height: 40 },
  };
  const variants = {
    primary: { background: "var(--accent)", color: "var(--accent-ink)", border: "1px solid var(--accent)" },
    secondary: { background: "var(--surface)", color: "var(--fg)", border: "1px solid var(--border)" },
    ghost: { background: "transparent", color: "var(--fg-2)", border: "1px solid transparent" },
    outline: { background: "transparent", color: "var(--fg)", border: "1px solid var(--border-strong)" },
    danger: { background: "transparent", color: "var(--danger)", border: "1px solid var(--border)" },
  };
  return (
    <button {...rest} className={("press " + (rest.className || "")).trim()}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontWeight: 500, letterSpacing: "-0.005em", borderRadius: 8,
        cursor: rest.disabled ? "default" : "pointer", transition: "all 0.12s ease",
        whiteSpace: "nowrap", opacity: rest.disabled ? 0.5 : 1,
        ...sizes[size], ...variants[variant], ...(rest.style || {}),
      }}
      onMouseEnter={(e) => { if (rest.disabled) return; if (variant === "ghost") e.currentTarget.style.background = "var(--surface)"; if (variant === "secondary") e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { if (variant === "ghost") e.currentTarget.style.background = "transparent"; if (variant === "secondary") e.currentTarget.style.background = "var(--surface)"; }}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 15}/>}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "sm" ? 13 : 15}/>}
    </button>
  );
};

const Kbd = ({ children }) => (
  <kbd className="mono" style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    minWidth: 20, height: 20, padding: "0 5px", fontSize: 10.5, fontWeight: 500,
    color: "var(--muted)", background: "var(--bg-2)", border: "1px solid var(--border)",
    borderRadius: 4, lineHeight: 1,
  }}>{children}</kbd>
);

const Eyebrow = ({ children, accent }) => (
  <div className="mono" style={{
    display: "inline-flex", alignItems: "center", gap: 6,
    fontSize: 10.5, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase",
    color: accent ? "var(--accent)" : "var(--muted)",
  }}>
    <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 99, background: accent ? "var(--accent)" : "var(--muted)" }}/>
    {children}
  </div>
);

const Header = ({ title, subtitle, right }) => (
  <header style={{ padding: "18px 40px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)" }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</h1>
      {subtitle && <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: "0.04em", marginTop: 2 }}>{subtitle}</div>}
    </div>
    {right}
  </header>
);

const Chip = ({ active, children, onClick }) => (
  <button onClick={onClick} style={{
    padding: "6px 12px",
    background: active ? "var(--accent)" : "var(--bg-2)",
    color: active ? "var(--accent-ink)" : "var(--fg-2)",
    border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
    borderRadius: 99, fontSize: 12, fontWeight: 500, cursor: "pointer",
    transition: "all 0.12s ease",
  }}>{children}</button>
);

// ============================================================================
// Sidebar — real docs from App prop; history/user badge kept as decoration.
// ============================================================================

const Sidebar = ({ mode, setMode, docs, activeDocs, toggleDoc, onNewChat, onOpenUpload, onClearAll, onRemoveDoc, theme, setTheme }) => {
  const modes = [
    { id: "qa", label: "Q&A", icon: "chat", hint: "1" },
    { id: "quiz", label: "Quiz", icon: "quiz", hint: "2" },
    { id: "cards", label: "Flashcards", icon: "cards", hint: "3" },
  ];
  return (
    <aside style={{ width: 264, flexShrink: 0, height: "100vh", position: "sticky", top: 0, borderRight: "1px solid var(--border)", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 18px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 6, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-ink)", fontFamily: '"Fraunces", serif', fontSize: 15, fontWeight: 500, fontStyle: "italic" }}>AISA</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 17, letterSpacing: "-0.01em" }}>AI Study Assisstant</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--muted)", letterSpacing: "0.04em" }}>local RAG</div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onNewChat} title="New chat" style={{ padding: "5px 8px" }}/>
      </div>

      <nav style={{ padding: "4px 10px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        {modes.map((m) => {
          const active = mode === m.id;
          return (
            <button key={m.id} className="press" onClick={() => setMode(m.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: active ? "var(--surface)" : "transparent", border: "1px solid " + (active ? "var(--border)" : "transparent"), borderRadius: 7, color: active ? "var(--fg)" : "var(--fg-2)", cursor: "pointer", fontSize: 13, fontWeight: active ? 500 : 400, textAlign: "left", transition: "all 0.1s ease", position: "relative" }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-2)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
              {active && <span style={{ position: "absolute", left: -10, top: 8, bottom: 8, width: 2, background: "var(--accent)", borderRadius: 2 }}/>}
              <Icon name={m.icon} size={45}/>
              <span style={{ flex: 1 }}>{m.label}</span>
              <Kbd>{m.hint}</Kbd>
            </button>
          );
        })}
      </nav>

      <div style={{ borderTop: "1px solid var(--border)", margin: "0 12px" }}/>

      <div style={{ padding: "14px 18px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Sources · {docs.length}
        </div>
        <button onClick={onOpenUpload} title="Upload" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 2 }}>
          <Icon name="plus" size={14}/>
        </button>
      </div>
      <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
        {docs.length === 0 && (
          <div style={{ padding: "18px 10px", color: "var(--muted-2)", fontSize: 12, textAlign: "center" }}>
            No notes yet.<br/><span style={{ color: "var(--muted)" }}>Click + above to upload.</span>
          </div>
        )}
        {docs.map((d) => {
          const on = activeDocs.includes(d.id);
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button onClick={() => toggleDoc(d.id)}
                style={{ flex: 1, display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", background: "transparent", border: "1px solid transparent", borderRadius: 6, color: on ? "var(--fg)" : "var(--muted)", cursor: "pointer", textAlign: "left", fontSize: 12.5, transition: "all 0.1s ease", minWidth: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-2)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, border: "1px solid " + (on ? "var(--accent)" : "var(--border-strong)"), background: on ? "var(--accent)" : "transparent", color: "var(--accent-ink)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {on && <Icon name="check" size={10} stroke={2.5}/>}
                </span>
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>{d.chunks}</span>
              </button>
              <button onClick={() => onRemoveDoc(d.name)} title={`Remove ${d.name}`}
                style={{ background: "transparent", border: "none", color: "var(--muted-2)", cursor: "pointer", padding: 4 }}
                onMouseEnter={(e) => e.currentTarget.style.color = "var(--danger)"}
                onMouseLeave={(e) => e.currentTarget.style.color = "var(--muted-2)"}>
                <Icon name="x" size={12}/>
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1 }}/>

      <div style={{ padding: "12px 12px" }}>
        {docs.length > 0 && (
          <Button variant="ghost" size="m" icon="trash" onClick={onClearAll} style={{ width: "100%", justifyContent: "flex-start", color: "var(--muted)" }}>
            Clear all notes
          </Button>
        )}
      </div>

      <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <div style={{ width: 26, height: 26, borderRadius: 99, background: "linear-gradient(135deg, oklch(0.75 0.12 80), oklch(0.6 0.14 30))", display: "flex", alignItems: "center", justifyContent: "center", color: "oklch(0.2 0.03 30)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>MP</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Local session</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>on device</div>
          </div>
        </div>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme"
          style={{ width: 30, height: 30, borderRadius: 6, background: "transparent", border: "1px solid var(--border)", color: "var(--fg-2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={14}/>
        </button>
      </div>
    </aside>
  );
};

// ============================================================================
// UploadModal — real multipart upload. Phases: idle -> uploading -> indexing -> done.
// ============================================================================

const UploadModal = ({ open, onClose, onUploaded }) => {
  const [phase, setPhase] = React.useState("idle"); // idle | uploading | done | error
  const [message, setMessage] = React.useState("");
  const [fileInfo, setFileInfo] = React.useState(null);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) { setPhase("idle"); setMessage(""); setFileInfo(null); }
  }, [open]);

  const handleFile = async (file) => {
    if (!file) return;
    setFileInfo({ name: file.name, size: formatSize(file.size) });
    setPhase("uploading");
    try {
      const res = await api.upload(file);
      setMessage(`${res.chunks} chunks indexed`);
      setPhase("done");
      onUploaded && onUploaded();
    } catch (e) {
      setMessage(e.message || "Upload failed");
      setPhase("error");
    }
  };

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "oklch(0 0 0 / 0.55)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      animation: "fadeIn 0.15s ease-out",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 520, background: "var(--bg)", border: "1px solid var(--border-strong)",
        borderRadius: 14, boxShadow: "0 30px 80px -20px oklch(0 0 0 / 0.6)", overflow: "hidden",
      }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <Eyebrow accent>Add source</Eyebrow>
            <h3 style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>
              {phase === "idle" ? "Upload notes" : phase === "uploading" ? "Processing…" : phase === "done" ? "Ready to study" : "Upload failed"}
            </h3>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
            <Icon name="x" size={18}/>
          </button>
        </div>

        <div style={{ padding: 22 }}>
          {phase === "idle" && (
            <>
              <input ref={inputRef} type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files[0])}/>
              <div onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                style={{
                  border: "1.5px dashed var(--border-strong)", borderRadius: 10,
                  padding: "36px 20px", textAlign: "center", cursor: "pointer",
                  transition: "all 0.15s ease", background: "var(--surface)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-dim)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--surface)"; }}>
                <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 10, background: "var(--bg-2)", color: "var(--fg-2)", marginBottom: 12 }}>
                  <Icon name="upload" size={20}/>
                </div>
                <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Drop files or click to browse</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.04em" }}>
                  PDF · DOCX · TXT
                </div>
              </div>
              <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10, color: "var(--muted)", fontSize: 12 }}>
                <Icon name="dot" size={10}/> Files stay on your device. Embeddings are computed locally.
              </div>
            </>
          )}

          {phase === "uploading" && (
            <>
              {fileInfo && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 18 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 6, background: "var(--bg-2)", color: "var(--fg-2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon name="file" size={15}/>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{fileInfo.name}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{fileInfo.size}</div>
                  </div>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--fg-2)", fontSize: 13 }}>
                <span style={{ width: 14, height: 14, borderRadius: 99, border: "1.5px solid var(--accent)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }}/>
                Extracting text, chunking, embedding, indexing…
              </div>
              <div className="mono" style={{ marginTop: 12, fontSize: 11, color: "var(--muted-2)" }}>
                Embedding with all-MiniLM-L6-v2 (first upload downloads ~80MB).
              </div>
            </>
          )}

          {phase === "done" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 48, height: 48, borderRadius: 99, background: "var(--accent)", color: "var(--accent-ink)", marginBottom: 14 }}>
                <Icon name="check" size={22} stroke={2.5}/>
              </div>
              <h3 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em", fontFamily: '"Fraunces", serif' }}>Your notes are ready</h3>
              <p style={{ margin: "0 0 18px", color: "var(--muted)", fontSize: 13.5 }}>
                {message}. Try asking a question, generating a quiz, or creating flashcards.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <Button variant="primary" icon="chat" onClick={onClose}>Start asking</Button>
                <Button variant="outline" onClick={() => { setPhase("idle"); setFileInfo(null); }}>Add another</Button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div>
              <div style={{ padding: 14, background: "var(--surface)", border: "1px solid var(--danger)", borderLeft: "3px solid var(--danger)", borderRadius: 8, color: "var(--fg-2)", fontSize: 13 }}>
                {message}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <Button variant="outline" onClick={() => setPhase("idle")}>Try again</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const formatSize = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

// ============================================================================
// Q&A panel — real NDJSON streaming from /api/ask.
// ============================================================================

const QAPanel = ({ docs, onOpenCitation, openCitation }) => {
  const [turns, setTurns] = React.useState([]); // {role, text, chunks?, streaming?}
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const scrollRef = React.useRef(null);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns]);

  const ask = async (text) => {
    const question = (text || draft).trim();
    if (!question || loading) return;
    setDraft("");
    setLoading(true);
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "", streaming: true, chunks: [] }]);

    try {
      await api.ask(question, (frame) => {
        if (frame.type === "chunks") {
          mergeChunks(frame.data);
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") last.chunks = Object.keys(frame.data);
            return next;
          });
        } else if (frame.type === "token") {
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") last.text = (last.text || "") + frame.text;
            return next;
          });
        } else if (frame.type === "error") {
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") { last.text = frame.message; last.streaming = false; }
            return next;
          });
        } else if (frame.type === "done") {
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") last.streaming = false;
            return next;
          });
        }
      });
    } catch (e) {
      setTurns((t) => {
        const next = [...t];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") { last.text = "Error: " + e.message; last.streaming = false; }
        return next;
      });
    } finally {
      setLoading(false);
    }
  };

  const reset = () => setTurns([]);
  const empty = turns.length === 0;
  const hasNotes = docs.length > 0;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Header
        title="Ask"
        subtitle={`${docs.length} source${docs.length === 1 ? "" : "s"} · ${docs.reduce((s, d) => s + d.chunks, 0)} chunks indexed`}
        right={turns.length > 0 ? <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>Clear</Button> : null}
      />

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: empty ? 0 : "32px 40px 120px" }}>
        {empty ? (
          <EmptyAsk onPick={(q) => ask(q)} hasNotes={hasNotes}/>
        ) : (
          <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 32 }}>
            {turns.map((turn, idx) => <Turn key={idx} turn={turn} onOpenCitation={onOpenCitation}/>)}
          </div>
        )}
      </div>

      {!empty && (
        <div style={{ position: "absolute", bottom: 0, left: 264, right: openCitation ? 264 : 0, padding: "16px 40px 20px", background: "linear-gradient(to top, var(--bg) 65%, transparent)", pointerEvents: "none" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", pointerEvents: "auto" }}>
            <Composer draft={draft} setDraft={setDraft} onSubmit={ask} loading={loading} size="sm" placeholder="Ask a follow-up…"/>
          </div>
        </div>
      )}
    </div>
  );
};

const EmptyAsk = ({ onPick, hasNotes }) => {
  const [draft, setDraft] = React.useState("");
  const [suggested, setSuggested] = React.useState([]);

  React.useEffect(() => {
    if (!hasNotes) { setSuggested([]); return; }
    api.topics(5).then(setSuggested).catch(() => setSuggested([]));
  }, [hasNotes]);

  const placeholder = hasNotes ? "Ask anything about your notes…" : "Upload notes first, then ask away.";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "72px 20px 40px", display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Eyebrow accent>{hasNotes ? "Your notes" : "Start here"}</Eyebrow>
        <h2 style={{ margin: 0, fontSize: 38, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.1, fontFamily: '"Fraunces", serif' }}>
          What would you like to <em style={{ fontWeight: 500 }}>understand</em>?
        </h2>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14.5, maxWidth: 520, lineHeight: 1.55 }}>
          Ask anything from your notes. I'll only answer from what's in your uploads.
        </p>
      </div>

      <Composer draft={draft} setDraft={setDraft} onSubmit={(v) => onPick(v || draft)} size="lg" placeholder={placeholder} disabled={!hasNotes}/>

      {suggested.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          <Eyebrow>Suggested topics</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, borderTop: "1px solid var(--border)" }}>
            {suggested.map((topic, i) => (
              <button key={i} onClick={() => onPick(`Explain ${topic} in simple terms.`)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 4px", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", color: "var(--fg-2)", cursor: "pointer", textAlign: "left", fontSize: 14, transition: "all 0.12s ease" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-2)"; }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--muted-2)", width: 22 }}>0{i+1}</span>
                <span style={{ flex: 1 }}>Explain {topic} in simple terms.</span>
                <Icon name="arrow-right" size={14}/>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Turn = ({ turn, onOpenCitation }) => {
  if (turn.role === "user") {
    return (
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ width: 22, height: 22, borderRadius: 99, background: "linear-gradient(135deg, oklch(0.75 0.12 80), oklch(0.6 0.14 30))", color: "oklch(0.2 0.03 30)", fontWeight: 600, fontSize: 9.5, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>ME</div>
        <div style={{ flex: 1, fontSize: 16, lineHeight: 1.55, color: "var(--fg)", fontWeight: 500, letterSpacing: "-0.005em" }}>{turn.text}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
      <div style={{ width: 22, height: 22, borderRadius: 6, background: "var(--accent)", color: "var(--accent-ink)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2, fontFamily: '"Fraunces", serif', fontStyle: "italic", fontSize: 13, fontWeight: 500 }}>s</div>
      <div style={{ flex: 1, fontSize: 15, lineHeight: 1.65, color: "var(--fg-2)", whiteSpace: "pre-wrap" }}>
        {turn.text}
        {turn.streaming && (
          <span style={{ display: "inline-block", width: 7, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom", animation: "caret 1s steps(1) infinite" }}/>
        )}
        {!turn.streaming && turn.chunks && turn.chunks.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              Sources
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {turn.chunks.map((id) => (
                <SourcePill key={id} id={id} onOpen={onOpenCitation}/>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SourcePill = ({ id, onOpen }) => {
  useChunkTick();
  const chunk = CHUNKS[id];
  if (!chunk) return null;
  return (
    <button onClick={() => onOpen(id)} style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 99, color: "var(--fg-2)", fontSize: 12, cursor: "pointer",
      transition: "all 0.12s ease",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--fg)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--fg-2)"; }}>
      <Icon name="file" size={11}/>
      <span>{chunk.doc}{chunk.page ? ` · p.${chunk.page}` : ""}</span>
    </button>
  );
};

const Composer = ({ draft, setDraft, onSubmit, size = "md", placeholder, disabled, loading }) => {
  const big = size === "lg";
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(draft); }
  };
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: big ? 14 : 10, boxShadow: "var(--shadow)",
      padding: big ? "14px 14px 10px" : "10px 10px 8px",
      display: "flex", flexDirection: "column", gap: 6,
      opacity: disabled ? 0.5 : 1,
    }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        rows={big ? 2 : 1}
        autoFocus={big}
        style={{
          width: "100%", minHeight: big ? 42 : 22, resize: "none",
          border: "none", outline: "none", background: "transparent",
          fontSize: big ? 16 : 14, fontFamily: "inherit",
          letterSpacing: "-0.005em", color: "var(--fg)",
          padding: big ? "4px 4px" : "2px 4px",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1 }}/>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--muted-2)", fontSize: 11 }}>
          <Kbd>↵</Kbd> <span>to ask</span>
        </div>
        <button onClick={() => onSubmit(draft)} disabled={disabled || !draft.trim() || loading}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 30, height: 30, borderRadius: 7,
            background: draft.trim() && !disabled ? "var(--accent)" : "var(--bg-2)",
            color: draft.trim() && !disabled ? "var(--accent-ink)" : "var(--muted-2)",
            border: "none",
            cursor: draft.trim() && !disabled ? "pointer" : "default",
            transition: "all 0.12s ease",
          }}>
          {loading ? (
            <span style={{ width: 12, height: 12, borderRadius: 99, border: "1.5px solid currentColor", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }}/>
          ) : (
            <Icon name="arrow-right" size={14} stroke={2}/>
          )}
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// Sources drawer — right-side panel showing one chunk in detail.
// ============================================================================

const SourcesDrawer = ({ openCitation, onClose }) => {
  useChunkTick();
  if (!openCitation) return null;
  const chunk = CHUNKS[openCitation];
  if (!chunk) return null;
  const num = Object.keys(CHUNKS).indexOf(openCitation) + 1;
  return (
    <aside style={{
      width: 360, height: "100vh", flexShrink: 0,
      borderLeft: "1px solid var(--border)", background: "var(--bg-2)",
      display: "flex", flexDirection: "column", position: "sticky", top: 0,
      animation: "fadeIn 0.2s ease-out",
    }}>
      <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Eyebrow accent>Source {num}</Eyebrow>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer" }}>
          <Icon name="x" size={16}/>
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "22px" }}>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
          {chunk.doc}{chunk.page ? ` · page ${chunk.page}` : ""}
        </div>
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 8, padding: 18, fontSize: 13, lineHeight: 1.7,
          color: "var(--fg-2)", marginBottom: 16,
          whiteSpace: "pre-wrap",
        }}>
          {chunk.excerpt}
        </div>
      </div>
    </aside>
  );
};

// ============================================================================
// Quiz — setup (topic + count) → generate → play → results.
// ============================================================================

const QuizPanel = ({ docs, onOpenCitation }) => {
  const [phase, setPhase] = React.useState("setup"); // setup | loading | play | done | error
  const [topic, setTopic] = React.useState("");
  const [count, setCount] = React.useState(5);
  const [questions, setQuestions] = React.useState([]);
  const [idx, setIdx] = React.useState(0);
  const [answers, setAnswers] = React.useState({});
  const [revealed, setRevealed] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState("");

  const start = async () => {
    if (!topic.trim()) return;
    setPhase("loading");
    try {
      const res = await api.quiz(topic.trim(), count);
      if (res.error) { setErrorMsg(res.error); setPhase("error"); return; }
      if (!res.questions || res.questions.length === 0) {
        setErrorMsg("The model didn't return any parseable questions. Try a different topic.");
        setPhase("error"); return;
      }
      mergeChunks(res.chunks);
      setQuestions(res.questions);
      setIdx(0); setAnswers({}); setRevealed(false);
      setPhase("play");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  const q = questions[idx];

  const answer = (val) => {
    if (revealed) return;
    const correct = val === q.answer;
    setAnswers((a) => ({ ...a, [q.id]: { value: val, correct } }));
    setRevealed(true);
  };

  const next = () => {
    if (idx + 1 >= questions.length) setPhase("done");
    else { setIdx(idx + 1); setRevealed(false); }
  };

  const hasNotes = docs.length > 0;

  if (phase === "setup" || phase === "error") {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Header title="Quiz" subtitle={hasNotes ? `${docs.reduce((s, d) => s + d.chunks, 0)} chunks indexed` : "Upload notes first"}/>
        <div style={{ flex: 1, overflowY: "auto", padding: "48px 40px" }}>
          <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
            <div>
              <Eyebrow accent>Ready when you are</Eyebrow>
              <h2 style={{ margin: "8px 0 10px", fontSize: 34, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.1, fontFamily: '"Fraunces", serif' }}>
                Test yourself
              </h2>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 14.5, lineHeight: 1.55 }}>
                Pick a topic from your notes. I'll pull the most relevant chunks and generate questions grounded in them.
              </p>
            </div>

            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Topic</div>
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. attention mechanism"
                  disabled={!hasNotes}
                  style={{ width: "100%", padding: "10px 12px", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--fg)", fontSize: 14, fontFamily: "inherit", outline: "none" }}/>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Length</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[3, 5, 10].map((n) => <Chip key={n} active={count === n} onClick={() => setCount(n)}>{n} questions</Chip>)}
                </div>
              </div>
            </div>

            {phase === "error" && (
              <div style={{ padding: 14, background: "var(--surface)", border: "1px solid var(--danger)", borderLeft: "3px solid var(--danger)", borderRadius: 8, color: "var(--fg-2)", fontSize: 13 }}>
                {errorMsg}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <Button variant="primary" size="lg" iconRight="arrow-right" onClick={start} disabled={!topic.trim() || !hasNotes}>
                Generate quiz
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Header title="Quiz" subtitle="Generating…"/>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
          <span style={{ width: 20, height: 20, borderRadius: 99, border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }}/>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Retrieving context and generating questions…</div>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    const correct = Object.values(answers).filter((a) => a.correct).length;
    const total = questions.length;
    const pct = Math.round((correct / total) * 100);
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Header title="Quiz · Results" subtitle=""/>
        <div style={{ flex: 1, overflowY: "auto", padding: "48px 40px" }}>
          <div style={{ maxWidth: 640, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 32 }}>
              <div style={{ fontFamily: '"Fraunces", serif', fontSize: 96, fontWeight: 500, lineHeight: 1, letterSpacing: "-0.04em", color: "var(--fg)" }}>
                {correct}<span style={{ color: "var(--muted-2)" }}>/{total}</span>
              </div>
              <div style={{ paddingBottom: 16 }}>
                <Eyebrow accent>{pct >= 80 ? "Strong" : pct >= 60 ? "Solid" : "Keep going"}</Eyebrow>
                <div style={{ fontSize: 14, color: "var(--muted)", marginTop: 6 }}>{pct}% correct</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
              <Button variant="primary" icon="refresh" onClick={() => setPhase("setup")}>New quiz</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Play
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Header title="Quiz" subtitle={`Question ${idx + 1} of ${questions.length}`}/>
      <div style={{ padding: "0 40px" }}>
        <div style={{ display: "flex", gap: 4, padding: "14px 0 0" }}>
          {questions.map((qq, i) => {
            const a = answers[qq.id];
            const cur = i === idx;
            return (
              <div key={qq.id} style={{
                flex: 1, height: 3, borderRadius: 2,
                background: cur ? "var(--fg)" : a ? (a.correct ? "var(--accent)" : "var(--danger)") : "var(--border)",
                opacity: !cur && !a ? 0.5 : 1,
              }}/>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "48px 40px 40px" }}>
        <div key={q.id} style={{ maxWidth: 680, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <Eyebrow accent>Multiple choice</Eyebrow>
          </div>
          <h2 style={{ margin: "0 0 28px", fontSize: 24, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: 1.3, color: "var(--fg)" }}>
            {q.prompt}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {q.choices.map((c, i) => {
              const picked = answers[q.id]?.value === i;
              const isAnswer = revealed && i === q.answer;
              const isWrong = revealed && picked && i !== q.answer;
              return (
                <button key={i} className="press" onClick={() => answer(i)} disabled={revealed}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 16px",
                    background: isAnswer ? "var(--accent-dim)" : picked ? "var(--surface-2)" : "var(--surface)",
                    border: "1px solid " + (isAnswer ? "var(--accent)" : isWrong ? "var(--danger)" : picked ? "var(--border-strong)" : "var(--border)"),
                    borderRadius: 10, color: "var(--fg)",
                    cursor: revealed ? "default" : "pointer", textAlign: "left",
                    fontSize: 14, transition: "all 0.12s ease",
                  }}>
                  <span className="mono" style={{
                    width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                    background: isAnswer ? "var(--accent)" : "var(--bg-2)",
                    color: isAnswer ? "var(--accent-ink)" : "var(--muted)",
                    border: "1px solid " + (isAnswer ? "var(--accent)" : "var(--border)"),
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 500, marginTop: 1,
                  }}>{String.fromCharCode(65 + i)}</span>
                  <span style={{ flex: 1, lineHeight: 1.5 }}>{c}</span>
                  {isAnswer && <Icon name="check" size={16} stroke={2}/>}
                </button>
              );
            })}
          </div>

          {revealed && (
            <div style={{
              marginTop: 20, background: "var(--surface)", border: "1px solid var(--border)",
              borderLeft: "3px solid " + (answers[q.id].correct ? "var(--accent)" : "var(--danger)"),
              borderRadius: 8, padding: "14px 16px",
            }}>
              <Eyebrow accent={answers[q.id].correct}>
                {answers[q.id].correct ? "Correct" : "Not quite"}
              </Eyebrow>
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--fg-2)", marginTop: 6 }}>
                Pulled from {q.cite && <Citation id={q.cite} onOpen={onOpenCitation}/>}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <Button variant="primary" size="sm" iconRight="arrow-right" onClick={next}>
                  {idx + 1 >= questions.length ? "See results" : "Next"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Flashcards — setup (topic + count) → review with flip + navigation.
// ============================================================================

const FlashcardsPanel = ({ docs, onOpenCitation }) => {
  const [phase, setPhase] = React.useState("setup");
  const [topic, setTopic] = React.useState("");
  const [count, setCount] = React.useState(5);
  const [cards, setCards] = React.useState([]);
  const [idx, setIdx] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState("");

  const generate = async () => {
    if (!topic.trim()) return;
    setPhase("loading");
    try {
      const res = await api.flashcards(topic.trim(), count);
      if (res.error) { setErrorMsg(res.error); setPhase("error"); return; }
      if (!res.cards || res.cards.length === 0) {
        setErrorMsg("The model didn't return any parseable flashcards. Try a different topic.");
        setPhase("error"); return;
      }
      mergeChunks(res.chunks);
      setCards(res.cards);
      setIdx(0); setFlipped(false);
      setPhase("play");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  const go = (delta) => {
    setFlipped(false);
    setIdx((i) => (i + delta + cards.length) % cards.length);
  };

  React.useEffect(() => {
    if (phase !== "play") return;
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); setFlipped((f) => !f); }
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, idx, cards.length]);

  const hasNotes = docs.length > 0;

  if (phase === "setup" || phase === "error") {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Header title="Flashcards" subtitle={hasNotes ? `${docs.reduce((s, d) => s + d.chunks, 0)} chunks indexed` : "Upload notes first"}/>
        <div style={{ flex: 1, overflowY: "auto", padding: "48px 40px" }}>
          <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
            <div>
              <Eyebrow accent>Build a deck</Eyebrow>
              <h2 style={{ margin: "8px 0 10px", fontSize: 34, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.1, fontFamily: '"Fraunces", serif' }}>
                Make cards from your notes
              </h2>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 14.5, lineHeight: 1.55 }}>
                Front/back pairs grounded in the top chunks for your topic.
              </p>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Topic</div>
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. memory hierarchy"
                  disabled={!hasNotes}
                  style={{ width: "100%", padding: "10px 12px", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--fg)", fontSize: 14, fontFamily: "inherit", outline: "none" }}/>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Cards</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[5, 10, 15].map((n) => <Chip key={n} active={count === n} onClick={() => setCount(n)}>{n} cards</Chip>)}
                </div>
              </div>
            </div>
            {phase === "error" && (
              <div style={{ padding: 14, background: "var(--surface)", border: "1px solid var(--danger)", borderLeft: "3px solid var(--danger)", borderRadius: 8, color: "var(--fg-2)", fontSize: 13 }}>
                {errorMsg}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="primary" size="lg" iconRight="arrow-right" onClick={generate} disabled={!topic.trim() || !hasNotes}>
                Generate deck
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Header title="Flashcards" subtitle="Generating…"/>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
          <span style={{ width: 20, height: 20, borderRadius: 99, border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }}/>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Building cards…</div>
        </div>
      </div>
    );
  }

  const card = cards[idx];
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Header
        title="Flashcards"
        subtitle={`${topic} · ${cards.length} cards`}
        right={<Button variant="ghost" size="sm" icon="refresh" onClick={() => setPhase("setup")}>New deck</Button>}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 40px" }}>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 20 }}>
          Card {idx + 1} / {cards.length}
        </div>
        <div style={{ width: "100%", maxWidth: 520, perspective: 1600 }}>
          <button onClick={() => setFlipped((f) => !f)}
            style={{
              position: "relative", width: "100%", aspectRatio: "3 / 2",
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 16, cursor: "pointer", padding: 0,
              boxShadow: "var(--shadow)", textAlign: "left",
              transformStyle: "preserve-3d",
              transition: "transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)",
              transform: flipped ? "rotateY(180deg)" : "none",
            }}>
            <Face side="front" visible={!flipped}>
              <Eyebrow>{card.tag}</Eyebrow>
              <div style={{ fontFamily: '"Fraunces", serif', fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.15, color: "var(--fg)" }}>
                {card.front}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
                <Icon name="flip" size={13}/> Tap or press <Kbd>space</Kbd>
              </div>
            </Face>
            <Face side="back" visible={flipped}>
              <Eyebrow accent>Answer</Eyebrow>
              <div style={{ fontSize: 18, lineHeight: 1.5, color: "var(--fg)" }}>
                {card.back} {card.cite && <span onClick={(e) => e.stopPropagation()}><Citation id={card.cite} onOpen={onOpenCitation}/></span>}
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
                <Icon name="book" size={13}/> {CHUNKS[card.cite]?.doc || "—"}
              </div>
            </Face>
          </button>
        </div>

        <div style={{ width: "100%", maxWidth: 520, marginTop: 28, display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="outline" size="md" icon="arrow-left" onClick={() => go(-1)}>Prev</Button>
          <div style={{ flex: 1 }}/>
          <Button variant="primary" size="md" icon="flip" onClick={() => setFlipped((f) => !f)}>Flip</Button>
          <div style={{ flex: 1 }}/>
          <Button variant="outline" size="md" iconRight="arrow-right" onClick={() => go(1)}>Next</Button>
        </div>
      </div>
    </div>
  );
};

const Face = ({ side, visible, children }) => (
  <div style={{
    position: side === "front" ? "relative" : "absolute",
    inset: 0, width: "100%", height: "100%", padding: 32,
    display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 18,
    backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden",
    transform: side === "back" ? "rotateY(180deg)" : "none",
    borderRadius: 16, pointerEvents: visible ? "auto" : "none",
  }}>{children}</div>
);

// ============================================================================
// App shell — fetches docs on mount, keeps them in sync on uploads/removes.
// ============================================================================

const App = () => {
  const [mode, setMode] = React.useState("qa");
  const [docs, setDocs] = React.useState([]);
  const [activeDocs, setActiveDocs] = React.useState([]);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [openCitation, setOpenCitation] = React.useState(null);
  const [theme, setThemeState] = React.useState("dark");

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const refreshDocs = React.useCallback(() => {
    api.documents().then((d) => {
      setDocs(d);
      setActiveDocs(d.map((x) => x.id));
    }).catch(() => {});
  }, []);

  React.useEffect(() => { refreshDocs(); }, [refreshDocs]);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      if (e.key === "1") setMode("qa");
      else if (e.key === "2") setMode("quiz");
      else if (e.key === "3") setMode("cards");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleDoc = (id) => setActiveDocs((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id]);

  const removeDoc = async (name) => {
    await api.remove(name);
    refreshDocs();
  };

  const clearAll = async () => {
    if (!confirm("Delete all indexed notes?")) return;
    await api.clearAll();
    refreshDocs();
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative" }}>
      <Sidebar
        mode={mode} setMode={setMode}
        docs={docs} activeDocs={activeDocs} toggleDoc={toggleDoc}
        onNewChat={() => setMode("qa")}
        onOpenUpload={() => setUploadOpen(true)}
        onClearAll={clearAll}
        onRemoveDoc={removeDoc}
        theme={theme} setTheme={setThemeState}
      />
      <main key={mode} style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {mode === "qa" && <QAPanel docs={docs} onOpenCitation={setOpenCitation} openCitation={openCitation}/>}
        {mode === "quiz" && <QuizPanel docs={docs} onOpenCitation={setOpenCitation}/>}
        {mode === "cards" && <FlashcardsPanel docs={docs} onOpenCitation={setOpenCitation}/>}
      </main>
      {openCitation && mode !== "cards" && (
        <SourcesDrawer openCitation={openCitation} onClose={() => setOpenCitation(null)}/>
      )}
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onUploaded={refreshDocs}/>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
