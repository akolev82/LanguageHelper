const vscode = acquireVsCodeApi();
const initialData = window.__INITIAL_DATA__ || { rows: [], locales: [] };
let rows = initialData.rows;
let locales = initialData.locales;

// Primary key helper: (file, key) is the unique primary key for each row
const getRowId = (r) => (r.file || '') + ':::' + (r.key || '');

// DOM elements
const headerRow = document.getElementById('headerRow');
const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('searchInput');
const statusFilterSelect = document.getElementById('statusFilterSelect');
const moduleFilterSelect = document.getElementById('moduleFilterSelect');
const saveBtn = document.getElementById('saveBtn');
const addRowBtn = document.getElementById('addRowBtn');
const addModuleBtn = document.getElementById('addModuleBtn');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const bulkMoveBtn = document.getElementById('bulkMoveBtn');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const unsavedBanner = document.getElementById('unsavedBanner');

// Panel elements
const leftContainer = document.getElementById('leftContainer');
const panelSplitter = document.getElementById('panelSplitter');
const rightPanel = document.getElementById('rightPanel');
const panelTitle = document.getElementById('panelTitle');
const panelSubtitle = document.getElementById('panelSubtitle');
const panelLocalesContainer = document.getElementById('panelLocalesContainer');
const panelLocaleSearchInput = document.getElementById('panelLocaleSearchInput');

const addModal = document.getElementById('addModal');
const newFile = document.getElementById('newFile');
const newKey = document.getElementById('newKey');
const localeInputsContainer = document.getElementById('localeInputsContainer');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const confirmAddBtn = document.getElementById('confirmAddBtn');

const addModuleModal = document.getElementById('addModuleModal');
const newModuleName = document.getElementById('newModuleName');
const cancelAddModuleBtn = document.getElementById('cancelAddModuleBtn');
const confirmAddModuleBtn = document.getElementById('confirmAddModuleBtn');

const bulkMoveModal = document.getElementById('bulkMoveModal');
const bulkMoveModuleSelect = document.getElementById('bulkMoveModuleSelect');
const cancelBulkMoveBtn = document.getElementById('cancelBulkMoveBtn');
const confirmBulkMoveBtn = document.getElementById('confirmBulkMoveBtn');

const deleteConfirmModal = document.getElementById('deleteConfirmModal');
const deleteConfirmMessage = document.getElementById('deleteConfirmMessage');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

const editModal = document.getElementById('editModal');
const editModuleSelect = document.getElementById('editModuleSelect');
const editKey = document.getElementById('editKey');
const editLocaleInputsContainer = document.getElementById('editLocaleInputsContainer');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const confirmEditBtn = document.getElementById('confirmEditBtn');

const conflictModal = document.getElementById('conflictModal');
const conflictModalDesc = document.getElementById('conflictModalDesc');
const conflictTableBody = document.getElementById('conflictTableBody');
const conflictKeepAllLocalBtn = document.getElementById('conflictKeepAllLocalBtn');
const conflictAcceptAllDiskBtn = document.getElementById('conflictAcceptAllDiskBtn');
const confirmConflictResolutionBtn = document.getElementById('confirmConflictResolutionBtn');

// State tracking
const originalRows = new Map(); // rowId -> JSON string of translations
rows.forEach(r => originalRows.set(getRowId(r), JSON.stringify(r.translations)));

const addedKeys = new Set(); // rowId set for newly added items
const selectedRowIds = new Set(); // rowId set for selected rows
let pendingDeleteRows = [];
let editingRowId = null;
let currentConflictsData = null;
let activeRowId = null; // currently selected row for the right panel

const emptyModules = new Set(); // tracks empty modules that don't have keys yet

// Splitter state
let isDragging = false;
let startX, startWidth;

// Initialize splitter width from vscode state if available
const lastState = vscode.getState();
if (lastState && lastState.leftContainerWidth) {
  leftContainer.style.flex = 'none';
  leftContainer.style.width = lastState.leftContainerWidth + 'px';
}

panelSplitter.addEventListener('mousedown', (e) => {
  isDragging = true;
  startX = e.clientX;
  startWidth = leftContainer.getBoundingClientRect().width;
  panelSplitter.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const newWidth = startWidth + (e.clientX - startX);
  if (newWidth > 200 && newWidth < window.innerWidth - 200) {
    leftContainer.style.flex = 'none';
    leftContainer.style.width = newWidth + 'px';
  }
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    panelSplitter.classList.remove('dragging');
    document.body.style.cursor = 'default';
    vscode.setState({ leftContainerWidth: leftContainer.getBoundingClientRect().width });
  }
});

