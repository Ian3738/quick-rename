// ===== PDF.js worker =====
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

// ===== 預設選項 =====
const DEFAULT_CATEGORIES = [
  '發文計畫', '初審建議公簽', '複審建議公簽', '全市備查發文', '手冊',
  '開會通知', '會議記錄',
  '學校總體課程計畫', '特殊教育課程計畫',
  '初審意見表', '複審意見表',
];

const DEFAULT_YEARS = ['110', '111', '112', '113', '114', '115'];

// ===== 狀態 =====
const state = {
  files: [],          // { id, file, type, status, seq, category, year, name, extractedText }
  categories: loadList('rename.categories', DEFAULT_CATEGORIES),
  years: loadList('rename.years', DEFAULT_YEARS),
  nextId: 1,
};

function loadList(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [...fallback];
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
}

// ===== DOM =====
const $ = sel => document.querySelector(sel);
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const pickBtn = $('#pickBtn');
const filesList = $('#filesList');
const filesPanel = $('#filesPanel');
const fileCount = $('#fileCount');
const defaultCategory = $('#defaultCategory');
const defaultYear = $('#defaultYear');
const applyDefaultsBtn = $('#applyDefaultsBtn');
const renumberBtn = $('#renumberBtn');
const manageOptionsBtn = $('#manageOptionsBtn');
const downloadAllBtn = $('#downloadAllBtn');
const clearBtn = $('#clearBtn');
const optionsDialog = $('#optionsDialog');
const categoryChips = $('#categoryChips');
const yearChips = $('#yearChips');
const newCategoryInput = $('#newCategoryInput');
const newYearInput = $('#newYearInput');
const addCategoryBtn = $('#addCategoryBtn');
const addYearBtn = $('#addYearBtn');

// ===== 初始化下拉 =====
function fillSelect(select, items, includeBlank) {
  const cur = select.value;
  select.innerHTML = '';
  if (includeBlank) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— 不套用 —';
    select.appendChild(o);
  }
  items.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = (select === defaultYear || select.dataset.kind === 'year') ? `${v}學年` : v;
    select.appendChild(o);
  });
  if (cur && items.includes(cur)) select.value = cur;
}
fillSelect(defaultCategory, state.categories, true);
fillSelect(defaultYear, state.years, true);

// ===== 上傳互動 =====
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles(e.target.files));

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

// ===== 處理檔案 =====
async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  for (const f of arr) {
    const ext = f.name.toLowerCase().split('.').pop();
    if (!['pdf', 'docx'].includes(ext)) continue;

    const item = {
      id: state.nextId++,
      file: f,
      type: ext,
      status: '讀取中…',
      seq: String(state.files.length + 1).padStart(2, '0'),
      category: '',
      year: '',
      name: '',
      extractedText: '',
    };
    state.files.push(item);
    renderFiles();

    extractText(item).then(text => {
      item.extractedText = text;
      const auto = autoFillFromText(text, f.name);
      if (auto.year && state.years.includes(auto.year)) item.year = auto.year;
      if (auto.category && state.categories.includes(auto.category)) item.category = auto.category;
      if (auto.name) item.name = auto.name;
      item.status = 'ready';
      renderFiles();
    }).catch(err => {
      item.status = '讀取失敗';
      console.error(err);
      renderFiles();
    });
  }
  fileInput.value = '';
}

// ===== 文字抽取 =====
async function extractText(item) {
  const buf = await item.file.arrayBuffer();
  if (item.type === 'pdf') return await extractPdfText(buf);
  if (item.type === 'docx') return await extractDocxText(buf);
  return '';
}

async function extractPdfText(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = Math.min(pdf.numPages, 3);
  let text = '';
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}

async function extractDocxText(buf) {
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value || '';
}

// ===== 自動推論 =====
function autoFillFromText(text, originalName) {
  const out = { year: '', category: '', name: '' };
  const baseName = originalName.replace(/\.[^.]+$/, '');

  // 學年
  const m = text.match(/(\d{2,3})\s*學\s*年/);
  if (m) out.year = m[1];
  else {
    const fn = baseName.match(/(\d{2,3})學年/);
    if (fn) out.year = fn[1];
  }

  // 項目（檔名比對 → 內文比對）
  for (const cat of state.categories) {
    if (baseName.includes(cat)) { out.category = cat; break; }
  }
  if (!out.category) {
    for (const cat of state.categories) {
      if (text.includes(cat)) { out.category = cat; break; }
    }
  }

  // 名稱：找主旨/標題；找不到就用檔名
  out.name = guessTitle(text, baseName, out.year, out.category);
  return out;
}

