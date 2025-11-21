// task_panel.js: 課題リストの取得・描画・進捗表示

function applyTasksData(normalized) {
  if (!Array.isArray(normalized)) {
    tasksData = [];
    return;
  }
  loadCollapsedState();
  const anySaved = Object.keys(collapsed).length > 0;
  const currentFolderIds = new Set(normalized.filter(t => t.IsFolder === true).map(t => t.TaskId));
  if (!anySaved) {
    currentFolderIds.forEach(id => (collapsed[id] = true));
    saveCollapsedState();
  } else {
    currentFolderIds.forEach(id => { if (!(id in collapsed)) collapsed[id] = true; });
    for (const id of Object.keys(collapsed)) {
      if (!currentFolderIds.has(id)) delete collapsed[id];
    }
    saveCollapsedState();
  }

  tasksData = normalized.map(t => ({
    id: t.TaskId,
    title: t.Title || t.TaskId,
    description: t.DescriptionHtml || '',
    hint: t.HintHtml || '',
    answer: t.AnswerCode || '',
    initialCode: t.InitialCode || '',
    parentId: t.ParentId || '',
    isFolder: !!t.IsFolder
  }));
}

async function loadTaskListFromServer() {
  tasksData = [];
  if (!APP_CONFIG.serverBaseUrl) {
    console.warn('[Main] serverBaseUrl が未設定');
    return;
  }
  if (!sheetIO || !commPayload) {
    console.warn('[Main] 通信ユーティリティが初期化されていません');
    return;
  }
  const payload = commPayload.createTaskListPayload({ sessionId, userId, userClass, userNumber });

  try {
    console.log('[main] getTasks: POST', APP_CONFIG.serverBaseUrl);
    const res = await sheetIO.requestTaskList(payload);
    if (!res) { console.error('[Main] getTasks の通信に失敗しました（レスポンスなし）'); return; }
    const text = await safeText(res);
    if (!res.ok) { console.error('[Main] getTasks HTTP', res.status, text); return; }
    const json = safeJson(text);
    if (!json || json.status !== 'ok' || !Array.isArray(json.tasks)) {
      console.error('[Main] getTasks アプリエラー', json); return;
    }
    console.log('[main] getTasks: received tasks=', json.tasks.length);
    const normalized = normalizeTasks(json.tasks);
    applyTasksData(normalized);
  } catch (err) {
    console.error('[Main] getTasks 通信エラー', err);
  }
}

function normalizeTasks(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (typeof raw[0] === "object" && !Array.isArray(raw[0])) {
    return raw.map(obj => normalizeTaskObject(obj));
  }
  if (Array.isArray(raw[0])) {
    const headerRow = raw[0].map(h => toCanonicalHeader(h));
    const rows = raw.slice(1);
    const idx = {
      taskid: headerRow.indexOf("taskid"),
      title: headerRow.indexOf("title"),
      descriptionhtml: headerRow.indexOf("descriptionhtml"),
      hinthtml: headerRow.indexOf("hinthtml"),
      answercode: headerRow.indexOf("answercode"),
      initialcode: headerRow.indexOf("initialcode"),
      parentid: headerRow.indexOf("parentid"),
      isfolder: headerRow.indexOf("isfolder"),
    };
    return rows.map(r => {
      const obj = {
        TaskId: getCell(r, idx.taskid),
        Title: getCell(r, idx.title),
        DescriptionHtml: getCell(r, idx.descriptionhtml),
        HintHtml: getCell(r, idx.hinthtml),
        AnswerCode: getCell(r, idx.answercode),
        InitialCode: getCell(r, idx.initialcode),
        ParentId: getCell(r, idx.parentid),
        IsFolder: toBool(getCell(r, idx.isfolder)),
      };
      return normalizeTaskObject(obj);
    }).filter(t => t.TaskId);
  }
  return [];
}
function toCanonicalHeader(h) {
  const s = String(h || "").replace(/^\uFEFF/, "").trim().toLowerCase();
  if (s === "isfolder" || s === "is_folder") return "isfolder";
  if (s === "parent" || s === "parent_id") return "parentid";
  return s;
}
function getCell(row, idx) { if (idx < 0 || idx == null) return ""; return row[idx]; }
function toBool(v) { const s = String(v || "").trim().toLowerCase(); return s === "true" || s === "1" || s === "yes" || s === "y"; }
function normalizeTaskObject(t) {
  const pick = (o, ks) => { for (const k of ks) { if (o[k] != null && o[k] !== "") return o[k]; } return ""; };
  return {
    TaskId: pick(t, ["TaskId","taskId","taskid"]),
    Title: pick(t, ["Title","title"]) || pick(t, ["TaskId","taskId","taskid"]),
    DescriptionHtml: pick(t, ["DescriptionHtml","descriptionHtml","description","Description"]),
    HintHtml: pick(t, ["HintHtml","hintHtml","hint","Hint"]),
    AnswerCode: pick(t, ["AnswerCode","answerCode","answer","Answer"]),
    InitialCode: pick(t, ["InitialCode","initialCode"]),
    ParentId: pick(t, ["ParentId","parentId","parentid"]),
    IsFolder: toBool(pick(t, ["IsFolder","isFolder","isfolder"]))
  };
}