function getRowStatus(row) {
  const id = getRowId(row);
  if (addedKeys.has(id)) return 'new';
  const orig = originalRows.get(id);
  if (orig === undefined || orig !== JSON.stringify(row.translations)) return 'modified';
  return 'saved';
}

function updateUnsavedStatus() {
  const hasUnsaved = rows.some(r => getRowStatus(r) !== 'saved');
  if (hasUnsaved) unsavedBanner.classList.add('show');
  else unsavedBanner.classList.remove('show');
}

// Setup Headers & Inputs
const thStatus = document.createElement('th');
thStatus.className = 'col-status'; thStatus.textContent = 'Status'; headerRow.appendChild(thStatus);
const thActions = document.createElement('th');
thActions.className = 'col-actions'; thActions.textContent = 'Action'; headerRow.appendChild(thActions);

locales.forEach(loc => {
  const divAdd = document.createElement('div');
  divAdd.className = 'form-group';
  divAdd.innerHTML = '<label for="newVal_' + loc + '">Translation (' + loc.toUpperCase() + ')</label>' +
    '<input type="text" id="newVal_' + loc + '" placeholder="Value for ' + loc + '" />';
  localeInputsContainer.appendChild(divAdd);

  const divEdit = document.createElement('div');
  divEdit.className = 'form-group';
  divEdit.innerHTML = '<label for="editVal_' + loc + '">Translation (' + loc.toUpperCase() + ')</label>' +
    '<input type="text" id="editVal_' + loc + '" placeholder="Value for ' + loc + '" />';
  editLocaleInputsContainer.appendChild(divEdit);
});

function updateModuleSelects() {
  const modules = Array.from(new Set([...rows.map(r => r.file), ...emptyModules])).sort();
  const currentFilter = moduleFilterSelect.value;
  moduleFilterSelect.innerHTML = '<option value="">All Modules (Files)</option>';
  newFile.innerHTML = '<option value="" disabled selected>Select a module...</option>';
  editModuleSelect.innerHTML = ''; bulkMoveModuleSelect.innerHTML = '';
  modules.forEach(mod => {
    [moduleFilterSelect, newFile, editModuleSelect, bulkMoveModuleSelect].forEach(select => {
      const opt = document.createElement('option');
      opt.value = mod; opt.textContent = mod; select.appendChild(opt);
    });
  });
  if (modules.includes(currentFilter)) moduleFilterSelect.value = currentFilter;
}

function updateSelectionUI() {
  const count = selectedRowIds.size;
  deleteSelectedBtn.disabled = count === 0;
  deleteSelectedBtn.textContent = count > 1 ? 'Delete Selected (' + count + ')' : 'Delete Selected';
  bulkMoveBtn.disabled = count === 0;
  bulkMoveBtn.textContent = count > 1 ? 'Move to Module (' + count + ')' : 'Move to Module';
}

let currentPage = 1;
let pageSize = 50;
const pageSizeSelect = document.getElementById('pageSizeSelect');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageIndicator = document.getElementById('pageIndicator');
const paginationInfo = document.getElementById('paginationInfo');

pageSizeSelect.addEventListener('change', (e) => {
  pageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
  currentPage = 1; renderTable();
});
prevPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
nextPageBtn.addEventListener('click', () => { currentPage++; renderTable(); });

selectAllCheckbox.addEventListener('change', (e) => {
  const isChecked = e.target.checked;
  rows.forEach(r => {
    const id = getRowId(r);
    if (isChecked) selectedRowIds.add(id); else selectedRowIds.delete(id);
  });
  renderTable();
});