function guessTitle(text, baseName, year, category) {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  // 主旨：xxx
  const m1 = cleaned.match(/主\s*旨\s*[:：]\s*(.{4,80}?)(?=說\s*明|附\s*件|正\s*本|$|。)/);
  if (m1) return tidy(m1[1]);

  // 案由：xxx
  const m2 = cleaned.match(/案\s*由\s*[:：]\s*(.{4,80}?)(?=說\s*明|決\s*議|$|。)/);
  if (m2) return tidy(m2[1]);

  // 從檔名嘗試：去掉序號、項目、學年
  let n = baseName;
  n = n.replace(/^\d+[-_\s]*/, '');
  if (category) n = n.replace(category, '');
  if (year) n = n.replace(new RegExp(`${year}\\s*學年(度)?`), '');
  n = n.replace(/^[-_\s]+|[-_\s]+$/g, '');
  if (n.length >= 2) return n;

  return '';
}

function tidy(s) {
  return s.replace(/\s+/g, '').replace(/[「」『』]/g, '').slice(0, 80);
}

// ===== 渲染 =====
function renderFiles() {
  fileCount.textContent = state.files.length;
  filesPanel.classList.toggle('hidden', state.files.length === 0);

  filesList.innerHTML = '';
  state.files.forEach((item, idx) => {
    filesList.appendChild(renderCard(item, idx));
  });
}

function renderCard(item, idx) {
  const card = document.createElement('div');
  card.className = 'file-card' + (item.status !== 'ready' ? ' processing' : '');

  // head
  const head = document.createElement('div');
  head.className = 'file-card-head';
  head.innerHTML = `
    <div class="file-original">
      <span class="file-type-tag">${item.type.toUpperCase()}</span>${escapeHtml(item.file.name)}
    </div>
    <div class="row-actions">
      <span class="file-status ${item.status === 'ready' ? 'ready' : ''}">${item.status === 'ready' ? '✓ 已讀取' : item.status}</span>
      <button type="button" class="icon-btn" title="移除">✕</button>
    </div>
  `;
  head.querySelector('.icon-btn').addEventListener('click', () => removeFile(item.id));
  card.appendChild(head);

  // fields
  const fields = document.createElement('div');
  fields.className = 'file-fields';

  const seqLabel = field('序號',
    `<input type="text" value="${escapeAttr(item.seq)}" inputmode="numeric" maxlength="3" data-key="seq">`);
  const catLabel = field('項目',
    selectHtml(state.categories, item.category, 'category'));
  const yearLabel = field('學年',
    selectHtml(state.years, item.year, 'year', true));
  const nameLabel = field('名稱',
    `<input type="text" value="${escapeAttr(item.name)}" data-key="name" placeholder="從內容自動抽取">`);

  fields.appendChild(seqLabel);
  fields.appendChild(catLabel);
  fields.appendChild(yearLabel);
  fields.appendChild(nameLabel);

  // actions: view + download
  const acts = document.createElement('div');
  acts.style.display = 'flex';
  acts.style.gap = '6px';
  acts.innerHTML = `
    <button type="button" class="btn" data-act="view">檢視</button>
    <button type="button" class="btn" data-act="download">下載</button>
  `;
  acts.querySelector('[data-act="view"]').addEventListener('click', () => openViewer(item));
  acts.querySelector('[data-act="download"]').addEventListener('click', () => downloadOne(item));
  fields.appendChild(acts);

  card.appendChild(fields);

  // preview
  const preview = document.createElement('div');
  preview.className = 'file-preview';
  preview.innerHTML = `<span class="label">新檔名：</span><span class="preview-text"></span>`;
  card.appendChild(preview);

  // bind inputs
  fields.querySelectorAll('[data-key]').forEach(el => {
    el.addEventListener('input', () => {
      item[el.dataset.key] = el.value;
      updatePreview(card, item);
    });
    el.addEventListener('change', () => {
      item[el.dataset.key] = el.value;
      updatePreview(card, item);
    });
  });

  updatePreview(card, item);
  return card;
}

