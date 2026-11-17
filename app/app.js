// Memo – assistente personale con memoria a lungo termine.
// Tutti i dati (chiave API, ricordi, conversazioni) restano nel localStorage del telefono.
import Anthropic from "./vendor/anthropic.js";

// ---------------------------------------------------------------------------
// Persistenza
// ---------------------------------------------------------------------------
const KEYS = {
  settings: "memo.settings",
  memories: "memo.memories",
  session: "memo.session",
  counter: "memo.counter",
};
const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
    showError("Spazio di archiviazione pieno: esporta un backup e avvia una nuova conversazione.");
    console.error(e);
  }
};

const DEFAULT_SETTINGS = { provider: "gemini", apiKey: "", geminiKey: "", name: "", botName: "Memo", model: "claude-opus-5-5", tts: false };
const storedSettings = load(KEYS.settings, {});
let settings = { ...DEFAULT_SETTINGS, ...storedSettings };
// Chi aveva già inserito una chiave Claude prima dell'arrivo di Gemini resta su Claude.
if (!storedSettings.provider && storedSettings.apiKey) settings.provider = "claude";
const activeKey = () => (settings.provider === "gemini" ? settings.geminiKey : settings.apiKey);
let memories = load(KEYS.memories, []);
let session = load(KEYS.session, null);

// Oltre questa lunghezza la conversazione riparte (i ricordi restano).
const MAX_SESSION_MESSAGES = 120;
const CATEGORIES = ["persona", "preferenze", "relazioni", "lavoro", "salute", "obiettivi", "abitudini", "eventi", "altro"];

function nextId() {
  const n = (load(KEYS.counter, 0) || 0) + 1;
  save(KEYS.counter, n);
  return "m" + n;
}
const persistMemories = () => {
  save(KEYS.memories, memories);
  renderMemCount();
};
const persistSession = () => save(KEYS.session, session);
const persistSettings = () => save(KEYS.settings, settings);

// ---------------------------------------------------------------------------
// Prompt e strumenti di memoria
// ---------------------------------------------------------------------------
const fmtDate = (d = new Date()) =>
  d.toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function baseInstructions() {
  const bot = settings.botName || "Memo";
  return `Sei ${bot}, l'assistente virtuale personale di ${settings.name || "questa persona"}. Vivi nel suo telefono e parli in italiano, con un tono caldo, naturale e conciso, come un amico fidato e competente. Le risposte possono essere lette ad alta voce: preferisci frasi brevi e scorrevoli, usa elenchi solo quando servono davvero.

La tua caratteristica principale è che RICORDI e IMPARI dalle conversazioni nel tempo.
- All'inizio di ogni conversazione ricevi i ricordi che hai salvato finora. Usali in modo naturale (chiama la persona per nome, ricorda preferenze, persone care, progetti, impegni), senza elencarli e senza dire "secondo i miei ricordi" a ogni frase.
- Quando la persona ti dice qualcosa che vale la pena ricordare a lungo termine — chi è, gusti e preferenze, persone importanti, lavoro e studio, salute, obiettivi, abitudini, date ed eventi, come preferisce che tu le risponda — salvalo con lo strumento "ricorda". Scrivi ogni ricordo come una frase breve e autonoma, in terza persona, con date assolute quando rilevanti (es. "Il 16/11/2026 ha iniziato un corso di chitarra").
- Se un'informazione nuova cambia o corregge un ricordo esistente, usa "aggiorna_ricordo" invece di crearne un doppione. Se la persona ti chiede di dimenticare qualcosa, o un ricordo non è più vero, usa "dimentica".
- Non salvare chiacchiere passeggere, cose che hai detto tu o dettagli già presenti nei ricordi. Non salvare password, codici o dati bancari.
- Puoi salvare in silenzio, senza annunciarlo; dillo solo se la persona te lo chiede o se è utile confermarlo.
- Impara anche dallo stile: se la persona ti corregge o mostra una preferenza su come rispondi, salvalo nella categoria "preferenze" e adeguati.
- Se non sai qualcosa sulla persona, non inventarlo: chiedi.
Ogni messaggio dell'utente inizia con data e ora tra parentesi quadre: usale per capire il tempo trascorso, ma non ripeterle.`;
}