function renderTable(filterText = searchInput.value) {
  tableBody.innerHTML = '';
  const lowerFilter = filterText.toLowerCase();
  const selectedModule = moduleFilterSelect.value;
  const selectedStatus = statusFilterSelect.value;

  if (selectedStatus) statusFilterSelect.classList.add('filter-active');
  else statusFilterSelect.classList.remove('filter-active');
  
  if (selectedModule) moduleFilterSelect.classList.add('filter-active');
  else moduleFilterSelect.classList.remove('filter-active');

  updateModuleSelects();
  updateUnsavedStatus();

  const filteredRows = rows.filter(row => {
    if (selectedModule && row.file !== selectedModule) return false;
    const status = getRowStatus(row);
    if (selectedStatus === 'unsaved' && status === 'saved') return false;
    if (selectedStatus === 'modified' && status !== 'modified') return false;
    if (selectedStatus === 'new' && status !== 'new') return false;
    if (filterText) {
      return (row.file || '').toLowerCase().includes(lowerFilter) ||
        (row.key || '').toLowerCase().includes(lowerFilter) ||
        Object.values(row.translations || {}).some(v => (v || '').toString().toLowerCase().includes(lowerFilter));
    }
    return true;
  });

  const totalItems = filteredRows.length;
  const effectivePageSize = pageSize === 'all' ? totalItems : pageSize;
  const totalPages = effectivePageSize > 0 ? Math.ceil(totalItems / effectivePageSize) || 1 : 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * effectivePageSize;
  const endIndex = pageSize === 'all' ? totalItems : Math.min(startIndex + effectivePageSize, totalItems);
  const pageRows = filteredRows.slice(startIndex, endIndex);

  paginationInfo.textContent = 'Showing ' + (totalItems > 0 ? startIndex + 1 : 0) + '-' + endIndex + ' of ' + totalItems + ' items';
  pageIndicator.textContent = 'Page ' + currentPage + ' of ' + totalPages;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;

  pageRows.forEach((row) => {
    const id = getRowId(row);
    const status = getRowStatus(row);
    const isSelected = selectedRowIds.has(id);

    const tr = document.createElement('tr');
    if (activeRowId === id) tr.classList.add('row-active');
    
    if (isSelected) tr.classList.add('row-checked');
    else if (status === 'new') tr.classList.add('row-added');
    else if (status === 'modified') tr.classList.add('row-modified');

    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') return;
      if (e.target.closest('button')) return;
      activeRowId = id;
      renderTable(searchInput.value);
      renderRightPanel();
    });

    const tdSelect = document.createElement('td'); tdSelect.className = 'col-select';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isSelected;
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) selectedRowIds.add(id); else selectedRowIds.delete(id);
      renderTable(searchInput.value);
    });
    tdSelect.appendChild(cb); tr.appendChild(tdSelect);

    const tdFile = document.createElement('td'); tdFile.textContent = row.file; tdFile.className = 'col-file'; tr.appendChild(tdFile);
    const tdKey = document.createElement('td'); tdKey.textContent = row.key; tdKey.className = 'col-key'; tr.appendChild(tdKey);

    const tdStatus = document.createElement('td'); tdStatus.className = 'col-status';
    const spanBadge = document.createElement('span');
    spanBadge.className = 'badge ' + (status === 'new' ? 'badge-added' : status === 'modified' ? 'badge-modified' : 'badge-saved');
    spanBadge.textContent = status === 'new' ? 'New' : status === 'modified' ? 'Modified' : 'Saved';
    tdStatus.appendChild(spanBadge); tr.appendChild(tdStatus);



    const tdActions = document.createElement('td'); tdActions.className = 'col-actions';
    const editBtn = document.createElement('button'); editBtn.className = 'btn-row-action edit';
    editBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 2 10.293V14h3.707l7.793-7.793zM1 15v-1h14v1H1z"/></svg>';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(row); });
    tdActions.appendChild(editBtn);

    const delBtn = document.createElement('button'); delBtn.className = 'btn-row-action delete';
    delBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); promptDeleteRows([row]); });
    tdActions.appendChild(delBtn);

    tr.appendChild(tdActions); tableBody.appendChild(tr);
  });
  updateSelectionUI();
}

const editModalError = document.getElementById('editModalError');

