// task_selection.js: 課題選択・保存・提出まわり



const HINT_NOTE_HTML = '<div style="margin-top:8px;color:#666;font-size:12px;">※コーディングアシストを使えます。</div>';

const LOADING_TEXT = '読み込み中...';
let commentBubbleCollapsed = false;
let lastCommentTaskId = null;
let commentBubbleInitDone = false;
let commentBubbleExpandTimer = null;
let commentBubblePending = null;
const COMMENT_EXPAND_MS = 500;

function isExcludedTask(taskId) {
  return typeof isTaskExcluded === "function" ? isTaskExcluded(taskId) : false;
}

function findTaskMeta(taskId) {

  if (!taskId) return null;

  return tasksData.find(t => t.id === taskId) || null;

}

function formatStatusMessage(base, taskId) {

  if (!taskId || taskId === currentTaskId) return base;

  const meta = findTaskMeta(taskId);

  const label = meta ? (meta.title || meta.id) : taskId;

  return `${base}（${label}）`;

}



function showNoSelectionState() {

  currentTaskId = null;

  previousTaskId = null;

  hintOpened = false;



  const problemTitleEl = document.getElementById('problemTitle');

  const problemTextEl = document.getElementById('problemText');

  const hintEl = document.getElementById('hint');

  problemTitleEl.textContent = '課題';

  problemTextEl.textContent = '左側で課題を選択してください。';

  if (hintEl) { hintEl.hidden = true; hintEl.innerHTML = ''; }



  if (editor) {

    editor.setOption('readOnly', false);

    editor.getDoc().setValue('');

  }

  const outArea = document.getElementById('outputArea');

  if (outArea) outArea.textContent = '';



  const assistToggle = document.getElementById('assistToggle');

  const assistLabel = document.getElementById('assistLabel');

  if (assistToggle) { assistToggle.checked = false; assistToggle.disabled = true; }

  if (assistLabel) assistLabel.classList.add('disabled');

  updateGhostVisibility();



  ['playButton', 'stopIconButton', 'saveButton', 'submitButton'].forEach(id => {

    const btn = document.getElementById(id);

    if (btn) btn.disabled = true;

  });

  updateCommentBubble(null);

}


function ensureHintShown() {
  const hintEl = document.getElementById('hint');
  const assistToggle = document.getElementById('assistToggle');
  const assistLabel = document.getElementById('assistLabel');
  if (hintEl) hintEl.hidden = false;
  if (assistToggle) assistToggle.disabled = false;
  if (assistLabel) assistLabel.classList.remove('disabled');
  updateGhostVisibility();
}


