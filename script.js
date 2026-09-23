(() => {
  'use strict';

  const KEYS = { hist: 'tdui_historial', mem: 'tdui_memoria', cfg: 'tdui_ajustes', cnt: 'tdui_contador' };
  const AIS = {
    Clau: { cls: 'clau', bio: 'sarcástica, dramática y muy ingeniosa; suelta ironías' },
    Pau: { cls: 'pau', bio: 'caótica, cotilla y fan de los memes; exagera todo' },
    Ju: { cls: 'ju', bio: 'dulce pero con mala leche; suelta verdades sin filtro' }
  };
  const NAMES = Object.keys(AIS);
  const ENDPOINTS = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions'
  };
  const DEFAULT_MODEL = { openrouter: 'openai/gpt-4o-mini', openai: 'gpt-4o-mini', local: 'llama3.2' };
  const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1/chat/completions'; // Ollama; LM Studio usa el puerto 1234
  const LEARN_EVERY = 3; // actualizar la memoria cada 3 mensajes del usuario

  const $ = id => document.getElementById(id);
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento lleno o bloqueado */ } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

  let history = load(KEYS.hist, []);
  let memory = load(KEYS.mem, '');
  let settings = Object.assign({ provider: 'openrouter', apiKey: '', model: '', localUrl: DEFAULT_LOCAL_URL }, load(KEYS.cfg, {}));
  let counter = load(KEYS.cnt, 0);
  let runId = 0;

  /* ---------- DOM ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function dots() { const s = el('span', 'dots'); s.append(el('i'), el('i'), el('i')); return s; }
  function scroll() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
  const hhmm = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  function render(msg) {
    const mine = msg.who === 'user';
    const cls = mine ? 'user' : AIS[msg.who].cls;
    const row = el('div', 'msg ' + cls + (mine ? ' mine' : ''));
    if (!mine) row.append(el('span', 'av ' + cls, msg.who[0]));
    const bubble = el('div', 'bubble');
    if (!mine) bubble.append(el('div', 'name', msg.who));
    if (msg.quote) {
      const qw = msg.quote.who;
      const q = el('div', 'quote ' + (qw === 'user' ? 'user' : AIS[qw].cls));
      q.append(el('b', '', qw === 'user' ? 'Tú' : qw), document.createTextNode(msg.quote.text));
      bubble.append(q);
    }
    bubble.append(document.createTextNode(msg.text), el('span', 'time', hhmm(msg.t)));
    row.append(bubble);
    return row;
  }

  function notice(text) { $('messages').append(el('div', 'sys', text)); scroll(); }

  function addMsg(who, text, quote) {
    const msg = { who, text, t: Date.now() };
    if (quote) msg.quote = quote;
    history.push(msg);
    if (history.length > 300) history = history.slice(-300);
    save(KEYS.hist, history);
    $('messages').append(render(msg));
    scroll();
  }

  function setTyping(name) {
    document.querySelector('.tb')?.remove();
    const st = $('status');
    if (!name) { st.replaceChildren('Clau, Pau, Ju y tú'); return; }
    st.replaceChildren(name + ' está escribiendo', dots());
    const row = el('div', 'msg tb ' + AIS[name].cls);
    const bubble = el('div', 'bubble');
    bubble.append(dots());
    row.append(el('span', 'av ' + AIS[name].cls, name[0]), bubble);
    $('messages').append(row);
    scroll();
  }

  /* ---------- API ---------- */
  async function callAPI(messages, maxTokens, temperature) {
    const provider = settings.provider;
    const headers = { 'Content-Type': 'application/json' };
    if (provider !== 'local') headers.Authorization = 'Bearer ' + settings.apiKey;
    if (provider === 'openrouter') headers['X-Title'] = 'Tres desviadas y una impostora';
    const body = {
      model: settings.model || DEFAULT_MODEL[provider],
      messages,
      temperature,
      [provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokens
    };
    const url = provider === 'local' ? (settings.localUrl || DEFAULT_LOCAL_URL) : ENDPOINTS[provider];
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new Error(provider === 'local'
        ? 'No se pudo conectar con el servidor local. ¿Está Ollama o LM Studio abierto? Mira el README.'
        : 'No hay conexión con el proveedor.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch { /* sin cuerpo JSON */ }
      throw new Error('Error ' + res.status + (detail ? ': ' + detail : ''));
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  /* ---------- Prompts y memoria ---------- */
  function systemPrompt(name) {
    const others = NAMES.filter(n => n !== name).join(' y ');
    return `Eres ${name}, ${AIS[name].bio}. Estás en el grupo de WhatsApp "Tres desviadas y una impostora" con ${others} (también IAs) y una persona humana, a la que llamáis "la impostora" con cariño.
REGLAS:
- Mensajes SÚPER cortos: una sola frase, máximo 10 palabras.
- Tono coloquial y espontáneo de chat de grupo; algún emoji o abreviatura de vez en cuando, no en todos.
- Reacciona al último mensaje y responde a las demás, sin repetir lo que ya se ha dicho.
- Usa lo que sabéis del grupo (memoria) cuando venga a cuento, sin recitarlo.
- Para citar el último mensaje de alguien empieza con [cita:Nombre]. Hazlo pocas veces.
- Responde SOLO con tu mensaje, sin tu nombre ni comillas.
MEMORIA DEL GRUPO (lo que sabemos de la persona y bromas internas):
${memory || '(aún no sabéis nada de ella, id conociéndola)'}`;
  }

  function transcript(n) {
    return history.slice(-n).map(m => (m.who === 'user' ? 'Usuario' : m.who) + ': ' + m.text).join('\n');
  }

  function parse(raw) {
    let t = raw.replace(/\s*\n+\s*/g, ' ').replace(/^["“]+|["”]+$/g, '').trim();
    t = t.replace(new RegExp('^(' + NAMES.join('|') + ')\\s*:\\s*', 'i'), '');
    let quote = null;
    const m = t.match(/^\[cita:\s*(Clau|Pau|Ju|Usuario)\]\s*/i);
    if (m) {
      t = t.slice(m[0].length);
      const who = /^usuario$/i.test(m[1]) ? 'user' : NAMES.find(n => n.toLowerCase() === m[1].toLowerCase());
      const orig = [...history].reverse().find(x => x.who === who);
      if (orig) quote = { who, text: orig.text.slice(0, 80) };
    }
    return { text: t, quote };
  }

  // Aprendizaje: cada pocos mensajes se resume lo nuevo y se fusiona con la memoria guardada.
  async function learn() {
    counter++;
    save(KEYS.cnt, counter);
    if (counter % LEARN_EVERY !== 0) return;
    try {
      const out = await callAPI([
        { role: 'system', content: 'Mantienes la memoria compartida de un chat de grupo. Devuelve SOLO la memoria actualizada, en español, como líneas cortas que empiecen por "- " (máximo 20). Incluye datos de la persona (nombre, gustos, trabajo, familia, manías), bromas internas, apodos, temas recurrentes y cómo le gusta que le hablen. Conserva lo antiguo importante, fusiona duplicados, descarta lo trivial y no inventes nada.' },
        { role: 'user', content: 'Memoria actual:\n' + (memory || '(vacía)') + '\n\nConversación reciente:\n' + transcript(20) + '\n\nMemoria actualizada:' }
      ], 400, 0.3);
      if (out) { memory = out.slice(0, 3000); save(KEYS.mem, memory); }
    } catch { /* si falla, se reintenta en el siguiente ciclo */ }
  }

  /* ---------- Turnos ---------- */
  async function generate(name) {
    return callAPI([
      { role: 'system', content: systemPrompt(name) },
      { role: 'user', content: 'Chat reciente:\n' + transcript(30) + '\n\nEscribe el siguiente mensaje de ' + name + '.' }
    ], 40, 1);
  }

  async function round() {
    const id = ++runId; // si el usuario escribe de nuevo, esta ronda se cancela
    const order = shuffle(NAMES).slice(0, 2 + Math.floor(Math.random() * 2));
    for (const name of order) {
      if (id !== runId) return;
      setTyping(name);
      let raw;
      try {
        [raw] = await Promise.all([generate(name), sleep(1500 + Math.random() * 1000)]);
      } catch (e) {
        if (id === runId) { setTyping(null); notice(e.message); }
        return;
      }
      if (id !== runId) return;
      setTyping(null);
      const { text, quote } = parse(raw);
      if (text) addMsg(name, text, quote);
    }
    if (id === runId) learn();
  }

  /* ---------- Ajustes ---------- */
  const dlg = $('dlg');
  function syncProvider(p) {
    $('keyBox').hidden = p === 'local';
    $('urlBox').hidden = p !== 'local';
    $('model').placeholder = DEFAULT_MODEL[p];
  }
  function openSettings() {
    $('provider').value = settings.provider;
    $('apiKey').value = settings.apiKey;
    $('model').value = settings.model;
    $('localUrl').value = settings.localUrl;
    syncProvider(settings.provider);
    $('memory').value = memory;
    dlg.returnValue = '';
    dlg.showModal();
  }
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    settings = {
      provider: $('provider').value,
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),
      localUrl: $('localUrl').value.trim() || DEFAULT_LOCAL_URL
    };
    memory = $('memory').value.trim();
    save(KEYS.cfg, settings);
    save(KEYS.mem, memory);
  });
  $('provider').addEventListener('change', e => { $('model').value = ''; syncProvider(e.target.value); });
  $('btnMenu').addEventListener('click', openSettings);
  $('btnKey').addEventListener('click', openSettings);

  $('reset').addEventListener('click', () => {
    if (!confirm('¿Borrar el historial y la memoria? No se puede deshacer.')) return;
    runId++;
    history = []; memory = ''; counter = 0;
    [KEYS.hist, KEYS.mem, KEYS.cnt].forEach(k => localStorage.removeItem(k));
    $('messages').replaceChildren();
    setTyping(null);
    dlg.close('cancel');
    notice('Memoria e historial reiniciados. Empezáis de cero.');
  });

  /* ---------- Envío e inicio ---------- */
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    if (settings.provider !== 'local' && !settings.apiKey) { notice('Falta la API Key: ábrela con el botón 🔑.'); openSettings(); return; }
    $('input').value = '';
    addMsg('user', text);
    round();
  });

  history.forEach(m => $('messages').append(render(m)));
  if (!history.length) notice('Escribe algo para empezar. Aquí la impostora eres tú 😏');
  scroll();
  if (settings.provider !== 'local' && !settings.apiKey) openSettings();
})();