function memorySnapshot() {
  if (!memories.length) return "Non hai ancora nessun ricordo su questa persona: è la vostra prima conversazione. Presentati brevemente e cerca di conoscerla.";
  const lines = memories.map((m) => `- [${m.id}] (${m.category}) ${m.text}`);
  return `Ricordi salvati finora (${memories.length}), con il loro id:\n${lines.join("\n")}`;
}

const TOOLS = [
  {
    name: "ricorda",
    description:
      "Salva un nuovo ricordo a lungo termine sulla persona (fatti, preferenze, persone, obiettivi, eventi, abitudini). Usalo ogni volta che emerge un'informazione utile da ricordare nelle conversazioni future.",
    input_schema: {
      type: "object",
      properties: {
        testo: { type: "string", description: "Il ricordo, una frase breve e autonoma in terza persona." },
        categoria: { type: "string", enum: CATEGORIES },
      },
      required: ["testo", "categoria"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "aggiorna_ricordo",
    description: "Sostituisce il testo di un ricordo esistente quando un'informazione cambia o va corretta.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "L'id del ricordo, es. m12." },
        testo: { type: "string", description: "Il nuovo testo completo del ricordo." },
      },
      required: ["id", "testo"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "dimentica",
    description: "Cancella un ricordo che non è più vero o che la persona ha chiesto di dimenticare.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "L'id del ricordo da cancellare." } },
      required: ["id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Esegue uno strumento di memoria. Restituisce { content, isError, note }.
function runTool(name, input) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  if (name === "ricorda") {
    const text = str(input?.testo);
    const category = CATEGORIES.includes(input?.categoria) ? input.categoria : "altro";
    if (!text) return { content: "Errore: testo mancante.", isError: true };
    const now = new Date().toISOString();
    const m = { id: nextId(), text, category, created: now, updated: now };
    memories.push(m);
    persistMemories();
    return { content: `Salvato con id ${m.id}.`, note: `🧠 Ho imparato: ${text}` };
  }
  if (name === "aggiorna_ricordo") {
    const m = memories.find((x) => x.id === str(input?.id));
    const text = str(input?.testo);
    if (!m) return { content: `Errore: nessun ricordo con id ${input?.id}.`, isError: true };
    if (!text) return { content: "Errore: testo mancante.", isError: true };
    m.text = text;
    m.updated = new Date().toISOString();
    persistMemories();
    return { content: `Ricordo ${m.id} aggiornato.`, note: `🧠 Ho aggiornato: ${text}` };
  }
  if (name === "dimentica") {
    const i = memories.findIndex((x) => x.id === str(input?.id));
    if (i < 0) return { content: `Errore: nessun ricordo con id ${input?.id}.`, isError: true };
    const [m] = memories.splice(i, 1);
    persistMemories();
    return { content: `Ricordo ${m.id} cancellato.`, note: `🧠 Ho dimenticato: ${m.text}` };
  }
  return { content: `Errore: strumento sconosciuto ${name}.`, isError: true };
}

// ---------------------------------------------------------------------------
// Sessione di conversazione
// La cronologia inviata all'API è solo in aggiunta (append-only): il prompt di sistema
// con i ricordi viene "congelato" all'inizio della sessione, e le modifiche fatte a mano
// ai ricordi durante la sessione vengono comunicate con un messaggio di sistema in coda.
// ---------------------------------------------------------------------------
function newSession() {
  session = {
    provider: settings.provider,
    startedAt: new Date().toISOString(),
    system: memorySnapshot(),
    api: [], // messaggi in formato API
    view: [], // elementi mostrati a schermo
    pendingNotes: [], // modifiche manuali ai ricordi da comunicare
  };
  persistSession();
}
function ensureSession() {
  // Le cronologie di Claude e Gemini hanno formati diversi: cambiando servizio si riparte (i ricordi restano).
  if (!session || session.api.length >= MAX_SESSION_MESSAGES || (session.provider || "claude") !== settings.provider) {
    const hadOne = !!session;
    newSession();
    if (hadOne) session.view.push({ type: "divider", text: "Nuova conversazione – i ricordi restano" });
  }
}
function notifyMemoryChange(text) {
  if (session && session.api.length) {
    session.pendingNotes.push(text);
    persistSession();
  }
}

// ---------------------------------------------------------------------------
// Chiamata a Claude con ciclo degli strumenti
// ---------------------------------------------------------------------------
let busy = false;

async function send(text) {
  if (busy || !text.trim()) return;
  if (!activeKey()) {
    openSettings();
    showError("Inserisci prima la tua chiave API nelle impostazioni.");
    return;
  }
  ensureSession();
  busy = true;
  setBusy(true);

  const rollback = session.api.length;
  const viewRollback = session.view.length;
  const stamped = `[${fmtDate()}]\n${text}`;
  const notes = session.pendingNotes.length
    ? "Nel frattempo l'utente ha modificato a mano i tuoi ricordi:\n" + session.pendingNotes.map((n) => "- " + n).join("\n")
    : "";
  if (settings.provider === "gemini") {
    const parts = [{ text: stamped }];
    if (notes) parts.push({ text: "[Nota di sistema] " + notes });
    session.api.push({ role: "user", parts });
  } else {
    session.api.push({ role: "user", content: stamped });
    if (notes) session.api.push({ role: "system", content: notes });
  }
  session.view.push({ type: "user", text });
  renderChat();

  const bubble = addBubble("bot", "");
  bubble.classList.add("typing");
  const ui = {
    append(delta) {
      bubble.dataset.raw = (bubble.dataset.raw || "") + delta;
      bubble.innerHTML = renderMarkdown(bubble.dataset.raw);
      scrollDown();
    },
    note(text) {
      session.view.push({ type: "note", text });
      chatEl.insertBefore(makeNote(text), bubble);
    },
    paragraph() {
      if (bubble.dataset.raw && !bubble.dataset.raw.endsWith("\n\n")) bubble.dataset.raw += "\n\n";
    },
  };

  try {
    if (settings.provider === "gemini") await geminiLoop(ui);
    else await claudeLoop(ui);
    session.pendingNotes = [];
    const finalText = (bubble.dataset.raw || "").trim();
    if (finalText) session.view.push({ type: "bot", text: finalText });
    persistSession();
    renderChat();
    if (settings.tts && finalText) speak(finalText);
  } catch (err) {
    console.error(err);
    session.api.length = rollback;
    session.view.length = viewRollback;
    persistSession();
    renderChat();
    input.value = text;
    showError(explainError(err));
  } finally {
    busy = false;
    setBusy(false);
  }
}

// Esegue gli strumenti richiesti e restituisce i risultati, mostrando le note di memoria.
function runTools(calls, ui) {
  return calls.map(({ name, input }) => {
    const r = runTool(name, input);
    if (r.note) ui.note(r.note);
    return r;
  });
}

// --- Claude (a pagamento) ---------------------------------------------------
async function claudeLoop(ui) {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 1 });
  const model = settings.model || DEFAULT_SETTINGS.model;
  for (let turn = 0; turn < 8; turn++) {
    const params = {
      model,
      max_tokens: 16000,
      system: [
        { type: "text", text: baseInstructions() },
        { type: "text", text: session.system },
      ],
      tools: TOOLS,
      messages: session.api,
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    };
    // Se un filtro di sicurezza rifiuta per errore, il server ripete la richiesta su un altro modello.
    if (model !== "claude-haiku-5-5") {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const stream = client.beta.messages.stream(params);
    stream.on("text", (delta) => ui.append(delta));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Non posso rispondere a questa richiesta.");
    session.api.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") return;

    const uses = msg.content.filter((b) => b.type === "tool_use");
    const results = runTools(uses, ui).map((r, i) => ({
      type: "tool_result",
      tool_use_id: uses[i].id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    }));
    session.api.push({ role: "user", content: results });
    ui.paragraph();
  }
}

// --- Google Gemini (piano gratuito) -----------------------------------------
// Se il modello principale ha esaurito la quota gratuita si prova il successivo.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
// Se la rete non manda nulla per tutto questo tempo, la richiesta viene annullata.
const IDLE_TIMEOUT_MS = 30000;
// Ragionamento breve = risposte molto più rapide. Se il modello non lo supporta, si riprova senza.
let geminiThinking = load("memo.geminiThinking", true);

class GeminiError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Una richiesta in streaming: il testo viene mostrato man mano che arriva.
async function geminiStreamOnce(model, body, onText) {
  const ctrl = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
  };
  arm();
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.geminiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new GeminiError(0, ctrl.signal.aborted ? "timeout" : "offline");
  }
  if (!res.ok) {
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    const err = Array.isArray(data) ? data[0]?.error : data.error;
    const reason = err?.details?.find((d) => d.reason)?.reason || err?.status;
    throw new GeminiError(res.status, err?.message || res.statusText, reason);
  }

  const parts = [];
  let finishReason, blockReason, started = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const chunk = JSON.parse(line.slice(5).trim());
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    const cand = chunk.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) finishReason = cand.finishReason;
    for (const part of cand.content?.parts || []) {
      parts.push(part);
      if (part.text && !part.thought) {
        started = true;
        onText(part.text);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (e instanceof SyntaxError) throw new GeminiError(0, "Risposta non valida da Gemini, riprova.");
    // Interruzione a metà: se qualcosa è già arrivato lo teniamo.
    if (!started) throw new GeminiError(0, ctrl.signal.aborted ? "timeout" : "offline");
  } finally {
    clearTimeout(timer);
  }
  return { parts: mergeTextParts(parts), finishReason, blockReason };
}

// Lo streaming spezza il testo in tanti pezzi: li riuniamo per tenere la cronologia compatta.
function mergeTextParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    const plain = (x) => x && typeof x.text === "string" && Object.keys(x).every((k) => k === "text" || k === "thought");
    if (plain(p) && plain(last) && !!p.thought === !!last.thought) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

async function geminiRequest(body, onText) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const b = geminiThinking ? { ...body, generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } } : body;
      try {
        return await geminiStreamOnce(model, b, onText);
      } catch (err) {
        lastErr = err;
        // Il modello non accetta l'impostazione del ragionamento: si riprova subito senza.
        if (err.status === 400 && geminiThinking && /thinking/i.test(err.message)) {
          geminiThinking = false;
          save("memo.geminiThinking", false);
          attempt--;
          continue;
        }
        // Rete lenta o interrotta, o servizio sovraccarico: un nuovo tentativo.
        if ((err.status === 0 || err.status >= 500) && attempt === 0) continue;
        break;
      }
    }
    if (![404, 429, 500, 503].includes(lastErr.status)) break;
  }
  throw lastErr;
}