async function selectTask(nextTaskId) {

  if (running || pyWorker) { hardKillWorker('selectTask'); }



  if (previousTaskId && previousTaskId !== nextTaskId) {

    if (!taskSubmitted[previousTaskId] && !getCachedSubmitted(previousTaskId)) {

      const prevCode = editor ? editor.getValue() : '';

      const normalizedOutput = String(outputBuffer || '').replace(/\r\n/g, '\n');

      const cachedState = {

        code: prevCode,

        output: normalizedOutput,

        hintOpened,

        submitted: false

      };

      let shouldMarkDirty = true;

      const wasDirty = typeof isTaskDirty === 'function' ? isTaskDirty(previousTaskId) : false;

      if (!wasDirty) {

        const synced = typeof getTaskSyncedState === 'function' ? getTaskSyncedState(previousTaskId) : null;

        if (synced) {

          const syncedOutput = String(synced.output || '').replace(/\r\n/g, '\n');

          const sameCode = (synced.code || '') === cachedState.code;

          const sameOutput = syncedOutput === cachedState.output;

          const sameHint = !!synced.hintOpened === !!cachedState.hintOpened;

          const sameSubmit = !!synced.submitted === !!cachedState.submitted;

          shouldMarkDirty = !(sameCode && sameOutput && sameHint && sameSubmit);

        } else {

          shouldMarkDirty = false;

        }

      }

      saveToCache(previousTaskId, {

        ...cachedState,

        dirty: shouldMarkDirty || wasDirty

      });

      if (shouldMarkDirty || wasDirty) markTaskDirty(previousTaskId);

      else setTaskDirty(previousTaskId, false);

    }

  }



  if (currentTaskId) saveLocalState(currentTaskId);



  previousTaskId = nextTaskId;

  currentTaskId = nextTaskId;

  saveSelectedTaskId(nextTaskId);



  document.querySelectorAll('#taskList li').forEach(li => {

    const isTask = !!li.querySelector('.task-icon');

    li.classList.toggle('active', isTask && li.dataset.taskId === nextTaskId);

  });



  const task = tasksData.find(t => t.id === nextTaskId);

  const excludedTask = isExcludedTask(nextTaskId);

  if (!task) return;



  document.getElementById('problemTitle').textContent = task.title;

  const toHtml = (s) => String(s || '').replace(/\r\n|\n/g, '<br>');

  const problemTextEl = document.getElementById('problemText');

  const hintEl = document.getElementById('hint');

  problemTextEl.innerHTML = toHtml(task.description);

  hintEl.innerHTML = (task.hint ? toHtml(task.hint) + HINT_NOTE_HTML : HINT_NOTE_HTML);

  hintEl.hidden = true;



  const assistToggle = document.getElementById('assistToggle');

  const assistLabel = document.getElementById('assistLabel');

  assistToggle.checked = false;

  assistToggle.disabled = true;

  assistLabel.classList.add('disabled');

  updateGhostVisibility();



  clearOutput();

  if (editor) {

    editor.getDoc().setValue(LOADING_TEXT);

    editor.setOption('readOnly', 'nocursor');

  }

  const outArea = document.getElementById('outputArea');

  outArea.textContent = LOADING_TEXT;

  document.getElementById('ghostText').textContent = task.answer || '';



  const requestId = nextTaskId;

  const cached = loadFromCache(nextTaskId);
  console.log('[selectTask] loaded cache', {
    taskId: nextTaskId,
    hasCache: !!cached,
    cacheKeys: cached ? Object.keys(cached) : [],
    cachePreview: cached ? { codeLen: (cached.code || '').length, dirty: cached.dirty, submitted: cached.submitted } : null
  });

  if (cached) {

    if (editor) editor.getDoc().setValue(cached.code || '');

    outputBuffer = String(cached.output || '').replace(/\r\n/g, '\n');

    outArea.textContent = outputBuffer;

    hintOpened = !!cached.hintOpened;

    taskSubmitted[nextTaskId] = !!cached.submitted;

    const cachedDirty = typeof cached.dirty === 'boolean' ? cached.dirty : false;

    if (taskSubmitted[nextTaskId]) {

      setTaskDirty(nextTaskId, false);

    } else {

      setTaskDirty(nextTaskId, cachedDirty);

    }

    setSubmitButtonState(!!taskSubmitted[nextTaskId]);

    if (taskSubmitted[nextTaskId]) lockEditor(); else unlockEditor();

    if (hintOpened) ensureHintShown();

  }



  const localState = getLocalState(nextTaskId);
  console.log('[selectTask] snapshot state', {
    taskId: nextTaskId,
    hasLocalState: !!localState,
    snapshotKeys: localState ? Object.keys(localState) : [],
    snapshotPreview: localState ? { codeLen: (localState.code || '').length, submitted: localState.submitted, savedAt: localState.savedAt } : null
  });

  if (localState) {

    if (editor) editor.getDoc().setValue(localState.code || '');

    outArea.textContent = localState.output || '';

    outputBuffer = String(localState.output || '').replace(/\r\n/g, '\n');

    hintOpened = !!localState.hintOpened;

    taskSubmitted[nextTaskId] = !!localState.submitted;

    setSubmitButtonState(!!taskSubmitted[nextTaskId]);

  }
  if (localState && hintOpened) ensureHintShown();

  const hasCacheRecord = !!cached;
  const hasSnapshotRecord = !!localState;
  const cacheHasCode = hasCacheRecord && !isBlankCode((cached?.code) || '');
  const snapshotHasCode = hasSnapshotRecord && !isBlankCode((localState?.code) || '');
  const hasAnyLocalState = hasCacheRecord || hasSnapshotRecord;
  const initialLocalState = !!(localState && !localState.savedAt);
  const missingPersistedCode = !cacheHasCode && !snapshotHasCode;
  const treatAsNewState = !hasAnyLocalState || initialLocalState || missingPersistedCode;
  const snapshotState = (typeof getSnapshotState === "function") ? getSnapshotState(nextTaskId) : null;
  const snapshotHasHistory = !!(snapshotState && (
    snapshotState.savedAt ||
    snapshotState.submitted ||
    (snapshotState.score !== undefined && snapshotState.score !== '') ||
    (snapshotState.code && !isBlankCode(snapshotState.code || ""))
  ));
  const hasGradedResult = (typeof getResultForTask === "function") ? !!getResultForTask(nextTaskId) : false;
  const shouldForceEditing = initialLocalState || (!snapshotHasHistory && !hasGradedResult);

  if (treatAsNewState) {
    if (shouldForceEditing) {
      taskSubmitted[nextTaskId] = false;
      setTaskDirty(nextTaskId, true);
      setSubmitButtonState(false);
      unlockEditor();
    } else {
      setTaskDirty(nextTaskId, false);
      if (snapshotState && typeof snapshotState.submitted !== "undefined") {
        taskSubmitted[nextTaskId] = !!snapshotState.submitted;
        setSubmitButtonState(!!taskSubmitted[nextTaskId]);
      }
    }
  } else if (!taskSubmitted[nextTaskId]) {
    unlockEditor();
  }

  let saved = null;

  if (missingPersistedCode) {
    console.log('[selectTask] no stored code, applying initial code immediately', {
      taskId: nextTaskId,
      initialLen: (task.initialCode || '').length,
      cacheHasCode,
      snapshotHasCode
    });
    applyInitialCodeIfBlank(task);
  }

  if (treatAsNewState) saved = await loadTaskFromServer(nextTaskId);



  if (currentTaskId !== requestId) {

    if (editor && editor.getOption('readOnly') === 'nocursor' && editor.getValue() === LOADING_TEXT) {

      editor.setOption('readOnly', false);

      editor.getDoc().setValue('');

    }

    if (outArea.textContent.trim() === LOADING_TEXT) outArea.textContent = '';

    return;

  }

  if (editor) editor.setOption('readOnly', false);



  if (saved) {
    const shouldSeedInitial = treatAsNewState
      && (!saved.code || isBlankCode(saved.code))
      && !saved.savedAt
      && !saved.submitted;
    if (shouldSeedInitial) {
      applyInitialCodeIfBlank(task);
    } else {
      if (editor) editor.getDoc().setValue(saved.code || '');
      outputBuffer = String(saved.output || '').replace(/\r\n/g, '\n');
      outArea.textContent = outputBuffer;
      hintOpened = !!saved.hintOpened;
      taskSubmitted[nextTaskId] = !!saved.submitted;
      setSubmitButtonState(!!taskSubmitted[nextTaskId]);
      if (taskSubmitted[nextTaskId]) lockEditor(); else unlockEditor();
      saveToCache(nextTaskId, {
        code: editor ? editor.getValue() : (saved.code || ''),
        output: outputBuffer,
        hintOpened,
        submitted: taskSubmitted[nextTaskId],
        dirty: isTaskDirty(nextTaskId)
      });
      markTaskSynced(nextTaskId, {
        code: editor ? editor.getValue() : (saved.code || ''),
        output: outputBuffer,
        hintOpened,
        submitted: !!taskSubmitted[nextTaskId]
      });
      setTaskDirty(nextTaskId, false);
      if (hintOpened) ensureHintShown();
    }
  } else if (!cached && !localState) {

    applyInitialCodeIfBlank(task);

  } else if (!taskSubmitted[nextTaskId]) {

    const currentCode = editor ? editor.getValue() : '';

    if (isBlankCode(currentCode) || currentCode.trim() === LOADING_TEXT) applyInitialCodeIfBlank(task);

  }



  document.getElementById('hintButton').onclick = () => {

    hintEl.hidden = false;

    if (assistToggle.disabled) {

      assistToggle.disabled = false;

      assistLabel.classList.remove('disabled');

      updateGhostVisibility();

    }

    if (!hintOpened) {

      hintOpened = true;

      if (!taskSubmitted[nextTaskId]) {

        const codeNow = editor ? editor.getValue() : '';

        const outNow = outputBuffer;

        saveToCache(nextTaskId, { code: codeNow, output: outNow, hintOpened: true, submitted: taskSubmitted[nextTaskId], dirty: isTaskDirty(nextTaskId) });

        saveSpecificTask(nextTaskId, { code: codeNow, output: outNow, hintOpened: true, submitted: taskSubmitted[nextTaskId] }, true)

          .catch(err => console.warn('[main] hint save error', err));

      }

    }

    if (currentTaskId) saveLocalState(currentTaskId);

  };



  refreshEditorLockState(nextTaskId);
  if (excludedTask) {
    taskSubmitted[nextTaskId] = false;
    setSubmitButtonState(false);
    unlockEditor();
  }
  updateStatusIcon(computeStatusKey(nextTaskId));

  applyResultsToList();

  updateStatusBadges();
  updateCommentBubble(nextTaskId);

}



