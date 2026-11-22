// ==UserScript==
// @name         AI 自动刷题助手 (OpenAI API)
// @namespace    https://github.com/ai-auto-solver
// @version      1.0.1
// @description  自动获取题目并通过 OpenAI 兼容 API 生成代码、填入 Monaco 编辑器、提交判题；出错时自动回传错误信息重试，通过后自动进入下一题，内置可视化管理面板。
// @author       github/locherli
// @match        https://leetcode.cn/problems/*
// @match        https://leetcode.com/problems/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================================
  // 1. 默认配置与持久化存储
  // ============================================================================
  const STORAGE_KEY_CONFIG = 'ai_auto_solver_config_v1';
  const STORAGE_KEY_STATE = 'ai_auto_solver_runtime_state_v1';

  const DEFAULT_CONFIG = {
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    temperature: 0.2,
    maxRetries: 3,
    submitTimeout: 20000,
    nextProblemDelay: 2500,
    skipOnMaxRetries: true,
    autoContinueAfterReload: false,
    systemPrompt: [
      '你是一名精通算法与数据结构的编程竞赛专家。',
      '请根据用户提供的题目描述、目标编程语言和初始代码模板，直接给出可以通过所有测试用例的完整、高效、无语法错误的代码。',
      '要求：',
      '1. 严格保留初始代码模板中的类名、函数名、参数签名与返回类型，不要额外添加 main 函数或 package main 等测试入口。',
      '2. 仅输出最终代码，不要输出任何解释文字；如使用 Markdown 代码块，请只包含一个代码块。',
      '3. 若用户反馈了错误结果或报错信息，请针对错误原因彻底修复并重新输出完整代码。',
    ].join('\n'),
  };

  function loadConfig() {
    try {
      const raw = GM_getValue(STORAGE_KEY_CONFIG, '');
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(cfg) {
    GM_setValue(STORAGE_KEY_CONFIG, JSON.stringify(cfg));
  }

  function loadRuntimeState() {
    try {
      const raw = GM_getValue(STORAGE_KEY_STATE, '');
      if (!raw) return { running: false, solved: 0, retries: 0, skipped: 0 };
      return { running: false, solved: 0, retries: 0, skipped: 0, ...JSON.parse(raw) };
    } catch (e) {
      return { running: false, solved: 0, retries: 0, skipped: 0 };
    }
  }

  function saveRuntimeState(state) {
    GM_setValue(STORAGE_KEY_STATE, JSON.stringify(state));
  }

  let config = loadConfig();
  let runtime = loadRuntimeState();
  let isLoopRunning = false;
  let stopRequested = false;
  let activeRequestAbort = null;

  // ============================================================================
  // 2. 页面 DOM 与 Monaco 编辑器操作
  // ============================================================================

  /** 获取题目描述文本与 HTML */
  function getProblemDescription() {
    const descriptionEl = document.querySelector('[data-track-load="description_content"]');
    if (!descriptionEl) return null;
    return {
      textContent: descriptionEl.innerText.trim(),
      htmlContent: descriptionEl.innerHTML,
    };
  }

  /** 获取当前选择的编程语言 */
  function getSelectedLanguage() {
    const btn = document.querySelector('[data-e2e-locator="lang-selector-button"]');
    if (btn) {
      return btn.innerText.trim();
    }
    return '';
  }

  /** 获取 Monaco 主编辑器实例 */
  function getMonacoEditor() {
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const monacoObj = (pageWin && pageWin.monaco) || window.monaco;
    if (monacoObj && monacoObj.editor) {
      const editors = monacoObj.editor.getEditors();
      if (editors && editors.length > 0) {
        return editors[0];
      }
    }
    return null;
  }

  /** 读取当前编辑器中的代码（用于获取函数签名模板） */
  function getMonacoValue() {
    const editor = getMonacoEditor();
    return editor ? editor.getValue() : '';
  }

  /** 直接通过全局 monaco 设置当前编辑器内容 */
  function setMonacoValue(newCode) {
    const editor = getMonacoEditor();
    if (editor) {
      editor.setValue(newCode);
      return true;
    }
    return false;
  }

  /** 点击下一题按钮 */
  function clickNextProblem() {
    const nextBtn = document.querySelector('[data-e2e-locator="nav-next"]');
    if (nextBtn) {
      if (nextBtn.getAttribute('data-e2e-disabled') === 'true') {
        addLog('下一题按钮当前被禁用（可能已是最后一题）', 'warn');
        return { ok: false, disabled: true };
      }
      nextBtn.click();
      addLog('已点击下一题', 'info');
      return { ok: true, disabled: false };
    }
    addLog('未找到下一题按钮', 'error');
    return { ok: false, disabled: false };
  }

  /** 点击提交按钮 */
  function clickSubmitButton() {
    const submitBtn = document.querySelector('[data-e2e-locator="console-submit-button"]');
    if (!submitBtn) {
      return { ok: false, reason: '未找到提交按钮' };
    }
    if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, busy: true, reason: '提交按钮当前不可用（可能正在判题中）' };
    }
    submitBtn.click();
    return { ok: true };
  }

  /** 等待提交按钮恢复可用 */
  async function waitForSubmitReady(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) throw new Error('用户已停止脚本');
      const submitBtn = document.querySelector('[data-e2e-locator="console-submit-button"]');
      if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true') {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  /** 判断元素当前是否可见 */
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * 查找当前页面上的判题结果状态元素：
   * - 成功页通常使用 [data-e2e-locator="submission-result"]（如“通过”）
   * - 失败/报错页通常使用 [data-e2e-locator="console-result"]（如“编译出错”、“解答错误”）
   */
  function findResultStatusElement() {
    const candidates = Array.from(
      document.querySelectorAll('[data-e2e-locator="submission-result"], [data-e2e-locator="console-result"]')
    );
    if (candidates.length === 0) return null;
    const visible = candidates.filter(isElementVisible);
    if (visible.length > 0) {
      // 优先返回可见的 submission-result，其次是可见的 console-result
      const visibleSubmission = visible.find(
        (el) => el.getAttribute('data-e2e-locator') === 'submission-result'
      );
      return visibleSubmission || visible[visible.length - 1];
    }
    return candidates[candidates.length - 1];
  }

  /** 提取当前可见的错误详情（.font-menlo） */
  function extractResultDetail() {
    const allMenlo = Array.from(document.querySelectorAll('.font-menlo'));
    const visibleMenlo = allMenlo.filter(isElementVisible);
    const targetList = visibleMenlo.length > 0 ? visibleMenlo : allMenlo;
    return targetList
      .map((el) => el.innerText.trim())
      .filter(Boolean)
      .join('\n');
  }

  /** 读取当前判题结果快照，用于避免读到上一次提交的旧结果 */
  function readCurrentResultSnapshot() {
    const statusEl = findResultStatusElement();
    return {
      url: location.href,
      statusEl,
      locator: statusEl ? statusEl.getAttribute('data-e2e-locator') : '',
      status: statusEl ? statusEl.innerText.trim() : '',
      detail: extractResultDetail(),
    };
  }

  /** 等待判题结果（同时兼容 submission-result 与 console-result） */
  function waitForSubmissionResult(timeout = 20000, previousSnapshot = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawTransition = false;
      const startTime = Date.now();

      const isTransitional = (status) => {
        const lower = status.toLowerCase();
        return (
          status.includes('执行') ||
          status.includes('判题') ||
          status.includes('提交中') ||
          lower.includes('pending') ||
          lower.includes('judging') ||
          lower.includes('running')
        );
      };

      const checkResult = () => {
        const statusEl = findResultStatusElement();
        const submitBtn = document.querySelector('[data-e2e-locator="console-submit-button"]');
        const isSubmitting = !!(
          submitBtn &&
          (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true')
        );

        if (!statusEl || statusEl.innerText.trim() === '') {
          sawTransition = true;
          return null;
        }

        const status = statusEl.innerText.trim();
        if (isTransitional(status)) {
          sawTransition = true;
          return null;
        }

        const detail = extractResultDetail();
        const locator = statusEl.getAttribute('data-e2e-locator') || '';

        // 判断是否为本次提交新渲染的结果（DOM 节点变化、URL 变化、定位器或文本变化）
        const isSameAsPrevious = !!(
          previousSnapshot &&
          previousSnapshot.status &&
          statusEl === previousSnapshot.statusEl &&
          locator === previousSnapshot.locator &&
          status === previousSnapshot.status &&
          detail === previousSnapshot.detail &&
          location.href === previousSnapshot.url
        );

        if (isSameAsPrevious) {
          if (isSubmitting) {
            sawTransition = true;
            return null;
          }
          // 若页面上残留了上一次提交的相同 DOM，等待其刷新或经过短暂过渡期
          if (!sawTransition && Date.now() - startTime < 4000) {
            return null;
          }
        }

        return { status, detail, locator };
      };

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        fn(val);
      };

      const observer = new MutationObserver(() => {
        if (stopRequested) {
          finish(reject, new Error('用户已停止脚本'));
          return;
        }
        const res = checkResult();
        if (res) finish(resolve, res);
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const pollTimer = setInterval(() => {
        if (stopRequested) {
          finish(reject, new Error('用户已停止脚本'));
          return;
        }
        const res = checkResult();
        if (res) finish(resolve, res);
      }, 300);

      const timeoutTimer = setTimeout(() => {
        finish(reject, new Error('等待判题结果超时'));
      }, timeout);
    });
  }

  /** 判断判题结果是否通过 */
  function isAcceptedResult(status) {
    if (!status) return false;
    const normalized = status.trim();
    const lower = normalized.toLowerCase();
    if (lower.includes('accepted') && !lower.includes('not accepted')) {
      return true;
    }
    if (normalized === '通过' || (normalized.includes('通过') && !normalized.includes('未通过') && !normalized.includes('不通过'))) {
      return true;
    }
    return false;
  }

  /** 等待题目描述与编辑器加载就绪（支持 SPA 切换下一题） */
  async function waitForProblemReady(prevUrl = '', prevText = '', timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) throw new Error('用户已停止脚本');
      const desc = getProblemDescription();
      const editor = getMonacoEditor();
      const lang = getSelectedLanguage();
      const submitBtn = document.querySelector('[data-e2e-locator="console-submit-button"]');

      const contentLoaded = desc && desc.textContent.length > 10 && editor && lang && submitBtn;
      if (contentLoaded) {
        const changed =
          (!prevUrl && !prevText) ||
          location.href !== prevUrl ||
          desc.textContent !== prevText;
        if (changed) {
          // 额外短暂等待，确保 Monaco 已加载新题目的初始模板
          await sleep(800);
          return true;
        }
      }
      await sleep(400);
    }
    throw new Error('等待题目与编辑器加载超时');
  }

  // ============================================================================
  // 3. OpenAI 兼容 API 调用与代码提取
  // ============================================================================

  function buildChatCompletionsUrl(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('请先配置 API Base URL');
    if (trimmed.endsWith('/chat/completions')) return trimmed;
    return `${trimmed}/chat/completions`;
  }

  function callOpenAI(messages) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = buildChatCompletionsUrl(config.apiBaseUrl);
      } catch (e) {
        reject(e);
        return;
      }
      if (!config.apiKey || !config.apiKey.trim()) {
        reject(new Error('请先配置 API Key'));
        return;
      }

      const payload = {
        model: (config.model || 'gpt-4o').trim(),
        messages,
        temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 0.2,
      };

      const req = GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey.trim()}`,
        },
        data: JSON.stringify(payload),
        timeout: 90000,
        onload: (res) => {
          activeRequestAbort = null;
          if (res.status < 200 || res.status >= 300) {
            let errMsg = `HTTP ${res.status}`;
            try {
              const errJson = JSON.parse(res.responseText);
              if (errJson.error && errJson.error.message) {
                errMsg += `: ${errJson.error.message}`;
              }
            } catch (_) {
              errMsg += `: ${(res.responseText || '').slice(0, 200)}`;
            }
            reject(new Error(`API 请求失败 (${errMsg})`));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            const content = data?.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error('API 返回内容为空'));
              return;
            }
            resolve(content);
          } catch (e) {
            reject(new Error(`解析 API 响应失败: ${e.message}`));
          }
        },
        onerror: () => {
          activeRequestAbort = null;
          reject(new Error('API 网络请求失败，请检查接口地址与网络连接'));
        },
        ontimeout: () => {
          activeRequestAbort = null;
          reject(new Error('API 请求超时'));
        },
        onabort: () => {
          activeRequestAbort = null;
          reject(new Error('API 请求已中止'));
        },
      });

      activeRequestAbort = () => {
        try {
          if (req && typeof req.abort === 'function') req.abort();
        } catch (_) {}
      };
    });
  }

  /** 从 LLM 返回文本中提取纯代码 */
  function extractCodeFromResponse(rawText) {
    if (!rawText) return '';
    const trimmed = rawText.trim();
    const fenceRegex = /```(?:[\w#+.-]*)\s*\n([\s\S]*?)```/g;
    const matches = [];
    let m;
    while ((m = fenceRegex.exec(trimmed)) !== null) {
      if (m[1] && m[1].trim()) {
        matches.push(m[1].trim());
      }
    }
    if (matches.length > 0) {
      // 取最长代码块（通常是完整解答）
      matches.sort((a, b) => b.length - a.length);
      return matches[0];
    }
    // 兼容无代码围栏直接返回纯代码的情况
    return trimmed;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // 4. 自动刷题核心主循环
  // ============================================================================

  async function solveCurrentProblem() {
    const desc = getProblemDescription();
    if (!desc || !desc.textContent) {
      throw new Error('未找到题目描述区域 [data-track-load="description_content"]');
    }

    const lang = getSelectedLanguage() || '未知语言';
    const starterCode = getMonacoValue();
    const problemTitle = document.title.replace(/\s*[-|].*$/, '').trim() || location.pathname;

    addLog(`开始处理题目：${problemTitle}（语言：${lang}）`, 'info');

    const messages = [
      { role: 'system', content: config.systemPrompt },
      {
        role: 'user',
        content: [
          `题目：${problemTitle}`,
          `编程语言：${lang}`,
          '',
          '题目描述：',
          desc.textContent,
          '',
          starterCode ? `当前编辑器初始代码模板：\n\`\`\`\n${starterCode}\n\`\`\`` : '',
          '',
          `请直接输出完整的 ${lang} 解答代码。`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    const maxAttempts = Math.max(1, Number(config.maxRetries) + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (stopRequested) throw new Error('用户已停止脚本');

      addLog(`第 ${attempt}/${maxAttempts} 次请求 AI 生成解答...`, 'info');
      const aiReply = await callOpenAI(messages);
      if (stopRequested) throw new Error('用户已停止脚本');

      const code = extractCodeFromResponse(aiReply);
      if (!code) {
        throw new Error('未能从 AI 回复中提取到有效代码');
      }

      messages.push({ role: 'assistant', content: aiReply });

      const filled = setMonacoValue(code);
      if (!filled) {
        throw new Error('填入代码失败：未找到 Monaco 编辑器实例');
      }
      addLog(`已将代码填入编辑器（${code.length} 字符）`, 'info');

      await sleep(500);
      await waitForSubmitReady(10000);
      if (stopRequested) throw new Error('用户已停止脚本');

      const prevSnapshot = readCurrentResultSnapshot();
      const submitRes = clickSubmitButton();
      if (!submitRes.ok) {
        throw new Error(submitRes.reason || '点击提交失败');
      }
      addLog('已点击提交，等待判题结果...', 'info');

      const result = await waitForSubmissionResult(
        Math.max(5000, Number(config.submitTimeout) || 20000),
        prevSnapshot
      );

      addLog(`判题结果：${result.status}`, isAcceptedResult(result.status) ? 'success' : 'warn');

      if (isAcceptedResult(result.status)) {
        runtime.solved += 1;
        saveRuntimeState(runtime);
        updateStatsUI();
        return { accepted: true, result };
      }

      // 回答错误，准备把错误信息反馈给 AI
      if (attempt < maxAttempts) {
        runtime.retries += 1;
        saveRuntimeState(runtime);
        updateStatsUI();

        const errorSummary = [
          `上次提交未通过，判题状态：${result.status}`,
          result.detail ? `错误/测试用例详情：\n${result.detail}` : '（页面未返回详细错误输出，请检查边界条件、时间/空间复杂度与语法）',
          '',
          `请分析原因并重新输出修复后的完整 ${lang} 代码（仅输出代码）。`,
        ].join('\n');

        addLog(`推送错误信息给 AI 重试：${result.status}`, 'warn');
        messages.push({ role: 'user', content: errorSummary });
        await sleep(1200);
      } else {
        return { accepted: false, result };
      }
    }

    return { accepted: false, result: null };
  }

  async function runAutomationLoop({ singleProblemOnly = false } = {}) {
    if (isLoopRunning) return;
    if (!config.apiKey.trim()) {
      addLog('请先在管理面板中填写 API Key', 'error');
      setStatusUI('未配置 Key', 'error');
      return;
    }

    isLoopRunning = true;
    stopRequested = false;
    runtime.running = !singleProblemOnly;
    saveRuntimeState(runtime);
    updateControlButtonsUI();
    setStatusUI(singleProblemOnly ? '单题运行中' : '自动刷题中', 'running');

    try {
      while (!stopRequested) {
        await waitForProblemReady();
        const currentUrl = location.href;
        const currentDesc = getProblemDescription()?.textContent || '';

        const outcome = await solveCurrentProblem();

        if (stopRequested) break;

        if (!outcome.accepted) {
          runtime.skipped += 1;
          saveRuntimeState(runtime);
          updateStatsUI();

          if (singleProblemOnly || !config.skipOnMaxRetries) {
            addLog('达到最大重试次数且未通过，已自动停止', 'error');
            setStatusUI('重试失败已停', 'error');
            break;
          }
          addLog('达到最大重试次数，跳过当前题目进入下一题', 'warn');
        }

        if (singleProblemOnly) {
          addLog('单题任务执行完毕', 'success');
          setStatusUI('已完成', 'idle');
          break;
        }

        const delayMs = Math.max(500, Number(config.nextProblemDelay) || 2500);
        addLog(`等待 ${(delayMs / 1000).toFixed(1)} 秒后进入下一题...`, 'info');
        await sleep(delayMs);
        if (stopRequested) break;

        const nextRes = clickNextProblem();
        if (!nextRes.ok) {
          if (nextRes.disabled) {
            addLog('已到达最后一题，自动刷题完成！', 'success');
            setStatusUI('全部完成', 'idle');
          } else {
            setStatusUI('无法切换下一题', 'error');
          }
          break;
        }

        addLog('等待下一题加载...', 'info');
        await waitForProblemReady(currentUrl, currentDesc, 20000);
      }
    } catch (err) {
      if (stopRequested || err.message === '用户已停止脚本' || err.message === 'API 请求已中止') {
        addLog('脚本已手动停止', 'warn');
        setStatusUI('已停止', 'idle');
      } else {
        addLog(`运行出错：${err.message}`, 'error');
        setStatusUI('运行出错', 'error');
      }
    } finally {
      isLoopRunning = false;
      runtime.running = false;
      saveRuntimeState(runtime);
      updateControlButtonsUI();
      if (stopRequested) {
        setStatusUI('已停止', 'idle');
      }
    }
  }

  function stopAutomation() {
    stopRequested = true;
    runtime.running = false;
    saveRuntimeState(runtime);
    if (activeRequestAbort) {
      activeRequestAbort();
      activeRequestAbort = null;
    }
    updateControlButtonsUI();
    setStatusUI('正在停止...', 'idle');
  }

  // ============================================================================
  // 5. 可视化管理页面 UI
  // ============================================================================

  const logs = [];
  let uiRefs = {};

  function addLog(message, level = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = { time, message, level };
    logs.push(entry);
    if (logs.length > 200) logs.shift();

    console.log(`[AI Auto Solver][${level.toUpperCase()}] ${message}`);

    if (uiRefs.logBox) {
      const line = document.createElement('div');
      line.className = `aas-log-line aas-log-${level}`;
      line.textContent = `[${time}] ${message}`;
      uiRefs.logBox.appendChild(line);
      uiRefs.logBox.scrollTop = uiRefs.logBox.scrollHeight;
    }
  }

  function setStatusUI(text, mode = 'idle') {
    if (uiRefs.statusBadge) {
      uiRefs.statusBadge.textContent = text;
      uiRefs.statusBadge.className = `aas-badge aas-badge-${mode}`;
    }
    if (uiRefs.fabDot) {
      uiRefs.fabDot.className = `aas-fab-dot aas-dot-${mode}`;
    }
  }

  function updateStatsUI() {
    if (uiRefs.statSolved) uiRefs.statSolved.textContent = String(runtime.solved);
    if (uiRefs.statRetries) uiRefs.statRetries.textContent = String(runtime.retries);
    if (uiRefs.statSkipped) uiRefs.statSkipped.textContent = String(runtime.skipped);
  }

  function updateControlButtonsUI() {
    if (!uiRefs.btnStart) return;
    uiRefs.btnStart.disabled = isLoopRunning;
    uiRefs.btnSingle.disabled = isLoopRunning;
    uiRefs.btnStop.disabled = !isLoopRunning;
  }

  function injectStyles() {
    GM_addStyle(`
      #aas-fab {
        position: fixed;
        right: 22px;
        bottom: 24px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        border-radius: 999px;
        background: #111827;
        color: #f9fafb;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        cursor: pointer;
        user-select: none;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      #aas-fab:hover {
        background: #1f2937;
        transform: translateY(-1px);
      }
      .aas-fab-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #9ca3af;
      }
      .aas-dot-running { background: #10b981; box-shadow: 0 0 8px #10b981; }
      .aas-dot-error { background: #ef4444; }
      .aas-dot-idle { background: #9ca3af; }

      #aas-panel {
        position: fixed;
        right: 22px;
        bottom: 76px;
        width: 420px;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 104px);
        z-index: 99999;
        background: #ffffff;
        color: #111827;
        border-radius: 14px;
        border: 1px solid #e5e7eb;
        box-shadow: 0 18px 48px rgba(0,0,0,0.22);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      #aas-panel.aas-open { display: flex; }

      .aas-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: #111827;
        color: #f9fafb;
      }
      .aas-title-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 14px;
      }
      .aas-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        font-weight: 600;
      }
      .aas-badge-idle { background: #374151; color: #e5e7eb; }
      .aas-badge-running { background: #065f46; color: #a7f3d0; }
      .aas-badge-error { background: #7f1d1d; color: #fecaca; }

      .aas-close-btn {
        background: transparent;
        border: none;
        color: #9ca3af;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        padding: 2px 6px;
      }
      .aas-close-btn:hover { color: #ffffff; }

      .aas-body {
        padding: 14px 16px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .aas-controls {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
      }
      .aas-btn {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease, background 0.15s ease;
      }
      .aas-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .aas-btn-primary { background: #2563eb; color: #fff; }
      .aas-btn-primary:hover:not(:disabled) { background: #1d4ed8; }
      .aas-btn-secondary { background: #f3f4f6; color: #111827; border-color: #d1d5db; }
      .aas-btn-secondary:hover:not(:disabled) { background: #e5e7eb; }
      .aas-btn-danger { background: #dc2626; color: #fff; }
      .aas-btn-danger:hover:not(:disabled) { background: #b91c1c; }

      .aas-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      .aas-stat-card {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 8px;
        text-align: center;
      }
      .aas-stat-val { font-size: 16px; font-weight: 700; color: #111827; }
      .aas-stat-lbl { font-size: 11px; color: #6b7280; margin-top: 2px; }

      .aas-section-title {
        font-size: 12px;
        font-weight: 700;
        color: #374151;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .aas-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
      .aas-field label { font-size: 12px; color: #4b5563; font-weight: 500; }
      .aas-input, .aas-textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 7px 10px;
        border: 1px solid #d1d5db;
        border-radius: 7px;
        font-size: 12px;
        color: #111827;
        background: #fff;
        outline: none;
      }
      .aas-input:focus, .aas-textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 2px rgba(37,99,235,0.14);
      }
      .aas-textarea { resize: vertical; min-height: 70px; font-family: inherit; }

      .aas-row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .aas-key-wrap {
        display: flex;
        gap: 6px;
      }
      .aas-checkbox-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #374151;
        margin-top: 2px;
      }

      .aas-log-box {
        height: 150px;
        overflow-y: auto;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 8px;
        padding: 8px 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
      }
      .aas-log-line { word-break: break-word; margin-bottom: 2px; }
      .aas-log-info { color: #cbd5e1; }
      .aas-log-success { color: #34d399; }
      .aas-log-warn { color: #fbbf24; }
      .aas-log-error { color: #f87171; }

      .aas-link-btn {
        background: none;
        border: none;
        color: #2563eb;
        font-size: 11px;
        cursor: pointer;
        padding: 0;
      }
      .aas-link-btn:hover { text-decoration: underline; }
    `);
  }

  function createManagementUI() {
    if (document.getElementById('aas-fab')) return;
    injectStyles();

    // 悬浮开关按钮
    const fab = document.createElement('div');
    fab.id = 'aas-fab';
    fab.innerHTML = `<span class="aas-fab-dot aas-dot-idle" id="aas-fab-dot"></span><span>AI 自动刷题</span>`;
    document.body.appendChild(fab);

    // 管理面板
    const panel = document.createElement('div');
    panel.id = 'aas-panel';
    panel.innerHTML = `
      <div class="aas-header">
        <div class="aas-title-wrap">
          <span>AI 自动刷题管理面板</span>
          <span id="aas-status-badge" class="aas-badge aas-badge-idle">空闲</span>
        </div>
        <button class="aas-close-btn" id="aas-close-btn" title="关闭">&times;</button>
      </div>
      <div class="aas-body">
        <div class="aas-controls">
          <button class="aas-btn aas-btn-primary" id="aas-btn-start">启动连续刷题</button>
          <button class="aas-btn aas-btn-secondary" id="aas-btn-single">仅解当前题</button>
          <button class="aas-btn aas-btn-danger" id="aas-btn-stop" disabled>停止</button>
        </div>

        <div class="aas-stats">
          <div class="aas-stat-card">
            <div class="aas-stat-val" id="aas-stat-solved">0</div>
            <div class="aas-stat-lbl">已通过</div>
          </div>
          <div class="aas-stat-card">
            <div class="aas-stat-val" id="aas-stat-retries">0</div>
            <div class="aas-stat-lbl">纠错重试</div>
          </div>
          <div class="aas-stat-card">
            <div class="aas-stat-val" id="aas-stat-skipped">0</div>
            <div class="aas-stat-lbl">失败/跳过</div>
          </div>
        </div>

        <div>
          <div class="aas-section-title">
            <span>OpenAI API 配置</span>
            <button class="aas-link-btn" id="aas-btn-test">测试连接</button>
          </div>
          <div class="aas-field">
            <label for="aas-api-url">API Base URL</label>
            <input class="aas-input" id="aas-api-url" type="text" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="aas-field">
            <label for="aas-api-key">API Key</label>
            <div class="aas-key-wrap">
              <input class="aas-input" id="aas-api-key" type="password" placeholder="sk-..." />
              <button class="aas-btn aas-btn-secondary" id="aas-toggle-key" type="button">显示</button>
            </div>
          </div>
          <div class="aas-row-2">
            <div class="aas-field">
              <label for="aas-model">模型名称 (Model)</label>
              <input class="aas-input" id="aas-model" type="text" placeholder="gpt-4o" />
            </div>
            <div class="aas-field">
              <label for="aas-temp">Temperature</label>
              <input class="aas-input" id="aas-temp" type="number" step="0.1" min="0" max="2" />
            </div>
          </div>
        </div>

        <div>
          <div class="aas-section-title">
            <span>刷题策略配置</span>
            <button class="aas-link-btn" id="aas-btn-reset-stats">重置统计</button>
          </div>
          <div class="aas-row-2">
            <div class="aas-field">
              <label for="aas-max-retries">单题最大重试次数</label>
              <input class="aas-input" id="aas-max-retries" type="number" min="0" max="10" />
            </div>
            <div class="aas-field">
              <label for="aas-timeout">判题等待超时 (ms)</label>
              <input class="aas-input" id="aas-timeout" type="number" min="5000" step="1000" />
            </div>
          </div>
          <div class="aas-field">
            <label for="aas-delay">切换下一题间隔 (ms)</label>
            <input class="aas-input" id="aas-delay" type="number" min="500" step="500" />
          </div>
          <label class="aas-checkbox-row">
            <input type="checkbox" id="aas-skip-max" />
            <span>重试耗尽仍未通过时，自动跳过进入下一题</span>
          </label>
          <label class="aas-checkbox-row">
            <input type="checkbox" id="aas-auto-reload" />
            <span>页面刷新后自动恢复连续刷题</span>
          </label>
          <div class="aas-field" style="margin-top:8px;">
            <label for="aas-sys-prompt">System Prompt</label>
            <textarea class="aas-textarea" id="aas-sys-prompt"></textarea>
          </div>
          <button class="aas-btn aas-btn-secondary" id="aas-btn-save" style="width:100%;">保存配置</button>
        </div>

        <div>
          <div class="aas-section-title">
            <span>运行日志</span>
            <button class="aas-link-btn" id="aas-btn-clear-log">清空</button>
          </div>
          <div class="aas-log-box" id="aas-log-box"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    uiRefs = {
      fab,
      panel,
      fabDot: document.getElementById('aas-fab-dot'),
      statusBadge: document.getElementById('aas-status-badge'),
      btnStart: document.getElementById('aas-btn-start'),
      btnSingle: document.getElementById('aas-btn-single'),
      btnStop: document.getElementById('aas-btn-stop'),
      statSolved: document.getElementById('aas-stat-solved'),
      statRetries: document.getElementById('aas-stat-retries'),
      statSkipped: document.getElementById('aas-stat-skipped'),
      apiUrl: document.getElementById('aas-api-url'),
      apiKey: document.getElementById('aas-api-key'),
      toggleKey: document.getElementById('aas-toggle-key'),
      model: document.getElementById('aas-model'),
      temp: document.getElementById('aas-temp'),
      maxRetries: document.getElementById('aas-max-retries'),
      timeout: document.getElementById('aas-timeout'),
      delay: document.getElementById('aas-delay'),
      skipMax: document.getElementById('aas-skip-max'),
      autoReload: document.getElementById('aas-auto-reload'),
      sysPrompt: document.getElementById('aas-sys-prompt'),
      btnSave: document.getElementById('aas-btn-save'),
      btnTest: document.getElementById('aas-btn-test'),
      btnResetStats: document.getElementById('aas-btn-reset-stats'),
      btnClearLog: document.getElementById('aas-btn-clear-log'),
      logBox: document.getElementById('aas-log-box'),
    };

    // 回填表单数据
    function syncFormFromConfig() {
      uiRefs.apiUrl.value = config.apiBaseUrl;
      uiRefs.apiKey.value = config.apiKey;
      uiRefs.model.value = config.model;
      uiRefs.temp.value = config.temperature;
      uiRefs.maxRetries.value = config.maxRetries;
      uiRefs.timeout.value = config.submitTimeout;
      uiRefs.delay.value = config.nextProblemDelay;
      uiRefs.skipMax.checked = !!config.skipOnMaxRetries;
      uiRefs.autoReload.checked = !!config.autoContinueAfterReload;
      uiRefs.sysPrompt.value = config.systemPrompt;
    }

    function readFormToConfig() {
      config = {
        ...config,
        apiBaseUrl: uiRefs.apiUrl.value.trim() || DEFAULT_CONFIG.apiBaseUrl,
        apiKey: uiRefs.apiKey.value.trim(),
        model: uiRefs.model.value.trim() || DEFAULT_CONFIG.model,
        temperature: parseFloat(uiRefs.temp.value) || 0,
        maxRetries: Math.max(0, parseInt(uiRefs.maxRetries.value, 10) || 0),
        submitTimeout: Math.max(5000, parseInt(uiRefs.timeout.value, 10) || 20000),
        nextProblemDelay: Math.max(500, parseInt(uiRefs.delay.value, 10) || 2500),
        skipOnMaxRetries: uiRefs.skipMax.checked,
        autoContinueAfterReload: uiRefs.autoReload.checked,
        systemPrompt: uiRefs.sysPrompt.value.trim() || DEFAULT_CONFIG.systemPrompt,
      };
      saveConfig(config);
    }

    syncFormFromConfig();
    updateStatsUI();
    updateControlButtonsUI();

    // 事件绑定
    fab.addEventListener('click', () => {
      panel.classList.toggle('aas-open');
    });

    document.getElementById('aas-close-btn').addEventListener('click', () => {
      panel.classList.remove('aas-open');
    });

    uiRefs.toggleKey.addEventListener('click', () => {
      const isPwd = uiRefs.apiKey.type === 'password';
      uiRefs.apiKey.type = isPwd ? 'text' : 'password';
      uiRefs.toggleKey.textContent = isPwd ? '隐藏' : '显示';
    });

    uiRefs.btnSave.addEventListener('click', () => {
      readFormToConfig();
      addLog('配置已保存', 'success');
    });

    uiRefs.btnTest.addEventListener('click', async () => {
      readFormToConfig();
      addLog('正在测试 API 连接...', 'info');
      try {
        const reply = await callOpenAI([{ role: 'user', content: '请仅回复 OK' }]);
        addLog(`连接成功，模型响应：${reply.trim().slice(0, 50)}`, 'success');
      } catch (err) {
        addLog(`连接测试失败：${err.message}`, 'error');
      }
    });

    uiRefs.btnStart.addEventListener('click', () => {
      readFormToConfig();
      runAutomationLoop({ singleProblemOnly: false });
    });

    uiRefs.btnSingle.addEventListener('click', () => {
      readFormToConfig();
      runAutomationLoop({ singleProblemOnly: true });
    });

    uiRefs.btnStop.addEventListener('click', () => {
      stopAutomation();
    });

    uiRefs.btnResetStats.addEventListener('click', () => {
      runtime.solved = 0;
      runtime.retries = 0;
      runtime.skipped = 0;
      saveRuntimeState(runtime);
      updateStatsUI();
      addLog('统计数据已重置', 'info');
    });

    uiRefs.btnClearLog.addEventListener('click', () => {
      logs.length = 0;
      uiRefs.logBox.innerHTML = '';
    });

    addLog('管理面板已就绪，请配置 API 后点击启动', 'info');
  }

  // ============================================================================
  // 6. 初始化入口
  // ============================================================================

  function init() {
    createManagementUI();
    if (config.autoContinueAfterReload && runtime.running) {
      addLog('检测到上次未结束的连续刷题状态，2 秒后自动恢复...', 'info');
      setTimeout(() => {
        if (!isLoopRunning) {
          runAutomationLoop({ singleProblemOnly: false });
        }
      }, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();