async function geminiLoop(ui) {
  const tools = [
    {
      functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })),
    },
  ];
  let wroteText = false;
  let nudged = false;
  for (let turn = 0; turn < 8; turn++) {
    const r = await geminiRequest(
      {
        systemInstruction: { parts: [{ text: baseInstructions() + "\n\n" + session.system }] },
        contents: session.api,
        tools,
      },
      (t) => {
        wroteText = true;
        ui.append(t);
      }
    );
    if (!r.parts.length) {
      if (r.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(r.finishReason)) {
        throw new Error("Non posso rispondere a questa richiesta.");
      }
      if (turn === 0) throw new Error("Risposta vuota da Gemini, riprova.");
    } else {
      // Le parti vanno rimandate così come sono (contengono le firme del ragionamento).
      session.api.push({ role: "model", parts: r.parts });
    }

    const calls = r.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length) {
      const results = runTools(calls.map((c) => ({ name: c.name, input: c.args || {} })), ui);
      session.api.push({
        role: "user",
        parts: results.map((res, i) => ({
          functionResponse: {
            name: calls[i].name,
            ...(calls[i].id ? { id: calls[i].id } : {}),
            response: res.isError ? { error: res.content } : { result: res.content },
          },
        })),
      });
      ui.paragraph();
      continue;
    }
    // A volte, dopo aver salvato un ricordo, Gemini non scrive nulla: gli chiediamo di rispondere.
    if (!wroteText && !nudged) {
      nudged = true;
      const nudge = { text: "[Nota di sistema] Ora rispondi all'utente." };
      const last = session.api[session.api.length - 1];
      if (last.role === "user") last.parts.push(nudge);
      else session.api.push({ role: "user", parts: [nudge] });
      continue;
    }
    return;
  }
}

