/**
 * GESTOR DE RIFAS PRO - FRONTEND SPA + PWA
 */

const DEFAULT_GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxpwjnw4awqaZMvugTWmSOK7bZLFE5reckrWO2Vm0UQUGLZWlXBY2Xcdp_0y1g8HbnNmA/exec';

const state = {
  endpoint: localStorage.getItem('rifas_gas_url') || DEFAULT_GAS_ENDPOINT,
  token: localStorage.getItem('rifas_session_token') || '',
  user: null,
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
  tempConfigImages: []
};

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  bindEvents();
  updateOnlineStatus();

  if (state.token) {
    showAppShell();
    syncData(true);
  } else {
    showLoginView();
  }
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
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
  if (!state.endpoint || state.endpoint.includes('REEMPLAZA_CON_TU_ID')) {
    throw new Error('Configura primero la URL de Google Apps Script en el botón inferior.');
  }

  const response = await fetch(state.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: action,
      token: state.token,
      data: data
    })
  });

  const result = await response.json();
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
  state.version = 0;
  localStorage.removeItem('rifas_session_token');
  showLoginView();
}

function startAutoSync() {
  stopAutoSync();
  state.syncTimer = setInterval(() => {
    if (navigator.onLine && !document.hidden) {
      syncData(false);
    }
  }, 12000);
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
      state.config = res.config;
      state.user = res.user;
      state.tickets = res.tickets || [];
      if (res.users) state.users = res.users;
      if (res.history) state.history = res.history;
      if (res.backups) state.backups = res.backups;

      applyVisualTheme();
      renderAll();
    }

    indicator.textContent = '● Sincronizado';
    indicator.classList.remove('syncing');
  } catch (err) {
    indicator.textContent = '⚠ Error red';
    if (forceFull) showToast(err.message, 'error');
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
  root.style.setProperty('--primary', cfg.primaryColor || '#2563eb');
  root.style.setProperty('--accent', cfg.accentColor || '#10b981');
  root.style.setProperty('--cols-desktop', cfg.gridColsDesktop || 10);
  root.style.setProperty('--cols-mobile', cfg.gridColsMobile || 5);
  root.style.setProperty('--header-font', (cfg.headerFontSize || 26) + 'px');
  root.style.setProperty('--body-font', (cfg.bodyFontSize || 15) + 'px');

  const headerCard = document.getElementById('raffleHeaderCard');
  headerCard.style.paddingTop = (cfg.headerPadTop ?? 24) + 'px';
  headerCard.style.paddingBottom = (cfg.headerPadBottom ?? 24) + 'px';
  headerCard.style.paddingLeft = (cfg.headerPadLeft ?? 16) + 'px';
  headerCard.style.paddingRight = (cfg.headerPadRight ?? 16) + 'px';
}

function renderAll() {
  if (!state.user || !state.config) return;

  const isAdmin = state.user.role === 'admin';
  document.getElementById('topbarUser').textContent = state.user.username;
  document.getElementById('topbarRole').textContent = isAdmin ? 'Administrador' : 'Vendedor';

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });

  renderRaffleHeader();
  renderTicketsGrid();

  if (isAdmin) {
    renderAdminTable();
    renderStats();
    renderUsersAndAssignments();
    populateConfigForm();
    renderHistory();
    renderBackups();
  }
}

