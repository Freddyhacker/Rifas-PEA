/**
 * GESTOR DE RIFAS PRO - FRONTEND SPA + PWA (v4.4)
 */

const DEFAULT_GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyv88F_YR8v1T5Fcjm9_DR-h-CvadL2G9v307yjwCo_lmB-ai7dNJZ8R84iGZQxgTkDNw/exec';
const SNAPSHOT_KEY = 'rifas_last_snapshot_v1';

const state = {
  endpoint: (localStorage.getItem('rifas_gas_url') || DEFAULT_GAS_ENDPOINT).trim(),
  token: localStorage.getItem('rifas_session_token') || '',
  user: null,
  activeRoleView: 'admin',
  config: null,
  tickets: [],
  users: [],
  history: [],
  backups: [],
  version: 0,
  currentFilter: 'all',
  searchQuery: '',
  syncTimer: null,
  deferredInstallPrompt: null,
  tempConfigImages: [],
  configDirty: false,
  seenWinnerKey: ''
};

document.addEventListener('DOMContentLoaded', () => {
  if (!DEFAULT_GAS_ENDPOINT.includes('REEMPLAZA_CON_TU_ID')) {
    state.endpoint = DEFAULT_GAS_ENDPOINT;
    localStorage.setItem('rifas_gas_url', DEFAULT_GAS_ENDPOINT);
  }

  const cfgForm = document.getElementById('configForm');
  if (cfgForm) {
    cfgForm.noValidate = true;
    cfgForm.querySelectorAll('[required]').forEach(el => el.removeAttribute('required'));
  }

  registerServiceWorker();
  bindEvents();
  updateOnlineStatus();

  if (state.token) {
    const loadedCache = loadLocalSnapshot();
    if (loadedCache) {
      syncActiveRoleView(true);
    }
    showAppShell();
    if (loadedCache) {
      applyVisualTheme();
      renderAll(true);
    }
    syncData(false);
  } else {
    showLoginView();
  }
});

function normalizeRoles(rawRole) {
  const valid = ['admin', 'vendedor'];
  const found = [];

  const pushRole = (val) => {
    const clean = String(val || '').trim().toLowerCase();
    if (valid.includes(clean) && !found.includes(clean)) {
      found.push(clean);
    }
  };

  if (Array.isArray(rawRole)) {
    rawRole.forEach(pushRole);
  } else if (typeof rawRole === 'string' && rawRole.trim()) {
    const trimmed = rawRole.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) parsed.forEach(pushRole);
      } catch (_) {
        trimmed.split(',').forEach(pushRole);
      }
    } else {
      trimmed.split(',').forEach(pushRole);
    }
  }

  return found.length ? found : ['vendedor'];
}

function hasRole(userObj, roleName) {
  if (!userObj) return false;
  return normalizeRoles(userObj.roles || userObj.role).includes(roleName);
}

function syncActiveRoleView(resetToDefault = false) {
  if (!state.user) return;
  const roles = normalizeRoles(state.user.roles || state.user.role);
  if (resetToDefault || !roles.includes(state.activeRoleView)) {
    state.activeRoleView = roles.includes('admin') ? 'admin' : 'vendedor';
  }
}

function isEffectiveAdmin() {
  return Boolean(state.user && hasRole(state.user, 'admin') && state.activeRoleView === 'admin');
}

function applyTopbarRoleStyle(isAdminView) {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  if (isAdminView) {
    topbar.style.background = 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)';
    topbar.style.borderBottomColor = '#f59e0b';
  } else {
    topbar.style.background = '#ffffff';
    topbar.style.borderBottomColor = '#e2e8f0';
  }
}

function formatTicketNum(num) {
  const n = Number(num);
  if (Number.isNaN(n)) return String(num);
  if (n === 1000) return '000';
  return String(Math.trunc(n)).padStart(3, '0');
}

function getTicketMultiplier(cfg = state.config) {
  if (!cfg) return 1;
  const n = Number(cfg.numbersPerTicket);
  if (!Number.isNaN(n) && n >= 1) return Math.floor(n);
  return cfg.doubleChance ? 2 : 1;
}

function getWinnerNumbersFormatted(winner) {
  if (!winner) return [];
  if (Array.isArray(winner.numerosParticipantes) && winner.numerosParticipantes.length > 0) {
    return winner.numerosParticipantes.map(n => `#${formatTicketNum(n)}`);
  }
  const ticket = state.tickets.find(
    t => Number(t.numero) === Number(winner.boletoPrincipal || winner.numero)
  );
  if (ticket) {
    const extras = Array.isArray(ticket.extraNumbers) ? ticket.extraNumbers : [];
    return [ticket.numero, ...extras].map(n => `#${formatTicketNum(n)}`);
  }
  return winner.numero !== undefined ? [`#${formatTicketNum(winner.numero)}`] : [];
}

function getRaffleProgressMetrics() {
  const total = state.tickets.length;
  const disp = state.tickets.filter(t => t.estado === 'disponible').length;
  const apar = state.tickets.filter(t => t.estado === 'apartado').length;
  const vend = state.tickets.filter(t => t.estado === 'vendido').length;
  const pctSold = total > 0 ? (vend / total) * 100 : 0;
  const pctOccupied = total > 0 ? Math.round(((vend + apar) / total) * 100) : 0;
  return { total, disp, apar, vend, pctSold, pctOccupied };
}

function buildExtraMap(totalTickets, multiplier) {
  const n = Number(totalTickets) || 0;
  const mult = Math.max(1, Math.floor(Number(multiplier) || 1));
  const extraCount = mult - 1;
  if (n <= 0 || extraCount <= 0) return {};

  const pool = [];
  for (let i = n + 1; i <= n + n * extraCount; i++) {
    pool.push(i);
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const map = {};
  let cursor = 0;
  for (let k = 1; k <= n; k++) {
    const chunk = [];
    for (let c = 0; c < extraCount; c++) {
      chunk.push(pool[cursor++]);
    }
    chunk.sort((a, b) => a - b);
    map[String(k)] = chunk;
  }
  return map;
}

function isExtraMapValid(map, totalTickets, multiplier) {
  const n = Number(totalTickets) || 0;
  const extraCount = Math.max(0, Math.floor(Number(multiplier) || 1) - 1);
  if (extraCount === 0) return true;
  if (!map || typeof map !== 'object') return false;

  const seen = new Set();
  for (let k = 1; k <= n; k++) {
    const arr = map[String(k)];
    if (!Array.isArray(arr) || arr.length !== extraCount) return false;
    for (let i = 0; i < arr.length; i++) {
      const val = Number(arr[i]);
      if (!val || val <= n || val > n + n * extraCount || seen.has(val)) {
        return false;
      }
      seen.add(val);
    }
  }
  return seen.size === n * extraCount;
}

function saveLocalSnapshot(payload) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      version: payload.version,
      config: payload.config,
      user: payload.user,
      tickets: payload.tickets,
      users: payload.users || state.users,
      history: payload.history || state.history,
      backups: payload.backups || state.backups
    }));
  } catch (_) {}
}

function loadLocalSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || !snap.config || !snap.user) return false;
    state.version = Number(snap.version || 0);
    state.config = snap.config;
    state.user = snap.user;
    state.tickets = Array.isArray(snap.tickets) ? snap.tickets : [];
    state.users = Array.isArray(snap.users) ? snap.users : [];
    state.history = Array.isArray(snap.history) ? snap.history : [];
    state.backups = Array.isArray(snap.backups) ? snap.backups : [];
    return true;
  } catch (_) {
    return false;
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
    }).catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    document.getElementById('btnInstallPwa').classList.remove('hidden');
  });
}

function updateOnlineStatus() {
  const banner = document.getElementById('offlineBanner');
  if (navigator.onLine) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

async function apiCall(action, data = {}) {
  if (!navigator.onLine) {
    throw new Error('Sin conexión a internet. Verifica tu red para continuar.');
  }
  const cleanUrl = (state.endpoint || '').trim();
  if (!cleanUrl || cleanUrl.includes('REEMPLAZA_CON_TU_ID')) {
    throw new Error('Falta configurar la URL de Google Apps Script en app.js.');
  }

  const payloadObj = {
    action: action,
    token: state.token,
    data: data
  };
  const payloadStr = JSON.stringify(payloadObj);

  let response;
  try {
    response = await fetch(cleanUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payloadStr
    });
  } catch (postErr) {
    const sep = cleanUrl.includes('?') ? '&' : '?';
    const getUrl = `${cleanUrl}${sep}payload=${encodeURIComponent(payloadStr)}`;
    try {
      response = await fetch(getUrl, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow'
      });
    } catch (getErr) {
      throw new Error('No se pudo conectar al servidor. Revisa que el script esté publicado para "Cualquier usuario".');
    }
  }

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (_) {
    throw new Error('El servidor devolvió una respuesta no válida (revisa permisos de ejecución del script).');
  }

  if (!result.ok) {
    if (result.code === 'UNAUTHORIZED') {
      forceLogout();
    }
    throw new Error(result.error || 'Error en la operación.');
  }
  return result;
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  btn.disabled = true;
  btn.textContent = 'Verificando...';

  try {
    const res = await apiCall('login', { username, password });
    state.token = res.token;
    state.user = res.user;
    syncActiveRoleView(true);
    localStorage.setItem('rifas_session_token', res.token);

    document.getElementById('loginForm').reset();
    showAppShell();
    await syncData(true);
    showToast('Bienvenido, ' + res.user.username, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Iniciar Sesión';
  }
}

async function handleLogoutClick() {
  try {
    if (state.token && navigator.onLine) {
      await apiCall('logout');
    }
  } catch (_) {}
  forceLogout();
}

function forceLogout() {
  stopAutoSync();
  state.token = '';
  state.user = null;
  state.activeRoleView = 'admin';
  state.version = 0;
  state.seenWinnerKey = '';
  localStorage.removeItem('rifas_session_token');
  localStorage.removeItem(SNAPSHOT_KEY);
  showLoginView();
}

function startAutoSync() {
  stopAutoSync();
  state.syncTimer = setInterval(() => {
    if (navigator.onLine && !document.hidden) {
      syncData(false);
    }
  }, 15000);
}

function stopAutoSync() {
  if (state.syncTimer) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
}

async function syncData(forceFull = false) {
  const indicator = document.getElementById('syncIndicator');
  indicator.textContent = '↻ Sincronizando...';
  indicator.classList.add('syncing');

  try {
    const res = await apiCall('sync', {
      clientVersion: forceFull ? 0 : state.version
    });

    if (!res.upToDate) {
      state.version = res.version;
      state.config = res.config || {};
      state.user = res.user;
      syncActiveRoleView(false);

      const mult = getTicketMultiplier(state.config);
      const total = Number(state.config.totalTickets || (res.tickets || []).length);
      let eMap = state.config.extraMap;
      if (mult > 1 && !isExtraMapValid(eMap, total, mult)) {
        eMap = buildExtraMap(total, mult);
        state.config.extraMap = eMap;
      }

      state.tickets = (res.tickets || [])
        .slice()
        .sort((a, b) => Number(a.numero) - Number(b.numero))
        .map(t => {
          const extras = mult > 1
            ? (Array.isArray(t.extraNumbers) && t.extraNumbers.length === mult - 1
              ? t.extraNumbers
              : (eMap && Array.isArray(eMap[String(t.numero)]) ? eMap[String(t.numero)] : []))
            : [];
          return {
            ...t,
            extraNumbers: extras,
            segundoNumero: extras.length ? extras[0] : null
          };
        });

      if (res.users) state.users = res.users;
      if (res.history) state.history = res.history;
      if (res.backups) state.backups = res.backups;

      saveLocalSnapshot(res);
      applyVisualTheme();
      renderAll(forceFull);
    }

    indicator.textContent = '● Sincronizado';
    indicator.classList.remove('syncing');
  } catch (err) {
    indicator.textContent = '⚠ Error red';
    if (forceFull && !state.tickets.length) showToast(err.message, 'error');
  }
}

function showLoginView() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}

function showAppShell() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  startAutoSync();
}

function applyVisualTheme() {
  const cfg = state.config;
  if (!cfg) return;

  const root = document.documentElement;
  root.style.setProperty('--cols-desktop', cfg.gridColsDesktop || 10);
  root.style.setProperty('--cols-mobile', cfg.gridColsMobile || 5);
  root.style.setProperty('--header-font', (cfg.headerFontSize || 26) + 'px');
  root.style.setProperty('--body-font', (cfg.bodyFontSize || 14) + 'px');

  const headerCard = document.getElementById('raffleHeaderCard');
  if (headerCard) {
    headerCard.style.paddingTop = (cfg.headerPadTop ?? 0) + 'px';
    headerCard.style.paddingBottom = (cfg.headerPadBottom ?? 0) + 'px';
    headerCard.style.paddingLeft = (cfg.headerPadLeft ?? 0) + 'px';
    headerCard.style.paddingRight = (cfg.headerPadRight ?? 0) + 'px';
  }
}

function switchToBoletosTab() {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const boletosBtn = document.querySelector('.nav-tab[data-tab="tabBoletos"]');
  if (boletosBtn) boletosBtn.classList.add('active');
  const boletosPanel = document.getElementById('tabBoletos');
  if (boletosPanel) boletosPanel.classList.remove('hidden');
}

function toggleAdminVendorRoleView() {
  if (!state.user) return;
  const canSwitch = hasRole(state.user, 'admin') && hasRole(state.user, 'vendedor');
  if (!canSwitch) return;

  state.activeRoleView = state.activeRoleView === 'admin' ? 'vendedor' : 'admin';
  if (state.activeRoleView === 'vendedor') {
    switchToBoletosTab();
  }
  renderAll(false);
}

