(function () {
  "use strict";

  const root = document.documentElement;
  const desktop = document.getElementById("desktop");

  const STORAGE_KEY = "agente-ui-state-v1";

  /* ======================================================================
   * Estado (equivalente ao this.state do mockup original)
   * ==================================================================== */

  const CONVERSATIONS = {
    r0: [
      { isAi: false, text: "Quais foram os principais pontos de dor dos usuários no onboarding?" },
      { isAi: true, text: "Encontrei três padrões recorrentes: confusão na etapa de verificação, falta de contexto sobre os próximos passos e um formulário inicial longo demais. Posso detalhar cada um com trechos das entrevistas." }
    ],
    r1: [
      { isAi: false, text: "Quais métricas mostraram maior queda na ativação?" },
      { isAi: true, text: "A maior queda foi na conclusão do checklist inicial (-18%) e no retorno em 7 dias (-12%). O ponto de abandono mais comum acontece logo após o cadastro." }
    ],
    r2: [
      { isAi: false, text: "Pode resumir as principais dores relatadas pelos usuários?" },
      { isAi: true, text: "Os temas mais citados foram: falta de clareza sobre o preço, dificuldade em encontrar suporte e demora no carregamento em telas específicas." }
    ],
    y0: [
      { isAi: false, text: "Como está o andamento da auditoria do roadmap?" },
      { isAi: true, text: "Concluí 70% da auditoria. Até agora, 3 itens estão sem dono definido e 2 dependem de uma decisão de negócio pendente." }
    ],
    y1: [
      { isAi: false, text: "Quantos bugs críticos estão em aberto?" },
      { isAi: true, text: "4 bugs críticos, sendo 2 relacionados a pagamentos e 2 a sincronização de dados offline." }
    ],
    y2: [
      { isAi: false, text: "O que a concorrência está fazendo de diferente?" },
      { isAi: true, text: "Dois concorrentes lançaram automações via IA no último trimestre; nenhum deles ainda oferece integração nativa com planilhas." }
    ],
    y3: [
      { isAi: false, text: "Quais features devemos priorizar no próximo ciclo?" },
      { isAi: true, text: "Com base no impacto e esforço estimado, sugiro priorizar exportação de relatórios e notificações em tempo real." }
    ],
    y4: [
      { isAi: false, text: "Pode gerar as notas de handoff para o time de suporte?" },
      { isAi: true, text: "Prontas. Incluí os principais fluxos, riscos conhecidos e contatos responsáveis por cada área." }
    ],
    y5: [
      { isAi: false, text: "Faz um levantamento dos custos de infraestrutura do último mês." },
      { isAi: true, text: "Levantamento pronto: o maior custo foi armazenamento (+22% vs. mês anterior), seguido de banda de rede. Posso detalhar por serviço." }
    ],
    y6: [
      { isAi: false, text: "Resuma o planejamento do trimestre passado." },
      { isAi: true, text: "O foco foi estabilização da base e redução de bugs críticos. As metas de performance foram parcialmente atingidas — 2 de 3 indicadores no alvo." }
    ],
    p1: [
      { isAi: false, text: "Inicie uma pesquisa e análise sobre retenção de usuários." },
      { isAi: true, text: "Analisando os dados de retenção das últimas 8 semanas. Identifiquei queda concentrada no dia 3 após o cadastro — posso aprofundar por segmento de usuário." }
    ],
    p2: [
      { isAi: false, text: "Busque na web tendências recentes sobre onboarding de produtos de IA." },
      { isAi: true, text: "Encontrei referências recentes indicando preferência por onboarding conversacional em vez de formulários longos, com ganhos relatados de ativação." }
    ],
    p3: [
      { isAi: false, text: "O que temos na base de conhecimento sobre o fluxo de checkout?" },
      { isAi: true, text: "Temos 6 documentos indexados sobre checkout, incluindo o guia de erros comuns e o mapeamento das etapas de pagamento." }
    ]
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const ALL_CHATS = [
    { id: "r0", title: "Revisão do fluxo de onboarding", ts: now - 2 * 60 * 60 * 1000 },
    { id: "r1", title: "Detalhamento das métricas de ativação", ts: now - 5 * 60 * 60 * 1000 },
    { id: "r2", title: "Resumo das dores dos usuários", ts: now - 8 * 60 * 60 * 1000 },
    { id: "y0", title: "Auditoria do roadmap", ts: now - 1 * DAY_MS },
    { id: "y1", title: "Triagem de bugs", ts: now - 1 * DAY_MS - 3 * 60 * 60 * 1000 },
    { id: "y2", title: "Análise competitiva", ts: now - 1 * DAY_MS - 6 * 60 * 60 * 1000 },
    { id: "y3", title: "Priorização de features", ts: now - 4 * DAY_MS },
    { id: "y4", title: "Notas de handoff", ts: now - 6 * DAY_MS },
    { id: "y5", title: "Levantamento de custos de infraestrutura", ts: now - 18 * DAY_MS },
    { id: "y6", title: "Planejamento do trimestre passado", ts: now - 40 * DAY_MS }
  ];

  function startOfDay(timestamp) {
    const d = new Date(timestamp);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupChatsByDate(chats) {
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
      if (chat.ts >= todayStart) groups[0].items.push(chat);
      else if (chat.ts >= yesterdayStart) groups[1].items.push(chat);
      else if (chat.ts >= last7Start) groups[2].items.push(chat);
      else groups[3].items.push(chat);
    });

    return groups.filter((g) => g.items.length > 0);
  }

  const PREVIEW_ENVS = [
    { name: "Produção", status: "Online", ok: true },
    { name: "Staging", status: "Online", ok: true },
    { name: "QA", status: "Em manutenção", ok: false }
  ];

  const AI_MODELS = [
    { name: "Agente Standard", desc: "Respostas rápidas para uso geral." },
    { name: "Agente Pro", desc: "Raciocínio mais profundo, indicado para análises complexas." },
    { name: "Agente Vision", desc: "Interpretação de imagens e documentos visuais." }
  ];

  const ORB_LABELS = { idle: "Pronta para ajudar", thinking: "Pesquisando...", speaking: "Respondendo..." };

  const state = {
    theme: "dark",
    sidebarExpanded: true,
    activeView: "chat",
    activeChatId: "r0",
    orbState: "idle",
    listening: false,
    loggedOut: false,
    deletedChatIds: [],
    confirmDeleteChatId: null,
    selectMode: false,
    selectedChatIds: [],
    confirmBulkDelete: false,
    sidebarSearch: "",
    selectedModel: "Agente Standard",
    previewToast: "",
    pinnedChatIds: [],
    chatTitleOverrides: {},
    renamingChatId: null,
    renameDraft: "",
    confirmDeleteProject: null,
    confirmDeleteLibrary: null,
    profileName: "Maria Costa",
    editingProfile: false,
    profileNameDraft: "",
    profileEmailDraft: "",
    confirmDeleteAccount: false,
    library: [
      { name: "Resumo de entrevistas", desc: "Prompt salvo — síntese de pesquisas qualitativas." },
      { name: "Análise competitiva", desc: "Prompt salvo — comparação estruturada de concorrentes." },
      { name: "Guia de tom de voz", desc: "Documento salvo — diretrizes de escrita do Agente." }
    ],
    projects: [
      { name: "Redesign do Onboarding", desc: "Simplificação do fluxo inicial de cadastro.", updated: "Atualizado há 2h" },
      { name: "Pesquisa de Usuários Q3", desc: "Entrevistas e síntese de dores por segmento.", updated: "Atualizado ontem" },
      { name: "Plano de Lançamento", desc: "Checklist e cronograma do próximo release.", updated: "Atualizado há 3 dias" }
    ],
    messages: CONVERSATIONS.r0.slice()
  };

  /* ======================================================================
   * Persistência (localStorage)
   * ==================================================================== */

  function loadPersisted() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (saved.theme) state.theme = saved.theme;
        if (typeof saved.sidebarExpanded === "boolean") state.sidebarExpanded = saved.sidebarExpanded;
        if (saved.activeView) state.activeView = saved.activeView;
        if ("activeChatId" in saved) state.activeChatId = saved.activeChatId;
        if (Array.isArray(saved.messages)) state.messages = saved.messages;
        if (Array.isArray(saved.projects)) state.projects = saved.projects;
        if (Array.isArray(saved.library)) state.library = saved.library;
        if (saved.selectedModel) state.selectedModel = saved.selectedModel;
      }
    } catch (e) { /* ignore */ }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        theme: state.theme,
        sidebarExpanded: state.sidebarExpanded,
        activeView: state.activeView,
        activeChatId: state.activeChatId,
        messages: state.messages,
        projects: state.projects,
        library: state.library,
        selectedModel: state.selectedModel
      }));
    } catch (e) { /* ignore */ }
  }

  /* ======================================================================
   * Referências de DOM
   * ==================================================================== */

  const el = (id) => document.getElementById(id);

  const loggedOutScreen = el("logged-out-screen");
  const sessionEl = el("session");
  const relogInBtn = el("relogin-btn");

  const themeToggle = el("theme-toggle");
  const themeMenu = el("theme-menu");

  const sidebarEl = el("sidebar");
  const sidebarToggle = el("sidebar-toggle");
  const sidebarSearchInput = el("sidebar-search");
  const newChatBtn = el("new-chat-btn");
  const profileBtn = el("profile-btn");
  const profileMenu = el("profile-menu");
  const profileMenuOpenBtn = el("profile-menu-open");
  const profileMenuLogoutBtn = el("profile-menu-logout");
  const profileBtnName = el("profile-btn-name");

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
    preview: el("view-preview"),
    models: el("view-models"),
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
  const micBtn = el("mic-btn");

  const projectsList = el("projects-list");
  const projectsEmpty = el("projects-empty");
  const libraryList = el("library-list");
  const libraryEmpty = el("library-empty");
  const previewList = el("preview-list");
  const previewToastEl = el("preview-toast");
  const modelsList = el("models-list");

  const profileDisplayName = el("profile-display-name");
  const profileDisplayEmail = el("profile-display-email");
  const profileViewMode = el("profile-view-mode");
  const profileEditMode = el("profile-edit-mode");
  const profileNameInput = el("profile-name-input");
  const profileEmailInput = el("profile-email-input");
  const profileAvatar = el("profile-avatar");
  const profileEditBtn = el("profile-edit-btn");
  const profileSaveBtn = el("profile-save-btn");
  const profileDeleteBtn = el("profile-delete-btn");
  const profileDeleteConfirmLabel = el("profile-delete-confirm-label");
  const profileDeleteConfirmBtn = el("profile-delete-confirm-btn");
  const profileDeleteCancelBtn = el("profile-delete-cancel-btn");
  const profileLogoutBtn = el("profile-logout-btn");

  /* ======================================================================
   * Orb: 72 barras giratórias
   * ==================================================================== */

  function buildOrbBars() {
    const count = 72;
    statusOrb.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const angle = (360 / count) * i;
      const delay = (((i * 37) % count) / count);
      const outer = document.createElement("div");
      outer.className = "orb-bar-outer";
      outer.style.transform = `rotate(${angle}deg)`;
      const inner = document.createElement("div");
      inner.className = "orb-bar-inner";
      inner.dataset.delayRatio = String(delay);
      outer.appendChild(inner);
      statusOrb.appendChild(outer);
    }
  }
  buildOrbBars();

  function applyOrbAnimationDelays() {
    const duration = state.orbState === "idle" ? 2.6 : state.orbState === "thinking" ? 0.85 : 1.05;
    const bars = statusOrb.querySelectorAll(".orb-bar-inner");
    bars.forEach((bar) => {
      const ratio = parseFloat(bar.dataset.delayRatio || "0");
      bar.style.animationDelay = `${(ratio * duration).toFixed(3)}s`;
    });
  }

  function renderOrb() {
    statusOrb.classList.remove("idle", "thinking", "speaking");
    statusOrb.classList.add(state.orbState);
    orbWrap.classList.remove("thinking", "speaking");
    if (state.orbState === "thinking") orbWrap.classList.add("thinking");
    if (state.orbState === "speaking") orbWrap.classList.add("speaking");
    orbLabel.textContent = ORB_LABELS[state.orbState];
    orbThinkingIcon.classList.toggle("hidden", state.orbState !== "thinking");
    applyOrbAnimationDelays();
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
   * Logout
   * ==================================================================== */

  function renderWindowState() {
    loggedOutScreen.classList.toggle("hidden", !state.loggedOut);
    sessionEl.classList.toggle("hidden", state.loggedOut);
  }

  relogInBtn.addEventListener("click", () => { state.loggedOut = false; state.activeView = "chat"; renderAll(); });

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
  sidebarSearchInput.addEventListener("input", (e) => {
    state.sidebarSearch = e.target.value;
    renderChatLists();
  });

  newChatBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.messages = [];
    state.activeChatId = null;
    state.activeView = "chat";
    state.orbState = "idle";
    chatInput.value = "";
    renderAll();
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
  profileMenuLogoutBtn.addEventListener("click", () => {
    state.loggedOut = true;
    profileMenu.classList.add("hidden");
    renderAll();
  });

  document.querySelectorAll(".nav-view").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      state.activeView = item.dataset.view;
      renderAll();
    });
  });

  el("nav-home").addEventListener("click", (e) => {
    e.stopPropagation();
    state.activeView = "chat";
    state.activeChatId = null;
    state.messages = [];
    state.orbState = "idle";
    renderAll();
  });

  function loadConversation(id) {
    const conv = CONVERSATIONS[id];
    state.messages = conv ? conv.slice() : [];
    state.activeChatId = id;
    state.activeView = "chat";
    state.orbState = "idle";
    renderAll();
  }

  el("pin-pesquisa").addEventListener("click", (e) => { e.stopPropagation(); loadConversation("p1"); });
  el("pin-busca").addEventListener("click", (e) => { e.stopPropagation(); loadConversation("p2"); });
  el("pin-base").addEventListener("click", (e) => { e.stopPropagation(); loadConversation("p3"); });

  /* ---------- Listas de conversas (recentes / ontem) ---------- */

  function chatTitle(c) {
    return state.chatTitleOverrides[c.id] || c.title;
  }

  function matchesSearch(title) {
    const q = (state.sidebarSearch || "").trim().toLowerCase();
    return !q || title.toLowerCase().includes(q);
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
      input.autofocus = true;
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
      confirmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.deletedChatIds.push(chat.id);
        state.pinnedChatIds = state.pinnedChatIds.filter((x) => x !== chat.id);
        state.confirmDeleteChatId = null;
        if (state.activeChatId === chat.id) {
          state.activeChatId = null;
          state.messages = [];
          state.orbState = "idle";
        }
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

      const pinned = state.pinnedChatIds.includes(chat.id);
      const pinBtn = document.createElement("button");
      pinBtn.className = "chat-row-action-btn" + (pinned ? " pinned" : "");
      pinBtn.setAttribute("aria-label", "Fixar conversa");
      pinBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 2l1.5 5.5L19 9l-4 4 1 6-4-3-4 3 1-6-4-4 5.5-1.5z"/></svg>';
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.pinnedChatIds.includes(chat.id)) {
          state.pinnedChatIds = state.pinnedChatIds.filter((x) => x !== chat.id);
        } else {
          state.pinnedChatIds.push(chat.id);
        }
        renderChatLists();
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

  function commitRename() {
    if (state.renamingChatId) {
      state.chatTitleOverrides[state.renamingChatId] = state.renameDraft || "";
      state.renamingChatId = null;
      renderChatLists();
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

  bulkDeleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.selectedChatIds.length === 0) return;
    state.deletedChatIds.push(...state.selectedChatIds);
    state.pinnedChatIds = state.pinnedChatIds.filter((x) => !state.selectedChatIds.includes(x));
    if (state.selectedChatIds.includes(state.activeChatId)) {
      state.activeChatId = null;
      state.messages = [];
      state.orbState = "idle";
    }
    state.selectMode = false;
    state.selectedChatIds = [];
    renderAll();
  });

  function renderChatLists() {
    const visible = ALL_CHATS.filter((c) => !state.deletedChatIds.includes(c.id) && matchesSearch(chatTitle(c)));
    const groups = groupChatsByDate(visible);

    historyGroups.innerHTML = "";
    groups.forEach((group) => {
      const header = document.createElement("div");
      header.className = "side-section-label history-group-label";
      header.textContent = group.label;
      historyGroups.appendChild(header);

      const list = document.createElement("div");
      group.items
        .slice()
        .sort((a, b) => b.ts - a.ts)
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

  /* ======================================================================
   * Views (equivalente ao activeView)
   * ==================================================================== */

  function renderViews() {
    Object.keys(views).forEach((key) => {
      views[key].classList.toggle("hidden", state.activeView !== key);
    });
    document.querySelectorAll(".nav-view").forEach((item) => {
      item.classList.toggle("active", item.dataset.view === state.activeView);
    });
    el("pin-pesquisa").classList.toggle("active", state.activeChatId === "p1");
    el("pin-busca").classList.toggle("active", state.activeChatId === "p2");
    el("pin-base").classList.toggle("active", state.activeChatId === "p3");
  }

  /* ---------- Chat ---------- */

  function agentAvatarSvg() {
    return '<svg viewBox="0 0 24 24"><path d="M12 8V3M14 8.53L16.5 4.21M15.46 10L19.79 7.5M16 12H21M15.46 14L19.79 16.5M14 15.46L16.5 19.79M12 16V21M10 15.46L7.5 19.79M8.54 14L4.21 16.5M8 12H3M8.54 10L4.21 7.5M10 8.54L7.5 4.21"/></svg>';
  }

  function renderMessages() {
    chatEl.innerHTML = "";
    state.messages.forEach((msg) => {
      const row = document.createElement("div");
      row.className = "msg-row " + (msg.isAi ? "assistant" : "user");
      if (msg.isAi) {
        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.innerHTML = agentAvatarSvg();
        row.appendChild(avatar);
      }
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      bubble.textContent = msg.text;
      row.appendChild(bubble);
      chatEl.appendChild(row);
    });
    chatEl.scrollTop = chatEl.scrollHeight;
    suggestionsEl.classList.toggle("hidden", state.messages.length !== 0);
  }

  function generateReply(q) {
    const lower = q.toLowerCase();
    if (lower.includes("métrica") || lower.includes("metrica") || lower.includes("número") || lower.includes("numero")) {
      return "Analisando os números: os indicadores mais relevantes no período foram ativação (+/-12%), retenção em 7 dias e tempo médio até a primeira ação. Quer que eu detalhe algum desses?";
    }
    if (lower.includes("usuário") || lower.includes("usuario") || lower.includes("cliente")) {
      return "Do ponto de vista do usuário, os principais atritos aparecem logo no início da jornada. Recomendo simplificar as primeiras telas e reduzir campos obrigatórios.";
    }
    if (lower.includes("bug") || lower.includes("erro") || lower.includes("problema")) {
      return "Identifiquei o possível ponto de falha. Recomendo isolar o cenário, revisar os logs recentes e validar em ambiente de staging antes do deploy.";
    }
    if (lower.includes("projeto") || lower.includes("prazo") || lower.includes("cronograma")) {
      return "Com base no escopo atual, o cronograma parece viável se priorizarmos as tarefas críticas primeiro. Posso montar uma sugestão de ordem de execução.";
    }
    const openers = [
      "Pesquisei isso e aqui está um resumo:",
      "Encontrei algumas referências relevantes sobre isso.",
      "Boa pergunta — aqui vai o que descobri:"
    ];
    const opener = openers[q.length % openers.length];
    return `${opener} com base nos dados disponíveis, os fatores mais relevantes envolvem clareza de contexto, tempo de resposta e consistência entre as etapas do fluxo. Posso aprofundar em algum ponto específico.`;
  }

  let sendT1 = null, sendT2 = null;

  function onSend() {
    const text = chatInput.value.trim();
    if (!text) return;
    state.messages.push({ isAi: false, text });
    chatInput.value = "";
    state.orbState = "thinking";
    renderMessages();
    renderOrb();

    clearTimeout(sendT1);
    clearTimeout(sendT2);
    sendT1 = setTimeout(() => {
      state.messages.push({ isAi: true, text: generateReply(text) });
      state.orbState = "speaking";
      renderMessages();
      renderOrb();
      sendT2 = setTimeout(() => {
        state.orbState = "idle";
        renderOrb();
        persist();
      }, 2600);
    }, 1700);
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

  let micTimer = null;
  micBtn.addEventListener("click", () => {
    state.listening = !state.listening;
    micBtn.classList.toggle("listening", state.listening);
    if (state.listening) {
      state.orbState = "thinking";
      renderOrb();
      clearTimeout(micTimer);
      micTimer = setTimeout(() => {
        state.orbState = "idle";
        state.listening = false;
        micBtn.classList.remove("listening");
        renderOrb();
      }, 2400);
    } else {
      state.orbState = "idle";
      renderOrb();
    }
  });

  /* ---------- Projetos ---------- */

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

      if (state.confirmDeleteProject === project.name) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.projects = state.projects.filter((p) => p.name !== project.name);
          state.confirmDeleteProject = null;
          renderProjects();
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
        const editBtn = document.createElement("button");
        editBtn.className = "card-icon-btn";
        editBtn.setAttribute("aria-label", "Editar projeto");
        editBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.activeView = "chat";
          state.activeChatId = null;
          state.orbState = "idle";
          state.messages = [
            { isAi: false, text: `Quero continuar trabalhando no projeto "${project.name}".` },
            { isAi: true, text: `Claro! Aqui está o resumo do projeto: ${project.desc} (${project.updated}). O que você gostaria de ajustar ou aprofundar?` }
          ];
          renderAll();
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir projeto");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteProject = project.name;
          renderProjects();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = project.desc;
      card.appendChild(desc);

      const updated = document.createElement("span");
      updated.className = "card-updated";
      updated.textContent = project.updated;
      card.appendChild(updated);

      projectsList.appendChild(card);
    });
  }

  /* ---------- Biblioteca ---------- */

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

      if (state.confirmDeleteLibrary === item.name) {
        const label = document.createElement("span");
        label.className = "card-confirm-label";
        label.textContent = "Excluir?";
        actions.appendChild(label);

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "card-confirm-btn";
        confirmBtn.setAttribute("aria-label", "Confirmar exclusão");
        confirmBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        confirmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.library = state.library.filter((p) => p.name !== item.name);
          state.confirmDeleteLibrary = null;
          renderLibrary();
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
        const editBtn = document.createElement("button");
        editBtn.className = "card-icon-btn";
        editBtn.setAttribute("aria-label", "Editar item");
        editBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.activeView = "chat";
          state.activeChatId = null;
          state.orbState = "idle";
          state.messages = [
            { isAi: false, text: `Quero revisar o item salvo "${item.name}".` },
            { isAi: true, text: `Aqui está: ${item.desc} Deseja que eu atualize ou expanda esse conteúdo?` }
          ];
          renderAll();
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "card-icon-btn danger";
        deleteBtn.setAttribute("aria-label", "Excluir item");
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.6"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          state.confirmDeleteLibrary = item.name;
          renderLibrary();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
      }

      head.appendChild(actions);
      card.appendChild(head);

      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = item.desc;
      card.appendChild(desc);

      libraryList.appendChild(card);
    });
  }

  /* ---------- Servidor preview ---------- */

  let toastTimer = null;

  function openPreviewEnv(name) {
    window.open("https://preview.lia.app/" + encodeURIComponent(name.toLowerCase()), "_blank");
    state.previewToast = `Abrindo ambiente "${name}"...`;
    renderPreview();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.previewToast = "";
      renderPreview();
    }, 2200);
  }

  function renderPreview() {
    previewList.innerHTML = "";
    PREVIEW_ENVS.forEach((envItem) => {
      const card = document.createElement("div");
      card.className = "card preview-card";

      const dot = document.createElement("div");
      dot.className = "preview-dot";
      dot.style.background = envItem.ok ? "var(--success)" : "var(--warning)";
      card.appendChild(dot);

      const info = document.createElement("div");
      info.className = "preview-info";
      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = envItem.name;
      const status = document.createElement("span");
      status.className = "card-desc";
      status.textContent = envItem.status;
      info.appendChild(name);
      info.appendChild(status);
      card.appendChild(info);

      const openBtn = document.createElement("button");
      openBtn.className = "preview-open-btn";
      openBtn.textContent = "Abrir";
      openBtn.addEventListener("click", () => openPreviewEnv(envItem.name));
      card.appendChild(openBtn);

      previewList.appendChild(card);
    });

    previewToastEl.textContent = state.previewToast;
    previewToastEl.classList.toggle("hidden", !state.previewToast);
  }

  /* ---------- Modelos de IA ---------- */

  function renderModels() {
    modelsList.innerHTML = "";
    AI_MODELS.forEach((model) => {
      const card = document.createElement("div");
      const selected = model.name === state.selectedModel;
      card.className = "card model-card" + (selected ? " selected" : "");
      card.addEventListener("click", () => {
        state.selectedModel = model.name;
        persist();
        renderModels();
      });

      const info = document.createElement("div");
      info.className = "model-info";
      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = model.name;
      const desc = document.createElement("span");
      desc.className = "card-desc";
      desc.textContent = model.desc;
      info.appendChild(name);
      info.appendChild(desc);
      card.appendChild(info);

      if (selected) {
        const check = document.createElement("div");
        check.innerHTML = '<svg class="model-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        card.appendChild(check.firstChild);
      }

      modelsList.appendChild(card);
    });
  }

  /* ---------- Perfil ---------- */

  function profileInitials() {
    return state.profileName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  }

  function renderProfile() {
    profileAvatar.textContent = profileInitials();
    profileDisplayName.textContent = state.profileName;
    profileDisplayEmail.textContent = state.profileEmail;
    profileBtnName.textContent = state.profileName;

    profileViewMode.classList.toggle("hidden", state.editingProfile);
    profileEditMode.classList.toggle("hidden", !state.editingProfile);
    profileNameInput.value = state.profileNameDraft;
    profileEmailInput.value = state.profileEmailDraft;

    profileEditBtn.classList.toggle("hidden", state.editingProfile);
    profileSaveBtn.classList.toggle("hidden", !state.editingProfile);

    profileDeleteConfirmLabel.classList.toggle("hidden", !state.confirmDeleteAccount);
    profileDeleteConfirmBtn.classList.toggle("hidden", !state.confirmDeleteAccount);
    profileDeleteCancelBtn.classList.toggle("hidden", !state.confirmDeleteAccount);
    profileDeleteBtn.classList.toggle("hidden", state.confirmDeleteAccount);
  }

  profileEditBtn.addEventListener("click", () => {
    state.editingProfile = true;
    state.profileNameDraft = state.profileName;
    state.profileEmailDraft = state.profileEmail;
    renderProfile();
  });
  profileNameInput.addEventListener("input", (e) => { state.profileNameDraft = e.target.value; });
  profileEmailInput.addEventListener("input", (e) => { state.profileEmailDraft = e.target.value; });
  profileSaveBtn.addEventListener("click", () => {
    state.profileName = state.profileNameDraft.trim() || state.profileName;
    state.profileEmail = state.profileEmailDraft.trim() || state.profileEmail;
    state.editingProfile = false;
    renderProfile();
  });
  profileDeleteBtn.addEventListener("click", () => {
    state.confirmDeleteAccount = true;
    renderProfile();
  });
  profileDeleteCancelBtn.addEventListener("click", () => {
    state.confirmDeleteAccount = false;
    renderProfile();
  });
  profileDeleteConfirmBtn.addEventListener("click", () => {
    state.loggedOut = true;
    state.confirmDeleteAccount = false;
    state.activeView = "chat";
    state.editingProfile = false;
    renderAll();
  });
  profileLogoutBtn.addEventListener("click", () => {
    state.loggedOut = true;
    renderAll();
  });

  /* ======================================================================
   * Fechamento de dropdowns ao clicar fora
   * (bug a evitar: fechar antes de registrar o clique na opção — por isso
   * todo botão/opção que abre ou seleciona faz stopPropagation, e este
   * listener global só fecha o que ainda estiver aberto quando o clique
   * chegar até aqui sem ter sido interceptado.)
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
    renderMessages();
    renderOrb();
    renderProjects();
    renderLibrary();
    renderPreview();
    renderModels();
    renderProfile();
    persist();
  }

  /* ======================================================================
   * Boot
   * ==================================================================== */

  loadPersisted();
  applyTheme();
  renderAll();
})();