function renderRaffleHeader() {
  const cfg = state.config;
  document.getElementById('displayTitle').textContent = cfg.title;
  document.getElementById('displaySubtitle').textContent = cfg.subtitle;
  document.getElementById('displayPromo').textContent = cfg.promoText || `$${cfg.ticketPrice} por boleto`;
  document.getElementById('displayPrizes').textContent = cfg.prizesText;
  document.getElementById('displayReason').textContent = cfg.reasonText;
  document.getElementById('displayDate').textContent = cfg.eventDate;
  document.getElementById('displayAnnouncement').textContent = cfg.announcementMethod;
  document.getElementById('displayWinnerMethod').textContent = cfg.winnerMethod;

  const imgBox = document.getElementById('displayImages');
  imgBox.innerHTML = '';
  (cfg.images || []).forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Premio';
    imgBox.appendChild(img);
  });

  const winnerBanner = document.getElementById('winnerBanner');
  if (cfg.winnerResult) {
    winnerBanner.classList.remove('hidden');
    winnerBanner.textContent = `🏆 NÚMERO GANADOR SELECCIONADO: #${cfg.winnerResult.numero} — ${cfg.winnerResult.participante} (Seleccionado el ${formatDate(cfg.winnerResult.selectedAt)})`;
  } else {
    winnerBanner.classList.add('hidden');
  }
}

