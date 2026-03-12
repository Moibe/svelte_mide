<script>
  import { tick } from 'svelte';

  // ─── Sesión & Logs ───────────────────────────────────────────────
  const SESSION_ID = crypto.randomUUID();
  let logs = $state([]);

  async function registrarLog({ pregunta, historial, respuesta, ms, error }) {
    const entry = {
      fecha: new Date().toISOString(),
      sesion: SESSION_ID,
      ambiente: ambienteSeleccionado,
      modelo,
      contexto: contextoSeleccionado,
      pregunta,
      historial: JSON.stringify(historial),
      respuesta: respuesta ?? '',
      ms: ms ?? 0,
      error: error ?? '',
    };
    logs = [...logs, entry];
    console.groupCollapsed(
      `%c📋 Log #${logs.length}  ·  ${entry.ambiente}  ·  ${entry.ms || '—'}ms`,
      'color:#7c3aed;font-weight:bold;font-size:12px'
    );
    console.table({ ...entry, historial: `(${historial.length} msgs)` });
    console.log('Historial completo:', historial);
    console.groupEnd();

    // Guardar en SQLite vía API
    try {
      const res = await fetch(`${apiUrl.base}/registrarLog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      if (res.ok) {
        console.log('%c💾 Log guardado en BD', 'color:#16a34a;font-weight:bold');
      } else {
        console.warn('%c⚠️ Error al guardar log en BD:', 'color:orange;font-weight:bold', res.status);
      }
    } catch (err) {
      console.warn('%c⚠️ No se pudo guardar log en BD:', 'color:orange;font-weight:bold', err.message);
    }

    return entry;
  }

  const AMBIENTES = {
    desarrollo: { url: 'http://127.0.0.1:8000', proxy: '/api-desarrollo' },
    staging: { url: 'http://172.10.30.15:8080', proxy: '/api-staging' },
    producción: { url: 'http://172.10.30.16:8080', proxy: '/api-produccion' },
  };

  // Determina el ambiente por defecto según build mode
  const DEFAULT_AMBIENTE = import.meta.env.DEV
    ? 'desarrollo'
    : import.meta.env.MODE === 'staging'
    ? 'staging'
    : 'producción';

  // Estado reactivo del ambiente seleccionado (recupera del localStorage)
  let ambienteSeleccionado = $state(
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('mide_ambiente') || DEFAULT_AMBIENTE
      : DEFAULT_AMBIENTE
  );

  // Resuelve API_BASE y API_URL_REAL dinámicamente según ambienteSeleccionado
  let apiUrl = $derived.by(() => {
    const config = AMBIENTES[ambienteSeleccionado];
    return {
      real: config.url,
      base: import.meta.env.DEV ? config.proxy : config.url,
    };
  });

  // Función para cambiar ambiente — recarga contextos al cambiar
  function cambiarAmbiente(nuevoAmbiente) {
    ambienteSeleccionado = nuevoAmbiente;
    localStorage.setItem('mide_ambiente', nuevoAmbiente);
    console.log(`🔄 Ambiente cambiado a: ${nuevoAmbiente}`);
    console.log(`📍 API URL: ${apiUrl.real}/chatbot`);
    cargarContextos();
  }

  // Exponer helpers de log en consola para depuración
  if (typeof window !== 'undefined') {
    window.__mideLogs = () => logs;
    window.__mideSession = SESSION_ID;
  }

  $effect(() => {
    console.groupCollapsed('%c🌐 MIDE Chat — Configuración', 'color:#c8102e;font-weight:bold;font-size:13px');
    console.log('Sesión     :', SESSION_ID);
    console.log('Ambiente   :', ambienteSeleccionado);
    console.log('API URL    :', apiUrl.real);
    console.log('Endpoint   :', `${apiUrl.real}/chatbot`);
    console.groupEnd();
    // Carga inicial de contextos al montar
    cargarContextos();
  });

  let messages = $state([
    {
      id: 1,
      role: 'bot',
      text: '¡Hola! Soy el asistente del MIDE. ¿En qué puedo ayudarte hoy?',
      time: formatTime(new Date()),
    },
  ]);

  const MODELOS = ['mistral', 'llama3.1'];

  let modelo = $state('mistral');
  let contextos = $state([]);
  let contextoSeleccionado = $state('');
  let cargandoContextos = $state(false);
  let inputText = $state('');
  let isLoading = $state(false);
  let chatContainer;

  async function cargarContextos() {
    cargandoContextos = true;
    contextos = [];
    contextoSeleccionado = '';
    try {
      const res = await fetch(`${apiUrl.base}/listarContextos`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // La API devuelve { "Contextos existentes para este chatbot": { "nombre": {...}, ... } }
      const mapa = data['Contextos existentes para este chatbot'] ?? {};
      contextos = Object.keys(mapa);
      contextoSeleccionado = contextos[0] ?? '';
      console.log('%c📂 Contextos cargados:', 'color:#c8102e;font-weight:bold', contextos);
    } catch (err) {
      console.error('%c❌ Error al cargar contextos', 'color:red;font-weight:bold', err);
    } finally {
      cargandoContextos = false;
    }
  }

  const MAX_TURNOS = 5;

  // Construye el historial en formato role/content (últimos 5 turnos)
  function buildHistorial() {
    const historial = [];
    const convo = messages.filter((m) => m.role === 'user' || m.role === 'bot');
    let i = 0;
    while (i < convo.length) {
      if (convo[i]?.role === 'user' && convo[i + 1]?.role === 'bot') {
        historial.push({ role: 'user', content: convo[i].text });
        historial.push({ role: 'assistant', content: convo[i + 1].text });
        i += 2;
      } else {
        i += 1;
      }
    }
    // Cada turno = 2 entradas (user + assistant), conservar últimos 5 turnos
    return historial.slice(-MAX_TURNOS * 2);
  }

  function formatTime(date) {
    return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  async function scrollToBottom() {
    await tick();
    if (chatContainer) {
      chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    }
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || isLoading) return;

    inputText = '';

    messages = [
      ...messages,
      { id: Date.now(), role: 'user', text, time: formatTime(new Date()) },
    ];
    await scrollToBottom();

    isLoading = true;

    try {
      const payload = {
        contexto: contextoSeleccionado,
        modelo_llm: modelo,
        pregunta: text,
        historial: buildHistorial(),
      };

      console.groupCollapsed(`%c📤 POST /chatbot`, 'color:#c8102e;font-weight:bold;font-size:12px');
      console.log('URL enviada :', `${apiUrl.real}/chatbot`);
      console.log('Ambiente    :', ambienteSeleccionado);
      console.log('Payload     :', JSON.parse(JSON.stringify(payload)));
      console.log('Body JSON   :', JSON.stringify(payload, null, 2));
      console.groupEnd();

      const t0 = performance.now();

      const response = await fetch(`${apiUrl.base}/chatbot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '(sin body)');
        console.error(`%c❌ HTTP ${response.status}`, 'color:red;font-weight:bold');
        console.error('Response body:', errorBody);
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const data = await response.json();

      const elapsed = Math.round(performance.now() - t0);

      console.groupCollapsed(`%c📥 Respuesta /chatbot (${elapsed}ms)`, 'color:#16a34a;font-weight:bold;font-size:12px');
      console.log('Status      :', response.status);
      console.log('Tiempo      :', `${elapsed}ms`);
      console.log('JSON        :', data);
      console.groupEnd();

      const botText =
        data.Mensaje ?? data.respuesta ?? data.answer ?? data.response ?? data.message ?? JSON.stringify(data);

      registrarLog({
        pregunta: text,
        historial: payload.historial,
        respuesta: botText,
        ms: elapsed,
      });

      messages = [
        ...messages,
        {
          id: Date.now() + 1,
          role: 'bot',
          text: botText,
          time: `${formatTime(new Date())} · ${elapsed}ms`,
        },
      ];
    } catch (err) {
      console.error('%c❌ Error al llamar /chatbot', 'color:red;font-weight:bold', err);

      registrarLog({
        pregunta: text,
        historial: payload?.historial ?? [],
        respuesta: null,
        ms: null,
        error: err.message,
      });

      messages = [
        ...messages,
        {
          id: Date.now() + 1,
          role: 'bot',
          text: 'Lo siento, ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.',
          time: formatTime(new Date()),
          isError: true,
        },
      ];
    } finally {
      isLoading = false;
      await scrollToBottom();
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<div class="app">
  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <div class="avatar">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="white"/>
        </svg>
      </div>
      <div class="header-info">
        <h1 class="header-title">Asistente MIDE</h1>
        <span class="header-status">
          <span class="status-dot"></span>
          En línea
        </span>
      </div>
      <div class="ambiente-toggle">
        {#each Object.keys(AMBIENTES) as amb}
          <button
            class="ambiente-btn"
            class:active={ambienteSeleccionado === amb}
            onclick={() => cambiarAmbiente(amb)}
            aria-pressed={ambienteSeleccionado === amb}
          >{amb}</button>
        {/each}
      </div>
    </div>
    <div class="context-select-wrap">
      <label for="ctx-select">Contexto</label>
      {#if cargandoContextos}
        <span class="ctx-loading">cargando...</span>
      {:else if contextos.length === 0}
        <span class="ctx-loading">sin contextos</span>
      {:else}
        <select id="ctx-select" bind:value={contextoSeleccionado}>
          {#each contextos as ctx}
            <option value={ctx}>{ctx}</option>
          {/each}
        </select>
      {/if}
    </div>
    <div class="model-toggle">
      {#each MODELOS as m}
        <button
          class="model-btn"
          class:active={modelo === m}
          onclick={() => (modelo = m)}
          aria-pressed={modelo === m}
        >{m}</button>
      {/each}
    </div>
    <div class="header-logo">MIDE</div>
  </header>

  <!-- Chat body -->
  <main class="chat-body" bind:this={chatContainer}>
    <div class="messages">
      {#each messages as msg (msg.id)}
        <div class="message-row {msg.role}" class:error={msg.isError}>
          {#if msg.role === 'bot'}
            <div class="bot-avatar">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/>
              </svg>
            </div>
          {/if}
          <div class="bubble-wrap">
            <div class="bubble">{msg.text}</div>
            <span class="time">{msg.time}</span>
          </div>
        </div>
      {/each}

      {#if isLoading}
        <div class="message-row bot">
          <div class="bot-avatar">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/>
            </svg>
          </div>
          <div class="bubble-wrap">
            <div class="bubble typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </main>

  <!-- Input area -->
  <footer class="input-area">
    <div class="input-container">
      <textarea
        bind:value={inputText}
        onkeydown={handleKeydown}
        placeholder="Escribe tu mensaje..."
        rows="1"
        disabled={isLoading}
      ></textarea>
      <button
        onclick={sendMessage}
        disabled={!inputText.trim() || isLoading}
        aria-label="Enviar mensaje"
      >
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>
        </svg>
      </button>
    </div>
    <p class="disclaimer">MIDE · Museo Interactivo de Economía</p>
  </footer>
</div>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    height: 100dvh;
    overflow: hidden;
  }

  :global(#app) {
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: linear-gradient(160deg, #6b0016 0%, #a80028 30%, #c8102e 60%, #e0154a 100%);
  }

  /* ── Header ─────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.2);
    border: 2px solid rgba(255, 255, 255, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar svg {
    width: 24px;
    height: 24px;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .header-title {
    font-size: 1rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.01em;
  }

  .header-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.75);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 6px #4ade80;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .header-logo {
    font-size: 1.25rem;
    font-weight: 800;
    color: rgba(255, 255, 255, 0.9);
    letter-spacing: 0.06em;
  }

  .header-center {
    flex: 1;
    display: flex;
    justify-content: center;
  }

  .ambiente-toggle {
    display: flex;
    gap: 3px;
    background: rgba(0, 0, 0, 0.2);
    padding: 3px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .ambiente-btn {
    width: auto;
    height: auto;
    border-radius: 14px;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.5);
    font-family: inherit;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
    box-shadow: none;
    letter-spacing: 0.01em;
    text-transform: capitalize;
  }

  .ambiente-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.75);
  }

  .ambiente-btn.active {
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  }

  /* ── Model toggle ────────────────────────────────── */
  .model-toggle {
    display: flex;
    gap: 4px;
    background: rgba(0, 0, 0, 0.2);
    padding: 4px;
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .model-btn {
    width: auto;
    height: auto;
    border-radius: 16px;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.65);
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.2s, color 0.2s, transform 0.15s;
    box-shadow: none;
    letter-spacing: 0.02em;
  }

  .model-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    transform: none;
  }

  .model-btn.active {
    background: #fff;
    color: #c8102e;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  }

  .model-btn.active:hover:not(:disabled) {
    background: #f0f0f0;
  }

  /* ── Chat body ───────────────────────────────────── */
  .chat-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 1rem;
    scroll-behavior: smooth;
  }

  .chat-body::-webkit-scrollbar {
    width: 5px;
  }

  .chat-body::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.25);
    border-radius: 10px;
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 780px;
    margin: 0 auto;
  }

  /* ── Message rows ────────────────────────────────── */
  .message-row {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    animation: fadeUp 0.3s ease;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .message-row.user {
    flex-direction: row-reverse;
  }

  .bot-avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.15);
    border: 1.5px solid rgba(255, 255, 255, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: rgba(255, 255, 255, 0.85);
  }

  .bot-avatar svg {
    width: 18px;
    height: 18px;
  }

  .bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-width: 72%;
  }

  .message-row.user .bubble-wrap {
    align-items: flex-end;
  }

  .bubble {
    padding: 0.75rem 1rem;
    border-radius: 18px;
    font-size: 0.9375rem;
    line-height: 1.55;
    word-break: break-word;
    white-space: pre-wrap;
  }

  /* Bot bubble */
  .message-row.bot .bubble {
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #fff;
    border-bottom-left-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.18);
  }

  /* User bubble */
  .message-row.user .bubble {
    background: #fff;
    color: #a80028;
    font-weight: 500;
    border-bottom-right-radius: 4px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  }

  .message-row.error .bubble {
    background: rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 100, 100, 0.4);
    color: rgba(255, 200, 200, 0.9);
  }

  .time {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.5);
    padding: 0 4px;
  }

  /* ── Typing indicator ─────────────────────────────── */
  .bubble.typing {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0.9rem 1.1rem;
    min-width: 60px;
  }

  .bubble.typing span {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.7);
    animation: bounce 1.2s ease-in-out infinite;
  }

  .bubble.typing span:nth-child(1) { animation-delay: 0s; }
  .bubble.typing span:nth-child(2) { animation-delay: 0.2s; }
  .bubble.typing span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); }
    30%            { transform: translateY(-6px); }
  }

  /* ── Input area ──────────────────────────────────── */
  .input-area {
    padding: 1rem 1rem 1.25rem;
    background: rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    flex-shrink: 0;
  }

  .input-container {
    display: flex;
    align-items: flex-end;
    gap: 0.625rem;
    max-width: 780px;
    margin: 0 auto;
    background: rgba(255, 255, 255, 0.12);
    border: 1.5px solid rgba(255, 255, 255, 0.22);
    border-radius: 24px;
    padding: 0.5rem 0.5rem 0.5rem 1.25rem;
    transition: border-color 0.2s, background 0.2s;
  }

  .input-container:focus-within {
    border-color: rgba(255, 255, 255, 0.55);
    background: rgba(255, 255, 255, 0.18);
  }

  textarea {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 0.9375rem;
    color: #fff;
    resize: none;
    line-height: 1.5;
    max-height: 120px;
    overflow-y: auto;
    padding: 4px 0;
  }

  textarea::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }

  textarea::-webkit-scrollbar { width: 3px; }
  textarea::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 10px; }

  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  button {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: none;
    background: #fff;
    color: #c8102e;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 0.15s, opacity 0.15s, background 0.15s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  }

  button svg {
    width: 20px;
    height: 20px;
  }

  button:hover:not(:disabled) {
    transform: scale(1.08);
    background: #f0f0f0;
  }

  button:active:not(:disabled) {
    transform: scale(0.95);
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .disclaimer {
    text-align: center;
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.35);
    margin-top: 0.6rem;
    letter-spacing: 0.04em;
  }

  /* ── Footer controls (contexto + disclaimer) ─────── */
  .context-select-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .context-select-wrap label {
    font-size: 0.65rem;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.45);
    letter-spacing: 0.05em;
    white-space: nowrap;
    text-transform: uppercase;
  }

  .context-select-wrap select {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 14px;
    color: #fff;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    padding: 4px 24px 4px 10px;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M6 9l6 6 6-6' stroke='rgba(255,255,255,0.5)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    transition: border-color 0.2s, background 0.2s;
    max-width: 180px;
  }

  .context-select-wrap select:hover {
    background-color: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.25);
  }

  .context-select-wrap select:focus {
    border-color: rgba(255, 255, 255, 0.4);
    background-color: rgba(255, 255, 255, 0.18);
  }

  .context-select-wrap select option {
    background: #a80028;
    color: #fff;
  }

  .ctx-loading {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.35);
    font-style: italic;
  }

  /* ── Responsive ──────────────────────────────────── */
  @media (max-width: 480px) {
    .header { padding: 0.875rem 1rem; }
    .chat-body { padding: 1rem 0.75rem; }
    .bubble-wrap { max-width: 85%; }
    .header-logo { display: none; }
  }
</style>
