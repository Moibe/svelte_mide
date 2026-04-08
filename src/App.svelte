<script>
  import { tick, onMount, untrack } from 'svelte';

  // ─── Sesión & Logs ───────────────────────────────────────────────
  function generateSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    // getRandomValues suele seguir disponible aun sin secure context.
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const SESSION_ID = generateSessionId();
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
    if (ambienteSeleccionado !== nuevoAmbiente) {
      modelosEmbedding = []; // Limpiamos caché de modelos
      nuevoContextoEmbedding = '';
      // Limpia mensajes/estado del panel admin para evitar residuos del ambiente anterior
      mensajeCrearContexto = '';
      mensajeBorrarContexto = '';
      mensajeIntegrarDocumento = '';
      mensajeBorrarDocumento = '';
      errorAdminContextos = '';
      contextoABorrar = '';
      documentoSeleccionadoParaBorrar = '';
      mostrarConfirmacionBorrar = false;
      mostrarConfirmacionBorrarDocumento = false;
    }
    ambienteSeleccionado = nuevoAmbiente;
    localStorage.setItem('mide_ambiente', nuevoAmbiente);
    console.log(`🔄 Ambiente cambiado a: ${nuevoAmbiente}`);
    console.log(`📍 API URL: ${apiUrl.real}/chatbot`);
    cargarContextos();
    if (activeTab === 'admin') {
      cargarContextosAdmin();
    }
    verificarSalud();
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

  // Carga contextos en admin cuando cambia el tab
  $effect(() => {
    if (activeTab === 'admin') {
      untrack(() => {
        cargarContextosAdmin();
      });
    }
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
  const MODELOS_OPENAI = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];

  let modelo = $state('mistral');
  let contextos = $state([]);
  let contextoSeleccionado = $state('');
  let cargandoContextos = $state(false);
  let inputText = $state('');
  let isLoading = $state(false);
  let chatContainer = $state(null);
  let activeTab = $state('chat');
  let adminTab = $state('contextos');

  // Lightbot config (defaults para embed)
  let lightbotAmbiente = $state('staging');
  let lightbotContexto = $state('');
  let lightbotModelo = $state('mistral');
  let lightbotHistorial = $state(3);

  // Auto-seleccionar contexto con 'mxbai' para lightbot
  $effect(() => {
    if (!lightbotContexto && contextos.length > 0) {
      const mxbai = contextos.find(c => c.toLowerCase().includes('mxbai'));
      if (mxbai) lightbotContexto = mxbai;
    }
  });

  let administracionContextos = $state([]);
  let cargandoAdminContextos = $state(false);
  
  // Modelos de Embedding
  let modelosEmbedding = $state([]);
  let cargandoModelosEmbedding = $state(false);

  let errorAdminContextos = $state('');
  const DEFAULT_EMBEDDING_MODEL = 'mxbai';
  const MODELOS_EMBEDDING_OPENAI = ['text-embedding-3-small', 'text-embedding-3-large'];
  let nuevoContextoNombre = $state('');
  let nuevoContextoEmbedding = $state('');
  let nuevoContextoChunkSize = $state('1500');

  // Nombre auto-generado: mide-<primera_palabra_modelo>-<chunk>
  const nombreContextoGenerado = $derived.by(() => {
    const primerapalabra = (nuevoContextoEmbedding || '').split(/[-:_\s]/)[0].toLowerCase();
    const chunk = nuevoContextoChunkSize || '1500';
    return primerapalabra ? `mide-${primerapalabra}-${chunk}` : 'mide--1500';
  });
  let cargandoCrearContexto = $state(false);
  let mensajeCrearContexto = $state('');
  let contextoABorrar = $state('');
  let mostrarConfirmacionBorrar = $state(false);
  let cargandoBorrarContexto = $state(false);
  let mensajeBorrarContexto = $state('');
  let administracionDocumentos = $state([]);
  let cargandoAdminDocumentos = $state(false);
  let documentoSeleccionadoParaBorrar = $state('');
  let contextoSeleccionadoParaDocumentos = $state('');
  let archivoParaIntegrar = $state(null);
  let cargandoIntegrarDocumento = $state(false);
  let progresoIntegrar = $state(0);
  let mensajeIntegrarDocumento = $state('');
  let cargandoBorrarDocumento = $state(false);
  let mensajeBorrarDocumento = $state('');
  let mostrarConfirmacionBorrarDocumento = $state(false);
  let integracionEnCurso = $state(null);
  let modelosDisponibles = $state([]);
  let cargandoModelos = $state(false);
  let errorModelos = $state('');
  let modeloSeleccionado = $state(null);
  let infoModeloSeleccionado = $state(null);
  let cargandoInfoModelo = $state(false);
  // Cache por ambiente para modelos de embedding
  let cacheModelosEmbedding = {};
  let chunkSugeridoPorModelo = {
    // Defaults estáticos para modelos de OpenAI (max tokens del modelo)
    'text-embedding-3-small': '8191',
    'text-embedding-3-large': '8191',
  };
  let estadoSalud = $state('checking'); // 'online', 'offline', 'checking'
  let ultimaVerificacion = $state(null);
  let timerVerificacion = null;
  let debounceInputHealth = null;

  function verificarSaludDesdeInput() {
    clearTimeout(debounceInputHealth);
    debounceInputHealth = setTimeout(verificarSalud, 500);
  }

  function reprogramarTimer() {
    clearInterval(timerVerificacion);
    const intervalo = estadoSalud === 'online' ? 60000 : 180000; // 1 min online, 3 min offline
    timerVerificacion = setInterval(verificarSalud, intervalo);
  }

  async function verificarSalud() {
    // No interferir con peticiones de chat activas
    if (isLoading) return;
    const estadoPrevio = estadoSalud;
    estadoSalud = 'checking';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${apiUrl.base}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      estadoSalud = data.status === 'ok' ? 'online' : 'offline';
      if (estadoSalud === 'online') {
        errorAdminContextos = '';
        // Si la API acaba de regresar, recargar contextos
        if (estadoPrevio === 'offline') {
          console.log('%c🔄 API regresó online — recargando contextos', 'color:#16a34a;font-weight:bold');
          cargarContextos();
        }
      }
      ultimaVerificacion = new Date();
    } catch (err) {
      estadoSalud = 'offline';
      ultimaVerificacion = new Date();
    }
    reprogramarTimer();
  }

  onMount(() => {
    verificarSalud(); // incluye reprogramarTimer() al terminar
    return () => clearInterval(timerVerificacion);
  });

  async function cargarModelos() {
    cargandoModelos = true;
    modelosDisponibles = [];
    errorModelos = '';
    modeloSeleccionado = null;
    infoModeloSeleccionado = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/listarModelos`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Maneja array directo o {modelos: [...]}
      if (Array.isArray(data)) {
        modelosDisponibles = data;
      } else if (data.modelos && Array.isArray(data.modelos)) {
        modelosDisponibles = data.modelos;
      } else {
        modelosDisponibles = [];
      }
      console.log('%c🤖 Modelos cargados:', 'color:#0077ff;font-weight:bold', modelosDisponibles);
    } catch (err) {
      if (err.name === 'AbortError') {
        errorModelos = '⏳ La API no respondió (tiempo de espera agotado). Intenta recargar en unos momentos.';
        console.warn('%c⏳ Timeout al cargar modelos', 'color:orange;font-weight:bold');
      } else {
        errorModelos = `API ${ambienteSeleccionado.charAt(0).toUpperCase() + ambienteSeleccionado.slice(1)} offline`;
        console.error('%c❌ Error al cargar modelos', 'color:red;font-weight:bold', err);
      }
    } finally {
      cargandoModelos = false;
    }
  }

  function seleccionarModeloDefault(lista) {
    const match = lista.find(m => m.toLowerCase().includes(DEFAULT_EMBEDDING_MODEL.toLowerCase()));
    return match || lista[0];
  }

  function aplicarChunkSugerido(modelo) {
    if (modelo && chunkSugeridoPorModelo[modelo]) {
      nuevoContextoChunkSize = chunkSugeridoPorModelo[modelo];
    }
  }

  async function cargarInfoModelo(modelo) {
    cargandoInfoModelo = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/infoModelo/${encodeURIComponent(modelo)}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      infoModeloSeleccionado = data;
      console.log('%c📋 Info modelo cargada:', 'color:#0077ff;font-weight:bold', data);
    } catch (err) {
      console.error('%c❌ Error al cargar info del modelo', 'color:red;font-weight:bold', err);
      infoModeloSeleccionado = null;
    } finally {
      cargandoInfoModelo = false;
    }
  }

  async function cargarContextos() {
    cargandoContextos = true;
    contextos = [];
    contextoSeleccionado = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/listarContextos`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log('%c📂 Respuesta /listarContextos:', 'color:#c8102e;font-weight:bold', data);
      
      // Soportar múltiples formatos de respuesta
      let mapa = {};
      if (data['Contextos existentes para este chatbot']) {
        mapa = data['Contextos existentes para este chatbot'];
      } else if (Array.isArray(data)) {
        // Si devuelve un array directo de nombres
        contextos = data;
        contextoSeleccionado = contextos[0] ?? '';
        console.log('%c📂 Contextos cargados:', 'color:#c8102e;font-weight:bold', contextos);
        return;
      } else if (data.contextos && typeof data.contextos === 'object') {
        mapa = data.contextos;
      } else {
        // Último recurso: usar las keys del primer objeto que encuentre
        const firstObjKey = Object.keys(data).find(k => typeof data[k] === 'object' && data[k] !== null);
        if (firstObjKey) mapa = data[firstObjKey];
      }
      
      contextos = Array.isArray(mapa) ? mapa : Object.keys(mapa);
      contextoSeleccionado = contextos[0] ?? '';
      console.log('%c📂 Contextos cargados:', 'color:#c8102e;font-weight:bold', contextos);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('%c⏳ Timeout al cargar contextos — la API puede estar ocupada', 'color:orange;font-weight:bold');
      } else {
        console.error('%c❌ Error al cargar contextos', 'color:red;font-weight:bold', err);
      }
    } finally {
      cargandoContextos = false;
    }
  }

  async function cargarModelosEmbedding() {
    cargandoModelosEmbedding = true;
    modelosEmbedding = [];
    try {
      // Reuse cache for current environment if available
      if (cacheModelosEmbedding[ambienteSeleccionado]?.length) {
        modelosEmbedding = cacheModelosEmbedding[ambienteSeleccionado];
        if (modelosEmbedding.length > 0 && !nuevoContextoEmbedding) {
          const preferido = seleccionarModeloDefault(modelosEmbedding);
          nuevoContextoEmbedding = preferido;
          aplicarChunkSugerido(preferido);
        }
        return;
      }

      // 1. Listar todos los modelos
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/listarModelos`, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      // Parse response based on format
      let listaModelos = [];
      if (Array.isArray(data)) listaModelos = data;
      else if (data.modelos && Array.isArray(data.modelos)) listaModelos = data.modelos;

      // 2. Verificar cada modelo para ver si es de embedding
      const modelosConfirmados = [];

      // Validar cada modelo
      for (const modelo of listaModelos) {
        try {
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 5000); // 5s por modelo
          const r2 = await fetch(`${apiUrl.base}/infoModelo/${encodeURIComponent(modelo)}`, { signal: c2.signal });
          clearTimeout(t2);
          
          if (r2.ok) {
            const info = await r2.json();

            // Preferir la bandera que ya entrega la API
            // Guardar chunk_size_sugerido si viene en la respuesta
            if (info.chunk_size_sugerido) {
              chunkSugeridoPorModelo[modelo] = String(info.chunk_size_sugerido);
            }

            const tipo = (info.tipo || '').toString().toLowerCase();
            if (tipo === 'embedding') {
              modelosConfirmados.push(modelo);
              continue;
            }

            // Fallback heurístico si la API no trae tipo
            let familiesStr = "";
            const details = info.details || {};
            if (Array.isArray(details.families)) familiesStr = details.families.join(" ").toLowerCase();
            else if (typeof details.family === "string") familiesStr = details.family.toLowerCase();
            
            const nombre = modelo.toLowerCase();

            if (nombre.includes('embed') || familiesStr.includes('bert')) {
              modelosConfirmados.push(modelo);
            }
          }
        } catch (e) {
          console.warn(`Error al verificar modelo ${modelo} para embeddings:`, e);
        }
      }
      // Combinar modelos de Ollama con los de OpenAI (evitando duplicados)
      const todosLosModelos = [
        ...modelosConfirmados,
        ...MODELOS_EMBEDDING_OPENAI.filter(m => !modelosConfirmados.includes(m))
      ];
      modelosEmbedding = todosLosModelos;
      cacheModelosEmbedding[ambienteSeleccionado] = modelosEmbedding;
      // Seleccionar por defecto uno si hay y no hay seleccion
      if (modelosEmbedding.length > 0 && !nuevoContextoEmbedding) {
        const preferido = seleccionarModeloDefault(modelosEmbedding);
        nuevoContextoEmbedding = preferido;
        aplicarChunkSugerido(preferido);
      }

      console.log('%c🧬 Modelos Embeddings detectados:', 'color:#d0f;font-weight:bold', modelosEmbedding);

    } catch (err) {
      console.error('Error al cargar modelos de embedding:', err);
      // Aunque falle la API, mostrar siempre los modelos de OpenAI
      if (modelosEmbedding.length === 0) {
        modelosEmbedding = [...MODELOS_EMBEDDING_OPENAI];
        if (!nuevoContextoEmbedding) {
          const preferido = seleccionarModeloDefault(modelosEmbedding);
          nuevoContextoEmbedding = preferido;
          aplicarChunkSugerido(preferido);
        }
      }
    } finally {
      cargandoModelosEmbedding = false;
    }
  }

  async function cargarContextosAdmin() {
    cargandoAdminContextos = true;
    // Solo carga modelos si no están en caché
    if (modelosEmbedding.length === 0) {
      cargarModelosEmbedding();
    }
    administracionContextos = [];
    errorAdminContextos = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${apiUrl.base}/listarContextos`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const mapa = data['Contextos existentes para este chatbot'] ?? {};
      administracionContextos = Object.entries(mapa).map(([nombre, info]) => ({
        nombre,
        info: typeof info === 'object' ? info : {},
        timestamp: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      }));
      console.log('%c📂 Contextos Admin cargados:', 'color:#0077ff;font-weight:bold', $state.snapshot(administracionContextos));
    } catch (err) {
      if (err.name === 'AbortError') {
        errorAdminContextos = '⏳ La API no respondió (tiempo de espera agotado). Puede estar ocupada procesando un documento. Intenta recargar en unos momentos.';
        console.warn('%c⏳ Timeout al cargar contextos admin — la API puede estar ocupada', 'color:orange;font-weight:bold');
      } else {
        errorAdminContextos = `API ${ambienteSeleccionado.charAt(0).toUpperCase() + ambienteSeleccionado.slice(1)} offline`;
        console.error('%c❌ Error al cargar contextos admin', 'color:red;font-weight:bold', err);
      }
    } finally {
      cargandoAdminContextos = false;
    }
  }

  async function crearContexto() {
    if (!nombreContextoGenerado || !nuevoContextoEmbedding.trim()) {
      mensajeCrearContexto = '❌ Selecciona un modelo de embedding';
      return;
    }

    const chunkSizeNum = parseInt(nuevoContextoChunkSize, 10);
    if (isNaN(chunkSizeNum) || chunkSizeNum < 1) {
      mensajeCrearContexto = '❌ Chunk size debe ser un número válido mayor a 0';
      return;
    }

    cargandoCrearContexto = true;
    mensajeCrearContexto = '';

    try {
      const nombre = encodeURIComponent(nombreContextoGenerado);
      const modelo = encodeURIComponent(nuevoContextoEmbedding.trim());
      const chunk = encodeURIComponent(chunkSizeNum);
      const url = `${apiUrl.base}/crearContexto?nombre_contexto=${nombre}&embedding_model=${modelo}&chunk_size=${chunk}`;

      console.groupCollapsed(`%c📤 POST /crearContexto`, 'color:#0077ff;font-weight:bold;font-size:12px');
      console.log('URL enviada :', `${apiUrl.real}/crearContexto`);
      console.log('Query params:', { nombre_contexto: nombre, embedding_model: modelo, chunk_size: chunk });
      console.groupEnd();

      const res = await fetch(url, {
        method: 'POST'
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '(sin detalles)');
        let friendlyMessage = errorText;
        try {
           const jsonError = JSON.parse(errorText);
           // Handle FastAPI detail format (string or array/object)
           if (jsonError.detail) {
             friendlyMessage = typeof jsonError.detail === 'string' 
               ? jsonError.detail 
               : JSON.stringify(jsonError.detail);
           } else {
             friendlyMessage = jsonError.message || jsonError.error || friendlyMessage;
           }
        } catch (e) {}

        if (res.status === 400) {
             throw new Error(friendlyMessage); 
        }
        throw new Error(`HTTP ${res.status}: ${friendlyMessage}`);
      }

      const data = await res.json();

      console.groupCollapsed(`%c📥 Respuesta /crearContexto`, 'color:#16a34a;font-weight:bold;font-size:12px');
      console.log('Status      :', res.status);
      console.log('Respuesta   :', data);
      console.groupEnd();

      mensajeCrearContexto = `✅ ${data.Mensaje ?? `Contexto "${nuevoContextoNombre}" creado exitosamente`}`;
      nuevoContextoNombre = '';
      nuevoContextoEmbedding = '';
      nuevoContextoChunkSize = '1500';

      // Recarga la lista después de 1 segundo
      setTimeout(() => {
        cargarContextosAdmin();
      }, 1000);

    } catch (err) {
      console.error('%c❌ Error al crear contexto', 'color:red;font-weight:bold', err);
      mensajeCrearContexto = `❌ Error: ${err.message}`;
    } finally {
      cargandoCrearContexto = false;
    }
  }

  async function borrarContextoConfirmado() {
    if (!contextoABorrar.trim()) {
      mensajeBorrarContexto = '❌ Selecciona un contexto para borrar';
      return;
    }

    cargandoBorrarContexto = true;
    mensajeBorrarContexto = '';

    try {
      const nombreContexto = contextoABorrar.trim();
      console.groupCollapsed(`%c📤 DELETE /borrarContexto`, 'color:#ff6b35;font-weight:bold;font-size:12px');
      console.log('URL enviada :', `${apiUrl.real}/borrarContexto?contexto=${encodeURIComponent(nombreContexto)}`);
      console.log('Query param :', { contexto: nombreContexto });
      console.groupEnd();

      const res = await fetch(`${apiUrl.base}/borrarContexto?contexto=${encodeURIComponent(nombreContexto)}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '(sin detalles)');
        throw new Error(`HTTP ${res.status}: ${errorBody}`);
      }

      const data = await res.json();

      console.groupCollapsed(`%c📥 Respuesta /borrarContexto`, 'color:#16a34a;font-weight:bold;font-size:12px');
      console.log('Status      :', res.status);
      console.log('Respuesta   :', data);
      console.groupEnd();

      mensajeBorrarContexto = `✅ ${data.Mensaje ?? `Contexto "${contextoABorrar}" borrado exitosamente`}`;
      contextoABorrar = '';
      mostrarConfirmacionBorrar = false;

      // Recarga la lista después de 1 segundo
      setTimeout(() => {
        cargarContextosAdmin();
      }, 1000);

    } catch (err) {
      console.error('%c❌ Error al borrar contexto', 'color:red;font-weight:bold', err);
      mensajeBorrarContexto = `❌ Error: ${err.message}`;
    } finally {
      cargandoBorrarContexto = false;
    }
  }

  async function cargarDocumentosAdmin(contexto) {
    if (!contexto.trim()) {
      mensajeIntegrarDocumento = '❌ Selecciona un contexto primero';
      return;
    }

    cargandoAdminDocumentos = true;
    administracionDocumentos = [];

    try {
      const res = await fetch(`${apiUrl.base}/listarDocumentos?contexto=${encodeURIComponent(contexto)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // La API devuelve { contexto, documentos: [...], conteo }
      administracionDocumentos = Array.isArray(data.documentos) ? data.documentos : [];
      console.log('%c📄 Documentos cargados:', 'color:#0077ff;font-weight:bold', administracionDocumentos);
    } catch (err) {
      console.error('%c❌ Error al cargar documentos', 'color:red;font-weight:bold', err);
    } finally {
      cargandoAdminDocumentos = false;
    }
  }

  async function integrarDocumento() {
    if (!contextoSeleccionadoParaDocumentos.trim()) {
      mensajeIntegrarDocumento = '❌ Selecciona un contexto';
      return;
    }
    if (!archivoParaIntegrar) {
      mensajeIntegrarDocumento = '❌ Selecciona un archivo';
      return;
    }

    cargandoIntegrarDocumento = true;
    progresoIntegrar = 0;
    mensajeIntegrarDocumento = '';

    // Guardar en localStorage que hay una integración en curso
    const infoIntegracion = {
      archivo: archivoParaIntegrar.name,
      contexto: contextoSeleccionadoParaDocumentos,
      inicio: new Date().toISOString()
    };
    localStorage.setItem('mide_integracion_pendiente', JSON.stringify(infoIntegracion));
    integracionEnCurso = infoIntegracion;

    try {
      const formData = new FormData();
      formData.append('documento', archivoParaIntegrar);

      const fetchUrl = `${apiUrl.base}/integrarDocumento?contexto=${encodeURIComponent(contextoSeleccionadoParaDocumentos)}`;

      console.groupCollapsed(`%c📤 POST /integrarDocumento`, 'color:#0077ff;font-weight:bold;font-size:12px');
      console.log('URL enviada :', `${apiUrl.real}/integrarDocumento`);
      console.log('Contexto   :', contextoSeleccionadoParaDocumentos);
      console.log('Archivo    :', archivoParaIntegrar.name);
      console.groupEnd();

      const nombreArchivo = archivoParaIntegrar.name;

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', fetchUrl);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            progresoIntegrar = Math.round((e.loaded / e.total) * 100);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            progresoIntegrar = 100;
            try {
              const data = JSON.parse(xhr.responseText);
              console.groupCollapsed(`%c📥 Respuesta /integrarDocumento`, 'color:#16a34a;font-weight:bold;font-size:12px');
              console.log('Status      :', xhr.status);
              console.log('Respuesta   :', data);
              console.groupEnd();
            } catch (_) {}
            resolve();
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || '(sin detalles)'}`))
          }
        };

        xhr.onerror = () => reject(new Error('Error de red al enviar el archivo'));
        xhr.send(formData);
      });

      mensajeIntegrarDocumento = `✅ Documento "${nombreArchivo}" integrado exitosamente`;
      archivoParaIntegrar = null;
      localStorage.removeItem('mide_integracion_pendiente');
      integracionEnCurso = null;

      // Recarga la lista después de 1 segundo
      setTimeout(() => {
        cargarDocumentosAdmin(contextoSeleccionadoParaDocumentos);
      }, 1000);

    } catch (err) {
      console.error('%c❌ Error al integrar documento', 'color:red;font-weight:bold', err);
      mensajeIntegrarDocumento = `❌ Error: ${err.message}`;
    } finally {
      cargandoIntegrarDocumento = false;
      localStorage.removeItem('mide_integracion_pendiente');
      integracionEnCurso = null;
    }
  }

  async function borrarDocumentoConfirmado() {
    if (!documentoSeleccionadoParaBorrar.trim()) {
      mensajeBorrarDocumento = '❌ Selecciona un documento para borrar';
      return;
    }

    cargandoBorrarDocumento = true;
    mensajeBorrarDocumento = '';

    try {
      const payload = {
        filename: documentoSeleccionadoParaBorrar.trim(),
        contexto: contextoSeleccionadoParaDocumentos.trim()
      };

      console.groupCollapsed(`%c📤 DELETE /quitarDocumento`, 'color:#ff6b35;font-weight:bold;font-size:12px');
      console.log('URL enviada :', `${apiUrl.real}/quitarDocumento`);
      console.log('Payload     :', payload);
      console.groupEnd();

      const res = await fetch(`${apiUrl.base}/quitarDocumento`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '(sin detalles)');
        throw new Error(`HTTP ${res.status}: ${errorBody}`);
      }

      const data = await res.json();

      console.groupCollapsed(`%c📥 Respuesta /quitarDocumento`, 'color:#16a34a;font-weight:bold;font-size:12px');
      console.log('Status      :', res.status);
      console.log('Respuesta   :', data);
      console.groupEnd();

      mensajeBorrarDocumento = `✅ Documento "${documentoSeleccionadoParaBorrar}" borrado exitosamente`;
      documentoSeleccionadoParaBorrar = '';
      mostrarConfirmacionBorrarDocumento = false;

      // Recarga la lista después de 1 segundo
      setTimeout(() => {
        cargarDocumentosAdmin(contextoSeleccionadoParaDocumentos);
      }, 1000);

    } catch (err) {
      console.error('%c❌ Error al borrar documento', 'color:red;font-weight:bold', err);
      mensajeBorrarDocumento = `❌ Error: ${err.message}`;
    } finally {
      cargandoBorrarDocumento = false;
    }
  }

  let maxTurnos = $state(5);

  // Construye el historial en formato role/content (últimos N turnos)
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
    // Cada turno = 2 entradas (user + assistant), conservar últimos N turnos
    return historial.slice(-maxTurnos * 2);
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

  const MENSAJE_INICIAL = {
    id: 1,
    role: 'bot',
    text: '¡Hola! Soy el asistente del MIDE. ¿En qué puedo ayudarte hoy?',
    time: formatTime(new Date()),
  };

  function resetChat() {
    messages = [{ ...MENSAJE_INICIAL, time: formatTime(new Date()) }];
    inputText = '';
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
      console.log('Keys        :', Object.keys(data));
      console.groupEnd();

      // Extraer texto: recorre claves conocidas; si el valor es objeto, lo serializa
      const candidato =
        data.Mensaje ?? data.respuesta ?? data.answer ?? data.response ?? data.message ?? data.content ?? data;
      const botText = typeof candidato === 'string'
        ? candidato
        : JSON.stringify(candidato, null, 2);

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

<div class="app" class:admin={activeTab === 'admin'}>
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
        <span class="header-status" onclick={verificarSalud} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && verificarSalud()} title="Click para verificar conexión" role="button" tabindex="0">
          <span class="status-dot" class:online={estadoSalud === 'online'} class:offline={estadoSalud === 'offline'} class:checking={estadoSalud === 'checking'}></span>
          {#if estadoSalud === 'online'}
            En linea
          {:else if estadoSalud === 'offline'}
            Sin conexion
          {:else}
            Verificando...
          {/if}
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
    {#if estadoSalud === 'online'}
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
    <div class="context-select-wrap">
      <label for="historial-select">Historial</label>
      <select id="historial-select" bind:value={maxTurnos}>
        <option value={0}>Sin historial</option>
        <option value={1}>1 turno</option>
        <option value={3}>3 turnos</option>
        <option value={5}>5 turnos</option>
        <option value={10}>10 turnos</option>
        <option value={20}>20 turnos</option>
      </select>
      <button
        class="clear-chat-btn"
        onclick={resetChat}
        disabled={messages.length <= 1}
        title="Limpiar conversación"
        aria-label="Limpiar conversación"
      >&#x1F5D1;</button>
    </div>
    {/if}
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
    <div class="model-toggle model-toggle-openai">
      <span class="model-toggle-label">OpenAI</span>
      {#each MODELOS_OPENAI as m}
        <button
          class="model-btn model-btn-openai"
          class:active={modelo === m}
          onclick={() => (modelo = m)}
          aria-pressed={modelo === m}
        >{m.replace('gpt-', '')}</button>
      {/each}
    </div>
    <div class="tabs-toggle">
      <button
        class="tab-btn"
        class:active={activeTab === 'chat'}
        onclick={() => { activeTab = 'chat'; cargarContextos(); verificarSalud(); }}
        aria-pressed={activeTab === 'chat'}
      >💬 Chatbot</button>
      <button
        class="tab-btn"
        class:active={activeTab === 'admin'}
        onclick={() => { activeTab = 'admin'; verificarSalud(); }}
        aria-pressed={activeTab === 'admin'}
      >⚙️ Administración</button>
    </div>
  </header>

  <!-- Chat body -->
  {#if activeTab === 'chat'}
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
  {/if}

  <!-- Input area -->
  {#if activeTab === 'chat'}
  <footer class="input-area">
    <div class="input-container">
      <button
        onclick={resetChat}
        disabled={isLoading || messages.length === 0}
        aria-label="Limpiar chat"
        class="reset-btn"
        title="Limpiar conversación"
      >
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/>
        </svg>
      </button>
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
  {/if}

  <!-- Admin section -->
  {#if activeTab === 'admin'}
    <main class="admin-body">
      <div class="admin-container">

        <!-- Banner de integración en curso -->
        {#if integracionEnCurso && !cargandoIntegrarDocumento}
          <div class="banner-integracion">
            <div class="banner-integracion-icon">⏳</div>
            <div class="banner-integracion-text">
              <strong>Integración en curso</strong>
              <p>El documento <strong>"{integracionEnCurso.archivo}"</strong> se está procesando en el contexto <strong>"{integracionEnCurso.contexto}"</strong>. La API puede tardar en responder a otras peticiones.</p>
              <button class="banner-dismiss-btn" onclick={() => { localStorage.removeItem('mide_integracion_pendiente'); integracionEnCurso = null; }}>✕ Descartar</button>
            </div>
          </div>
        {/if}

        <!-- Mensaje de Error Global -->
        {#if errorAdminContextos && estadoSalud !== 'online'}
          <div style="margin-bottom: 1.5rem; padding: 1rem; background: rgba(255,170,0,0.1); border-left: 4px solid rgba(255,170,0,0.7); border-radius: 8px;">
            <p style="color: rgba(255,200,0,0.9); font-size: 0.95rem; line-height: 1.5; margin: 0;">❌ {errorAdminContextos}</p>
          </div>
        {/if}

        <!-- Sub-tab bar -->
        <div class="admin-subtabs">
          <button
            class="admin-subtab-btn"
            class:active={adminTab === 'contextos'}
            onclick={() => adminTab = 'contextos'}
          >
            📂 Contextos
          </button>
          <button
            class="admin-subtab-btn"
            class:active={adminTab === 'documentos'}
            onclick={() => adminTab = 'documentos'}
          >
            📄 Documentos
          </button>
          <button
            class="admin-subtab-btn"
            class:active={adminTab === 'modelos'}
            onclick={() => { adminTab = 'modelos'; cargarModelos(); }}
          >
            🤖 Modelos
          </button>
          <button
            class="admin-subtab-btn"
            class:active={adminTab === 'lightbot'}
            onclick={() => adminTab = 'lightbot'}
          >
            💬 Lightbot
          </button>
        </div>

        <!-- Dashboard -->
        <!-- Contextos -->
        {#if adminTab === 'contextos'}
          <div class="contextos-table-wrap">
            <div class="seccion-header">
              <h3>📂 Contextos Disponibles</h3>
              <button onclick={cargarContextosAdmin} class="admin-action-btn" disabled={cargandoAdminContextos}>
                🔄 Recargar
              </button>
            </div>
            {#if cargandoAdminContextos}
              <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">⟳ Cargando contextos...</p>
            {:else if administracionContextos.length === 0}
              <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">No hay contextos disponibles</p>
            {:else}
              <div class="contextos-table">
                {#each administracionContextos as contexto (contexto.nombre)}
                  <div class="contexto-row">
                    <span class="contexto-nombre">{contexto.nombre}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="crear-contexto-wrap">
            <h3>➕ Crear Nuevo Contexto</h3>
            <div class="crear-contexto-form">
              <div class="form-field">
                <label for="contexto-nombre">Nombre del Contexto</label>
                <input
                  id="contexto-nombre"
                  type="text"
                  value={nombreContextoGenerado}
                  disabled
                  class="contexto-input"
                  style="opacity: 0.65; cursor: default;"
                />
              </div>
              <div class="form-field">
                <label for="contexto-embedding">
                  Modelo de Embedding
                  {#if cargandoModelosEmbedding}
                    <span style="font-size:0.75rem; color:#888; margin-left:8px;">(Cargando...)</span>
                  {/if}
                </label>
                {#if modelosEmbedding.length > 0}
                  <select
                    id="contexto-embedding"
                    bind:value={nuevoContextoEmbedding}
                    onchange={() => aplicarChunkSugerido(nuevoContextoEmbedding)}
                    disabled={cargandoCrearContexto}
                    class="contexto-input"
                    style="display: block; width: 100%;"
                  >
                    <option value="">-- Selecciona Modelo --</option>
                    {#each modelosEmbedding as emb (emb)}
                      <option value={emb}>{emb}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    id="contexto-embedding"
                    type="text"
                    placeholder="ej: nomic-embed-text"
                    bind:value={nuevoContextoEmbedding}
                    disabled={cargandoCrearContexto}
                    class="contexto-input"
                  />
                  {#if !cargandoModelosEmbedding}
                    <p class="field-hint">No se detectaron modelos especificos de embedding, ingresa el nombre manual.</p>
                  {/if}
                {/if}
              </div>
              <div class="form-field">
                <label for="contexto-chunk-size">Medida Embedding</label>
                <input
                  id="contexto-chunk-size"
                  type="number"
                  value={nuevoContextoChunkSize}
                  onchange={(e) => nuevoContextoChunkSize = e.target.value}
                  disabled={cargandoCrearContexto}
                  class="contexto-input"
                  min="1"
                  style="-moz-appearance: textfield;"
                />
              </div>
              <button
                onclick={crearContexto}
                disabled={cargandoCrearContexto || !nombreContextoGenerado || !nuevoContextoEmbedding.trim()}
                class="crear-contexto-btn"
              >
                {cargandoCrearContexto ? '⟳ Creando...' : '✓ Crear'}
              </button>
            </div>
            {#if mensajeCrearContexto}
              <p class="mensaje-contexto" class:success={mensajeCrearContexto.includes('✅')}>
                {mensajeCrearContexto}
              </p>
            {/if}
          </div>

          <div class="borrar-contexto-wrap">
            <h3>🗑️ Borrar Contexto</h3>
            <div class="borrar-contexto-form">
              <div class="form-field" style="flex: 1;">
                <label for="contexto-a-borrar">Selecciona contexto</label>
                <select
                  id="contexto-a-borrar"
                  bind:value={contextoABorrar}
                  disabled={cargandoBorrarContexto || administracionContextos.length === 0}
                  class="contexto-select"
                >
                  <option value="">-- Selecciona un contexto --</option>
                  {#each administracionContextos as contexto (contexto.nombre)}
                    <option value={contexto.nombre}>{contexto.nombre}</option>
                  {/each}
                </select>
              </div>
              <button
                onclick={() => mostrarConfirmacionBorrar = true}
                disabled={cargandoBorrarContexto || !contextoABorrar.trim()}
                class="borrar-contexto-btn"
              >
                🗑️ Borrar
              </button>
            </div>
            {#if mensajeBorrarContexto}
              <p class="mensaje-contexto" class:success={mensajeBorrarContexto.includes('✅')}>
                {mensajeBorrarContexto}
              </p>
            {/if}
          </div>
        {/if}

        <!-- Documentos -->
        {#if adminTab === 'documentos'}
          <div class="documentos-wrap">
            <div class="seccion-header">
              <h3>📄 Documentos por Contexto</h3>
              <button onclick={() => cargarDocumentosAdmin(contextoSeleccionadoParaDocumentos)} class="admin-action-btn" disabled={cargandoAdminDocumentos}>
                🔄 Recargar
              </button>
            </div>

            <!-- Selector de contexto -->
            <div class="documentos-contexto-select">
              <label for="doc-contexto">Selecciona contexto:</label>
              <select
                id="doc-contexto"
                bind:value={contextoSeleccionadoParaDocumentos}
                onchange={() => cargarDocumentosAdmin(contextoSeleccionadoParaDocumentos)}
                class="contexto-select"
              >
                <option value="">-- Selecciona un contexto --</option>
                {#each administracionContextos as contexto (contexto.nombre)}
                  <option value={contexto.nombre}>{contexto.nombre}</option>
                {/each}
              </select>
            </div>

            <!-- Lista de documentos -->
            {#if contextoSeleccionadoParaDocumentos}
              <div class="documentos-list-wrap">
                <h4>Documentos del contexto: <strong>{contextoSeleccionadoParaDocumentos}</strong></h4>
                {#if cargandoAdminDocumentos}
                  <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">⟳ Cargando documentos...</p>
                {:else if administracionDocumentos.length === 0}
                  <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">No hay documentos en este contexto</p>
                {:else}
                  <div class="documentos-table">
                    {#each administracionDocumentos as doc (doc)}
                      <div class="documento-row">
                        <span class="documento-nombre">📋 {doc}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Integrar Documento -->
          <div class="integrar-documento-wrap">
            <h3>📤 Integrar Nuevo Documento</h3>
            <div class="integrar-documento-form">
              <div class="form-field">
                <label for="doc-contexto-integrar">Contexto destino</label>
                <select
                  id="doc-contexto-integrar"
                  bind:value={contextoSeleccionadoParaDocumentos}
                  disabled={cargandoIntegrarDocumento}
                  class="contexto-select"
                >
                  <option value="">-- Selecciona un contexto --</option>
                  {#each administracionContextos as contexto (contexto.nombre)}
                    <option value={contexto.nombre}>{contexto.nombre}</option>
                  {/each}
                </select>
              </div>
              <div class="form-field">
                <label for="doc-archivo">Selecciona archivo</label>
                <input
                  id="doc-archivo"
                  type="file"
                  onchange={(e) => {
                    const files = e.target.files;
                    archivoParaIntegrar = files && files[0] ? files[0] : null;
                  }}
                  disabled={cargandoIntegrarDocumento}
                  accept=".txt,.pdf,.doc,.docx"
                  class="documento-input"
                />
                {#if archivoParaIntegrar}
                  <small>Archivo: {archivoParaIntegrar.name} ({(archivoParaIntegrar.size / 1024).toFixed(2)} KB)</small>
                {/if}
              </div>
              <button
                onclick={integrarDocumento}
                disabled={cargandoIntegrarDocumento || !contextoSeleccionadoParaDocumentos.trim() || !archivoParaIntegrar}
                class="integrar-documento-btn"
              >
                {cargandoIntegrarDocumento ? '⟳ Procesando...' : '✓ Integrar'}
              </button>
            </div>

            {#if cargandoIntegrarDocumento}
              <div class="progreso-wrap">
                <div class="progreso-bar indeterminate"></div>
              </div>
            {:else if progresoIntegrar === 100}
              <div class="progreso-wrap">
                <div class="progreso-bar done"></div>
              </div>
            {/if}

            {#if mensajeIntegrarDocumento}
              <p class="mensaje-documento" class:success={mensajeIntegrarDocumento.includes('✅')}>
                {mensajeIntegrarDocumento}
              </p>
            {/if}
          </div>

          <!-- Borrar Documento -->
          <div class="borrar-documento-wrap">
            <h3>🗑️ Borrar Documento</h3>
            <div class="borrar-documento-form">
              <div class="form-field" style="flex: 1;">
                <label for="doc-a-borrar">Selecciona documento</label>
                <select
                  id="doc-a-borrar"
                  bind:value={documentoSeleccionadoParaBorrar}
                  disabled={cargandoBorrarDocumento || administracionDocumentos.length === 0}
                  class="contexto-select"
                >
                  <option value="">-- Selecciona un documento --</option>
                  {#each administracionDocumentos as doc (doc)}
                    <option value={doc}>{doc}</option>
                  {/each}
                </select>
              </div>
              <button
                onclick={() => mostrarConfirmacionBorrarDocumento = true}
                disabled={cargandoBorrarDocumento || !documentoSeleccionadoParaBorrar.trim()}
                class="borrar-documento-btn"
              >
                🗑️ Borrar
              </button>
            </div>
            {#if mensajeBorrarDocumento}
              <p class="mensaje-documento" class:success={mensajeBorrarDocumento.includes('✅')}>
                {mensajeBorrarDocumento}
              </p>
            {/if}
          </div>

          <!-- Confirmación Modal para Borrar Documento -->
          {#if mostrarConfirmacionBorrarDocumento}
            <div class="modal-overlay">
              <div class="modal-content">
                <h3>⚠️ Confirmar Borrado de Documento</h3>
                <p>
                  ¿Estás seguro de que deseas borrar el documento <strong>"{documentoSeleccionadoParaBorrar}"</strong> del contexto <strong>"{contextoSeleccionadoParaDocumentos}"</strong>?
                </p>
                <p style="font-size: 0.85rem; color: rgba(255,255,255,0.6);">
                  Esta acción es irreversible.
                </p>
                <div class="modal-buttons">
                  <button
                    onclick={() => mostrarConfirmacionBorrarDocumento = false}
                    disabled={cargandoBorrarDocumento}
                    class="modal-btn cancel"
                  >
                    Cancelar
                  </button>
                  <button
                    onclick={borrarDocumentoConfirmado}
                    disabled={cargandoBorrarDocumento}
                    class="modal-btn danger"
                  >
                    {cargandoBorrarDocumento ? '⟳ Borrando...' : 'Sí, borrar'}
                  </button>
                </div>
              </div>
            </div>
          {/if}
        {/if}

        <!-- Modelos -->
        {#if adminTab === 'modelos'}
          <div class="modelos-wrap">
            <div class="seccion-header">
              <h3>🤖 Modelos Disponibles</h3>
              <button onclick={cargarModelos} class="admin-action-btn" disabled={cargandoModelos}>
                🔄 Recargar
              </button>
            </div>

            {#if cargandoModelos}
              <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">⟳ Cargando modelos...</p>
            {:else if errorModelos}
              <p style="color: rgba(255,200,0,0.9); font-size: 0.9rem; padding: 1rem; background: rgba(255,170,0,0.1); border-left: 3px solid rgba(255,170,0,0.7); border-radius: 4px; line-height: 1.5;">{errorModelos}</p>
            {:else if modelosDisponibles.length === 0}
              <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem; padding: 1rem 0;">No hay modelos disponibles</p>
            {:else}
              <div class="modelos-grid">
                {#each modelosDisponibles as modelo (modelo)}
                  <button
                    class="modelo-card"
                    class:active={modeloSeleccionado === modelo}
                    onclick={() => { modeloSeleccionado = modelo; cargarInfoModelo(modelo); }}
                  >
                    <span class="modelo-nombre">{modelo}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if modeloSeleccionado && infoModeloSeleccionado}
              <div class="modelo-detalle">
                <h4>📋 Detalles de <strong>"{modeloSeleccionado}"</strong></h4>
                {#if cargandoInfoModelo}
                  <p style="color: rgba(255,255,255,0.6); font-size: 0.9rem;">⟳ Cargando información...</p>
                {:else}
                  <div class="modelo-propiedades">
                    {#each Object.entries(infoModeloSeleccionado) as [key, value]}
                      <div class="propiedad-item">
                        <span class="propiedad-key">{key}:</span>
                        <span class="propiedad-value">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Lightbot -->
        {#if adminTab === 'lightbot'}
          <div class="lightbot-wrap">
            <div class="seccion-header">
              <h3>💬 Configuración Lightbot</h3>
            </div>
            <p class="lightbot-desc">Define los valores por defecto del widget embebible. Estos se usarán cuando no se pasen parámetros por URL.</p>

            <div class="lightbot-form">
              <div class="lightbot-field">
                <label for="lb-ambiente">Ambiente</label>
                <select id="lb-ambiente" bind:value={lightbotAmbiente}>
                  {#each Object.keys(AMBIENTES) as amb}
                    <option value={amb}>{amb}</option>
                  {/each}
                </select>
              </div>

              <div class="lightbot-field">
                <label for="lb-contexto">Contexto</label>
                <select id="lb-contexto" bind:value={lightbotContexto}>
                  <option value="">— Seleccionar —</option>
                  {#each contextos as ctx}
                    <option value={ctx}>{ctx}</option>
                  {/each}
                </select>
              </div>

              <div class="lightbot-field">
                <label for="lb-modelo">Modelo LLM</label>
                <select id="lb-modelo" bind:value={lightbotModelo}>
                  <optgroup label="Ollama">
                    {#each MODELOS as m}
                      <option value={m}>{m}</option>
                    {/each}
                  </optgroup>
                  <optgroup label="OpenAI">
                    {#each MODELOS_OPENAI as m}
                      <option value={m}>{m}</option>
                    {/each}
                  </optgroup>
                </select>
              </div>

              <div class="lightbot-field">
                <label for="lb-historial">Historial (turnos)</label>
                <select id="lb-historial" bind:value={lightbotHistorial}>
                  {#each [0, 1, 2, 3, 5, 10, 15, 20] as n}
                    <option value={n}>{n === 0 ? 'Sin historial' : `${n} turnos`}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="lightbot-preview">
              <h4>📋 URL del widget</h4>
              <code class="lightbot-url">{AMBIENTES[lightbotAmbiente]?.url ?? ''}/embed/?ambiente={lightbotAmbiente}&contexto={lightbotContexto}&modelo={lightbotModelo}&historial={lightbotHistorial}</code>
              <h4 style="margin-top: 1rem;">📌 Código para embeber</h4>
              <code class="lightbot-url">&lt;iframe src="{AMBIENTES[lightbotAmbiente]?.url ?? ''}/embed/?ambiente={lightbotAmbiente}&amp;contexto={lightbotContexto}&amp;modelo={lightbotModelo}&amp;historial={lightbotHistorial}" width="400" height="600" style="border:none;border-radius:12px" &gt;&lt;/iframe&gt;</code>
            </div>
          </div>
        {/if}

        <!-- Confirmación Modal -->
        {#if mostrarConfirmacionBorrar}
          <div class="modal-overlay">
            <div class="modal-content">
              <h3>⚠️ Confirmar Borrado</h3>
              <p>
                ¿Estás seguro de que deseas borrar el contexto <strong>"{contextoABorrar}"</strong>?
              </p>
              <p style="font-size: 0.85rem; color: rgba(255,255,255,0.6);">
                Esta acción es irreversible.
              </p>
              <div class="modal-buttons">
                <button
                  onclick={() => mostrarConfirmacionBorrar = false}
                  disabled={cargandoBorrarContexto}
                  class="modal-btn cancel"
                >
                  Cancelar
                </button>
                <button
                  onclick={borrarContextoConfirmado}
                  disabled={cargandoBorrarContexto}
                  class="modal-btn danger"
                >
                  {cargandoBorrarContexto ? '⟳ Borrando...' : 'Sí, borrar'}
                </button>
              </div>
            </div>
          </div>
        {/if}

      </div>
      <p class="disclaimer">MIDE · Museo Interactivo de Economía</p>
    </main>
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
    transition: background 0.5s ease;
  }

  .app.admin {
    background: linear-gradient(160deg, #001a4d 0%, #003d99 30%, #0055cc 60%, #0077ff 100%);
  }

  /* ── Header ─────────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
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
    cursor: pointer;
    border-radius: 6px;
    padding: 2px 6px;
    transition: background 0.2s ease;
  }

  .header-status:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 6px #4ade80;
    animation: pulse 2s ease-in-out infinite;
  }

  .status-dot.online {
    background: #4ade80;
    box-shadow: 0 0 6px #4ade80;
  }

  .status-dot.offline {
    background: #ef4444;
    box-shadow: 0 0 6px #ef4444;
    animation: none;
  }

  .status-dot.checking {
    background: #facc15;
    box-shadow: 0 0 6px #facc15;
    animation: pulse 1s ease-in-out infinite;
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

  .model-toggle-openai {
    border-color: rgba(16, 163, 127, 0.35);
  }

  .model-toggle-openai .model-toggle-label {
    color: #fff;
  }

  .model-toggle-label {
    font-size: 0.6rem;
    font-weight: 700;
    color: rgba(16, 163, 127, 0.8);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 4px;
    align-self: center;
  }

  .model-btn-openai {
    color: rgba(255, 255, 255, 0.55);
    white-space: nowrap;
  }

  .model-btn-openai:hover:not(:disabled) {
    background: rgba(16, 163, 127, 0.2);
    color: #fff;
  }

  .model-btn-openai.active {
    background: rgb(16, 163, 127);
    color: #fff;
    box-shadow: 0 1px 6px rgba(16, 163, 127, 0.4);
  }

  .model-btn-openai.active:hover:not(:disabled) {
    background: rgb(13, 140, 108);
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
  .input-container button {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: none;
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s ease, opacity 0.2s;
  }

  .input-container button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .input-container button:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.35);
  }

  .reset-btn {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  .reset-btn:not(:disabled):hover {
    background: rgba(255, 100, 100, 0.3) !important;
  }

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

  .input-container button {
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

  .input-container button svg {
    width: 20px;
    height: 20px;
  }

  .input-container button:hover:not(:disabled) {
    transform: scale(1.08);
    background: #f0f0f0;
  }

  .input-container button:active:not(:disabled) {
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

  .clear-chat-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 6px;
    opacity: 0.5;
    transition: opacity 0.2s, background 0.2s;
    color: #fff;
  }

  .clear-chat-btn:not(:disabled):hover {
    opacity: 1;
    background: rgba(255, 80, 80, 0.25);
  }

  .clear-chat-btn:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }

  /* ── Tabs toggle ────────────────────────────────── */
  .tabs-toggle {
    display: flex;
    gap: 0;
    background: transparent;
    padding: 0;
    border-radius: 0;
    border: none;
    margin-left: auto;
    border-bottom: 2px solid rgba(255, 255, 255, 0.2);
  }

  .tab-btn {
    width: auto;
    height: auto;
    border-radius: 0;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.75rem 1.5rem;
    cursor: pointer;
    transition: all 0.25s ease;
    box-shadow: none;
    letter-spacing: 0.01em;
    white-space: nowrap;
    border-bottom: 3px solid transparent;
    position: relative;
    bottom: -2px;
  }

  .tab-btn:hover:not(:disabled) {
    color: rgba(255, 255, 255, 0.85);
  }

  .tab-btn.active {
    color: #fff;
    border-bottom-color: #fff;
    background: transparent;
    box-shadow: none;
  }

  /* ── Admin Body ──────────────────────────────────── */
  .admin-body {
    flex: 1;
    overflow-y: auto;
    padding: 2rem 1.5rem;
    width: 100%;
    min-width: 0;
  }

  .admin-container {
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  }

  /* ── Banner Integración En Curso ─────────────────── */
  .banner-integracion {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 1rem 1.25rem;
    background: rgba(255, 170, 0, 0.15);
    border: 1px solid rgba(255, 170, 0, 0.4);
    border-left: 4px solid rgba(255, 170, 0, 0.8);
    border-radius: 10px;
    margin-bottom: 1.5rem;
    animation: slideUp 0.3s ease;
  }

  .banner-integracion-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
    animation: pulse 1.5s ease-in-out infinite;
  }

  .banner-integracion-text {
    flex: 1;
  }

  .banner-integracion-text strong {
    color: #ffcc00;
    font-size: 0.95rem;
  }

  .banner-integracion-text p {
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.85rem;
    line-height: 1.5;
    margin-top: 0.25rem;
  }

  .banner-dismiss-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.7);
    padding: 0.3rem 0.75rem;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    margin-top: 0.5rem;
    transition: background 0.2s ease;
    white-space: nowrap;
    min-width: max-content;
  }

  .banner-dismiss-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
  }

  /* ── Admin Sub-tabs ──────────────────────────────── */
  .admin-subtabs {
    display: inline-flex;
    gap: 0.5rem;
    margin-bottom: 2rem;
    background: rgba(0, 0, 0, 0.2);
    padding: 0.4rem;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .admin-subtab-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 1.25rem;
    border-radius: 10px;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: max-content;
  }

  .admin-subtab-btn:hover:not(.active) {
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.08);
  }

  .admin-subtab-btn.active {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }

  .seccion-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
    color: rgba(255, 255, 255, 0.4);
    font-size: 1.1rem;
    border: 2px dashed rgba(255, 255, 255, 0.15);
    border-radius: 12px;
  }

  .admin-action-btn {
    background: rgba(255, 255, 255, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.3);
    color: #fff;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
    font-family: inherit;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: max-content;
  }

  .admin-action-btn:hover {
    background: rgba(255, 255, 255, 0.3);
    border-color: rgba(255, 255, 255, 0.5);
  }

  .logs-table {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 400px;
    overflow-y: auto;
  }

  .log-row {
    display: grid;
    grid-template-columns: 80px 1fr 60px 40px;
    gap: 1rem;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    font-size: 0.8rem;
    align-items: center;
    border-left: 3px solid transparent;
  }

  .log-row.has-error {
    border-left-color: #ff6b6b;
  }

  .log-fecha {
    color: rgba(255, 255, 255, 0.6);
    font-weight: 600;
    font-family: 'Courier New', monospace;
  }

  .log-pregunta {
    color: rgba(255, 255, 255, 0.85);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-ms {
    color: #4ade80;
    text-align: right;
    font-weight: 600;
  }

  .log-error {
    color: #4ade80;
    text-align: center;
    font-weight: 600;
  }

  .log-error.has-error {
    color: #ff6b6b;
  }

  /* ── Contextos Table ────────────────────────────── */
  .contextos-table-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .contextos-table-wrap h3 {
    color: #fff;
    font-size: 1rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .contextos-table {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 500px;
    overflow-y: auto;
  }

  .contexto-row {
    display: flex;
    align-items: center;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    font-size: 0.85rem;
    border-left: 3px solid rgba(0, 200, 255, 0.5);
    transition: background 0.2s ease;
  }

  .contexto-row:hover {
    background: rgba(0, 0, 0, 0.3);
    border-left-color: rgba(0, 200, 255, 0.8);
  }

  .contexto-nombre {
    color: rgba(255, 255, 255, 0.9);
    font-weight: 600;
    flex: 1;
  }

  .recargar-btn {
    align-self: flex-start;
    margin-top: 0.5rem;
  }

  .seccion-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .seccion-header h3 {
    margin: 0;
    flex-shrink: 0;
    white-space: nowrap;
    color: white;
  }

  /* ── Crear Contexto Form ────────────────────────── */
  .crear-contexto-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .crear-contexto-wrap h3 {
    color: #fff;
    font-size: 1rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .crear-contexto-form {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.75rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
    min-width: 150px;
    position: relative;
  }

  .field-hint {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: 2px;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.65);
    line-height: 1.2;
  }

  .form-field label {
    font-size: 0.8rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.01em;
  }

  .contexto-input {
    flex: 1;
    padding: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    transition: border-color 0.2s ease, background 0.2s ease;
  }

  /* Ocultar flechitas del input type=number */
  .contexto-input::-webkit-outer-spin-button,
  .contexto-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .contexto-input::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }

  .contexto-input:focus {
    outline: none;
    border-color: rgba(0, 200, 255, 0.8);
    background: rgba(0, 0, 0, 0.3);
  }

  .contexto-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .crear-contexto-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(0, 200, 255, 0.3);
    border: 1px solid rgba(0, 200, 255, 0.5);
    border-radius: 8px;
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: max-content;
    align-self: flex-end;
  }

  .crear-contexto-btn:hover:not(:disabled) {
    background: rgba(0, 200, 255, 0.5);
    border-color: rgba(0, 200, 255, 0.8);
  }

  .crear-contexto-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mensaje-contexto {
    font-size: 0.9rem;
    padding: 0.75rem;
    border-radius: 8px;
    background: rgba(255, 0, 0, 0.2);
    border: 1px solid rgba(255, 0, 0, 0.4);
    color: rgba(255, 100, 100, 1);
    margin: 0;
  }

  .mensaje-contexto.success {
    background: rgba(0, 200, 0, 0.2);
    border-color: rgba(0, 200, 0, 0.4);
    color: rgba(100, 255, 100, 1);
  }

  /* ── Borrar Contexto Form ────────────────────────── */
  .borrar-contexto-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .borrar-contexto-wrap h3 {
    color: #fff;
    font-size: 1rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .borrar-contexto-form {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
    align-items: flex-end;
  }

  .contexto-select {
    padding: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    transition: border-color 0.2s ease, background 0.2s ease;
    width: 100%;
  }

  .contexto-select:focus {
    outline: none;
    border-color: rgba(200, 50, 50, 0.8);
    background: rgba(0, 0, 0, 0.3);
  }

  .contexto-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .contexto-select option {
    background: #1a1a1a;
    color: #fff;
  }

  .borrar-contexto-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(200, 50, 50, 0.3);
    border: 1px solid rgba(200, 50, 50, 0.5);
    border-radius: 8px;
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: max-content;
    align-self: flex-end;
  }

  .borrar-contexto-btn:hover:not(:disabled) {
    background: rgba(200, 50, 50, 0.5);
    border-color: rgba(200, 50, 50, 0.8);
  }

  .borrar-contexto-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Modal Confirmación ───────────────────────────── */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: linear-gradient(160deg, #001a4d 0%, #003d99 30%, #0055cc 60%, #0077ff 100%);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px;
    padding: 2rem;
    max-width: 400px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(12px);
    animation: slideUp 0.3s ease;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .modal-content h3 {
    color: #fff;
    font-size: 1.2rem;
    margin-bottom: 1rem;
    font-weight: 700;
  }

  .modal-content p {
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.95rem;
    line-height: 1.5;
    margin-bottom: 0.75rem;
  }

  .modal-buttons {
    display: flex;
    gap: 1rem;
    margin-top: 1.5rem;
  }

  .modal-btn {
    flex: 1;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    border: none;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.1s ease;
  }

  .modal-btn:active:not(:disabled) {
    transform: scale(0.98);
  }

  .modal-btn.cancel {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.3);
  }

  .modal-btn.cancel:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.3);
  }

  .modal-btn.danger {
    background: rgba(255, 50, 50, 0.8);
    color: #fff;
    border: 1px solid rgba(255, 100, 100, 0.8);
  }

  .modal-btn.danger:hover:not(:disabled) {
    background: rgba(255, 50, 50, 1);
  }

  .modal-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Documentos Section ──────────────────────────── */
  .documentos-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .documentos-contexto-select {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 1.5rem;
    background: rgba(255, 255, 255, 0.08);
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .documentos-contexto-select label {
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.9rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .documentos-contexto-select select {
    flex: 1;
    min-width: 200px;
  }

  .documentos-list-wrap {
    margin-bottom: 1.5rem;
  }

  .documentos-list-wrap h4 {
    color: #fff;
    font-size: 0.95rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .documentos-table {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .documento-row {
    display: flex;
    align-items: center;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    border-left: 3px solid rgba(0, 119, 255, 0.5);
    transition: background 0.2s ease;
  }

  .documento-row:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .documento-nombre {
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.9rem;
    word-break: break-word;
  }

  /* ── Integrar Documento Form ─────────────────────── */
  .integrar-documento-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .integrar-documento-wrap h3 {
    color: #fff;
    font-size: 1rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .integrar-documento-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .documento-input {
    padding: 0.75rem;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    transition: border-color 0.2s ease;
    width: 100%;
  }

  .documento-input::file-selector-button {
    background: rgba(0, 119, 255, 0.3);
    border: 1px solid rgba(0, 119, 255, 0.5);
    color: #fff;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    margin-right: 1rem;
    font-weight: 600;
    transition: background 0.2s ease;
  }

  .documento-input::file-selector-button:hover {
    background: rgba(0, 119, 255, 0.6);
  }

  .documento-input:focus {
    outline: none;
    border-color: rgba(0, 119, 255, 0.8);
  }

  .documento-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .integrar-documento-form small {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.8rem;
  }

  .integrar-documento-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(0, 119, 255, 0.3);
    border: 1px solid rgba(0, 119, 255, 0.5);
    border-radius: 8px;
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
    white-space: nowrap;
    min-width: max-content;
    align-self: flex-start;
  }

  .integrar-documento-btn:hover:not(:disabled) {
    background: rgba(0, 119, 255, 0.5);
    border-color: rgba(0, 119, 255, 0.8);
  }

  .integrar-documento-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Barra de Progreso ───────────────────────────── */
  .progreso-wrap {
    height: 6px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 99px;
    overflow: hidden;
    margin-top: 0.75rem;
    position: relative;
  }

  .progreso-bar {
    height: 100%;
    border-radius: 99px;
  }

  .progreso-bar.indeterminate {
    position: absolute;
    width: 45%;
    background: linear-gradient(90deg, transparent, #0077ff, #00c8ff, transparent);
    animation: sweep 1.4s ease-in-out infinite;
  }

  @keyframes sweep {
    0%   { left: -50%; }
    100% { left: 110%; }
  }

  .progreso-bar.done {
    width: 100%;
    background: linear-gradient(90deg, #16a34a, #4ade80);
    box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);
    transition: width 0.3s ease;
  }

  /* ── Borrar Documento Form ───────────────────────── */
  .borrar-documento-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .borrar-documento-wrap h3 {
    color: #fff;
    font-size: 1rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .borrar-documento-form {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
    align-items: flex-end;
  }

  .borrar-documento-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(200, 50, 50, 0.3);
    border: 1px solid rgba(200, 50, 50, 0.5);
    border-radius: 8px;
    color: #fff;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: max-content;
    align-self: flex-end;
  }

  .borrar-documento-btn:hover:not(:disabled) {
    background: rgba(200, 50, 50, 0.5);
    border-color: rgba(200, 50, 50, 0.8);
  }

  .borrar-documento-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Mensajes Documento ──────────────────────────── */
  .mensaje-documento {
    color: rgba(200, 50, 50, 0.9);
    font-size: 0.9rem;
    padding: 0.75rem 1rem;
    background: rgba(200, 50, 50, 0.15);
    border-left: 3px solid rgba(200, 50, 50, 0.8);
    border-radius: 4px;
    margin-top: 0.75rem;
    animation: slideUp 0.3s ease;
  }

  .mensaje-documento.success {
    color: rgba(74, 222, 128, 0.9);
    background: rgba(74, 222, 128, 0.15);
    border-left-color: rgba(74, 222, 128, 0.8);
  }

  /* ── Modelos Section ───────────────────────────── */
  .modelos-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .modelos-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .modelo-card {
    padding: 1rem;
    background: rgba(0, 119, 255, 0.15);
    border: 2px solid rgba(0, 119, 255, 0.3);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: center;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .modelo-card:hover:not(:disabled) {
    background: rgba(0, 119, 255, 0.25);
    border-color: rgba(0, 119, 255, 0.6);
  }

  .modelo-card.active {
    background: rgba(0, 119, 255, 0.4);
    border-color: rgba(0, 119, 255, 0.8);
    color: #fff;
    box-shadow: 0 0 12px rgba(0, 119, 255, 0.5);
  }

  .modelo-nombre {
    display: block;
    word-break: break-word;
  }

  .modelo-detalle {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 1.5rem;
    margin-top: 1.5rem;
  }

  .modelo-detalle h4 {
    color: #fff;
    font-size: 0.95rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }

  .modelo-propiedades {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .propiedad-item {
    display: flex;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-left: 3px solid rgba(0, 119, 255, 0.5);
    border-radius: 4px;
    align-items: flex-start;
  }

  .propiedad-key {
    color: rgba(0, 200, 255, 0.8);
    font-weight: 600;
    font-size: 0.85rem;
    min-width: fit-content;
    text-transform: capitalize;
  }

  .propiedad-value {
    color: rgba(255, 255, 255, 0.75);
    font-size: 0.85rem;
    word-break: break-word;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  /* ── Lightbot Section ──────────────────────────── */
  .lightbot-wrap {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 1.5rem;
    backdrop-filter: blur(8px);
    margin-bottom: 2rem;
  }

  .lightbot-desc {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.85rem;
    margin-bottom: 1.5rem;
    line-height: 1.5;
  }

  .lightbot-form {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .lightbot-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .lightbot-field label {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .lightbot-field select {
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    border: 1.5px solid rgba(255, 255, 255, 0.2);
    background: rgba(0, 0, 0, 0.25);
    color: #fff;
    font-family: inherit;
    font-size: 0.875rem;
    outline: none;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .lightbot-field select:focus {
    border-color: rgba(0, 150, 255, 0.6);
  }

  .lightbot-field select option,
  .lightbot-field select optgroup {
    background: #1a1a2e;
    color: #fff;
  }

  .lightbot-preview {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }

  .lightbot-preview h4 {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 0.5rem;
  }

  .lightbot-url {
    display: block;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.78rem;
    color: rgba(100, 200, 255, 0.9);
    word-break: break-all;
    font-family: 'Monaco', 'Courier New', monospace;
    line-height: 1.5;
    user-select: all;
  }

  /* ── Responsive ──────────────────────────────────── */
  @media (max-width: 480px) {
    .header { padding: 0.875rem 1rem; }
    .chat-body { padding: 1rem 0.75rem; }
    .bubble-wrap { max-width: 85%; }
    .header-logo { display: none; }
  }
</style>
