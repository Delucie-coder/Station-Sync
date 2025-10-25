// SPIRO Station Manager - app.js
// Keep data in localStorage under key "spiro_stations_v1"

const STORAGE_KEY = 'spiro_stations_v1';

// ---------- Utilities ----------
function uid() {
  return 'S' + Date.now().toString(36).slice(-6).toUpperCase();
}

function qs(id){ return document.getElementById(id); }
function saveStations(list){ localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
function loadStations(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e){ return []; } }

// ---------- App State ----------
let stations = loadStations();
let isCards = true; // toggle view

// ---------- DOM Elements ----------
const stationForm = qs('stationForm');
const resetFormBtn = qs('resetForm');
const cardsView = qs('cardsView');
const tableBody = document.querySelector('#stationsTable tbody');
const searchInput = qs('searchInput');
const filterType = qs('filterType');
const filterStatus = qs('filterStatus');
const toggleViewBtn = qs('toggleView');
const exportCsvBtn = qs('exportCsvBtn');

// Modal elements
const modal = qs('modal');
const modalClose = qs('modalClose');
const modalForm = qs('modalForm');
const modalStationId = qs('modalStationId');
const modalTitle = qs('modalTitle');
const modalDelete = qs('modalDelete');

// Chart
let chart = null;

// ---------- Initial sample data (only if empty) ----------
if (stations.length === 0) {
  stations = [
    { id: uid(), name: 'Kigali Central', contact: '0788000001', location: 'Kigali', type: 'Service', batteryCount: 12, status: 'Active', createdAt: new Date().toISOString() },
    { id: uid(), name: 'Musanze Depot', contact: '0788000002', location: 'Musanze', type: 'Assembly', batteryCount: 8, status: 'Active', createdAt: new Date().toISOString() },
    { id: uid(), name: 'Old Warehouse A', contact: '0788000003', location: 'Butare', type: 'Old Warehouse', batteryCount: 5, status: 'Inactive', createdAt: new Date().toISOString() }
  ];
  saveStations(stations);
}