async function saveSpecificTask(taskId, data, silent = true) {

  if (!sheetIO || !commPayload) {

    if (!silent) showStatusMessage('通信モジュールが初期化されていません', 'error');

    return;

  }
  const excluded = isExcludedTask(taskId);
  if (excluded && data && data.submitted) {
    if (!silent) showStatusMessage('採点対象外の課題は提出できません', 'error');
    return;
  }

  const payload = commPayload.createTaskSavePayload(

    { sessionId, userId, userClass, userNumber },

    { taskId, code: data.code, output: data.output, hintOpened: data.hintOpened, submitted: data.submitted }

  );

  try {

    const res = await sheetIO.postTaskSave(payload, APP_CONFIG.saveScript || '/save');

    if (!silent) showStatusMessage(res.ok ? '保存しました' : '保存に失敗しました', res.ok ? 'success' : 'error');

  } catch {

    if (!silent) showStatusMessage('保存に失敗しました', 'error');

  }

}



function applyInitialCodeIfBlank(task) {
  const initial = task.initialCode || '';
  const cur = editor ? editor.getValue() : '';
  if (!isBlankCode(cur) && cur.trim() !== LOADING_TEXT) {
    console.log('[applyInitialCodeIfBlank] skipped (editor already has content)', {
      taskId: task?.id || task?.TaskId,
      currentLen: cur.length
    });
    return;
  }
  console.log('[applyInitialCodeIfBlank] applying initial code', {
    taskId: task?.id || task?.TaskId,
    initialLen: initial.length
  });
  if (editor) editor.getDoc().setValue(initial);
  outputBuffer = '';
  document.getElementById('outputArea').textContent = '';
  hintOpened = false;
  taskSubmitted[currentTaskId] = false;
  setSubmitButtonState(false);
  unlockEditor();
  setTaskDirty(currentTaskId, true);
  saveToCache(currentTaskId, { code: initial, output: '', hintOpened: false, submitted: false, dirty: true });
}




