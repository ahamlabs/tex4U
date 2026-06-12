// ---------- CodeMirror ----------
const starterSource = [
  '\\documentclass{article}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage{amsmath, amssymb}',
  '\\usepackage{graphicx}',
  '',
  '\\begin{document}',
  '',
  '\\title{My Document}',
  '\\author{Local LaTeX}',
  '\\date{\\today}',
  '\\maketitle',
  '',
  '\\section{Introduction}',
  'Hello, this is a local \\LaTeX\\ editor.',
  '',
  '% Example image inclusion (upload an image first)',
  '% \\includegraphics[width=0.5\\textwidth]{example.png}',
  '',
  '\\begin{equation}',
  '  E = mc^2',
  '\\end{equation}',
  '',
  '\\end{document}'
].join('\n');

const editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
  mode: 'text/x-latex',
  theme: 'material-darker',
  lineNumbers: true,
  indentUnit: 2,
  tabSize: 2,
  lineWrapping: true,
  value: starterSource
});

// ---------- DOM ----------
const compileBtn = document.getElementById('compile-btn');
const downloadBtn = document.getElementById('download-btn');
const newProjectBtn = document.getElementById('new-project-btn');
const toggleFilesBtn = document.getElementById('toggle-files-btn');
const closeFilesBtn = document.getElementById('close-files-btn');
const filesPanel = document.getElementById('files-panel');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const fileTree = document.getElementById('file-tree');
const statusSpan = document.getElementById('status');
const logDiv = document.getElementById('log');
const pdfFrame = document.getElementById('pdf-frame');

// Mode selector elements
const tempRadio = document.querySelector('input[value="temp"]');
const customRadio = document.querySelector('input[value="custom"]');
const customPathArea = document.getElementById('custom-path-area');
const customPathInput = document.getElementById('custom-path-input');

let currentProjectId = null;
let currentMode = 'temp';       // 'temp' or 'custom'
let customPath = '';

// ---------- UI: File panel toggle ----------
function openFilesPanel() {
  filesPanel.classList.remove('collapsed');
  toggleFilesBtn.textContent = 'Files ◂';
}
function closeFilesPanel() {
  filesPanel.classList.add('collapsed');
  toggleFilesBtn.textContent = 'Files ▸';
}
toggleFilesBtn.addEventListener('click', () => {
  filesPanel.classList.contains('collapsed') ? openFilesPanel() : closeFilesPanel();
});
closeFilesBtn.addEventListener('click', closeFilesPanel);

// ---------- Mode selector logic ----------
function updateModeUI() {
  if (customRadio.checked) {
    customPathArea.style.display = 'block';
  } else {
    customPathArea.style.display = 'none';
  }
}
tempRadio.addEventListener('change', () => {
  currentMode = 'temp';
  localStorage.setItem('latexWorkspaceMode', 'temp');
  updateModeUI();
});
customRadio.addEventListener('change', () => {
  currentMode = 'custom';
  localStorage.setItem('latexWorkspaceMode', 'custom');
  updateModeUI();
});
customPathInput.addEventListener('input', () => {
  customPath = customPathInput.value.trim();
  localStorage.setItem('latexCustomPath', customPath);
});

// Restore saved mode and path
function restoreModeFromStorage() {
  const savedMode = localStorage.getItem('latexWorkspaceMode');
  if (savedMode === 'custom') {
    customRadio.checked = true;
    currentMode = 'custom';
    customPath = localStorage.getItem('latexCustomPath') || '';
    customPathInput.value = customPath;
  } else {
    tempRadio.checked = true;
    currentMode = 'temp';
    customPath = '';
    customPathInput.value = '';
  }
  updateModeUI();
}

// ---------- Project management ----------
async function createNewProject() {
  const body = { mode: currentMode };
  if (currentMode === 'custom') {
    if (!customPath) {
      statusSpan.textContent = 'Please enter a folder path for custom workspace';
      return;
    }
    body.path = customPath;
  }

  try {
    const resp = await fetch('/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json();
      statusSpan.textContent = 'Error: ' + (err.detail || resp.status);
      return;
    }
    const data = await resp.json();
    currentProjectId = data.project_id;
    localStorage.setItem('latexProjectId', currentProjectId);
    localStorage.setItem('latexWorkspaceMode', currentMode);
    if (currentMode === 'custom') {
      localStorage.setItem('latexCustomPath', customPath);
    }
    pdfFrame.src = '';
    logDiv.textContent = '';
    statusSpan.textContent = `New ${currentMode} project created`;
    editor.setValue(starterSource);
    await updateFileList();
  } catch (e) {
    statusSpan.textContent = 'Failed to create project';
  }
}

