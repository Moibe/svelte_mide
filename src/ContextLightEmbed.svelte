<script>
  // ─── Config ──────────────────────────────────────────
  // El API se infiere del hostname donde corre el embed.
  const HOSTNAME_TO_API = {
    'mide-chatbot.buzzword.com.mx': 'https://mide-chatbot-api.buzzword.com.mx',
    'mide-chatbot.mide.org.mx':     'https://mide-chatbot-api.mide.org.mx',
    // Acceso directo por IP interna (red corporativa) — HTTP plano:
    '172.10.30.15':  'http://172.10.30.15:8080',
    '172.16.60.233': 'http://172.16.60.233:8080',
  };

  const AMBIENTE_LABEL = (() => {
    if (import.meta.env.DEV) return 'desarrollo';
    const host = window.location.hostname;
    if (host === 'mide-chatbot.buzzword.com.mx' || host === '172.10.30.15') return 'staging';
    if (host === 'mide-chatbot.mide.org.mx' || host === '172.16.60.233') return 'producción';
    return host || 'desconocido';
  })();

  const apiUrl = (() => {
    if (import.meta.env.DEV) {
      return { real: 'http://127.0.0.1:8000', base: '/api' };
    }
    const host = window.location.hostname;
    const real = HOSTNAME_TO_API[host] ?? window.location.origin;
    return { real, base: real };
  })();

  // ─── Estado ──────────────────────────────────────────
  let contexto = $state('');
  let configError = $state('');
  let configCargada = $state(false);
  let documentos = $state([]);
  let cargando = $state(false);
  let archivo = $state(null);
  let cargandoIntegrar = $state(false);
  let progreso = $state(0);
  let mensaje = $state('');
  let mensajeBorrar = $state('');
  let cargandoBorrar = $state(false);
  let confirmarBorrar = $state(null);

  async function cargarConfig() {
    configError = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/configContextlight`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 404) {
        configError = `No hay configuración para el ambiente "${AMBIENTE_LABEL}". Defínela desde la administración.`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      contexto = data.contexto ?? '';
      configCargada = true;
      if (!contexto) {
        configError = `La configuración del ambiente "${AMBIENTE_LABEL}" no tiene base de conocimiento.`;
        return;
      }
      cargarDocumentos();
    } catch (err) {
      configError = `No se pudo cargar la configuración: ${err.message}`;
    }
  }

  async function cargarDocumentos() {
    if (!contexto) return;
    cargando = true;
    documentos = [];
    try {
      const res = await fetch(`${apiUrl.base}/listarDocumentos?contexto=${encodeURIComponent(contexto)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      documentos = Array.isArray(data.documentos) ? data.documentos : [];
    } catch (err) {
      console.error('Error al cargar documentos', err);
    } finally {
      cargando = false;
    }
  }

  async function integrarDocumento() {
    if (!archivo || !contexto) return;
    cargandoIntegrar = true;
    progreso = 0;
    mensaje = '';
    try {
      const formData = new FormData();
      formData.append('documento', archivo);
      const url = `${apiUrl.base}/integrarDocumento?contexto=${encodeURIComponent(contexto)}`;
      const nombre = archivo.name;

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) progreso = Math.round((e.loaded / e.total) * 100);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { progreso = 100; resolve(); }
          else reject(new Error(`HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('Error de red'));
        xhr.send(formData);
      });

      mensaje = `✅ "${nombre}" integrado`;
      archivo = null;
      const fileInput = document.getElementById('cle-archivo');
      if (fileInput) fileInput.value = '';
      setTimeout(cargarDocumentos, 800);
    } catch (err) {
      mensaje = `❌ Error: ${err.message}`;
    } finally {
      cargandoIntegrar = false;
    }
  }

  async function borrarDocumento(nombre) {
    cargandoBorrar = true;
    mensajeBorrar = '';
    try {
      const res = await fetch(`${apiUrl.base}/quitarDocumento`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: nombre, contexto }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mensajeBorrar = `✅ "${nombre}" borrado`;
      confirmarBorrar = null;
      setTimeout(cargarDocumentos, 800);
    } catch (err) {
      mensajeBorrar = `❌ Error: ${err.message}`;
    } finally {
      cargandoBorrar = false;
    }
  }

  cargarConfig();
</script>

<div class="embed-app">
  <!-- Mini header -->
  <header class="embed-header">
    <div class="embed-avatar">
      <span class="material-symbols-outlined">dashboard_2_gear</span>
    </div>
    <div class="embed-header-info">
      <span class="embed-title">Gestión de Chatbot</span>
      {#if contexto}
        <span class="embed-context">{contexto}</span>
      {/if}
    </div>
    <button class="embed-reload" onclick={cargarDocumentos} disabled={cargando} title="Recargar" aria-label="Recargar">
      <span class="material-symbols-outlined">autorenew</span>
    </button>
  </header>

  {#if configError}
    <div class="config-error">❌ {configError}</div>
  {/if}

  <!-- Body -->
  <main class="embed-body">
    {#if !configCargada && !configError}
      <p class="empty-msg">⟳ Cargando configuración...</p>
    {:else if !contexto}
      <p class="empty-msg">No se pudo determinar la base de conocimiento. Verifica la administración del ambiente <strong>{AMBIENTE_LABEL}</strong>.</p>
    {:else}
      <section class="card">
        <h3><span class="material-symbols-outlined section-icon">document_scanner</span> Documentos</h3>
        {#if cargando}
          <p class="muted">⟳ Cargando documentos...</p>
        {:else if documentos.length === 0}
          <p class="muted">No hay documentos en esta base de conocimiento.</p>
        {:else}
          <ul class="doc-list">
            {#each documentos as doc (doc)}
              <li class="doc-row">
                <span><span class="material-symbols-outlined doc-icon">article</span> {doc}</span>
                <button class="btn-trash" disabled={cargandoBorrar} onclick={() => confirmarBorrar = doc} title="Borrar"><span class="material-symbols-outlined">delete</span></button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if mensajeBorrar}
          <p class="msg" class:success={mensajeBorrar.includes('✅')}>{mensajeBorrar}</p>
        {/if}
      </section>

      <section class="card">
        <h3><span class="material-symbols-outlined section-icon">upload_file</span> Agregar documento</h3>
        <label class="file-label">
          <span class="file-fake-btn">Seleccionar archivo</span>
          <span class="file-name">{archivo ? archivo.name : 'Sin archivo'}</span>
          <input
            id="cle-archivo"
            type="file"
            accept=".txt,.pdf,.doc,.docx"
            disabled={cargandoIntegrar}
            onchange={(e) => { archivo = e.target.files?.[0] ?? null; }}
          />
        </label>
        {#if archivo}
          <small class="muted">{(archivo.size / 1024).toFixed(2)} KB</small>
        {/if}
        <button class="btn-primary" onclick={integrarDocumento} disabled={cargandoIntegrar || !archivo}>
          {cargandoIntegrar ? `⟳ Procesando ${progreso}%` : '✓ Integrar'}
        </button>
        {#if cargandoIntegrar}
          <div class="progress"><div class="progress-bar" style="width:{progreso}%"></div></div>
        {/if}
        {#if mensaje}
          <p class="msg" class:success={mensaje.includes('✅')}>{mensaje}</p>
        {/if}
      </section>
    {/if}
  </main>

  <footer class="embed-footer">
    <p class="embed-disclaimer">MIDE · Museo Interactivo de Economía</p>
  </footer>

  {#if confirmarBorrar}
    <div class="modal-overlay" onclick={() => confirmarBorrar = null} role="presentation">
      <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') confirmarBorrar = null; }} role="dialog" tabindex="-1">
        <h3>⚠️ Confirmar borrado</h3>
        <p>¿Borrar el documento <strong>"{confirmarBorrar}"</strong>?</p>
        <p class="muted">Esta acción es irreversible.</p>
        <div class="modal-actions">
          <button class="btn-secondary" disabled={cargandoBorrar} onclick={() => confirmarBorrar = null}>Cancelar</button>
          <button class="btn-danger" disabled={cargandoBorrar} onclick={() => borrarDocumento(confirmarBorrar)}>
            {cargandoBorrar ? '⟳ Borrando...' : 'Sí, borrar'}
          </button>
        </div>
      </div>
    </div>
  {/if}
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
    background: #fff;
    border: 1px solid #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .embed-avatar .material-symbols-outlined {
    font-size: 22px;
    color: #1f1f1f;
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  }

  .embed-header-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .embed-reload {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid #d6dde6;
    background: #f0f2f5;
    color: #1a1a2e;
    cursor: pointer;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .embed-reload:hover:not(:disabled) { background: #d4e4f7; }
  .embed-reload:disabled { opacity: 0.5; cursor: not-allowed; }
  .embed-reload .material-symbols-outlined {
    font-size: 18px;
    color: #1f1f1f;
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
  }

  /* ── Body ───────────────────────────── */
  .embed-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    scroll-behavior: smooth;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .embed-body::-webkit-scrollbar { width: 4px; }
  .embed-body::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.15); border-radius: 10px; }

  .empty-msg {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    padding: 1rem;
    color: #6b7280;
    font-size: 0.85rem;
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

  .card {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    padding: 0.85rem 1rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  }

  .card h3 {
    font-size: 0.85rem;
    color: #1a1a2e;
    margin-bottom: 0.6rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .section-icon {
    font-size: 18px;
    color: #1f1f1f;
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
  }
  .doc-icon {
    font-size: 18px;
    color: #1f1f1f;
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
    vertical-align: middle;
    margin-right: 4px;
  }

  .muted {
    color: #888;
    font-size: 0.8rem;
    margin: 0.4rem 0;
  }

  .doc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid #e8eaed;
    border-radius: 8px;
    overflow: hidden;
  }
  .doc-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid #f3f4f6;
    font-size: 0.85rem;
    color: #1a1a2e;
    background: #fff;
  }
  .doc-row:last-child { border-bottom: none; }
  .doc-row > span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn-trash {
    background: #f0f2f5;
    border: 1px solid #d6dde6;
    border-radius: 6px;
    padding: 3px 9px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background 0.15s;
  }
  .btn-trash:hover:not(:disabled) {
    background: #fde8e8;
    border-color: #f5a5a5;
  }
  .btn-trash:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-trash .material-symbols-outlined {
    font-size: 18px;
    color: #1f1f1f;
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
    vertical-align: middle;
  }
  .btn-trash:hover:not(:disabled) .material-symbols-outlined {
    color: #c8102e;
  }

  /* File input */
  .file-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.4rem 0;
    cursor: pointer;
  }
  .file-label input[type="file"] {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    overflow: hidden;
  }
  .file-fake-btn {
    background: #f0f2f5;
    border: 1.5px solid #ddd;
    border-radius: 16px;
    padding: 0.35rem 0.85rem;
    font-size: 0.8rem;
    color: #1a1a2e;
    transition: border-color 0.15s, background 0.15s;
  }
  .file-label:hover .file-fake-btn {
    background: #d4e4f7;
    border-color: #6b8aaf;
  }
  .file-name {
    font-size: 0.8rem;
    color: #6b7280;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .btn-primary {
    background: #5b6abf;
    color: #fff;
    border: none;
    padding: 0.5rem 1.1rem;
    border-radius: 20px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    margin-top: 0.5rem;
    box-shadow: 0 2px 8px rgba(91, 106, 191, 0.35);
    transition: transform 0.15s, background 0.15s;
  }
  .btn-primary:hover:not(:disabled) {
    background: #4a59a8;
    transform: scale(1.02);
  }
  .btn-primary:active:not(:disabled) { transform: scale(0.98); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }

  .btn-secondary {
    background: #f0f2f5;
    border: 1px solid #d6dde6;
    padding: 0.45rem 0.95rem;
    border-radius: 16px;
    cursor: pointer;
    font-size: 0.85rem;
    color: #1a1a2e;
  }
  .btn-secondary:hover:not(:disabled) { background: #d4e4f7; }

  .btn-danger {
    background: #c8102e;
    color: #fff;
    border: none;
    padding: 0.45rem 0.95rem;
    border-radius: 16px;
    cursor: pointer;
    font-size: 0.85rem;
    box-shadow: 0 2px 8px rgba(200, 16, 46, 0.35);
  }
  .btn-danger:hover:not(:disabled) { background: #a30d24; }
  .btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }

  .msg {
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
    color: #9b1c1c;
  }
  .msg.success { color: #15803d; }

  .progress {
    height: 6px;
    background: #e0e0e0;
    border-radius: 999px;
    margin-top: 0.5rem;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: #5b6abf;
    transition: width 0.2s;
  }

  /* ── Footer ─────────────────────────── */
  .embed-footer {
    padding: 0.5rem;
    background: #fff;
    border-top: 1px solid #e0e0e0;
    flex-shrink: 0;
  }
  .embed-disclaimer {
    text-align: center;
    font-size: 0.6rem;
    color: #aaa;
    letter-spacing: 0.04em;
  }

  /* ── Modal ──────────────────────────── */
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex; justify-content: center; align-items: center;
    z-index: 1000;
  }
  .modal {
    background: #fff;
    padding: 1.25rem 1.5rem;
    border-radius: 12px;
    max-width: 380px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  }
  .modal h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    color: #1a1a2e;
  }
  .modal p { font-size: 0.85rem; color: #1a1a2e; margin: 0.3rem 0; }
  .modal-actions {
    display: flex; gap: 0.5rem; justify-content: flex-end;
    margin-top: 1rem;
  }
</style>