function saveToServer(silent = false, submittedFlag = false, targetTaskId = currentTaskId, snapshot = null) {

  if (!targetTaskId) {

    if (!silent) showStatusMessage('提出対象が選択されていません', 'error');

    return;

  }

  if (taskSubmitted[targetTaskId] && !submittedFlag) {

    if (!silent) showStatusMessage(formatStatusMessage('提出済みのため保存はスキップしました', targetTaskId), 'success');

    return;

  }

  const excludedTask = isExcludedTask(targetTaskId);
  if (submittedFlag && excludedTask) {
    if (!silent) showStatusMessage('採点対象外の課題は提出できません', 'error');
    return;
  }

  if (!sheetIO || !commPayload) {

    if (!silent) showStatusMessage('通信モジュールが初期化されていません', 'error');

    return;

  }

  const isCurrent = targetTaskId === currentTaskId;

  const cached = !isCurrent ? (loadFromCache(targetTaskId) || {}) : {};

  const code = snapshot?.code ?? (isCurrent && editor ? editor.getValue() : (cached.code || ''));

  const rawOutput = snapshot?.output ?? (isCurrent ? outputBuffer : (cached.output || ''));

  const output = String(rawOutput || '').replace(/\r\n/g, '\n');

  const hintState = snapshot?.hintOpened ?? (isCurrent ? !!hintOpened : !!cached.hintOpened);

  const payload = commPayload.createTaskSavePayload(

    { sessionId, userId, userClass, userNumber },

    { taskId: targetTaskId, code, output, hintOpened: hintState, submitted: submittedFlag || taskSubmitted[targetTaskId] === true }

  );

  const useGasEndpoint = commPayload.isGasServer(APP_CONFIG.serverBaseUrl || '');

  const successMessage = formatStatusMessage(submittedFlag ? '提出しました' : '保存しました', targetTaskId);

  const failureMessage = formatStatusMessage(submittedFlag ? '提出に失敗しました' : '保存に失敗しました', targetTaskId);



  const handleSuccess = () => {

    if (submittedFlag) taskSubmitted[targetTaskId] = true;

    setTaskDirty(targetTaskId, false);

    persistSelectionCache(targetTaskId, {

      code,

      output,

      hintOpened: hintState,

      submitted: !!taskSubmitted[targetTaskId]

    });

    if (!silent) showStatusMessage(successMessage, 'success');

  };

  const handleFailure = () => {

    if (!silent) showStatusMessage(failureMessage, 'error');

  };



  sheetIO.postTaskSave(payload, APP_CONFIG.saveScript || '/save')

    .then(async (res) => {

      if (useGasEndpoint) {

        handleSuccess();

        return;

      }

      try {

        const data = await res.json();

        const ok = res.ok && data && data.status === 'ok';

        if (ok) handleSuccess();

        else handleFailure();

      } catch (err) {

        if (res.ok) handleSuccess();

        else handleFailure();

      }

    })

    .catch(handleFailure);

}