function openEditModal(row) {
  editModalError.textContent = '';
  editingRowId = getRowId(row);
  editModuleSelect.value = row.file;
  editKey.value = row.key;
  locales.forEach(loc => {
    document.getElementById('editVal_' + loc).value = row.translations[loc] || '';
  });
  editModal.classList.add('show');
}
cancelEditBtn.addEventListener('click', () => { editModal.classList.remove('show'); });
confirmEditBtn.addEventListener('click', () => {
  editModalError.textContent = '';
  if (!editModuleSelect.value) {
    editModalError.textContent = 'Please select a module.';
    return;
  }
  const keyVal = editKey.value.trim();
  if (!keyVal) {
    editModalError.textContent = 'Please enter a key.';
    return;
  }
  const rowToEdit = rows.find(r => getRowId(r) === editingRowId);
  if (rows.some(r => r.key === keyVal && r !== rowToEdit)) {
    editModalError.textContent = 'This key already exists. Keys must be globally unique.';
    return;
  }
  let missingLocale = false;
  locales.forEach(loc => {
    if (!document.getElementById('editVal_' + loc).value.trim()) missingLocale = true;
  });
  if (missingLocale) {
    editModalError.textContent = 'Please provide translations for all locales.';
    return;
  }

  const row = rows.find(r => getRowId(r) === editingRowId);
  if (row) {
    const oldId = getRowId(row);
    row.file = editModuleSelect.value;
    row.key = editKey.value.trim();
    const newId = getRowId(row);
    locales.forEach(loc => { row.translations[loc] = document.getElementById('editVal_' + loc).value; });

    if (oldId !== newId) {
      if (addedKeys.has(oldId)) { addedKeys.delete(oldId); addedKeys.add(newId); }
      if (selectedRowIds.has(oldId)) { selectedRowIds.delete(oldId); selectedRowIds.add(newId); }
    }
    editModal.classList.remove('show'); renderTable(); renderRightPanel();
  }
});

function promptDeleteRows(targetRows) {
  pendingDeleteRows = targetRows;
  deleteConfirmMessage.textContent = targetRows.length === 1 ? 'Are you sure you want to delete translation key "' + targetRows[0].key + '"?' : 'Are you sure you want to delete ' + targetRows.length + ' items?';
  deleteConfirmModal.classList.add('show');
}
cancelDeleteBtn.addEventListener('click', () => { deleteConfirmModal.classList.remove('show'); });
confirmDeleteBtn.addEventListener('click', () => {
  const targetIds = new Set(pendingDeleteRows.map(getRowId));
  rows = rows.filter(r => !targetIds.has(getRowId(r)));
  targetIds.forEach(id => { selectedRowIds.delete(id); addedKeys.delete(id); originalRows.delete(id); });
  deleteConfirmModal.classList.remove('show');
  renderTable();
});
deleteSelectedBtn.addEventListener('click', () => {
  const selectedRows = rows.filter(r => selectedRowIds.has(getRowId(r)));
  if (selectedRows.length > 0) promptDeleteRows(selectedRows);
});

bulkMoveBtn.addEventListener('click', () => { bulkMoveModal.classList.add('show'); });
cancelBulkMoveBtn.addEventListener('click', () => { bulkMoveModal.classList.remove('show'); });
confirmBulkMoveBtn.addEventListener('click', () => {
  const targetModule = bulkMoveModuleSelect.value;
  rows.forEach(r => {
    if (selectedRowIds.has(getRowId(r))) {
      r.file = targetModule;
    }
  });
  bulkMoveModal.classList.remove('show');
  selectedRowIds.clear();
  renderTable();
});

addModuleBtn.addEventListener('click', () => { addModuleModal.classList.add('show'); });
cancelAddModuleBtn.addEventListener('click', () => { addModuleModal.classList.remove('show'); });
confirmAddModuleBtn.addEventListener('click', () => {
  const mod = newModuleName.value.trim();
  if (mod) {
    vscode.postMessage({ command: 'createModule', moduleName: mod });
    emptyModules.add(mod);
  }
  addModuleModal.classList.remove('show'); renderTable();
});

const addModalError = document.getElementById('addModalError');

addRowBtn.addEventListener('click', () => { 
  addModalError.textContent = '';
  addModal.classList.add('show'); 
});
cancelAddBtn.addEventListener('click', () => { addModal.classList.remove('show'); });
confirmAddBtn.addEventListener('click', () => {
  addModalError.textContent = '';
  if (!newFile.value) {
    addModalError.textContent = 'Please select a module.';
    return;
  }
  const keyVal = newKey.value.trim();
  if (!keyVal) {
    addModalError.textContent = 'Please enter a key.';
    return;
  }
  if (rows.some(r => r.key === keyVal)) {
    addModalError.textContent = 'This key already exists. Keys must be globally unique.';
    return;
  }
  
  const trans = {};
  let missingLocale = false;
  locales.forEach(l => {
    const val = document.getElementById('newVal_' + l).value;
    if (!val.trim()) missingLocale = true;
    trans[l] = val;
  });
  
  if (missingLocale) {
    addModalError.textContent = 'Please provide translations for all locales.';
    return;
  }

  const newRow = { file: newFile.value, key: newKey.value.trim(), translations: trans };
  rows.push(newRow);
  addedKeys.add(getRowId(newRow));
  addModal.classList.remove('show'); renderTable();
});

