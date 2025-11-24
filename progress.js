(function () {
  const APP = window.APP_CONFIG || {};
  const serverBaseUrl = APP.serverBaseUrl || '';

  const attrColors = {
    '基礎': getComputedStyle(document.documentElement).getPropertyValue('--attr-basic') || '#35c759',
    '演習': getComputedStyle(document.documentElement).getPropertyValue('--attr-practice') || '#2d8dfc',
    '発展': getComputedStyle(document.documentElement).getPropertyValue('--attr-advanced') || '#ff4d67',
    'その他': getComputedStyle(document.documentElement).getPropertyValue('--attr-other') || '#f3b12f'
  };

  const state = {
    tasks: [],
    rows: [],
    attributes: ['基礎', '演習', '発展', 'その他'],
    generatedAt: '',
    source: '',
    loading: false,
    filterText: '',
    taskSearch: '',
    sortKey: 'user',
    sortDir: 'asc'
  };

  const tableEl = document.getElementById('progressTable');
  const reloadBtn = document.getElementById('reloadButton');
  const rebuildBtn = document.getElementById('rebuildButton');
  const statusLine = document.getElementById('statusMessage');
  const generatedAtEl = document.getElementById('generatedAt');
  const sourceEl = document.getElementById('dataSource');
  const classFilterEl = document.getElementById('classFilter');
  const taskSearchEl = document.getElementById('taskSearch');
  const legendEl = document.getElementById('legend');
  const sortUserBtn = document.getElementById('sortUserButton');
  const sortCountBtn = document.getElementById('sortCountButton');
  const sortScoreBtn = document.getElementById('sortScoreButton');
  const hiddenAttributes = new Set();
  const defaultAttrs = ['基礎', '演習', '発展', 'その他'];

  function showMessage(text, type = '') {
    statusLine.textContent = text || '';
    statusLine.className = `status-line${type ? ' ' + type : ''}`;
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    reloadBtn.disabled = isLoading;
    rebuildBtn.disabled = isLoading;
    rebuildBtn.textContent = isLoading ? '処理中...' : '再集計して更新';
  }

  function normalizeAttr(value) {
    const s = String(value || '').replace(/\s+/g, '').trim();
    const allowed = defaultAttrs;
    if (allowed.includes(s)) return s;
    if (/基礎/.test(s)) return '基礎';
    if (/演習/.test(s)) return '演習';
    if (/発展/.test(s)) return '発展';
    return 'その他';
  }

  function extractTopFolderLabel(path) {
    const parts = String(path || '').split(' / ').filter(Boolean);
    if (parts.length >= 1) {
      return String(parts[0] || '').slice(0, 3) || '---';
    }
    return '---';
  }

  function aggregateRow(row, visibleTasks) {
    let cleared = 0;
    let total = 0;
    let scoreSum = 0;
    let maxScore = 0;
    visibleTasks.forEach(task => {
      total += 1;
      maxScore += 100;
      const scoreRaw = row.scoreMap ? row.scoreMap[task.taskId] : '';
      const numeric = Number(scoreRaw);
      const isNumeric = !Number.isNaN(numeric);
      const isCleared = isNumeric && numeric === 100;
      if (isCleared) cleared += 1;
      if (isNumeric) scoreSum += numeric;
    });
    return { cleared, total, scoreSum, maxScore };
  }

  function sortRows(rows, tasks) {
    const { sortKey, sortDir } = state;
    if (!sortKey) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].map(row => ({ row, agg: aggregateRow(row, tasks) }))
      .sort((a, b) => {
        if (sortKey === 'user') {
          return String(a.row.userId || '').localeCompare(String(b.row.userId || '')) * dir;
        }
        const av = sortKey === 'count' ? a.agg.cleared : a.agg.scoreSum;
        const bv = sortKey === 'count' ? b.agg.cleared : b.agg.scoreSum;
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      })
      .map(x => x.row);
  }

  function updateMeta() {
    generatedAtEl.textContent = state.generatedAt ? `更新日時: ${state.generatedAt}` : '更新日時: --';
    sourceEl.textContent = state.source ? `ソース: ${state.source}` : 'ソース: --';
  }

  function filteredRows() {
    const q = (state.filterText || '').trim().toLowerCase();
    if (!q) return state.rows || [];
    return (state.rows || []).filter(row => {
      return [row.userId, row.classId, row.number].some(v => String(v || '').toLowerCase().includes(q));
    });
  }

  function getVisibleAttributes() {
    const attrs = state.attributes && state.attributes.length ? state.attributes : defaultAttrs;
    return attrs.filter(a => !hiddenAttributes.has(a));
  }

  function visibleTasks() {
    const q = (state.taskSearch || '').trim().toLowerCase();
    return (state.tasks || []).filter(t => {
      if (hiddenAttributes.has(t.attribute)) return false;
      if (!q) return true;
      const path = String(t.path || '').toLowerCase();
      const title = String(t.title || '').toLowerCase();
      const id = String(t.taskId || '').toLowerCase();
      return path.includes(q) || title.includes(q) || id.includes(q);
    });
  }

  function buildBaseColumns(attrs) {
    const cols = [
      { key: 'userId', label: 'ユーザID', type: 'id' },
      { key: 'classId', label: 'クラス', type: 'class' },
      { key: 'number', label: '番号', type: 'number' },
      { key: 'count', label: '件数', type: 'count' },
      { key: 'score', label: 'スコア', type: 'score' }
    ];
    return cols;
  }

  function createSummaryCell(value, total) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pair';
    const num = document.createElement('span');
    num.className = 'numerator';
    num.textContent = Number(value || 0);
    const denom = document.createElement('span');
    denom.className = 'denominator';
    denom.textContent = `/ ${Number(total || 0)}`;
    wrapper.appendChild(num);
    wrapper.appendChild(denom);
    return wrapper;
  }

  function renderTable() {
    tableEl.innerHTML = '';
    const tasks = visibleTasks();
    const rows = filteredRows();
    const attrs = getVisibleAttributes();
    const baseCols = buildBaseColumns(attrs);
    const stickyCount = baseCols.length;

    if (!rows.length || !tasks.length) {
      tableEl.innerHTML = '<tbody><tr><td class="empty-row">表示するデータがありません。再集計またはフィルタを確認してください。</td></tr></tbody>';
      return;
    }
    const sortedRows = sortRows(rows, tasks);

    // 可視タスク用の集計を計算（表示タスクのみでクリア件数・総数・スコア合計を再集計）
    const visibleTaskMeta = tasks.map(t => ({
      taskId: t.taskId,
      attribute: t.attribute,
      path: t.path
    }));

    const thead = document.createElement('thead');
    const attrRow = document.createElement('tr');
    baseCols.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.dataset.colIndex = idx;
      th.dataset.colKey = col.key;
      th.classList.add('sticky-col', 'base-col');
      th.rowSpan = 3;
      th.scope = 'col';
      attrRow.appendChild(th);
    });

    // 属性でグルーピング（1行目）
    const attrGroups = [];
    let currentAttr = null;
    visibleTaskMeta.forEach((t) => {
      if (!currentAttr || currentAttr.label !== t.attribute) {
        currentAttr = { label: t.attribute, count: 0 };
        attrGroups.push(currentAttr);
      }
      currentAttr.count += 1;
    });
    attrGroups.forEach(g => {
      const th = document.createElement('th');
      th.className = 'group-head';
      th.textContent = g.label;
      th.colSpan = g.count;
      attrRow.appendChild(th);
    });

    // 最上位フォルダでグルーピング（2行目）
    const folderRow = document.createElement('tr');
    const folderGroups = [];
    let currentFolder = null;
    visibleTaskMeta.forEach((t) => {
      const folderLabel = extractTopFolderLabel(t.path);
      const key = `${t.attribute}|${folderLabel}`; // 属性を跨いで結合しない
      if (!currentFolder || currentFolder.key !== key) {
        currentFolder = { key, label: folderLabel, count: 0 };
        folderGroups.push(currentFolder);
      }
      currentFolder.count += 1;
    });
    folderGroups.forEach(g => {
      const th = document.createElement('th');
      th.className = 'group-head';
      th.textContent = g.label;
      th.colSpan = g.count;
      folderRow.appendChild(th);
    });

    // 課題タイトル行（頭1文字）（3行目）
    const taskRow = document.createElement('tr');
    tasks.forEach((task, i) => {
      const th = document.createElement('th');
      th.dataset.colIndex = baseCols.length + i;
      th.className = 'task-head-cell';
      const head = document.createElement('div');
      head.className = 'task-head';
      const title = document.createElement('div');
      title.className = 'title';
      const shortTitle = (task.title || task.taskId || '?').trim().slice(0, 1) || '?';
      title.textContent = shortTitle;
      head.appendChild(title);
      th.appendChild(head);
      taskRow.appendChild(th);
    });

    thead.appendChild(attrRow);
    thead.appendChild(folderRow);
    thead.appendChild(taskRow);

    const tbody = document.createElement('tbody');
    sortedRows.forEach(row => {
      const tr = document.createElement('tr');
      baseCols.forEach((col, idx) => {
        const td = document.createElement('td');
        td.dataset.colIndex = idx;
        td.dataset.colKey = col.key;
        td.classList.add('sticky-col', 'summary-col');
        // 可視タスクのみで再集計
        const agg = aggregateRow(row, tasks);
        if (col.type === 'id') {
          td.textContent = row.userId || '';
        } else if (col.type === 'class') {
          td.textContent = row.classId || '';
        } else if (col.type === 'number') {
          td.textContent = row.number || '';
        } else if (col.type === 'count') {
          td.appendChild(createSummaryCell(agg.cleared, agg.total));
        } else if (col.type === 'score') {
          td.appendChild(createSummaryCell(agg.scoreSum, agg.maxScore));
        }
        tr.appendChild(td);
      });

      tasks.forEach((task, i) => {
        const td = document.createElement('td');
        td.className = 'score-cell';
        const score = row.scoreMap ? row.scoreMap[task.taskId] : (row.scores ? row.scores[i] : '');
        const text = score === undefined || score === null ? '' : String(score);
        if (!text || text.trim() === '') {
          td.classList.add('empty');
          td.textContent = '';
        } else {
          const numeric = Number(text);
          if (!Number.isNaN(numeric) && numeric === 100) {
            const star = document.createElement('span');
            star.className = 'star';
            star.textContent = '★';
            star.style.color = attrColors[task.attribute] || '#fadb14';
            td.appendChild(star);
          } else {
            const span = document.createElement('span');
            span.className = 'score-text';
            span.textContent = text;
            td.appendChild(span);
          }
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
    requestAnimationFrame(() => applyStickyOffsets(stickyCount));
  }

  function applyStickyOffsets(stickyCount) {
    const headerCells = Array.from(tableEl.querySelectorAll('th[data-col-index]'));
    if (!headerCells.length) return;
    let offset = 0;
    for (let i = 0; i < stickyCount; i++) {
      const th = headerCells.find(cell => Number(cell.dataset.colIndex) === i);
      if (!th) continue;
      const width = th.getBoundingClientRect().width;
      const left = offset;
      tableEl.querySelectorAll(`[data-col-index="${i}"]`).forEach(cell => {
        cell.style.left = `${left}px`;
      });
      offset += width;
    }
  }

  async function fetchProgress(opts = {}) {
    if (!serverBaseUrl) {
      showMessage('serverBaseUrl が設定されていません。config.js を確認してください。', 'error');
      return;
    }
    const rebuild = !!opts.rebuild;
    setLoading(true);
    showMessage(rebuild ? '再集計しています...' : '読み込み中...');
    try {
      const params = new URLSearchParams();
      params.append('action', rebuild ? 'buildUserProgress' : 'getUserProgress');
      const res = await fetch(serverBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.status !== 'ok') throw new Error(data && data.message ? data.message : '進捗表を取得できませんでした');

      state.tasks = Array.isArray(data.tasks) ? data.tasks.map(t => ({
        taskId: t.taskId,
        title: t.title || t.taskId,
        path: t.path || t.title || t.taskId,
        attribute: normalizeAttr(t.attribute)
      })) : [];
      state.rows = Array.isArray(data.rows) ? data.rows.map(row => {
        const scoreMap = {};
        state.tasks.forEach((t, idx) => {
          const val = row.scores ? row.scores[idx] : '';
          scoreMap[t.taskId] = val === undefined || val === null ? '' : val;
        });
        return { ...row, scoreMap };
      }) : [];
      state.attributes = Array.isArray(data.attributes) && data.attributes.length ? data.attributes.map(normalizeAttr) : defaultAttrs;
      state.generatedAt = data.generatedAt || '';
      state.source = data.source || (rebuild ? 'rebuilt' : 'cached');

      renderTable();
      updateMeta();
      updateSortButtons();
      showMessage(rebuild ? '再集計が完了しました。' : 'シートを読み込みました。', 'success');
    } catch (err) {
      console.error(err);
      showMessage(`読み込みに失敗しました: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  reloadBtn.addEventListener('click', () => fetchProgress({ rebuild: false }));
  rebuildBtn.addEventListener('click', () => fetchProgress({ rebuild: true }));
  classFilterEl.addEventListener('input', (e) => {
    state.filterText = e.target.value || '';
    renderTable();
  });
  taskSearchEl.addEventListener('input', (e) => {
    state.taskSearch = e.target.value || '';
    renderTable();
  });
  legendEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.legend-item');
    if (!btn) return;
    const attr = btn.dataset.attr;
    if (!attr) return;
    if (hiddenAttributes.has(attr)) hiddenAttributes.delete(attr);
    else hiddenAttributes.add(attr);
    updateLegend();
    renderTable();
  });

  function updateLegend() {
    legendEl.querySelectorAll('.legend-item').forEach(btn => {
      const attr = btn.dataset.attr;
      const active = !hiddenAttributes.has(attr);
      btn.dataset.active = active ? 'true' : 'false';
    });
  }

  function updateSortButtons() {
    if (sortUserBtn) {
      const active = state.sortKey === 'user';
      sortUserBtn.dataset.active = active ? 'true' : 'false';
      const dir = active ? state.sortDir : 'asc';
      sortUserBtn.textContent = `${active ? '▶' : ''}ユーザID ${dir === 'asc' ? '▲' : '▼'}`;
    }
    if (sortCountBtn) {
      const active = state.sortKey === 'count';
      sortCountBtn.dataset.active = active ? 'true' : 'false';
      const dir = active ? state.sortDir : 'desc';
      sortCountBtn.textContent = `${active ? '▶' : ''}件数 ${dir === 'asc' ? '▲' : '▼'}`;
    }
    if (sortScoreBtn) {
      const active = state.sortKey === 'score';
      sortScoreBtn.dataset.active = active ? 'true' : 'false';
      const dir = active ? state.sortDir : 'desc';
      sortScoreBtn.textContent = `${active ? '▶' : ''}スコア ${dir === 'asc' ? '▲' : '▼'}`;
    }
  }

  if (sortUserBtn) {
    sortUserBtn.addEventListener('click', () => {
      if (state.sortKey === 'user') {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = 'user';
        state.sortDir = 'asc';
      }
      updateSortButtons();
      renderTable();
    });
  }
  if (sortCountBtn) {
    sortCountBtn.addEventListener('click', () => {
      if (state.sortKey === 'count') {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = 'count';
        state.sortDir = 'desc';
      }
      updateSortButtons();
      renderTable();
    });
  }
  if (sortScoreBtn) {
    sortScoreBtn.addEventListener('click', () => {
      if (state.sortKey === 'score') {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = 'score';
        state.sortDir = 'desc';
      }
      updateSortButtons();
      renderTable();
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(() => {
    applyStickyOffsets(buildBaseColumns(getVisibleAttributes()).length);
  }));

  fetchProgress({ rebuild: false });
  updateLegend();
  updateSortButtons();
})();