function explainError(err) {
  if (err instanceof GeminiError) {
    if (err.reason === "API_KEY_INVALID" || err.status === 401) return "Chiave Gemini non valida. Controllala nelle impostazioni.";
    if (err.status === 403) return "La chiave Gemini non è autorizzata. Creane una nuova su aistudio.google.com.";
    if (err.status === 429) return "Hai raggiunto il limite gratuito di Gemini per ora. Riprova tra qualche minuto (o domani).";
    if (err.status === 0 && err.message === "timeout") return "La rete è troppo lenta e la risposta non arriva. Riprova (il messaggio è ancora nella casella).";
    if (err.status === 0 && err.message === "offline") return "Nessuna connessione a internet. Riprova quando sei online.";
    if (err.status >= 500) return "Gemini è momentaneamente sovraccarico. Riprova.";
    return err.message || "Errore di Gemini.";
  }
  if (err instanceof Anthropic.AuthenticationError) return "Chiave API non valida. Controllala nelle impostazioni.";
  if (err instanceof Anthropic.PermissionDeniedError) return "La chiave API non ha accesso a questo modello.";
  if (err instanceof Anthropic.RateLimitError) return "Troppe richieste: riprova tra qualche secondo.";
  if (err instanceof Anthropic.BadRequestError) return "Richiesta non valida: " + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.InternalServerError) return "Il servizio è momentaneamente sovraccarico. Riprova.";
  if (err instanceof Anthropic.APIConnectionError) return "Nessuna connessione a internet.";
  if (err instanceof Anthropic.APIError) return "Errore del servizio (" + err.status + "): " + err.message;
  return err?.message || String(err);
}