function persistSelectionCache(taskId, state) {

  if (!taskId || !state) return;

  const payload = {

    code: state.code || '',

    output: state.output || '',

    hintOpened: !!state.hintOpened,

    submitted: !!state.submitted,

    dirty: false

  };

  saveToCache(taskId, payload);

  if (taskId === currentTaskId) {

    updateStatusIcon(computeStatusKey(taskId));

  }

  applyResultsToList();

  updateStatusBadges();

  saveLocalState(taskId, {

    code: payload.code,

    output: payload.output,

    hintOpened: payload.hintOpened,

    submitted: payload.submitted

  });

  markTaskSynced(taskId, payload);

}



function submitToServer() {

  if (!currentTaskId) return;
  if (isExcludedTask(currentTaskId)) {
    showStatusMessage('採点対象外の課題は提出できません', 'error');
    return;
  }

  const targetTaskId = currentTaskId;

  const snapshot = {

    code: editor ? editor.getValue() : '',

    output: outputBuffer,

    hintOpened: !!hintOpened

  };

  saveToServer(false, true, targetTaskId, snapshot);

  taskSubmitted[targetTaskId] = true;

  if (currentTaskId === targetTaskId) {

    lockEditor();

    setSubmitButtonState(true);

    updateStatusIcon('submitted');

    applyResultsToList();

    updateStatusBadges();

    saveLocalState(targetTaskId, {

      code: snapshot.code,

      output: String(snapshot.output || ''),

      hintOpened: snapshot.hintOpened,

      submitted: true

    });

  }

}





function cancelSubmission() {

  if (!currentTaskId) return;

  const targetTaskId = currentTaskId;

  const snapshot = {

    code: editor ? editor.getValue() : '',

    output: outputBuffer,

    hintOpened: !!hintOpened,

    submitted: false

  };

  taskSubmitted[targetTaskId] = false;

  markTaskDirty(targetTaskId);

  saveToServer(false, false, targetTaskId, snapshot);

  saveToCache(targetTaskId, { code: snapshot.code, output: snapshot.output, hintOpened: snapshot.hintOpened, submitted: false, dirty: true });

  if (currentTaskId === targetTaskId) {

    unlockEditor();

    setSubmitButtonState(false);

    updateStatusIcon('editing');

    applyResultsToList();

    updateStatusBadges();

    saveLocalState(targetTaskId, snapshot);

  }

}





