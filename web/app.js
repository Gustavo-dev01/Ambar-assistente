(function () {
  "use strict";

  const root = document.documentElement;
  const desktop = document.getElementById("desktop");

  const STORAGE_KEY = "agente-ui-state-v1";
  const CONFIRM_MARK = "\x01";

  const TAG_LABELS = {
    "agent-write": "Escrever arquivo",
    "agent-edit": "Editar trecho de arquivo",
    "agent-delete": "Apagar arquivo",
    "agent-run": "Executar comando",
    "agent-preview": "Iniciar servidor de preview",
    "agent-remember": "Salvar memória",
    "agent-schedule": "Agendar tarefa",
    "agent-standing-order": "Salvar ordem permanente",
  };

  const AGENT_TAG_NAMES = "read|list|write|edit|delete|run|preview|remember|schedule|standing-order";
  const AGENT_TAG_PATTERN = new RegExp(`<agent-(${AGENT_TAG_NAMES})(?:\\s+\\w+="[^"]*")*\\s*>[\\s\\S]*?</agent-\\1>`, "g");
  const AGENT_TAG_NAME_LIST = AGENT_TAG_NAMES.split("|");

  // Durante o streaming, o texto acumulado pode conter uma tag de ABERTURA já completa
  // (ex: "<agent-remember>") cujo conteúdo e/ou fechamento ainda não chegaram por
  // inteiro — de "<agent-remember>algo" até "<agent-remember>algo</agent-remem" (a tag
  // de fechamento em progresso). Nenhum desses estados bate no AGENT_TAG_PATTERN (que
  // exige o par completo <tag>...</tag>), então tanto a tag quanto o conteúdo dela
  // ficavam visíveis crus na bolha até tudo terminar de chegar. Acha a última tag de
  // abertura <agent-*> completa no texto; se não há um "</agent-mesmoNome>" completo
  // depois dela, essa tag ainda está em progresso — oculta dali (a abertura) até o fim
  // do texto acumulado, e não só o fragmento final de "<".
  const OPEN_TAG_PATTERN = new RegExp(`<agent-(${AGENT_TAG_NAMES})(?:\\s+\\w+="[^"]*")*\\s*>`, "g");

  function stripUnclosedAgentTagTail(text) {
    let match;
    let lastOpen = null;
    OPEN_TAG_PATTERN.lastIndex = 0;
    while ((match = OPEN_TAG_PATTERN.exec(text))) {
      lastOpen = match;
    }
    if (lastOpen) {
      const tagName = lastOpen[1];
      const closeTag = `</agent-${tagName}>`;
      const afterOpen = text.slice(lastOpen.index + lastOpen[0].length);
      if (!afterOpen.includes(closeTag)) {
        return text.slice(0, lastOpen.index);
      }
    }

    // Nenhuma tag de abertura completa em aberto — ainda assim o texto pode terminar
    // no meio de "<", "<a", "<agent-remem" etc. (a própria tag de abertura chegando
    // caractere por caractere). Procura o último "<" e, se o que vem depois dele é
    // consistente com o início de alguma tag <agent-*> conhecida, oculta a partir dali.
    const lastLt = text.lastIndexOf("<");
    if (lastLt === -1) return text;
    const tail = text.slice(lastLt);
    const gtIndex = tail.indexOf(">");
    const head = gtIndex === -1 ? tail : tail.slice(0, gtIndex);
    const looksLikeAgentTagStart = AGENT_TAG_NAME_LIST.some((name) => {
      const prefix = `<agent-${name}`;
      return prefix.startsWith(head) || head.startsWith(prefix);
    });
    return looksLikeAgentTagStart ? text.slice(0, lastLt) : text;
  }

  function stripAgentTags(rawText) {
    const withoutClosedTags = rawText.replace(AGENT_TAG_PATTERN, "");
    const withoutPartialTag = stripUnclosedAgentTagTail(withoutClosedTags);
    return withoutPartialTag.replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ======================================================================
   * Estado
   * ==================================================================== */

  const ORB_LABELS = { idle: "Pronta para ajudar", thinking: "Pensando...", speaking: "Respondendo..." };

  const state = {
    theme: "dark",
    sidebarExpanded: true,
    activeView: "chat",
    orbState: "idle",
    listening: false,
    sidebarSearch: "",
    models: [],
    selectedModel: "",
    previewToast: "",
    pendingImages: [],
    // Nomes com que as imagens anexadas foram gravadas na workspace — o modelo precisa
    // deles pra referenciar a imagem num <img src="..."> que ele mesmo escreva.
    lastImageFiles: [],
    // provisório, e o botão "Copiar tudo" então omite a linha "Para:".
    supportEmail: "",
    chats: [],
    searchResults: null,
    activeChatId: null,
    confirmDeleteChatId: null,
    selectMode: false,
    selectedChatIds: [],
    renamingChatId: null,
    renameDraft: "",
    confirmDeleteProject: null,
    confirmDeleteLibrary: null,
    confirmDeleteKnowledge: null,
    confirmDeleteModel: null,
    confirmDeleteTask: null,
    confirmDeleteStandingOrder: null,
    automationTab: "tasks",
    tasks: [],
    standingOrders: [],
    profileName: "Você",
    editingProfile: false,
    profileNameDraft: "",
    library: [
      { name: "Resumo de entrevistas", desc: "Prompt salvo — síntese de pesquisas qualitativas." },
      { name: "Análise competitiva", desc: "Prompt salvo — comparação estruturada de concorrentes." },
      { name: "Guia de tom de voz", desc: "Documento salvo — diretrizes de escrita do Ambar." }
    ],
    projects: [],
    knowledge: [],
    messages: []
  };

  /* ======================================================================
   * Persistência (localStorage) — só preferências de UI, não o histórico
   * de chat (esse vive no servidor / não é restaurado ao recarregar ainda)
   * ==================================================================== */

  function loadPersisted() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (saved.theme) state.theme = saved.theme;
        if (typeof saved.sidebarExpanded === "boolean") state.sidebarExpanded = saved.sidebarExpanded;
      }
    } catch (e) { /* ignore */ }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        theme: state.theme,
        sidebarExpanded: state.sidebarExpanded
      }));
    } catch (e) { /* ignore */ }
  }

  /* ======================================================================
   * Referências de DOM
   * ==================================================================== */

  const el = (id) => document.getElementById(id);

  const sessionEl = el("session");

  const themeToggle = el("theme-toggle");
  const themeMenu = el("theme-menu");

  const sidebarEl = el("sidebar");
  const sidebarToggle = el("sidebar-toggle");
  const sidebarSearchInput = el("sidebar-search");
  const newChatBtn = el("new-chat-btn");
  const profileBtn = el("profile-btn");
  const profileMenu = el("profile-menu");
  const profileMenuOpenBtn = el("profile-menu-open");
  const profileBtnName = el("profile-btn-name");

  const sidebarPinned = el("sidebar-pinned");
  const pinnedTitle = el("pinned-title");
  const pinnedSep = el("pinned-sep");
  const historyGroups = el("history-groups");
  const noSearchResults = el("no-search-results");
  const selectModeToggle = el("select-mode-toggle");
  const bulkActionsBar = el("bulk-actions-bar");
  const bulkCount = el("bulk-count");
  const bulkDeleteBtn = el("bulk-delete-btn");
  const bulkCancelBtn = el("bulk-cancel-btn");

    const views = {
      chat: el("view-chat"),
      projects: el("view-projects"),
      library: el("view-library"),
      knowledge: el("view-knowledge"),
      preview: el("view-preview"),
      models: el("view-models"),
      automation: el("view-automation"),
      setup: el("view-setup"),
      profile: el("view-profile")
    };

  const orbWrap = el("orb-wrap");
  const statusOrb = el("status-orb");
  const orbLabel = el("orb-label");
  const orbThinkingIcon = el("orb-thinking-icon");
  const suggestionsEl = el("suggestions");
  const chatEl = el("chat");
  const chatInput = el("chat-input");
  const sendBtn = el("send-btn");
  const stopBtn = el("stop-btn");
  const micBtn = el("mic-btn");
  const confirmBox = el("confirm-box");
  const attachBtn = el("attach-btn");
  const attachFileInput = el("attach-file-input");
  const attachPdfInput = el("attach-pdf-input");
  const attachMenu = el("attach-menu");
  const attachOptImage = el("attach-opt-image");
  const attachOptPdf = el("attach-opt-pdf");
  const attachmentPreview = el("attachment-preview");

  const projectsList = el("projects-list");
  const projectsEmpty = el("projects-empty");
  const libraryList = el("library-list");
  const libraryEmpty = el("library-empty");
  const knowledgeList = el("knowledge-list");
  const knowledgeEmpty = el("knowledge-empty");
  const modelsList = el("models-list");
  const loadingNotice = el("loading-notice");
  const runtimeState = el("runtime-state");
  const keepAliveSelect = el("keep-alive-select");
  const preloadCheck = el("preload-check");
  const preloadNowBtn = el("preload-now-btn");

  const memoryCountEl = el("memory-count");
  const memoryListEl = el("memory-list");
  const memoryEmptyEl = el("memory-empty");
  const memoryClearEl = el("memory-clear");

  const previewDotEl = el("preview-dot");
  const previewStatusTextEl = el("preview-status-text");
  const previewLinkEl = el("preview-link");
  const previewRefreshEl = el("preview-refresh");
  const previewStopEl = el("preview-stop");
  const previewFrameEl = el("preview-frame");
  const previewEmptyEl = el("preview-empty");

  const profileDisplayName = el("profile-display-name");
  const profileViewMode = el("profile-view-mode");
  const profileEditMode = el("profile-edit-mode");
  const profileNameInput = el("profile-name-input");
  const profileAvatar = el("profile-avatar");
  const profileEditBtn = el("profile-edit-btn");
  const profileSaveBtn = el("profile-save-btn");

  /* ======================================================================
   * Orb: esfera tipográfica em canvas (ditherpunk), estilo/pipeline validados
   * em prototype/orb-test/orb-typo-test.html antes de entrar aqui.
   * ==================================================================== */

  const OrbRenderer = (function () {
    const canvas = statusOrb; // #status-orb agora é um <canvas>, não mais o container das barras
    const ctx = canvas.getContext("2d");
    const WORD = "AMBAR";

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const SIZE = canvas.width; // 380, ver index.html — mantém a proporção de folga do glow validada no protótipo
    canvas.width = SIZE * DPR;
    canvas.height = SIZE * DPR;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.scale(DPR, DPR);

    const CX = SIZE / 2, CY = SIZE / 2;
    const R = SIZE * 0.385; // mesma proporção R/SIZE do protótipo (200/520)
    const GLOW_MAX_R = SIZE / 2 * 0.9;

    const STAMP_FONT_PX = Math.round(SIZE * 0.065);
    function buildStamp(rgb) {
      const off = document.createElement("canvas");
      const pad = 6;
      const octx = off.getContext("2d");
      octx.font = `700 ${STAMP_FONT_PX}px 'Segoe UI', system-ui, sans-serif`;
      const w = Math.ceil(octx.measureText(WORD).width) + pad * 2;
      const h = STAMP_FONT_PX + pad * 2;
      off.width = w;
      off.height = h;
      octx.font = `700 ${STAMP_FONT_PX}px 'Segoe UI', system-ui, sans-serif`;
      octx.textAlign = "left";
      octx.textBaseline = "middle";
      octx.fillStyle = `rgb(${rgb})`;
      octx.fillText(WORD, pad, h / 2);
      return { canvas: off, w, h };
    }

    const rawPoints = [];
    const RINGS = 22;
    for (let i = 1; i < RINGS; i++) {
      const lat = (i / RINGS) * Math.PI - Math.PI / 2;
      const ringR = Math.cos(lat);
      if (ringR < 0.05) continue;
      const count = Math.max(3, Math.round(RINGS * 1.7 * ringR));
      for (let j = 0; j < count; j++) {
        const lon = (j / count) * Math.PI * 2 + (i % 2) * 0.15;
        rawPoints.push({
          x0: Math.cos(lat) * Math.cos(lon),
          y0: Math.sin(lat),
          z0: Math.cos(lat) * Math.sin(lon),
          phase: Math.random() * Math.PI * 2,
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.4,
          scaleJitter: 0.75 + Math.random() * 0.5,
        });
      }
    }
    const N = rawPoints.length;
    const X0 = new Float32Array(N), Y0 = new Float32Array(N), Z0 = new Float32Array(N);
    const PHASE = new Float32Array(N), ROT0 = new Float32Array(N), ROTSPD = new Float32Array(N), SJITTER = new Float32Array(N);
    rawPoints.forEach((p, i) => {
      X0[i] = p.x0; Y0[i] = p.y0; Z0[i] = p.z0;
      PHASE[i] = p.phase; ROT0[i] = p.rot; ROTSPD[i] = p.rotSpeed; SJITTER[i] = p.scaleJitter;
    });

    const PX = new Float32Array(N), PY = new Float32Array(N), DEPTH = new Float32Array(N);
    const ORDER = new Uint32Array(N);
    for (let i = 0; i < N; i++) ORDER[i] = i;

    const STATE_PARAMS = {
      idle:     { speed: 0.35, jitterAmp: 0.012, jitterFreq: 1.0, glow: 0.45 },
      thinking: { speed: 1.7,  jitterAmp: 0.035, jitterFreq: 3.6, glow: 0.9  },
      speaking: { speed: 1.2,  jitterAmp: 0.05,  jitterFreq: 4.8, glow: 1.05 },
      voice:    { speed: 1.0,  jitterAmp: 0.045, jitterFreq: 5.6, glow: 0.95 },
    };
    const cur = { ...STATE_PARAMS.idle };
    const EASE_SPEED = 4.5;

    let orbState = "idle";
    let hover = false;
    let hoverAmt = 0;
    let voiceAmplitude = 0;
    let angleY = 0;
    let angleX = 0.15;
    let t = 0;

    function orbRGB() {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--orb-rgb").trim();
      return raw || "255,255,255";
    }
    let ORB_RGB = orbRGB();
    let stamp = buildStamp(ORB_RGB);
    function refreshColors() {
      ORB_RGB = orbRGB();
      stamp = buildStamp(ORB_RGB);
      glowCacheKey = ""; // força reconstrução do gradiente na cor nova
    }

    function lerp(a, b, f) { return a + (b - a) * f; }
    function easeToward(dt) {
      const target = STATE_PARAMS[orbState];
      const f = Math.min(1, dt * EASE_SPEED);
      cur.speed = lerp(cur.speed, target.speed, f);
      cur.jitterAmp = lerp(cur.jitterAmp, target.jitterAmp, f);
      cur.jitterFreq = lerp(cur.jitterFreq, target.jitterFreq, f);
      cur.glow = lerp(cur.glow, target.glow, f);
      hoverAmt = lerp(hoverAmt, hover ? 1 : 0, Math.min(1, dt * 8));
    }

    let glowCache = null, glowCacheKey = "";
    function getGlow(glowR) {
      const roundedR = Math.round(glowR);
      const key = `${roundedR}|${ORB_RGB}`;
      if (key !== glowCacheKey) {
        const grad = ctx.createRadialGradient(CX, CY, R * 0.35, CX, CY, roundedR);
        grad.addColorStop(0, `rgba(${ORB_RGB}, 0.2)`);
        grad.addColorStop(0.6, `rgba(${ORB_RGB}, 0.07)`);
        grad.addColorStop(1, `rgba(${ORB_RGB}, 0)`);
        glowCache = grad;
        glowCacheKey = key;
      }
      return glowCache;
    }

    function draw() {
      ctx.clearRect(0, 0, SIZE, SIZE);

      const hoverBoost = 1 + hoverAmt * 0.16;
      const voiceGlow = orbState === "voice" ? voiceAmplitude * 0.5 : 0;
      const stateGlow = cur.glow + voiceGlow;

      const glowR = Math.min(GLOW_MAX_R, R * 1.4 * hoverBoost);
      ctx.globalAlpha = Math.min(1, stateGlow);
      ctx.fillStyle = getGlow(glowR);
      ctx.beginPath();
      ctx.arc(CX, CY, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      const cosX = Math.cos(angleX), sinX = Math.sin(angleX);
      const cosY = Math.cos(angleY), sinY = Math.sin(angleY);
      const amp = cur.jitterAmp * (1 + voiceGlow);
      const freq = cur.jitterFreq;

      for (let i = 0; i < N; i++) {
        const j = Math.sin(t * freq + PHASE[i]) * amp;
        const rr = (1 + j) * hoverBoost;

        const x0 = X0[i], y0 = Y0[i], z0 = Z0[i];
        const x = x0 * cosY - z0 * sinY;
        const z = x0 * sinY + z0 * cosY;
        const y2 = y0 * cosX - z * sinX;
        const z2 = y0 * sinX + z * cosX;

        const scale = rr * R;
        PX[i] = CX + x * scale;
        PY[i] = CY + y2 * scale;
        DEPTH[i] = z2;
      }

      const depthRef = DEPTH;
      Array.prototype.sort.call(ORDER, (a, b) => depthRef[a] - depthRef[b]);

      const stampCanvas = stamp.canvas, sw = stamp.w, sh = stamp.h;
      const wordScale = 0.11;
      const rotBase = t * cur.speed * 0.3;

      for (let k = 0; k < N; k++) {
        const i = ORDER[k];
        const depth = DEPTH[i];
        const front = (depth + 1) / 2;
        if (front < 0.06) continue;

        const px = PX[i], py = PY[i];
        const alpha = Math.min(1, 0.15 + front * 0.85);
        const scale = (0.55 + front * 0.75) * SJITTER[i] * wordScale * (R / 100);

        const drawW = sw * scale, drawH = sh * scale;
        const rot = ROT0[i] + rotBase * ROTSPD[i];
        const cosR = Math.cos(rot), sinR = Math.sin(rot);

        ctx.globalAlpha = alpha;
        ctx.setTransform(cosR * DPR, sinR * DPR, -sinR * DPR, cosR * DPR, px * DPR, py * DPR);
        ctx.drawImage(stampCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = `rgba(${ORB_RGB}, ${0.35 * stateGlow})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(CX, CY, R * 1.001, 0, Math.PI * 2);
      ctx.stroke();
    }

    let lastTs = performance.now();
    let rafId = null;
    function tick(ts) {
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      t += dt;
      easeToward(dt);
      angleY += dt * 0.3 * cur.speed * (1 + hoverAmt * 0.3);
      draw();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    let voiceRAF = null;
    function setVoiceAmplitude(amp) {
      // hook público pro futuro chat de voz: alimentar com a amplitude real do
      // microfone (ex: via AnalyserNode do Web Audio) em vez da simulação abaixo.
      voiceAmplitude = Math.max(0, Math.min(1, amp));
    }
    function simulateVoiceAmplitude(on) {
      if (voiceRAF) cancelAnimationFrame(voiceRAF);
      if (!on) { voiceAmplitude = 0; return; }
      let vt = 0;
      const step = () => {
        vt += 0.05;
        voiceAmplitude = 0.35 + Math.abs(Math.sin(vt * 3)) * 0.5 + Math.random() * 0.1;
        if (orbState === "voice") voiceRAF = requestAnimationFrame(step);
      };
      step();
    }

    // orbWrap (não o canvas) recebe a classe .hover pro CSS aplicar o scale
    // do wrapper — mesma convenção já usada por .thinking/.speaking.
    canvas.addEventListener("mouseenter", () => { hover = true; orbWrap.classList.add("hover"); });
    canvas.addEventListener("mouseleave", () => { hover = false; orbWrap.classList.remove("hover"); });

    return {
      setState(next) {
        orbState = next;
        // "voice" é um estado interno do renderer (chat de voz futuro); os estados
        // vindos de state.orbState hoje são só idle/thinking/speaking.
        simulateVoiceAmplitude(orbState === "voice");
      },
      refreshColors,
      setVoiceAmplitude,
    };
  })();

  function renderOrb() {
    orbWrap.classList.remove("thinking", "speaking");
    if (state.orbState === "thinking") orbWrap.classList.add("thinking");
    if (state.orbState === "speaking") orbWrap.classList.add("speaking");
    orbLabel.textContent = ORB_LABELS[state.orbState];
    orbThinkingIcon.classList.toggle("hidden", state.orbState !== "thinking");
    OrbRenderer.setState(state.orbState);
  }

  /* ======================================================================
   * Tema
   * ==================================================================== */

  function applyTheme() {
    root.setAttribute("data-theme", state.theme);
  }

  function selectTheme(theme) {
    state.theme = theme;
    applyTheme();
    OrbRenderer.refreshColors();
    themeMenu.classList.add("hidden");
    persist();
  }

  themeToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    themeMenu.classList.toggle("hidden");
  });
  themeMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    const opt = e.target.closest(".theme-opt");
    if (!opt) return;
    selectTheme(opt.dataset.theme);
  });

  /* ======================================================================
   * Estado da janela
   *
   * Não existe logout: o Ambar roda local, sem conta nem autenticação
   * (decisão #11). A tela de "você saiu" era do mockup original e só
   * escondia o app atrás de um botão que voltava — removida em 2026-08-10.
   * ==================================================================== */

  function renderWindowState() {
    sessionEl.classList.remove("hidden");
  }

  /* ======================================================================
   * Sidebar: recolher/expandir, busca, perfil, navegação
   * ==================================================================== */

  function renderSidebar() {
    desktop.classList.toggle("sidebar-collapsed", !state.sidebarExpanded);
  }

  sidebarToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    state.sidebarExpanded = !state.sidebarExpanded;
    renderSidebar();
    persist();
  });
  sidebarEl.addEventListener("click", () => {
    if (!state.sidebarExpanded) {
      state.sidebarExpanded = true;
      renderSidebar();
      persist();
    }
  });

  sidebarSearchInput.addEventListener("click", (e) => e.stopPropagation());

  let searchDebounceTimer = null;
  sidebarSearchInput.addEventListener("input", (e) => {
    state.sidebarSearch = e.target.value;
    clearTimeout(searchDebounceTimer);
    const query = state.sidebarSearch.trim();
    if (!query) {
      state.searchResults = null;
      renderChatLists();
      return;
    }
    searchDebounceTimer = setTimeout(async () => {
      const res = await fetch(`/conversations/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const data = await res.json();
      state.searchResults = data.conversations || [];
      renderChatLists();
    }, 250);
  });

  newChatBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch("/reset", { method: "POST" });
    state.activeChatId = null;
    state.activeView = "chat";
    state.orbState = "idle";
    chatInput.value = "";
    chatEl.innerHTML = "";
    suggestionsEl.classList.remove("hidden");
    confirmBox.classList.add("hidden");
    confirmBox.innerHTML = "";
    renderOrb();
    await refreshConversations();
  });

  profileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.sidebarExpanded) return;
    const willOpen = profileMenu.classList.contains("hidden");
    profileMenu.classList.toggle("hidden", !willOpen);
  });
  profileMenu.addEventListener("click", (e) => e.stopPropagation());
  profileMenuOpenBtn.addEventListener("click", () => {
    state.activeView = "profile";
    profileMenu.classList.add("hidden");
    renderAll();
  });

  document.querySelectorAll(".nav-view").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      state.activeView = item.dataset.view;
      renderAll();
      // A lista de modelos só é buscada uma vez no boot() — se essa chamada falhar
      // (ex: Ollama ainda subindo), o usuário ficava preso na tela de erro pra
      // sempre nessa sessão, mesmo clicando na aba de novo. Rebusca sempre que a
      // view é aberta, sem custo perceptível (é uma chamada rápida).
      if (state.activeView === "models") {
        refreshModels();
        refreshRuntime();
      }
      if (state.activeView === "setup") refreshSetupStatus();
      if (state.activeView === "automation") {
        refreshTasks();
        refreshStandingOrders();
        fetch("/automation/seen", { method: "POST" }).then(() => refreshAutomationBadge());
      }
    });
  });

  el("nav-home").addEventListener("click", (e) => {
    e.stopPropagation();
    state.activeView = "chat";
    renderAll();
  });

  /* ---------- Histórico de conversas (persistido em data/conversations.json) ---------- */

  const DAY_MS = 24 * 60 * 60 * 1000;

  function startOfDay(timestamp) {
    const d = new Date(timestamp);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupChatsByDate(chats) {
    const now = Date.now();
    const todayStart = startOfDay(now);
    const yesterdayStart = todayStart - DAY_MS;
    const last7Start = todayStart - 7 * DAY_MS;

    const groups = [
      { key: "today", label: "HOJE", items: [] },
      { key: "yesterday", label: "ONTEM", items: [] },
      { key: "last7", label: "ÚLTIMOS 7 DIAS", items: [] },
      { key: "older", label: "MAIS ANTIGAS", items: [] }
    ];

    chats.forEach((chat) => {
      const ts = new Date(chat.updated_at).getTime();
      if (ts >= todayStart) groups[0].items.push(chat);
      else if (ts >= yesterdayStart) groups[1].items.push(chat);
      else if (ts >= last7Start) groups[2].items.push(chat);
      else groups[3].items.push(chat);
    });

    return groups.filter((g) => g.items.length > 0);
  }

  async function refreshConversations() {
    const res = await fetch("/conversations");
    const data = await res.json();
    state.chats = data.conversations || [];
    state.activeChatId = data.active_id || null;
    renderChatLists();
  }

  function chatTitle(c) {
    return c.title || "Nova conversa";
  }


  async function loadConversation(id) {
    if (id === state.activeChatId) return;
    const res = await fetch(`/conversations/${id}/activate`, { method: "POST" });
    if (!res.ok) return;
    const conv = await res.json();
    state.activeChatId = conv.id;
    state.activeView = "chat";
    state.orbState = "idle";
    confirmBox.classList.add("hidden");
    confirmBox.innerHTML = "";

    chatEl.innerHTML = "";
    const msgs = (conv.messages || []).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    msgs.forEach((m) => {
      const text = m.role === "assistant" ? stripAgentTags(m.content) || m.content : m.content;
      addMessage(m.role === "assistant" ? "assistant" : "user", text, m.images);
    });
    suggestionsEl.classList.toggle("hidden", msgs.length !== 0);

    await refreshConversations();
    renderAll();
  }

  const STAR_ICON_PATH = "M12 3.5l2.36 5.44 5.89.55-4.46 3.9 1.34 5.79L12 16.13l-5.13 3.05 1.34-5.79-4.46-3.9 5.89-.55L12 3.5z";

  function buildPinnedRow(chat) {
    const row = document.createElement("div");
    row.className = "side-item pinned-item chat-row" + (chat.id === state.activeChatId ? " active" : "");

    if (state.renamingChatId === chat.id) {
      row.addEventListener("click", (e) => e.stopPropagation());
      const input = document.createElement("input");
      input.className = "chat-row-input";
      input.value = state.renameDraft;
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("input", (e) => { state.renameDraft = e.target.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { commitRename(); }
        if (e.key === "Escape") { state.renamingChatId = null; renderChatLists(); }
      });
      input.addEventListener("blur", () => commitRename());
      row.appendChild(input);
      setTimeout(() => input.focus(), 0);
      sidebarPinned.appendChild(row);
      return;
    }

    if (state.confirmDeleteChatId === chat.id) {
      row.addEventListener("click", (e) => e.stopPropagation());

      const title = document.createElement("span");
      title.className = "side-label flex1";
      title.textContent = chatTitle(chat);
      row.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "chat-row-actions";

      const label = document.createElement("span");
      label.className = "chat-row-confirm-label";
      label.textContent = "Excluir?";
      actions.appendChild(label);

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "chat-row-action-btn danger";
      confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
      confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><polyline points="20 6 9 17 4 12"/></svg>';
      confirmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/conversations/${chat.id}`, { method: "DELETE" });
        state.confirmDeleteChatId = null;
        if (state.activeChatId === chat.id) {
          state.activeChatId = null;
          chatEl.innerHTML = "";
          suggestionsEl.classList.remove("hidden");
        }
        await refreshConversations();
        renderAll();
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "chat-row-action-btn";
      cancelBtn.setAttribute("aria-label", "Cancelar");
      cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.confirmDeleteChatId = null;
        renderChatLists();
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      row.appendChild(actions);
      sidebarPinned.appendChild(row);
      return;
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      loadConversation(chat.id);
    });

    const title = document.createElement("span");
    title.className = "side-label flex1";
    title.textContent = chatTitle(chat);
    row.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "chat-row-actions";

    const pinBtn = document.createElement("button");
    pinBtn.className = "chat-row-action-btn pinned";
    pinBtn.setAttribute("aria-label", "Desfixar conversa");
    pinBtn.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="${STAR_ICON_PATH}"/></svg>`;
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/conversations/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
      await refreshConversations();
    });

    const renameBtn = document.createElement("button");
    renameBtn.className = "chat-row-action-btn";
    renameBtn.setAttribute("aria-label", "Renomear conversa");
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.renamingChatId = chat.id;
      state.renameDraft = chatTitle(chat);
      renderChatLists();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-row-action-btn danger";
    deleteBtn.setAttribute("aria-label", "Excluir conversa");
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.confirmDeleteChatId = chat.id;
      renderChatLists();
    });

    actions.appendChild(pinBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);

    sidebarPinned.appendChild(row);
  }

  function buildChatRow(chat, container) {
    const row = document.createElement("div");
    row.className = "chat-row" + (chat.id === state.activeChatId ? " active" : "");

    if (state.selectMode) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "chat-row-checkbox";
      checkbox.checked = state.selectedChatIds.includes(chat.id);
      checkbox.setAttribute("aria-label", "Selecionar conversa");
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.selectedChatIds.push(chat.id);
        } else {
          state.selectedChatIds = state.selectedChatIds.filter((x) => x !== chat.id);
        }
        renderChatLists();
      });
      row.appendChild(checkbox);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      });

      const title = document.createElement("span");
      title.className = "chat-row-title";
      title.textContent = chatTitle(chat);
      row.appendChild(title);

      container.appendChild(row);
      return;
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      loadConversation(chat.id);
    });

    if (state.renamingChatId === chat.id) {
      const input = document.createElement("input");
      input.className = "chat-row-input";
      input.value = state.renameDraft;
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("input", (e) => { state.renameDraft = e.target.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { commitRename(); }
        if (e.key === "Escape") { state.renamingChatId = null; renderChatLists(); }
      });
      input.addEventListener("blur", () => commitRename());
      row.appendChild(input);
      setTimeout(() => input.focus(), 0);
    } else if (state.confirmDeleteChatId === chat.id) {
      const title = document.createElement("span");
      title.className = "chat-row-title";
      title.textContent = chatTitle(chat);
      row.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "chat-row-actions";

      const label = document.createElement("span");
      label.className = "chat-row-confirm-label";
      label.textContent = "Excluir?";
      actions.appendChild(label);

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "chat-row-action-btn danger";
      confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
      confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><polyline points="20 6 9 17 4 12"/></svg>';
      confirmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/conversations/${chat.id}`, { method: "DELETE" });
        state.confirmDeleteChatId = null;
        if (state.activeChatId === chat.id) {
          state.activeChatId = null;
          chatEl.innerHTML = "";
          suggestionsEl.classList.remove("hidden");
        }
        await refreshConversations();
        renderAll();
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "chat-row-action-btn";
      cancelBtn.setAttribute("aria-label", "Cancelar");
      cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.confirmDeleteChatId = null;
        renderChatLists();
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      row.appendChild(actions);
    } else {
      const title = document.createElement("span");
      title.className = "chat-row-title";
      title.textContent = chatTitle(chat);
      row.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "chat-row-actions";

      const pinBtn = document.createElement("button");
      pinBtn.className = "chat-row-action-btn" + (chat.pinned ? " pinned" : "");
      pinBtn.setAttribute("aria-label", "Fixar conversa");
      pinBtn.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="${STAR_ICON_PATH}"/></svg>`;
      pinBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/conversations/${chat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: !chat.pinned }),
        });
        await refreshConversations();
      });

      const renameBtn = document.createElement("button");
      renameBtn.className = "chat-row-action-btn";
      renameBtn.setAttribute("aria-label", "Renomear conversa");
      renameBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.renamingChatId = chat.id;
        state.renameDraft = chatTitle(chat);
        renderChatLists();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "chat-row-action-btn danger";
      deleteBtn.setAttribute("aria-label", "Excluir conversa");
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.confirmDeleteChatId = chat.id;
        renderChatLists();
      });

      actions.appendChild(pinBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(actions);
    }

    container.appendChild(row);
  }

  async function commitRename() {
    if (state.renamingChatId) {
      const draft = state.renameDraft;
      const id = state.renamingChatId;
      state.renamingChatId = null;
      if (draft && draft.trim()) {
        await fetch(`/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: draft.trim() }),
        });
      }
      await refreshConversations();
    }
  }

  selectModeToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectMode = !state.selectMode;
    state.selectedChatIds = [];
    renderChatLists();
  });

  bulkCancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectMode = false;
    state.selectedChatIds = [];
    renderChatLists();
  });

  bulkDeleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (state.selectedChatIds.length === 0) return;
    await Promise.all(
      state.selectedChatIds.map((id) => fetch(`/conversations/${id}`, { method: "DELETE" }))
    );
    if (state.selectedChatIds.includes(state.activeChatId)) {
      state.activeChatId = null;
      chatEl.innerHTML = "";
      suggestionsEl.classList.remove("hidden");
    }
    state.selectMode = false;
    state.selectedChatIds = [];
    await refreshConversations();
    renderAll();
  });

  function renderChatLists() {
    const visible = state.searchResults !== null ? state.searchResults : state.chats;
    const pinned = visible.filter((c) => c.pinned);
    const unpinned = visible.filter((c) => !c.pinned);

    sidebarPinned.innerHTML = "";
    pinned.forEach((c) => buildPinnedRow(c));
    pinnedTitle.hidden = pinned.length === 0;
    pinnedSep.hidden = pinned.length === 0;

    const groups = groupChatsByDate(unpinned);
    historyGroups.innerHTML = "";
    groups.forEach((group) => {
      const header = document.createElement("div");
      header.className = "side-section-label history-group-label";
      header.textContent = group.label;
      historyGroups.appendChild(header);

      const list = document.createElement("div");
      group.items
        .slice()
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .forEach((c) => buildChatRow(c, list));
      historyGroups.appendChild(list);
    });

    const search = (state.sidebarSearch || "").trim();
    noSearchResults.classList.toggle("hidden", !(search && visible.length === 0));

    selectModeToggle.textContent = state.selectMode ? "Concluir" : "Selecionar";
    bulkActionsBar.classList.toggle("hidden", !state.selectMode);
    bulkCount.textContent = `${state.selectedChatIds.length} selecionada${state.selectedChatIds.length === 1 ? "" : "s"}`;
    bulkDeleteBtn.disabled = state.selectedChatIds.length === 0;
  }

  selectModeToggle.addEventListener("click", (e) => e.stopPropagation());
  bulkCancelBtn.addEventListener("click", (e) => e.stopPropagation());
  bulkDeleteBtn.addEventListener("click", (e) => e.stopPropagation());

  /* ======================================================================
   * Views
   * ==================================================================== */

  function renderViews() {
    Object.keys(views).forEach((key) => {
      views[key].classList.toggle("hidden", state.activeView !== key);
    });
    document.querySelectorAll(".nav-view").forEach((item) => {
      item.classList.toggle("active", item.dataset.view === state.activeView);
    });
  }

  /* ---------- Chat real (conectado ao backend) ---------- */

  function agentAvatarSvg() {
    return '<svg viewBox="0 0 24 24"><path d="M12 8V3M14 8.53L16.5 4.21M15.46 10L19.79 7.5M16 12H21M15.46 14L19.79 16.5M14 15.46L16.5 19.79M12 16V21M10 15.46L7.5 19.79M8.54 14L4.21 16.5M8 12H3M8.54 10L4.21 7.5M10 8.54L7.5 4.21"/></svg>';
  }

  function addMessage(role, text, images) {
    const row = document.createElement("div");
    row.className = "msg-row " + (role === "assistant" ? "assistant" : "user");
    if (role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "msg-avatar";
      avatar.innerHTML = agentAvatarSvg();
      row.appendChild(avatar);
    }
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    if (images && images.length) {
      const imagesWrap = document.createElement("div");
      imagesWrap.className = "msg-images";
      images.forEach((base64) => {
        const img = document.createElement("img");
        img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
        imagesWrap.appendChild(img);
      });
      bubble.appendChild(imagesWrap);
    }

    const textSpan = document.createElement("span");
    textSpan.textContent = text;
    bubble.appendChild(textSpan);

    row.appendChild(bubble);
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
    suggestionsEl.classList.add("hidden");
    return bubble;
  }

  /* ---------- Anexar imagem (visão) ---------- */

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderAttachmentPreview() {
    attachmentPreview.innerHTML = "";
    attachmentPreview.classList.toggle("hidden", state.pendingImages.length === 0);
    attachBtn.classList.toggle("has-attachments", state.pendingImages.length > 0);

    state.pendingImages.forEach((base64, index) => {
      const thumb = document.createElement("div");
      thumb.className = "attachment-thumb";

      const img = document.createElement("img");
      img.src = base64;
      thumb.appendChild(img);

      const removeBtn = document.createElement("button");
      removeBtn.className = "attachment-remove";
      removeBtn.setAttribute("aria-label", "Remover imagem");
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      removeBtn.addEventListener("click", () => {
        state.pendingImages.splice(index, 1);
        renderAttachmentPreview();
      });
      thumb.appendChild(removeBtn);

      attachmentPreview.appendChild(thumb);
    });
  }

  // Botão de anexo abre um menu com duas opções (Imagem/PDF) em vez de ir direto pro
  // seletor de arquivo — os dois formatos seguem fluxos diferentes por baixo (imagem
  // vira base64 pro Ollama; PDF não tem caminho de visão, então é copiado pra
  attachBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    attachMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => attachMenu.classList.add("hidden"));
  attachMenu.addEventListener("click", (e) => e.stopPropagation());

  attachOptImage.addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    attachFileInput.click();
  });
  attachOptPdf.addEventListener("click", () => {
    attachMenu.classList.add("hidden");
    attachPdfInput.click();
  });

  attachFileInput.addEventListener("change", async () => {
    const files = Array.from(attachFileInput.files || []);
    attachFileInput.value = "";
    if (!files.length) return;

    const statusRes = await fetch("/models/vision-status");
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (!status.supports_vision) {
        // Avisa, mas não impede: a imagem continua útil como ARQUIVO (o modelo pode
        // usá-la num <img src="...">) mesmo sem conseguir enxergar o conteúdo dela.
        const seguir = window.confirm(
          `O modelo ativo (${status.model}) não enxerga imagens — ele não vai conseguir ` +
          `descrever o que está na figura.\n\n` +
          `A imagem ainda será salva na workspace, então ele pode usá-la para montar uma ` +
          `página (por exemplo, um card).\n\n` +
          `Para que ele analise a imagem, troque para um modelo de visão em "Modelos de IA".\n\n` +
          `Anexar mesmo assim?`
        );
        if (!seguir) return;
      }
    }

    const encoded = await Promise.all(files.map(fileToBase64));
    state.pendingImages.push(...encoded);
    renderAttachmentPreview();

    // Além do base64 (que é como o modelo VÊ a imagem), grava o arquivo na workspace:
    // sem isso, um pedido tipo "faça um card com essa imagem" não tinha arquivo real pra
    // referenciar no <img src="...">, e o modelo acabava apontando pra alguma imagem
    // antiga que estivesse na pasta — o preview mostrava a figura errada.
    state.lastImageFiles = [];
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch("/workspace/upload", { method: "POST", body: formData });
        if (res.ok) state.lastImageFiles.push((await res.json()).filename);
      } catch (err) {
        /* O anexo continua funcionando pra visão mesmo se a cópia falhar. */
      }
    }
    if (state.lastImageFiles.length) renderAttachmentPreview();
  });

  attachPdfInput.addEventListener("change", async () => {
    const file = attachPdfInput.files && attachPdfInput.files[0];
    attachPdfInput.value = "";
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    let data;
    try {
      const res = await fetch("/workspace/upload", { method: "POST", body: formData });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao enviar o PDF.");
    } catch (err) {
      window.alert(err.message || "Falha ao enviar o PDF.");
      return;
    }

    // O modelo lê o PDF de verdade via <agent-read> (não há caminho de visão pra PDF);
    // já deixamos o pedido pronto no campo de mensagem pro usuário só revisar e enviar,
    // mesma convenção do botão "Usar" da Biblioteca (preenche, não envia sozinho).
    const prefix = chatInput.value.trim() ? `${chatInput.value.trim()} ` : "";
    chatInput.value = `${prefix}Leia o arquivo "${data.filename}" e me diga o que ele contém.`;
    chatInput.focus();
  });

  function showTyping(bubble) {
    bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  }

  /* Parada manual da geração: o botão de parar troca de lugar com o de enviar enquanto
     o modelo responde. Abortar o fetch derruba a conexão, e o servidor detecta isso via
     request.is_disconnected() e para de puxar tokens do Ollama — sem isso o modelo
     continuaria gerando a resposta inteira mesmo com a tela já parada. */
  let streamAbort = null;

  function setGenerating(on) {
    streamAbort = on ? new AbortController() : null;
    sendBtn.classList.toggle("hidden", on);
    stopBtn.classList.toggle("hidden", !on);
  }

  function stopGenerating() {
    if (streamAbort) streamAbort.abort();
  }

  stopBtn.addEventListener("click", stopGenerating);

  async function streamResponse(response, bubble) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    while (true) {
      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        // Abortar o fetch faz o reader rejeitar — é a parada manual, não um erro real.
        if (err.name !== "AbortError") throw err;
        break;
      }
      if (done) break;

      // Primeiro byte recebido = o modelo começou a gerar, ou seja, já está carregado.
      // Some com o aviso de carregamento aqui em vez de esperar o polling de 3s notar.
      hideLoadingNotice();
      stopRuntimePolling();

      buffer += decoder.decode(value, { stream: true });

      let keepGoing = true;
      while (keepGoing) {
        const start = buffer.indexOf(CONFIRM_MARK);
        if (start === -1) {
          text += buffer;
          buffer = "";
          keepGoing = false;
          break;
        }
        text += buffer.slice(0, start);
        const rest = buffer.slice(start + 1);
        const end = rest.indexOf(CONFIRM_MARK);
        if (end === -1) {
          buffer = buffer.slice(start);
          keepGoing = false;
          break;
        }
        const marker = rest.slice(0, end);
        buffer = rest.slice(end + 1);
        if (marker.startsWith("CONFIRM:")) {
          const actionId = marker.slice("CONFIRM:".length);
          bubble.textContent = stripAgentTags(text);
          state.orbState = "idle";
          renderOrb();
          await handleConfirmation(actionId, bubble);
          return;
        }
      }

      const display = stripAgentTags(text);
      if (!display) {
        showTyping(bubble);
      } else {
        bubble.textContent = display;
        state.orbState = "speaking";
        renderOrb();
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    }
    bubble.textContent = stripAgentTags(text);
    state.orbState = "idle";
    renderOrb();
  }

  async function handleConfirmation(actionId, bubble) {
    const res = await fetch(`/pending/${actionId}`);
    const info = await res.json();

    confirmBox.classList.remove("hidden");
    confirmBox.innerHTML = "";

    const title = document.createElement("p");
    title.className = "confirm-title";

    const badge = document.createElement("span");
    badge.className = "confirm-tag-badge";
    badge.textContent = TAG_LABELS[info.tag] || info.tag;
    title.appendChild(badge);

    if (info.attrs && info.attrs.path) {
      const pathSpan = document.createElement("span");
      pathSpan.textContent = info.attrs.path;
      title.appendChild(pathSpan);
    }
    confirmBox.appendChild(title);

    if (info.warning) {
      const warning = document.createElement("p");
      warning.className = "confirm-warning";
      warning.textContent = `⚠ ${info.warning}`;
      confirmBox.appendChild(warning);
    }

    if (info.content) {
      const pre = document.createElement("pre");
      pre.className = info.warning ? "confirm-content-risky" : "";
      pre.textContent = info.content;
      confirmBox.appendChild(pre);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "approve-btn";
    approveBtn.textContent = "Aprovar";
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "reject-btn";
    rejectBtn.textContent = "Recusar";

    approveBtn.onclick = () => resolveConfirmation(actionId, true, bubble);
    rejectBtn.onclick = () => resolveConfirmation(actionId, false, bubble);

    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    confirmBox.appendChild(actions);
  }

  async function resolveConfirmation(actionId, approved, bubble) {
    confirmBox.classList.add("hidden");
    confirmBox.innerHTML = "";

    const newBubble = addMessage("assistant", "");
    showTyping(newBubble);
    state.orbState = "thinking";
    renderOrb();

    setGenerating(true);
    try {
      const response = await fetch(`/confirm/${actionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
        signal: streamAbort.signal,
      });

      await streamResponse(response, newBubble);
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    } finally {
      setGenerating(false);
      state.orbState = "idle";
      renderOrb();
    }

    await refreshPreviewStatus();
    await refreshMemory();
    await refreshConversations();
  }

  async function onSend() {
    const text = chatInput.value.trim();
    const images = state.pendingImages.slice();
    if (!text && images.length === 0) return;
    const arquivos = state.lastImageFiles.slice();
    chatInput.value = "";
    state.pendingImages = [];
    state.lastImageFiles = [];
    renderAttachmentPreview();

    // Na bolha do chat o usuário vê só o que escreveu; o nome do arquivo é detalhe
    // técnico. Mas o MODELO precisa dele: é o que permite escrever <img src="foto.jpg">
    // apontando pra imagem certa em vez de chutar um nome antigo da pasta.
    const textoParaModelo =
      images.length && arquivos.length
        ? `${text}\n\n[A imagem anexada está salva na workspace como: ${arquivos.join(", ")}]`
        : text;

    addMessage("user", text, images);
    const bubble = addMessage("assistant", "");
    showTyping(bubble);
    state.orbState = "thinking";
    renderOrb();

    const rawImages = images.map((base64) => base64.replace(/^data:[^;]+;base64,/, ""));

    // Avisa (sem bloquear) se o modelo ainda não está na memória — a espera pode ser de
    // minutos e, sem isso, é indistinguível de um travamento.
    noticeIfModelCold();

    setGenerating(true);
    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: textoParaModelo,
          images: rawImages.length ? rawImages : undefined,
        }),
        signal: streamAbort.signal,
      });

      // como se fosse a resposta do modelo, e o usuário veria um texto técnico na bolha
      // em vez de saber que precisa renovar.
      await streamResponse(response, bubble);
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    } finally {
      setGenerating(false);
      state.orbState = "idle";
      renderOrb();
    }

    await refreshPreviewStatus();
    await refreshMemory();
    await refreshConversations();
  }

  sendBtn.addEventListener("click", onSend);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSend();
  });

  function sendSuggestion(text) {
    chatInput.value = text;
    setTimeout(onSend, 0);
  }

  document.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => sendSuggestion(chip.dataset.text));
  });

  /* mic-btn: placeholder visual, sem transcrição de voz implementada ainda */

  /* ---------- Projetos (persistidos em data/projects.json, contexto real no prompt) ---------- */

  async function refreshProjects() {
    const res = await fetch("/projects");
    const data = await res.json();
    state.projects = data.projects || [];
    renderProjects();
  }

  async function openProjectChat(projectId) {
    const res = await fetch(`/projects/${projectId}/chat`, { method: "POST" });
    if (!res.ok) return;
    const conv = await res.json();
    state.activeChatId = conv.id;
    state.activeView = "chat";
    state.orbState = "idle";
    chatEl.innerHTML = "";
    suggestionsEl.classList.remove("hidden");
    confirmBox.classList.add("hidden");
    confirmBox.innerHTML = "";
    await refreshConversations();
    renderAll();
  }

  function renderProjects() {
    projectsList.innerHTML = "";
    projectsEmpty.classList.toggle("hidden", state.projects.length !== 0);
    state.projects.forEach((project) => {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = project.name;
      head.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.confirmDeleteProject === project.id) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/projects/${project.id}`, { method: "DELETE" });
          state.confirmDeleteProject = null;
          await refreshProjects();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "card-cancel-btn";
        cancelBtn.setAttribute("aria-label", "Cancelar");
        cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        cancelBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteProject = null;
          renderProjects();
        });

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const openBtn = document.createElement("button");
        openBtn.className = "card-open-btn";
        openBtn.textContent = "Conversar";
        openBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openProjectChat(project.id);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir projeto");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteProject = project.id;
          renderProjects();
        });

        actions.appendChild(openBtn);
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = project.description || "Sem descrição.";
      card.appendChild(desc);

      const workspaceHint = document.createElement("span");
      workspaceHint.className = "card-updated";
      workspaceHint.textContent = `workspace/${project.workspace_dir}`;
      card.appendChild(workspaceHint);

      projectsList.appendChild(card);
    });
  }

  const newProjectForm = el("new-project-form");
  const newProjectNameInput = el("new-project-name");
  const newProjectDescInput = el("new-project-desc");

  newProjectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = newProjectNameInput.value.trim();
    if (!name) return;
    const description = newProjectDescInput.value.trim();
    const res = await fetch("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) return;
    newProjectNameInput.value = "";
    newProjectDescInput.value = "";
    await refreshProjects();
  });

  /* ---------- Automação: tarefas agendadas + ordens permanentes ---------- */

  const tasksList = el("tasks-list");
  const tasksEmpty = el("tasks-empty");
  const standingOrdersList = el("standing-orders-list");
  const standingOrdersEmpty = el("standing-orders-empty");
  const automationBadge = el("automation-badge");

  async function refreshTasks() {
    const res = await fetch("/tasks");
    const data = await res.json();
    state.tasks = data.tasks || [];
    renderTasks();
  }

  async function refreshStandingOrders() {
    const res = await fetch("/standing-orders");
    const data = await res.json();
    state.standingOrders = data.entries || [];
    renderStandingOrders();
  }

  async function refreshAutomationBadge() {
    try {
      const res = await fetch("/automation/status");
      const data = await res.json();
      automationBadge.classList.toggle("hidden", !data.has_unseen);
    } catch (e) { /* ignore — próximo poll tenta de novo */ }
  }

  const SCHEDULE_TYPE_LABELS = { once: "Uma vez", daily: "Todo dia", weekly: "Toda semana" };
  const WEEKDAY_LABELS = { mon: "segunda", tue: "terça", wed: "quarta", thu: "quinta", fri: "sexta", sat: "sábado", sun: "domingo" };

  function formatSchedule(task) {
    if (task.schedule_type === "daily") {
      const { hour, minute } = task.schedule_value;
      return `Todo dia às ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    if (task.schedule_type === "weekly") {
      const { hour, minute, weekday } = task.schedule_value;
      return `Toda ${WEEKDAY_LABELS[weekday] || weekday} às ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return `Uma vez (${SCHEDULE_TYPE_LABELS[task.schedule_type] || task.schedule_type})`;
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    } catch (e) {
      return iso;
    }
  }

  function renderTasks() {
    tasksList.innerHTML = "";
    tasksEmpty.classList.toggle("hidden", state.tasks.length !== 0);
    state.tasks.forEach((task) => {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = task.instruction;
      head.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.confirmDeleteTask === task.id) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/tasks/${task.id}`, { method: "DELETE" });
          state.confirmDeleteTask = null;
          await refreshTasks();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "card-cancel-btn";
        cancelBtn.setAttribute("aria-label", "Cancelar");
        cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        cancelBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteTask = null;
          renderTasks();
        });

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "card-open-btn";
        toggleBtn.textContent = task.enabled ? "Desativar" : "Ativar";
        toggleBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/tasks/${task.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !task.enabled }),
          });
          await refreshTasks();
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir tarefa");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteTask = task.id;
          renderTasks();
        });

        actions.appendChild(toggleBtn);
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const schedule = document.createElement("span");
      schedule.className = "card-desc";
      schedule.textContent = formatSchedule(task) + (task.enabled ? "" : " · desativada");
      card.appendChild(schedule);

      const status = document.createElement("span");
      status.className = "card-updated";
      status.textContent = task.last_run_at
        ? `Última execução: ${formatDateTime(task.last_run_at)} · ${task.last_run_result || ""}`
        : `Próxima execução: ${formatDateTime(task.next_run_at)}`;
      card.appendChild(status);

      tasksList.appendChild(card);
    });
  }

  function renderStandingOrders() {
    standingOrdersList.innerHTML = "";
    standingOrdersEmpty.classList.toggle("hidden", state.standingOrders.length !== 0);
    state.standingOrders.forEach((entry) => {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = entry.text;
      head.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.confirmDeleteStandingOrder === entry.id) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/standing-orders/${entry.id}`, { method: "DELETE" });
          state.confirmDeleteStandingOrder = null;
          await refreshStandingOrders();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "card-cancel-btn";
        cancelBtn.setAttribute("aria-label", "Cancelar");
        cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        cancelBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteStandingOrder = null;
          renderStandingOrders();
        });

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir ordem permanente");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteStandingOrder = entry.id;
          renderStandingOrders();
        });

        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      standingOrdersList.appendChild(card);
    });
  }

  document.querySelectorAll(".automation-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.automationTab = tab.dataset.tab;
      document.querySelectorAll(".automation-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.tab === state.automationTab);
      });
      el("automation-tab-tasks").classList.toggle("hidden", state.automationTab !== "tasks");
      el("automation-tab-orders").classList.toggle("hidden", state.automationTab !== "orders");
    });
  });

  const newTaskForm = el("new-task-form");
  const newTaskInstruction = el("new-task-instruction");
  const newTaskType = el("new-task-type");
  const newTaskMinutes = el("new-task-minutes");
  const newTaskTime = el("new-task-time");
  const newTaskWeekday = el("new-task-weekday");

  function updateTaskScheduleFields() {
    const type = newTaskType.value;
    newTaskMinutes.classList.toggle("hidden", type !== "once");
    newTaskTime.classList.toggle("hidden", type === "once");
    newTaskWeekday.classList.toggle("hidden", type !== "weekly");
  }
  newTaskType.addEventListener("change", updateTaskScheduleFields);
  updateTaskScheduleFields();

  newTaskForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const instruction = newTaskInstruction.value.trim();
    if (!instruction) return;
    const type = newTaskType.value;
    let schedule_value;
    if (type === "once") {
      const minutes = parseInt(newTaskMinutes.value, 10);
      if (!minutes || minutes <= 0) return;
      schedule_value = { minutes_from_now: minutes };
    } else {
      const [hourStr, minuteStr] = (newTaskTime.value || "00:00").split(":");
      schedule_value = { hour: parseInt(hourStr, 10), minute: parseInt(minuteStr, 10) };
      if (type === "weekly") schedule_value.weekday = newTaskWeekday.value;
    }
    const res = await fetch("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, schedule_type: type, schedule_value }),
    });
    if (!res.ok) return;
    newTaskInstruction.value = "";
    newTaskMinutes.value = "";
    await refreshTasks();
  });

  const newStandingOrderForm = el("new-standing-order-form");
  const newStandingOrderText = el("new-standing-order-text");
  const newStandingOrderCount = el("new-standing-order-count");

  newStandingOrderText.addEventListener("input", () => {
    newStandingOrderCount.textContent = `${newStandingOrderText.value.length}/300`;
  });

  newStandingOrderForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = newStandingOrderText.value.trim();
    if (!text) return;
    const res = await fetch("/standing-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    newStandingOrderText.value = "";
    newStandingOrderCount.textContent = "0/300";
    await refreshStandingOrders();
  });

  /* ---------- Biblioteca (persistida em data/library.json) ---------- */

  async function refreshLibrary() {
    const res = await fetch("/library");
    const data = await res.json();
    state.library = data.items || [];
    renderLibrary();
  }

  function useLibraryItem(item) {
    state.activeView = "chat";
    chatInput.value = item.content;
    renderAll();
    chatInput.focus();
  }

  function renderLibrary() {
    libraryList.innerHTML = "";
    libraryEmpty.classList.toggle("hidden", state.library.length !== 0);
    state.library.forEach((item) => {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = item.name;
      head.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.confirmDeleteLibrary === item.id) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/library/${item.id}`, { method: "DELETE" });
          state.confirmDeleteLibrary = null;
          await refreshLibrary();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "card-cancel-btn";
        cancelBtn.setAttribute("aria-label", "Cancelar");
        cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        cancelBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteLibrary = null;
          renderLibrary();
        });

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const useBtn = document.createElement("button");
        useBtn.className = "card-open-btn";
        useBtn.textContent = "Usar";
        useBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          useLibraryItem(item);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir item");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteLibrary = item.id;
          renderLibrary();
        });

        actions.appendChild(useBtn);
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = item.content;
      card.appendChild(desc);

      libraryList.appendChild(card);
    });
  }

  const newLibraryForm = el("new-library-form");
  const newLibraryNameInput = el("new-library-name");
  const newLibraryContentInput = el("new-library-content");

  newLibraryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = newLibraryNameInput.value.trim();
    const content = newLibraryContentInput.value.trim();
    if (!name || !content) return;
    const res = await fetch("/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    if (!res.ok) return;
    newLibraryNameInput.value = "";
    newLibraryContentInput.value = "";
    await refreshLibrary();
  });

  /* ---------- Base de conhecimento (persistida em data/knowledge.json) ---------- */

  async function refreshKnowledge() {
    const res = await fetch("/knowledge");
    const data = await res.json();
    state.knowledge = data.items || [];
    renderKnowledge();
  }

  function renderKnowledge() {
    knowledgeList.innerHTML = "";
    knowledgeEmpty.classList.toggle("hidden", state.knowledge.length !== 0);
    state.knowledge.forEach((item) => {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = item.title;
      head.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (state.confirmDeleteKnowledge === item.id) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`/knowledge/${item.id}`, { method: "DELETE" });
          state.confirmDeleteKnowledge = null;
          await refreshKnowledge();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "card-cancel-btn";
        cancelBtn.setAttribute("aria-label", "Cancelar");
        cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        cancelBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteKnowledge = null;
          renderKnowledge();
        });

        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir item");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteKnowledge = item.id;
          renderKnowledge();
        });

        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = item.content.length > 240 ? item.content.slice(0, 240) + "…" : item.content;
      card.appendChild(desc);

      knowledgeList.appendChild(card);
    });
  }

  const newKnowledgeForm = el("new-knowledge-form");
  const newKnowledgeTitleInput = el("new-knowledge-title");
  const newKnowledgeContentInput = el("new-knowledge-content");

  newKnowledgeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = newKnowledgeTitleInput.value.trim();
    const content = newKnowledgeContentInput.value.trim();
    if (!title || !content) return;
    const res = await fetch("/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) return;
    newKnowledgeTitleInput.value = "";
    newKnowledgeContentInput.value = "";
    await refreshKnowledge();
  });

  /* ---------- Memória real (conectada ao backend) ---------- */

  async function refreshMemory() {
    const res = await fetch("/memory");
    const data = await res.json();
    const entries = data.entries || [];

    memoryCountEl.textContent = String(entries.length);
    memoryListEl.innerHTML = "";
    memoryEmptyEl.classList.toggle("hidden", entries.length !== 0);

    entries.forEach((entry) => {
      const card = document.createElement("div");
      card.className = "card memory-card";

      const text = document.createElement("span");
      text.className = "card-desc";
      text.textContent = entry.text;
      card.appendChild(text);

      const removeBtn = document.createElement("button");
      removeBtn.className = "card-icon-btn danger";
      removeBtn.setAttribute("aria-label", "Apagar memória");
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      removeBtn.addEventListener("click", async () => {
        await fetch(`/memory/${entry.id}`, { method: "DELETE" });
        await refreshMemory();
      });
      card.appendChild(removeBtn);

      memoryListEl.appendChild(card);
    });
  }

  memoryClearEl.addEventListener("click", async () => {
    await fetch("/memory/reset", { method: "POST" });
    await refreshMemory();
  });

  /* ---------- Servidor de preview real (conectado ao backend) ---------- */

  async function refreshPreviewStatus() {
    const res = await fetch("/preview/status");
    const info = await res.json();

    previewDotEl.classList.remove("running", "starting");

    if (info.running && info.url) {
      previewDotEl.classList.add("running");
      previewStatusTextEl.textContent = `Rodando: ${info.command}`;
      previewLinkEl.href = info.url;
      previewLinkEl.classList.remove("hidden");
      previewRefreshEl.classList.remove("hidden");
      previewStopEl.classList.remove("hidden");
      if (previewFrameEl.src !== info.url) {
        previewFrameEl.src = info.url;
      }
      previewFrameEl.classList.remove("hidden");
      previewEmptyEl.classList.add("hidden");
    } else if (info.running) {
      previewDotEl.classList.add("starting");
      previewStatusTextEl.textContent = `Iniciando: ${info.command} (aguardando detectar a porta)`;
      previewLinkEl.classList.add("hidden");
      previewRefreshEl.classList.add("hidden");
      previewStopEl.classList.remove("hidden");
      previewFrameEl.classList.add("hidden");
      previewEmptyEl.classList.remove("hidden");
    } else {
      previewStatusTextEl.textContent = "Nenhum servidor de preview rodando";
      previewLinkEl.classList.add("hidden");
      previewRefreshEl.classList.add("hidden");
      previewStopEl.classList.add("hidden");
      previewFrameEl.classList.add("hidden");
      previewFrameEl.src = "";
      previewEmptyEl.classList.remove("hidden");
    }
  }

  previewRefreshEl.addEventListener("click", () => {
    if (previewFrameEl.src) {
      previewFrameEl.src = previewFrameEl.src;
    }
  });

  previewStopEl.addEventListener("click", async () => {
    await fetch("/preview/stop", { method: "POST" });
    await refreshPreviewStatus();
  });

  /* ---------- Estado do motor (carregamento do modelo) ---------- */

  // Existe por um motivo concreto de experiência: quando o modelo não está na memória, a
  // primeira mensagem leva minutos lendo o disco (GPU parada, disco a 100%) e a tela
  // mostrava o mesmo spinner de uma resposta rápida — indistinguível de travamento. Aqui
  // o app passa a DIZER o que está acontecendo, em vez de deixar o usuário adivinhar.

  let runtimePoll = null;
  let elapsedTimer = null;
  // "O usuário pediu o carregamento agora mesmo" — vale até o servidor confirmar que está
  // carregando (ou que já terminou). Ver o comentário em renderRuntimePanel.
  let preloadPedido = false;

  function showLoadingNotice(html) {
    // Toda troca de aviso passa por aqui, então é aqui que o timer anterior morre. Sem
    // isso, trocar o aviso "modelo carregando" (com contador) pelo de "Ollama parado"
    // (sem contador) deixaria o setInterval rodando invisível pelo resto da sessão.
    stopElapsedTimer();
    loadingNotice.innerHTML = html;
    loadingNotice.classList.remove("hidden");
  }

  // Variante com barra + tempo decorrido, só pro caso de ESPERA (modelo carregando).
  // O aviso de "Ollama não está rodando" continua sem barra de propósito: ali nada está
  // carregando, é um problema pro usuário resolver — barra animada ali sugeriria que
  // basta esperar, que é o oposto do que ele precisa fazer.
  function showLoadingNoticeWithBar(html) {
    showLoadingNotice(
      html +
        '<div class="load-bar"></div>' +
        '<div class="load-meta">' +
        "<span>Sem previsão exata — depende do computador</span>" +
        '<span class="load-elapsed">há 0s</span>' +
        "</div>"
    );
    startElapsedTimer();
  }

  // O tempo decorrido é a ÚNICA informação real de progresso disponível (o Ollama não
  // reporta percentual), e ajuda o usuário a calibrar a espera sem prometer prazo.
  //
  // Atualiza TODOS os `.load-elapsed` visíveis, por classe e não por id: o contador existe
  // em dois lugares (aviso do chat e painel de Modelos) e um id repetido seria HTML
  // inválido — `getElementById` acharia só o primeiro e o outro ficaria congelado em "há 0s".
  function startElapsedTimer() {
    stopElapsedTimer();
    const startedAt = Date.now();
    elapsedTimer = setInterval(() => {
      const alvos = document.querySelectorAll(".load-elapsed");
      // Os avisos podem ter sido removidos entre dois ticks — sem isso o timer ficaria
      // rodando pra sempre escrevendo em elementos que não existem mais.
      if (!alvos.length) {
        stopElapsedTimer();
        return;
      }
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const texto =
        s < 60
          ? `há ${s}s`
          : `há ${Math.floor(s / 60)}min ${String(s % 60).padStart(2, "0")}s`;
      alvos.forEach((el) => { el.textContent = texto; });
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function hideLoadingNotice() {
    // Parar o timer junto é obrigatório: o aviso some, mas um setInterval esquecido
    // continuaria rodando a cada segundo pelo resto da sessão.
    stopElapsedTimer();
    loadingNotice.classList.add("hidden");
    loadingNotice.innerHTML = "";
  }

  async function fetchRuntimeStatus() {
    try {
      const res = await fetch("/models/runtime-status");
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  // Enquanto o modelo carrega, o polling mantém o aviso vivo e o remove sozinho quando
  // fica pronto. Intervalo de 3s (não 1s): carregar leva minutos, checar mais rápido só
  // gastaria requisição sem mudar nada na tela.
  function startRuntimePolling() {
    if (runtimePoll) return;
    runtimePoll = setInterval(async () => {
      const status = await fetchRuntimeStatus();
      if (!status) return;
      renderRuntimePanel(status);
      if (status.model_loaded) {
        stopRuntimePolling();
        hideLoadingNotice();
        setRuntimeLoading(false);
      }
    }, 3000);
  }

  function stopRuntimePolling() {
    if (runtimePoll) {
      clearInterval(runtimePoll);
      runtimePoll = null;
    }
  }

  // Chamado ANTES de enviar a mensagem. Não bloqueia o envio — só avisa. O usuário pode
  // perfeitamente mandar a pergunta e esperar; o que não pode é achar que quebrou.
  async function noticeIfModelCold() {
    const status = await fetchRuntimeStatus();
    if (!status) return;

    if (!status.ollama_running) {
      showLoadingNotice(
        '<strong>O Ollama não está rodando.</strong> ' +
          "O Ambar precisa dele para pensar. Abra o Ollama (ou reinicie o computador) e tente de novo. " +
          'Veja o passo a passo em <em>Primeiros passos</em>, na barra lateral.'
      );
      return;
    }

    if (!status.model_loaded) {
      showLoadingNoticeWithBar(
        '<strong>Carregando o modelo na memória…</strong> ' +
          "Isso acontece na primeira pergunta depois de abrir o Ambar e pode levar alguns minutos. " +
          "As próximas respostas são bem mais rápidas. Pode aguardar — não travou."
      );
      startRuntimePolling();
    }
  }

  function renderRuntimePanel(status) {
    if (!runtimeState) return;
    if (!status.ollama_running) {
      runtimeState.textContent = "Ollama não está rodando";
      runtimeState.className = "runtime-state bad";
    } else if (status.preloading) {
      runtimeState.textContent = "Carregando o modelo…";
      runtimeState.className = "runtime-state warn";
    } else if (status.model_loaded) {
      runtimeState.textContent = "Modelo pronto — respostas rápidas";
      runtimeState.className = "runtime-state good";
    } else {
      runtimeState.textContent = "Modelo não carregado — a primeira pergunta será lenta";
      runtimeState.className = "runtime-state warn";
    }
    if (preloadNowBtn) {
      preloadNowBtn.disabled = !status.ollama_running || status.model_loaded || status.preloading;
    }
    // Barra + contador enquanto carrega. Ligado ao ESTADO, não ao clique: se o
    // carregamento já estiver em curso (preload do boot, ou uma pergunta no chat), abrir
    // esta tela mostra o indicador do mesmo jeito.
    //
    // O `|| preloadPedido` cobre a janela entre o clique e o servidor passar a reportar
    // `preloading: true`: nesse intervalo o status ainda diz `false`, e sem isso este
    // render apagaria o indicador que o clique acabou de acender (bug real, pego
    // amostrando a visibilidade a cada 30ms depois do clique).
    setRuntimeLoading(!!status.preloading || preloadPedido);
    if (status.preloading || status.model_loaded) preloadPedido = false;
  }

  // Espelha no painel de Modelos o mesmo par barra + tempo do aviso do chat. O timer é
  // compartilhado (um só setInterval atualiza os dois), então ligar aqui enquanto o chat
  // já conta não reinicia a contagem de quem estava esperando.
  function setRuntimeLoading(carregando) {
    const box = el("runtime-loading");
    if (!box) return;
    const jaVisivel = !box.classList.contains("hidden");
    box.classList.toggle("hidden", !carregando);
    if (carregando && !jaVisivel && !elapsedTimer) startElapsedTimer();
    if (!carregando && !loadingNoticeVisivel()) stopElapsedTimer();
  }

  function loadingNoticeVisivel() {
    return loadingNotice && !loadingNotice.classList.contains("hidden");
  }

  async function refreshRuntime() {
    try {
      const prefsRes = await fetch("/models/preferences");
      const prefs = await prefsRes.json();

      keepAliveSelect.innerHTML = "";
      Object.entries(prefs.keep_alive_choices || {}).forEach(([value, label]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        keepAliveSelect.appendChild(opt);
      });
      keepAliveSelect.value = prefs.keep_alive;
      preloadCheck.checked = !!prefs.preload_model;
    } catch (err) {
      /* preferências indisponíveis não podem quebrar a tela toda */
    }

    const status = await fetchRuntimeStatus();
    if (status) renderRuntimePanel(status);
  }

  async function saveRuntimePrefs(patch) {
    await fetch("/models/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

  if (keepAliveSelect) {
    keepAliveSelect.addEventListener("change", () =>
      saveRuntimePrefs({ keep_alive: keepAliveSelect.value })
    );
  }

  if (preloadCheck) {
    preloadCheck.addEventListener("change", () =>
      saveRuntimePrefs({ preload_model: preloadCheck.checked })
    );
  }

  if (preloadNowBtn) {
    preloadNowBtn.addEventListener("click", async () => {
      preloadNowBtn.disabled = true;
      preloadPedido = true;
      setRuntimeLoading(true);
      await fetch("/models/preload", { method: "POST" });
      await refreshRuntime();
      startRuntimePolling();
    });
  }

  }

  /* ---------- Primeiros passos (instalação do Ollama) ---------- */

  // O badge na sidebar acende quando falta algo pra usar o Ambar (Ollama parado ou nenhum
  // modelo instalado). É o que leva um cliente novo até o tutorial sem precisar procurar:
  // sem isso, a tela de chat só ficaria dando erro sem dizer o que fazer.
  async function refreshSetupStatus() {
    const setupStatus = el("setup-status");
    const setupBadge = el("setup-badge");
    const status = await fetchRuntimeStatus();

    let models = [];
    if (status && status.ollama_running) {
      try {
        const res = await fetch("/models");
        models = (await res.json()).models || [];
      } catch (err) {
        /* lista indisponível: tratada como "nenhum modelo" abaixo */
      }
    }
    // Modelos de embedding não servem pra conversar (ver MODEL_CATEGORIES).
    const usable = models.filter((m) => (m.category || "text") !== "embedding");

    let text, cls, needsAttention;
    if (!status || !status.ollama_running) {
      text = "O Ollama não está rodando. Siga o passo 1 abaixo.";
      cls = "setup-status bad";
      needsAttention = true;
    } else if (usable.length === 0) {
      text = "Ollama instalado, mas nenhum modelo de conversa foi baixado. Siga o passo 2.";
      cls = "setup-status bad";
      needsAttention = true;
    } else {
      text = `Tudo pronto: Ollama rodando e ${usable.length} modelo(s) disponível(is).`;
      cls = "setup-status good";
      needsAttention = false;
    }

    if (setupStatus) {
      setupStatus.textContent = text;
      setupStatus.className = cls;
    }
    if (setupBadge) setupBadge.classList.toggle("hidden", !needsAttention);
  }

  /* ---------- Modelos de IA (lista real dos modelos instalados no Ollama) ---------- */

  async function refreshModels() {
    const res = await fetch("/models");
    const data = await res.json();
    state.models = data.models || [];
    state.selectedModel = data.selected || "";
    renderModels();
  }

  async function selectModel(name) {
    if (name === state.selectedModel) return;
    await fetch("/models/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    await refreshModels();
  }

  async function deleteModel(name) {
    await fetch(`/models/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.confirmDeleteModel = null;
    await refreshModels();
  }

  // Ordem de exibição e rótulos das categorias — "text"/"vision" são selecionáveis
  // como modelo de conversa; "embedding" só é usado internamente pela busca semântica
  // da base de conhecimento (agent/knowledge.py), não serve pra conversar.
  const MODEL_CATEGORIES = [
    { key: "text", label: "Texto", desc: "Conversa e código — selecione um para usar no chat." },
    { key: "vision", label: "Visão", desc: "Além de texto, também interpretam imagens anexadas no chat." },
    { key: "embedding", label: "Embedding (busca semântica)", desc: "Usados só internamente pela base de conhecimento, para achar itens relevantes — não servem para conversar." },
  ];

  function renderModels() {
    modelsList.innerHTML = "";

    if (state.models.length === 0) {
      const empty = document.createElement("span");
      empty.className = "empty-msg";
      empty.textContent = "Não foi possível listar os modelos — verifique se o Ollama está rodando.";
      modelsList.appendChild(empty);
      return;
    }

    MODEL_CATEGORIES.forEach(({ key, label, desc }) => {
      const models = state.models.filter((m) => (m.category || "text") === key);
      if (models.length === 0) return;

      const groupTitle = document.createElement("h3");
      groupTitle.className = "model-group-title";
      groupTitle.textContent = label;
      modelsList.appendChild(groupTitle);

      const groupDesc = document.createElement("p");
      groupDesc.className = "model-group-desc";
      groupDesc.textContent = desc;
      modelsList.appendChild(groupDesc);

      const isSelectable = key !== "embedding";

      models.forEach((model) => {
        const card = document.createElement("div");
        const selected = model.name === state.selectedModel;
        card.className = "card model-card" + (selected ? " selected" : "") + (isSelectable ? "" : " model-card-static");
        if (isSelectable) {
          card.addEventListener("click", () => selectModel(model.name));
        }

        const info = document.createElement("div");
        info.className = "model-info";
        const name = document.createElement("span");
        name.className = "card-name";
        name.textContent = model.name;
        const modelDesc = document.createElement("span");
        modelDesc.className = "card-desc";
        const details = [model.parameter_size, model.quantization].filter(Boolean).join(" · ");
        modelDesc.textContent = details || "Modelo instalado no Ollama local.";
        info.appendChild(name);
        info.appendChild(modelDesc);
        card.appendChild(info);

        const actions = document.createElement("div");
        actions.className = "card-actions";

        if (state.confirmDeleteModel === model.name) {
          const label = document.createElement("span");
          label.className = "card-confirm-label";
          label.textContent = "Remover?";
          actions.appendChild(label);

          const confirmBtn = document.createElement("button");
          confirmBtn.className = "card-confirm-btn";
          confirmBtn.setAttribute("aria-label", "Confirmar remoção");
          confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
          confirmBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await deleteModel(model.name);
          });

          const cancelBtn = document.createElement("button");
          cancelBtn.className = "card-cancel-btn";
          cancelBtn.setAttribute("aria-label", "Cancelar");
          cancelBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
          cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.confirmDeleteModel = null;
            renderModels();
          });

          actions.appendChild(confirmBtn);
          actions.appendChild(cancelBtn);
        } else {
          const deleteBtn = document.createElement("button");
          deleteBtn.className = "card-icon-btn danger";
          deleteBtn.setAttribute("aria-label", "Remover modelo");
          deleteBtn.title = "Remover modelo do disco";
          deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.confirmDeleteModel = model.name;
            renderModels();
          });
          actions.appendChild(deleteBtn);
        }

        card.appendChild(actions);

        modelsList.appendChild(card);
      });
    });
  }

  /* ---------- Perfil (persistido em data/profile.json — sem autenticação, app é local/single-user) ---------- */

  async function refreshProfile() {
    const res = await fetch("/profile");
    const data = await res.json();
    state.profileName = data.name || "Você";
    renderProfile();
  }

  function profileInitials() {
    return state.profileName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  }

  function renderProfile() {
    profileAvatar.textContent = profileInitials();
    profileDisplayName.textContent = state.profileName;
    profileBtnName.textContent = state.profileName;

    profileViewMode.classList.toggle("hidden", state.editingProfile);
    profileEditMode.classList.toggle("hidden", !state.editingProfile);
    profileNameInput.value = state.profileNameDraft;

    profileEditBtn.classList.toggle("hidden", state.editingProfile);
    profileSaveBtn.classList.toggle("hidden", !state.editingProfile);
  }

  profileEditBtn.addEventListener("click", () => {
    state.editingProfile = true;
    state.profileNameDraft = state.profileName;
    renderProfile();
    profileNameInput.focus();
    profileNameInput.select();
  });
  profileNameInput.addEventListener("input", (e) => { state.profileNameDraft = e.target.value; });
  // Enter salva — o campo é único, então abrir mão do mouse aqui é gratuito.
  profileNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveProfileName();
  });
  profileSaveBtn.addEventListener("click", saveProfileName);

  async function saveProfileName() {
    const res = await fetch("/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.profileNameDraft.trim() || state.profileName,
      }),
    });
    const data = await res.json();
    state.profileName = data.name;
    state.editingProfile = false;
    renderProfile();
  }

  /* ======================================================================
   * Fechamento de dropdowns ao clicar fora
   * ==================================================================== */

  window.addEventListener("click", () => {
    themeMenu.classList.add("hidden");
    profileMenu.classList.add("hidden");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      themeMenu.classList.add("hidden");
      profileMenu.classList.add("hidden");
      state.renamingChatId = null;
      state.confirmDeleteProject = null;
      state.confirmDeleteLibrary = null;
      renderAll();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      state.sidebarExpanded = true;
      renderSidebar();
      sidebarSearchInput.focus();
    }
  });

  /* ======================================================================
   * Render geral
   * ==================================================================== */

  function renderAll() {
    renderWindowState();
    renderSidebar();
    renderChatLists();
    renderViews();
    renderOrb();
    renderProjects();
    renderLibrary();
    renderKnowledge();
    renderModels();
    renderTasks();
    renderStandingOrders();
    renderProfile();
    persist();
  }

  /* ======================================================================
   * Boot
   * ==================================================================== */

  async function boot() {
    loadPersisted();
    applyTheme();
    OrbRenderer.refreshColors(); // garante a cor certa se o tema persistido não era o default (dark)
    renderAll();
    refreshMemory();
    refreshPreviewStatus();
    refreshProjects();
    refreshLibrary();
    refreshKnowledge();
    refreshModels();
    refreshProfile();
    refreshAutomationBadge();
    refreshRuntime();
    // Checa o setup no boot pra acender o badge da sidebar já na abertura, mesmo que o
    // usuário nunca entre na view — é assim que quem acabou de instalar descobre que
    // falta o Ollama, em vez de só ver o chat falhando.
    refreshSetupStatus();
    setInterval(refreshPreviewStatus, 4000);
    setInterval(refreshAutomationBadge, 4000);
    // Bem mais espaçado que os outros (60s): instalar Ollama/baixar modelo é raro, e o
    // badge não precisa reagir em segundos.
    setInterval(refreshSetupStatus, 60000);

    const res = await fetch("/conversations");
    const data = await res.json();
    state.chats = data.conversations || [];

    if (data.active_id) {
      const activateRes = await fetch(`/conversations/${data.active_id}/activate`, { method: "POST" });
      if (activateRes.ok) {
        const conv = await activateRes.json();
        state.activeChatId = conv.id;
        const msgs = (conv.messages || []).filter(
          (m) => m.role === "user" || m.role === "assistant"
        );
        msgs.forEach((m) => {
          const text = m.role === "assistant" ? stripAgentTags(m.content) || m.content : m.content;
          addMessage(m.role === "assistant" ? "assistant" : "user", text, m.images);
        });
        suggestionsEl.classList.toggle("hidden", msgs.length !== 0);
      }
    }
    renderChatLists();
  }

  boot();
})();