function renderAll(forceFormRefresh = false) {
  if (!state.user || !state.config) return;

  const isRealAdmin = hasRole(state.user, 'admin');
  const showAdminUI = isEffectiveAdmin();
  const canSwitch = isRealAdmin && hasRole(state.user, 'vendedor');

  applyTopbarRoleStyle(showAdminUI);

  document.getElementById('topbarUser').textContent = state.user.username;
  const roleBtn = document.getElementById('topbarRole');
  roleBtn.textContent = showAdminUI ? 'Administrador' : 'Vendedor';
  roleBtn.style.cursor = canSwitch ? 'pointer' : 'default';

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !showAdminUI);
  });

  renderRaffleHeader();
  renderTicketsGrid();
  renderVendorWinnerView();

  if (isRealAdmin) {
    renderAdminTable();
    renderStats();
    renderUsersAndAssignments();
    if (!state.configDirty || forceFormRefresh) {
      populateConfigForm();
    }
    renderHistory();
    renderBackups();
    renderWinnerConditionInfo();
  }
}

function renderWinnerConditionInfo() {
  const el = document.getElementById('winnerConditionInfo');
  if (!el || !state.config) return;
  const reqPct = Number(state.config.minWinnerSoldPercent || 0);
  const { pctSold } = getRaffleProgressMetrics();
  if (reqPct > 0) {
    el.textContent = `Condición de venta mínima: ${reqPct}% de boletos vendidos (actual: ${pctSold.toFixed(1)}%).`;
  } else {
    el.textContent = 'Sin condición de porcentaje mínimo de venta.';
  }
}

function renderVendorWinnerView() {
  const notice = document.getElementById('vendorWinnerNotice');
  const modalBody = document.getElementById('vendorWinnerModalBody');
  const modal = document.getElementById('vendorWinnerModal');
  const winner = state.config && state.config.winnerResult;

  if (!winner || !state.user || isEffectiveAdmin()) {
    if (notice) notice.classList.add('hidden');
    return;
  }

  const numsList = getWinnerNumbersFormatted(winner);
  const numsText = numsList.length ? numsList.join(', ') : `#${formatTicketNum(winner.numero)}`;

  if (notice) {
    notice.classList.remove('hidden');
    notice.innerHTML = `
      <div class="card-header-flex">
        <div>
          <strong>🏆 Ganador: ${escapeHtml(winner.participante || 'Participante')}</strong>
          <div>Números con los que participaba: <strong>${escapeHtml(numsText)}</strong></div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" onclick="openVendorWinnerModal()">Ver detalle</button>
      </div>
    `;
  }

  const key = `${winner.numero}_${winner.selectedAt || winner.participante}`;
  if (state.seenWinnerKey !== key) {
    state.seenWinnerKey = key;
    if (modalBody && modal) {
      modalBody.innerHTML = `
        <p><strong>Ganador:</strong> ${escapeHtml(winner.participante || '-')}</p>
        ${winner.telefono ? `<p><strong>Teléfono:</strong> ${escapeHtml(winner.telefono)}</p>` : ''}
        <p><strong>Números con los que participaba:</strong> <strong>${escapeHtml(numsText)}</strong></p>
      `;
      modal.classList.remove('hidden');
    }
  }
}

window.openVendorWinnerModal = function() {
  const winner = state.config && state.config.winnerResult;
  const modalBody = document.getElementById('vendorWinnerModalBody');
  const modal = document.getElementById('vendorWinnerModal');
  if (!winner || !modalBody || !modal) return;
  const numsList = getWinnerNumbersFormatted(winner);
  const numsText = numsList.length ? numsList.join(', ') : `#${formatTicketNum(winner.numero)}`;
  modalBody.innerHTML = `
    <p><strong>Ganador:</strong> ${escapeHtml(winner.participante || '-')}</p>
    ${winner.telefono ? `<p><strong>Teléfono:</strong> ${escapeHtml(winner.telefono)}</p>` : ''}
    <p><strong>Números con los que participaba:</strong> <strong>${escapeHtml(numsText)}</strong></p>
  `;
  modal.classList.remove('hidden');
};

function renderRaffleHeader() {
  const cfg = state.config || {};
  const mult = getTicketMultiplier(cfg);
  document.getElementById('displayTitle').textContent = cfg.title || 'GRAN RIFA ESPECIAL';
  document.getElementById('displaySubtitle').textContent = cfg.subtitle || '¡Participa y gana increíbles premios!';

  const promoDoubleEl = document.getElementById('displayPromoDouble');
  const promoTicketsEl = document.getElementById('displayPromoTickets');
  if (cfg.promoText && cfg.promoText.includes('|')) {
    const parts = cfg.promoText.split('|').map(s => s.trim()).filter(Boolean);
    if (parts[0]) promoDoubleEl.textContent = parts[0];
    if (parts[1]) promoTicketsEl.textContent = parts[1];
  } else {
    promoDoubleEl.textContent = cfg.promoText || `Cada boleto vale x${mult}.`;
    promoTicketsEl.textContent = mult > 1 ? `${mult} números por boleto.` : '1 número por boleto.';
  }

  const firstEl = document.getElementById('displayFirstPrize');
  const secondEl = document.getElementById('displaySecondPrize');
  const prizesRaw = String(cfg.prizesText || '').trim();
  if (prizesRaw) {
    const lines = prizesRaw.split(/\n|\|/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
      firstEl.textContent = lines[0].replace(/^(🥇\s*)?(PRIMER\s*LUGAR\s*:?\s*)/i, '') || 'Premio a elegir.';
      secondEl.textContent = lines[1].replace(/^(🥈\s*)?(SEGUNDO\s*LUGAR\s*:?\s*)/i, '') || '$5,000.';
    } else {
      firstEl.textContent = lines[0] || 'Premio a elegir.';
      secondEl.textContent = '$5,000.';
    }
  }

  document.getElementById('displayReason').textContent = cfg.reasonText || 'Equipo Evangelismo.';
  document.getElementById('displayDate').textContent = cfg.eventDate || 'Por confirmar.';
  document.getElementById('displayAnnouncement').textContent = cfg.announcementMethod || 'Redes sociales.';
  document.getElementById('displayWinnerMethod').textContent = cfg.winnerMethod || 'Últimos 3 dígitos de la Lotería Nacional.';

  const imgBox = document.getElementById('displayImages');
  imgBox.innerHTML = '';
  (cfg.images || []).forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Premio';
    imgBox.appendChild(img);
  });

  const { pctOccupied } = getRaffleProgressMetrics();
  const tplBar = document.getElementById('templateProgressBar');
  const tplLabel = document.getElementById('templateProgressLabel');
  if (tplBar) tplBar.style.width = pctOccupied + '%';
  if (tplLabel) tplLabel.textContent = `${pctOccupied}%`;

  const winnerBanner = document.getElementById('winnerBanner');
  if (cfg.winnerResult) {
    winnerBanner.classList.remove('hidden');
    const numsText = getWinnerNumbersFormatted(cfg.winnerResult).join(', ');
    winnerBanner.textContent = `🏆 GANADOR: ${cfg.winnerResult.participante} — Número #${formatTicketNum(cfg.winnerResult.numero)}${numsText ? ` (Números: ${numsText})` : ''}`;
  } else {
    winnerBanner.classList.add('hidden');
  }
}