function renderTaskTree() {
  const ul = document.getElementById("tasks");
  while (ul.firstChild) ul.removeChild(ul.firstChild);

  const byParent = new Map();
  tasksData.forEach(t => {
    const key = t.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  });

  const sortChildren = (arr) => {
    arr.sort((a, b) => {
      const af = a.isFolder ? 0 : 1;
      const bf = b.isFolder ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.title || "").localeCompare(b.title || "");
    });
  };

  const renderGroup = (parentId, level) => {
    const list = byParent.get(parentId || "") || [];
    sortChildren(list);

    list.forEach(item => {
      const li = document.createElement("li");
      li.dataset.taskId = item.id;
      li.style.setProperty("--indent", `${level * 18}px`);

      li.appendChild(Object.assign(document.createElement("span"), { className: "indent" }));

      if (item.isFolder) {
        const btn = document.createElement("span");
        btn.className = "toggle-btn";
        const isCollapsed = !!collapsed[item.id];
        btn.textContent = isCollapsed ? "+" : "-";
        btn.title = isCollapsed ? "展開" : "折りたたみ";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          collapsed[item.id] = !collapsed[item.id];
          saveCollapsedState();
          renderTaskTree();
        });
        li.appendChild(btn);
      } else {
        li.appendChild(Object.assign(document.createElement("span"), { className: "toggle-ph" }));
      }

      if (item.isFolder) {
        li.appendChild(Object.assign(document.createElement("span"), { className: "icon-ph" }));
      } else {
        const icon = document.createElement("span");
        icon.className = "task-icon dot-icon";
        icon.textContent = "●";
        icon.style.background = "transparent";
        icon.style.color = statusColors.empty;
        li.appendChild(icon);
      }

      const titleCell = document.createElement("span");
      titleCell.className = "title-cell";
      titleCell.textContent = item.title || item.id;
      li.appendChild(titleCell);

      if (!item.isFolder) {
        const badge = document.createElement("span");
        badge.className = "status-badge";
        badge.textContent = "";
        li.appendChild(badge);
      }

      if (item.isFolder) {
        li.classList.add("folder-item");
        li.addEventListener("click", () => {
          collapsed[item.id] = !collapsed[item.id];
          saveCollapsedState();
          renderTaskTree();
        });
        ul.appendChild(li);
        if (!collapsed[item.id]) renderGroup(item.id, level + 1);
      } else {
        li.addEventListener("click", () => selectTask(item.id));
        ul.appendChild(li);
      }
    });
  };

  renderGroup("", 0);

  applyResultsToList();
  updateStatusBadges();
  if (currentTaskId) saveLocalState(currentTaskId);
}

function loadCollapsedState() {
  if (collapseLoaded) return;
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY());
    if (raw) Object.assign(collapsed, JSON.parse(raw) || {});
  } catch {}
  collapseLoaded = true;
}
function saveCollapsedState() {
  try { localStorage.setItem(COLLAPSE_KEY(), JSON.stringify({ ...collapsed })); } catch {}
}

async function loadResults() {
  try {
    const resultsPath = APP_CONFIG.resultsPath;
    if (!resultsPath) {
      hydrateResultsFromSnapshot(true);
      return;
    }
    const res = sheetIO && typeof sheetIO.fetchResults === 'function'
      ? await sheetIO.fetchResults(resultsPath)
      : await fetch(commPayload ? commPayload.buildEndpoint(resultsPath) : resultsPath);
    if (res.ok) {
      resultsData = (await res.json()) || {};
      applyResultsToList();
      updateStatusBadges();
    } else {
      hydrateResultsFromSnapshot(false);
    }
  } catch {
    hydrateResultsFromSnapshot(false);
  }
}