function field(label, innerHtml) {
  const wrap = document.createElement('label');
  wrap.innerHTML = `<span>${label}</span>${innerHtml}`;
  return wrap;
}

function selectHtml(items, current, key, isYear) {
  const opts = ['<option value="">—</option>']
    .concat(items.map(v =>
      `<option value="${escapeAttr(v)}" ${v === current ? 'selected' : ''}>${isYear ? `${v}學年` : escapeHtml(v)}</option>`
    )).join('');
  return `<select data-key="${key}">${opts}</select>`;
}

function updatePreview(card, item) {
  const name = buildNewName(item);
  card.querySelector('.preview-text').textContent = name;
}

function buildNewName(item) {
  const parts = [];
  if (item.seq) parts.push(item.seq);
  if (item.category) parts.push(item.category);
  if (item.year) parts.push(`${item.year}學年`);
  if (item.name) parts.push(item.name);
  const stem = parts.join('-') || stemOf(item.file.name);
  return `${sanitize(stem)}.${item.type}`;
}

function stemOf(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ===== 操作 =====
function removeFile(id) {
  state.files = state.files.filter(f => f.id !== id);
  renumberSeq();
  renderFiles();
}

function renumberSeq() {
  state.files.forEach((f, i) => f.seq = String(i + 1).padStart(2, '0'));
}

clearBtn.addEventListener('click', () => {
  if (!state.files.length) return;
  if (confirm('確定要清除所有檔案？')) {
    state.files = [];
    renderFiles();
  }
});

renumberBtn.addEventListener('click', () => {
  renumberSeq();
  renderFiles();
});

applyDefaultsBtn.addEventListener('click', () => {
  const c = defaultCategory.value;
  const y = defaultYear.value;
  if (!c && !y) {
    alert('請先在預設值中選擇項目或學年。');
    return;
  }
  state.files.forEach(f => {
    if (c) f.category = c;
    if (y) f.year = y;
  });
  renderFiles();
});

// ===== 下載 =====
async function downloadOne(item) {
  const newName = buildNewName(item);
  const url = URL.createObjectURL(item.file);
  const a = document.createElement('a');
  a.href = url;
  a.download = newName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

downloadAllBtn.addEventListener('click', async () => {
  if (!state.files.length) return;
  downloadAllBtn.disabled = true;
  const oldText = downloadAllBtn.textContent;
  downloadAllBtn.textContent = '打包中…';
  try {
    const zip = new JSZip();
    const seen = {};
    for (const item of state.files) {
      let name = buildNewName(item);
      if (seen[name]) {
        const dot = name.lastIndexOf('.');
        name = name.slice(0, dot) + `(${++seen[name]})` + name.slice(dot);
      } else seen[name] = 1;
      const buf = await item.file.arrayBuffer();
      zip.file(name, buf);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `重新命名_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = oldText;
  }
});

// ===== 管理選項對話框 =====
manageOptionsBtn.addEventListener('click', () => {
  renderChips();
  if (typeof optionsDialog.showModal === 'function') optionsDialog.showModal();
  else optionsDialog.setAttribute('open', '');
});

optionsDialog.addEventListener('close', () => {
  fillSelect(defaultCategory, state.categories, true);
  fillSelect(defaultYear, state.years, true);
  renderFiles();
});

function renderChips() {
  categoryChips.innerHTML = '';
  state.categories.forEach(v => categoryChips.appendChild(makeChip(v, 'category')));
  yearChips.innerHTML = '';
  state.years.forEach(v => yearChips.appendChild(makeChip(`${v}學年`, 'year', v)));
}

function makeChip(label, kind, rawValue) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.innerHTML = `${escapeHtml(label)}<button type="button" title="刪除">×</button>`;
  chip.querySelector('button').addEventListener('click', () => {
    const v = rawValue ?? label;
    if (kind === 'category') {
      state.categories = state.categories.filter(x => x !== v);
      saveList('rename.categories', state.categories);
    } else {
      state.years = state.years.filter(x => x !== v);
      saveList('rename.years', state.years);
    }
    renderChips();
  });
  return chip;
}

addCategoryBtn.addEventListener('click', () => {
  const v = newCategoryInput.value.trim();
  if (!v) return;
  if (!state.categories.includes(v)) {
    state.categories.push(v);
    saveList('rename.categories', state.categories);
  }
  newCategoryInput.value = '';
  renderChips();
});

addYearBtn.addEventListener('click', () => {
  const v = newYearInput.value.trim().replace(/[^\d]/g, '');
  if (!v) return;
  if (!state.years.includes(v)) {
    state.years.push(v);
    state.years.sort((a, b) => Number(a) - Number(b));
    saveList('rename.years', state.years);
  }
  newYearInput.value = '';
  renderChips();
});

newCategoryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCategoryBtn.click(); } });
newYearInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addYearBtn.click(); } });

// ===== 檔案檢視對話框 =====
const viewerDialog = $('#viewerDialog');
const viewerType = $('#viewerType');
const viewerFileName = $('#viewerFileName');
const viewerNameInput = $('#viewerNameInput');
const viewerSaveBtn = $('#viewerSaveBtn');
const viewerUseSelectionBtn = $('#viewerUseSelectionBtn');
const viewerCloseBtn = $('#viewerClose');
const viewerRendered = $('#viewerRendered');
const viewerText = $('#viewerText');

let currentViewerItem = null;
let currentBlobUrl = null;

async function openViewer(item) {
  currentViewerItem = item;
  viewerType.textContent = item.type.toUpperCase();
  viewerFileName.textContent = item.file.name;
  viewerNameInput.value = item.name || '';
  viewerText.textContent = item.extractedText || '（尚未抽取文字）';
  viewerRendered.innerHTML = '<div class="viewer-empty">載入中…</div>';

  // 先打開對話框
  if (typeof viewerDialog.showModal === 'function') viewerDialog.showModal();
  else viewerDialog.setAttribute('open', '');

  // 釋放上次的 blob
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

  try {
    if (item.type === 'pdf') {
      currentBlobUrl = URL.createObjectURL(item.file);
      const iframe = document.createElement('iframe');
      iframe.src = currentBlobUrl + '#view=FitH';
      iframe.title = 'PDF 預覽';
      viewerRendered.innerHTML = '';
      viewerRendered.appendChild(iframe);
    } else if (item.type === 'docx') {
      const buf = await item.file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      viewerRendered.innerHTML = `<div class="docx-render">${result.value || '<p class="viewer-empty">無內容</p>'}</div>`;
    } else {
      viewerRendered.innerHTML = '<div class="viewer-empty">無法預覽此類型</div>';
    }
  } catch (err) {
    console.error(err);
    viewerRendered.innerHTML = '<div class="viewer-empty">載入失敗</div>';
  }
}

function closeViewer() {
  if (typeof viewerDialog.close === 'function') viewerDialog.close();
  else viewerDialog.removeAttribute('open');
}

viewerCloseBtn.addEventListener('click', () => {
  // 不套用名稱，直接關閉
  closeViewer();
});

viewerSaveBtn.addEventListener('click', () => {
  if (currentViewerItem) {
    currentViewerItem.name = viewerNameInput.value.trim();
    renderFiles();
  }
  closeViewer();
});

viewerUseSelectionBtn.addEventListener('click', () => {
  const text = readSelectionText();
  if (text) {
    viewerNameInput.value = text;
    viewerNameInput.focus();
  } else {
    alert('請先在右側文字區或左側文件中選取要當名稱的文字。');
  }
});

function readSelectionText() {
  // 先看主視窗的選取
  let s = (window.getSelection && window.getSelection().toString()) || '';
  if (s.trim()) return cleanSelection(s);
  // 再看 iframe 內（同源 blob 可讀）
  const iframe = viewerRendered.querySelector('iframe');
  if (iframe && iframe.contentWindow) {
    try {
      const sel = iframe.contentWindow.getSelection && iframe.contentWindow.getSelection();
      if (sel) {
        const t = sel.toString();
        if (t.trim()) return cleanSelection(t);
      }
    } catch (e) {}
  }
  return '';
}

function cleanSelection(s) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}

viewerDialog.addEventListener('close', () => {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  viewerRendered.innerHTML = '';
  currentViewerItem = null;
});

// 點擊對話框外側自動關閉
viewerDialog.addEventListener('click', e => {
  if (e.target === viewerDialog) closeViewer();
});