// ---------- Rendering ----------
function render() {
  // Apply filters and search
  const q = searchInput.value.trim().toLowerCase();
  const typeF = filterType.value;
  const statusF = filterStatus.value;

  let filtered = stations.filter(s => {
    if (typeF && s.type !== typeF) return false;
    if (statusF && s.status !== statusF) return false;
    if (!q) return true;
    return (s.name + ' ' + s.id + ' ' + s.location).toLowerCase().includes(q);
  });

  // Render cards
  cardsView.innerHTML = '';
  filtered.forEach(s => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="title">${escapeHtml(s.name)} <small style="color:var(--muted);font-weight:400">(${s.id})</small></div>
      <div>${escapeHtml(s.location)} · <em>${escapeHtml(s.type)}</em></div>
      <div style="margin:8px 0"><span class="tag ${s.status.toLowerCase()}">${s.status}</span></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <div style="font-size:13px;color:var(--muted)">${s.batteryCount} batteries</div>
        <div>
          <button class="btn" data-action="view" data-id="${s.id}"><i class="fa-solid fa-eye"></i></button>
          <button class="btn" data-action="edit" data-id="${s.id}"><i class="fa-solid fa-pen-to-square"></i></button>
        </div>
      </div>
    `;
    cardsView.appendChild(div);
  });

  // Render table
  tableBody.innerHTML = '';
  filtered.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.location)}</td>
      <td>${escapeHtml(s.type)}</td>
      <td>${s.batteryCount}</td>
      <td><span class="tag ${s.status.toLowerCase()}">${s.status}</span></td>
      <td class="actions">
        <button class="btn" data-action="view" data-id="${s.id}"><i class="fa-solid fa-eye"></i></button>
        <button class="btn" data-action="edit" data-id="${s.id}"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="btn danger" data-action="delete" data-id="${s.id}"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  // Update chart
  updateChart(filtered);

  // toggle view
  document.querySelectorAll('.table-wrapper')[0].style.display = isCards ? 'none' : 'block';
  cardsView.style.display = isCards ? 'grid' : 'none';
  toggleViewBtn.textContent = isCards ? 'Show Table' : 'Show Cards';
}

// small escape function
function escapeHtml(str='') {
  return String(str).replace(/[&<>"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]});
}

// ---------- Chart ----------
function updateChart(list) {
  const countsByType = {};
  list.forEach(s => countsByType[s.type] = (countsByType[s.type] || 0) + (Number(s.batteryCount)||0));
  const labels = Object.keys(countsByType);
  const data = labels.map(l => countsByType[l]);

  const ctx = qs('stationsChart').getContext('2d');
  if (chart) { chart.data.labels = labels; chart.data.datasets[0].data = data; chart.update(); return; }

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Batteries by Station Type',
        data,
        backgroundColor: [ '#06b6b4', '#0891b2', '#0ea5a6' ]
      }]
    },
    options: {
      responsive:true,
      plugins:{ legend:{ display:false } },
      scales:{ y:{ beginAtZero:true } }
    }
  });
}

// ---------- Form actions ----------
stationForm.addEventListener('submit', e => {
  e.preventDefault();
  const name = qs('stationName').value.trim();
  const contact = qs('stationContact').value.trim();
  const location = qs('stationLocation').value.trim();
  const type = qs('stationType').value;
  const batteryCount = Number(qs('batteryCount').value) || 0;
  const status = qs('stationStatus').value;

  const newStation = {
    id: uid(),
    name, contact, location, type, batteryCount, status,
    createdAt: new Date().toISOString()
  };
  stations.unshift(newStation);
  saveStations(stations);
  stationForm.reset();
  render();
});

resetFormBtn.addEventListener('click', () => stationForm.reset());

// Search / filters
[searchInput, filterType, filterStatus].forEach(el => el.addEventListener('input', render));

// Toggle view
toggleViewBtn.addEventListener('click', () => { isCards = !isCards; render(); });

// Export CSV
exportCsvBtn.addEventListener('click', () => {
  if (stations.length === 0) return alert('No station data to export.');
  const headers = ['id','name','contact','location','type','batteryCount','status','createdAt'];
  const rows = stations.map(s => headers.map(h => JSON.stringify(s[h] ?? '')).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'spiro_stations.csv'; document.body.appendChild(a); a.click();
  URL.revokeObjectURL(url); a.remove();
});

// ---------- Table / Cards interaction (delegation) ----------
document.body.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!action || !id) return;

  if (action === 'view' || action === 'edit') {
    openModalForStation(id, action === 'edit');
  } else if (action === 'delete') {
    if (!confirm('Delete this station?')) return;
    stations = stations.filter(s => s.id !== id);
    saveStations(stations);
    render();
  }
});

// ---------- Modal logic ----------
function openModalForStation(id, editable=false) {
  const s = stations.find(x => x.id === id);
  if (!s) return;
  modalStationId.value = s.id;
  modalTitle.textContent = editable ? 'Edit Station' : 'Station Details';
  qs('modalName').value = s.name;
  qs('modalContact').value = s.contact;
  qs('modalLocation').value = s.location;
  qs('modalType').value = s.type;
  qs('modalBatteryCount').value = s.batteryCount;
  qs('modalStatus').value = s.status;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
  // if not editable, disable inputs
  [].forEach.call(modalForm.querySelectorAll('input,select'), inp => {
    inp.disabled = !editable;
  });
  modalDelete.style.display = editable ? 'inline-block' : 'none';
}

modalClose.addEventListener('click', closeModal);
function closeModal(){
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden','true');
}

// Save changes
modalForm.addEventListener('submit', e => {
  e.preventDefault();
  const id = modalStationId.value;
  const idx = stations.findIndex(s => s.id === id);
  if (idx === -1) return;
  stations[idx].name = qs('modalName').value.trim();
  stations[idx].contact = qs('modalContact').value.trim();
  stations[idx].location = qs('modalLocation').value.trim();
  stations[idx].type = qs('modalType').value;
  stations[idx].batteryCount = Number(qs('modalBatteryCount').value) || 0;
  stations[idx].status = qs('modalStatus').value;
  saveStations(stations);
  closeModal();
  render();
});

// Delete from modal
modalDelete.addEventListener('click', () => {
  const id = modalStationId.value;
  if (!confirm('Delete this station?')) return;
  stations = stations.filter(s => s.id !== id);
  saveStations(stations);
  closeModal();
  render();
});

// Close modal on backdrop
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

// ---------- Helpers ----------
function init() {
  render();
}
init();