function hydrateResultsFromSnapshot(forceReload) {
  resultsData = {};
  if (!userClass || !userNumber) return;
  const snap = loadSnapshot(forceReload);
  if (!snap || !snap.states) {
    applyResultsToList();
    updateStatusBadges();
    return;
  }
  const classBucket = resultsData[userClass] || {};
  const perTask = {};
  Object.entries(snap.states).forEach(([taskId, state]) => {
    if (!state) return;
    const scoreValue = state.score;
    if (scoreValue === undefined || scoreValue === null || scoreValue === '') return;
    const numeric = Number(scoreValue);
    perTask[taskId] = {
      score: isNaN(numeric) ? scoreValue : numeric,
      comment: state.comment || ''
    };
  });
  classBucket[userNumber] = perTask;
  resultsData[userClass] = classBucket;
  applyResultsToList();
  updateStatusBadges();
}
function getCachedSubmitted(taskId) { const c = loadFromCache(taskId); return !!(c && c.submitted); }
function getCachedHasCode(taskId) { const c = loadFromCache(taskId); return !!(c && !isBlankCode(c.code || "")); }
function hasAnySubmittedRecord(taskId) {
  if (!taskId) return false;
  if (Object.prototype.hasOwnProperty.call(taskSubmitted, taskId)) {
    return !!taskSubmitted[taskId];
  }
  const cached = loadFromCache(taskId);
  if (cached && cached.submitted === true) return true;
  const snapState = getSnapshotState(taskId);
  if (snapState && snapState.submitted === true) {
    if (snapState.savedAt) return true;
  }
  return false;
}
function hasAnySavedRecord(taskId) {
  if (!taskId) return false;
  return !!(getCachedHasCode(taskId) || snapshotStateHasCode(taskId));
}
function isDirtyRecord(taskId) {
  if (!taskId) return false;
  if (typeof isTaskDirty === "function") return !!isTaskDirty(taskId);
  const cached = loadFromCache(taskId);
  return !!(cached && cached.dirty);
}
function getResultForTask(taskId) {
  if (!taskId) return null;
  const classData = resultsData[userClass] || {};
  const studentData = classData[userNumber] || {};
  return studentData[taskId] || null;
}
function isPerfectScore(taskId) {
  if (!taskId) return false;
  const result = getResultForTask(taskId);
  if (!result) return false;
  const numeric = Number(result.score);
  return !hasAnySubmittedRecord(taskId) && !isDirtyRecord(taskId) && !Number.isNaN(numeric) && numeric === 100;
}
function computeStatusKey(taskId) {
  if (hasAnySubmittedRecord(taskId)) return "submitted";
  if (isDirtyRecord(taskId)) return "editing";
  const result = getResultForTask(taskId);
  if (result && result.score !== undefined && result.score !== '') return "graded";
  if (hasAnySavedRecord(taskId)) return "saved";
  return "empty";
}
function applyResultsToList() {
  document.querySelectorAll("#taskList li").forEach(li => {
    const icon = li.querySelector(".task-icon"); if (!icon) return;
    const taskId = li.dataset.taskId;
    const status = computeStatusKey(taskId);
    const perfect = isPerfectScore(taskId);
    const color = statusColors[status] || statusColors.empty;
    if (perfect) {
      icon.textContent = "★";
      icon.classList.add("sparkle-star");
      icon.classList.remove("dot-icon");
      icon.style.background = "transparent";
      icon.style.color = "";
    } else {
      icon.textContent = "●";
      icon.classList.remove("sparkle-star");
      icon.classList.add("dot-icon");
      icon.style.background = "transparent";
      icon.style.color = color;
    }
  });
  if (typeof updateCommentBubble === "function" && typeof currentTaskId !== "undefined") {
    updateCommentBubble(currentTaskId || null);
  }
}
function updateStatusBadges() {
  document.querySelectorAll("#taskList li").forEach(li => {
    const badge = li.querySelector(".status-badge"); if (!badge) return;
    const taskId = li.dataset.taskId;
    const result = getResultForTask(taskId);
    let label = "";
    if (hasAnySubmittedRecord(taskId)) {
      label = "[提出済]";
    } else if (isDirtyRecord(taskId)) {
      label = "[編集中]";
    } else if (result && result.score !== undefined && result.score !== "") {
      const numeric = Number(result.score);
      const scoreText = isNaN(numeric) ? result.score : `${numeric}`;
      label = `[${scoreText}点]`;
    }
    else if (hasAnySavedRecord(taskId)) label = "[保存済]";
    badge.textContent = label;
  });
}
