// task_editor.js
// - 折り畳み状態を localStorage に保存・復元（次回表示時も維持）
// - 初回（保存が無い場合）は全フォルダ折り畳みで開始
// - フォルダの折り畳み/展開（四角ボタン）、色分け表示
// - フォルダ名・課題名ともに昇順ソート（階層ごと）
// - フォルダ名クリックで「新規作成 + 親フォルダをそのフォルダ」に
// - 「フォルダ作成」モードはタイトル/親以外をグレイアウト＆入力不可、離れたら解除
// - 「コピーを作成」ボタン：選択中の課題（非フォルダ）を同一フォルダに複製（TaskIdは新規採番）
// - 親フォルダセレクトの表示をフルパス化
// - 既存の：非キャッシュ化・requestId・正規化・即時反映・状態表示 も維持

(() => {
  /** @type {CodeMirror.Editor} */
  let answerEditor;
  /** @type {CodeMirror.Editor} */
  let initialEditor;

  /** 現在編集中がフォルダかどうか（UIチェックは廃止、内部で保持） */
  let currentIsFolder = false;

  /** 現在の getTasks 要求ID（最新以外の描画を抑止） */
  let latestRequestId = 0;

  /** 直近に選択中の TaskId（再読込後の再選択に使用） */
  let lastSelectedId = null;

  /** 折り畳み状態: フォルダ TaskId -> boolean（true = 折り畳み中） */
  const collapsed = Object.create(null);

  /** 折り畳み状態の保存キー（serverBaseUrlでスコープ分け） */
  const COLLAPSE_KEY = () => {
    const base = (typeof APP_CONFIG?.serverBaseUrl === "string" && APP_CONFIG.serverBaseUrl) || "default";
    return `taskEditor.collapsed.${base}`;
  };

  /** ローカルに保存された折り畳み状態が読み込まれたか */
  let collapseLoaded = false;

  /** ログ */
  const log = {
    info: (...a) => console.log("[TaskEditor]", ...a),
    warn: (...a) => console.warn("[TaskEditor]", ...a),
    error: (...a) => console.error("[TaskEditor]", ...a),
    debug: (...a) => console.debug("[TaskEditor]", ...a),
  };

  const $ = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    answerEditor = CodeMirror.fromTextArea($("answerEditor"), {
      mode: "python",
      lineNumbers: true,
      indentUnit: 4,
    });
    initialEditor = CodeMirror.fromTextArea($("initialEditor"), {
      mode: "python",
      lineNumbers: true,
      indentUnit: 4,
    });

    $("btnNewTask").addEventListener("click", () => {
      exitFolderOnlyMode(); // 別操作に遷移 → グレイアウト解除
      currentIsFolder = false;
      populateTaskForm({
        TaskId: "",
        Title: "",
        DescriptionHtml: "",
        HintHtml: "",
        AnswerCode: "",
        InitialCode: "",
        ParentId: $("taskParentId").value || "",
        IsFolder: false,
      });
      setActiveTask(null);
      setStatus("");
    });

    $("btnNewFolder").addEventListener("click", () => {
      enterFolderOnlyMode(); // グレイアウトON
      currentIsFolder = true;
      populateTaskForm({
        TaskId: "",
        Title: "",
        DescriptionHtml: "",
        HintHtml: "",
        AnswerCode: "",
        InitialCode: "",
        ParentId: $("taskParentId").value || "",
        IsFolder: true,
      });
      setActiveTask(null);
      setStatus("フォルダを作成します。タイトルと（必要なら）親フォルダを選んで保存してください。");
    });

    $("btnReload").addEventListener("click", () => {
      loadTaskList();
    });

    $("btnCopy").addEventListener("click", () => {
      copySelectedTask();
    });

    $("saveTaskButton").addEventListener("click", () => {
      saveTask();
    });

    // セッションの有無でバッジ表示（ログイン無しでも動作）
    $("anonBadge").hidden = !!getSessionId();

    // 初回ロード
    loadTaskList();
  }

  function setStatus(msg, type = "") {
    const el = $("taskStatusMsg");
    el.className = "";
    if (type) el.classList.add(type);
    el.textContent = msg || "";
  }

  function setActiveTask(taskIdOrNull) {
    const items = document.querySelectorAll("#taskTree li");
    items.forEach((li) => {
      const active = taskIdOrNull && li.dataset.taskId === String(taskIdOrNull);
      li.classList.toggle("active", !!active);
      if (active) lastSelectedId = String(taskIdOrNull);
    });
    if (!taskIdOrNull) lastSelectedId = null;
  }

  function getSessionId() {
    return sessionStorage.getItem("sessionId") || "";
  }

  /** 折り畳み状態の保存・復元 */
  function loadCollapsedState() {
    if (collapseLoaded) return;
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY());
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          for (const [k, v] of Object.entries(obj)) {
            collapsed[k] = !!v;
          }
        }
        log.debug("折り畳み状態を復元", obj);
      } else {
        log.debug("折り畳み状態の保存なし（初回）");
      }
    } catch (e) {
      log.warn("折り畳み状態の復元に失敗", e);
    }
    collapseLoaded = true;
  }
  function saveCollapsedState() {
    try {
      const obj = { ...collapsed };
      localStorage.setItem(COLLAPSE_KEY(), JSON.stringify(obj));
      log.debug("折り畳み状態を保存", obj);
    } catch (e) {
      log.warn("折り畳み状態の保存に失敗", e);
    }
  }

  /** 受け取った tasks を正規化（ヘッダ配列→オブジェクト配列） */
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
  function toBool(v) {
    if (typeof v === "boolean") return v;
    const s = String(v || "").trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "y";
  }
  function normalizeTaskObject(t) {
    const pick = (obj, keys) => { for (const k of keys) { if (obj[k] != null && obj[k] !== "") return obj[k]; } return ""; };
    const TaskId = pick(t, ["TaskId", "taskId", "taskid"]);
    const Title = pick(t, ["Title", "title"]) || TaskId;
    const DescriptionHtml = pick(t, ["DescriptionHtml", "descriptionHtml", "description", "Description"]);
    const HintHtml = pick(t, ["HintHtml", "hintHtml", "hint", "Hint"]);
    const AnswerCode = pick(t, ["AnswerCode", "answerCode", "answer", "Answer"]);
    const InitialCode = pick(t, ["InitialCode", "initialCode"]);
    const ParentId = pick(t, ["ParentId", "parentId", "parentid"]);
    const IsFolder = toBool(pick(t, ["IsFolder", "isFolder", "isfolder"]));
    return { TaskId, Title, DescriptionHtml, HintHtml, AnswerCode, InitialCode, ParentId, IsFolder };
  }

  async function loadTaskList() {
    if (!APP_CONFIG?.serverBaseUrl) {
      setStatus("サーバ設定が未設定です。", "error");
      return;
    }
    const session = getSessionId();
    const requestId = ++latestRequestId;

    const params = new URLSearchParams();
    params.append("action", "getTasks");
    if (session) params.append("session", session);
    params.append("_ts", String(Date.now()));

    setStatus("課題一覧を取得中…");
    log.debug("getTasks → POST", { url: APP_CONFIG.serverBaseUrl, withSession: !!session, requestId });

    try {
      const res = await fetch(APP_CONFIG.serverBaseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        cache: "no-store",
      });
      const text = await safeText(res);
      if (requestId !== latestRequestId) {
        log.debug("古いレスポンスを破棄", { requestId, latestRequestId });
        return;
      }
      if (!res.ok) {
        setStatus("課題一覧の取得に失敗しました。", "error");
        log.error("getTasks HTTPエラー", res.status, text);
        return;
      }

      const json = safeJson(text);
      if (!json || json.status !== "ok") {
        setStatus((json && json.message) || "課題一覧の取得に失敗しました。", "error");
        log.error("getTasks アプリエラー", json);
        return;
      }

      const raw = Array.isArray(json.tasks) ? json.tasks : [];
      const tasks = normalizeTasks(raw);
      window.__TASKS = tasks;

      // --- 折り畳み状態の復元 or 初期化 ---
      loadCollapsedState();
      const anySaved = Object.keys(collapsed).length > 0;
      const currentFolderIds = new Set(tasks.filter(t => t.IsFolder === true).map(t => t.TaskId));

      // 保存が無い場合 → 全フォルダを折り畳みで初期化
      if (!anySaved) {
        currentFolderIds.forEach(id => (collapsed[id] = true));
        saveCollapsedState();
      } else {
        // 保存がある場合 → 既知IDは維持・新規フォルダは折り畳みで追加・存在しなくなったIDは削除
        // 追加
        currentFolderIds.forEach(id => {
          if (!(id in collapsed)) collapsed[id] = true; // 既定は折り畳み
        });
        // 削除
        for (const id of Object.keys(collapsed)) {
          if (!currentFolderIds.has(id)) delete collapsed[id];
        }
        saveCollapsedState();
      }

      // デバッグ
      log.info(`getTasks 取得件数（正規化後）: ${tasks.length}`);
      if (tasks.length) {
        const tail = tasks.slice(-5).map(t => ({TaskId: t.TaskId, Title: t.Title, IsFolder: t.IsFolder, ParentId: t.ParentId}));
        console.table(tail);
      }

      renderTaskTree(tasks);
      populateParentFolderSelect(tasks);

      setStatus(`課題一覧を読み込みました（${tasks.length}件）。`, "success");
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      if (requestId !== latestRequestId) return;
      setStatus("課題一覧の取得でエラーが発生しました。", "error");
      log.error("getTasks 例外", err);
    }
  }

  /** 親フォルダのセレクトをフルパスラベルで生成（値はTaskIdのまま） */
  function populateParentFolderSelect(tasks) {
    const sel = $("taskParentId");
    const keep = sel.value;

    // フォルダのみ抽出
    const folders = tasks.filter(t => t.IsFolder === true);

    // ルックアップ用マップ
    const byId = new Map(folders.map(f => [f.TaskId, f]));

    // フルパスを生成
    const makePath = (node) => {
      const parts = [];
      let cur = node;
      const safeGuard = new Set();
      while (cur && !safeGuard.has(cur.TaskId)) {
        safeGuard.add(cur.TaskId);
        parts.push(cur.Title || cur.TaskId);
        cur = byId.get(cur.ParentId);
      }
      return parts.reverse().join("/");
    };

    const items = folders.map(f => ({ id: f.TaskId, label: makePath(f) }));
    items.sort((a, b) => a.label.localeCompare(b.label));

    sel.innerHTML = '<option value="">（なし／ルート）</option>';
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.id;
      opt.textContent = it.label;
      sel.appendChild(opt);
    }
    if (keep) sel.value = keep;
  }

  /** ツリー描画：フォルダ→子（フォルダ→課題）を名称昇順で並べ、折り畳み対応 */
  function renderTaskTree(tasks) {
    const ul = $("taskTree");
    while (ul.firstChild) ul.removeChild(ul.firstChild);

    // 子リスト構築
    const byParent = new Map();
    const nodes = new Map();
    tasks.forEach(t => {
      nodes.set(t.TaskId, t);
      const key = t.ParentId || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(t);
    });

    // ソート関数（フォルダ先、名称昇順）
    const sortChildren = (arr) => {
      arr.sort((a, b) => {
        const af = a.IsFolder === true ? 0 : 1;
        const bf = b.IsFolder === true ? 0 : 1;
        if (af !== bf) return af - bf; // フォルダ優先
        return (a.Title || "").localeCompare(b.Title || "");
      });
    };

    const renderGroup = (parentId, level) => {
      const list = byParent.get(parentId || "") || [];
      sortChildren(list);

      list.forEach(item => {
        const li = document.createElement("li");
        li.dataset.taskId = item.TaskId;
        const isFolder = item.IsFolder === true;

        // インデント
        const indent = document.createElement("span");
        indent.className = "indent";
        indent.style.setProperty("--indent", `${level * 18}px`);
        li.appendChild(indent);

        // 折り畳みボタン（フォルダ時のみ）
        if (isFolder) {
          li.classList.add("folder-item");
          const btn = document.createElement("span");
          btn.className = "toggle-btn";
          const isCollapsed = !!collapsed[item.TaskId];
          btn.textContent = isCollapsed ? "+" : "−";
          btn.title = isCollapsed ? "展開" : "折り畳み";
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            collapsed[item.TaskId] = !collapsed[item.TaskId];
            saveCollapsedState();           // ← 操作のたびに保存
            renderTaskTree(tasks);          // 再描画
          });
          li.appendChild(btn);
        } else {
          const ph = document.createElement("span");
          ph.style.width = "18px";
          ph.style.display = "inline-block";
          li.appendChild(ph);
        }

        // 表示名
        const nameSpan = document.createElement("span");
        nameSpan.textContent = item.Title || item.TaskId;
        nameSpan.style.flex = "1 1 auto";
        li.appendChild(nameSpan);

        // フォルダタグ
        if (isFolder) {
          const tag = document.createElement("span");
          tag.className = "folder-tag";
          tag.textContent = "フォルダ";
          li.appendChild(tag);
        }

        // クリック動作
        li.addEventListener("click", () => {
          if (isFolder) {
            // フォルダ名クリック → 新規作成 + 親フォルダセット
            exitFolderOnlyMode();
            currentIsFolder = false;
            populateTaskForm({
              TaskId: "",
              Title: "",
              DescriptionHtml: "",
              HintHtml: "",
              AnswerCode: "",
              InitialCode: "",
              ParentId: item.TaskId,
              IsFolder: false,
            });
            $("taskParentId").value = item.TaskId; // 親にセット
            setActiveTask(null);
            setStatus(`「${item.Title || item.TaskId}」配下に新規課題を作成します。`);
          } else {
            // 課題クリック → 編集
            exitFolderOnlyMode();
            currentIsFolder = false;
            populateTaskForm(item);
            setActiveTask(item.TaskId);
            setStatus("");
          }
        });

        ul.appendChild(li);

        // 子の描画（折り畳み中はスキップ）
        if (isFolder && !collapsed[item.TaskId]) {
          renderGroup(item.TaskId, level + 1);
        }
      });
    };

    renderGroup("", 0);

    // 再読込後の再選択
    if (lastSelectedId) setActiveTask(lastSelectedId);
  }

  function populateTaskForm(task) {
    $("taskId").value = task.TaskId || "";
    $("taskTitle").value = task.Title || "";
    $("taskParentId").value = task.ParentId || "";

    $("taskDesc").value = task.DescriptionHtml || task.Description || "";
    $("taskHint").value = task.HintHtml || task.Hint || "";

    if (answerEditor) {
      answerEditor.setValue(task.AnswerCode || task.Answer || "");
      answerEditor.refresh();
    } else {
      $("answerEditor").value = task.AnswerCode || task.Answer || "";
    }
    if (initialEditor) {
      initialEditor.setValue(task.InitialCode || "");
      initialEditor.refresh();
    } else {
      $("initialEditor").value = task.InitialCode || "";
    }

    currentIsFolder = task.IsFolder === true;
  }

  /** フォルダ作成モード（タイトル/親以外を無効化＆見た目グレー） */
  function enterFolderOnlyMode() {
    ["field-desc", "field-hint", "block-answer", "block-initial"].forEach(id => {
      $(id).classList.add("is-disabled");
    });
    if (answerEditor) answerEditor.setOption("readOnly", "nocursor");
    if (initialEditor) initialEditor.setOption("readOnly", "nocursor");
    $("taskDesc").setAttribute("readonly", "readonly");
    $("taskHint").setAttribute("readonly", "readonly");
  }
  /** フォルダ作成モード解除 */
  function exitFolderOnlyMode() {
    ["field-desc", "field-hint", "block-answer", "block-initial"].forEach(id => {
      $(id).classList.remove("is-disabled");
    });
    if (answerEditor) answerEditor.setOption("readOnly", false);
    if (initialEditor) initialEditor.setOption("readOnly", false);
    $("taskDesc").removeAttribute("readonly");
    $("taskHint").removeAttribute("readonly");
  }

  /** 選択中の課題を同一フォルダに複製（TaskIdはサーバ採番） */
  async function copySelectedTask() {
    const tasks = Array.isArray(window.__TASKS) ? window.__TASKS : [];
    const selectedId = getCurrentlySelectedTaskId();
    if (!selectedId) {
      setStatus("複製する課題を左の一覧から選択してください。", "error");
      return;
    }
    const src = tasks.find(t => t.TaskId === selectedId);
    if (!src) {
      setStatus("選択中の課題が見つかりません。", "error");
      return;
    }
    if (src.IsFolder === true) {
      setStatus("フォルダは複製できません。課題を選択してください。", "error");
      return;
    }

    const session = getSessionId();
    const payload = new URLSearchParams();
    payload.append("action", "saveTask");
    if (session) payload.append("session", session);
    payload.append("_ts", String(Date.now()));
    // TaskId は空（＝サーバで新規採番）
    payload.append("Title", src.Title || src.TaskId);
    payload.append("DescriptionHtml", src.DescriptionHtml || "");
    payload.append("HintHtml", src.HintHtml || "");
    payload.append("AnswerCode", src.AnswerCode || "");
    payload.append("InitialCode", src.InitialCode || "");
    payload.append("ParentId", src.ParentId || "");
    payload.append("IsFolder", "false");

    setStatus("コピーを作成しています…");
    try {
      const res = await fetch(APP_CONFIG.serverBaseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
        cache: "no-store",
      });
      const text = await safeText(res);
      if (!res.ok) {
        setStatus("コピーの作成に失敗しました。", "error");
        log.error("copy save HTTPエラー", res.status, text);
        return;
      }
      const json = safeJson(text);
      if (!json || json.status !== "ok") {
        setStatus((json && json.message) || "コピーの作成に失敗しました。", "error");
        log.error("copy save アプリエラー", json);
        return;
      }

      const newId = json.taskId;
      setStatus("コピーを作成しました。", "success");
      log.info("コピー作成完了", { from: src.TaskId, to: newId });

      // 即時ローカル反映
      const newTask = {
        TaskId: newId,
        Title: src.Title || newId,
        DescriptionHtml: src.DescriptionHtml || "",
        HintHtml: src.HintHtml || "",
        AnswerCode: src.AnswerCode || "",
        InitialCode: src.InitialCode || "",
        ParentId: src.ParentId || "",
        IsFolder: false,
      };
      const arr = tasks.slice();
      arr.push(newTask);
      window.__TASKS = arr;
      renderTaskTree(arr);
      populateParentFolderSelect(arr);
      setActiveTask(newId);
      populateTaskForm(newTask); // すぐ編集できるようにフォームにも反映

      // サーバ再同期
      await loadTaskList();
      setActiveTask(newId);
      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      setStatus("コピーの作成中にエラーが発生しました。", "error");
      log.error("copy例外", err);
    }
  }

  /** 現在選択中（ハイライトされている）課題の TaskId を返す */
  function getCurrentlySelectedTaskId() {
    const active = document.querySelector("#taskTree li.active");
    if (active && active.dataset.taskId) return active.dataset.taskId;
    // 直近選択を fallback
    return lastSelectedId;
  }

  async function saveTask() {
    if (!APP_CONFIG?.serverBaseUrl) {
      setStatus("サーバ設定が未設定です。", "error");
      return;
    }
    const session = getSessionId();

    const taskId = $("taskId").value.trim();
    const title = $("taskTitle").value.trim();
    const parentId = $("taskParentId").value;
    const desc = $("taskDesc").value;
    const hint = $("taskHint").value;
    const ans = answerEditor ? answerEditor.getValue() : $("answerEditor").value;
    const initCode = initialEditor ? initialEditor.getValue() : $("initialEditor").value;

    $("saveTaskButton").disabled = true;
    setStatus("保存しています…");
    log.info("保存開始", {
      taskId: taskId || "(new)",
      title,
      parentId,
      isFolder: currentIsFolder,
    });

    const payload = new URLSearchParams();
    payload.append("action", "saveTask");
    if (session) payload.append("session", session);
    payload.append("_ts", String(Date.now()));
    if (taskId) payload.append("TaskId", taskId);
    payload.append("Title", title);
    payload.append("DescriptionHtml", desc);
    payload.append("HintHtml", hint);
    payload.append("AnswerCode", ans);
    payload.append("InitialCode", initCode);
    payload.append("ParentId", parentId || "");
    payload.append("IsFolder", String(!!currentIsFolder));

    try {
      const res = await fetch(APP_CONFIG.serverBaseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
        cache: "no-store",
      });
      const text = await safeText(res);
      if (!res.ok) {
        setStatus("保存に失敗しました。", "error");
        log.error("保存HTTPエラー", res.status, text);
        return;
      }
      const json = safeJson(text);
      if (!json || json.status !== "ok") {
        setStatus((json && json.message) || "保存に失敗しました。", "error");
        log.error("保存アプリエラー", json);
        return;
      }

      const newId = json.taskId || taskId || "";
      $("taskId").value = newId;
      setStatus("保存完了しました。", "success");
      log.info("保存完了", { taskId: newId });

      // 即時ローカル反映（追加 or 置換）
      const local = {
        TaskId: newId,
        Title: title || newId,
        DescriptionHtml: desc,
        HintHtml: hint,
        AnswerCode: ans,
        InitialCode: initCode,
        ParentId: parentId || "",
        IsFolder: !!currentIsFolder,
      };
      const arr = Array.isArray(window.__TASKS) ? window.__TASKS.slice() : [];
      const i = arr.findIndex(x => x.TaskId === newId);
      if (i >= 0) arr[i] = local; else arr.push(local);
      window.__TASKS = arr;
      renderTaskTree(arr);
      populateParentFolderSelect(arr);
      setActiveTask(newId);

      // サーバ再同期
      await loadTaskList();
      setActiveTask(newId);

      setTimeout(() => setStatus(""), 1500);
    } catch (err) {
      setStatus("保存時にエラーが発生しました。", "error");
      log.error("保存例外", err);
    } finally {
      $("saveTaskButton").disabled = false;
    }
  }

  /* Utility */
  async function safeText(res) { try { return await res.text(); } catch { return ""; } }
  function safeJson(text) {
    try {
      const cleaned = text.replace(/^[)\]\}'\s]+/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
})();
