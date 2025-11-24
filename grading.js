(function(){
  const APP = window.APP_CONFIG || {};
  const serverBaseUrl = APP.serverBaseUrl || '';

  const state = {
    tasks: [],
    roots: [],
    students: [],
    submissions: {},
    selectedTaskId: '',
    selectedTaskTitle: '',
    classId: '',
    loading: false,
    localGrades: {},
    pendingSaves: Object.create(null),
    submittedCount: {},
    latestFetchedAt: ''
  };

  const collapsedFolders = new Set();

  const classInput = document.getElementById('classInput');
  const userInput = document.getElementById('userInput');
  const loadButton = document.getElementById('loadButton');
  const bulkButton = document.getElementById('bulkFullButton');
  const saveButton = document.getElementById('saveButton');
  const classInfo = document.getElementById('classInfo');
  const globalMessage = document.getElementById('globalMessage');
  const taskTree = document.getElementById('taskTree');
  const taskSummary = document.getElementById('taskSummary');
  const gradingTable = document.getElementById('gradingTable');
  const saveStatus = document.getElementById('saveStatus');
  const gradingTableWrapper = document.getElementById('gradingTableWrapper');
  const submittedOnlyToggle = document.getElementById('submittedOnlyToggle');

  const cacheBaseKey = serverBaseUrl || 'default';
  const CLASS_CACHE_PREFIX = `grading.${cacheBaseKey}.cache.`;
  const USER_CLASS_PREFIX = `grading.${cacheBaseKey}.userClass.`;
  const SUBMITTED_ONLY_KEY = `grading.${cacheBaseKey}.submittedOnly`;
  let submittedOnly = false;
  const plotCache = new Map(); // key -> { signature, dataUrl?, error? }
  const plotPromises = new Map(); // key -> { signature, promise }
  let plotPyodide = null;
  let plotPyodideInit = null;
  let plotRunQueue = Promise.resolve();

  const cloneDeep = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : obj);
  const pendingKeyFor = (classId, taskId) => `${classId || 'default'}::${taskId || ''}`;

  function showMessage(text, type = '') {
    globalMessage.textContent = text || '';
    globalMessage.className = type ? type : '';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    loadButton.disabled = isLoading;
    loadButton.textContent = isLoading ? '読み込み中...' : '読み込み';
  }

  function classCacheKey(classId) {
    const cls = String(classId || '').trim();
    return cls ? `${CLASS_CACHE_PREFIX}${cls}` : '';
  }

  function loadClassCache(classId) {
    const key = classCacheKey(classId);
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('grading cache load failed', err);
      return null;
    }
  }

  function saveClassCache(classId, snapshot) {
    const key = classCacheKey(classId);
    if (!key || !snapshot) return;
    try {
      localStorage.setItem(key, JSON.stringify(snapshot));
    } catch (err) {
      console.warn('grading cache save failed', err);
    }
  }

  function rememberUserClass(userId, classId) {
    const uid = String(userId || '').trim();
    const cls = String(classId || '').trim();
    if (!uid || !cls) return;
    try {
      localStorage.setItem(`${USER_CLASS_PREFIX}${uid}`, cls);
    } catch {}
  }

  function rememberUsersFromResponse(students = [], resolvedUserId, classId) {
    const fallbackClass = String(classId || '').trim();
    students.forEach(stu => {
      const cls = stu && stu.classId ? String(stu.classId || '').trim() : fallbackClass;
      rememberUserClass(stu && stu.userId, cls);
    });
    if (resolvedUserId) {
      const resolvedClass = students.find(stu => stu && stu.userId === resolvedUserId)?.classId || fallbackClass;
      rememberUserClass(resolvedUserId, resolvedClass);
    }
  }

  function getCachedUserClass(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return '';
    try {
      return localStorage.getItem(`${USER_CLASS_PREFIX}${uid}`) || '';
    } catch {
      return '';
    }
  }

  function loadSubmittedOnlySetting() {
    try {
      return localStorage.getItem(SUBMITTED_ONLY_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function persistSubmittedOnlySetting(value) {
    submittedOnly = !!value;
    try {
      localStorage.setItem(SUBMITTED_ONLY_KEY, submittedOnly ? 'true' : 'false');
    } catch {}
    if (submittedOnlyToggle) submittedOnlyToggle.checked = submittedOnly;
  }

  submittedOnly = loadSubmittedOnlySetting();
  if (submittedOnlyToggle) {
    submittedOnlyToggle.checked = submittedOnly;
  }

  function clearPlotPreviews() {
    plotCache.clear();
    plotPromises.clear();
  }

  function plotCacheKey(userId, taskId) {
    return `${userId || ''}::${taskId || ''}`;
  }

  function buildPlotSignature(submission) {
    if (!submission) return '';
    const savedAt = submission.savedAt || '';
    const code = submission.code || '';
    const output = submission.output || '';
    return `${savedAt}::${code}::${output}`;
  }

  function enqueuePlotExecution(fn) {
    const next = plotRunQueue.then(() => fn());
    plotRunQueue = next.catch(() => {});
    return next;
  }

  async function ensurePlotPyodide() {
    if (plotPyodide) return plotPyodide;
    if (plotPyodideInit) return plotPyodideInit;
    plotPyodideInit = (async () => {
      let chosenSrc = '';
      if (typeof loadPyodide === 'undefined') {
        const candidates = [
          'https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js',
          './pyodide/pyodide.js',
          './pyodide.js'
        ];
        let lastErr = null;
        for (const src of candidates) {
          try {
            await new Promise((resolve, reject) => {
              const s = document.createElement('script');
              s.src = src;
              s.onload = resolve;
              s.onerror = reject;
              document.head.appendChild(s);
            });
            chosenSrc = src;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (typeof loadPyodide === 'undefined') {
          throw lastErr || new Error('pyodide.js の読み込みに失敗しました');
        }
      }
      let indexURL = 'https://cdn.jsdelivr.net/pyodide/v0.22.1/full/';
      if (chosenSrc && !/^https?:/i.test(chosenSrc)) {
        const a = document.createElement('a');
        a.href = chosenSrc;
        indexURL = a.href.replace(/[^/]+$/, '');
      }
      const py = await loadPyodide({ indexURL });
      await py.loadPackage(['matplotlib']);
      return py;
    })().then(py => {
      plotPyodide = py;
      return py;
    }).finally(() => {
      plotPyodideInit = null;
    });
    return plotPyodideInit;
  }

  function generatePlotPreview(code) {
    return enqueuePlotExecution(async () => {
      const py = await ensurePlotPyodide();
      if (!py) throw new Error('Pyodide の初期化に失敗しました');
      const pythonCode = [
        'import builtins, io, base64',
        'import matplotlib',
        'matplotlib.use("Agg", force=True)',
        'from matplotlib import pyplot as plt',
        'from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas',
        'plt.ioff()',
        '__plot_data__ = []',
        'def __capture_plot__():',
        '    try:',
        '        fids = list(plt.get_fignums())',
        '        for fid in fids:',
        '            fig = plt.figure(fid)',
        '            if not getattr(fig, "canvas", None):',
        '                FigureCanvas(fig)',
        '            try:',
        '                fig.canvas.draw()',
        '                buf = io.BytesIO()',
        '                fig.savefig(buf, format="png", bbox_inches="tight")',
        '                buf.seek(0)',
        '                b64 = base64.b64encode(buf.getvalue()).decode("ascii")',
        '                __plot_data__.append("data:image/png;base64," + b64)',
        '            finally:',
        '                plt.close(fig)',
        '    except Exception:',
        '        pass',
        'def __plt_show_patch__(*args, **kwargs):',
        '    __capture_plot__()',
        'try:',
        '    plt.show = __plt_show_patch__',
        'except Exception:',
        '    pass',
        'def __safe_input__(*args, **kwargs):',
        '    return ""',
        'try:',
        '    builtins.input = __safe_input__',
        '    __builtins__["input"] = __safe_input__',
        'except Exception:',
        '    pass',
        'try:',
        '    import time',
        '    time.sleep = lambda *args, **kwargs: None',
        'except Exception:',
        '    pass',
        '__ns = {}',
        `code_to_run = ${JSON.stringify(String(code || ''))}`,
        'exec(compile(code_to_run, "<student>", "exec"), __ns, __ns)',
        '__capture_plot__()',
        'try:',
        '    plt.close("all")',
        'except Exception:',
        '    pass'
      ].join('\n');
      await py.runPythonAsync(pythonCode);
      const pyList = py.globals.get('__plot_data__');
      let urls = [];
      try {
        urls = pyList && pyList.toJs ? pyList.toJs() : [];
      } finally {
        try { if (pyList && pyList.destroy) pyList.destroy(); } catch {}
        try { py.runPython('del __plot_data__'); } catch {}
      }
      if (urls && urls.length) return urls[0];
      throw new Error('グラフを取得できませんでした');
    });
  }

  function plotNoteText(outputText) {
    const base = (outputText && String(outputText).trim()) || '[plot]';
    return `提出出力: ${base}`;
  }

  function applyPlotLoading(outputBlock, outputText) {
    if (!outputBlock) return;
    outputBlock.classList.add('plot-output');
    outputBlock.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'plot-note';
    note.textContent = plotNoteText(outputText);
    const status = document.createElement('div');
    status.className = 'plot-status';
    status.textContent = 'グラフを生成しています...';
    outputBlock.append(note, status);
  }

  function applyPlotImage(outputBlock, dataUrl, outputText) {
    if (!outputBlock) return;
    outputBlock.classList.add('plot-output');
    outputBlock.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'plot-note';
    note.textContent = plotNoteText(outputText);
    const img = document.createElement('img');
    img.className = 'plot-preview';
    img.src = dataUrl;
    img.alt = '提出コードのグラフ';
    outputBlock.append(note, img);
  }

  function applyPlotError(outputBlock, message, outputText) {
    if (!outputBlock) return;
    outputBlock.classList.add('plot-output');
    outputBlock.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'plot-note';
    note.textContent = plotNoteText(outputText);
    const status = document.createElement('div');
    status.className = 'plot-status error';
    status.textContent = message || 'グラフ生成に失敗しました';
    outputBlock.append(note, status);
  }

  function renderPlotPreview(userId, taskId, submission, outputBlock) {
    const outputText = submission?.output;
    applyPlotLoading(outputBlock, outputText);
    if (!submission || !submission.code) {
      applyPlotError(outputBlock, '提出コードが空のためグラフを生成できませんでした', outputText);
      return;
    }
    const key = plotCacheKey(userId, taskId);
    const signature = buildPlotSignature(submission);
    const cached = plotCache.get(key);
    if (cached && cached.signature === signature) {
      if (cached.dataUrl) {
        applyPlotImage(outputBlock, cached.dataUrl, outputText);
        return;
      }
      if (cached.error) {
        applyPlotError(outputBlock, cached.error, outputText);
        return;
      }
    } else if (cached && cached.signature !== signature) {
      plotCache.delete(key);
    }
    const inflight = plotPromises.get(key);
    if (inflight && inflight.signature === signature) {
      inflight.promise
        .then(url => {
          if (outputBlock.isConnected) applyPlotImage(outputBlock, url, outputText);
        })
        .catch(err => {
          if (outputBlock.isConnected) applyPlotError(outputBlock, err.message || String(err), outputText);
        });
      return;
    } else if (inflight && inflight.signature !== signature) {
      plotPromises.delete(key);
    }
    const promise = generatePlotPreview(submission.code)
      .then(url => {
        plotCache.set(key, { signature, dataUrl: url });
        return url;
      })
      .catch(err => {
        const msg = err && err.message ? err.message : 'グラフ生成に失敗しました';
        plotCache.set(key, { signature, error: msg });
        throw new Error(msg);
      })
      .finally(() => {
        const current = plotPromises.get(key);
        if (current && current.signature === signature) plotPromises.delete(key);
      });
    plotPromises.set(key, { signature, promise });
    promise
      .then(url => {
        if (outputBlock.isConnected) applyPlotImage(outputBlock, url, outputText);
      })
      .catch(err => {
        if (outputBlock.isConnected) applyPlotError(outputBlock, err.message || String(err), outputText);
      });
  }

  function mergeSubmissionSets(base = {}, incoming = {}) {
    const merged = cloneDeep(base) || {};
    Object.entries(incoming).forEach(([userId, tasks]) => {
      if (!tasks) return;
      const target = merged[userId] || (merged[userId] = {});
      Object.entries(tasks).forEach(([taskId, payload]) => {
        target[taskId] = payload;
      });
    });
    return merged;
  }

  function mergeCacheSnapshots(base = {}, incoming = {}) {
    const tasks = (Array.isArray(incoming.tasks) && incoming.tasks.length ? incoming.tasks : base.tasks) || [];
    const students = (Array.isArray(incoming.students) && incoming.students.length ? incoming.students : base.students) || [];
    return {
      classId: incoming.classId || base.classId || '',
      tasks: cloneDeep(tasks),
      students: cloneDeep(students),
      submissions: mergeSubmissionSets(base.submissions || {}, incoming.submissions || {}),
      fetchedAt: incoming.fetchedAt || base.fetchedAt || '',
      localGrades: cloneDeep(base.localGrades || {})
    };
  }

  function updateCacheFromState() {
    if (!state.classId) return;
    saveClassCache(state.classId, {
      classId: state.classId,
      tasks: state.tasks,
      students: state.students,
      submissions: state.submissions,
      fetchedAt: state.latestFetchedAt || '',
      localGrades: state.localGrades
    });
  }

  function prepareLocalGradesFromSubmissions() {
    state.localGrades = state.localGrades || {};
    Object.entries(state.submissions || {}).forEach(([userId, taskMap]) => {
      if (!taskMap) return;
      const userGrades = state.localGrades[userId] || (state.localGrades[userId] = {});
      Object.entries(taskMap).forEach(([taskId, submission]) => {
        const signature = submission?.savedAt || '';
        let entry = userGrades[taskId];
        if (!entry || entry.serverSignature !== signature) {
          entry = {
            score: submission && submission.score !== undefined ? submission.score : '',
            comment: submission?.comment || '',
            locked: submission ? !submission.submitted : true,
            submitted: !!submission?.submitted,
            serverSignature: signature,
            dirty: false
          };
          userGrades[taskId] = entry;
        } else {
          entry.submitted = submission ? !!submission.submitted : entry.submitted;
          if (submission && submission.submitted) entry.locked = false;
        }
      });
    });
  }

  function recomputeSubmittedCounts() {
    const counts = {};
    Object.values(state.submissions || {}).forEach(taskMap => {
      Object.entries(taskMap || {}).forEach(([taskId, entry]) => {
        if (entry && entry.submitted) counts[taskId] = (counts[taskId] || 0) + 1;
      });
    });
    state.submittedCount = counts;
  }

  function refreshActionAvailability() {
    const taskId = state.selectedTaskId;
    if (!taskId) {
      saveButton.disabled = true;
      bulkButton.disabled = true;
      return;
    }
    const hasSubmitted = (state.submittedCount[taskId] || 0) > 0;
    const hasEditableManual = hasNonSubmittedEditableRows(taskId);
    const key = pendingKeyFor(state.classId, taskId);
    const hasPending = !!state.pendingSaves[key] && state.pendingSaves[key].size > 0;
    saveButton.disabled = (!hasSubmitted && !hasEditableManual) || hasPending;
    bulkButton.disabled = !hasSubmitted || hasPending;
  }

  function hasNonSubmittedEditableRows(taskId) {
    if (!taskId || !state.students.length) return false;
    return state.students.some(student => {
      const submission = (state.submissions[student.userId] || {})[taskId];
      const entry = ensureLocalGrade(student.userId, taskId, submission);
      if (!entry) return false;
      if (isGradedEntry(submission, entry)) return true;
      if (!isSubmittedEntry(submission, entry) && entryNeedsManualSave(entry)) return true;
      return false;
    });
  }

  function resetStateForLoading(classId) {
    clearPlotPreviews();
    state.classId = classId || state.classId || '';
    state.tasks = [];
    state.roots = [];
    state.students = [];
    state.submissions = {};
    state.localGrades = {};
    state.submittedCount = {};
    state.pendingSaves = Object.create(null);
    state.selectedTaskId = '';
    state.selectedTaskTitle = '';
    state.latestFetchedAt = '';
    classInfo.textContent = state.classId ? `対象クラス: ${state.classId}` : '対象クラス: 未選択';
    taskTree.classList.add('empty');
    taskTree.textContent = '読み込み中...';
    gradingTable.className = 'empty-state';
    gradingTable.textContent = '読み込み中...';
    refreshActionAvailability();
  }

  function updateClassInfo() {
    classInfo.textContent = state.classId
      ? `対象クラス: ${state.classId} (${state.students.length}名)`
      : '対象クラス: 未選択';
  }

  function applyCacheSnapshot(snapshot, preserveSelection) {
    if (!snapshot) return;
    const data = cloneDeep(snapshot);
    const previousSelection = preserveSelection ? state.selectedTaskId : '';
    const prevClassId = state.classId;
    state.classId = data.classId || state.classId || '';
    if (prevClassId && prevClassId !== state.classId) {
      clearPlotPreviews();
      state.pendingSaves = Object.create(null);
    } else if (!prevClassId && state.classId) {
      clearPlotPreviews();
    }
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.roots = buildTaskTree(state.tasks);
    state.students = Array.isArray(data.students) ? data.students : [];
    state.submissions = data.submissions || {};
    state.localGrades = data.localGrades || {};
    state.latestFetchedAt = data.fetchedAt || state.latestFetchedAt || '';
    prepareLocalGradesFromSubmissions();
    recomputeSubmittedCounts();
    updateClassInfo();
    if (!state.roots.length) {
      state.selectedTaskId = '';
      state.selectedTaskTitle = '';
      renderTaskList();
      taskSummary.textContent = '課題を選択してください。';
      gradingTable.className = 'empty-state';
      gradingTable.textContent = state.classId ? '課題データがありません。' : 'クラスを読み込んでください。';
      refreshActionAvailability();
      return;
    }
    const preserved = previousSelection && state.tasks.some(t => t.id === previousSelection && !t.isFolder);
    if (preserved) {
      selectTask(previousSelection);
    } else {
      const firstTask = state.tasks.find(t => !t.isFolder);
      if (firstTask) {
        selectTask(firstTask.id);
      } else {
        state.selectedTaskId = '';
        state.selectedTaskTitle = '';
        renderTaskList();
        taskSummary.textContent = '課題を選択してください。';
        gradingTable.className = 'empty-state';
        gradingTable.textContent = '課題データがありません。';
        refreshActionAvailability();
      }
    }
  }

  function normalizeTasks(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const result = [];
    if (Array.isArray(raw[0])) {
      const header = raw[0].map(h => String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase());
      const rows = raw.slice(1);
      const idx = {
        taskid: header.indexOf('taskid'),
        title: header.indexOf('title'),
        parent: header.indexOf('parentid'),
        isFolder: header.indexOf('isfolder')
      };
      rows.forEach((row, order) => {
        const id = getCell(row, idx.taskid);
        if (!id) return;
        result.push({
          id,
          title: getCell(row, idx.title) || id,
          parentId: getCell(row, idx.parent),
          isFolder: toBool(getCell(row, idx.isFolder)),
          order
        });
      });
      return result;
    }
    if (typeof raw[0] === 'object') {
      raw.forEach((row, order) => {
        const id = row.TaskId || row.taskId;
        if (!id) return;
        result.push({
          id,
          title: row.Title || row.title || id,
          parentId: row.ParentId || row.parentId || '',
          isFolder: !!row.IsFolder,
          order
        });
      });
      return result;
    }
    return [];
  }

  function getCell(row, idx) {
    if (idx == null || idx < 0) return '';
    const v = row[idx];
    return v == null ? '' : String(v).trim();
  }

  function toBool(value) {
    const s = String(value || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  }

  function isPlotOutput(outputText) {
    if (!outputText) return false;
    const text = String(outputText).toLowerCase();
    return text.includes('[plot]');
  }

  function buildTaskTree(tasks) {
    const map = new Map();
    tasks.forEach(t => map.set(t.id, { ...t, children: [] }));
    const roots = [];
    map.forEach(node => {
      if (node.parentId && map.has(node.parentId)) map.get(node.parentId).children.push(node);
      else roots.push(node);
    });
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        const af = a.isFolder ? 0 : 1;
        const bf = b.isFolder ? 0 : 1;
        if (af !== bf) return af - bf;
        const at = a.title || a.id || '';
        const bt = b.title || b.id || '';
        const cmp = at.localeCompare(bt);
        if (cmp !== 0) return cmp;
        return (a.order || 0) - (b.order || 0);
      });
      nodes.forEach(child => sortNodes(child.children));
    };
    sortNodes(roots);
    return roots;
  }

  function renderTaskList() {
    taskTree.classList.remove('empty');
    if (!state.roots.length) {
      taskTree.textContent = state.classId ? '課題が見つかりません。' : 'クラスを読み込んでください。';
      return;
    }
    const container = document.createElement('div');
    container.appendChild(renderTaskNodes(state.roots));
    taskTree.innerHTML = '';
    taskTree.appendChild(container);
  }

  function renderTaskNodes(nodes) {
    const ul = document.createElement('ul');
    nodes.forEach(node => {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = `task-node ${node.isFolder ? 'folder' : 'task'}${state.selectedTaskId === node.id ? ' active' : ''}`;
      if (node.isFolder) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'toggle';
        toggle.textContent = collapsedFolders.has(node.id) ? '▶' : '▼';
        toggle.addEventListener('click', evt => {
          evt.stopPropagation();
          if (collapsedFolders.has(node.id)) collapsedFolders.delete(node.id);
          else collapsedFolders.add(node.id);
          renderTaskList();
        });
        row.appendChild(toggle);
        const label = document.createElement('span');
        label.className = 'title';
        label.textContent = node.title;
        row.appendChild(label);
      } else {
        const dot = document.createElement('span');
        dot.className = 'task-dot';
        row.appendChild(dot);
        const label = document.createElement('span');
        label.className = 'title';
        label.textContent = node.title;
        row.appendChild(label);
        const count = state.submittedCount[node.id] || 0;
        if (count > 0) {
          const countEl = document.createElement('span');
          countEl.className = 'task-count';
          countEl.textContent = count;
          row.appendChild(countEl);
        }
        row.addEventListener('click', () => selectTask(node.id, node.title));
      }
      li.appendChild(row);
      if (node.children && node.children.length && !collapsedFolders.has(node.id)) {
        li.appendChild(renderTaskNodes(node.children));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function selectTask(taskId, title) {
    if (!taskId || state.selectedTaskId === taskId) {
      refreshActionAvailability();
      return;
    }
    state.selectedTaskId = taskId;
    state.selectedTaskTitle = title || (state.tasks.find(t => t.id === taskId)?.title || taskId);
    taskSummary.textContent = `表示中: ${state.selectedTaskTitle}`;
    if (gradingTableWrapper) gradingTableWrapper.scrollTop = 0;
    renderTaskList();
    renderStudents();
  }

  function isRowPending(taskId, userId) {
    const key = pendingKeyFor(state.classId, taskId);
    const set = state.pendingSaves[key];
    return !!(set && set.has(userId));
  }

  function setRowsPending(classId, taskId, userIds, pending) {
    const key = pendingKeyFor(classId, taskId);
    let set = state.pendingSaves[key];
    if (pending) {
      if (!set) set = state.pendingSaves[key] = new Set();
      userIds.forEach(id => set.add(id));
    } else if (set) {
      userIds.forEach(id => set.delete(id));
      if (set.size === 0) delete state.pendingSaves[key];
    }
  }

  function ensureLocalGrade(userId, taskId, submission) {
    const userGrades = state.localGrades[userId] || (state.localGrades[userId] = {});
    const signature = submission?.savedAt || '';
    let entry = userGrades[taskId];
    if (!entry || entry.serverSignature !== signature) {
      entry = {
        score: submission && submission.score !== undefined ? submission.score : '',
        comment: submission?.comment || '',
        locked: submission ? !submission.submitted : true,
        submitted: !!submission?.submitted,
        serverSignature: signature,
        dirty: false
      };
      userGrades[taskId] = entry;
    }
    return entry;
  }

  function isSubmittedEntry(submission, entry) {
    if (submission && submission.submitted != null) {
      return toBool(submission.submitted);
    }
    if (entry && entry.submitted != null) return !!entry.submitted;
    return false;
  }

  function hasStoredGrade(entry) {
    if (!entry) return false;
    const score = entry.score;
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    const hasScore = !(score === '' || score === null || score === undefined);
    return hasScore || !!comment;
  }

  function isGradedEntry(submission, entry) {
    if (!submission || !entry) return false;
    if (isSubmittedEntry(submission, entry)) return false;
    return hasStoredGrade(entry);
  }

  function entryNeedsManualSave(entry) {
    return !!(entry && entry.dirty);
  }

  function editLocalGrade(userId, taskId, updater) {
    if (!state.classId || !taskId) return;
    const submission = (state.submissions[userId] || {})[taskId];
    const entry = ensureLocalGrade(userId, taskId, submission);
    updater(entry);
    entry.dirty = true;
    entry.locked = false;
    updateCacheFromState();
    refreshActionAvailability();
  }

  function renderStudents() {
    const currentTaskId = state.selectedTaskId;
    if (!currentTaskId) {
      gradingTable.className = 'empty-state';
      gradingTable.textContent = '課題を選択してください。';
      refreshActionAvailability();
      return;
    }
    if (!state.students.length) {
      gradingTable.className = 'empty-state';
      gradingTable.textContent = '対象クラスにユーザが見つかりません。';
      refreshActionAvailability();
      return;
    }
    gradingTable.className = '';
    gradingTable.innerHTML = '';
    let renderedCount = 0;
    state.students.forEach(student => {
      const submission = (state.submissions[student.userId] || {})[currentTaskId];
      const localEntry = ensureLocalGrade(student.userId, currentTaskId, submission);
      const submitted = isSubmittedEntry(submission, localEntry);
      const graded = !submitted && isGradedEntry(submission, localEntry);
      const manual = !submitted && !graded;
      const editable = submitted || graded || manual;
      const pending = isRowPending(currentTaskId, student.userId);
      if (submittedOnly && !submitted) return;
      const card = document.createElement('article');
      card.className = 'student-card';
      card.dataset.userId = student.userId;
      card.dataset.taskId = currentTaskId;
      card.dataset.submitted = submitted ? 'true' : 'false';
      card.dataset.pending = pending ? 'true' : 'false';
      card.dataset.locked = localEntry.locked ? 'true' : 'false';
      card.dataset.editing = localEntry.dirty ? 'true' : 'false';

      const meta = document.createElement('div');
      meta.className = 'student-meta';
      const numberEl = document.createElement('div');
      numberEl.className = 'student-number';
      numberEl.textContent = student.number || '-';
      const idEl = document.createElement('div');
      idEl.className = 'student-id';
      idEl.textContent = student.userId;
      const badge = document.createElement('div');
      badge.className = 'submission-badge';
      if (pending) {
        badge.classList.add('pending');
        badge.textContent = '保存中';
      } else if (submitted) {
        badge.classList.add('submitted');
        badge.textContent = '提出済';
      } else if (graded) {
        badge.classList.add('graded');
        badge.textContent = '採点済';
      } else {
        badge.classList.add('pending');
        badge.textContent = '未提出';
      }
      meta.append(numberEl, idEl, badge);

      const codeBlock = document.createElement('pre');
      codeBlock.className = 'code-block';
      codeBlock.textContent = submission?.code || '---';

      const hasPlotOutput = isPlotOutput(submission?.output);
      const outputBlock = document.createElement(hasPlotOutput ? 'div' : 'pre');
      outputBlock.className = 'output-block';
      if (hasPlotOutput) {
        renderPlotPreview(student.userId, currentTaskId, submission, outputBlock);
      } else {
        outputBlock.textContent = submission?.output || '---';
      }

      const evaluation = document.createElement('div');
      evaluation.className = 'evaluation-area';
      const scoreLabel = document.createElement('label');
      scoreLabel.textContent = 'スコア (0-100)';
      const scoreInput = document.createElement('input');
      scoreInput.type = 'number';
      scoreInput.min = '0';
      scoreInput.max = '100';
      scoreInput.className = 'score-input';
      scoreInput.value = localEntry.score !== undefined ? localEntry.score : '';
      scoreInput.disabled = pending || !editable;
      if (!submitted) scoreInput.tabIndex = -1;
      else scoreInput.removeAttribute('tabindex');
      scoreInput.addEventListener('input', evt => {
        editLocalGrade(student.userId, currentTaskId, entry => {
          entry.score = evt.target.value;
        });
        const cardEl = evt.currentTarget.closest('.student-card');
        if (cardEl) cardEl.dataset.editing = 'true';
      });
      scoreLabel.appendChild(scoreInput);

      const commentLabel = document.createElement('label');
      commentLabel.textContent = 'コメント';
      const commentInput = document.createElement('textarea');
      commentInput.className = 'comment-input';
      commentInput.value = localEntry.comment || '';
      commentInput.disabled = pending || !editable;
      if (!submitted) commentInput.tabIndex = -1;
      else commentInput.removeAttribute('tabindex');
      commentInput.addEventListener('input', evt => {
        editLocalGrade(student.userId, currentTaskId, entry => {
          entry.comment = evt.target.value;
        });
        const cardEl = evt.currentTarget.closest('.student-card');
        if (cardEl) cardEl.dataset.editing = 'true';
      });
      commentLabel.appendChild(commentInput);

      evaluation.append(scoreLabel, commentLabel);
      card.append(meta, codeBlock, outputBlock, evaluation);
      gradingTable.appendChild(card);
      renderedCount++;
    });
    if (renderedCount === 0) {
      gradingTable.className = 'empty-state';
      gradingTable.textContent = submittedOnly ? '提出済みのユーザがいません。' : '対象の提出がありません。';
      refreshActionAvailability();
      return;
    }
    refreshActionAvailability();
  }

  function focusFirstVisibleScoreInput(taskId) {
    const cards = Array.from(document.querySelectorAll(`.student-card[data-task-id="${taskId || ''}"]`))
      .filter(card => card.offsetParent !== null);
    const targetInput = cards.length ? cards[0].querySelector('.score-input:not(:disabled)') : null;
    if (targetInput) {
      targetInput.focus();
      targetInput.select();
    }
  }

  function applySaveEntriesToTargets(targetSubmissions, targetLocalGrades, entries) {
    entries.forEach(item => {
      const { userId, taskId, score, comment, savedAt } = item;
      if (!targetSubmissions[userId]) targetSubmissions[userId] = {};
      const existing = targetSubmissions[userId][taskId] || {};
      targetSubmissions[userId][taskId] = {
        ...existing,
        score,
        comment,
        submitted: false,
        savedAt
      };
      const userGrades = targetLocalGrades[userId] || (targetLocalGrades[userId] = {});
      const entry = userGrades[taskId] || {};
      entry.score = score;
      entry.comment = comment || '';
      entry.locked = true;
      entry.submitted = false;
      entry.serverSignature = savedAt || entry.serverSignature || '';
      entry.dirty = false;
      userGrades[taskId] = entry;
    });
  }

  function applySaveResults(classId, taskId, savedEntries) {
    if (!Array.isArray(savedEntries) || !savedEntries.length || !classId) return;
    const isCurrent = classId === state.classId;
    if (isCurrent) {
      applySaveEntriesToTargets(state.submissions, state.localGrades, savedEntries);
      recomputeSubmittedCounts();
      updateCacheFromState();
      renderTaskList();
      if (state.selectedTaskId === taskId) renderStudents();
      else refreshActionAvailability();
      return;
    }
    const snapshot = loadClassCache(classId);
    if (!snapshot) return;
    snapshot.submissions = snapshot.submissions || {};
    snapshot.localGrades = snapshot.localGrades || {};
    applySaveEntriesToTargets(snapshot.submissions, snapshot.localGrades, savedEntries);
    saveClassCache(classId, snapshot);
  }

  async function loadClassData() {
    if (!serverBaseUrl) {
      showMessage('serverBaseUrl が設定されていません。', 'error');
      return;
    }
    const mode = document.querySelector('input[name="targetMode"]:checked')?.value || 'class';
    let classValue = classInput.value.trim();
    if (classValue && classValue.toUpperCase() === 'ALL') classValue = 'ALL';
    const userValue = userInput.value.trim();
    if (mode === 'class' && !classValue) {
      showMessage('クラスIDを入力してください。', 'error');
      return;
    }
    if (mode === 'user' && !userValue) {
      showMessage('ユーザIDを入力してください。', 'error');
      return;
    }

    let cacheClassId = '';
    if (mode === 'class') cacheClassId = classValue;
    else cacheClassId = getCachedUserClass(userValue);

    const cachedSnapshot = cacheClassId ? loadClassCache(cacheClassId) : null;
    if (cachedSnapshot) {
      applyCacheSnapshot(cachedSnapshot, true);
    } else if (mode === 'class') {
      resetStateForLoading(classValue);
    }

    const lastLoadedAt = cachedSnapshot?.fetchedAt || '';
    showMessage('');
    setLoading(true);
    saveStatus.textContent = '';
    try {
      const params = new URLSearchParams();
      params.append('action', 'getClassSubmissions');
      if (mode === 'class') params.append('classId', classValue);
      else if (cacheClassId) params.append('classId', cacheClassId);
      if (mode === 'user') params.append('userId', userValue);
      if (lastLoadedAt) params.append('lastLoadedAt', lastLoadedAt);
      const res = await fetch(serverBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.status !== 'ok') throw new Error(data && data.message ? data.message : '読み込みに失敗しました');
      const serverClassId = data.classId || cacheClassId || classValue || getCachedUserClass(userValue) || '';
      if (!serverClassId) throw new Error('クラスを特定できませんでした');
      rememberUsersFromResponse(data.students || [], data.resolvedUserId || (mode === 'user' ? userValue : ''), serverClassId);
      const mergedCache = mergeCacheSnapshots(loadClassCache(serverClassId) || {}, {
        classId: serverClassId,
        tasks: normalizeTasks(data.tasks || []),
        students: data.students || [],
        submissions: data.submissions || {},
        fetchedAt: data.fetchedAt || ''
      });
      state.latestFetchedAt = mergedCache.fetchedAt || state.latestFetchedAt || '';
      mergedCache.localGrades = mergedCache.localGrades || {};
      saveClassCache(serverClassId, mergedCache);
      applyCacheSnapshot(mergedCache, serverClassId === state.classId);
      showMessage(`クラス ${serverClassId} の課題データを読み込みました。`, 'success');
    } catch (err) {
      console.error(err);
      showMessage(`読み込みに失敗しました: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleBulkFull() {
    const currentTaskId = state.selectedTaskId;
    if (!currentTaskId) return;
    const cards = document.querySelectorAll(`.student-card[data-task-id="${currentTaskId}"][data-submitted="true"]`);
    cards.forEach(card => {
      const input = card.querySelector('.score-input');
      if (!input || input.disabled) return;
      input.value = '100';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    focusFirstVisibleScoreInput(currentTaskId);
  }

  async function handleSave() {
    const classId = state.classId;
    const taskId = state.selectedTaskId;
    if (!classId || !taskId) return;
    const key = pendingKeyFor(classId, taskId);
    if (state.pendingSaves[key] && state.pendingSaves[key].size > 0) {
      saveStatus.className = 'error';
      saveStatus.textContent = 'この課題は保存処理中です。';
      return;
    }
    const targetRows = [];
    state.students.forEach(student => {
      const submission = (state.submissions[student.userId] || {})[taskId];
      const localEntry = ensureLocalGrade(student.userId, taskId, submission);
      const submitted = isSubmittedEntry(submission, localEntry);
      const graded = isGradedEntry(submission, localEntry);
      const manualDirty = !submitted && !graded && entryNeedsManualSave(localEntry);
      if (!submitted && !graded && !manualDirty) return;
      targetRows.push({ student, submission, localEntry, submitted, graded });
    });
    if (!targetRows.length) {
      saveStatus.className = 'error';
      saveStatus.textContent = '提出済・採点済・未提出で採点入力済みの行がありません。';
      return;
    }
    const dirtyRows = targetRows.filter(item => item.localEntry.dirty);
    if (!dirtyRows.length) {
      saveStatus.className = 'error';
      saveStatus.textContent = '更新対象がありません。';
      return;
    }
    const payload = [];
    const invalid = [];
    dirtyRows.forEach(item => {
      const { student, localEntry, submitted } = item;
      const numeric = Number(localEntry.score);
      if (localEntry.score === '' || isNaN(numeric) || numeric < 0 || numeric > 100) {
        invalid.push(student.userId);
      }
      const entry = { userId: student.userId, taskId, score: numeric, comment: localEntry.comment || '' };
      if (!submitted) entry.force = true;
      payload.push(entry);
    });
    if (invalid.length) {
      saveStatus.className = 'error';
      saveStatus.textContent = `スコア未入力: ${invalid.join(', ')}`;
      return;
    }
    const userIds = dirtyRows.map(item => item.student.userId);
    setRowsPending(classId, taskId, userIds, true);
    refreshActionAvailability();
    if (state.selectedTaskId === taskId) renderStudents();
    saveStatus.className = '';
    saveStatus.textContent = '保存中...';
    try {
      const params = new URLSearchParams();
      params.append('action', 'saveScores');
      params.append('entries', JSON.stringify(payload));
      const res = await fetch(serverBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await res.json();
      if (!res.ok || !data || data.status !== 'ok') throw new Error(data && data.message ? data.message : '保存に失敗しました');
      const savedEntries = data.entries || payload.map(entry => ({ ...entry, savedAt: new Date().toISOString() }));
      applySaveResults(classId, taskId, savedEntries);
      saveStatus.className = 'success';
      saveStatus.textContent = '保存しました。';
    } catch (err) {
      console.error(err);
      saveStatus.className = 'error';
      saveStatus.textContent = `保存に失敗しました: ${err.message || err}`;
    } finally {
      setRowsPending(classId, taskId, userIds, false);
      if (state.classId === classId && state.selectedTaskId === taskId) {
        renderStudents();
      } else {
        refreshActionAvailability();
      }
    }
  }

  if (submittedOnlyToggle) {
    submittedOnlyToggle.addEventListener('change', evt => {
      persistSubmittedOnlySetting(!!evt.target.checked);
      renderStudents();
    });
  }

  loadButton.addEventListener('click', loadClassData);
  bulkButton.addEventListener('click', handleBulkFull);
  saveButton.addEventListener('click', handleSave);
})();
