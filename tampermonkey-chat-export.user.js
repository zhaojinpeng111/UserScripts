// ==UserScript==
// @name         Chat Export Sidebar (ChatGPT/Gemini/千问)
// @namespace    https://local.cursor/
// @version      0.1.0
// @description  侧边栏目录定位 + 导出对话 Markdown（复制/下载），参考 ExportGPT
// @author       cursor-agent
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @match        https://tongyi.aliyun.com/*
// @match        https://qianwen.aliyun.com/*
// @match        https://www.qianwen.com/*
// @match        https://qianwen.com/*
// @match        https://chat.qwen.ai/*
// @match        https://*.qwen.ai/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('cexport-root')) return;
  const gm = /** @type {any} */ (globalThis);

  /**
   * @typedef {'user'|'assistant'|'system'|'unknown'} Role
   * @typedef {{collapsed: boolean, pinned: boolean, filter: string, exportMode: 'all'|'from'|'selected', selected: Record<string, boolean>, qianwenMatches: string[]}} AppState
   *
   * @typedef {Object} Message
   * @property {string} id
   * @property {Role} role
   * @property {string} text
   * @property {Element} el
   * @property {number} index
   *
   * @typedef {Object} ConversationMeta
   * @property {string} title
   * @property {string} site
   * @property {string} url
   * @property {string} exportedAtIso
   *
   * @typedef {Object} Adapter
   * @property {string} id
   * @property {string} label
   * @property {() => boolean} canHandle
   * @property {() => string} getTitle
   * @property {() => Element|null} getConversationRoot
   * @property {() => Element[]} getMessageElements
   * @property {(el: Element) => Role} getRole
   * @property {(el: Element) => Element} getContentRoot
   * @property {(el: Element) => void} scrollToMessage
   */

  const STORAGE_KEY = 'chat_export_sidebar_v1';

  /** @returns {AppState} */
  function loadState() {
    /** @type {AppState} */
    const fallback = {
      collapsed: false,
      pinned: true,
      filter: '',
      exportMode: 'all',
      selected: {},
      qianwenMatches: [],
    };
    try {
      const raw = typeof gm.GM_getValue === 'function' ? gm.GM_getValue(STORAGE_KEY, '') : '';
      if (!raw) return fallback;
      const parsed = JSON.parse(String(raw));
      return { ...fallback, ...parsed };
    } catch {
      return fallback;
    }
  }

  /** @param {ReturnType<typeof loadState>} next */
  function saveState(next) {
    try {
      if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  /** @param {string} css */
  function addStyle(css) {
    if (typeof gm.GM_addStyle === 'function') {
      gm.GM_addStyle(css);
      return;
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  /** @param {string} text */
  async function copyToClipboard(text) {
    if (typeof gm.GM_setClipboard === 'function') {
      try {
        gm.GM_setClipboard(text, 'text');
        return;
      } catch {
        // fall through
      }
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // fall through
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error('复制失败：浏览器拒绝写入剪贴板');
  }

  /**
   * @param {string} filename
   * @param {string} content
   */
  function downloadText(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    if (typeof gm.GM_download === 'function') {
      gm.GM_download({ url, name: filename, saveAs: true, onload: () => URL.revokeObjectURL(url), onerror: () => URL.revokeObjectURL(url) });
      return;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** @param {string} s */
  function sanitizeFilename(s) {
    const cleaned = s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    return cleaned || 'chat-export';
  }

  /** @param {string} s */
  function normalizeText(s) {
    return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** @param {Element} el */
  function flashHighlight(el) {
    el.classList.add('cexport-flash');
    window.setTimeout(() => el.classList.remove('cexport-flash'), 1200);
  }

  /** @param {Element} el */
  function scrollToMessageStart(el) {
    const previousScrollMarginTop = /** @type {HTMLElement} */ (el).style.scrollMarginTop;
    /** @type {HTMLElement} */ (el).style.scrollMarginTop = '120px';
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      /** @type {HTMLElement} */ (el).style.scrollMarginTop = previousScrollMarginTop;
    }, 900);
    flashHighlight(el);
  }

  /**
   * 基于 DOM 的 Markdown 转换（尽量保真，遇到复杂组件会降级为纯文本）。
   * @param {Node} node
   * @returns {string}
   */
  function domToMarkdown(node) {
    const out = [];

    /** @param {string} t */
    const push = (t) => out.push(t);

    /** @param {Node} n */
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        push(n.textContent || '');
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {Element} */ (n);

      const tag = el.tagName.toLowerCase();
      if (tag === 'br') {
        push('\n');
        return;
      }

      if (tag === 'pre') {
        const codeEl = el.querySelector('code') || el;
        const code = (codeEl.textContent || '').replace(/\n+$/, '');
        const langFromClass = (() => {
          if (!(codeEl instanceof Element)) return '';
          const cls = codeEl.getAttribute('class') || '';
          const m = cls.match(/language-([a-z0-9_+-]+)/i);
          return (m && m[1]) ? m[1] : '';
        })();
        const langFromAttr = codeEl instanceof Element ? (codeEl.getAttribute('data-language') || '') : '';
        const lang = (langFromAttr || langFromClass || '').trim();
        push('\n\n```' + (lang ? lang : '') + '\n' + code + '\n```\n\n');
        return;
      }

      if (tag === 'code') {
        // inline code (pre 已处理)
        const txt = el.textContent || '';
        push('`' + txt.replace(/`/g, '\\`') + '`');
        return;
      }

      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        const label = el.textContent || href;
        push('[');
        push(label);
        push('](');
        push(href);
        push(')');
        return;
      }

      if (tag === 'strong' || tag === 'b') {
        push('**');
        el.childNodes.forEach(walk);
        push('**');
        return;
      }

      if (tag === 'em' || tag === 'i') {
        push('*');
        el.childNodes.forEach(walk);
        push('*');
        return;
      }

      if (tag === 'blockquote') {
        const inner = normalizeText(Array.from(el.childNodes).map((c) => domToMarkdown(c)).join(''));
        const quoted = inner
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n');
        push('\n\n' + quoted + '\n\n');
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        const isOl = tag === 'ol';
        const items = Array.from(el.querySelectorAll(':scope > li'));
        push('\n');
        items.forEach((li, idx) => {
          const bullet = isOl ? `${idx + 1}. ` : '- ';
          const inner = normalizeText(domToMarkdown(li));
          push(bullet + inner.replace(/\n/g, '\n  ') + '\n');
        });
        push('\n');
        return;
      }

      if (tag === 'li') {
        el.childNodes.forEach(walk);
        return;
      }

      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
        // 作为容器，子节点串起来；p/div 之间用空行更符合阅读
        const beforeLen = out.length;
        el.childNodes.forEach(walk);
        const afterLen = out.length;
        if (tag === 'p' && afterLen > beforeLen) push('\n\n');
        return;
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        const hashes = '#'.repeat(Math.min(6, Math.max(1, level)));
        push('\n\n' + hashes + ' ' + (el.textContent || '').trim() + '\n\n');
        return;
      }

      // fallback: walk children
      el.childNodes.forEach(walk);
    };

    walk(node);
    return normalizeText(out.join(''));
  }

  /** @param {string} markdown */
  function firstContentLine(markdown) {
    return (markdown || '').split('\n').find((line) => line.trim()) || '';
  }

  /** @param {string} markdown */
  function withoutFirstContentLine(markdown) {
    let removed = false;
    return (markdown || '')
      .split('\n')
      .filter((line) => {
        if (!removed && line.trim()) {
          removed = true;
          return false;
        }
        return true;
      })
      .join('\n')
      .trim();
  }

  /**
   * 将内容中的 Markdown 标题整体降级，避免回答里的一级标题和问题一级标题并列。
   * @param {string} markdown
   * @param {number} increment
   */
  function shiftMarkdownHeadings(markdown, increment) {
    let inFence = false;
    return (markdown || '')
      .split('\n')
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          return line;
        }
        if (inFence) return line;

        return line.replace(/^(#{1,6})(\s+.+)$/, (_, hashes, rest) => {
          const level = Math.min(6, hashes.length + increment);
          return '#'.repeat(level) + rest;
        });
      })
      .join('\n')
      .trim();
  }

  /** @param {Message[]} messages */
  function buildMarkdown(meta, messages) {
    const lines = [];
    lines.push(`**对话标题：** ${meta.title}`);
    lines.push(`**来源：** ${meta.site}`);
    lines.push(`**链接：** ${meta.url}`);
    lines.push(`**导出时间：** ${meta.exportedAtIso}`);
    lines.push('');

    const questions = messages.filter((m) => m.role === 'user');
    if (questions.length) {
      lines.push('**目录**');
      questions.forEach((m, idx) => {
        const firstLine = firstContentLine(m.text);
        const title = firstLine.replace(/^#+\s+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(空)';
        lines.push(`- [Q${idx + 1}. ${title}](#q${idx + 1})`);
      });
      lines.push('');
    }

    let questionIndex = 0;
    for (const m of messages) {
      if (m.role === 'user') {
        questionIndex += 1;
        const firstLine = firstContentLine(m.text);
        const questionTitle = firstLine.replace(/^#+\s+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(空)';
        const questionBody = withoutFirstContentLine(m.text);

        lines.push(`<a id="q${questionIndex}"></a>`);
        lines.push('');
        lines.push(`# Q${questionIndex}. ${questionTitle}`);
        lines.push('');
        if (questionBody) {
          lines.push(shiftMarkdownHeadings(questionBody, 1));
          lines.push('');
        }
        continue;
      }

      const text = m.role === 'assistant' ? shiftMarkdownHeadings(m.text, 1) : shiftMarkdownHeadings(m.text || '', 1);
      lines.push(text || '');
      lines.push('');
    }

    return normalizeText(lines.join('\n')) + '\n';
  }

  /** @type {Adapter[]} */
  const adapters = [];
  /** @type {WeakMap<Element, {sourceText: string, markdown: string}>} */
  const markdownCache = new WeakMap();

  /** @returns {Adapter|null} */
  function pickAdapter() {
    for (const a of adapters) if (a.canHandle()) return a;
    return null;
  }

  /**
   * @param {Element} contentRoot
   */
  function getContentSignature(contentRoot) {
    const parts = [contentRoot.textContent || ''];
    contentRoot.querySelectorAll('a[href], code, pre, h1, h2, h3, h4, h5, h6').forEach((el) => {
      parts.push(el.tagName, el.getAttribute('href') || '', el.getAttribute('class') || '', el.getAttribute('data-language') || '');
    });
    return parts.join('\u0001');
  }

  /**
   * @param {Element} messageEl
   * @param {Element} contentRoot
   * @param {boolean} force
   */
  function getMessageMarkdown(messageEl, contentRoot, force = false) {
    const sourceText = getContentSignature(contentRoot);
    const cached = markdownCache.get(messageEl);
    if (!force && cached && cached.sourceText === sourceText) return cached.markdown;

    const markdown = domToMarkdown(contentRoot);
    markdownCache.set(messageEl, { sourceText, markdown });
    return markdown;
  }

  /**
   * @param {Adapter} adapter
   * @param {{forceMarkdown?: boolean}} opts
   */
  function extractMessages(adapter, opts = {}) {
    const els = adapter.getMessageElements();
    /** @type {Message[]} */
    const msgs = [];
    els.forEach((el, index) => {
      const role = adapter.getRole(el);
      const contentRoot = adapter.getContentRoot(el);
      const id = el.getAttribute('data-cexport-id') || `m_${index}_${Math.random().toString(16).slice(2)}`;
      el.setAttribute('data-cexport-id', id);
      const text = getMessageMarkdown(el, contentRoot, !!opts.forceMarkdown);
      msgs.push({ id, role, text, el, index });
    });

    if (msgs.length >= 2 && !msgs.some((m) => m.role === 'user')) {
      msgs.forEach((m, index) => {
        m.role = index % 2 === 0 ? 'user' : 'assistant';
      });
    }

    return msgs;
  }

  /** @param {Element|null} el */
  function isScriptUiElement(el) {
    return Boolean(el && el.closest && el.closest('#cexport-root, #cexport-preview, #cexport-rail-popover'));
  }

  /**
   * @param {string[]} selectors
   * @param {ParentNode} rootNode
   */
  function collectCandidateElements(selectors, rootNode = document) {
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of Array.from(rootNode.querySelectorAll(sel))) {
        if (seen.has(el)) continue;
        if (isScriptUiElement(el)) continue;
        const text = normalizeText(el.textContent || '');
        if (!text || text.length > 40000) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
  }

  /**
   * 从一组候选元素中删除父级大容器，只保留更接近消息内容的节点。
   * @param {Element[]} elements
   */
  function preferLeafMessageElements(elements) {
    return elements.filter((el) => {
      const text = normalizeText(el.textContent || '');
      if (!text) return false;
      const hasCandidateChild = elements.some((other) => other !== el && el.contains(other));
      if (!hasCandidateChild) return true;

      const childTextLength = elements
        .filter((other) => other !== el && el.contains(other))
        .reduce((sum, child) => sum + normalizeText(child.textContent || '').length, 0);
      return childTextLength < text.length * 0.35;
    });
  }

  /** @param {Element} el */
  function getRoleHint(el) {
    const attrs = [
      el.tagName,
      el.id,
      el.className,
      el.getAttribute('data-role'),
      el.getAttribute('data-message-role'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
      el.getAttribute('aria-label'),
      el.getAttribute('role'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/(user|human|query|question|prompt|you|me|mine|用户|提问|问题|我:|我\b)/i.test(attrs)) return 'user';
    if (/(assistant|model|bot|answer|response|markdown|ai|gemini|qwen|tongyi|回答|回复|助手|通义|千问)/i.test(attrs)) return 'assistant';
    return 'unknown';
  }

  // -------------------------
  // Adapters
  // -------------------------

  /** @type {Adapter} */
  const chatgptAdapter = {
    id: 'chatgpt',
    label: 'ChatGPT',
    canHandle: () => /(^|\.)chatgpt\.com$/.test(location.hostname) || /(^|\.)chat\.openai\.com$/.test(location.hostname),
    getTitle: () => {
      const h1 = document.querySelector('main h1');
      const docTitle = document.title || '';
      const t = (h1 && h1.textContent) || docTitle.replace(/\s*-\s*ChatGPT\s*$/i, '');
      return (t || 'ChatGPT 对话').trim();
    },
    getConversationRoot: () => document.querySelector('main'),
    getMessageElements: () => {
      // 1) 优先：角色属性（最稳）
      const byAttr = Array.from(document.querySelectorAll('[data-message-author-role]'));
      if (byAttr.length) return byAttr;

      // 2) 兼容：常见测试 id / turn 容器（站点改版时的兜底）
      const selectors = [
        '[data-testid="conversation-turn"]',
        '[data-testid^="conversation-turn-"]',
        'article[data-testid]',
      ];
      for (const sel of selectors) {
        const found = Array.from(document.querySelectorAll(sel)).filter((el) => (el.textContent || '').trim().length > 0);
        if (found.length >= 2) return found;
      }

      if (!/^\/(?:c|share)\//.test(location.pathname)) return [];

      // 3) 最后兜底：main 内较大的 text 块（可能会包含噪音）
      const main = document.querySelector('main');
      if (!main) return [];
      const candidates = Array.from(main.querySelectorAll('article, section, div')).filter((el) => {
        const t = (el.textContent || '').trim();
        if (!t) return false;
        if (t.length > 20000) return false;
        // 排除侧边栏自身
        if (el.closest && el.closest('#cexport-root')) return false;
        return true;
      });
      return candidates.slice(0, 220);
    },
    getRole: (el) => {
      const raw = el.getAttribute('data-message-author-role');
      if (raw === 'user') return 'user';
      if (raw === 'assistant') return 'assistant';
      if (raw === 'system') return 'system';

      // fallback: 通过 aria-label/标识性文本做弱猜测（不保证）
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('user') || aria.includes('you')) return 'user';
      if (aria.includes('assistant') || aria.includes('chatgpt')) return 'assistant';

      return 'unknown';
    },
    getContentRoot: (el) => {
      const explicitContent = el.querySelector('[data-message-content], [data-testid="message-content"]');
      if (explicitContent) return explicitContent;

      // 若存在多个 markdown 块，返回整条消息容器，避免只导出第一段内容。
      const markdownBlocks = el.querySelectorAll('.markdown');
      return markdownBlocks.length === 1 ? markdownBlocks[0] : el;
    },
    scrollToMessage: (el) => {
      scrollToMessageStart(el);
    },
  };

  /** @type {Adapter} */
  const geminiAdapter = {
    id: 'gemini',
    label: 'Gemini',
    canHandle: () => /(^|\.)gemini\.google\.com$/.test(location.hostname),
    getTitle: () => {
      const titleCandidates = [
        document.querySelector('main h1'),
        document.querySelector('[data-test-id="conversation-title"]'),
        document.querySelector('[data-testid="conversation-title"]'),
        document.querySelector('.conversation-title'),
        document.querySelector('title'),
      ].filter(Boolean);
      const t = titleCandidates.map((n) => (/** @type {Element} */ (n)).textContent || '').find((s) => s.trim());
      return (t || 'Gemini 对话').trim();
    },
    getConversationRoot: () => document.querySelector('main, chat-window, infinite-scroller, .conversation-container') || document.body,
    getMessageElements: () => {
      const selectors = [
        'user-query',
        'model-response',
        '[id^="model-response-message-content"]',
        '.user-query-container',
        '.query-text',
        '.model-response-text',
        '.response-container',
        '.conversation-turn',
        '[data-test-id="conversation-turn"]',
        '[data-testid="conversation-turn"]',
        'conversation-turn',
        'chat-message',
        '[data-role="user"], [data-role="assistant"]',
        '[aria-label*="User" i]',
        '[aria-label*="Gemini" i]',
      ];
      const root = geminiAdapter.getConversationRoot() || document;
      const found = preferLeafMessageElements(collectCandidateElements(selectors, root));
      if (found.length >= 2) return found;

      const fallback = collectCandidateElements([
        'main article',
        'main section',
        'main div[class*="query" i]',
        'main div[class*="response" i]',
        'main div[class*="message" i]',
      ], root).filter((el) => {
        const text = normalizeText(el.textContent || '');
        return text.length > 0 && text.length < 20000;
      });
      return preferLeafMessageElements(fallback).slice(0, 300);
    },
    getRole: (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'user-query' || /user-query|query-text|user-query-container/i.test(el.className.toString())) return 'user';
      if (tag === 'model-response' || /model-response|response-container|model-response-text/i.test(el.className.toString()) || /^model-response-message-content/i.test(el.id)) return 'assistant';

      const roleAttr = el.getAttribute('data-role') || el.getAttribute('role') || '';
      if (/user/i.test(roleAttr)) return 'user';
      if (/assistant|model/i.test(roleAttr)) return 'assistant';

      const aria = el.getAttribute('aria-label') || '';
      if (/you|user/i.test(aria)) return 'user';
      if (/gemini|assistant|model/i.test(aria)) return 'assistant';

      return getRoleHint(el);
    },
    getContentRoot: (el) => {
      const explicitContent = el.querySelector([
        'message-content',
        '[id^="model-response-message-content"]',
        '[data-test-id="message-content"]',
        '[data-testid="message-content"]',
        '.message-content',
        '.model-response-text',
        '.query-text',
        '.markdown',
      ].join(', '));
      if (explicitContent) return explicitContent;

      const markdownBlocks = el.querySelectorAll('.markdown');
      return markdownBlocks.length === 1 ? markdownBlocks[0] : el;
    },
    scrollToMessage: (el) => {
      scrollToMessageStart(el);
    },
  };

  /**
   * 通义千问适配器：
   * - 由于域名/DOM 差异较大，先做成可配置域名匹配 + 通用抽取兜底。
   */
  /** @type {Adapter} */
  const qianwenAdapter = {
    id: 'qianwen',
    label: '通义千问',
    canHandle: () => {
      const state = loadState();
      const host = location.hostname;
      if (/qianwen\.com|qianwen|tongyi|qwen|aliyun/i.test(host)) return true;
      return state.qianwenMatches.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(host);
        } catch {
          return false;
        }
      });
    },
    getTitle: () => {
      const titleNode = document.querySelector('main h1, [class*="conversation-title" i], [class*="chat-title" i], [class*="session-title" i]');
      return ((titleNode && titleNode.textContent) || document.title || '通义千问对话').replace(/\s*[-|]\s*(通义千问|Qwen).*$/i, '').trim();
    },
    getConversationRoot: () => document.querySelector('main, [class*="conversation" i], [class*="chat" i], [class*="message-list" i]') || document.body,
    getMessageElements: () => {
      const selectors = [
        '[data-testid*="message" i]',
        '[data-test-id*="message" i]',
        '[data-message-role]',
        '[data-message-author-role]',
        '[data-role]',
        '[class*="user-message" i]',
        '[class*="assistant-message" i]',
        '[class*="bot-message" i]',
        '[class*="ai-message" i]',
        '[class*="message-item" i]',
        '[class*="messageItem" i]',
        '[class*="chat-item" i]',
        '[class*="chatItem" i]',
        '[class*="question" i]',
        '[class*="answer" i]',
        '[class*="response" i]',
        '[class*="bubble" i]',
        '.message',
        '.chat-message',
        'article',
      ];
      const root = qianwenAdapter.getConversationRoot() || document;
      const found = preferLeafMessageElements(collectCandidateElements(selectors, root));
      if (found.length >= 2) return found.slice(0, 500);

      const fallback = collectCandidateElements([
        'main article',
        'main section',
        'main div[class]',
        '[class*="conversation" i] div[class]',
        '[class*="message-list" i] div[class]',
      ], root).filter((el) => {
        const text = normalizeText(el.textContent || '');
        if (!text || text.length > 20000) return false;
        const className = el.className.toString();
        return /(message|chat|user|assistant|answer|question|response|bubble|item|content|markdown)/i.test(className);
      });
      return preferLeafMessageElements(fallback).slice(0, 400);
    },
    getRole: (el) => {
      const r = [
        el.getAttribute('data-message-role'),
        el.getAttribute('data-message-author-role'),
        el.getAttribute('data-role'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-test-id'),
        el.getAttribute('aria-label'),
        el.className,
      ].filter(Boolean).join(' ').toLowerCase();

      if (/(user|human|question|query|prompt|mine|self|我|用户|提问|问题)/i.test(r)) return 'user';
      if (/(assistant|bot|model|answer|response|ai|qwen|tongyi|assistant-message|回答|回复|助手|通义|千问)/i.test(r)) return 'assistant';
      return getRoleHint(el);
    },
    getContentRoot: (el) => {
      const explicitContent = el.querySelector([
        '[class*="markdown" i]',
        '[class*="content" i]',
        '[class*="message-content" i]',
        '[class*="messageContent" i]',
        '[class*="answer" i]',
        '[class*="response" i]',
        'pre',
      ].join(', '));
      return explicitContent || el;
    },
    scrollToMessage: (el) => {
      scrollToMessageStart(el);
    },
  };

  adapters.push(chatgptAdapter, geminiAdapter, qianwenAdapter);

  // -------------------------
  // UI
  // -------------------------

  addStyle(`
    :root {
      --cexport-bg: rgba(20, 20, 24, 0.92);
      --cexport-fg: rgba(255, 255, 255, 0.92);
      --cexport-muted: rgba(255, 255, 255, 0.66);
      --cexport-border: rgba(255, 255, 255, 0.12);
      --cexport-accent: #7aa2ff;
      --cexport-danger: #ff6b6b;
      --cexport-ok: #2ecc71;
      --cexport-shadow: 0 12px 28px rgba(0,0,0,0.35);
      --cexport-radius: 14px;
      --cexport-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }

    #cexport-root,
    #cexport-preview,
    #cexport-rail-popover {
      --cexport-bg: rgba(20, 20, 24, 0.92);
      --cexport-fg: rgba(255, 255, 255, 0.92);
      --cexport-muted: rgba(255, 255, 255, 0.66);
      --cexport-border: rgba(255, 255, 255, 0.12);
      --cexport-accent: #7aa2ff;
      --cexport-danger: #ff6b6b;
      --cexport-ok: #2ecc71;
      --cexport-shadow: 0 12px 28px rgba(0,0,0,0.35);
      --cexport-radius: 14px;
      --cexport-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }

    #cexport-root.cexport-theme-chatgpt,
    #cexport-preview.cexport-theme-chatgpt,
    #cexport-rail-popover.cexport-theme-chatgpt {
      --cexport-bg: rgba(32, 33, 35, 0.94);
      --cexport-fg: rgba(236, 236, 241, 0.96);
      --cexport-muted: rgba(236, 236, 241, 0.64);
      --cexport-border: rgba(236, 236, 241, 0.13);
      --cexport-accent: #10a37f;
      --cexport-ok: #10a37f;
      --cexport-shadow: 0 14px 34px rgba(0,0,0,0.34);
    }

    #cexport-root.cexport-theme-chatgpt.cexport-light,
    #cexport-preview.cexport-theme-chatgpt.cexport-light,
    #cexport-rail-popover.cexport-theme-chatgpt.cexport-light {
      --cexport-bg: rgba(255, 255, 255, 0.95);
      --cexport-fg: rgba(32, 33, 35, 0.95);
      --cexport-muted: rgba(32, 33, 35, 0.62);
      --cexport-border: rgba(32, 33, 35, 0.12);
      --cexport-accent: #10a37f;
      --cexport-shadow: 0 14px 34px rgba(0,0,0,0.12);
    }

    #cexport-root.cexport-theme-gemini,
    #cexport-preview.cexport-theme-gemini,
    #cexport-rail-popover.cexport-theme-gemini {
      --cexport-bg: rgba(24, 25, 31, 0.94);
      --cexport-fg: rgba(232, 234, 237, 0.96);
      --cexport-muted: rgba(232, 234, 237, 0.64);
      --cexport-border: rgba(138, 180, 248, 0.18);
      --cexport-accent: #8ab4f8;
      --cexport-ok: #81c995;
      --cexport-shadow: 0 14px 34px rgba(60,64,67,0.36);
    }

    #cexport-root.cexport-theme-gemini.cexport-light,
    #cexport-preview.cexport-theme-gemini.cexport-light,
    #cexport-rail-popover.cexport-theme-gemini.cexport-light {
      --cexport-bg: rgba(255, 255, 255, 0.95);
      --cexport-fg: rgba(32, 33, 36, 0.95);
      --cexport-muted: rgba(32, 33, 36, 0.62);
      --cexport-border: rgba(95, 99, 104, 0.18);
      --cexport-accent: #1a73e8;
      --cexport-ok: #188038;
      --cexport-shadow: 0 14px 34px rgba(60,64,67,0.16);
    }

    #cexport-root.cexport-theme-qianwen,
    #cexport-preview.cexport-theme-qianwen,
    #cexport-rail-popover.cexport-theme-qianwen {
      --cexport-bg: rgba(18, 24, 38, 0.94);
      --cexport-fg: rgba(246, 248, 252, 0.96);
      --cexport-muted: rgba(246, 248, 252, 0.64);
      --cexport-border: rgba(255, 140, 66, 0.20);
      --cexport-accent: #ff8a3d;
      --cexport-ok: #3fa7ff;
      --cexport-shadow: 0 14px 34px rgba(10,18,32,0.40);
    }

    #cexport-root.cexport-theme-qianwen.cexport-light,
    #cexport-preview.cexport-theme-qianwen.cexport-light,
    #cexport-rail-popover.cexport-theme-qianwen.cexport-light {
      --cexport-bg: rgba(255, 255, 255, 0.95);
      --cexport-fg: rgba(17, 17, 51, 0.95);
      --cexport-muted: rgba(17, 17, 51, 0.58);
      --cexport-border: rgba(17, 17, 51, 0.12);
      --cexport-accent: #615ced;
      --cexport-ok: #1677ff;
      --cexport-shadow: 0 14px 34px rgba(17,17,51,0.14);
    }

    #cexport-root.cexport-dark,
    #cexport-preview.cexport-dark,
    #cexport-rail-popover.cexport-dark {
      color-scheme: dark;
    }

    #cexport-root.cexport-light,
    #cexport-preview.cexport-light,
    #cexport-rail-popover.cexport-light {
      color-scheme: light;
    }

    #cexport-root.cexport-light #cexport-title strong,
    #cexport-root.cexport-light .cexport-snippet,
    #cexport-root.cexport-light .cexport-label,
    #cexport-preview.cexport-light #cexport-preview-title strong,
    #cexport-preview.cexport-light #cexport-preview-toc-title,
    #cexport-preview.cexport-light .cexport-preview-toc-item,
    #cexport-rail-popover.cexport-light {
      color: var(--cexport-fg);
    }

    #cexport-root.cexport-light #cexport-subtitle,
    #cexport-root.cexport-light #cexport-status,
    #cexport-preview.cexport-light #cexport-preview-subtitle,
    #cexport-preview.cexport-light #cexport-preview-count {
      color: var(--cexport-muted);
    }

    #cexport-root.cexport-light .cexport-btn,
    #cexport-preview.cexport-light .cexport-btn {
      background: rgba(17, 17, 51, 0.045);
      border-color: rgba(17, 17, 51, 0.14);
      color: var(--cexport-fg);
    }

    #cexport-root.cexport-light .cexport-btn:hover,
    #cexport-preview.cexport-light .cexport-btn:hover {
      background: rgba(17, 17, 51, 0.08);
      border-color: color-mix(in srgb, var(--cexport-accent) 55%, rgba(17,17,51,0.18));
    }

    #cexport-root.cexport-light .cexport-rail-item {
      background: color-mix(in srgb, var(--cexport-accent) 28%, #fff);
      border-color: color-mix(in srgb, var(--cexport-accent) 62%, rgba(17,17,51,0.22));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--cexport-accent) 12%, transparent);
    }

    #cexport-root.cexport-light .cexport-rail-item::before {
      background: color-mix(in srgb, var(--cexport-accent) 38%, rgba(17,17,51,0.18));
    }

    #cexport-root.cexport-light .cexport-rail-item:hover,
    #cexport-root.cexport-light .cexport-rail-item.active {
      background: var(--cexport-accent);
      border-color: var(--cexport-accent);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--cexport-accent) 22%, transparent);
    }

    #cexport-preview.cexport-light #cexport-preview-textarea,
    #cexport-root.cexport-light #cexport-filter {
      background: rgba(17, 17, 51, 0.045);
      color: var(--cexport-fg);
      border-color: rgba(17,17,51,0.12);
    }

    #cexport-preview.cexport-light #cexport-preview-toc {
      background: rgba(17, 17, 51, 0.035);
    }

    #cexport-root.cexport-theme-gemini #cexport-header,
    #cexport-preview.cexport-theme-gemini #cexport-preview-header {
      background: linear-gradient(90deg, rgba(66,133,244,0.16), rgba(174,121,255,0.12));
    }

    #cexport-root.cexport-theme-qianwen #cexport-header,
    #cexport-preview.cexport-theme-qianwen #cexport-preview-header {
      background: linear-gradient(90deg, rgba(255,138,61,0.16), rgba(63,167,255,0.10));
    }

    #cexport-root.cexport-theme-chatgpt #cexport-header,
    #cexport-preview.cexport-theme-chatgpt #cexport-preview-header {
      background: linear-gradient(90deg, rgba(16,163,127,0.13), rgba(255,255,255,0.03));
    }

    #cexport-root {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 360px;
      height: calc(100vh - 24px);
      z-index: 2147483646;
      font-family: var(--cexport-font);
      color: var(--cexport-fg);
      background: var(--cexport-bg);
      border: 1px solid var(--cexport-border);
      border-radius: var(--cexport-radius);
      box-shadow: var(--cexport-shadow);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(10px);
      transition: width 0.18s ease, height 0.18s ease, top 0.18s ease, right 0.18s ease, border-radius 0.18s ease, transform 0.18s ease;
    }

    #cexport-root.cexport-collapsed {
      top: 50%;
      right: 10px;
      width: 36px;
      height: auto;
      max-height: calc(100vh - 24px);
      transform: translateY(-50%);
      border-radius: 999px;
      background: var(--cexport-bg);
      border-color: var(--cexport-border);
      box-shadow: var(--cexport-shadow);
    }

    #cexport-root.cexport-collapsed::before {
      display: none;
    }

    #cexport-root.cexport-collapsed #cexport-header,
    #cexport-root.cexport-collapsed #cexport-body,
    #cexport-root.cexport-collapsed #cexport-footer {
      display: none;
      opacity: 0;
      pointer-events: none;
    }

    #cexport-rail {
      display: none;
    }

    #cexport-root.cexport-collapsed #cexport-rail {
      display: flex;
      flex-direction: column;
      height: auto;
      width: 100%;
      min-height: 0;
      overflow: hidden;
      background: transparent;
    }

    #cexport-rail-head {
      margin: 0px auto 0px;
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      color: var(--cexport-accent);
      border-radius: 999px;
    }

    #cexport-rail-head:hover {
      border-color: rgba(122,162,255,0.55);
      background: rgba(122,162,255,0.20);
    }

    #cexport-rail-list {
      flex: 0 1 auto;
      min-height: 0;
      max-height: calc(100vh - 82px);
      overflow: auto;
      padding: 5px 0 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      scrollbar-width: thin;
      position: relative;
      overscroll-behavior: contain;
    }

    .cexport-rail-item {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.10);
      color: var(--cexport-fg);
      border-radius: 999px;
      width: 13px;
      height: 13px;
      min-height: 13px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-family: var(--cexport-font);
      position: relative;
      box-shadow: 0 0 0 3px rgba(255,255,255,0.03);
      transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }

    .cexport-rail-item::before {
      content: "";
      position: absolute;
      left: 50%;
      top: calc(100% + 2px);
      width: 1px;
      height: 12px;
      transform: translateX(-50%);
      background: var(--cexport-border);
      pointer-events: none;
    }

    .cexport-rail-item:last-child::before {
      display: none;
    }

    .cexport-rail-item:hover,
    .cexport-rail-item.active {
      border-color: rgba(122,162,255,0.55);
      background: var(--cexport-accent);
      color: #fff;
      transform: scale(1.22);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--cexport-accent) 22%, transparent);
    }

    #cexport-rail-popover {
      position: fixed;
      z-index: 2147483647;
      display: none;
      max-width: 320px;
      padding: 8px 10px;
      border: 1px solid var(--cexport-border);
      border-radius: 12px;
      color: var(--cexport-fg);
      background: var(--cexport-bg);
      box-shadow: var(--cexport-shadow);
      backdrop-filter: blur(10px);
      font: 12px/1.45 var(--cexport-font);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }

    #cexport-rail-popover.open {
      display: block;
    }

    .cexport-rail-empty {
      writing-mode: vertical-rl;
      margin: auto;
      color: var(--cexport-muted);
      font-size: 12px;
      letter-spacing: 3px;
    }

    #cexport-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--cexport-border);
      user-select: none;
    }

    #cexport-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    #cexport-title strong {
      font-size: 13px;
      letter-spacing: 0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #cexport-subtitle {
      font-size: 12px;
      color: var(--cexport-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cexport-btn {
      appearance: none;
      border: 1px solid var(--cexport-border);
      background: rgba(255,255,255,0.06);
      color: var(--cexport-fg);
      border-radius: 10px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .cexport-btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.18); }
    .cexport-btn:active { background: rgba(255,255,255,0.14); }

    .cexport-icon-btn {
      min-width: 34px;
      height: 32px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .cexport-btn svg {
      width: 16px;
      height: 16px;
      display: block;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }

    .cexport-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    #cexport-body {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      padding: 10px 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .cexport-row { display: flex; gap: 8px; align-items: center; }
    .cexport-row > * { flex: 1; }

    .cexport-mode-row {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 8px;
    }

    .cexport-label {
      font-size: 12px;
      color: var(--cexport-muted);
      white-space: nowrap;
    }

    .cexport-segmented {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }

    .cexport-mode-btn {
      min-width: 0;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .cexport-mode-btn.active,
    .cexport-mode-btn[aria-pressed="true"] {
      color: #fff !important;
      border-color: var(--cexport-accent) !important;
      background: var(--cexport-accent) !important;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--cexport-accent) 18%, transparent);
    }

    .cexport-mode-btn.active svg,
    .cexport-mode-btn[aria-pressed="true"] svg {
      stroke: #fff;
    }

    .cexport-pin-active {
      color: #fff;
      border-color: rgba(122,162,255,0.55);
      background: rgba(122,162,255,0.22);
    }

    #cexport-filter {
      width: 100%;
      flex: 0 0 auto;
      border: 1px solid var(--cexport-border);
      background: rgba(0,0,0,0.18);
      color: var(--cexport-fg);
      border-radius: 10px;
      padding: 8px 10px;
      outline: none;
      font-size: 12px;
    }

    #cexport-list {
      flex: 1;
      min-height: 0;
      border: 1px solid var(--cexport-border);
      border-radius: 12px;
      overflow: auto;
      scrollbar-width: thin;
    }

    #cexport-list-inner {
      min-height: 100%;
    }

    .cexport-item {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border-top: 1px solid rgba(255,255,255,0.06);
      cursor: pointer;
      background: rgba(255,255,255,0.00);
    }
    .cexport-item:first-child { border-top: none; }
    .cexport-item:hover { background: rgba(255,255,255,0.06); }
    .cexport-item.active { background: rgba(122,162,255,0.12); }

    .cexport-tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 6px;
      font-size: 11px;
      border: 1px solid rgba(255,255,255,0.14);
      color: var(--cexport-muted);
      background: rgba(0,0,0,0.18);
    }
    .cexport-tag.user { border-color: rgba(122,162,255,0.35); color: rgba(122,162,255,0.95); }
    .cexport-tag.assistant { border-color: rgba(46,204,113,0.35); color: rgba(46,204,113,0.95); }
    .cexport-tag.unknown { border-color: rgba(255,255,255,0.18); color: rgba(255,255,255,0.75); }

    .cexport-snippet {
      font-size: 12px;
      color: rgba(255,255,255,0.85);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .cexport-check {
      appearance: none;
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      margin: 0;
      border: 1px solid color-mix(in srgb, var(--cexport-accent) 45%, var(--cexport-border));
      border-radius: 6px;
      background: rgba(255,255,255,0.05);
      display: inline-grid;
      place-content: center;
      cursor: pointer;
      transition: background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease, transform 0.12s ease;
    }

    .cexport-check::before {
      content: "";
      width: 9px;
      height: 5px;
      border-left: 2px solid #fff;
      border-bottom: 2px solid #fff;
      transform: rotate(-45deg) scale(0);
      transform-origin: center;
      transition: transform 0.12s ease;
      margin-top: -2px;
    }

    .cexport-check:hover {
      border-color: var(--cexport-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--cexport-accent) 18%, transparent);
    }

    .cexport-check:checked {
      background: var(--cexport-accent);
      border-color: var(--cexport-accent);
    }

    .cexport-check:checked::before {
      transform: rotate(-45deg) scale(1);
    }

    .cexport-check:active {
      transform: scale(0.94);
    }

    #cexport-footer {
      padding: 10px 12px 12px;
      border-top: 1px solid var(--cexport-border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    #cexport-status {
      font-size: 12px;
      color: var(--cexport-muted);
      min-height: 16px;
    }

    #cexport-preview {
      position: fixed;
      inset: 24px;
      z-index: 2147483647;
      display: none;
      align-items: stretch;
      justify-content: center;
      color: var(--cexport-fg);
      font-family: var(--cexport-font);
    }

    #cexport-preview.open {
      display: flex;
    }

    #cexport-preview-backdrop {
      position: absolute;
      inset: -24px;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(2px);
    }

    #cexport-preview-panel {
      position: relative;
      width: min(1280px, calc(100vw - 36px));
      height: min(920px, calc(100vh - 36px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--cexport-bg);
      border: 1px solid var(--cexport-border);
      border-radius: var(--cexport-radius);
      box-shadow: var(--cexport-shadow);
      backdrop-filter: blur(10px);
    }

    #cexport-preview-header,
    #cexport-preview-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--cexport-border);
    }

    #cexport-preview-footer {
      border-top: 1px solid var(--cexport-border);
      border-bottom: 0;
    }

    #cexport-preview-title {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 2px;
    }

    #cexport-preview-title strong {
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #cexport-preview-subtitle,
    #cexport-preview-count {
      font-size: 13px;
      color: var(--cexport-muted);
    }

    #cexport-preview-toc {
      display: none;
      width: 320px;
      min-width: 280px;
      max-width: 380px;
      overflow: auto;
      padding: 12px 14px;
      border-left: 1px solid var(--cexport-border);
      background: rgba(255,255,255,0.035);
    }

    #cexport-preview-toc.open {
      display: block;
    }

    #cexport-preview-toc-title {
      margin-bottom: 10px;
      font-size: 14px;
      font-weight: 700;
      color: var(--cexport-fg);
    }

    #cexport-preview-toc-list {
      display: grid;
      gap: 4px;
    }

    .cexport-preview-toc-item {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--cexport-fg);
      border-radius: 8px;
      padding: 6px 9px;
      text-align: left;
      font-size: 13px;
      line-height: 1.45;
      cursor: pointer;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .cexport-preview-toc-item:hover {
      background: rgba(122,162,255,0.16);
    }

    .cexport-preview-toc-toggle {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      color: var(--cexport-muted);
      font-size: 10px;
      line-height: 1;
    }

    .cexport-preview-toc-toggle.has-children:hover {
      color: var(--cexport-fg);
      background: rgba(255,255,255,0.10);
    }

    .cexport-preview-toc-label {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .cexport-preview-toc-item.level-1 { padding-left: 8px; font-weight: 700; }
    .cexport-preview-toc-item.level-2 { padding-left: 18px; }
    .cexport-preview-toc-item.level-3 { padding-left: 28px; color: rgba(255,255,255,0.82); }
    .cexport-preview-toc-item.level-4 { padding-left: 38px; color: rgba(255,255,255,0.76); }
    .cexport-preview-toc-item.level-5 { padding-left: 48px; color: rgba(255,255,255,0.70); }
    .cexport-preview-toc-item.level-6 { padding-left: 58px; color: rgba(255,255,255,0.66); }

    #cexport-preview-main {
      flex: 1;
      min-height: 0;
      display: flex;
      overflow: hidden;
    }

    #cexport-preview-textarea {
      flex: 1;
      width: 100%;
      min-height: 0;
      resize: none;
      border: 0;
      outline: none;
      padding: 18px;
      color: var(--cexport-fg);
      background: rgba(0,0,0,0.22);
      font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      tab-size: 2;
    }

    .cexport-flash {
      outline: 2px solid var(--cexport-accent);
      outline-offset: 3px;
      border-radius: 8px;
      transition: outline-color 0.2s ease;
    }
  `);

  const state = loadState();

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const THEME_CLASSES = ['cexport-theme-chatgpt', 'cexport-theme-gemini', 'cexport-theme-qianwen'];
  const MODE_CLASSES = ['cexport-light', 'cexport-dark'];

  function detectColorMode() {
    const attrText = [
      document.documentElement.getAttribute('data-theme'),
      document.documentElement.getAttribute('theme'),
      document.documentElement.className,
      document.body && document.body.getAttribute('data-theme'),
      document.body && document.body.className,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/\b(dark|night|黑|暗)\b/.test(attrText)) return 'dark';
    if (/\b(light|day|白|浅)\b/.test(attrText)) return 'light';

    const storageKeys = [
      'theme',
      'color-theme',
      'colorMode',
      'color-mode',
      'qwen-theme',
      'tongyi-theme-preference',
      'gemini-theme',
      'chakra-ui-color-mode',
    ];
    for (const key of storageKeys) {
      try {
        const value = (localStorage.getItem(key) || '').toLowerCase();
        if (value === 'dark' || value === 'night') return 'dark';
        if (value === 'light' || value === 'day') return 'light';
      } catch {
        // ignore inaccessible storage
      }
    }

    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** @param {Adapter|null} adapter */
  function getThemeClass(adapter) {
    const theme = adapter ? `cexport-theme-${adapter.id}` : '';
    return THEME_CLASSES.includes(theme) ? theme : '';
  }

  /**
   * @param {HTMLElement} surface
   * @param {Adapter|null} adapter
   */
  function setSurfaceTheme(surface, adapter) {
    surface.classList.remove(...THEME_CLASSES, ...MODE_CLASSES);
    const theme = getThemeClass(adapter);
    if (theme) surface.classList.add(theme);
    surface.classList.add(`cexport-${detectColorMode()}`);
  }

  /** @param {string} d */
  function svgPath(d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    return path;
  }

  /** @param {string} name */
  function createIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const pathMap = {
      refresh: ['M21 12a9 9 0 0 1-15.3 6.4', 'M3 12A9 9 0 0 1 18.3 5.6', 'M18 2v4h4', 'M6 22v-4H2'],
      collapse: ['M9 6l6 6-6 6', 'M20 4v16'],
      expand: ['M15 6l-6 6 6 6', 'M4 4v16'],
      all: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      from: ['M5 5h14', 'M12 5v14', 'M8 15l4 4 4-4'],
      selected: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
      autoload: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
      copy: ['M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
      download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
      pin: ['M12 17v5', 'M5 17h14', 'M7 17l2-8', 'M15 9l2 8', 'M8 9h8', 'M9 2h6l1 7H8l1-7z'],
      unpin: ['M12 17v5', 'M5 17h14', 'M7 17l2-8', 'M15 9l2 8', 'M8 9h8', 'M9 2h6l1 7H8l1-7z', 'M3 3l18 18'],
    };

    if (name === 'stop') {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', '6');
      rect.setAttribute('y', '6');
      rect.setAttribute('width', '12');
      rect.setAttribute('height', '12');
      rect.setAttribute('rx', '2');
      svg.appendChild(rect);
      return svg;
    }

    if (name === 'copy') {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', '9');
      rect.setAttribute('y', '9');
      rect.setAttribute('width', '13');
      rect.setAttribute('height', '13');
      rect.setAttribute('rx', '2');
      svg.appendChild(rect);
    }

    for (const d of pathMap[name] || []) svg.appendChild(svgPath(d));
    return svg;
  }

  /**
   * @param {HTMLElement} target
   * @param {string} name
   * @param {string} label
   */
  function setIconWithLabel(target, name, label) {
    const sr = document.createElement('span');
    sr.className = 'cexport-sr-only';
    sr.textContent = label;
    target.replaceChildren(createIcon(name), sr);
  }

  /**
   * @param {string} tag
   * @param {{id?: string, className?: string, text?: string, title?: string, ariaLabel?: string, type?: string, disabled?: boolean, attrs?: Record<string, string>}} opts
   */
  function makeEl(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.id) node.id = opts.id;
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.title) node.setAttribute('title', opts.title);
    if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel);
    if (opts.type && node instanceof HTMLButtonElement) node.setAttribute('type', opts.type);
    if (opts.disabled && node instanceof HTMLButtonElement) node.disabled = true;
    for (const [key, value] of Object.entries(opts.attrs || {})) node.setAttribute(key, value);
    return node;
  }

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} ariaLabel
   * @param {string} iconName
   * @param {string} srLabel
   */
  function makeIconButton(id, title, ariaLabel, iconName, srLabel) {
    const btn = /** @type {HTMLButtonElement} */ (makeEl('button', { id, className: 'cexport-btn cexport-icon-btn', title, ariaLabel, type: 'button' }));
    setIconWithLabel(btn, iconName, srLabel);
    return btn;
  }

  const initialAdapter = pickAdapter();
  const root = document.createElement('div');
  root.id = 'cexport-root';
  if (state.collapsed) root.classList.add('cexport-collapsed');
  setSurfaceTheme(root, initialAdapter);

  const rail = makeEl('div', { id: 'cexport-rail', ariaLabel: '折叠目录' });
  rail.appendChild(makeIconButton('cexport-rail-head', '点击展开完整面板', '点击展开完整面板', 'expand', '展开'));
  rail.appendChild(makeEl('div', { id: 'cexport-rail-list' }));

  const header = makeEl('div', { id: 'cexport-header' });
  const titleWrap = makeEl('div', { id: 'cexport-title' });
  titleWrap.appendChild(makeEl('strong', { id: 'cexport-title-text', text: '导出对话' }));
  titleWrap.appendChild(makeEl('div', { id: 'cexport-subtitle', text: '初始化中…' }));
  const headerActions = makeEl('div');
  headerActions.style.display = 'flex';
  headerActions.style.gap = '8px';
  headerActions.style.alignItems = 'center';
  headerActions.appendChild(makeIconButton('cexport-refresh', '重新扫描消息', '重新扫描消息', 'refresh', '刷新'));
  headerActions.appendChild(makeIconButton('cexport-pin', '固定展开', '固定展开', 'pin', '固定展开'));
  headerActions.appendChild(makeIconButton('cexport-toggle', '折叠/展开', '折叠或固定展开', 'collapse', '折叠'));
  header.append(titleWrap, headerActions);

  const body = makeEl('div', { id: 'cexport-body' });
  const filterInput = /** @type {HTMLInputElement} */ (makeEl('input', { id: 'cexport-filter', attrs: { placeholder: '搜索目录（包含匹配）' } }));
  const modeRow = makeEl('div', { className: 'cexport-mode-row' });
  modeRow.appendChild(makeEl('span', { className: 'cexport-label', text: '导出方式' }));
  const segmented = makeEl('div', { className: 'cexport-segmented', ariaLabel: '导出方式' });
  const modeAll = /** @type {HTMLButtonElement} */ (makeEl('button', { className: 'cexport-btn cexport-mode-btn', title: '导出当前已识别到的全部消息', ariaLabel: '导出全部消息', type: 'button', attrs: { 'data-mode': 'all' } }));
  setIconWithLabel(modeAll, 'all', '全部');
  const modeFrom = /** @type {HTMLButtonElement} */ (makeEl('button', { className: 'cexport-btn cexport-mode-btn', title: '从你最近点击定位的目录项开始，导出后续消息', ariaLabel: '从当前定位开始导出', type: 'button', attrs: { 'data-mode': 'from' } }));
  setIconWithLabel(modeFrom, 'from', '从当前');
  const modeSelected = /** @type {HTMLButtonElement} */ (makeEl('button', { className: 'cexport-btn cexport-mode-btn', title: '只导出目录右侧复选框已勾选的消息', ariaLabel: '导出勾选消息', type: 'button', attrs: { 'data-mode': 'selected' } }));
  setIconWithLabel(modeSelected, 'selected', '勾选');
  segmented.append(modeAll, modeFrom, modeSelected);
  modeRow.appendChild(segmented);
  body.append(filterInput, modeRow, makeEl('div', { id: 'cexport-list' }));

  const footer = makeEl('div', { id: 'cexport-footer' });
  const footerRow1 = makeEl('div', { className: 'cexport-row' });
  footerRow1.append(
    makeEl('button', { id: 'cexport-autoload', className: 'cexport-btn', text: '自动加载', title: '尝试自动滚动加载更多历史消息（站点不同可能效果有限）', ariaLabel: '自动加载更多', type: 'button' }),
    makeEl('button', { id: 'cexport-cancel', className: 'cexport-btn', text: '停止', title: '停止自动加载', ariaLabel: '停止自动加载', type: 'button', disabled: true }),
  );
  const footerRow2 = makeEl('div', { className: 'cexport-row' });
  footerRow2.appendChild(makeEl('button', { id: 'cexport-export', className: 'cexport-btn', text: '导出', title: '预览并编辑 Markdown，然后在预览界面复制或导出文件', ariaLabel: '导出', type: 'button' }));
  footer.append(footerRow1, footerRow2, makeEl('div', { id: 'cexport-status' }));
  root.append(rail, header, body, footer);

  document.documentElement.appendChild(root);

  const railPopover = document.createElement('div');
  railPopover.id = 'cexport-rail-popover';
  setSurfaceTheme(railPopover, initialAdapter);
  document.documentElement.appendChild(railPopover);

  const previewRoot = document.createElement('div');
  previewRoot.id = 'cexport-preview';
  setSurfaceTheme(previewRoot, initialAdapter);
  const previewBackdrop = makeEl('div', { id: 'cexport-preview-backdrop' });
  const previewPanel = makeEl('div', { id: 'cexport-preview-panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cexport-preview-heading' } });
  const previewHeader = makeEl('div', { id: 'cexport-preview-header' });
  const previewTitle = makeEl('div', { id: 'cexport-preview-title' });
  previewTitle.append(makeEl('strong', { id: 'cexport-preview-heading', text: '预览并编辑 Markdown' }), makeEl('span', { id: 'cexport-preview-subtitle', text: '复制/导出会使用编辑后的内容' }));
  previewHeader.append(previewTitle, makeIconButton('cexport-preview-close', '关闭预览', '关闭预览', 'collapse', '关闭'));
  const previewMain = makeEl('div', { id: 'cexport-preview-main' });
  const previewTextareaNode = /** @type {HTMLTextAreaElement} */ (makeEl('textarea', { id: 'cexport-preview-textarea', attrs: { spellcheck: 'false' } }));
  const previewToc = makeEl('div', { id: 'cexport-preview-toc', ariaLabel: 'Markdown 目录' });
  previewToc.append(makeEl('div', { id: 'cexport-preview-toc-title', text: 'Markdown 目录' }), makeEl('div', { id: 'cexport-preview-toc-list' }));
  previewMain.append(previewTextareaNode, previewToc);
  const previewFooter = makeEl('div', { id: 'cexport-preview-footer' });
  const previewActions = makeEl('div');
  previewActions.style.display = 'flex';
  previewActions.style.gap = '8px';
  previewActions.style.alignItems = 'center';
  previewActions.append(
    makeEl('button', { id: 'cexport-preview-copy', className: 'cexport-btn', text: '复制编辑内容', title: '复制当前编辑框里的 Markdown', type: 'button' }),
    makeEl('button', { id: 'cexport-preview-download', className: 'cexport-btn', text: '导出编辑内容', title: '下载当前编辑框里的 Markdown', type: 'button' }),
  );
  previewFooter.append(makeEl('span', { id: 'cexport-preview-count' }), previewActions);
  previewPanel.append(previewHeader, previewMain, previewFooter);
  previewRoot.append(previewBackdrop, previewPanel);
  document.documentElement.appendChild(previewRoot);

  const $ = (sel) => /** @type {HTMLElement} */ (root.querySelector(sel));
  const $preview = (sel) => /** @type {HTMLElement} */ (previewRoot.querySelector(sel));
  const subtitleEl = $('#cexport-subtitle');
  const statusEl = $('#cexport-status');
  const listEl = $('#cexport-list');
  const railHeadEl = $('#cexport-rail-head');
  const railListEl = $('#cexport-rail-list');
  const titleEl = /** @type {HTMLElement} */ ($('#cexport-title-text'));
  const filterEl = /** @type {HTMLInputElement} */ ($('#cexport-filter'));
  const modeButtons = Array.from(root.querySelectorAll('.cexport-mode-btn'));
  const previewTextarea = /** @type {HTMLTextAreaElement} */ ($preview('#cexport-preview-textarea'));
  const previewTocEl = $preview('#cexport-preview-toc');
  const previewTocListEl = $preview('#cexport-preview-toc-list');

  filterEl.value = state.filter;

  /** @param {Adapter|null} adapter */
  function applySiteTheme(adapter) {
    setSurfaceTheme(root, adapter);
    setSurfaceTheme(previewRoot, adapter);
    setSurfaceTheme(railPopover, adapter);
  }

  function updateToggleButton() {
    const toggle = $('#cexport-toggle');
    const label = state.collapsed ? '固定展开' : '折叠到右侧';
    setIconWithLabel(toggle, state.collapsed ? 'expand' : 'collapse', label);
    toggle.setAttribute('title', label);
    toggle.setAttribute('aria-label', label);
  }

  function updatePinButton() {
    const pin = $('#cexport-pin');
    const label = state.pinned ? '已固定：展开后不会自动折叠，点击可取消固定' : '未固定：鼠标离开展开面板后自动折叠，点击可固定';
    setIconWithLabel(pin, state.pinned ? 'pin' : 'unpin', label);
    pin.classList.toggle('cexport-pin-active', state.pinned);
    pin.setAttribute('title', label);
    pin.setAttribute('aria-label', label);
    pin.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
  }

  updateToggleButton();
  updatePinButton();

  /** @param {unknown} mode */
  function normalizeExportMode(mode) {
    return mode === 'from' || mode === 'selected' || mode === 'all' ? mode : 'all';
  }

  /** @param {'all'|'from'|'selected'} mode */
  function setExportMode(mode) {
    const normalizedMode = normalizeExportMode(mode);
    state.exportMode = normalizedMode;
    modeButtons.forEach((btn) => {
      const active = btn.getAttribute('data-mode') === normalizedMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.setAttribute('data-active', active ? 'true' : 'false');
    });
    saveState(state);
  }

  setExportMode(normalizeExportMode(state.exportMode));

  /** @type {{adapter: Adapter|null, messages: Message[], activeIndex: number, lastUrl: string, lastTitle: string, lastDirectorySignature: string}} */
  const ctx = { adapter: null, messages: [], activeIndex: -1, lastUrl: location.href, lastTitle: document.title, lastDirectorySignature: '' };
  /** @type {number|undefined} */
  let autoCollapseTimer;

  function collapsePanel() {
    state.collapsed = true;
    root.classList.add('cexport-collapsed');
    updateToggleButton();
    saveState(state);
  }

  function expandPanel() {
    state.collapsed = false;
    root.classList.remove('cexport-collapsed');
    updateToggleButton();
    saveState(state);
  }

  /** @param {string} s */
  function setStatus(s) {
    statusEl.textContent = s;
  }

  function syncHeader() {
    const a = ctx.adapter;
    const site = a ? a.label : '未识别站点';
    subtitleEl.textContent = `${site} · 已识别 ${ctx.messages.length} 条消息`;
    if (a) titleEl.textContent = a.getTitle() || '导出对话';
  }

  /** @param {Message} m */
  function messageSnippet(m) {
    const firstLine = (m.text || '').split('\n').find((l) => l.trim()) || '';
    const clean = firstLine.replace(/^#+\s+/g, '').trim();
    return clean.slice(0, 80) || '(空)';
  }

  function getDirectoryEntries() {
    return ctx.messages
      .filter((m) => m.role === 'user')
      .map((message, questionIndex) => ({ message, questionIndex }));
  }

  /** @param {Message[]} messages */
  function getDirectorySignature(messages) {
    return messages
      .filter((m) => m.role === 'user')
      .map((m) => `${m.index}:${messageSnippet(m)}`)
      .join('|');
  }

  /** @param {Message} question */
  function getQuestionSegmentMessages(question) {
    const start = question.index;
    const nextQuestion = ctx.messages.find((m) => m.index > start && m.role === 'user');
    const end = nextQuestion ? nextQuestion.index : Infinity;
    return ctx.messages.filter((m) => m.index >= start && m.index < end);
  }

  function getSelectedQuestionSegmentMessages() {
    const picked = [];
    const seen = new Set();

    for (const { message } of getDirectoryEntries()) {
      if (!state.selected[message.id]) continue;
      for (const segmentMessage of getQuestionSegmentMessages(message)) {
        if (seen.has(segmentMessage.id)) continue;
        seen.add(segmentMessage.id);
        picked.push(segmentMessage);
      }
    }

    return picked.sort((a, b) => a.index - b.index);
  }

  function syncActiveMarkers() {
    const active = ctx.messages.find((m) => m.index === ctx.activeIndex);
    const activeId = active ? active.id : '';
    root.querySelectorAll('.cexport-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-id') === activeId);
    });
    railListEl.querySelectorAll('.cexport-rail-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-id') === activeId);
    });
  }

  /** @param {Message} message */
  function setActiveMessage(message) {
    if (ctx.activeIndex === message.index) return;
    ctx.activeIndex = message.index;
    syncActiveMarkers();
  }

  let suppressScrollActiveUntil = 0;
  function suppressScrollActiveSync() {
    suppressScrollActiveUntil = Date.now() + 1200;
  }

  function updateActiveFromViewport() {
    if (Date.now() < suppressScrollActiveUntil) return;
    const questions = getDirectoryEntries();
    if (!questions.length) return;

    const anchorY = Math.min(Math.max(window.innerHeight * 0.28, 120), 260);
    let best = null;
    for (const { message } of questions) {
      const rect = message.el.getBoundingClientRect();
      if (rect.bottom < 0) continue;
      if (rect.top <= anchorY) {
        best = message;
        continue;
      }
      if (!best) best = message;
      break;
    }
    if (!best) best = questions[questions.length - 1].message;
    if (best) setActiveMessage(best);
  }

  /** @type {number|undefined} */
  let activeScrollFrame;
  function scheduleActiveFromViewport() {
    if (activeScrollFrame) return;
    activeScrollFrame = window.requestAnimationFrame(() => {
      activeScrollFrame = undefined;
      updateActiveFromViewport();
    });
  }

  function renderList() {
    const filter = (filterEl.value || '').toLowerCase();
    listEl.replaceChildren();

    const wrap = document.createElement('div');
    wrap.id = 'cexport-list-inner';

    const shown = getDirectoryEntries().filter(({ message }) => {
      if (!filter) return true;
      return messageSnippet(message).toLowerCase().includes(filter);
    });

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.style.padding = '10px';
      empty.style.color = 'rgba(255,255,255,0.66)';
      empty.style.fontSize = '12px';
      empty.textContent = '未匹配到问题目录项（试试清空搜索，或等待消息角色识别完成）。';
      listEl.appendChild(empty);
      renderRail();
      return;
    }

    for (const { message: m, questionIndex } of shown) {
      const item = document.createElement('div');
      item.className = 'cexport-item' + (ctx.activeIndex === m.index ? ' active' : '');
      item.setAttribute('data-id', m.id);

      const tag = document.createElement('span');
      tag.className = `cexport-tag ${m.role}`;
      tag.textContent = 'Q';

      const snip = document.createElement('div');
      snip.className = 'cexport-snippet';
      snip.textContent = `Q${questionIndex + 1}. ${messageSnippet(m)}`;

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'cexport-check';
      chk.checked = !!state.selected[m.id];
      chk.title = '勾选后会导出该问题及其回答';
      chk.setAttribute('aria-label', `勾选 Q${questionIndex + 1} 及其回答`);
      chk.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.selected[m.id] = chk.checked;
        saveState(state);
      });

      item.appendChild(tag);
      item.appendChild(snip);
      item.appendChild(chk);

      item.addEventListener('click', () => {
        setActiveMessage(m);
        suppressScrollActiveSync();
        if (ctx.adapter) ctx.adapter.scrollToMessage(m.el);
        setStatus(`已定位到第 ${m.index + 1} 条消息。`);
      });

      wrap.appendChild(item);
    }

    listEl.appendChild(wrap);
    renderRail();
  }

  function renderRail() {
    railListEl.replaceChildren();

    const questions = getDirectoryEntries();

    if (!questions.length) {
      const empty = document.createElement('div');
      empty.className = 'cexport-rail-empty';
      empty.textContent = '问题';
      railListEl.appendChild(empty);
      return;
    }

    for (const { message: m, questionIndex } of questions) {
      const btn = document.createElement('button');
      btn.className = 'cexport-rail-item' + (ctx.activeIndex === m.index ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('data-id', m.id);
      const preview = `Q${questionIndex + 1}. ${messageSnippet(m)}`;
      btn.dataset.preview = preview;
      btn.setAttribute('aria-label', `跳转到第 ${questionIndex + 1} 个问题`);
      btn.addEventListener('mouseenter', () => {
        const rect = btn.getBoundingClientRect();
        railPopover.textContent = preview;
        railPopover.classList.add('open');
        const popoverWidth = Math.min(320, Math.max(180, preview.length * 7 + 28));
        railPopover.style.width = `${popoverWidth}px`;
        railPopover.style.left = `${Math.max(12, rect.left - popoverWidth - 12)}px`;
        railPopover.style.top = `${Math.max(12, Math.min(window.innerHeight - 48, rect.top + rect.height / 2 - 18))}px`;
      });
      btn.addEventListener('mouseleave', () => {
        railPopover.classList.remove('open');
      });
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        railPopover.classList.remove('open');
        setActiveMessage(m);
        suppressScrollActiveSync();
        if (ctx.adapter) ctx.adapter.scrollToMessage(m.el);
        setStatus(`已定位到第 ${m.index + 1} 条消息。`);
      });

      railListEl.appendChild(btn);
    }
  }

  /** @param {{silent?: boolean, reason?: string}} opts */
  function refresh(opts = {}) {
    const beforeCount = ctx.messages.length;
    ctx.adapter = pickAdapter();
    applySiteTheme(ctx.adapter);
    if (!ctx.adapter) {
      ctx.messages = [];
      ctx.activeIndex = -1;
      syncHeader();
      renderList();
      if (!opts.silent) setStatus('未识别当前站点：仅支持 ChatGPT/Gemini/通义千问（需配置域名）。');
      return;
    }

    try {
      ctx.messages = extractMessages(ctx.adapter);
      ctx.lastUrl = location.href;
      ctx.lastTitle = document.title;
      const beforeDirectorySignature = ctx.lastDirectorySignature;
      ctx.lastDirectorySignature = getDirectorySignature(ctx.messages);
      const changed = beforeCount !== ctx.messages.length || beforeDirectorySignature !== ctx.lastDirectorySignature || opts.reason === 'route';
      if (opts.silent && !changed) return;

      syncHeader();
      renderList();
      updateActiveFromViewport();
      if (opts.silent) {
        setStatus(`目录已自动更新（${ctx.messages.length} 条）。`);
      } else {
        setStatus('就绪。若导出不完整，请先滚动加载更多历史消息后再刷新。');
      }
    } catch (e) {
      ctx.messages = [];
      ctx.activeIndex = -1;
      syncHeader();
      renderList();
      setStatus(`扫描失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** @type {number|undefined} */
  let refreshTimer;

  /**
   * 页面流式输出时 DOM 会频繁变化；这里延迟合并刷新，避免目录闪烁。
   * @param {string} reason
   * @param {number} delayMs
   */
  function scheduleRefresh(reason = 'mutation', delayMs = 900) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refresh({ silent: true, reason }), delayMs);
  }

  function refreshIfDirectoryChanged() {
    const adapter = pickAdapter();
    if (!adapter) return;
    applySiteTheme(adapter);
    try {
      const messages = extractMessages(adapter);
      const signature = getDirectorySignature(messages);
      if (signature && signature !== ctx.lastDirectorySignature) {
        ctx.adapter = adapter;
        ctx.messages = messages;
        ctx.lastDirectorySignature = signature;
        ctx.lastUrl = location.href;
        ctx.lastTitle = document.title;
        syncHeader();
        renderList();
        updateActiveFromViewport();
        setStatus(`目录已自动更新（${ctx.messages.filter((m) => m.role === 'user').length} 轮对话）。`);
      }
    } catch {
      // ignore auto refresh probe failures
    }
  }

  /** @param {MutationRecord[]} mutations */
  function hasExternalConversationMutation(mutations) {
    return mutations.some((m) => {
      const target = /** @type {Element|null} */ (m.target && m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement);
      if (target && target.closest && target.closest('#cexport-root')) return false;
      if (target && target.closest && target.closest('#cexport-preview')) return false;
      return true;
    });
  }

  function startAutoRefresh() {
    const themeObserver = new MutationObserver(() => applySiteTheme(ctx.adapter || pickAdapter()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'theme'] });
    if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'theme'] });

    const observer = new MutationObserver((mutations) => {
      if (!hasExternalConversationMutation(mutations)) return;
      scheduleRefresh('mutation', 1200);
      scheduleActiveFromViewport();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const onRouteChange = () => scheduleRefresh('route', 450);
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      onRouteChange();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      onRouteChange();
      return result;
    };
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('scroll', scheduleActiveFromViewport, { passive: true });
    document.addEventListener('scroll', scheduleActiveFromViewport, { passive: true, capture: true });

    document.addEventListener('click', (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (target && target.closest('#cexport-root, #cexport-preview')) return;
      const maybeSubmit = target && target.closest('button, [role="button"], [aria-label], [data-testid]');
      if (maybeSubmit) {
        const text = `${maybeSubmit.textContent || ''} ${maybeSubmit.getAttribute('aria-label') || ''} ${maybeSubmit.getAttribute('data-testid') || ''}`;
        if (/send|submit|发送|提交|arrow|composer/i.test(text)) scheduleRefresh('submit', 900);
      }
    }, true);

    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target || target.closest('#cexport-root, #cexport-preview')) return;
      if (target.closest('textarea, [contenteditable="true"], [role="textbox"]')) scheduleRefresh('enter-submit', 900);
    }, true);

    window.setInterval(() => {
      if (location.href !== ctx.lastUrl || document.title !== ctx.lastTitle) {
        scheduleRefresh('route', 450);
        return;
      }
      refreshIfDirectoryChanged();
    }, 1800);
  }

  /** @type {{filename: string, turnCount: number}|null} */
  let previewExportState = null;
  const previewTocCollapsed = new Set();

  /** @param {string} markdown */
  function getMarkdownTocItems(markdown) {
    const items = [];
    const lines = markdown.split('\n');
    let offset = 0;
    /** @type {string[]} */
    const pathByLevel = [];
    /** @type {Record<string, number>} */
    const seenKeys = {};

    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) {
        const level = match[1].length;
        const label = match[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '').trim();
        if (label) {
          pathByLevel[level - 1] = label;
          pathByLevel.length = level;
          const baseKey = pathByLevel.join(' / ');
          seenKeys[baseKey] = (seenKeys[baseKey] || 0) + 1;
          const key = `${baseKey}#${seenKeys[baseKey]}`;
          items.push({ level, label, offset, key });
        }
      }
      offset += line.length + 1;
    }

    return items;
  }

  /** @param {{level: number, label: string, offset: number, key: string}[]} tocItems */
  function renderPreviewToc(tocItems) {
    previewTocListEl.replaceChildren();
    previewTocEl.classList.toggle('open', tocItems.length > 0);

    /** @type {{level: number, key: string}[]} */
    const stack = [];

    tocItems.forEach((item, idx) => {
      while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
      const hiddenByAncestor = stack.some((ancestor) => previewTocCollapsed.has(ancestor.key));
      const hasChildren = Boolean(tocItems[idx + 1] && tocItems[idx + 1].level > item.level);

      stack.push({ level: item.level, key: item.key });
      if (hiddenByAncestor) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cexport-preview-toc-item level-${item.level}`;
      btn.title = item.label;

      const toggle = document.createElement('span');
      toggle.className = 'cexport-preview-toc-toggle' + (hasChildren ? ' has-children' : '');
      toggle.textContent = hasChildren ? (previewTocCollapsed.has(item.key) ? '▸' : '▾') : '';
      toggle.title = hasChildren ? (previewTocCollapsed.has(item.key) ? '展开下级目录' : '折叠下级目录') : '';
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!hasChildren) return;
        if (previewTocCollapsed.has(item.key)) previewTocCollapsed.delete(item.key);
        else previewTocCollapsed.add(item.key);
        renderPreviewToc(getMarkdownTocItems(previewTextarea.value));
      });

      const label = document.createElement('span');
      label.className = 'cexport-preview-toc-label';
      label.textContent = item.label;

      btn.appendChild(toggle);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        previewTextarea.focus();
        previewTextarea.setSelectionRange(item.offset, item.offset);
        previewTextarea.scrollTop = Math.max(0, (item.offset / Math.max(1, previewTextarea.value.length)) * previewTextarea.scrollHeight - 80);
      });
      previewTocListEl.appendChild(btn);
    });
  }

  /**
   * @param {{markdown: string, filename: string, turnCount: number}} data
   */
  function openMarkdownPreview(data) {
    previewExportState = { filename: data.filename, turnCount: data.turnCount };
    previewTextarea.value = data.markdown;
    renderPreviewToc(getMarkdownTocItems(data.markdown));
    $preview('#cexport-preview-count').textContent = `${data.turnCount} 轮对话 · ${data.markdown.length.toLocaleString()} 字符`;
    $preview('#cexport-preview-heading').textContent = '预览并编辑 Markdown';
    previewRoot.classList.add('open');
    window.setTimeout(() => previewTextarea.focus(), 0);
  }

  function closeMarkdownPreview() {
    previewRoot.classList.remove('open');
  }

  async function copyEditedMarkdown() {
    if (!previewExportState) return;
    try {
      await copyToClipboard(previewTextarea.value);
      setStatus(`已复制编辑后的 Markdown（${previewExportState.turnCount} 轮对话）。`);
      closeMarkdownPreview();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '复制失败：请手动全选编辑框内容复制。');
      previewTextarea.focus();
      previewTextarea.select();
    }
  }

  function downloadEditedMarkdown() {
    if (!previewExportState) return;
    downloadText(previewExportState.filename, previewTextarea.value);
    setStatus(`已触发下载编辑后的 Markdown（${previewExportState.turnCount} 轮对话）。`);
    closeMarkdownPreview();
  }

  function refreshForExport() {
    ctx.adapter = pickAdapter();
    applySiteTheme(ctx.adapter);
    if (!ctx.adapter) return false;
    ctx.messages = extractMessages(ctx.adapter, { forceMarkdown: true });
    ctx.lastUrl = location.href;
    ctx.lastTitle = document.title;
    ctx.lastDirectorySignature = getDirectorySignature(ctx.messages);
    syncHeader();
    renderList();
    return true;
  }

  async function doExport() {
    if (!refreshForExport() || !ctx.adapter) {
      setStatus('无法导出：未识别站点。');
      return;
    }

    /** @type {Message[]} */
    let picked = [];
    const mode = state.exportMode;

    if (mode === 'all') {
      picked = ctx.messages;
    } else if (mode === 'from') {
      const start = ctx.activeIndex >= 0 ? ctx.activeIndex : 0;
      picked = ctx.messages.filter((m) => m.index >= start);
    } else {
      picked = getSelectedQuestionSegmentMessages();
    }

    if (!picked.length) {
      setStatus('没有可导出的消息（检查导出范围或先刷新）。');
      return;
    }

    const meta = /** @type {ConversationMeta} */ ({
      title: ctx.adapter.getTitle(),
      site: ctx.adapter.label,
      url: location.href,
      exportedAtIso: new Date().toISOString(),
    });

    const md = buildMarkdown(meta, picked);

    const name = sanitizeFilename(meta.title);
    const date = new Date().toISOString().slice(0, 10);
    openMarkdownPreview({
      markdown: md,
      filename: `${name}.${date}.md`,
      turnCount: picked.filter((m) => m.role === 'user').length,
    });
  }

  /** @param {{maxRounds?: number, settleMs?: number}} opts */
  async function autoLoadMore(opts = {}) {
    if (!ctx.adapter) {
      setStatus('无法自动加载：未识别站点。');
      return;
    }

    const maxRounds = Math.max(1, Math.min(50, opts.maxRounds ?? 16));
    const settleMs = Math.max(250, Math.min(4000, opts.settleMs ?? 850));

    let cancelled = false;
    const cancelBtn = $('#cexport-cancel');
    const autoBtn = $('#cexport-autoload');

    cancelBtn.removeAttribute('disabled');
    autoBtn.setAttribute('disabled', 'true');

    const onCancel = () => {
      cancelled = true;
      setStatus('已停止自动加载。');
    };
    cancelBtn.addEventListener('click', onCancel, { once: true });

    // 起点：尽量滚到顶部触发“向上加载历史”
    let lastCount = ctx.messages.length;
    for (let round = 1; round <= maxRounds; round++) {
      if (cancelled) break;
      setStatus(`自动加载中…（${round}/${maxRounds}）当前已识别 ${lastCount} 条，正在尝试加载更多历史…`);

      // 优先滚动对话根容器；失败则滚动页面
      const rootEl = ctx.adapter.getConversationRoot();
      if (rootEl && 'scrollTop' in rootEl) {
        try {
          rootEl.scrollTop = 0;
        } catch {
          // ignore
        }
      }
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, 0);
      }

      await new Promise((r) => window.setTimeout(r, settleMs));

      // 刷新一次看看数量是否增长
      const prev = lastCount;
      try {
        ctx.messages = extractMessages(ctx.adapter);
        lastCount = ctx.messages.length;
        syncHeader();
        renderList();
      } catch {
        // ignore
      }

      if (lastCount <= prev) {
        // 没增长：再给一次机会；连续不增长则退出
        if (round >= 2) {
          setStatus(`自动加载结束：消息数未继续增长（${lastCount} 条）。你也可以手动向上滚动加载后再点“刷新”。`);
          break;
        }
      }
    }

    cancelBtn.setAttribute('disabled', 'true');
    autoBtn.removeAttribute('disabled');
  }

  // Events
  $('#cexport-toggle').addEventListener('click', () => {
    if (state.collapsed) expandPanel();
    else collapsePanel();
  });

  $('#cexport-pin').addEventListener('click', () => {
    state.pinned = !state.pinned;
    updatePinButton();
    saveState(state);
    setStatus(state.pinned ? '已固定：展开后不会自动折叠。' : '未固定：鼠标离开展开面板后会自动折叠。');
  });

  railHeadEl.addEventListener('click', () => {
    expandPanel();
  });

  railListEl.addEventListener('wheel', (ev) => {
    ev.stopPropagation();
    railListEl.scrollTop += ev.deltaY;
  }, { passive: false });

  root.addEventListener('mouseenter', () => {
    window.clearTimeout(autoCollapseTimer);
  });

  root.addEventListener('mouseleave', () => {
    window.clearTimeout(autoCollapseTimer);
    if (state.pinned || state.collapsed) return;
    autoCollapseTimer = window.setTimeout(() => {
      if (!state.pinned && !state.collapsed) collapsePanel();
    }, 700);
  });

  $('#cexport-refresh').addEventListener('click', () => refresh({ silent: false, reason: 'manual' }));
  $('#cexport-autoload').addEventListener('click', () => autoLoadMore());

  filterEl.addEventListener('input', () => {
    state.filter = filterEl.value;
    saveState(state);
    renderList();
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      if (mode === 'all' || mode === 'from' || mode === 'selected') setExportMode(mode);
    });
  });

  $('#cexport-export').addEventListener('click', () => doExport());
  $preview('#cexport-preview-close').addEventListener('click', () => closeMarkdownPreview());
  $preview('#cexport-preview-backdrop').addEventListener('click', () => closeMarkdownPreview());
  $preview('#cexport-preview-copy').addEventListener('click', () => copyEditedMarkdown());
  $preview('#cexport-preview-download').addEventListener('click', () => downloadEditedMarkdown());
  previewTextarea.addEventListener('input', () => {
    if (!previewExportState) return;
    $preview('#cexport-preview-count').textContent = `${previewExportState.turnCount} 轮对话 · ${previewTextarea.value.length.toLocaleString()} 字符`;
    renderPreviewToc(getMarkdownTocItems(previewTextarea.value));
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && previewRoot.classList.contains('open')) closeMarkdownPreview();
  });

  // 初次刷新（给 SPA 一点点时间）
  window.setTimeout(() => refresh({ silent: false, reason: 'initial' }), 500);
  startAutoRefresh();
})();