async function ensureProject() {
  const storedId = localStorage.getItem('latexProjectId');
  const storedMode = localStorage.getItem('latexWorkspaceMode');
  const storedPath = localStorage.getItem('latexCustomPath');

  if (!storedId) {
    await createNewProject();
    return;
  }

  // Try to use the stored project
  currentProjectId = storedId;
  try {
    const resp = await fetch(`/files/${currentProjectId}`);
    if (resp.ok) {
      // Valid
      return;
    } else if (resp.status === 404 && storedMode === 'custom' && storedPath) {
      // Custom project lost after restart -> reconnect
      const reconResp = await fetch('/project/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'custom', path: storedPath })
      });
      if (reconResp.ok) {
        const data = await reconResp.json();
        currentProjectId = data.project_id;
        localStorage.setItem('latexProjectId', currentProjectId);
        return;
      }
    }
  } catch (e) {
    // network error, maybe server down? will create new later
  }
  // fallback: create new project
  await createNewProject();
}

// ---------- File tree ----------
async function updateFileList() {
  if (!currentProjectId) return;
  try {
    const resp = await fetch(`/files/${currentProjectId}`);
    if (!resp.ok) {
      if (resp.status === 404) {
        await createNewProject();
        return;
      }
      throw new Error(`Server responded with ${resp.status}`);
    }
    const data = await resp.json();
    renderFileTree(data.files);
  } catch (e) {
    logDiv.textContent += `Error loading files: ${e.message}\n`;
  }
}

function renderFileTree(files) {
  fileTree.innerHTML = '';
  if (files.length === 0) {
    fileTree.innerHTML = '<div class="file-tree-item">(empty)</div>';
    return;
  }
  files.forEach(fname => {
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    item.innerHTML = `
      <span class="file-icon">📄</span>
      <span class="file-name">${escapeHtml(fname)}</span>
      <button class="delete-file-btn" title="Delete file">✕</button>
    `;
    item.querySelector('.delete-file-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteFile(fname);
    });
    fileTree.appendChild(item);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------- Upload / Delete ----------
async function uploadFiles() {
  if (!currentProjectId || fileInput.files.length === 0) return;
  statusSpan.textContent = 'Uploading...';
  for (let file of fileInput.files) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch(`/upload/${currentProjectId}`, {
        method: 'POST',
        body: formData
      });
      if (!resp.ok) {
        const err = await resp.json();
        logDiv.textContent += `Upload failed for ${file.name}: ${err.detail}\n`;
      }
    } catch (e) {
      logDiv.textContent += `Upload error: ${e.message}\n`;
    }
  }
  statusSpan.textContent = 'Upload complete';
  fileInput.value = '';
  await updateFileList();
}

async function deleteFile(filename) {
  if (!currentProjectId) return;
  try {
    const resp = await fetch(`/files/${currentProjectId}/${filename}`, {
      method: 'DELETE'
    });
    if (resp.ok) {
      await updateFileList();
    } else {
      const err = await resp.json();
      logDiv.textContent += `Delete failed: ${err.detail}\n`;
    }
  } catch (e) {
    logDiv.textContent += `Delete error: ${e.message}\n`;
  }
}

// ---------- Compilation ----------
async function compile() {
  const source = editor.getValue();
  if (!source.trim() || !currentProjectId) return;

  statusSpan.textContent = 'Compiling…';
  logDiv.textContent = '';

  try {
    const response = await fetch('/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, project_id: currentProjectId })
    });
    const data = await response.json();

    if (data.success) {
      currentProjectId = data.project_id;
      localStorage.setItem('latexProjectId', currentProjectId);
      pdfFrame.src = `/pdf/${currentProjectId}?t=${Date.now()}`;
      statusSpan.textContent = '✓ Compilation successful';
      downloadBtn.disabled = false;
      logDiv.textContent = data.log || '';
    } else {
      statusSpan.textContent = '✗ Compilation failed';
      logDiv.textContent = data.log || data.error || 'Unknown error';
    }
  } catch (err) {
    statusSpan.textContent = '✗ Network error';
    logDiv.textContent = err.message;
  }
}

// ---------- Event listeners ----------
compileBtn.addEventListener('click', compile);
newProjectBtn.addEventListener('click', createNewProject);
uploadBtn.addEventListener('click', uploadFiles);
downloadBtn.addEventListener('click', () => {
  if (currentProjectId) window.open(`/pdf/${currentProjectId}`, '_blank');
});
editor.setOption('extraKeys', {
  'Ctrl-Enter': compile,
  'Cmd-Enter': compile
});

// ---------- Initialisation ----------
restoreModeFromStorage();
ensureProject().then(() => {
  updateFileList();
  if (currentProjectId) {
    pdfFrame.src = `/pdf/${currentProjectId}?t=${Date.now()}`;
    downloadBtn.disabled = false;
  }
});