function getTicketsForCurrentView() {
  if (!isEffectiveAdmin() && state.config && state.config.distributionMode === 'B') {
    const userObj = (state.users || []).find(u => u.username === state.user.username);
    const assignedSet = new Set(Array.isArray(userObj && userObj.assignedTickets) ? userObj.assignedTickets.map(Number) : []);
    return state.tickets.filter(t => t.vendedorAsignado === state.user.username || assignedSet.has(Number(t.numero)));
  }
  return state.tickets;
}

function renderTicketsGrid() {
  const grid = document.getElementById('ticketsGrid');
  const q = state.searchQuery.toLowerCase();
  const mult = getTicketMultiplier(state.config);
  const viewTickets = getTicketsForCurrentView();

  let disp = 0, apar = 0, vend = 0;
  viewTickets.forEach(t => {
    if (t.estado === 'disponible') disp++;
    else if (t.estado === 'apartado') apar++;
    else if (t.estado === 'vendido') vend++;
  });

  document.getElementById('countAll').textContent = viewTickets.length;
  document.getElementById('countDisp').textContent = disp;
  document.getElementById('countApar').textContent = apar;
  document.getElementById('countVend').textContent = vend;

  const filtered = viewTickets.filter(t => {
    if (state.currentFilter !== 'all' && t.estado !== state.currentFilter) return false;
    if (q) {
      const matchNum = String(t.numero).includes(q) || formatTicketNum(t.numero).includes(q);
      const matchExtra = Array.isArray(t.extraNumbers) && t.extraNumbers.some(n => String(n).includes(q) || formatTicketNum(n).includes(q));
      const matchName = (t.participante || '').toLowerCase().includes(q);
      const matchPhone = (t.telefono || '').toLowerCase().includes(q);
      return matchNum || matchExtra || matchName || matchPhone;
    }
    return true;
  });

  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  filtered.forEach(ticket => {
    const cell = document.createElement('div');
    cell.className = `ticket-cell ${ticket.estado}`;
    const label = ticket.estado === 'disponible'
      ? (ticket.vendedorAsignado ? `Asig: ${ticket.vendedorAsignado}` : 'Libre')
      : ticket.participante;

    const extrasList = (mult > 1 && Array.isArray(ticket.extraNumbers)) ? ticket.extraNumbers : [];
    const extrasHtml = extrasList.length
      ? extrasList.map(n => `<span class="ticket-double-pill">#${formatTicketNum(n)}</span>`).join('')
      : '';

    cell.innerHTML = `
      <div class="ticket-pair-row">
        <span class="ticket-num">#${formatTicketNum(ticket.numero)}</span>
        ${extrasHtml}
      </div>
      <span class="ticket-sub">${escapeHtml(label)}</span>
    `;
    cell.addEventListener('click', () => openTicketModal(ticket));
    frag.appendChild(cell);
  });

  grid.appendChild(frag);
}

function openTicketModal(ticket) {
  const mult = getTicketMultiplier(state.config);
  document.getElementById('modalTicketNumber').textContent = formatTicketNum(ticket.numero);
  document.getElementById('modalTicketNumInput').value = ticket.numero;

  const extrasList = (mult > 1 && Array.isArray(ticket.extraNumbers)) ? ticket.extraNumbers : [];
  const doubleModalBadge = document.getElementById('modalDoubleBadge');
  if (extrasList.length > 0) {
    doubleModalBadge.textContent = `Extras: ${extrasList.map(n => `#${formatTicketNum(n)}`).join(', ')}`;
    doubleModalBadge.classList.remove('hidden');
  } else {
    doubleModalBadge.classList.add('hidden');
  }

  document.getElementById('modalParticipant').value = ticket.participante || '';
  document.getElementById('modalPhone').value = ticket.telefono || '';
  document.getElementById('modalPayStatus').value = ticket.estadoPago || 'pendiente';
  document.getElementById('modalNotes').value = ticket.notas || '';

  const metaBox = document.getElementById('modalTicketMeta');
  let metaLines = [];
  if (extrasList.length > 0) {
    const allNums = [`#${formatTicketNum(ticket.numero)}`, ...extrasList.map(n => `#${formatTicketNum(n)}`)].join(', ');
    metaLines.push(`Participa con los números: <strong>${allNums}</strong>`);
  }
  if (ticket.vendedorAsignado) metaLines.push(`Asignado a: <strong>${escapeHtml(ticket.vendedorAsignado)}</strong>`);
  if (ticket.vendedorRegistro) metaLines.push(`Registrado por: <strong>${escapeHtml(ticket.vendedorRegistro)}</strong>`);
  if (ticket.estado === 'apartado' && ticket.fechaVencimiento) {
    metaLines.push(`Vence apartado: <strong>${formatDate(ticket.fechaVencimiento)}</strong>`);
  }
  metaBox.innerHTML = metaLines.length ? metaLines.join(' | ') : 'Boleto disponible para registro.';

  const releaseBtn = document.getElementById('btnReleaseTicket');
  releaseBtn.classList.toggle('hidden', ticket.estado === 'disponible');

  document.getElementById('ticketModal').classList.remove('hidden');
}

async function handleSaveTicketSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSaveTicket');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const res = await apiCall('saveTicket', {
      numero: Number(document.getElementById('modalTicketNumInput').value),
      participante: document.getElementById('modalParticipant').value,
      telefono: document.getElementById('modalPhone').value,
      estadoPago: document.getElementById('modalPayStatus').value,
      notas: document.getElementById('modalNotes').value
    });

    closeModal('ticketModal');
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar Boleto';
  }
}