window.addEventListener('message', event => {
  const message = event.data;
  if (message.command === 'externalFileChanged') {
    const { file: fileBasename, locale, relativePath, items: incomingItems, fileContent } = message;
    const diskItemsMap = new Map();
    incomingItems.forEach(it => diskItemsMap.set(it.key, it.value));

    const hasUnsavedInFile = rows.some(r => r.file === fileBasename && getRowStatus(r) !== 'saved');

    if (!hasUnsavedInFile) {
      rows.forEach(r => {
        if (r.file === fileBasename && diskItemsMap.has(r.key)) {
          r.translations[locale] = diskItemsMap.get(r.key);
          diskItemsMap.delete(r.key);
        }
      });
      for (const [key, val] of diskItemsMap.entries()) {
        const trans = Object.fromEntries(locales.map(l => [l, '']));
        trans[locale] = val;
        const newRow = { file: fileBasename, key, translations: trans };
        rows.push(newRow);
      }
      rows.forEach(r => {
        if (r.file === fileBasename) {
          originalRows.set(getRowId(r), JSON.stringify(r.translations));
        }
      });
      vscode.postMessage({ command: 'updateRawFileContent', relativePath, fileContent });
      renderTable();
      return;
    }

    const conflicts = [];
    const processedKeys = new Set();
    rows.forEach(row => {
      if (row.file === fileBasename) {
        processedKeys.add(row.key);
        const localVal = row.translations[locale] || '';
        const diskVal = diskItemsMap.has(row.key) ? diskItemsMap.get(row.key) : '(Deleted on disk)';
        if (localVal !== diskVal) {
          conflicts.push({
            file: fileBasename, key: row.key, locale, localValue: localVal, diskValue: diskVal,
            type: diskItemsMap.has(row.key) ? 'modified' : 'deleted_on_disk'
          });
        }
      }
    });

    for (const [diskKey, diskVal] of diskItemsMap.entries()) {
      if (!processedKeys.has(diskKey)) {
        conflicts.push({
          file: fileBasename, key: diskKey, locale, localValue: '(Not present locally)', diskValue: diskVal, type: 'added_on_disk'
        });
      }
    }

    if (conflicts.length > 0) {
      openConflictModal(conflicts, { fileBasename, locale, relativePath, fileContent, incomingItems });
    } else {
      vscode.postMessage({ command: 'updateRawFileContent', relativePath, fileContent });
      renderTable();
    }
  }
});

function openConflictModal(conflicts, contextData) {
  currentConflictsData = { conflicts, contextData };
  conflictTableBody.innerHTML = '';
  conflictModalDesc.textContent = "External changes were detected in module \"" + contextData.fileBasename + "\" (" + contextData.locale.toUpperCase() + "), but you have unsaved local changes. Select how to resolve each conflict below:";
  conflicts.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--vscode-widget-border, #444)';
    const tdKey = document.createElement('td'); tdKey.style.padding = '6px'; tdKey.style.fontWeight = '600'; tdKey.textContent = c.key;
    const tdLoc = document.createElement('td'); tdLoc.style.padding = '6px'; tdLoc.textContent = c.locale.toUpperCase();
    const tdLocal = document.createElement('td'); tdLocal.style.padding = '6px'; tdLocal.style.color = '#fde047'; tdLocal.textContent = c.localValue;
    const tdDisk = document.createElement('td'); tdDisk.style.padding = '6px'; tdDisk.style.color = '#4ade80'; tdDisk.textContent = c.diskValue;
    const tdRes = document.createElement('td'); tdRes.style.padding = '6px';
    const select = document.createElement('select'); select.className = 'select-box conflict-resolution-select'; select.id = 'conflictSelect_' + i; select.style.padding = '4px 6px'; select.style.fontSize = '0.8rem';
    const optLocal = document.createElement('option'); optLocal.value = 'local'; optLocal.textContent = 'Keep Local';
    const optDisk = document.createElement('option'); optDisk.value = 'disk'; optDisk.textContent = 'Accept Disk';
    select.appendChild(optLocal); select.appendChild(optDisk);
    tdRes.appendChild(select);
    tr.appendChild(tdKey); tr.appendChild(tdLoc); tr.appendChild(tdLocal); tr.appendChild(tdDisk); tr.appendChild(tdRes);
    conflictTableBody.appendChild(tr);
  });
  conflictModal.classList.add('show');
}

