<script>
  import { tick, onMount } from 'svelte';

  // ─── Config ──────────────────────────────────────────
  const AMBIENTES = {
    desarrollo: { url: 'http://127.0.0.1:8000', proxy: '/api-desarrollo' },
    staging: { url: 'https://mide-chatbot-api.buzzword.com.mx', proxy: '/api-staging' },
    producción: { url: 'http://172.10.30.16:8080', proxy: '/api-produccion' },
  };

  const DEFAULT_AMBIENTE = import.meta.env.DEV
    ? 'desarrollo'
    : import.meta.env.MODE === 'staging'
    ? 'staging'
    : 'producción';

  // Leer SOLO el ambiente desde la URL: ?ambiente=producción
  const params = new URLSearchParams(window.location.search);
  const ambienteParam = params.get('ambiente') || DEFAULT_AMBIENTE;

  let ambienteSeleccionado = $state(
    Object.keys(AMBIENTES).includes(ambienteParam) ? ambienteParam : DEFAULT_AMBIENTE
  );

  let apiUrl = $derived.by(() => {
    const config = AMBIENTES[ambienteSeleccionado];
    return {
      real: config.url,
      base: import.meta.env.DEV ? config.proxy : config.url,
    };
  });

  // ─── Estado ──────────────────────────────────────────
  let contextoSeleccionado = $state('');
  let modelo = $state('mistral');
  let maxTurnos = $state(5);
  let inputText = $state('');
  let isLoading = $state(false);
  let chatContainer;
  let configError = $state('');
  let configCargada = $state(false);

  function formatTime(date) {
    return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }

  const MENSAJE_INICIAL = {
    id: 1,
    role: 'bot',
    text: '¡Hola! Soy el asistente del MIDE. ¿En qué puedo ayudarte hoy?',
    time: formatTime(new Date()),
  };

  let messages = $state([{ ...MENSAJE_INICIAL }]);

  // ─── Cargar config del backend ───────────────────────
  async function cargarConfig() {
    configError = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/configLightbot`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 404) {
        configError = `No hay configuración para el ambiente "${ambienteSeleccionado}". Defínela desde la administración.`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      contextoSeleccionado = data.contexto ?? '';
      modelo = data.modelo ?? 'mistral';
      maxTurnos = typeof data.historial === 'number' ? data.historial : 5;
      configCargada = true;
      if (!contextoSeleccionado) {
        configError = `La configuración del ambiente "${ambienteSeleccionado}" no tiene contexto.`;
      }
    } catch (err) {
      configError = `No se pudo cargar la configuración: ${err.message}`;
    }
  }

  // ─── Historial ───────────────────────────────────────
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
    return historial.slice(-maxTurnos * 2);
  }

  async function scrollToBottom() {
    await tick();
    if (chatContainer) {
      chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    }
  }

  // ─── Enviar mensaje ──────────────────────────────────
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

      const t0 = performance.now();
      const response = await fetch(`${apiUrl.base}/chatbot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const data = await response.json();
      const elapsed = Math.round(performance.now() - t0);

      const candidato =
        data.Mensaje ?? data.respuesta ?? data.answer ?? data.response ?? data.message ?? data.content ?? data;
      const botText = typeof candidato === 'string' ? candidato : JSON.stringify(candidato, null, 2);

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
      messages = [
        ...messages,
        {
          id: Date.now() + 1,
          role: 'bot',
          text: 'Lo siento, ocurrió un error al procesar tu mensaje.',
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

  onMount(() => {
    cargarConfig();
  });
</script>

<div class="embed-app">
  <!-- Mini header -->
  <header class="embed-header">
    <div class="embed-avatar">
      <span class="material-symbols-outlined">smart_toy</span>
    </div>
    <div class="embed-header-info">
      <span class="embed-title">Asistente MIDE</span>
      {#if contextoSeleccionado}
        <span class="embed-context">{contextoSeleccionado}</span>
      {/if}
    </div>
  </header>

  {#if configError}
    <div class="config-error">❌ {configError}</div>
  {/if}

  <!-- Chat body -->
  <main class="embed-body" bind:this={chatContainer}>
    <div class="messages">
      {#each messages as msg (msg.id)}
        <div class="message-row {msg.role}" class:error={msg.isError}>
          {#if msg.role === 'bot'}
            <div class="bot-avatar">
              <span class="material-symbols-outlined">smart_toy</span>
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

  <!-- Input -->
  <footer class="embed-input-area">
    <div class="embed-input-container">
      <textarea
        bind:value={inputText}
        onkeydown={handleKeydown}
        placeholder={configCargada ? "Escribe tu mensaje..." : "Cargando configuración..."}
        rows="1"
        disabled={isLoading || !configCargada || !!configError}
      ></textarea>
      <button
        onclick={sendMessage}
        disabled={!inputText.trim() || isLoading || !configCargada || !!configError}
        aria-label="Enviar mensaje"
      >
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>
        </svg>
      </button>
    </div>
    <p class="embed-disclaimer">MIDE · Museo Interactivo de Economía</p>
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
    margin: 0;
  }

  :global(#embed) {
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  .embed-app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: #f0f2f5;
  }

  .config-error {
    background: #c8102e;
    color: #fff;
    padding: 0.55rem 1rem;
    font-size: 0.8rem;
    line-height: 1.4;
    text-align: center;
    flex-shrink: 0;
  }

  /* ── Header ─────────────────────────── */
  .embed-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  }

  .embed-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #6b8aaf;
    border: 2px solid #8faac8;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .embed-avatar .material-symbols-outlined {
    font-size: 22px;
    color: #fff;
    font-variation-settings: 'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 24;
  }

  .embed-header-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .embed-title {
    font-size: 0.9rem;
    font-weight: 700;
    color: #1a1a2e;
  }

  .embed-context {
    font-size: 0.65rem;
    color: #888;
    letter-spacing: 0.03em;
  }

  /* ── Chat body ──────────────────────── */
  .embed-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    scroll-behavior: smooth;
  }

  .embed-body::-webkit-scrollbar {
    width: 4px;
  }

  .embed-body::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.15);
    border-radius: 10px;
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 600px;
    margin: 0 auto;
  }

  /* ── Messages ───────────────────────── */
  .message-row {
    display: flex;
    align-items: flex-end;
    gap: 0.4rem;
    animation: fadeUp 0.3s ease;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .message-row.user {
    flex-direction: row-reverse;
  }

  .bot-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #6b8aaf;
    border: 1.5px solid #8faac8;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: #fff;
  }

  .bot-avatar .material-symbols-outlined {
    font-size: 17px;
    color: #fff;
    font-variation-settings: 'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 20;
  }

  .bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 80%;
  }

  .message-row.user .bubble-wrap {
    align-items: flex-end;
  }

  .bubble {
    padding: 0.6rem 0.85rem;
    border-radius: 16px;
    font-size: 0.875rem;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .message-row.bot .bubble {
    background: #d4e4f7;
    color: #1a1a2e;
    border-bottom-left-radius: 4px;
    border: 1px solid #c0d6ed;
  }

  .message-row.user .bubble {
    background: #fff;
    color: #1a1a2e;
    font-weight: 500;
    border-bottom-right-radius: 4px;
    border: 1px solid #e0e0e0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }

  .message-row.error .bubble {
    background: #fde8e8;
    border-color: #f5a5a5;
    color: #9b1c1c;
  }

  .time {
    font-size: 0.65rem;
    color: #999;
    padding: 0 4px;
  }

  /* ── Typing ─────────────────────────── */
  .bubble.typing {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.75rem 0.9rem;
    min-width: 50px;
  }

  .bubble.typing span {
    display: block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #6b8aaf;
    animation: bounce 1.2s ease-in-out infinite;
  }

  .bubble.typing span:nth-child(1) { animation-delay: 0s; }
  .bubble.typing span:nth-child(2) { animation-delay: 0.2s; }
  .bubble.typing span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); }
    30%            { transform: translateY(-5px); }
  }

  /* ── Input ──────────────────────────── */
  .embed-input-area {
    padding: 0.75rem;
    background: #fff;
    border-top: 1px solid #e0e0e0;
    flex-shrink: 0;
  }

  .embed-input-container {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    max-width: 600px;
    margin: 0 auto;
    background: #f0f2f5;
    border: 1.5px solid #ddd;
    border-radius: 20px;
    padding: 0.4rem 0.4rem 0.4rem 1rem;
    transition: border-color 0.2s, background 0.2s;
  }

  .embed-input-container:focus-within {
    border-color: #6b8aaf;
    background: #f8f9fb;
  }

  textarea {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 0.875rem;
    color: #1a1a2e;
    resize: none;
    line-height: 1.5;
    max-height: 100px;
    overflow-y: auto;
    padding: 4px 0;
  }

  textarea::placeholder {
    color: #999;
  }

  textarea::-webkit-scrollbar { width: 3px; }
  textarea::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 10px; }

  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .embed-input-container button {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: #5b6abf;
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 0.15s, opacity 0.15s, background 0.15s;
    box-shadow: 0 2px 8px rgba(91, 106, 191, 0.35);
  }

  .embed-input-container button svg {
    width: 18px;
    height: 18px;
  }

  .embed-input-container button:hover:not(:disabled) {
    transform: scale(1.08);
    background: #4a59a8;
  }

  .embed-input-container button:active:not(:disabled) {
    transform: scale(0.95);
  }

  .embed-input-container button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .embed-disclaimer {
    text-align: center;
    font-size: 0.6rem;
    color: #aaa;
    margin-top: 0.4rem;
    letter-spacing: 0.04em;
  }
</style>