async function handleReleaseTicketClick() {
  const numero = Number(document.getElementById('modalTicketNumInput').value);
  if (!confirm(`¿Seguro que deseas liberar el boleto #${formatTicketNum(numero)}? Se borrarán los datos del participante.`)) {
    return;
  }

  try {
    const res = await apiCall('releaseTicket', { numero });
    closeModal('ticketModal');
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderAdminTable() {
  const tbody = document.getElementById('adminTicketsTableBody');
  const vendorSelect = document.getElementById('adminFilterVendor');
  const mult = getTicketMultiplier(state.config);

  const thDouble = document.getElementById('thDoubleCol');
  if (thDouble) thDouble.classList.add('hidden');

  const currentVendorFilter = vendorSelect.value;
  vendorSelect.innerHTML = '<option value="">Todos los vendedores</option>';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.username;
    opt.textContent = u.username + (!u.active ? ' (Cerrado)' : '');
    vendorSelect.appendChild(opt);
  });
  vendorSelect.value = currentVendorFilter;

  const q = document.getElementById('adminTableSearch').value.toLowerCase();
  const statusFilter = document.getElementById('adminFilterStatus').value;
  const now = Date.now();

  const rows = state.tickets.filter(t => {
    if (currentVendorFilter && t.vendedorAsignado !== currentVendorFilter && t.vendedorRegistro !== currentVendorFilter) {
      return false;
    }
    if (statusFilter === 'expiring') {
      if (t.estado !== 'apartado' || !t.fechaVencimiento) return false;
      const diffHours = (new Date(t.fechaVencimiento).getTime() - now) / 3600000;
      if (diffHours > 3 || diffHours < 0) return false;
    } else if (statusFilter && t.estado !== statusFilter) {
      return false;
    }
    if (q) {
      return String(t.numero).includes(q) ||
        formatTicketNum(t.numero).includes(q) ||
        (Array.isArray(t.extraNumbers) && t.extraNumbers.some(n => String(n).includes(q) || formatTicketNum(n).includes(q))) ||
        (t.participante || '').toLowerCase().includes(q) ||
        (t.telefono || '').toLowerCase().includes(q);
    }
    return true;
  });

  tbody.innerHTML = rows.map(t => {
    let statusTag = '<span class="tag tag-disp">Disponible</span>';
    if (t.estado === 'apartado') statusTag = '<span class="tag tag-apar">Apartado</span>';
    if (t.estado === 'vendido') statusTag = '<span class="tag tag-vend">Vendido</span>';

    let expText = '-';
    if (t.estado === 'apartado' && t.fechaVencimiento) {
      const diffH = (new Date(t.fechaVencimiento).getTime() - now) / 3600000;
      expText = formatDate(t.fechaVencimiento);
      if (diffH <= 3) expText = `<span class="tag tag-warn">Pronto: ${expText}</span>`;
    }

    const extrasList = (mult > 1 && Array.isArray(t.extraNumbers)) ? t.extraNumbers : [];
    const numDisplay = extrasList.length
      ? `<div class="ticket-table-pair"><strong>#${formatTicketNum(t.numero)}</strong>${extrasList.map(n => `<span class="tag tag-double">#${formatTicketNum(n)}</span>`).join('')}</div>`
      : `<strong>#${formatTicketNum(t.numero)}</strong>`;

    return `
      <tr>
        <td>${numDisplay}</td>
        <td>${escapeHtml(t.vendedorAsignado || '-')}</td>
        <td>${escapeHtml(t.vendedorRegistro || '-')}</td>
        <td>${escapeHtml(t.participante || '-')}</td>
        <td>${escapeHtml(t.telefono || '-')}</td>
        <td>${statusTag}</td>
        <td>${t.estado === 'disponible' ? '-' : t.estadoPago.toUpperCase()}</td>
        <td>${expText}</td>
        <td><button class="btn btn-sm btn-ghost" onclick="openTicketByNum(${t.numero})">Editar</button></td>
      </tr>
    `;
  }).join('');
}

window.openTicketByNum = function(num) {
  const t = state.tickets.find(item => item.numero === num);
  if (t) openTicketModal(t);
};

function exportToExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('La librería de Excel aún está cargando, intenta de nuevo.', 'error');
    return;
  }

  const mult = getTicketMultiplier(state.config);
  const dataRows = state.tickets.map(t => {
    const row = {
      'Número Principal': formatTicketNum(t.numero)
    };
    if (mult > 1) {
      row['Números Extra'] = Array.isArray(t.extraNumbers) ? t.extraNumbers.map(formatTicketNum).join(', ') : '';
    }
    row['Estado Venta'] = t.estado.toUpperCase();
    row['Estado Pago'] = t.estado === 'disponible' ? '' : t.estadoPago.toUpperCase();
    row['Participante'] = t.participante;
    row['Teléfono'] = t.telefono;
    row['Vendedor Asignado'] = t.vendedorAsignado;
    row['Vendedor Registro'] = t.vendedorRegistro;
    row['Fecha Registro'] = t.fechaRegistro ? formatDate(t.fechaRegistro) : '';
    row['Vencimiento Apartado'] = t.fechaVencimiento ? formatDate(t.fechaVencimiento) : '';
    row['Notas'] = t.notas;
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(dataRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Boletos');
  XLSX.writeFile(wb, `Rifa_${(state.config.title || 'Rifa').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

function renderStats() {
  const price = Number(state.config.ticketPrice || 0);
  const mult = getTicketMultiplier(state.config);
  const { total, disp, apar, vend, pctOccupied } = getRaffleProgressMetrics();

  const recaudado = vend * price;
  const pendienteDinero = apar * price;
  const proyeccionTotal = total * price;
  const pctVendidos = total > 0 ? Math.round((vend / total) * 100) : 0;

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card"><span>Total de Boletos</span><strong>${total}${mult > 1 ? ` (${total * mult} núms)` : ''}</strong></div>
    <div class="kpi-card"><span>Disponibles</span><strong>${disp} <small style="font-size:13px;color:var(--muted)">(${total > 0 ? Math.round((disp/total)*100) : 0}%)</small></strong></div>
    <div class="kpi-card"><span>Apartados (Pendientes)</span><strong>${apar} <small style="font-size:13px;color:var(--muted)">(${total > 0 ? Math.round((apar/total)*100) : 0}%)</small></strong></div>
    <div class="kpi-card"><span>Vendidos (Pagados)</span><strong>${vend} <small style="font-size:13px;color:var(--muted)">(${pctVendidos}%)</small></strong></div>
    <div class="kpi-card"><span>Dinero Recaudado</span><strong style="color:#059669">$${recaudado.toLocaleString()}</strong></div>
    <div class="kpi-card"><span>Pendiente por Cobrar</span><strong style="color:var(--warning)">$${pendienteDinero.toLocaleString()}</strong></div>
    <div class="kpi-card"><span>Proyección Máxima</span><strong>$${proyeccionTotal.toLocaleString()}</strong></div>
    <div class="kpi-card"><span>Avance Total</span><strong>${pctOccupied}%</strong></div>
  `;

  const bar = document.getElementById('raffleProgressBar');
  const statsLabel = document.getElementById('statsProgressLabel');
  if (bar) bar.style.width = pctOccupied + '%';
  if (statsLabel) statsLabel.textContent = `${pctOccupied}% (${vend} pagados, ${apar} apartados, ${disp} libres de ${total})`;

  const vendorMap = {};
  state.users.forEach(u => {
    vendorMap[u.username] = {
      username: u.username,
      active: u.active,
      asignados: Array.isArray(u.assignedTickets) ? u.assignedTickets.length : 0,
      pagados: 0,
      apartados: 0
    };
  });

  state.tickets.forEach(t => {
    const owner = t.vendedorRegistro || t.vendedorAsignado;
    if (!owner) return;
    if (!vendorMap[owner]) {
      vendorMap[owner] = { username: owner, active: false, asignados: 0, pagados: 0, apartados: 0 };
    }
    if (t.estado === 'vendido') vendorMap[owner].pagados++;
    if (t.estado === 'apartado') vendorMap[owner].apartados++;
  });

  document.getElementById('vendorStatsBody').innerHTML = Object.values(vendorMap).map(v => {
    const libres = Math.max(0, v.asignados - v.pagados - v.apartados);
    const totalVendedor = v.pagados + v.apartados;
    const efectividad = v.asignados > 0 ? Math.round((totalVendedor / v.asignados) * 100) : 0;
    const estadoBadge = v.active ? '' : ' <span class="tag tag-warn">Cerrado</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(v.username)}</strong>${estadoBadge}</td>
        <td>${v.asignados}</td>
        <td>${v.pagados}</td>
        <td>${v.apartados}</td>
        <td>${libres} (${efectividad}% mov.)</td>
        <td><strong>$${(v.pagados * price).toLocaleString()}</strong></td>
        <td>$${(v.apartados * price).toLocaleString()}</td>
      </tr>
    `;
  }).join('');
}

function renderVendorDistributionSummary() {
  const box = document.getElementById('vendorDistributionSummary');
  if (!box) return;

  const activeVendors = (state.users || []).filter(u => hasRole(u, 'vendedor') && u.active);
  const vendorCount = activeVendors.length;
  const totalTickets = Number((state.config && state.config.totalTickets) || state.tickets.length || 0);

  if (vendorCount === 0 || totalTickets === 0) {
    box.innerHTML = '';
    return;
  }

  const countByTickets = new Map();
  let hasAssigned = false;

  activeVendors.forEach(u => {
    const qty = Array.isArray(u.assignedTickets) ? u.assignedTickets.length : 0;
    if (qty > 0) hasAssigned = true;
    countByTickets.set(qty, (countByTickets.get(qty) || 0) + 1);
  });

  if (!hasAssigned) {
    countByTickets.clear();
    const base = Math.floor(totalTickets / vendorCount);
    const remainder = totalTickets % vendorCount;
    if (remainder > 0) {
      countByTickets.set(base + 1, remainder);
      countByTickets.set(base, vendorCount - remainder);
    } else {
      countByTickets.set(base, vendorCount);
    }
  }

  const lines = Array.from(countByTickets.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([qty, vendorsQty]) => {
      const vLabel = vendorsQty === 1 ? 'vendedor' : 'vendedores';
      const tLabel = qty === 1 ? 'boleto' : 'boletos';
      return `<div>• <strong>${vendorsQty}</strong> ${vLabel} con <strong>${qty}</strong> ${tLabel}</div>`;
    });

  box.innerHTML = lines.join('');
}

function renderUsersAndAssignments() {
  document.getElementById('cfgDistModeQuick').value = state.config.distributionMode || 'A';

  document.getElementById('usersTableBody').innerHTML = state.users.map(u => {
    const isSelf = state.user && state.user.id === u.id;
    const delBtn = isSelf
      ? ''
      : `<button class="btn btn-sm btn-danger-outline" onclick="deleteUserById('${u.id}', '${escapeHtml(u.username)}')">Eliminar</button>`;

    const statusLabel = u.active
      ? '<span class="tag tag-vend">Activo</span>'
      : '<span class="tag tag-warn">Cerrado / Inactivo</span>';

    const rolesText = normalizeRoles(u.roles || u.role).map(r => r.toUpperCase()).join(', ');

    return `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(rolesText)}</td>
        <td>${statusLabel}</td>
        <td>${u.assignedTickets.length > 0 ? u.assignedTickets.map(formatTicketNum).join(', ') : 'Ninguno'}</td>
        <td>
          <div class="btn-row">
            <button class="btn btn-sm btn-ghost" onclick="editUser('${u.id}')">Editar</button>
            ${delBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderVendorDistributionSummary();
}

window.deleteUserById = async function(userId, username) {
  if (!confirm(`¿Eliminar al usuario "${username}"? Esta acción es para limpieza o pruebas.`)) {
    return;
  }
  try {
    const res = await apiCall('deleteUser', { userId });
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.editUser = function(userId) {
  const u = state.users.find(item => item.id === userId);
  if (!u) return;
  const roles = normalizeRoles(u.roles || u.role);
  document.getElementById('userFormTitle').textContent = 'Editar Usuario: ' + u.username;
  document.getElementById('editUserId').value = u.id;
  document.getElementById('userUsername').value = u.username;
  document.getElementById('userPassword').value = '';
  document.getElementById('pwdHint').textContent = '(Dejar vacío para conservar actual)';
  document.getElementById('chkRoleAdmin').checked = roles.includes('admin');
  document.getElementById('chkRoleVendor').checked = roles.includes('vendedor');
  document.getElementById('userActive').value = String(u.active);
  document.getElementById('btnCancelEditUser').classList.remove('hidden');
};

async function handleSaveUserSubmit(e) {
  e.preventDefault();
  const selectedRoles = [];
  if (document.getElementById('chkRoleAdmin').checked) selectedRoles.push('admin');
  if (document.getElementById('chkRoleVendor').checked) selectedRoles.push('vendedor');

  if (!selectedRoles.length) {
    showToast('Selecciona al menos un rol (Administrador o Vendedor).', 'error');
    return;
  }

  try {
    const res = await apiCall('saveUser', {
      id: document.getElementById('editUserId').value || undefined,
      username: document.getElementById('userUsername').value,
      password: document.getElementById('userPassword').value,
      roles: selectedRoles,
      role: selectedRoles[0],
      active: document.getElementById('userActive').value === 'true'
    });
    resetUserForm();
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function resetUserForm() {
  document.getElementById('userForm').reset();
  document.getElementById('editUserId').value = '';
  document.getElementById('chkRoleAdmin').checked = false;
  document.getElementById('chkRoleVendor').checked = true;
  document.getElementById('userFormTitle').textContent = 'Nuevo Usuario (Vendedor / Admin)';
  document.getElementById('pwdHint').textContent = '(Mínimo 6 caracteres)';
  document.getElementById('btnCancelEditUser').classList.add('hidden');
}

function updateExtraHint(val) {
  const n = Math.max(1, Math.floor(Number(val) || 1));
  const extra = n - 1;
  const hint = document.getElementById('extraTicketsHint');
  const btn = document.getElementById('btnRegenerateExtra');
  if (hint) {
    hint.textContent = extra === 0
      ? 'Cada boleto tiene 1 número (sin números extra).'
      : `Cada boleto vale x${n}: agrega ${extra} número(s) extra aleatorio(s) sin repetir.`;
  }
  if (btn) {
    btn.classList.toggle('hidden', extra === 0);
  }
}

function populateConfigForm() {
  const c = state.config;
  const mult = getTicketMultiplier(c);
  document.getElementById('cfgTitle').value = c.title || '';
  document.getElementById('cfgSubtitle').value = c.subtitle || '';
  document.getElementById('cfgTotalTickets').value = c.totalTickets ?? 100;
  document.getElementById('cfgTicketPrice').value = c.ticketPrice ?? 50;
  document.getElementById('cfgNumbersPerTicket').value = mult;
  updateExtraHint(mult);
  document.getElementById('cfgMinWinnerSoldPercent').value = c.minWinnerSoldPercent ?? 0;
  document.getElementById('cfgPromoText').value = c.promoText || '';
  document.getElementById('cfgPrizesText').value = c.prizesText || '';
  document.getElementById('cfgReasonText').value = c.reasonText || '';
  document.getElementById('cfgEventDate').value = c.eventDate || '';
  document.getElementById('cfgReservationHours').value = c.reservationHours ?? 24;
  document.getElementById('cfgAnnouncementMethod').value = c.announcementMethod || '';
  document.getElementById('cfgWinnerMethod').value = c.winnerMethod || '';
  document.getElementById('cfgAutoReleaseExpired').checked = Boolean(c.autoReleaseExpired);

  document.getElementById('cfgColsDesktop').value = c.gridColsDesktop ?? 10;
  document.getElementById('cfgColsMobile').value = c.gridColsMobile ?? 5;
  document.getElementById('cfgPrimaryColor').value = c.primaryColor || '#102442';
  document.getElementById('cfgAccentColor').value = c.accentColor || '#0B1730';
  document.getElementById('cfgHeaderFontSize').value = c.headerFontSize ?? 26;
  document.getElementById('cfgBodyFontSize').value = c.bodyFontSize ?? 14;
  document.getElementById('cfgPadTop').value = c.headerPadTop ?? 0;
  document.getElementById('cfgPadBottom').value = c.headerPadBottom ?? 0;
  document.getElementById('cfgPadLeft').value = c.headerPadLeft ?? 0;
  document.getElementById('cfgPadRight').value = c.headerPadRight ?? 0;

  state.tempConfigImages = [...(c.images || [])];
  state.configDirty = false;
  renderConfigImagesList();
}

function renderConfigImagesList() {
  const list = document.getElementById('configImagesList');
  list.innerHTML = state.tempConfigImages.map((src, idx) => `
    <div class="img-thumb-item">
      <img src="${src}" alt="Premio ${idx + 1}" />
      <button type="button" onclick="removeConfigImage(${idx})">&times;</button>
    </div>
  `).join('');
}

window.removeConfigImage = function(idx) {
  state.tempConfigImages.splice(idx, 1);
  state.configDirty = true;
  renderConfigImagesList();
};

function handlePrizeImageUpload(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 420 / Math.max(img.width, img.height));
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        state.tempConfigImages.push(canvas.toDataURL('image/jpeg', 0.78));
        state.configDirty = true;
        renderConfigImagesList();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function readFieldClean(id, fallbackValue, isNumber = false) {
  const el = document.getElementById(id);
  if (!el) return fallbackValue;
  const raw = el.value;
  if (isNumber) {
    if (raw === '' || raw === null || raw === undefined) return fallbackValue;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallbackValue : parsed;
  }
  return raw === '' ? (fallbackValue ?? '') : raw;
}

async function handleSaveConfigSubmit(e, regenerateExtraMap = false) {
  if (e) e.preventDefault();
  const btn = document.getElementById('btnSaveConfig');
  btn.disabled = true;
  btn.textContent = 'Guardando configuración...';

  try {
    const cur = state.config || {};
    const prevMult = getTicketMultiplier(cur);
    const totalVal = readFieldClean('cfgTotalTickets', Number(cur.totalTickets) || 100, true);
    const priceVal = readFieldClean('cfgTicketPrice', Number(cur.ticketPrice) || 50, true);
    const multVal = Math.max(1, Math.floor(readFieldClean('cfgNumbersPerTicket', prevMult, true)));
    const minPctVal = Math.max(0, Math.min(100, readFieldClean('cfgMinWinnerSoldPercent', Number(cur.minWinnerSoldPercent) || 0, true)));

    const localMap = multVal > 1
      ? ((regenerateExtraMap || Number(cur.totalTickets) !== totalVal || prevMult !== multVal || !isExtraMapValid(cur.extraMap, totalVal, multVal))
        ? buildExtraMap(totalVal, multVal)
        : cur.extraMap)
      : {};

    const payload = {
      title: readFieldClean('cfgTitle', cur.title || 'GRAN RIFA ESPECIAL', false),
      subtitle: readFieldClean('cfgSubtitle', cur.subtitle || '¡Participa y gana increíbles premios!', false),
      totalTickets: totalVal,
      ticketPrice: priceVal,
      numbersPerTicket: multVal,
      doubleChance: multVal > 1,
      extraMap: localMap,
      regenerateExtraMap: regenerateExtraMap,
      minWinnerSoldPercent: minPctVal,
      promoText: readFieldClean('cfgPromoText', cur.promoText || '', false),
      prizesText: readFieldClean('cfgPrizesText', cur.prizesText || '', false),
      reasonText: readFieldClean('cfgReasonText', cur.reasonText || '', false),
      eventDate: readFieldClean('cfgEventDate', cur.eventDate || '', false),
      reservationHours: readFieldClean('cfgReservationHours', Number(cur.reservationHours) || 24, true),
      announcementMethod: readFieldClean('cfgAnnouncementMethod', cur.announcementMethod || '', false),
      winnerMethod: readFieldClean('cfgWinnerMethod', cur.winnerMethod || '', false),
      autoReleaseExpired: document.getElementById('cfgAutoReleaseExpired')
        ? Boolean(document.getElementById('cfgAutoReleaseExpired').checked)
        : Boolean(cur.autoReleaseExpired),
      gridColsDesktop: readFieldClean('cfgColsDesktop', Number(cur.gridColsDesktop) || 10, true),
      gridColsMobile: readFieldClean('cfgColsMobile', Number(cur.gridColsMobile) || 5, true),
      primaryColor: readFieldClean('cfgPrimaryColor', cur.primaryColor || '#102442', false),
      accentColor: readFieldClean('cfgAccentColor', cur.accentColor || '#0B1730', false),
      headerFontSize: readFieldClean('cfgHeaderFontSize', Number(cur.headerFontSize) || 26, true),
      bodyFontSize: readFieldClean('cfgBodyFontSize', Number(cur.bodyFontSize) || 14, true),
      headerPadTop: readFieldClean('cfgPadTop', Number(cur.headerPadTop ?? 0), true),
      headerPadBottom: readFieldClean('cfgPadBottom', Number(cur.headerPadBottom ?? 0), true),
      headerPadLeft: readFieldClean('cfgPadLeft', Number(cur.headerPadLeft ?? 0), true),
      headerPadRight: readFieldClean('cfgPadRight', Number(cur.headerPadRight ?? 0), true),
      images: state.tempConfigImages
    };

    const res = await apiCall('updateConfig', payload);
    state.configDirty = false;
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Guardar Toda la Configuración';
  }
}

function renderWinnerBoxResult(w) {
  const box = document.getElementById('winnerResultBox');
  if (!box || !w) return;
  const numsText = getWinnerNumbersFormatted(w).join(', ');
  box.classList.remove('hidden');
  box.innerHTML = `
    <h2>🎉 Número Ganador: #${formatTicketNum(w.numero)}</h2>
    ${numsText ? `<p><strong>Números participantes:</strong> ${escapeHtml(numsText)}</p>` : ''}
    <p><strong>Participante:</strong> ${escapeHtml(w.participante)}</p>
    <p><strong>Teléfono:</strong> ${escapeHtml(w.telefono)}</p>
    <p><strong>Vendedor:</strong> ${escapeHtml(w.vendedor)}</p>
    <small>${formatDate(w.selectedAt)}</small>
  `;
}

function renderHistory() {
  const salesOnly = (state.history || []).filter(h => {
    const acc = String(h.accion || '').toUpperCase();
    const det = String(h.detalle || '').toLowerCase();
    return acc.includes('VENTA') || acc.includes('VENDIDO') || det.includes(' - pagado');
  });

  document.getElementById('historyTableBody').innerHTML = salesOnly.map(h => `
    <tr>
      <td>${formatDate(h.fecha)}</td>
      <td><strong>${escapeHtml(h.usuario)}</strong></td>
      <td>${escapeHtml(h.rol)}</td>
      <td><span class="tag tag-vend">${escapeHtml(h.accion)}</span></td>
      <td>${escapeHtml(formatTicketNum(h.boleto))}</td>
      <td>${escapeHtml(h.detalle)}</td>
    </tr>
  `).join('');
}

function renderBackups() {
  document.getElementById('backupsTableBody').innerHTML = state.backups.map(b => `
    <tr>
      <td>${formatDate(b.fecha)}</td>
      <td>${escapeHtml(b.label)}</td>
      <td>${b.totalBoletos}</td>
      <td>$${Number(b.recaudado).toLocaleString()}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="restoreBackupById('${b.id}')">Restaurar</button>
      </td>
    </tr>
  `).join('');
}

window.restoreBackupById = async function(backupId) {
  if (!confirm('¿Restaurar este respaldo? Se sobrescribirán los boletos actuales.')) return;
  try {
    const res = await apiCall('restoreBackup', { backupId });
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
  document.getElementById('btnLogout').addEventListener('click', handleLogoutClick);
  document.getElementById('topbarRole').addEventListener('click', toggleAdminVendorRoleView);
  document.getElementById('btnManualSync').addEventListener('click', () => {
    state.configDirty = false;
    syncData(true);
  });

  const cfgForm = document.getElementById('configForm');
  cfgForm.addEventListener('input', () => { state.configDirty = true; });
  cfgForm.addEventListener('change', () => { state.configDirty = true; });

  document.getElementById('cfgNumbersPerTicket').addEventListener('input', (e) => {
    updateExtraHint(e.target.value);
  });

  document.getElementById('btnRegenerateExtra').addEventListener('click', async () => {
    if (!confirm('¿Generar nuevos números extra aleatorios sin repetir para todos los boletos?')) return;
    await handleSaveConfigSubmit(null, true);
  });

  document.getElementById('btnInstallPwa').addEventListener('click', async () => {
    if (state.deferredInstallPrompt) {
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      document.getElementById('btnInstallPwa').classList.add('hidden');
    }
  });

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
  });

  document.getElementById('ticketSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTicketsGrid();
  });

  document.querySelectorAll('.filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.currentFilter = pill.dataset.filter;
      renderTicketsGrid();
    });
  });

  document.getElementById('ticketForm').addEventListener('submit', handleSaveTicketSubmit);
  document.getElementById('btnReleaseTicket').addEventListener('click', handleReleaseTicketClick);

  document.getElementById('adminTableSearch').addEventListener('input', renderAdminTable);
  document.getElementById('adminFilterVendor').addEventListener('change', renderAdminTable);
  document.getElementById('adminFilterStatus').addEventListener('change', renderAdminTable);
  document.getElementById('btnExportExcel').addEventListener('click', exportToExcel);

  document.getElementById('userForm').addEventListener('submit', handleSaveUserSubmit);
  document.getElementById('btnCancelEditUser').addEventListener('click', resetUserForm);

  document.getElementById('btnSaveDistMode').addEventListener('click', async () => {
    try {
      const mode = document.getElementById('cfgDistModeQuick').value;
      await apiCall('updateConfig', { distributionMode: mode });
      showToast('Modalidad actualizada a ' + mode, 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('btnAutoAssign').addEventListener('click', async () => {
    try {
      const res = await apiCall('assignTickets', {
        mode: 'auto',
        shuffle: document.getElementById('autoAssignShuffle').value === 'true'
      });
      showToast(res.message, 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('btnClearAssign').addEventListener('click', async () => {
    if (!confirm('¿Quitar todas las asignaciones de vendedores?')) return;
    try {
      const res = await apiCall('assignTickets', { mode: 'clear' });
      showToast(res.message, 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  cfgForm.addEventListener('submit', (e) => handleSaveConfigSubmit(e, false));
  document.getElementById('prizeImageFile').addEventListener('change', handlePrizeImageUpload);

  document.getElementById('btnPickWinner').addEventListener('click', async () => {
    const onlyPaid = document.getElementById('winnerOnlyPaid').checked;
    if (!confirm('¿Confirmas seleccionar un número ganador aleatorio ahora?')) return;
    try {
      const res = await apiCall('pickWinner', { onlyPaid });
      renderWinnerBoxResult(res.winner);
      showToast('Ganador seleccionado: #' + formatTicketNum(res.winner.numero), 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('manualWinnerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawVal = document.getElementById('manualWinnerNumber').value.trim();
    const onlyPaid = document.getElementById('winnerOnlyPaid').checked;
    if (!rawVal) {
      showToast('Ingresa el número ganador.', 'error');
      return;
    }
    try {
      const res = await apiCall('setManualWinner', {
        numero: rawVal,
        onlyPaid: onlyPaid
      });
      document.getElementById('manualWinnerNumber').value = '';
      renderWinnerBoxResult(res.winner);
      showToast('Ganador manual registrado: #' + formatTicketNum(res.winner.numero), 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('btnCreateBackup').addEventListener('click', async () => {
    try {
      const res = await apiCall('createBackup', { label: 'Respaldo manual' });
      const blob = new Blob([JSON.stringify(res.backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Respaldo_Rifa_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      showToast('Respaldo guardado en Google Sheets y descargado.', 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('btnOpenResetModal').addEventListener('click', () => {
    document.getElementById('resetTotalTickets').value = state.config.totalTickets || 100;
    document.getElementById('resetModal').classList.remove('hidden');
  });

  document.getElementById('resetRaffleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (document.getElementById('resetConfirmText').value.trim() !== 'REINICIAR') {
      showToast('Debes escribir REINICIAR exactamente para confirmar.', 'error');
      return;
    }
    try {
      const res = await apiCall('resetRaffle', {
        newTitle: document.getElementById('resetNewTitle').value,
        totalTickets: Number(document.getElementById('resetTotalTickets').value),
        keepTemplate: document.getElementById('resetKeepTemplate').checked,
        keepAssignments: document.getElementById('resetKeepAssignments').checked
      });
      closeModal('resetModal');
      document.getElementById('resetRaffleForm').reset();
      showToast(res.message, 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function formatDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('es-MX', {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  } catch (_) {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