function renderTicketsGrid() {
  const grid = document.getElementById('ticketsGrid');
  const q = state.searchQuery.toLowerCase();

  let disp = 0, apar = 0, vend = 0;
  state.tickets.forEach(t => {
    if (t.estado === 'disponible') disp++;
    else if (t.estado === 'apartado') apar++;
    else if (t.estado === 'vendido') vend++;
  });

  document.getElementById('countAll').textContent = state.tickets.length;
  document.getElementById('countDisp').textContent = disp;
  document.getElementById('countApar').textContent = apar;
  document.getElementById('countVend').textContent = vend;

  const filtered = state.tickets.filter(t => {
    if (state.currentFilter !== 'all' && t.estado !== state.currentFilter) return false;
    if (q) {
      const matchNum = String(t.numero).includes(q);
      const matchName = (t.participante || '').toLowerCase().includes(q);
      const matchPhone = (t.telefono || '').toLowerCase().includes(q);
      return matchNum || matchName || matchPhone;
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

    cell.innerHTML = `
      <span class="ticket-num">${ticket.numero}</span>
      <span class="ticket-sub">${escapeHtml(label)}</span>
    `;
    cell.addEventListener('click', () => openTicketModal(ticket));
    frag.appendChild(cell);
  });

  grid.appendChild(frag);
}

function openTicketModal(ticket) {
  document.getElementById('modalTicketNumber').textContent = ticket.numero;
  document.getElementById('modalTicketNumInput').value = ticket.numero;
  document.getElementById('modalParticipant').value = ticket.participante || '';
  document.getElementById('modalPhone').value = ticket.telefono || '';
  document.getElementById('modalPayStatus').value = ticket.estadoPago || 'pendiente';
  document.getElementById('modalNotes').value = ticket.notas || '';

  const metaBox = document.getElementById('modalTicketMeta');
  let metaLines = [];
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
  if (!confirm(`¿Seguro que deseas liberar el boleto #${numero}? Se borrarán los datos del participante.`)) {
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

  const currentVendorFilter = vendorSelect.value;
  vendorSelect.innerHTML = '<option value="">Todos los vendedores</option>';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.username;
    opt.textContent = u.username;
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

    return `
      <tr>
        <td><strong>#${t.numero}</strong></td>
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

  const dataRows = state.tickets.map(t => ({
    'Número': t.numero,
    'Estado Venta': t.estado.toUpperCase(),
    'Estado Pago': t.estado === 'disponible' ? '' : t.estadoPago.toUpperCase(),
    'Participante': t.participante,
    'Teléfono': t.telefono,
    'Vendedor Asignado': t.vendedorAsignado,
    'Vendedor Registro': t.vendedorRegistro,
    'Fecha Registro': t.fechaRegistro ? formatDate(t.fechaRegistro) : '',
    'Vencimiento Apartado': t.fechaVencimiento ? formatDate(t.fechaVencimiento) : '',
    'Notas': t.notas
  }));

  const ws = XLSX.utils.json_to_sheet(dataRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Boletos');
  XLSX.writeFile(wb, `Rifa_${state.config.title.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

function renderStats() {
  const total = state.tickets.length;
  const price = Number(state.config.ticketPrice || 0);
  const disp = state.tickets.filter(t => t.estado === 'disponible').length;
  const apar = state.tickets.filter(t => t.estado === 'apartado').length;
  const vend = state.tickets.filter(t => t.estado === 'vendido').length;

  const recaudado = vend * price;
  const pendienteDinero = apar * price;
  const pct = total > 0 ? Math.round(((vend + apar) / total) * 100) : 0;

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card"><span>Total de Boletos</span><strong>${total}</strong></div>
    <div class="kpi-card"><span>Disponibles</span><strong>${disp}</strong></div>
    <div class="kpi-card"><span>Apartados (Pendientes)</span><strong>${apar}</strong></div>
    <div class="kpi-card"><span>Vendidos (Pagados)</span><strong>${vend}</strong></div>
    <div class="kpi-card"><span>Dinero Recaudado</span><strong style="color:var(--accent)">$${recaudado.toLocaleString()}</strong></div>
    <div class="kpi-card"><span>Pendiente por Cobrar</span><strong style="color:var(--warning)">$${pendienteDinero.toLocaleString()}</strong></div>
  `;

  const bar = document.getElementById('raffleProgressBar');
  bar.style.width = pct + '%';
  bar.textContent = `${pct}% (${vend + apar} de ${total} boletos ocupados)`;

  const vendorMap = {};
  state.users.forEach(u => {
    vendorMap[u.username] = { username: u.username, asignados: u.assignedTickets.length, pagados: 0, apartados: 0 };
  });

  state.tickets.forEach(t => {
    const owner = t.vendedorRegistro || t.vendedorAsignado;
    if (!owner) return;
    if (!vendorMap[owner]) vendorMap[owner] = { username: owner, asignados: 0, pagados: 0, apartados: 0 };
    if (t.estado === 'vendido') vendorMap[owner].pagados++;
    if (t.estado === 'apartado') vendorMap[owner].apartados++;
  });

  document.getElementById('vendorStatsBody').innerHTML = Object.values(vendorMap).map(v => {
    const libres = Math.max(0, v.asignados - v.pagados - v.apartados);
    return `
      <tr>
        <td><strong>${escapeHtml(v.username)}</strong></td>
        <td>${v.asignados}</td>
        <td>${v.pagados}</td>
        <td>${v.apartados}</td>
        <td>${libres}</td>
        <td><strong>$${(v.pagados * price).toLocaleString()}</strong></td>
        <td>$${(v.apartados * price).toLocaleString()}</td>
      </tr>
    `;
  }).join('');
}

function renderUsersAndAssignments() {
  document.getElementById('cfgDistModeQuick').value = state.config.distributionMode || 'A';

  const manualSel = document.getElementById('manualAssignVendor');
  manualSel.innerHTML = '';
  state.users.filter(u => u.role === 'vendedor').forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.username} (${u.assignedTickets.length} asignados)`;
    manualSel.appendChild(opt);
  });

  document.getElementById('usersTableBody').innerHTML = state.users.map(u => `
    <tr>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${u.role.toUpperCase()}</td>
      <td>${u.active ? '<span class="tag tag-vend">Activo</span>' : '<span class="tag tag-warn">Desactivado</span>'}</td>
      <td>${u.assignedTickets.length > 0 ? u.assignedTickets.join(', ') : 'Ninguno'}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="editUser('${u.id}')">Editar</button></td>
    </tr>
  `).join('');
}

window.editUser = function(userId) {
  const u = state.users.find(item => item.id === userId);
  if (!u) return;
  document.getElementById('userFormTitle').textContent = 'Editar Usuario: ' + u.username;
  document.getElementById('editUserId').value = u.id;
  document.getElementById('userUsername').value = u.username;
  document.getElementById('userPassword').value = '';
  document.getElementById('pwdHint').textContent = '(Dejar vacío para conservar actual)';
  document.getElementById('userRole').value = u.role;
  document.getElementById('userActive').value = String(u.active);
  document.getElementById('btnCancelEditUser').classList.remove('hidden');
};

async function handleSaveUserSubmit(e) {
  e.preventDefault();
  try {
    const res = await apiCall('saveUser', {
      id: document.getElementById('editUserId').value || undefined,
      username: document.getElementById('userUsername').value,
      password: document.getElementById('userPassword').value,
      role: document.getElementById('userRole').value,
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
  document.getElementById('userFormTitle').textContent = 'Nuevo Usuario (Vendedor / Admin)';
  document.getElementById('pwdHint').textContent = '(Mínimo 6 caracteres)';
  document.getElementById('btnCancelEditUser').classList.add('hidden');
}

function parseNumberRanges(str) {
  const nums = [];
  str.split(',').forEach(part => {
    const clean = part.trim();
    if (clean.includes('-')) {
      const [start, end] = clean.split('-').map(Number);
      if (start && end && start <= end) {
        for (let i = start; i <= end; i++) nums.push(i);
      }
    } else if (Number(clean)) {
      nums.push(Number(clean));
    }
  });
  return nums;
}

function populateConfigForm() {
  const c = state.config;
  document.getElementById('cfgTitle').value = c.title || '';
  document.getElementById('cfgSubtitle').value = c.subtitle || '';
  document.getElementById('cfgTotalTickets').value = c.totalTickets || 100;
  document.getElementById('cfgTicketPrice').value = c.ticketPrice || 50;
  document.getElementById('cfgPromoText').value = c.promoText || '';
  document.getElementById('cfgPrizesText').value = c.prizesText || '';
  document.getElementById('cfgReasonText').value = c.reasonText || '';
  document.getElementById('cfgEventDate').value = c.eventDate || '';
  document.getElementById('cfgReservationHours').value = c.reservationHours || 24;
  document.getElementById('cfgAnnouncementMethod').value = c.announcementMethod || '';
  document.getElementById('cfgWinnerMethod').value = c.winnerMethod || '';
  document.getElementById('cfgAutoReleaseExpired').checked = Boolean(c.autoReleaseExpired);

  document.getElementById('cfgColsDesktop').value = c.gridColsDesktop || 10;
  document.getElementById('cfgColsMobile').value = c.gridColsMobile || 5;
  document.getElementById('cfgPrimaryColor').value = c.primaryColor || '#2563eb';
  document.getElementById('cfgAccentColor').value = c.accentColor || '#10b981';
  document.getElementById('cfgHeaderFontSize').value = c.headerFontSize || 26;
  document.getElementById('cfgBodyFontSize').value = c.bodyFontSize || 15;
  document.getElementById('cfgPadTop').value = c.headerPadTop ?? 24;
  document.getElementById('cfgPadBottom').value = c.headerPadBottom ?? 24;
  document.getElementById('cfgPadLeft').value = c.headerPadLeft ?? 16;
  document.getElementById('cfgPadRight').value = c.headerPadRight ?? 16;

  state.tempConfigImages = [...(c.images || [])];
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
        renderConfigImagesList();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleSaveConfigSubmit(e) {
  e.preventDefault();
  try {
    const res = await apiCall('updateConfig', {
      title: document.getElementById('cfgTitle').value,
      subtitle: document.getElementById('cfgSubtitle').value,
      totalTickets: Number(document.getElementById('cfgTotalTickets').value),
      ticketPrice: Number(document.getElementById('cfgTicketPrice').value),
      promoText: document.getElementById('cfgPromoText').value,
      prizesText: document.getElementById('cfgPrizesText').value,
      reasonText: document.getElementById('cfgReasonText').value,
      eventDate: document.getElementById('cfgEventDate').value,
      reservationHours: Number(document.getElementById('cfgReservationHours').value),
      announcementMethod: document.getElementById('cfgAnnouncementMethod').value,
      winnerMethod: document.getElementById('cfgWinnerMethod').value,
      autoReleaseExpired: document.getElementById('cfgAutoReleaseExpired').checked,
      gridColsDesktop: Number(document.getElementById('cfgColsDesktop').value),
      gridColsMobile: Number(document.getElementById('cfgColsMobile').value),
      primaryColor: document.getElementById('cfgPrimaryColor').value,
      accentColor: document.getElementById('cfgAccentColor').value,
      headerFontSize: Number(document.getElementById('cfgHeaderFontSize').value),
      bodyFontSize: Number(document.getElementById('cfgBodyFontSize').value),
      headerPadTop: Number(document.getElementById('cfgPadTop').value),
      headerPadBottom: Number(document.getElementById('cfgPadBottom').value),
      headerPadLeft: Number(document.getElementById('cfgPadLeft').value),
      headerPadRight: Number(document.getElementById('cfgPadRight').value),
      images: state.tempConfigImages
    });
    showToast(res.message, 'success');
    await syncData(true);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderHistory() {
  document.getElementById('historyTableBody').innerHTML = state.history.map(h => `
    <tr>
      <td>${formatDate(h.fecha)}</td>
      <td><strong>${escapeHtml(h.usuario)}</strong></td>
      <td>${escapeHtml(h.rol)}</td>
      <td><span class="tag tag-disp">${escapeHtml(h.accion)}</span></td>
      <td>${escapeHtml(String(h.boleto))}</td>
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
  document.getElementById('btnManualSync').addEventListener('click', () => syncData(true));

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
        perVendor: Number(document.getElementById('autoAssignCount').value),
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

  document.getElementById('btnManualAssign').addEventListener('click', async () => {
    try {
      const numbers = parseNumberRanges(document.getElementById('manualAssignInput').value);
      const res = await apiCall('assignTickets', {
        mode: 'manual',
        userId: document.getElementById('manualAssignVendor').value,
        numbers
      });
      document.getElementById('manualAssignInput').value = '';
      showToast(res.message, 'success');
      await syncData(true);
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('configForm').addEventListener('submit', handleSaveConfigSubmit);
  document.getElementById('prizeImageFile').addEventListener('change', handlePrizeImageUpload);

  document.getElementById('btnPickWinner').addEventListener('click', async () => {
    const onlyPaid = document.getElementById('winnerOnlyPaid').checked;
    if (!confirm('¿Confirmas seleccionar un número ganador aleatorio ahora?')) return;
    try {
      const res = await apiCall('pickWinner', { onlyPaid });
      const w = res.winner;
      const box = document.getElementById('winnerResultBox');
      box.classList.remove('hidden');
      box.innerHTML = `
        <h2>🎉 Boleto #${w.numero}</h2>
        <p><strong>Participante:</strong> ${escapeHtml(w.participante)}</p>
        <p><strong>Teléfono:</strong> ${escapeHtml(w.telefono)}</p>
        <p><strong>Vendedor:</strong> ${escapeHtml(w.vendedor)}</p>
        <small>${formatDate(w.selectedAt)}</small>
      `;
      showToast('Ganador seleccionado: #' + w.numero, 'success');
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

  document.getElementById('btnConfigEndpoint').addEventListener('click', () => {
    document.getElementById('gasUrlInput').value = state.endpoint.includes('REEMPLAZA') ? '' : state.endpoint;
    document.getElementById('endpointModal').classList.remove('hidden');
  });

  document.getElementById('endpointForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = document.getElementById('gasUrlInput').value.trim();
    state.endpoint = url;
    localStorage.setItem('rifas_gas_url', url);
    closeModal('endpointModal');
    showToast('URL del backend guardada.', 'success');
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
  setTimeout(() => el.remove(), 4000);
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
