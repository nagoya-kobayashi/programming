(function () {
  const APP = window.APP_CONFIG || {};
  const serverBaseUrl = APP.serverBaseUrl || '';

  const statusDefs = [
    { key: 'cleared', label: 'クリア済', className: 'cleared' },
    { key: 'graded', label: '採点済', className: 'graded' },
    { key: 'submitted', label: '提出済', className: 'submitted' },
    { key: 'pending', label: '未提出', className: 'pending' },
  ];

  const state = {
    classes: [],
    rows: [],
    tasks: [],
    generatedAt: '',
    source: '',
    hiddenClasses: new Set(),
    loading: false,
  };

  const tableEl = document.getElementById('summaryTable');
  const reloadBtn = document.getElementById('reloadButton');
  const rebuildBtn = document.getElementById('rebuildButton');
  const statusLine = document.getElementById('statusMessage');
  const generatedAtEl = document.getElementById('generatedAt');
  const sourceEl = document.getElementById('dataSource');
  const taskFilterEl = document.getElementById('taskFilter');
  const classTogglesEl = document.getElementById('classToggles');
  const displayModeBtn = document.getElementById('displayModeButton');
  const tableWrap = document.getElementById('tableWrap');
  const scrollRailInner = document.getElementById('scrollRailInner');
  const scrollRailSpacer = document.getElementById('scrollRailSpacer');
  const collapsedFolders = new Set();
  let showPercent = false;

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

  function updateMeta() {
    generatedAtEl.textContent = state.generatedAt ? `更新日時: ${state.generatedAt}` : '更新日時: --';
    sourceEl.textContent = state.source ? `ソース: ${state.source}` : 'ソース: --';
  }

  function normalizeCount(value) {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }

  function emptyCounts() {
    return { cleared: 0, graded: 0, submitted: 0, pending: 0 };
  }

  function sumCounts(target = {}, source = {}) {
    statusDefs.forEach(def => {
      const cur = Number(target[def.key] || 0);
      const add = Number(source[def.key] || 0);
      target[def.key] = (Number.isNaN(cur) ? 0 : cur) + (Number.isNaN(add) ? 0 : add);
    });
    return target;
  }

  function buildTaskTree(tasks = []) {
    const map = new Map();
    tasks.forEach(t => map.set(t.taskId, { ...t, children: [] }));
    const roots = [];
    map.forEach(node => {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    });
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        const af = a.isFolder ? 0 : 1;
        const bf = b.isFolder ? 0 : 1;
        if (af !== bf) return af - bf;
        return String(a.title || '').localeCompare(String(b.title || ''), 'ja');
      });
      nodes.forEach(n => sortNodes(n.children));
    };
    sortNodes(roots);
    return roots;
  }

  function filterTree(nodes, rows, queryText) {
    const rowSet = new Set(rows.map(r => r.taskId));
    const q = (queryText || '').trim().toLowerCase();
    const match = (node) => {
      const title = (node.title || '').toLowerCase();
      const path = (node.path || '').toLowerCase();
      const id = (node.taskId || '').toLowerCase();
      return title.includes(q) || path.includes(q) || id.includes(q);
    };
    const dfs = (node) => {
      const filteredChildren = (node.children || []).map(dfs).filter(Boolean);
      const hasRow = rowSet.has(node.taskId);
      const selfHit = !q || match(node);
      if (filteredChildren.length || (hasRow && selfHit)) {
        return { ...node, children: filteredChildren };
      }
      return null;
    };
    return nodes.map(dfs).filter(Boolean);
  }

  function filteredRows() {
    const q = (taskFilterEl.value || '').trim().toLowerCase();
    if (!q) return state.rows || [];
    return (state.rows || []).filter(row => {
      const path = (row.path || '').toLowerCase();
      const title = (row.title || '').toLowerCase();
      const taskId = (row.taskId || '').toLowerCase();
      return path.includes(q) || title.includes(q) || taskId.includes(q);
    });
  }

  function computeAggregates(rows, tasks) {
    const countsByTask = {};
    rows.forEach(r => { countsByTask[r.taskId] = r.counts || {}; });
    const aggregates = new Map();
    const roots = buildTaskTree(tasks);
    function agg(node) {
      const own = countsByTask[node.taskId] || {};
      const total = {};
      Object.keys(own).forEach(cls => {
        total[cls] = sumCounts(emptyCounts(), own[cls]);
      });
      node.children.forEach(child => {
        const childCounts = agg(child);
        Object.entries(childCounts).forEach(([cls, c]) => {
          if (!total[cls]) total[cls] = emptyCounts();
          sumCounts(total[cls], c);
        });
      });
      aggregates.set(node.taskId, total);
      return total;
    }
    roots.forEach(agg);
    return aggregates;
  }

  function computeClassTotals() {
    const totals = {};
    (state.rows || []).forEach(row => {
      Object.entries(row.counts || {}).forEach(([cls, c]) => {
        if (!totals[cls]) totals[cls] = emptyCounts();
        statusDefs.forEach(def => {
          totals[cls][def.key] += normalizeCount((c || {})[def.key]);
        });
      });
    });
    return totals;
  }

  function renderClassToggles() {
    classTogglesEl.innerHTML = '';
    if (!state.classes.length) {
      classTogglesEl.textContent = 'クラス情報なし';
      return;
    }
    const totals = computeClassTotals();
    state.classes.forEach(cls => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-toggle';
      btn.dataset.hidden = state.hiddenClasses.has(cls) ? 'true' : 'false';
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.appendChild(dot);
      const text = document.createElement('span');
      text.textContent = cls;
      btn.appendChild(text);
      const count = document.createElement('span');
      const total = totals[cls] || {};
      count.textContent = total.cleared || 0;
      count.title = 'クリア済件数';
      count.style.color = 'var(--status-cleared)';
      btn.appendChild(count);
      btn.addEventListener('click', () => {
        if (state.hiddenClasses.has(cls)) state.hiddenClasses.delete(cls);
        else state.hiddenClasses.add(cls);
        renderClassToggles();
        renderTable();
      });
      classTogglesEl.appendChild(btn);
    });
  }

  function renderNode(node, aggregates, visibleClasses, tbody, depth) {
    const tr = document.createElement('tr');
    const tdTask = document.createElement('td');
    tdTask.className = 'task-cell';
    tdTask.style.paddingLeft = `${12 + depth * 18}px`;
    const label = document.createElement('span');
    label.className = 'task-label';
    const toggle = document.createElement('span');
    toggle.className = `task-toggle ${node.isFolder ? '' : 'leaf'}`;
    toggle.textContent = collapsedFolders.has(node.taskId) ? '▶' : '▼';
    if (node.isFolder) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsedFolders.has(node.taskId)) collapsedFolders.delete(node.taskId);
        else collapsedFolders.add(node.taskId);
        renderTable();
      });
    }
    label.appendChild(toggle);
    const title = document.createElement('span');
    title.textContent = node.title || node.taskId;
    label.appendChild(title);
    tdTask.appendChild(label);
    tr.appendChild(tdTask);

    const counts = aggregates.get(node.taskId) || {};
    const visibleTotal = {};
    visibleClasses.forEach(cls => {
      sumCounts(visibleTotal, counts[cls] || emptyCounts());
    });

    statusDefs.forEach(def => {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = `count ${def.className}`;
      const base = totalOfCounts(visibleTotal);
      span.textContent = formatValue(visibleTotal[def.key], base);
      td.appendChild(span);
      tr.appendChild(td);
    });

    visibleClasses.forEach(cls => {
      const c = counts[cls] || emptyCounts();
      statusDefs.forEach(def => {
        const td = document.createElement('td');
        const span = document.createElement('span');
        span.className = `count ${def.className}`;
        const base = totalOfCounts(c);
        span.textContent = formatValue(c[def.key], base);
        td.appendChild(span);
        tr.appendChild(td);
      });
    });

    tbody.appendChild(tr);
    if (node.isFolder && collapsedFolders.has(node.taskId)) return;
    (node.children || []).forEach(child => renderNode(child, aggregates, visibleClasses, tbody, depth + 1));
  }

  function totalOfCounts(counts = {}) {
    return ['cleared', 'graded', 'submitted', 'pending'].reduce((acc, k) => acc + normalizeCount(counts[k]), 0);
  }

  function formatValue(count, base) {
    if (!showPercent) return normalizeCount(count);
    const total = Number(base || 0);
    if (total <= 0) return '-';
    const pct = (normalizeCount(count) / total) * 100;
    return `${pct.toFixed(1)}%`;
  }

  function renderTable() {
    tableEl.innerHTML = '';
    const visibleClasses = state.classes.filter(cls => !state.hiddenClasses.has(cls));
    const rows = filteredRows();
    if (!visibleClasses.length) {
      tableEl.innerHTML = '<tbody><tr class="empty-row"><td>すべてのクラス列が非表示です。トグルで列を表示してください。</td></tr></tbody>';
      return;
    }
    if (!rows.length || !state.tasks.length) {
      tableEl.innerHTML = '<tbody><tr class="empty-row"><td>表示するデータがありません。</td></tr></tbody>';
      return;
    }

    const aggregates = computeAggregates(rows, state.tasks);
    const treeRoots = buildTaskTree(state.tasks);
    const filteredTree = filterTree(treeRoots, rows, taskFilterEl.value || '');

    const thead = document.createElement('thead');
    const headTop = document.createElement('tr');
    const thTask = document.createElement('th');
    thTask.rowSpan = 2;
    thTask.textContent = '課題';
    thTask.className = 'task-col';
    headTop.appendChild(thTask);

    const thTotal = document.createElement('th');
    thTotal.colSpan = statusDefs.length;
    thTotal.textContent = '合計（表示中のクラス）';
    headTop.appendChild(thTotal);

    visibleClasses.forEach(cls => {
      const th = document.createElement('th');
      th.colSpan = statusDefs.length;
      th.textContent = cls;
      headTop.appendChild(th);
    });

    const headBottom = document.createElement('tr');
    statusDefs.forEach(def => {
      const th = document.createElement('th');
      th.textContent = def.label;
      headBottom.appendChild(th);
    });
    visibleClasses.forEach(() => {
      statusDefs.forEach(def => {
        const th = document.createElement('th');
        th.textContent = def.label;
        headBottom.appendChild(th);
      });
    });
    thead.appendChild(headTop);
    thead.appendChild(headBottom);

    const tbody = document.createElement('tbody');
    filteredTree.forEach(node => renderNode(node, aggregates, visibleClasses, tbody, 0));
    renderTotalRow(tbody, rows, visibleClasses);

    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
    syncScrollRail();
  }

  async function fetchSummary(opts = {}) {
    if (!serverBaseUrl) {
      showMessage('serverBaseUrl が設定されていません。config.js を確認してください。', 'error');
      return;
    }
    const rebuild = !!opts.rebuild;
    setLoading(true);
    showMessage(rebuild ? '再集計しています...' : '読み込み中...');
    try {
      const params = new URLSearchParams();
      params.append('action', rebuild ? 'buildSubmissionSummary' : 'getSubmissionSummary');
      const res = await fetch(serverBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.status !== 'ok') throw new Error(data && data.message ? data.message : '集計を取得できませんでした');

      state.classes = Array.isArray(data.classes) ? data.classes : [];
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.generatedAt = data.generatedAt || '';
      state.source = data.source || (rebuild ? 'rebuilt' : 'cached');
      if (rebuild) state.hiddenClasses.clear();

      collapsedFolders.clear();
      state.tasks.filter(t => t.isFolder).forEach(t => collapsedFolders.add(t.taskId));
      renderClassToggles();
      renderTable();
      updateMeta();
      showMessage(rebuild ? '再集計が完了しました。' : '集計シートを読み込みました。', 'success');
    } catch (err) {
      console.error(err);
      showMessage(`読み込みに失敗しました: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  reloadBtn.addEventListener('click', () => fetchSummary({ rebuild: false }));
  rebuildBtn.addEventListener('click', () => fetchSummary({ rebuild: true }));
  taskFilterEl.addEventListener('input', renderTable);
  if (displayModeBtn) {
    displayModeBtn.addEventListener('click', () => {
      showPercent = !showPercent;
      displayModeBtn.textContent = showPercent ? '％表示' : '件数表示';
      renderTable();
    });
  }

  if (tableWrap && scrollRailInner) {
    tableWrap.addEventListener('scroll', () => {
      scrollRailInner.scrollLeft = tableWrap.scrollLeft;
    });
    scrollRailInner.addEventListener('scroll', () => {
      if (tableWrap.scrollLeft !== scrollRailInner.scrollLeft) {
        tableWrap.scrollLeft = scrollRailInner.scrollLeft;
      }
    });
  }

  fetchSummary({ rebuild: false });

  function syncScrollRail() {
    if (!tableWrap || !scrollRailSpacer || !scrollRailInner) return;
    scrollRailSpacer.style.width = `${tableWrap.scrollWidth}px`;
    scrollRailInner.scrollLeft = tableWrap.scrollLeft;
  }

  function renderTotalRow(tbody, rows, visibleClasses) {
    if (!rows || !rows.length) return;
    const totals = {};
    visibleClasses.forEach(cls => { totals[cls] = emptyCounts(); });
    rows.forEach(row => {
      visibleClasses.forEach(cls => {
        sumCounts(totals[cls], (row.counts || {})[cls] || {});
      });
    });
    const tr = document.createElement('tr');
    tr.className = 'total-row';
    const tdTask = document.createElement('td');
    tdTask.className = 'task-cell task-col';
    tdTask.textContent = '合計';
    tr.appendChild(tdTask);

    const combined = {};
    visibleClasses.forEach(cls => { sumCounts(combined, totals[cls]); });
    statusDefs.forEach(def => {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = `count ${def.className}`;
      span.textContent = formatValue(combined[def.key], totalOfCounts(combined));
      td.appendChild(span);
      tr.appendChild(td);
    });

    visibleClasses.forEach(cls => {
      const c = totals[cls] || emptyCounts();
      statusDefs.forEach(def => {
        const td = document.createElement('td');
        const span = document.createElement('span');
        span.className = `count ${def.className}`;
        span.textContent = formatValue(c[def.key], totalOfCounts(c));
        td.appendChild(span);
        tr.appendChild(td);
      });
    });

    tbody.appendChild(tr);
  }
})();
