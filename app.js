'use strict';

/* =====================================================================
   Chat de grupo con tres IAs que se responden entre ellas.
   Todo corre en el navegador: la clave de API la pones tú en Ajustes
   y se guarda solo en localStorage de tu navegador.
   ===================================================================== */

const API_URL = 'https://api.anthropic.com/v1/messages';
const KEY_SETTINGS = 'multiia.settings.v1';
const KEY_CHAT = 'multiia.chat.v1';
const MAX_SAVED = 200;
const MIN_TYPING_MS = 700;

const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (rápido y barato)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (equilibrado)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (el más capaz)' },
];

const DEFAULTS = {
  apiKey: '',
  groupName: 'Trío de IAs',
  maxExchanges: 4,
  history: 40,
  ais: [
    {
      id: 'ai1',
      name: 'Nova',
      model: 'claude-haiku-5-5',
      persona: 'Curiosa y entusiasta. Propone ideas, conecta temas y le encanta explorar posibilidades. Habla con calidez y algo de humor.',
    },
    {
      id: 'ai2',
      name: 'Bruno',
      model: 'claude-haiku-5-5',
      persona: 'Escéptico y práctico. Busca fallos, pide datos y baja las ideas a tierra, pero sin ser borde. Le gusta llevar la contraria con argumentos.',
    },
    {
      id: 'ai3',
      name: 'Luna',
      model: 'claude-haiku-5-5',
      persona: 'Creativa y con mucho humor. Usa analogías, bromea con cariño y a veces resume o hace de mediadora cuando Nova y Bruno discrepan.',
    },
  ],
};

/* ---------------------------- Estado ---------------------------- */

let settings = loadSettings();
let messages = loadChat();
let typingId = null;
let running = false;
let runId = 0;
let abortCtl = null;

const $ = (id) => document.getElementById(id);
const els = {
  chat: $('chat'),
  input: $('input'),
  composer: $('composer'),
  sendBtn: $('sendBtn'),
  title: $('groupTitle'),
  subtitle: $('subtitle'),
  mentions: $('mentions'),
  menuBtn: $('menuBtn'),
  menu: $('menu'),
  settings: $('settings'),
  settingsForm: $('settingsForm'),
  apiKey: $('apiKey'),
  groupName: $('groupName'),
  maxExchanges: $('maxExchanges'),
  aiFields: $('aiFields'),
};

/* ------------------------- Almacenamiento ------------------------- */

function loadSettings() {
  const base = structuredClone(DEFAULTS);
  try {
    const s = JSON.parse(localStorage.getItem(KEY_SETTINGS));
    if (s && typeof s === 'object') {
      return {
        ...base,
        ...s,
        ais: DEFAULTS.ais.map((d, i) => ({ ...d, ...(s.ais && s.ais[i] ? s.ais[i] : {}), id: d.id })),
      };
    }
  } catch { /* sin datos o localStorage no disponible */ }
  return base;
}

function saveSettings() {
  try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch { /* ignorar */ }
}

function loadChat() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY_CHAT));
    if (Array.isArray(c)) return c;
  } catch { /* ignorar */ }
  return [];
}

function saveChat() {
  try {
    const persist = messages.filter((m) => m.kind !== 'error').slice(-MAX_SAVED);
    localStorage.setItem(KEY_CHAT, JSON.stringify(persist));
  } catch { /* ignorar */ }
}

/* ---------------------------- Utilidades ---------------------------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aiById = (id) => settings.ais.find((a) => a.id === id);
const slotOf = (id) => Math.max(0, settings.ais.findIndex((a) => a.id === id));
const promptName = (author) => (author === 'user' ? 'Usuario' : aiById(author)?.name || author);

function mentions(text, name) {
  return new RegExp(`@${escapeRe(name)}(?![\\p{L}\\d_])`, 'iu').test(text);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------ Mensajes y render ------------------------ */

function addMessage(author, text, kind) {
  messages.push({ id: crypto.randomUUID(), author, text, ts: Date.now(), kind });
  saveChat();
  render(author === 'user');
}

function addSystem(text, kind) {
  addMessage('system', text, kind);
}