function updateStatusIcon(status) {

  if (!currentTaskId) return;

  const key = (status in statusColors) ? status : computeStatusKey(currentTaskId);

  const icon = document.querySelector(`#taskList li[data-task-id='${currentTaskId}'] .task-icon`);

  if (!icon) return;
  const color = statusColors[key] || statusColors.empty;
  const perfect = (typeof isPerfectScore === "function") ? isPerfectScore(currentTaskId) : false;
  if (perfect) {
    icon.textContent = "★";
    icon.classList.add("sparkle-star");
    icon.classList.remove("dot-icon");
    icon.style.background = "transparent";
    icon.style.color = "";
    return;
  }
  icon.classList.remove("sparkle-star");
  icon.classList.add("dot-icon");
  icon.textContent = "●";
  icon.style.background = "transparent";
  icon.style.color = color;

}



function lockEditor() {

  if (editor) editor.setOption('readOnly', true);

  document.getElementById('editorWrapper').classList.add('locked');

  document.getElementById('playButton').disabled = true;

  document.getElementById('stopIconButton').disabled = true;

  document.getElementById('saveButton').disabled = true;

}



function unlockEditor() {

  if (editor) editor.setOption('readOnly', false);

  document.getElementById('editorWrapper').classList.remove('locked');

  document.getElementById('playButton').disabled = false;

  document.getElementById('stopIconButton').disabled = false;

  enableSaveSubmitButtons();

}

function refreshEditorLockState(taskId = null) {
  const targetId = taskId || currentTaskId;
  if (!targetId) return;
  if (isExcludedTask(targetId)) {
    unlockEditor();
    return;
  }
  if (taskSubmitted[targetId]) {
    lockEditor();
  } else {
    unlockEditor();
  }
}



function setSubmitButtonState(isSubmitted) {

  const submitBtn = document.getElementById('submitButton');

  if (submitBtn) {
    const excluded = isExcludedTask(currentTaskId);
    submitBtn.textContent = isSubmitted ? '提出取消' : '提出';
    if (excluded) submitBtn.disabled = true;
  }

}

function sanitizeCommentHtml(raw) {
  if (!raw) return "";
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
  const allowed = new Set(['B','I','U','FONT','STRONG','EM','BR','SMALL','SPAN']);
  const escapeHtml = (text) => text.replace(/[&<>]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    return '&gt;';
  });
  const normalizeNewlines = (text) => escapeHtml(text).replace(/\r?\n/g, '<br>');
  const serialize = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return normalizeNewlines(node.textContent || '');
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toUpperCase();
      if (tag === 'BR') return '<br>';
      const children = Array.from(node.childNodes).map(serialize).join('');
      if (!allowed.has(tag)) return children;
      let attrs = '';
      if (tag === 'FONT') {
        const color = node.getAttribute('color') || '';
        if (/^#[0-9A-Fa-f]{3,6}$/.test(color) || /^[a-zA-Z]+$/.test(color)) {
          attrs += ` color="${color}"`;
        }
      }
      return `<${tag.toLowerCase()}${attrs}>${children}</${tag.toLowerCase()}>`;
    }
    return '';
  };
  const root = doc.body.firstElementChild || doc.body;
  return Array.from(root.childNodes || []).map(serialize).join('');
}