conflictKeepAllLocalBtn.addEventListener('click', () => { document.querySelectorAll('.conflict-resolution-select').forEach(s => s.value = 'local'); });
conflictAcceptAllDiskBtn.addEventListener('click', () => { document.querySelectorAll('.conflict-resolution-select').forEach(s => s.value = 'disk'); });
confirmConflictResolutionBtn.addEventListener('click', () => {
  if (!currentConflictsData) return;
  const { conflicts, contextData } = currentConflictsData;
  conflicts.forEach((c, i) => {
    const select = document.getElementById('conflictSelect_' + i);
    const choice = select ? select.value : 'local';
    let row = rows.find(r => r.file === c.file && r.key === c.key);
    if (choice === 'disk') {
      if (row) {
        row.translations[c.locale] = c.diskValue;
      } else {
        const trans = Object.fromEntries(locales.map(l => [l, '']));
        trans[c.locale] = c.diskValue;
        rows.push({ file: c.file, key: c.key, translations: trans });
      }
    }
  });
  vscode.postMessage({ command: 'updateRawFileContent', relativePath: contextData.relativePath, fileContent: contextData.fileContent });
  conflictModal.classList.remove('show');
  currentConflictsData = null;
  renderTable();
});

[statusFilterSelect, moduleFilterSelect].forEach(s => s.addEventListener('change', () => { currentPage = 1; renderTable(); }));
searchInput.addEventListener('input', (e) => { currentPage = 1; renderTable(e.target.value); });
saveBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'save', rows });
  addedKeys.clear();
  originalRows.clear();
  rows.forEach(r => originalRows.set(getRowId(r), JSON.stringify(r.translations)));
  renderTable();
  renderRightPanel();
});

panelLocaleSearchInput.addEventListener('input', () => {
  renderRightPanel();
});

function renderRightPanel() {
  if (!activeRowId) {
    panelTitle.textContent = 'No Item Selected';
    panelSubtitle.textContent = 'Select a row in the table to edit all locale translations';
    panelLocaleSearchInput.style.display = 'none';
    panelLocalesContainer.innerHTML = '<div class="empty-selection-placeholder"><span>👈 Click any key on the left to edit translations for all locales</span></div>';
    return;
  }
  
  const row = rows.find(r => getRowId(r) === activeRowId);
  if (!row) {
    activeRowId = null;
    renderRightPanel();
    return;
  }

  panelTitle.textContent = row.key;
  panelSubtitle.textContent = row.file;
  panelLocaleSearchInput.style.display = 'block';
  
  const searchQuery = panelLocaleSearchInput.value.toLowerCase();
  
  panelLocalesContainer.innerHTML = '';
  locales.forEach(loc => {
    if (searchQuery && !loc.toLowerCase().includes(searchQuery)) return;
    
    const origStr = originalRows.get(activeRowId);
    let origVal = '';
    if (origStr) {
      try {
        const parsed = JSON.parse(origStr);
        origVal = parsed[loc] || '';
      } catch (e) {}
    }
    const currentVal = row.translations[loc] || '';
    const isDirty = origVal !== currentVal;

    const card = document.createElement('div');
    card.className = 'locale-card';
    
    const header = document.createElement('div');
    header.className = 'locale-card-header';
    
    const titleSpan = document.createElement('span');
    titleSpan.className = 'locale-name';
    titleSpan.textContent = loc.toUpperCase();
    
    const dirtySpan = document.createElement('span');
    dirtySpan.className = 'locale-dirty-indicator' + (isDirty ? ' dirty' : '');
    dirtySpan.textContent = '• Modified';
    
    header.appendChild(titleSpan);
    header.appendChild(dirtySpan);
    
    const input = document.createElement('textarea');
    input.className = 'locale-input';
    input.value = currentVal;
    input.placeholder = `Translation for ${loc}`;
    input.addEventListener('input', (e) => {
      row.translations[loc] = e.target.value;
      const newIsDirty = origVal !== e.target.value;
      if (newIsDirty) {
        dirtySpan.classList.add('dirty');
      } else {
        dirtySpan.classList.remove('dirty');
      }
      renderTable(searchInput.value);
    });
    
    card.appendChild(header);
    card.appendChild(input);
    panelLocalesContainer.appendChild(card);
  });
}

renderTable();
renderRightPanel();