// Texto seguro: *negrita*, _cursiva_ y @menciones, siempre con textContent.
function formatInto(parent, text) {
  const re = /(\*[^*\n]+\*|(?<![\p{L}\d])_[^_\n]+_(?![\p{L}\d])|@[\p{L}\d_]+)/gu;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    let el;
    if (tok[0] === '*') {
      el = document.createElement('strong');
      el.textContent = tok.slice(1, -1);
    } else if (tok[0] === '_') {
      el = document.createElement('em');
      el.textContent = tok.slice(1, -1);
    } else {
      el = document.createElement('span');
      el.className = 'mention';
      el.textContent = tok;
    }
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const TICKS = '<svg class="read-ticks" viewBox="0 0 18 11" width="18" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6l3 3L10.5 1.5"/><path d="M7 8l1.2 1.2L14.5 1.5"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6v6.4l12.6 2-12.6 2z"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

function avatarEl(authorId) {
  const ai = aiById(authorId);
  const el = document.createElement('div');
  el.className = `avatar slot${slotOf(authorId)}`;
  el.textContent = (ai?.name || '?').charAt(0).toUpperCase();
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function chipEl(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
}

function messageRow(m, first, read) {
  const isUser = m.author === 'user';
  const row = document.createElement('div');
  row.className = `row ${isUser ? 'out' : `in slot${slotOf(m.author)}`}${first ? ' first' : ''}`;

  if (!isUser) {
    if (first) row.append(avatarEl(m.author));
    else {
      const sp = document.createElement('div');
      sp.className = 'spacer';
      row.append(sp);
    }
  }

  const bubble = document.createElement('div');
  bubble.className = `bubble ${isUser ? 'out' : 'in'}${first ? ' first' : ''}`;

  if (!isUser && first) {
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = aiById(m.author)?.name || m.author;
    bubble.append(name);
  }

  const text = document.createElement('div');
  text.className = 'text';
  formatInto(text, m.text);
  bubble.append(text);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.append(formatTime(m.ts));
  if (isUser) {
    const t = document.createElement('span');
    t.className = read ? 'read' : '';
    t.innerHTML = TICKS;
    meta.append(t);
  }
  bubble.append(meta);

  row.append(bubble);
  return row;
}

function typingRow(aiId, first) {
  const row = document.createElement('div');
  row.className = `row in slot${slotOf(aiId)}${first ? ' first' : ''}`;
  if (first) row.append(avatarEl(aiId));
  else {
    const sp = document.createElement('div');
    sp.className = 'spacer';
    row.append(sp);
  }
  const bubble = document.createElement('div');
  bubble.className = `bubble in typing${first ? ' first' : ''}`;
  bubble.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
  bubble.setAttribute('aria-label', `${aiById(aiId)?.name} está escribiendo`);
  row.append(bubble);
  return row;
}

function render(forceScroll = false) {
  const c = els.chat;
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 140;
  const frag = document.createDocumentFragment();

  if (!messages.length) {
    const names = settings.ais.map((a) => a.name);
    frag.append(chipEl('chip-system', `Grupo con ${names[0]}, ${names[1]} y ${names[2]}. Escribe algo o menciona a una IA con @.`));
    if (!settings.apiKey) {
      frag.append(chipEl('chip-system error', 'Falta tu clave de API. Ábrela en ⋮ → Ajustes de las IAs.'));
    }
  }

  let prev = null;
  let prevDay = null;
  messages.forEach((m, i) => {
    const day = dayKey(m.ts);
    if (day !== prevDay) {
      frag.append(chipEl('chip-day', dayLabel(m.ts)));
      prevDay = day;
      prev = null;
    }
    if (m.author === 'system') {
      frag.append(chipEl(`chip-system${m.kind === 'error' ? ' error' : ''}`, m.text));
      prev = null;
      return;
    }
    const first = !prev || prev.author !== m.author;
    const read = m.author === 'user' && messages.slice(i + 1).some((n) => n.author !== 'user' && n.author !== 'system');
    frag.append(messageRow(m, first, read));
    prev = m;
  });

  if (typingId) frag.append(typingRow(typingId, !prev || prev.author !== typingId));

  c.replaceChildren(frag);
  if (nearBottom || forceScroll) c.scrollTop = c.scrollHeight;

  updateHeader();
  updateSendButton();
}

function updateHeader() {
  els.title.textContent = settings.groupName;
  document.title = settings.groupName;
  if (typingId) {
    els.subtitle.textContent = `${aiById(typingId).name} está escribiendo…`;
  } else {
    els.subtitle.textContent = `${settings.ais.map((a) => a.name).join(', ')}, tú`;
  }
}

function updateSendButton() {
  const stopMode = running && !els.input.value.trim();
  els.sendBtn.innerHTML = stopMode ? STOP_ICON : SEND_ICON;
  els.sendBtn.setAttribute('aria-label', stopMode ? 'Detener la conversación' : 'Enviar');
  els.sendBtn.dataset.mode = stopMode ? 'stop' : 'send';
}

function renderMentionChips() {
  els.mentions.replaceChildren();
  settings.ais.forEach((ai, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip slot${i}`;
    b.textContent = `@${ai.name}`;
    b.addEventListener('click', () => insertMention(ai.name));
    els.mentions.append(b);
  });
}

function insertMention(name) {
  const el = els.input;
  const pre = el.value && !/\s$/.test(el.value) ? ' ' : '';
  el.value += `${pre}@${name} `;
  el.focus();
  autosize();
  updateSendButton();
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`;
}

/* ------------------------- Llamadas a la IA ------------------------- */

function buildSystem(ai, canPass) {
  const others = settings.ais.filter((a) => a.id !== ai.id).map((a) => a.name).join(' y ');
  return [
    `Estás en un chat de grupo (estilo WhatsApp) con una persona ("Usuario") y otras dos IAs: ${others}. Tú eres ${ai.name}.`,
    `Tu personalidad: ${ai.persona}`,
    '',
    'Reglas:',
    `- Escribe solo tu mensaje, sin empezar con tu nombre ni con "${ai.name}:".`,
    '- Mensajes cortos y naturales, como en un chat: normalmente 1-3 frases. Sin listas largas ni encabezados.',
    '- Responde en el idioma del usuario.',
    '- Puedes dirigirte a otra IA con @Nombre, responderle, discrepar o completar lo que dijo. Aporta algo nuevo; no repitas lo ya dicho ni te presentes de nuevo.',
    '- Para negrita usa *texto* y para cursiva _texto_.',
    '- El historial llega con el formato "Nombre: mensaje".',
    canPass
      ? '- Si ahora mismo no tienes nada útil que añadir, responde exactamente [PASS] y nada más.'
      : '- Esta vez debes responder con un mensaje (no uses [PASS]).',
  ].join('\n');
}

function buildMessages(ai) {
  const recent = messages.filter((m) => m.author !== 'system').slice(-settings.history);
  const out = [];
  for (const m of recent) {
    const role = m.author === ai.id ? 'assistant' : 'user';
    const content = role === 'assistant' ? m.text : `${promptName(m.author)}: ${m.text}`;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  if (!out.length || out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: '(Sigue la conversación con tu siguiente mensaje.)' });
  }
  return out;
}

function friendlyError(status, detail) {
  if (status === 401) return 'La clave de API no es válida. Revísala en Ajustes.';
  if (status === 403) return 'Tu clave no tiene permiso para usar este modelo.';
  if (status === 404) return 'No se encontró el modelo elegido. Cambia el modelo en Ajustes.';
  if (status === 429) return 'Has alcanzado el límite de peticiones. Espera un momento y vuelve a probar.';
  if (status >= 500) return 'El servicio de la API no está disponible ahora mismo. Inténtalo de nuevo en un rato.';
  return `Error ${status}${detail ? `: ${detail}` : ''}`;
}

async function callClaude(ai, system, msgs, signal) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: ai.model, max_tokens: 400, system, messages: msgs }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('No se pudo conectar con la API. Revisa tu conexión a internet.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignorar */ }
    throw new Error(friendlyError(res.status, detail));
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

const isPass = (t) => /^\W*PASS\W*$/i.test(t);

function cleanReply(ai, text) {
  return text.replace(new RegExp(`^\\s*${escapeRe(ai.name)}\\s*:\\s*`, 'i'), '').trim();
}

/* ----------------------- Turnos de conversación ----------------------- */

async function speak(ai, canPass, myRun) {
  typingId = ai.id;
  render();
  const [text] = await Promise.all([
    callClaude(ai, buildSystem(ai, canPass), buildMessages(ai), abortCtl.signal),
    sleep(MIN_TYPING_MS),
  ]);
  if (myRun !== runId) return false;
  typingId = null;
  const clean = cleanReply(ai, text);
  if (!clean || isPass(clean)) {
    render();
    return false;
  }
  addMessage(ai.id, clean);
  return true;
}

function pickNext(passed) {
  const lastMsg = [...messages].reverse().find((m) => m.author !== 'system');
  const candidates = settings.ais.filter((a) => a.id !== lastMsg?.author && !passed.has(a.id));
  if (!candidates.length) return null;
  if (lastMsg && lastMsg.author !== 'user') {
    const mentioned = candidates.filter((a) => mentions(lastMsg.text, a.name));
    if (mentioned.length) return mentioned[0];
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function run() {
  if (abortCtl) abortCtl.abort();
  const myRun = ++runId;
  abortCtl = new AbortController();
  running = true;
  render();
  const alive = () => myRun === runId;

  try {
    // 1) Respuestas al usuario: las IAs mencionadas, o las tres si no hay menciones.
    const lastUser = [...messages].reverse().find((m) => m.author === 'user');
    const mentioned = settings.ais.filter((a) => mentions(lastUser.text, a.name));
    const targets = shuffle(mentioned.length ? mentioned : settings.ais);
    for (const ai of targets) {
      if (!alive()) return;
      await speak(ai, false, myRun);
    }

    // 2) Réplicas entre las IAs. Cada una puede callarse con [PASS].
    let exchanges = 0;
    const passed = new Set();
    while (alive() && exchanges < settings.maxExchanges) {
      const next = pickNext(passed);
      if (!next) break;
      const spoke = await speak(next, true, myRun);
      if (!alive()) return;
      if (spoke) passed.clear();
      else passed.add(next.id);
      exchanges++;
    }
  } catch (err) {
    if (err.name !== 'AbortError' && alive()) {
      typingId = null;
      addSystem(err.message, 'error');
    }
  } finally {
    if (myRun === runId) {
      running = false;
      typingId = null;
      render();
    }
  }
}

function stop() {
  runId++;
  if (abortCtl) abortCtl.abort();
  running = false;
  typingId = null;
  render();
}

function send() {
  const text = els.input.value.trim();
  if (!text) return;
  if (!settings.apiKey) {
    openSettings(true);
    return;
  }
  els.input.value = '';
  autosize();
  addMessage('user', text);
  run();
}

/* ----------------------------- Ajustes ----------------------------- */

function renderAiFields(ais) {
  els.aiFields.replaceChildren();
  ais.forEach((ai, i) => {
    const card = document.createElement('fieldset');
    card.className = `ai-card slot${i}`;
    card.innerHTML = `
      <legend><span class="dot"></span>IA ${i + 1}</legend>
      <label for="ai${i}name">Nombre</label>
      <input id="ai${i}name" type="text" maxlength="20" required pattern="[^\\s@]+" title="Una sola palabra, sin espacios ni @">
      <label for="ai${i}model">Modelo</label>
      <select id="ai${i}model">${MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}</select>
      <label for="ai${i}persona">Personalidad</label>
      <textarea id="ai${i}persona" rows="3"></textarea>`;
    card.querySelector(`#ai${i}name`).value = ai.name;
    card.querySelector(`#ai${i}model`).value = ai.model;
    card.querySelector(`#ai${i}persona`).value = ai.persona;
    els.aiFields.append(card);
  });
}

function openSettings(needKey = false) {
  els.menu.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
  els.apiKey.value = settings.apiKey;
  els.groupName.value = settings.groupName;
  els.maxExchanges.value = settings.maxExchanges;
  renderAiFields(settings.ais);
  els.settings.showModal();
  if (needKey) els.apiKey.focus();
}

function saveFromForm() {
  const ais = settings.ais.map((ai, i) => ({
    id: ai.id,
    name: $(`ai${i}name`).value.trim(),
    model: $(`ai${i}model`).value,
    persona: $(`ai${i}persona`).value.trim(),
  }));
  const names = new Set(ais.map((a) => a.name.toLowerCase()));
  if (names.size < ais.length) {
    alert('Cada IA debe tener un nombre distinto.');
    return false;
  }
  const max = parseInt(els.maxExchanges.value, 10);
  settings = {
    ...settings,
    apiKey: els.apiKey.value.trim(),
    groupName: els.groupName.value.trim() || DEFAULTS.groupName,
    maxExchanges: Number.isNaN(max) ? DEFAULTS.maxExchanges : Math.min(12, Math.max(0, max)),
    ais,
  };
  saveSettings();
  return true;
}

/* ----------------------------- Eventos ----------------------------- */

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (els.sendBtn.dataset.mode === 'stop') stop();
  else send();
});

els.input.addEventListener('input', () => {
  autosize();
  updateSendButton();
});

els.input.addEventListener('keydown', (e) => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) {
    e.preventDefault();
    send();
  }
});

els.menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  els.menu.hidden = !els.menu.hidden;
  els.menuBtn.setAttribute('aria-expanded', String(!els.menu.hidden));
});

document.addEventListener('click', (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target)) {
    els.menu.hidden = true;
    els.menuBtn.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.menu.hidden) {
    els.menu.hidden = true;
    els.menuBtn.setAttribute('aria-expanded', 'false');
    els.menuBtn.focus();
  }
});

$('openSettings').addEventListener('click', () => openSettings());

$('clearChat').addEventListener('click', () => {
  els.menu.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
  if (!confirm('¿Vaciar todo el chat?')) return;
  stop();
  messages = [];
  saveChat();
  render();
});

$('cancelSettings').addEventListener('click', () => els.settings.close());

$('resetAis').addEventListener('click', () => renderAiFields(DEFAULTS.ais));

els.settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!saveFromForm()) return;
  els.settings.close();
  renderMentionChips();
  render();
});

/* ------------------------------ Inicio ------------------------------ */

renderMentionChips();
autosize();
render(true);