// ---------------------------------------------------------------------------
// Interfaccia
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const chatEl = $("#chat");
const input = $("#input");

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function renderMarkdown(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,6} (.*)$/gm, "<strong>$1</strong>");
}
function makeNote(text) {
  const n = document.createElement("div");
  n.className = "note";
  n.textContent = text;
  return n;
}
function addBubble(kind, text) {
  const b = document.createElement("div");
  b.className = "msg " + kind;
  if (kind === "bot") b.innerHTML = renderMarkdown(text);
  else b.textContent = text;
  chatEl.appendChild(b);
  scrollDown();
  return b;
}
function scrollDown() {
  chatEl.scrollTop = chatEl.scrollHeight;
}
function renderChat() {
  chatEl.innerHTML = "";
  const items = session?.view || [];
  if (!items.length) {
    const w = document.createElement("div");
    w.className = "welcome";
    const who = settings.name ? `Ciao ${escapeHtml(settings.name)}!` : "Ciao!";
    w.innerHTML = `<h2>${who}</h2><p>Sono ${escapeHtml(settings.botName || "Memo")}. Parlami di te, dei tuoi impegni, di quello che vuoi: imparo e ricordo nel tempo.</p>${
      memories.length ? `<p>Ricordo già ${memories.length} cose su di te 🧠</p>` : ""
    }`;
    chatEl.appendChild(w);
    return;
  }
  for (const it of items) {
    if (it.type === "user") addBubble("user", it.text);
    else if (it.type === "bot") addBubble("bot", it.text);
    else if (it.type === "note") chatEl.appendChild(makeNote(it.text));
    else if (it.type === "divider") {
      const d = document.createElement("div");
      d.className = "divider";
      d.textContent = "— " + it.text + " —";
      chatEl.appendChild(d);
    }
  }
  scrollDown();
}
function showError(text) {
  const e = document.createElement("div");
  e.className = "msg error";
  e.textContent = text;
  chatEl.appendChild(e);
  scrollDown();
}
function setBusy(on) {
  $("#btn-send").disabled = on;
  input.placeholder = on ? "Sto pensando…" : "Scrivimi qualcosa…";
}
function renderMemCount() {
  $("#mem-count").textContent = memories.length;
}

