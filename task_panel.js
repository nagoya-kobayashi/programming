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

  const pathMap = buildTaskPathMapForClient(normalized);
  tasksData = normalized.map(t => {
    const attr = normalizeAttribute(t.Attribute) || guessAttributeFromPath(t.TaskId, pathMap) || "その他";
    return {
      id: t.TaskId,
      title: t.Title || t.TaskId,
      description: t.DescriptionHtml || '',
      hint: t.HintHtml || '',
      answer: t.AnswerCode || '',
      initialCode: t.InitialCode || '',
      parentId: t.ParentId || '',
      isFolder: !!t.IsFolder,
      attribute: attr
    };
  });
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
      attribute: headerRow.indexOf("attribute"),
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
        Attribute: getCell(r, idx.attribute),
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
    IsFolder: toBool(pick(t, ["IsFolder","isFolder","isfolder"])),
    Attribute: pick(t, ["Attribute","attribute"])
  };
}
function normalizeAttribute(raw) {
  const s = String(raw || "").replace(/\s+/g, "").trim();
  const allowed = ["基礎", "演習", "発展", "その他"];
  if (!s) return "";
  return allowed.includes(s) ? s : "";
}
function guessAttributeFromPath(taskId, pathMap) {
  const path = pathMap && pathMap[String(taskId)] ? String(pathMap[String(taskId)]) : "";
  if (!path) return "その他";
  const parts = path.split(" / ").filter(Boolean);
  const second = parts.length >= 2 ? parts[1] : (parts[0] || "");
  const lower = second.toLowerCase();
  if (lower.includes("基礎") || /^\(?\s*1/.test(lower)) return "基礎";
  if (lower.includes("演習") || /^\(?\s*2/.test(lower)) return "演習";
  if (lower.includes("発展") || /^\(?\s*3/.test(lower)) return "発展";
  if (lower.includes("その他")) return "その他";
  return "その他";
}
function buildTaskPathMapForClient(tasks) {
  const map = new Map();
  tasks.forEach(t => map.set(String(t.TaskId), { id: String(t.TaskId), parentId: String(t.ParentId || ""), title: t.Title || String(t.TaskId), isFolder: !!t.IsFolder }));
  const cache = {};
  const visiting = new Set();
  const resolve = (id) => {
    const key = String(id || "");
    if (!key) return "";
    if (cache[key]) return cache[key];
    if (visiting.has(key)) return key;
    visiting.add(key);
    const t = map.get(key);
    if (!t) { visiting.delete(key); return key; }
    const self = t.title || key;
    const parentId = t.parentId && map.has(String(t.parentId)) ? String(t.parentId) : '';
    const parentPath = parentId ? resolve(parentId) : '';
    const path = parentPath ? `${parentPath} / ${self}` : self;
    cache[key] = path;
    visiting.delete(key);
    return path;
  };
  tasks.forEach(t => { if (!t.IsFolder) resolve(t.TaskId); });
  return cache;
}

const STAR_ATTRIBUTE_CLASSES = ["star-basic", "star-exercise", "star-advanced", "star-default"];
function starClassForAttribute(attr) {
  switch (attr) {
    case "基礎": return "star-basic";
    case "演習": return "star-exercise";
    case "発展": return "star-advanced";
    default: return "star-default";
  }
}
function applyStarColorClass(el, attr) {
  if (!el) return;
  STAR_ATTRIBUTE_CLASSES.forEach(cls => el.classList.remove(cls));
  const cls = starClassForAttribute(attr);
  if (cls) el.classList.add(cls);
}
function setStarIcon(el, attr) {
  if (!el) return;
  el.textContent = "★";
  el.classList.add("sparkle-star");
  el.classList.remove("dot-icon");
  applyStarColorClass(el, attr);
  el.style.background = "transparent";
  el.style.color = "";
}
function setDotIcon(el, color) {
  if (!el) return;
  el.textContent = "●";
  el.classList.remove("sparkle-star");
  el.classList.add("dot-icon");
  STAR_ATTRIBUTE_CLASSES.forEach(cls => el.classList.remove(cls));
  el.style.background = "transparent";
  el.style.color = color;
}

function renderTaskTree() {
  const ul = document.getElementById("tasks");
  while (ul.firstChild) ul.removeChild(ul.firstChild);

  const byParent = new Map();
  const buildChild = (key, item) => {
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(item);
  };
  tasksData.forEach(t => {
    const key = t.parentId || "";
    buildChild(key, t);
  });

  const sortChildren = (arr) => {
    arr.sort((a, b) => {
      const af = a.isFolder ? 0 : 1;
      const bf = b.isFolder ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.title || "").localeCompare(b.title || "");
    });
  };

  const folderCounts = computeFolderCompletionMap(byParent);

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
        const folderIcon = document.createElement("span");
        folderIcon.className = "folder-icon-slot icon-ph";
        li.appendChild(folderIcon);
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

      if (item.isFolder) {
        const counts = folderCounts.get(item.id) || { cleared: 0, total: 0 };
        const countWrap = document.createElement("span");
        countWrap.className = "folder-count";
        const cleared = document.createElement("span");
        let clearedClass = "";
        if (counts.total > 0) {
          clearedClass = counts.cleared === counts.total ? " all-cleared" : " has-remaining";
        }
        cleared.className = "folder-count-cleared" + clearedClass;
        cleared.textContent = counts.cleared;
        const slash = document.createElement("span");
        slash.textContent = " / ";
        const total = document.createElement("span");
        total.className = "folder-count-total";
        total.textContent = counts.total;
        countWrap.appendChild(cleared);
        countWrap.appendChild(slash);
        countWrap.appendChild(total);
        li.appendChild(countWrap);
      }

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
  updateFolderCompletionIndicators();
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
  if (typeof isTaskExcluded === "function" && isTaskExcluded(taskId)) return false;
  const result = getResultForTask(taskId);
  if (!result) return false;
  const numeric = Number(result.score);
  return !hasAnySubmittedRecord(taskId) && !isDirtyRecord(taskId) && !Number.isNaN(numeric) && numeric === 100;
}
function isTaskCleared(taskId) {
  if (!taskId) return false;
  if (typeof isTaskExcluded === "function" && isTaskExcluded(taskId)) return false;
  const result = getResultForTask(taskId);
  if (!result) return false;
  const numeric = Number(result.score);
  return !Number.isNaN(numeric) && numeric === 100;
}
function computeStatusKey(taskId) {
  if (typeof isTaskExcluded === "function" && isTaskExcluded(taskId)) return "excluded";
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
    const meta = tasksData.find(t => t.id === taskId);
    if (meta && meta.isFolder) return;
    const status = computeStatusKey(taskId);
    const perfect = isPerfectScore(taskId);
    const attr = meta ? meta.attribute : getTaskAttribute(taskId);
    const color = statusColors[status] || statusColors.empty;
    if (perfect) {
      setStarIcon(icon, attr);
    } else {
      setDotIcon(icon, color);
    }
  });
  if (typeof updateCommentBubble === "function" && typeof currentTaskId !== "undefined") {
    updateCommentBubble(currentTaskId || null);
  }
  updateFolderCompletionIndicators();
}
function updateStatusBadges() {
  document.querySelectorAll("#taskList li").forEach(li => {
    const badge = li.querySelector(".status-badge"); if (!badge) return;
    const taskId = li.dataset.taskId;
    if (typeof isTaskExcluded === "function" && isTaskExcluded(taskId)) {
      badge.textContent = "[採点対象外]";
      return;
    }
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
function computeFolderCompletionMap(byParent) {
  const memo = new Map();
  const dfs = (pid) => {
    const key = pid || "";
    if (memo.has(key)) return memo.get(key);
    const children = byParent.get(key) || [];
    let cleared = 0;
    let total = 0;
    children.forEach(child => {
      if (child.isFolder) {
        const res = dfs(child.id);
        cleared += res.cleared;
        total += res.total;
      } else {
        if (typeof isTaskExcluded === "function" && isTaskExcluded(child.id)) return;
        total += 1;
        if (isTaskCleared(child.id)) cleared += 1;
      }
    });
    const res = { cleared, total };
    memo.set(key, res);
    return res;
  };
  tasksData.filter(t => t.isFolder).forEach(f => dfs(f.id));
  dfs("");
  return memo;
}
function updateFolderCompletionIndicators() {
  const byParent = new Map();
  tasksData.forEach(t => {
    const key = t.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  });
  const countsMap = computeFolderCompletionMap(byParent);
  document.querySelectorAll("#taskList li.folder-item").forEach(li => {
    const folderId = li.dataset.taskId || "";
    const counts = countsMap.get(folderId) || { cleared: 0, total: 0 };
    const icon = li.querySelector(".folder-icon-slot");
    if (icon) {
      const allCleared = counts.total > 0 && counts.cleared === counts.total;
      if (allCleared) {
        icon.className = "folder-icon-slot task-icon sparkle-star folder-star";
        setStarIcon(icon, getTaskAttribute(folderId));
      } else {
        icon.className = "folder-icon-slot icon-ph";
        icon.textContent = "";
      }
    }
    const countWrap = li.querySelector(".folder-count");
    if (!countWrap) return;
    const clearedEl = countWrap.querySelector(".folder-count-cleared");
    const totalEl = countWrap.querySelector(".folder-count-total");
    if (clearedEl) {
      clearedEl.textContent = counts.cleared;
      clearedEl.classList.remove("all-cleared", "has-remaining");
      if (counts.total > 0) {
        if (counts.cleared === counts.total) {
          clearedEl.classList.add("all-cleared");
        } else {
          clearedEl.classList.add("has-remaining");
        }
      }
    }
    if (totalEl) totalEl.textContent = counts.total;
  });
}