function updateCommentBubble(taskId = null) {

  const bubble = document.getElementById('commentBubble');
  const body = bubble ? bubble.querySelector('.bubble-body') : null;
  const message = body ? body.querySelector('.bubble-message') : null;

  if (!bubble || !body || !message) return;
  if (taskId && isExcludedTask(taskId)) {
    bubble.style.display = 'none';
    message.innerHTML = '';
    bubble.classList.remove('is-compact', 'is-mini', 'is-collapsed', 'is-expanding');
    commentBubbleCollapsed = false;
    lastCommentTaskId = null;
    return;
  }

  if (!taskId) {

    bubble.style.display = 'none';

    message.innerHTML = '';

    bubble.classList.remove('is-compact', 'is-mini', 'is-collapsed', 'is-expanding');

    commentBubbleCollapsed = false;
    lastCommentTaskId = null;

    return;

  }

  const result = (typeof getResultForTask === "function") ? getResultForTask(taskId) : null;

  let text = "";

  if (result && result.comment && String(result.comment).trim()) {

    text = String(result.comment).trim();

  } else if (result && !Number.isNaN(Number(result.score)) && Number(result.score) === 100) {

    text = "満点クリア、お見事！おめでとう♪";

  }

  if (!text) {

    bubble.style.display = 'none';

    message.innerHTML = '';

    bubble.classList.remove('is-compact', 'is-mini', 'is-collapsed', 'is-expanding');

    commentBubbleCollapsed = false;
    lastCommentTaskId = null;

    return;

  }

  const html = sanitizeCommentHtml(text);
  const plainLength = text.replace(/<[^>]+>/g, '');

  bubble.style.display = 'block';

  const setContent = () => {
    message.innerHTML = html;
    bubble.classList.remove('is-compact', 'is-mini');
    if (plainLength.length > 120) bubble.classList.add('is-mini');
    else if (plainLength.length > 60) bubble.classList.add('is-compact');
  };

  if (lastCommentTaskId !== taskId) {
    lastCommentTaskId = taskId;
    commentBubbleCollapsed = false;
    bubble.classList.add('is-expanding');
    commentBubblePending = { html, plainLength };
    message.innerHTML = '';
    if (commentBubbleExpandTimer) clearTimeout(commentBubbleExpandTimer);
    commentBubbleExpandTimer = setTimeout(() => {
      bubble.classList.remove('is-expanding');
      if (commentBubblePending) {
        setContent();
        commentBubblePending = null;
      }
    }, COMMENT_EXPAND_MS);
  } else {
    commentBubblePending = null;
    setContent();
  }
  if (commentBubbleCollapsed) {
    bubble.classList.add('is-collapsed');
  } else if (!commentBubblePending) {
    bubble.classList.remove('is-collapsed', 'is-expanding');
  }

}

function collapseCommentBubble() {
  const bubble = document.getElementById('commentBubble');
  if (!bubble || bubble.style.display === 'none') return;
  commentBubbleCollapsed = true;
  bubble.classList.add('is-collapsed');
}

function expandCommentBubble() {
  const bubble = document.getElementById('commentBubble');
  if (!bubble) return;
  commentBubbleCollapsed = false;
  bubble.classList.remove('is-collapsed');
  bubble.classList.add('is-expanding');
  if (commentBubbleExpandTimer) clearTimeout(commentBubbleExpandTimer);
  commentBubbleExpandTimer = setTimeout(() => {
    bubble.classList.remove('is-expanding');
  }, 520);
}

function initCommentBubbleControls() {
  const bubble = document.getElementById('commentBubble');
  if (!bubble || commentBubbleInitDone) return;
  const toggle = bubble.querySelector('.bubble-toggle');
  commentBubbleInitDone = true;
  bubble.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (bubble.classList.contains('is-collapsed')) return;
    if (ev.target && ev.target.closest('.bubble-toggle')) return;
    if (bubble.style.display === 'none') return;
    collapseCommentBubble();
  });
  if (toggle) {
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      expandCommentBubble();
    });
  }
}

initCommentBubbleControls();
window.addEventListener('DOMContentLoaded', initCommentBubbleControls);



async function loadTaskFromServer(taskId) {

  try {

    if (!APP_CONFIG.serverBaseUrl) return null;

    if (!sheetIO || !commPayload) return null;

    const query = commPayload.createTaskDetailPayload({ sessionId, userId, userClass, userNumber }, taskId);

    const res = await sheetIO.requestTaskDetail(query);

    if (!res.ok) {

      if (res.status === 401) { clearSession(); redirectToLogin(); }

      return null;

    }

    const json = await res.json();

    if (json && json.status === 'ok') return json.data || null;

    if (json && json.status === 'error') { clearSession(); redirectToLogin(); }

    return null;

  } catch {

    return null;

  }

}