// Composer
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = input.value;
  input.value = "";
  autoGrow();
  send(t);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(hover: hover)").matches) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", autoGrow);

$("#btn-new").addEventListener("click", () => {
  if (busy) return;
  if (session?.view.length && !confirm("Iniziare una nuova conversazione? I ricordi restano.")) return;
  newSession();
  renderChat();
});

// ---------------------------------------------------------------------------
// Voce: dettatura e lettura
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
$("#btn-mic").addEventListener("click", () => {
  if (!SR) {
    showError("La dettatura vocale non è supportata da questo browser. Usa il microfono della tastiera.");
    return;
  }
  if (recog) {
    recog.stop();
    return;
  }
  speechSynthesis?.cancel();
  recog = new SR();
  recog.lang = "it-IT";
  recog.interimResults = true;
  recog.continuous = false;
  const before = input.value ? input.value + " " : "";
  let finalText = "";
  recog.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = before + finalText + interim;
    autoGrow();
  };
  recog.onerror = (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") showError("Microfono: " + ev.error);
  };
  recog.onend = () => {
    $("#btn-mic").classList.remove("listening");
    recog = null;
    if (finalText.trim()) $("#composer").requestSubmit();
  };
  $("#btn-mic").classList.add("listening");
  recog.start();
});

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "it-IT";
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith("it"));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------------------
// Pannello memoria
// ---------------------------------------------------------------------------
const dlgMem = $("#dlg-memory");
$("#btn-memory").addEventListener("click", () => {
  renderMemList();
  dlgMem.showModal();
});
dlgMem.querySelector("[data-close]").addEventListener("click", () => dlgMem.close());
dlgMem.addEventListener("click", (e) => e.target === dlgMem && dlgMem.close());
$("#mem-search").addEventListener("input", renderMemList);

function renderMemList() {
  const q = $("#mem-search").value.trim().toLowerCase();
  const list = $("#mem-list");
  list.innerHTML = "";
  const items = memories
    .filter((m) => !q || m.text.toLowerCase().includes(q) || m.category.includes(q))
    .slice()
    .reverse();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = memories.length ? "Nessun risultato." : "Ancora nessun ricordo. Inizia a chiacchierare!";
    list.appendChild(li);
    return;
  }
  for (const m of items) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="mem-body"><div class="mem-cat"></div><div class="mem-text" contenteditable="true"></div><div class="mem-date"></div></div><button class="icon-btn" aria-label="Cancella">🗑</button>`;
    li.querySelector(".mem-cat").textContent = m.category;
    const t = li.querySelector(".mem-text");
    t.textContent = m.text;
    li.querySelector(".mem-date").textContent = new Date(m.updated).toLocaleDateString("it-IT");
    t.addEventListener("blur", () => {
      const v = t.textContent.trim();
      if (v && v !== m.text) {
        m.text = v;
        m.updated = new Date().toISOString();
        persistMemories();
        notifyMemoryChange(`ricordo ${m.id} corretto in: "${v}"`);
      } else t.textContent = m.text;
    });
    li.querySelector("button").addEventListener("click", () => {
      if (!confirm("Cancellare questo ricordo?")) return;
      memories = memories.filter((x) => x.id !== m.id);
      persistMemories();
      notifyMemoryChange(`ricordo ${m.id} cancellato ("${m.text}")`);
      renderMemList();
    });
    list.appendChild(li);
  }
}
$("#mem-add").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#mem-add-text").value.trim();
  if (!text) return;
  const now = new Date().toISOString();
  const m = { id: nextId(), text, category: "altro", created: now, updated: now };
  memories.push(m);
  persistMemories();
  notifyMemoryChange(`nuovo ricordo ${m.id}: "${text}"`);
  $("#mem-add-text").value = "";
  renderMemList();
});

// ---------------------------------------------------------------------------
// Impostazioni, backup
// ---------------------------------------------------------------------------
const dlgSet = $("#dlg-settings");
function syncProviderFields() {
  const g = $("#set-provider").value === "gemini";
  document.querySelectorAll("[data-provider]").forEach((el) => (el.hidden = el.dataset.provider !== (g ? "gemini" : "claude")));
}
$("#set-provider").addEventListener("change", syncProviderFields);
function openSettings() {
  $("#set-provider").value = settings.provider;
  $("#set-gemini-key").value = settings.geminiKey;
  syncProviderFields();
  $("#set-key").value = settings.apiKey;
  $("#set-name").value = settings.name;
  $("#set-botname").value = settings.botName;
  $("#set-model").value = settings.model;
  $("#set-tts").checked = settings.tts;
  dlgSet.showModal();
}
$("#btn-settings").addEventListener("click", openSettings);
dlgSet.addEventListener("close", () => {
  if (dlgSet.returnValue !== "save") return;
  settings = {
    provider: $("#set-provider").value,
    geminiKey: $("#set-gemini-key").value.trim(),
    apiKey: $("#set-key").value.trim(),
    name: $("#set-name").value.trim(),
    botName: $("#set-botname").value.trim() || "Memo",
    model: $("#set-model").value,
    tts: $("#set-tts").checked,
  };
  persistSettings();
  document.title = settings.botName;
  $("h1").textContent = settings.botName;
  renderChat();
});

$("#btn-export").addEventListener("click", () => {
  const data = { app: "memo", version: 1, exportedAt: new Date().toISOString(), memories, session, counter: load(KEYS.counter, 0), profile: { name: settings.name, botName: settings.botName } };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `memo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#btn-import").addEventListener("click", () => $("#file-import").click());
$("#file-import").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== "memo" || !Array.isArray(data.memories)) throw new Error("File non riconosciuto");
    if (!confirm(`Importare ${data.memories.length} ricordi? Sostituiranno quelli attuali.`)) return;
    memories = data.memories;
    save(KEYS.counter, Math.max(data.counter || 0, ...memories.map((m) => parseInt(m.id.slice(1)) || 0)));
    persistMemories();
    if (data.profile) {
      settings.name = data.profile.name || settings.name;
      settings.botName = data.profile.botName || settings.botName;
      persistSettings();
    }
    newSession();
    dlgSet.close();
    renderChat();
  } catch (err) {
    alert("Importazione non riuscita: " + err.message);
  } finally {
    e.target.value = "";
  }
});
$("#btn-wipe").addEventListener("click", () => {
  if (!confirm("Cancellare TUTTI i ricordi e le conversazioni? Non si può annullare.")) return;
  memories = [];
  persistMemories();
  save(KEYS.counter, 0);
  newSession();
  dlgSet.close();
  renderChat();
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
document.title = settings.botName || "Memo";
$("h1").textContent = settings.botName || "Memo";
renderMemCount();
renderChat();
if (!activeKey()) openSettings();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
}
