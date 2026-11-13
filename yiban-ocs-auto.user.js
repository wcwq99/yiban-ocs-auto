// ==UserScript==
// @name         易班考试答题助手（OCS·AI 版）
// @namespace    http://tampermonkey.net/
// @version      4.4.0
// @description  易班考试自动答题助手 - 使用自定义题库（多源按序尝试），在面板「题库设置」里配置；无内置题库、无卡密授权
// @author       You
// @homepageURL  https://github.com/wcwq99/yiban-ocs-auto
// @supportURL   https://github.com/wcwq99/yiban-ocs-auto/issues
// @updateURL    https://raw.githubusercontent.com/wcwq99/yiban-ocs-auto/main/yiban-ocs-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/wcwq99/yiban-ocs-auto/main/yiban-ocs-auto.user.js
// @match        *://exam.yooc.me/group/*/exam/*
// @match        *://exam.yooc.me/group/*/exams
// @match        *://www.yooc.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      exambackend.yooc.me
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    /* ================= 常量与默认配置 ================= */

    // 题库请求默认超时；单个题库可用 timeout 字段覆盖
    const DEFAULT_BANK_TIMEOUT_MS = 25000;

    const KEY_BANKS = 'cfg_custom_banks';
    // 旧版 OCS 接口配置：只在启动时一次性迁移成自定义题库
    const LEGACY_KEY_OCS_URL = 'cfg_ocs_url';
    const LEGACY_KEY_OCS_TIMEOUT = 'cfg_ocs_timeout_ms';
    const LEGACY_KEY_OCS_ENABLED = 'cfg_ocs_enabled';
    const KEY_LEGACY_MIGRATED = 'cfg_legacy_ocs_migrated';

    const BANK_MAX_RETRY = 1;          // 网络错误时每个题库的重试次数
    const BANK_RETRY_DELAY_MS = 1200;
    const EXAM_API_TIMEOUT_MS = 20000;
    const QUESTION_RENDER_TIMEOUT_MS = 8000;
    const QUESTION_RENDER_STABLE_MS = 160;
    const QUESTION_INTERVAL_MS = 600;  // 两题之间的间隔
    const REVIEW_MAX_CONCURRENT = 2;   // 回顾页同时查询的题目数上限
    const RANDOM_ON_MISS_KEY = 'ocs_random_on_miss';   // 键名沿用旧版，保留用户原有设置

    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    // 题干 -> 答案 的内存缓存（刷新页面即失效，不做任何持久化）
    const answerCache = new Map();
    const answerSourceCache = new Map();   // 题干 -> 命中的题库名，用于日志显示

    const ANSWER_LOG_KEY = 'ocs_answer_log';
    const ANSWER_LOG_MAX = 300;            // 日志最多保留条数

    let autoAnswerRunning = false;
    let examPreparing = false;             // 已点击开始、正在获取试卷
    let stopRequested = false;             // 用户点击了停止
    let examRunToken = 0;                  // 每次开始/取消都自增，过期的回调据此丢弃
    const activeRequests = new Set();      // 进行中的 GM 请求，停止时统一中断
    let reviewAnswerObserver = null;
    let reviewRenderTimer = null;
    let reviewActiveLookups = 0;
    const reviewLookupQueue = [];
    let banksConfigErrorReportedFor = null;
    const approvedHandlers = new Set();    // 本次会话里用户已确认过的 handler 源码

    /* ================= Cookie / 用户 ================= */

    function getCookie(name) {
        var pairs = String(document.cookie || '').split(';');
        for (var i = 0; i < pairs.length; i++) {
            var at = pairs[i].indexOf('=');
            if (at < 0 || pairs[i].slice(0, at).trim() !== name) continue;
            var raw = pairs[i].slice(at + 1).trim();
            // Cookie 值可能是 URL 编码过的，先解码，拼 URL 时再统一编码
            try { return decodeURIComponent(raw); } catch (error) { return raw; }
        }
        return null;
    }

    const userId = getCookie('user_id');
    const userToken = getCookie('user_token');
    const yibanId = getCookie('yiban_id');

    function missingLoginInfo() {
        var missing = [];
        if (!userId) missing.push('user_id');
        if (!userToken) missing.push('user_token');
        if (!yibanId) missing.push('yiban_id');
        return missing.length ? '未从 Cookie 获取到登录信息（' + missing.join('、') + '），请先登录易班后刷新页面' : '';
    }

    function examApi(path, params) {
        var query = Object.keys(params).map(function (key) {
            return encodeURIComponent(key) + '=' + encodeURIComponent(params[key] == null ? '' : String(params[key]));
        }).join('&');
        return 'https://exambackend.yooc.me/api/' + path + '?' + query;
    }

    /* ================= 启动 ================= */

    if (location.hostname === 'www.yooc.me' && !/^\/mobile\//.test(location.pathname)) {
        // 登录 / 授权类页面不跳，避免打断登录流程；15 秒内跳过一次就不再跳，防止来回跳转死循环
        var isAuthPage = /login|logout|passport|oauth|auth|sso|register|signup|callback/i.test(location.pathname + location.search);
        var lastRedirectAt = 0;
        try { lastRedirectAt = Number(sessionStorage.getItem('hp_mobile_redirect_at')) || 0; } catch (error) { /* 忽略 */ }
        if (!isAuthPage && Date.now() - lastRedirectAt > 15000) {
            try { sessionStorage.setItem('hp_mobile_redirect_at', String(Date.now())); } catch (error) { /* 忽略 */ }
            console.log('[考试助手] 检测到网页版，跳转到手机版');
            window.location.href = 'https://www.yooc.me/mobile/dashboard';
        } else {
            console.log('[考试助手] 网页版页面：登录相关或刚跳转过，不再跳转。');
        }
        return;
    }

    if (document.readyState === 'complete') {
        bootstrap();
    } else {
        window.addEventListener('load', bootstrap);
    }

    function bootstrap() {
        console.log('[考试助手] 自定义题库版启动，用户信息:', { userId, userToken: userToken ? '已获取' : '缺失', yibanId });
        if (!userToken) console.warn('[考试助手] 未能从 Cookie 获取 user_token，试卷接口可能不可用。');
        migrateLegacyOcsConfig();
        createControlPanel();
        autoStartReviewDisplay();
    }

    // 旧版用户在设置里保存过 OCS 接口时，转成一条自定义题库，避免升级后配置丢失
    function migrateLegacyOcsConfig() {
        if (GM_getValue(KEY_LEGACY_MIGRATED, false) === true) return;
        var url = String(GM_getValue(LEGACY_KEY_OCS_URL, '') || '').trim();
        var enabled = GM_getValue(LEGACY_KEY_OCS_ENABLED, true) !== false;
        if (url && enabled) {
            var raw = String(GM_getValue(KEY_BANKS, '') || '').trim();
            var list;
            try {
                var parsed = raw ? JSON.parse(raw) : [];
                list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.banks) ? parsed.banks : null);
            } catch (error) {
                list = null;
            }
            if (!list) {
                // 现有题库配置无法解析时不动它，旧 OCS 配置也先留着
                console.warn('[考试助手] 现有题库配置无法解析，旧版 OCS 设置未迁移。');
                GM_setValue(KEY_LEGACY_MIGRATED, true);
                return;
            }
            var exists = list.some(function (bank) { return bank && typeof bank.url === 'string' && bank.url.trim() === url; });
            if (!exists) {
                var timeout = Number(GM_getValue(LEGACY_KEY_OCS_TIMEOUT, DEFAULT_BANK_TIMEOUT_MS));
                list.push({
                    name: 'OCS（旧版设置迁移）',
                    url: url,
                    method: 'post',
                    contentType: 'json',
                    data: { title: '${title}', type: '${type}', options: '${options}' },
                    timeout: Number.isFinite(timeout) && timeout >= 3000 ? timeout : DEFAULT_BANK_TIMEOUT_MS
                });
                GM_setValue(KEY_BANKS, JSON.stringify(list, null, 2));
                console.log('[考试助手] 已把旧版 OCS 接口迁移为自定义题库。');
            }
        }
        [LEGACY_KEY_OCS_URL, LEGACY_KEY_OCS_TIMEOUT, LEGACY_KEY_OCS_ENABLED].forEach(function (key) {
            try { GM_deleteValue(key); } catch (error) { GM_setValue(key, ''); }
        });
        GM_setValue(KEY_LEGACY_MIGRATED, true);
    }

    /* ================= 文本工具 ================= */

    // ES5 安全的 hasOwnProperty，兼容不支持 Object.hasOwn 的旧内核
    function has(obj, key) {
        return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function normText(t) {
        var ta = document.createElement('textarea');
        ta.innerHTML = String(t || '');
        return ta.value.replace(/&nbsp;/g, ' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function normalizeMatchText(text) {
        var holder = document.createElement('div');
        holder.innerHTML = String(text || '');
        var value = holder.textContent || holder.innerText || '';
        try { value = value.normalize('NFKC'); } catch (e) { }
        return value
            .replace(/\u00a0/g, ' ')
            .replace(/\[x\]/gi, ' {{blank}} ')
            .replace(/_{2,}|＿{2,}/g, ' {{blank}} ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeTitleForMatch(text) {
        return normalizeMatchText(text)
            .replace(/^\s*[一二三四五六七八九十]+\s*[、.．)]\s*/, '')
            .replace(/^\s*\d+\s*[、.．)]\s*/, '')
            .replace(/\[\s*\d+(?:\.\d+)?\s*分\s*\]/g, '')
            .replace(/\{\s*input\s*\}|\{\{\s*blank(?::\d+)?\s*\}\}/gi, ' {{blank}} ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeOptionForMatch(text) {
        return normalizeMatchText(text)
            .replace(/^[a-zＡ-Ｚ]\s*[.．、:：]\s*/i, '')
            .replace(/^[（(]\s*[a-zＡ-Ｚ]\s*[）)]\s*/i, '')
            .trim();
    }

    function getOptionSignature(optionTexts) {
        return JSON.stringify((optionTexts || []).slice().sort());
    }

    // 用于比对答案与选项：去标签、去字母前缀、去全部标点与空白
    function simplifyText(text) {
        var v = String(text == null ? '' : text).replace(/<[^>]*>/g, ' ');
        try { v = v.normalize('NFKC'); } catch (e) { }
        return v
            .replace(/^\s*(?:选项|答案)\s*[:：]?\s*/, '')
            .replace(/^[A-Za-z]\s*[.．、:：)）]\s*/, '')
            .replace(/^[（(]\s*[A-Za-z]\s*[）)]\s*/, '')
            .replace(/[\s\u00a0"'“”‘’《》<>()（）\[\]【】,.，。;；:：!！?？\-—_/\\|、]/g, '')
            .toLowerCase();
    }

    function bigrams(s) {
        var out = [];
        for (var i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
        return out;
    }

    // 字符二元组 Dice 相似度，0~1
    function diceSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.length === 1 || b.length === 1) return (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) ? 0.8 : 0;
        var A = bigrams(a), B = bigrams(b);
        var pool = B.slice(), hit = 0;
        A.forEach(function (pair) {
            var at = pool.indexOf(pair);
            if (at >= 0) { hit++; pool.splice(at, 1); }
        });
        return (2 * hit) / (A.length + B.length);
    }

    /* ================= 题干快照（DOM 读数层） ================= */

    function hasQuestionContentMedia(root, optionItems) {
        if (!root) return false;
        return Array.prototype.some.call(root.querySelectorAll('img, svg, canvas, video, audio, math'), function (media) {
            if (media.tagName.toLowerCase() !== 'svg') return true;
            var icon = media.closest('.icon');
            return !icon || !optionItems || optionItems.indexOf(icon.parentElement) < 0 || Boolean(media.closest('.flex-auto'));
        });
    }

    function readCurrentQuestionSnapshot() {
        var main = document.getElementsByTagName('main')[0];
        var h3 = main ? main.getElementsByTagName('h3')[0] : null;
        if (!h3) return null;

        var container = h3.parentElement || h3;
        var clone = h3.cloneNode(true);
        var cloneInputs = clone.querySelectorAll('input, textarea');
        for (var ci = 0; ci < cloneInputs.length; ci++) {
            cloneInputs[ci].replaceWith(document.createTextNode(' {{blank}} '));
        }

        var optionList = container.querySelector('ul');
        var optionItems = optionList ? Array.prototype.slice.call(optionList.children).filter(function (item) {
            return item.tagName && item.tagName.toLowerCase() === 'li';
        }) : [];
        var inputs = Array.prototype.slice.call(container.querySelectorAll('input.exam-input, input[type=text], input:not([type]), textarea'));
        var optionRawTexts = optionItems.map(function (item) {
            var textNode = item.querySelector('.flex-auto') || item.lastElementChild || item;
            return (textNode.textContent || item.textContent || '').trim();
        });
        var optionTexts = optionRawTexts.map(normalizeOptionForMatch);
        var heading = main.querySelector('h2');
        var headingText = heading ? heading.textContent || '' : '';
        var kind = inputs.length > 0 && optionItems.length === 0 ? 'blank' : 'choice';
        var optionInputs = optionItems.map(function (item) {
            return item.querySelector('input[type=checkbox], input[type=radio]');
        });
        var hasCheckbox = optionInputs.some(function (input) { return input && input.type === 'checkbox'; });
        var hasRadio = optionInputs.some(function (input) { return input && input.type === 'radio'; });

        return {
            container: container,
            h3: h3,
            optionItems: optionItems,
            optionTexts: optionTexts,
            optionRawTexts: optionRawTexts,
            titleText: (clone.textContent || '').replace(/\s+/g, ' ').trim(),
            inputs: inputs,
            kind: kind,
            multiple: hasCheckbox ? true : hasRadio ? false : (function () {
                var hasMultipleLabel = /多项|多选/.test(headingText);
                var hasSingleLabel = /单项|单选/.test(headingText);
                return hasMultipleLabel === hasSingleLabel ? null : hasMultipleLabel;
            })(),
            hasMedia: hasQuestionContentMedia(h3, []) || hasQuestionContentMedia(optionList, optionItems),
            titleKey: normalizeTitleForMatch(clone.textContent || ''),
            optionSignature: getOptionSignature(optionTexts),
            blankCount: inputs.length
        };
    }

    function getCurrentProgress() {
        var items = Array.prototype.slice.call(document.querySelectorAll('li'));
        var candidates = items.filter(function (item) {
            return /^\s*\d+\s*\/\s*\d+\s*$/.test(item.textContent || '') && !item.querySelector('ul');
        });
        if (!candidates.length) return null;

        // 优先取与「下一题/上一题」按钮同一导航区里的那个；选项里出现 "1/2" 时不会误判
        var chosen = null;
        var nav = findNavButton('下一题') || findNavButton('上一题');
        if (nav) {
            var scope = nav.parentElement;
            for (var up = 0; up < 4 && scope; up++) {
                var hit = candidates.filter(function (el) { return scope.contains(el); });
                if (hit.length) { chosen = hit[hit.length - 1]; break; }
                scope = scope.parentElement;
            }
        }
        if (!chosen) chosen = candidates[candidates.length - 1];

        var match = (chosen.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        if (!match) return null;
        var current = Number(match[1]);
        var total = Number(match[2]);
        return current >= 1 && current <= total ? { current: current, total: total } : null;
    }

    function sameQuestionRender(first, second) {
        if (!first || !second || first.h3 !== second.h3 || first.container !== second.container) return false;
        if (first.kind !== second.kind || first.titleKey !== second.titleKey || first.titleText !== second.titleText ||
            first.multiple !== second.multiple || first.hasMedia !== second.hasMedia ||
            JSON.stringify(first.optionTexts) !== JSON.stringify(second.optionTexts) ||
            JSON.stringify(first.optionRawTexts) !== JSON.stringify(second.optionRawTexts)) return false;
        return ['optionItems', 'inputs'].every(function (key) {
            return first[key].length === second[key].length && first[key].every(function (node, index) { return node === second[key][index]; });
        });
    }

    function findNavButton(name) {
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        return buttons.find(function (button) { return (button.textContent || '').trim() === name; }) || null;
    }

    function waitForQuestionReady(expectedProgress, previousSnapshot, expectedTotal) {
        return new Promise(function (resolve, reject) {
            var started = Date.now();
            var stableSince = null;
            var lastSnapshot = null;

            function check() {
                try {
                    var progress = getCurrentProgress();
                    var snapshot = readCurrentQuestionSnapshot();
                    if (progress && expectedTotal && progress.total !== expectedTotal) throw new Error('页面总题数与试卷数据不一致');
                    // 相邻两题题干/选项完全相同时，React 会复用同一批节点，
                    // 因此"与上一屏不同"不能作为必要条件：只要题号已经变了就算切换完成
                    var sameAsPrevious = Boolean(previousSnapshot) && sameQuestionRender(previousSnapshot, snapshot) &&
                        previousSnapshot.__progress === (progress && progress.current);
                    var ready = progress && progress.current === expectedProgress && snapshot && snapshot.h3.isConnected !== false &&
                        (snapshot.kind === 'blank' ? snapshot.inputs.length > 0 : snapshot.optionItems.length > 0) &&
                        !sameAsPrevious;
                    if (ready) {
                        snapshot.__progress = progress.current;
                        if (!sameQuestionRender(lastSnapshot, snapshot)) stableSince = Date.now();
                        lastSnapshot = snapshot;
                        if (Date.now() - stableSince >= QUESTION_RENDER_STABLE_MS) { resolve(snapshot); return; }
                    } else {
                        stableSince = null;
                        lastSnapshot = null;
                    }
                    if (Date.now() - started >= QUESTION_RENDER_TIMEOUT_MS) throw new Error('等待第 ' + expectedProgress + ' 题切换超时，停止以避免答案写到其他题目');
                    setTimeout(check, 40);
                } catch (error) {
                    reject(error);
                }
            }
            check();
        });
    }

    /* ================= 填写与选择状态 ================= */

    function isChoiceItemSelected(item) {
        var input = item && item.querySelector ? item.querySelector('input[type=checkbox], input[type=radio]') : null;
        return input ? input.checked === true : Boolean(item && item.classList && item.classList.contains('_c'));
    }

    function setInputValue(input, value) {
        var proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(input, value == null ? '' : String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setStatus(message) {
        var status = document.getElementById('hp-ai-status');
        if (status) status.textContent = message;
        console.log('[考试助手] ' + message);
    }

    function randomOnMissEnabled() {
        return GM_getValue(RANDOM_ON_MISS_KEY, true) === true;
    }

    function applyRandomChoice(snapshot, label) {
        if (!snapshot || snapshot.kind !== 'choice' || !snapshot.optionItems || snapshot.optionItems.length === 0) return false;
        var selected = snapshot.optionItems.map(isChoiceItemSelected);
        if (snapshot.multiple === true) {
            var desired = new Set();
            var count = 1 + Math.floor(Math.random() * snapshot.optionItems.length);
            var indices = snapshot.optionItems.map(function (item, index) { return index; });
            for (var i = indices.length - 1; i > 0; i--) {
                var swapIndex = Math.floor(Math.random() * (i + 1));
                var temporary = indices[i];
                indices[i] = indices[swapIndex];
                indices[swapIndex] = temporary;
            }
            indices.slice(0, count).forEach(function (index) { desired.add(index); });
            snapshot.optionItems.forEach(function (item, index) {
                if (selected[index] !== desired.has(index)) item.click();
            });
        } else {
            var target = Math.floor(Math.random() * snapshot.optionItems.length);
            if (!selected[target]) snapshot.optionItems[target].click();
        }
        console.warn('[考试助手] ' + label + ' 未命中，已随机作答，请自行核对。');
        return true;
    }

    function handleMiss(snapshot, label) {
        if (randomOnMissEnabled() && applyRandomChoice(snapshot, label)) {
            setStatus(label + '：未命中，已随机作答（请自行核对）');
            return true;
        }
        setStatus(label + '：未命中，已跳过');
        return false;
    }

    function applyChoiceIndices(snapshot, indices, source) {
        if (!indices || !indices.length) return false;
        if (indices.some(function (index) { return !snapshot.optionItems[index]; })) return false;
        var desired = new Set(indices);
        var selected = snapshot.optionItems.map(isChoiceItemSelected);
        // multiple 为 null（DOM 与题头都没有单选/多选标记）时按多选处理：
        // 这样题库只给一个答案时也能把多余的已选项取消，避免"单选却亮两项"
        var treatAsMultiple = snapshot.multiple !== false;
        if (treatAsMultiple) {
            snapshot.optionItems.forEach(function (item, index) {
                if (selected[index] && !desired.has(index)) item.click();
            });
            snapshot.optionItems.forEach(function (item, index) {
                if (!selected[index] && desired.has(index)) item.click();
            });
        } else {
            var target = indices[0];
            if (!selected[target]) snapshot.optionItems[target].click();
        }
        console.log('[选择题] 已按' + (source || '题库') + '答案填写，选项索引:', indices);
        return true;
    }

    function applyBlankValues(snapshot, values, source) {
        if (!values || !values.length) return false;
        var inputs = snapshot.inputs;
        if (!inputs.length) return false;
        // 数量不一致时宁可不填，避免把答案写进错误空格
        if (values.length !== inputs.length) {
            console.warn('[填空题] 答案数量(' + values.length + ')与空格数(' + inputs.length + ')不一致，本题跳过。');
            return false;
        }
        inputs.forEach(function (input, index) { setInputValue(input, values[index]); });
        console.log('[填空题] 已按' + (source || '题库') + '答案填写:', values.slice());
        return true;
    }

    /* ================= 题型判定与题库请求构建 ================= */

    function judgeGroup(text) {
        var s = simplifyText(text);
        if (/^(正确|对|是|真|√|t|true|yes|y)$/.test(s)) return 'T';
        if (/^(错误|错|否|假|×|x|f|false|no|n)$/.test(s)) return 'F';
        return null;
    }

    function isJudgeOptions(optionTexts) {
        if (!optionTexts || optionTexts.length !== 2) return false;
        var groups = optionTexts.map(judgeGroup);
        return groups.indexOf(null) < 0 && groups[0] !== groups[1];
    }

    function questionTypeName(snapshot) {
        if (snapshot.kind === 'blank') return '填空题';
        if (isJudgeOptions(snapshot.optionTexts)) return '判断题';
        return snapshot.multiple === true ? '多选题' : '单选题';
    }

    function questionVars(snapshot) {
        var options = '';
        if (snapshot.kind === 'choice') {
            options = (snapshot.optionRawTexts || []).map(function (text, index) {
                // 选项文本可能本身已带 "A." 前缀，先剥掉再统一补，避免出现 "A. A. xxx"
                var clean = String(text == null ? '' : text)
                    .replace(/^\s*[A-Za-zＡ-Ｚ]\s*[.．、:：)）]\s*/, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                return LETTERS[index] + '. ' + clean;
            }).join('\n');
        }
        return {
            title: snapshot.titleText || snapshot.titleKey,
            type: questionTypeName(snapshot),
            options: options
        };
    }

    function answerCacheKey(snapshot) {
        return JSON.stringify([snapshot.kind, snapshot.multiple, snapshot.titleKey, snapshot.optionTexts, snapshot.blankCount]);
    }

    /* ================= 可配置题库源 ================= */

    // 把用户粘贴的题库 JSON 规整成内部结构；不合法项直接丢弃，不影响其它题库
    function normalizeBankList(input) {
        var list = Array.isArray(input) ? input : (input && Array.isArray(input.banks) ? input.banks : []);
        return list.filter(function (bank) {
            return bank && typeof bank === 'object' && typeof bank.url === 'string' && bank.url.trim();
        }).map(function (bank, index) {
            var timeout = Number(bank.timeout);
            var method = String(bank.method || 'POST').toUpperCase();
            return {
                name: String(bank.name || ('题库' + (index + 1))),
                url: String(bank.url).trim(),
                // 原样保留，非法枚举由 validateBanksInput 报错，避免静默改写用户配置
                method: method,
                contentType: String(bank.contentType || 'json').toLowerCase(),
                data: bank.data && typeof bank.data === 'object' ? bank.data : {},
                handler: typeof bank.handler === 'string' ? bank.handler : '',
                timeout: Number.isFinite(timeout) && timeout >= 3000 ? timeout : DEFAULT_BANK_TIMEOUT_MS,
                enabled: bank.enabled !== false
            };
        }).filter(function (bank) { return bank.enabled; });
    }

    // 每次调用都重新读取，错误通过返回值带出，保证每次失败都能看到原因
    function loadCustomBanks() {
        var raw = GM_getValue(KEY_BANKS, '');
        if (typeof raw !== 'string' || !raw.trim()) return { banks: [], error: '' };
        try {
            return { banks: normalizeBankList(JSON.parse(raw)), error: '' };
        } catch (error) {
            if (banksConfigErrorReportedFor !== raw) {
                banksConfigErrorReportedFor = raw;
                console.warn('[考试助手] 自定义题库 JSON 解析失败:', error.message);
            }
            return { banks: [], error: '题库配置 JSON 解析失败（' + error.message + '）' };
        }
    }

    function bankConfigProblem() {
        var loaded = loadCustomBanks();
        if (loaded.error) return loaded.error;
        if (!loaded.banks.length) return '还没有配置可用的题库';
        return '';
    }

    // 把 ${title} / ${type} / ${options} 替换进题库请求体（支持嵌套对象与数组）
    // missing 传入数组时，把无法识别的占位符收集进去，便于提示用户拼写错误
    function renderTemplate(value, vars, missing) {
        if (typeof value === 'string') {
            return value.replace(/\$\{(\w+)\}/g, function (match, key) {
                if (has(vars, key)) return String(vars[key]);
                if (missing && missing.indexOf(key) < 0) missing.push(key);
                return '';
            });
        }
        if (Array.isArray(value)) return value.map(function (item) { return renderTemplate(item, vars, missing); });
        if (value && typeof value === 'object') {
            var out = {};
            Object.keys(value).forEach(function (key) { out[key] = renderTemplate(value[key], vars, missing); });
            return out;
        }
        return value;
    }

    // 非标量值（对象/数组）用 JSON 表示，避免出现 [object Object]
    function formValue(value) {
        if (value == null) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }

    function encodeForm(data) {
        return Object.keys(data).map(function (key) {
            return encodeURIComponent(key) + '=' + encodeURIComponent(formValue(data[key]));
        }).join('&');
    }

    // URL 里的占位符需要 URL 编码后再拼接
    function renderUrlTemplate(template, vars) {
        var missing = [];
        var rendered = String(template || '').replace(/\$\{(\w+)\}/g, function (match, key) {
            if (has(vars, key)) return encodeURIComponent(String(vars[key]));
            if (missing.indexOf(key) < 0) missing.push(key);
            return '';
        });
        return { url: rendered, missing: missing };
    }

    function buildBankRequest(bank, snapshot) {
        var vars = questionVars(snapshot);
        var missing = [];
        var urlInfo = renderUrlTemplate(bank.url, vars);
        var targetUrl = urlInfo.url;
        missing = missing.concat(urlInfo.missing);

        // 占位符拼进 query 时，fragment 必须留在最后
        var fragmentAt = targetUrl.indexOf('#');
        var fragment = fragmentAt >= 0 ? targetUrl.slice(fragmentAt) : '';
        if (fragmentAt >= 0) targetUrl = targetUrl.slice(0, fragmentAt);

        var body = renderTemplate(bank.data, vars, missing);
        if (missing.length) {
            console.warn('[考试助手] 题库「' + bank.name + '」含无法识别的占位符:', missing.join(', '),
                '（可用：title / type / options）');
        }

        if (bank.method === 'GET') {
            var query = encodeForm(body);
            var fullUrl = query ? targetUrl + (targetUrl.indexOf('?') >= 0 ? '&' : '?') + query : targetUrl;
            return { method: 'GET', url: fullUrl + fragment, headers: {}, data: undefined };
        }
        if (bank.contentType.indexOf('form') >= 0) {
            return {
                method: 'POST',
                url: targetUrl + fragment,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: encodeForm(body)
            };
        }
        return {
            method: 'POST',
            url: targetUrl + fragment,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(body)
        };
    }

    // handler 语法：源码求值后若得到函数则用响应对象调用它，返回 [question, answer] 或 undefined
    function runBankHandler(handlerSource, responseJson) {
        function defaultExtract() {
            // 没有 handler 时的默认解析：必须 code 为 1（或未提供 code）且 answer 为非空
            if (!responseJson || typeof responseJson !== 'object') return undefined;
            if (responseJson.code !== undefined && Number(responseJson.code) !== 1) return undefined;
            var answer = responseJson.answer;
            if (typeof answer === 'number') answer = String(answer);
            return typeof answer === 'string' && answer.trim() ? [responseJson.question, answer] : undefined;
        }

        if (!handlerSource) return defaultExtract();

        var produced;
        try {
            produced = new Function(handlerSource)();
        } catch (compileError) {
            // 编译失败通常是环境限制（CSP/沙箱禁 eval）或用户写错语法，退回默认解析
            console.warn('[考试助手] handler 无法编译，改用默认解析（读 code/answer 字段）:', compileError.message);
            return defaultExtract();
        }

        try {
            return typeof produced === 'function' ? produced(responseJson) : produced;
        } catch (runError) {
            // 运行期抛错说明该题库没解析出结果，按未命中处理，绝不回退成"读 answer"以免误判失败响应
            console.warn('[考试助手] handler 执行出错，视为未命中:', runError.message);
            return undefined;
        }
    }

    function extractAnswerFromHandlerResult(result) {
        if (result == null) return null;
        if (typeof result === 'number') return String(result);
        if (typeof result === 'string') return result.trim() || null;
        if (Array.isArray(result)) {
            var value = result.length > 1 ? result[1] : result[0];
            if (typeof value === 'number') return String(value);
            return typeof value === 'string' && value.trim() ? value.trim() : null;
        }
        if (typeof result === 'object') {
            var answer = result.answer;
            if (typeof answer === 'number') return String(answer);
            if (typeof answer === 'string' && answer.trim()) return answer.trim();
        }
        return null;
    }

    function makeStopError() {
        var error = new Error('已手动停止');
        error.userStop = true;
        return error;
    }

    function trackRequest(handle) {
        if (handle && typeof handle.abort === 'function') activeRequests.add(handle);
        return handle;
    }

    function abortActiveRequests() {
        var handles = Array.from(activeRequests);
        activeRequests.clear();
        handles.forEach(function (handle) {
            try { handle.abort(); } catch (error) { /* 忽略 */ }
        });
    }

    function httpJson(options, timeout) {
        return new Promise(function (resolve, reject) {
            var handle = null;
            var settled = false;
            function finish() {
                settled = true;
                if (handle) activeRequests.delete(handle);
            }
            handle = GM_xmlhttpRequest({
                method: options.method || 'POST',
                url: options.url,
                headers: options.headers || {},
                data: options.data,
                timeout: timeout,
                onload: function (response) {
                    finish();
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error('HTTP ' + response.status));
                        return;
                    }
                    try { resolve(JSON.parse(response.responseText)); }
                    catch (error) { reject(new Error('返回内容不是合法 JSON')); }
                },
                onerror: function (response) {
                    finish();
                    // 带上脚本管理器给出的原因（如域名未授权、DNS/连接失败），便于排查
                    var detail = response && (response.error || response.statusText) || '';
                    if (response && response.status) detail = 'HTTP ' + response.status + (detail ? ' ' + detail : '');
                    reject(new Error('网络请求失败' + (detail ? '（' + detail + '）' : '（可能是域名未授权、地址写错或服务器不可达）')));
                },
                ontimeout: function () { finish(); reject(new Error('请求超时')); },
                onabort: function () { finish(); reject(makeStopError()); }
            });
            if (!settled) trackRequest(handle);
        });
    }

    async function queryCustomBank(bank, snapshot) {
        var request = buildBankRequest(bank, snapshot);
        var data = await httpJson(request, bank.timeout);
        var result;
        try {
            // handler 可以是 async 函数，这里统一 await
            result = await runBankHandler(bank.handler, data);
        } catch (runError) {
            console.warn('[考试助手] 题库「' + bank.name + '」handler 异步执行出错，视为未命中:', runError && runError.message);
            return null;
        }
        return extractAnswerFromHandlerResult(result);
    }

    // 只有网络类/服务端类错误值得重试；HTTP 4xx 这类配置错误重试也没用
    function isRetryable(error) {
        var message = String(error && error.message || '');
        if (/HTTP 4\d\d/.test(message)) return false;
        return /网络请求失败|请求超时|HTTP 5\d\d/.test(message);
    }

    // 统一入口：按配置顺序依次查询自定义题库，命中即停。返回 { answer, source }
    async function lookupAnswer(snapshot) {
        var cacheKey = answerCacheKey(snapshot);
        if (answerCache.has(cacheKey)) {
            return { answer: answerCache.get(cacheKey), source: (answerSourceCache.get(cacheKey) || '题库') + '（缓存）' };
        }

        var loaded = loadCustomBanks();
        if (loaded.error) throw new Error(loaded.error + '，请到「题库设置」里修正');
        if (!loaded.banks.length) throw new Error('还没有配置可用的题库，请先在「题库设置」里添加');

        var errors = [];
        for (var i = 0; i < loaded.banks.length; i++) {
            var bank = loaded.banks[i];
            for (var attempt = 0; attempt <= BANK_MAX_RETRY; attempt++) {
                checkStopRequested();
                setStatus('正在查询题库「' + bank.name + '」' + (attempt ? '（重试）' : '') + '…');
                try {
                    var answer = await queryCustomBank(bank, snapshot);
                    if (answer) {
                        var source = '题库「' + bank.name + '」';
                        console.log('[考试助手] 命中' + source);
                        answerCache.set(cacheKey, answer);
                        answerSourceCache.set(cacheKey, source);
                        return { answer: answer, source: source };
                    }
                    errors.push(bank.name + ': 未返回答案');
                    break;
                } catch (error) {
                    if (error.userStop) throw error;
                    if (attempt < BANK_MAX_RETRY && isRetryable(error)) {
                        await sleep(BANK_RETRY_DELAY_MS);
                        continue;
                    }
                    errors.push(bank.name + ': ' + error.message);
                    break;
                }
            }
        }

        var shown = errors.slice(-2);
        throw new Error(shown.join('；') + (errors.length > shown.length ? '（共 ' + errors.length + ' 个题库未命中）' : ''));
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* ================= 答案解析 ================= */

    // 题库答案用 # 分隔多个答案
    // allowLetters：只有选择题才把 "AB" / "A,B" 这种纯字母串拆成选项字母；
    // 填空题答案可能是 "FACE" 这类纯字母单词，绝不能拆
    function splitAnswerParts(raw, allowLetters) {
        var text = String(raw == null ? '' : raw).trim();
        if (!text) return [];
        var parts = text.split(/[#＃]+/).map(function (part) { return part.trim(); }).filter(Boolean);
        if (parts.length > 1) return parts;
        if (!allowLetters) return parts;
        var compact = parts[0] || '';
        if (/^[A-Ha-h](?:[\s、,，;；]+[A-Ha-h])+$/.test(compact)) {
            return compact.replace(/[^A-Ha-h]/g, '').toUpperCase().split('');
        }
        if (/^[A-Ha-h]{2,}$/.test(compact)) {
            return compact.toUpperCase().split('');
        }
        return parts;
    }

    function matchOptionPart(part, snapshot) {
        var options = snapshot.optionTexts || [];
        if (!options.length) return null;

        // 1) 选项字母
        var letters = String(part).replace(/[\s、,，.．:：;；()（）]/g, '');
        if (/^[A-Za-z]$/.test(letters)) {
            var letterIndex = LETTERS.indexOf(letters.toUpperCase());
            if (letterIndex >= 0 && letterIndex < options.length) return letterIndex;
        }

        var want = simplifyText(part);
        if (!want) return null;

        // 2) 完全一致
        var exact = [];
        options.forEach(function (text, index) {
            if (simplifyText(text) === want) exact.push(index);
        });
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) return null;

        // 3) 包含关系（唯一命中才算）
        var contains = [];
        options.forEach(function (text, index) {
            var option = simplifyText(text);
            if (option && (option.indexOf(want) >= 0 || want.indexOf(option) >= 0)) contains.push(index);
        });
        if (contains.length === 1) return contains[0];

        // 4) 判断题同义（正确/对/是  <->  错误/错/否）
        var group = judgeGroup(part);
        if (group) {
            var sameGroup = [];
            options.forEach(function (text, index) {
                if (judgeGroup(text) === group) sameGroup.push(index);
            });
            if (sameGroup.length === 1) return sameGroup[0];
        }

        // 5) 相似度最高且唯一
        var scored = options.map(function (text, index) {
            return { index: index, score: diceSimilarity(want, simplifyText(text)) };
        }).sort(function (a, b) { return b.score - a.score; });
        if (scored.length && scored[0].score >= 0.45 &&
            (scored.length === 1 || scored[0].score - scored[1].score >= 0.08)) return scored[0].index;

        return null;
    }

    function resolveChoiceIndices(snapshot, rawAnswer) {
        var parts = splitAnswerParts(rawAnswer, true);
        if (!parts.length) return null;
        var picked = [];
        var unresolved = [];
        parts.forEach(function (part) {
            var index = matchOptionPart(part, snapshot);
            if (index == null) unresolved.push(part);
            else if (picked.indexOf(index) < 0) picked.push(index);
        });
        if (unresolved.length) console.warn('[选择题] 这些答案片段无法映射到选项:', unresolved);
        if (!picked.length) return null;
        if (snapshot.multiple === false) return [picked[0]];   // 单选遇到多答案时取首个
        return picked;
    }

    function resolveBlankValues(snapshot, rawAnswer) {
        var total = snapshot.inputs ? snapshot.inputs.length : snapshot.blankCount;
        var parts = splitAnswerParts(rawAnswer, false);
        if (!parts.length) return null;
        if (total <= 1) return [String(rawAnswer).replace(/[#＃]+/g, ' ').trim()];
        if (parts.length === total) return parts;
        if (parts.length > total) return parts.slice(0, total);
        // 只在显式分隔符上再试一次；不按空格切，避免把 "New York" 拆成两空
        var alt = String(rawAnswer).split(/[，,、;；|｜]+/).map(function (part) { return part.trim(); }).filter(Boolean);
        if (alt.length > parts.length) return alt.length > total ? alt.slice(0, total) : alt;
        return parts;
    }

    // 返回 'bank'（题库答案已填）| 'random'（未命中随机作答）| 'skip'（未填写）
    function answerQuestion(snapshot, rawAnswer, label) {
        if (snapshot.kind === 'choice') {
            var indices = resolveChoiceIndices(snapshot, rawAnswer);
            if (!indices) {
                console.warn('[选择题] 答案无法映射，原文:', rawAnswer);
                return handleMiss(snapshot, label) ? 'random' : 'skip';
            }
            return applyChoiceIndices(snapshot, indices, '题库') ? 'bank' : 'skip';
        }
        var values = resolveBlankValues(snapshot, rawAnswer);
        if (!values) {
            console.warn('[填空题] 答案为空');
            return handleMiss(snapshot, label) ? 'random' : 'skip';
        }
        return applyBlankValues(snapshot, values, '题库') ? 'bank' : 'skip';
    }

    /* ================= 自动答题主流程 ================= */

    function captureQuestionState(snapshot) {
        return {
            url: window.location.href,
            inputs: snapshot.inputs.map(function (input) { return input.value; }),
            selected: snapshot.optionItems.map(isChoiceItemSelected)
        };
    }

    function assertQuestionUnchanged(index, total, snapshot, state) {
        var progress = getCurrentProgress();
        var latest = readCurrentQuestionSnapshot();
        var changed = !autoAnswerRunning ||
            window.location.href !== state.url ||
            !progress || progress.current !== index + 1 || progress.total !== total ||
            !latest || latest.h3.isConnected === false ||
            !sameQuestionRender(snapshot, latest) ||
            latest.inputs.some(function (input, k) { return input.value !== state.inputs[k]; }) ||
            latest.optionItems.some(function (item, k) { return isChoiceItemSelected(item) !== state.selected[k]; });
        if (changed) throw new Error('等待题库返回时题目或手动答案发生变化，已停止以避免覆盖');
    }

    async function moveToQuestion(currentPosition, targetPosition, name, total) {
        var before = await waitForQuestionReady(currentPosition, null, total);
        var progress = getCurrentProgress();
        if (!progress || progress.current !== currentPosition) throw new Error('页面题号意外变化，停止自动答题');
        var button = findNavButton(name);
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('没有可用的' + name + '按钮');
        button.click();
        return waitForQuestionReady(targetPosition, before, total);
    }

    async function answerAllQuestions(questions) {
        var progress = getCurrentProgress();
        if (!progress || progress.total !== questions.length) throw new Error('页面题号或总题数与试卷数据不一致');

        var total = questions.length;
        var snapshot = await waitForQuestionReady(progress.current, null, total);
        var startIndex = progress.current - 1;
        var consecutiveFailures = 0;
        console.log('[考试助手] 从第 ' + progress.current + '/' + total + ' 题开始（前面的题目不再处理）。');

        for (var index = startIndex; index < total; index++) {
            checkStopRequested();
            var current = getCurrentProgress();
            if (!current || current.current !== index + 1 || !sameQuestionRender(snapshot, readCurrentQuestionSnapshot())) {
                throw new Error('当前题号或题目内容意外变化，停止自动答题');
            }

            var label = '第 ' + (index + 1) + '/' + total + ' 题';
            var applied = 'skip';
            var lastError = null;
            var countFailure = true;
            var logAnswer = '';
            var logSource = '';

            if (snapshot.hasMedia) {
                lastError = new Error('题干或选项含图片/公式，未送题库');
                console.warn('[考试助手] ' + label + ' 题干或选项含图片/公式，不送题库。');
                applied = handleMiss(snapshot, label) ? 'random' : 'skip';
                countFailure = false;   // 含媒体题本来就不查题库，不计入熔断
            } else {
                var state = captureQuestionState(snapshot);
                setStatus(label + ' 正在查询题库…');
                try {
                    var found = await lookupAnswer(snapshot);
                    var rawAnswer = found.answer;
                    logAnswer = String(rawAnswer);
                    logSource = found.source;
                    checkStopRequested();
                    assertQuestionUnchanged(index, total, snapshot, state);
                    applied = answerQuestion(snapshot, rawAnswer, label);
                    if (applied === 'bank') setStatus(label + ' 已按题库作答：' + String(rawAnswer).slice(0, 40));
                } catch (error) {
                    if (error.userStop || /题目或手动答案发生变化/.test(error.message)) throw error;
                    lastError = error;
                    console.warn('[考试助手] ' + label + ' 查询失败:', error.message);
                    applied = handleMiss(snapshot, label) ? 'random' : 'skip';
                }
            }

            await sleep(150);   // 等页面把选中状态渲染出来再记录
            recordAnswerLog(label, snapshot, logAnswer, logSource, applied, lastError);

            if (applied === 'bank') {
                consecutiveFailures = 0;
            } else {
                // 只有真正用到题库答案才算成功；随机/跳过都计失败，避免题库持续异常时一路随机到底
                if (countFailure) consecutiveFailures++;
                setStatus(label + (applied === 'random' ? ' 已随机作答（请自行核对）' : ' 未填写，已跳过'));
                if (countFailure && consecutiveFailures >= 3) {
                    throw new Error('连续 3 题未能使用题库答案' +
                        (lastError ? '（' + lastError.message + '）' : '') + '，已停止。请到「题库设置」里检查题库配置后重试');
                }
            }

            if (index + 1 < total) {
                await sleep(QUESTION_INTERVAL_MS);
                snapshot = await moveToQuestion(index + 1, index + 2, '下一题', total);
            }
        }
        setStatus('已处理完 ' + total + ' 题，请检查后手动提交');
        console.log('[考试助手] 自动答题处理完成，停留在最后一题，请自行检查后提交。');
    }

    function runExamMode() {
        var runToken = ++examRunToken;
        // 用户取消或重新开始后，旧请求的回调一律丢弃
        function isCurrent() { return runToken === examRunToken && examPreparing; }
        function fail(message) { if (isCurrent()) failStart(message); }

        function startAnswering(paperData) {
            if (!isCurrent()) return;
            if (autoAnswerRunning) { failStart('自动答题正在进行，请勿重复启动'); return; }
            autoAnswerRunning = true;
            examPreparing = false;
            updateExamButton();
            (async function () {
                try {
                    if (!Array.isArray(paperData)) throw new Error('试卷数据不是题目分组数组');
                    var questions = paperData.reduce(function (items, section) {
                        if (!section || !Array.isArray(section.subjects)) throw new Error('试卷题目分组无效');
                        return items.concat(section.subjects.map(function (subject) {
                            if (!subject || subject.subjectId == null) throw new Error('试卷题目缺少 ID');
                            return { subject: subject };
                        }));
                    }, []);
                    if (!questions.length) throw new Error('试卷没有可用题目');
                    await answerAllQuestions(questions);
                } catch (error) {
                    if (error.userStop) {
                        setStatus('已手动停止自动答题');
                    } else {
                        console.error('[考试助手] 自动答题已停止:', error);
                        setStatus('已停止：' + error.message);
                        alert('自动答题已停止：' + error.message);
                    }
                } finally {
                    autoAnswerRunning = false;
                    examPreparing = false;
                    stopRequested = false;
                    updateExamButton();
                }
            })();
        }

        function parseJson(text, what) {
            try { return JSON.parse(text); }
            catch (error) { throw new Error(what + '返回内容不是合法 JSON'); }
        }

        // 本地缓存的试卷结构不可靠，校验失败就回源请求
        function readCachedPaper(examuserId) {
            try {
                var raw = localStorage.getItem('exam-paper-' + examuserId);
                if (!raw) return null;
                var parsed = JSON.parse(raw);
                var paper = parsed && parsed.value && parsed.value.paper;
                if (!Array.isArray(paper) || !paper.length) return null;
                if (!paper.every(function (section) { return section && Array.isArray(section.subjects); })) return null;
                console.log('[考试助手] 使用本地缓存试卷。');
                return paper;
            } catch (error) {
                console.warn('[考试助手] 本地缓存试卷解析失败，改用接口获取:', error.message);
                return null;
            }
        }

        function getJson(url, what, onData, headers) {
            var handle = GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: headers || {},
                timeout: EXAM_API_TIMEOUT_MS,
                onload: function (response) {
                    activeRequests.delete(handle);
                    if (!isCurrent()) return;
                    try {
                        if (response.status < 200 || response.status >= 300) {
                            console.error('[考试助手] ' + what + '失败:', response.status);
                            fail(what + '失败，HTTP ' + response.status);
                            return;
                        }
                        onData(parseJson(response.responseText, what));
                    } catch (error) {
                        console.error('[考试助手] ' + what + '处理失败:', error);
                        fail(what + '失败：' + error.message);
                    }
                },
                onerror: function (error) {
                    activeRequests.delete(handle);
                    console.error('[考试助手] ' + what + '请求失败:', error);
                    fail(what + '失败：网络错误，请检查网络或确认已登录易班');
                },
                ontimeout: function () {
                    activeRequests.delete(handle);
                    fail(what + '超时，请重试');
                },
                onabort: function () { activeRequests.delete(handle); }
            });
            trackRequest(handle);
        }

        try {
            if (window.location.href.includes('/review/')) { fail('当前是回顾页，请使用「强制看题」。'); return; }
            var examIdMatch = window.location.href.match(/exam\/(\d+)/);
            var examId = examIdMatch ? examIdMatch[1] : null;
            if (!examId) { fail('未能从 URL 中解析出 examId'); return; }
            var loginProblem = missingLoginInfo();
            if (loginProblem) { fail(loginProblem); return; }
            console.log('[考试助手] 考试ID:', examId);

            getJson(examApi('exam/setting/get', { examId: examId, userId: userId, token: userToken, yibanId: yibanId }), '获取考试信息', function (responseData) {
                if (!responseData.result) { fail('获取 examuserId 失败'); return; }
                var examuserId = responseData.data && responseData.data.examuserId;
                if (!examuserId) { fail('接口未返回 examuserId'); return; }

                var cached = readCachedPaper(examuserId);
                if (cached) { startAnswering(cached); return; }

                getJson(examApi('exam/paper/get', { examuserId: examuserId, token: userToken, yibanId: yibanId }), '获取试卷', function (paperData) {
                    if (paperData.result) startAnswering(paperData.data);
                    else fail('题目获取失败！');
                }, { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' });
            });
        } catch (error) {
            console.error('[考试助手] 自动答题脚本出错:', error);
            fail('自动答题脚本出错：' + error.message);
        }
    }

    /* ================= 开始 / 停止 按钮 ================= */

    function failStart(message) {
        examPreparing = false;
        updateExamButton();
        alert(message);
    }

    function checkStopRequested() {
        if (stopRequested) throw makeStopError();
    }

    function updateExamButton() {
        var button = document.getElementById('hp-exam-btn');
        if (!button) return;
        var active = autoAnswerRunning || examPreparing;
        button.classList.toggle('hp-primary', active);
        button.textContent = stopRequested && autoAnswerRunning ? '正在停止…'
            : autoAnswerRunning ? '停止自动答题'
            : examPreparing ? '获取试卷中…'
            : '开始自动答题';
        button.title = autoAnswerRunning ? '点击停止' : examPreparing ? '点击取消' : '';
    }

    // 进入或刷新页面时按钮为未点亮状态，必须手动点击才开始；运行中再次点击则停止
    function onExamButtonClick() {
        if (autoAnswerRunning) {
            if (stopRequested) return;
            stopRequested = true;
            abortActiveRequests();   // 立刻中断正在等待的题库请求
            setStatus('正在停止…');
            updateExamButton();
            return;
        }
        if (examPreparing) {
            // 获取试卷阶段直接取消，过期回调会被 examRunToken 丢弃
            examRunToken++;
            examPreparing = false;
            abortActiveRequests();
            updateExamButton();
            setStatus('已取消自动答题');
            return;
        }
        var problem = bankConfigProblem();
        if (problem) {
            alert(problem + '，请先点击「题库设置」添加自定义题库。');
            return;
        }
        examPreparing = true;
        stopRequested = false;
        updateExamButton();
        runExamMode();
    }

    /* ================= 答题日志 ================= */

    function readAnswerLog() {
        try {
            var list = JSON.parse(GM_getValue(ANSWER_LOG_KEY, '[]') || '[]');
            return Array.isArray(list) ? list : [];
        } catch (error) {
            return [];
        }
    }

    function describeFilled(snapshot) {
        var latest = readCurrentQuestionSnapshot();
        var target = latest && sameQuestionRender(snapshot, latest) ? latest : snapshot;
        if (target.kind === 'choice') {
            var picked = [];
            target.optionItems.forEach(function (item, index) {
                if (isChoiceItemSelected(item)) picked.push(LETTERS[index] + '. ' + (target.optionTexts[index] || ''));
            });
            return picked.join('\n');
        }
        return target.inputs.map(function (input, index) { return '空' + (index + 1) + '：' + input.value; }).join('\n');
    }

    function recordAnswerLog(label, snapshot, rawAnswer, source, applied, error) {
        try {
            var examMatch = window.location.href.match(/exam\/(\d+)/);
            var entry = {
                time: new Date().toLocaleString(),
                examId: examMatch ? examMatch[1] : '',
                label: label,
                type: snapshot.kind === 'choice' ? (snapshot.multiple === true ? '多选' : snapshot.multiple === false ? '单选' : '选择') : '填空',
                question: snapshot.titleText || '',
                options: (snapshot.optionTexts || []).map(function (text, index) { return LETTERS[index] + '. ' + text; }),
                answer: rawAnswer || '',
                source: source || '',
                result: applied === 'bank' ? '题库作答' : applied === 'random' ? '随机作答' : '未填写',
                filled: describeFilled(snapshot),
                error: error ? error.message : ''
            };
            var list = readAnswerLog();
            list.push(entry);
            if (list.length > ANSWER_LOG_MAX) list = list.slice(-ANSWER_LOG_MAX);
            GM_setValue(ANSWER_LOG_KEY, JSON.stringify(list));
            if (document.getElementById('hp-log-mask')) renderAnswerLog();
        } catch (e) {
            console.warn('[考试助手] 写入答题日志失败:', e);
        }
    }

    function formatLogEntry(entry) {
        var lines = ['[' + entry.time + '] ' + entry.label + '（' + entry.type + '）' + entry.result];
        lines.push('题目：' + entry.question);
        if (entry.options && entry.options.length) lines.push('选项：' + entry.options.join('  '));
        lines.push('答案：' + (entry.answer || '（无）') + (entry.source ? '  ← ' + entry.source : ''));
        if (entry.filled) lines.push('已填：' + entry.filled.replace(/\n/g, '；'));
        if (entry.error) lines.push('说明：' + entry.error);
        return lines.join('\n');
    }

    function renderAnswerLog() {
        var body = document.getElementById('hp-log-body');
        var count = document.getElementById('hp-log-count');
        if (!body) return;
        var list = readAnswerLog();
        if (count) count.textContent = '共 ' + list.length + ' 条';
        body.textContent = '';
        if (!list.length) {
            var empty = document.createElement('p');
            empty.style.cssText = 'margin:24px 0;text-align:center;color:#94a3b8;font-size:13px;';
            empty.textContent = '暂无答题日志，点击「开始自动答题」后会在这里记录每道题的题目和答案。';
            body.appendChild(empty);
            return;
        }
        var colors = { '题库作答': '#059669', '随机作答': '#d97706', '未填写': '#dc2626' };
        list.slice().reverse().forEach(function (entry) {
            var card = document.createElement('div');
            card.style.cssText = 'border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.6;';

            var head = document.createElement('div');
            head.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:#64748b;margin-bottom:4px;';
            var tag = document.createElement('span');
            tag.style.cssText = 'color:#fff;border-radius:4px;padding:0 6px;background:' + (colors[entry.result] || '#64748b') + ';';
            tag.textContent = entry.result;
            var meta = document.createElement('span');
            meta.textContent = entry.label + ' · ' + entry.type + ' · ' + entry.time + (entry.examId ? ' · 考试 ' + entry.examId : '');
            head.appendChild(tag);
            head.appendChild(meta);
            card.appendChild(head);

            function row(name, value, style) {
                if (!value) return;
                var line = document.createElement('div');
                line.style.cssText = 'white-space:pre-wrap;' + (style || '');
                var strong = document.createElement('strong');
                strong.textContent = name + '：';
                line.appendChild(strong);
                line.appendChild(document.createTextNode(value));
                card.appendChild(line);
            }
            row('题目', entry.question, 'color:#1e293b;');
            row('选项', entry.options && entry.options.length ? entry.options.join('\n') : '', 'color:#475569;');
            row('答案', (entry.answer || '（无）') + (entry.source ? '　← ' + entry.source : ''), 'color:#4338CA;');
            row('已填', entry.filled, 'color:#334155;');
            row('说明', entry.error, 'color:#dc2626;font-size:12px;');
            body.appendChild(card);
        });
    }

    function openAnswerLog() {
        var old = document.getElementById('hp-log-mask');
        if (old) old.remove();

        var mask = document.createElement('div');
        mask.id = 'hp-log-mask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
        mask.innerHTML =
            '<div style="background:#fff;border-radius:12px;width:720px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#334155;">' +
            '  <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #e5e7eb;">' +
            '    <strong style="font-size:15px;">答题日志</strong>' +
            '    <span id="hp-log-count" style="font-size:12px;color:#94a3b8;flex:1;"></span>' +
            '    <button id="hp-log-copy" style="border:1px solid #e2e8f0;background:#f8fafc;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">复制全部</button>' +
            '    <button id="hp-log-clear" style="border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">清空</button>' +
            '    <button id="hp-log-close" style="border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#94a3b8;">&times;</button>' +
            '  </div>' +
            '  <div id="hp-log-body" style="padding:14px 18px;overflow:auto;"></div>' +
            '</div>';
        document.body.appendChild(mask);

        function close() { mask.remove(); }
        mask.addEventListener('click', function (event) { if (event.target === mask) close(); });
        mask.querySelector('#hp-log-close').addEventListener('click', close);
        mask.querySelector('#hp-log-clear').addEventListener('click', function () {
            if (!confirm('确定清空全部答题日志？')) return;
            GM_setValue(ANSWER_LOG_KEY, '[]');
            renderAnswerLog();
        });
        mask.querySelector('#hp-log-copy').addEventListener('click', function () {
            var copyButton = this;
            var text = readAnswerLog().map(formatLogEntry).join('\n\n');
            if (!text) return;
            var done = function () { copyButton.textContent = '已复制'; setTimeout(function () { copyButton.textContent = '复制全部'; }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
            } else {
                fallbackCopy(text);
                done();
            }
        });
        renderAnswerLog();
    }

    function fallbackCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } catch (error) { /* 忽略 */ }
        area.remove();
    }

    /* ================= 回顾页：正确答案显示 ================= */

    function readReviewSubject(hidden, examId) {
        var root = document.getElementById('root');
        if (!root) return null;
        var key = Object.keys(root).find(function (name) { return /^__react(Container|Fiber)/.test(name); });
        var fiber = key && root[key];
        var current = (fiber && fiber.stateNode && fiber.stateNode.current) || fiber;
        var pending = current ? [current] : [];
        var visited = new Set();
        while (pending.length && visited.size < 20000) {
            var node = pending.pop();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            if (node.stateNode === hidden) {
                for (var parent = node; parent; parent = parent.return) {
                    var props = parent.memoizedProps;
                    if (props && props.review === true && String(props.examId) === examId &&
                        props.subject && props.subject.subjectId != null) return props.subject;
                }
                return null;
            }
            if (node.sibling) pending.push(node.sibling);
            if (node.child) pending.push(node.child);
        }
        return null;
    }

    function readReviewSnapshot(container, examId, hidden) {
        var h3 = container.querySelector('h3');
        var titleText = '';
        if (h3) {
            var clone = h3.cloneNode(true);
            var cloneInputs = clone.querySelectorAll('input, textarea');
            for (var ci = 0; ci < cloneInputs.length; ci++) {
                cloneInputs[ci].replaceWith(document.createTextNode(' {{blank}} '));
            }
            titleText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        } else {
            var subject = readReviewSubject(hidden, examId);
            if (subject && typeof subject.title === 'string') {
                titleText = normText(String(subject.title).replace(/<input[^>]*>/gi, ' {{blank}} '));
            }
        }
        if (!titleText) return null;

        var optionRawTexts = Array.prototype.slice.call(container.querySelectorAll('ul li')).map(function (item) {
            var textNode = item.querySelector('.flex-auto') || item;
            return (textNode.textContent || '').trim();
        });
        var inputs = container.querySelectorAll('input.exam-input, input[type=text], input:not([type]), textarea');
        var kind = optionRawTexts.length ? 'choice' : 'blank';
        var blankInputs = kind === 'blank' ? inputs.length : 0;
        var blankCount = blankInputs || (titleText.match(/\{\{\s*blank\s*\}\}/gi) || []).length;
        var heading = document.querySelector('main h2');
        var headingText = heading ? heading.textContent || '' : '';
        var hasCheckbox = Boolean(container.querySelector('input[type=checkbox]'));

        return {
            kind: kind,
            multiple: kind === 'choice' ? hasCheckbox : null,
            titleText: titleText,
            titleKey: normalizeTitleForMatch(titleText),
            optionRawTexts: optionRawTexts,
            optionTexts: optionRawTexts.map(normalizeOptionForMatch),
            blankCount: blankCount,
            headingText: headingText
        };
    }

    function formatAnswerText(snapshot, rawAnswer) {
        if (snapshot.kind === 'choice') {
            var indices = resolveChoiceIndices(snapshot, rawAnswer);
            if (!indices) return '正确答案：' + rawAnswer;
            return '正确答案：' + indices.map(function (index) {
                return LETTERS[index] + '. ' + snapshot.optionTexts[index];
            }).join('；');
        }
        var values = resolveBlankValues(snapshot, rawAnswer);
        if (!values) return '正确答案：' + rawAnswer;
        return '正确答案：' + values.map(function (value, index) {
            return '第 ' + (index + 1) + ' 空：' + value;
        }).join('；');
    }

    function ensureReviewBox(container) {
        var box = container.querySelector('.exam-helper-review-answer');
        if (box) return box;
        box = document.createElement('div');
        box.className = 'exam-helper-review-answer';
        box.style.cssText = 'margin:12px 0;padding:10px 12px;border:1px solid #a7f3d0;border-radius:8px;background:#ecfdf5;color:#065f46;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;';
        container.appendChild(box);
        return box;
    }

    function hideReviewAnswer(hidden) {
        if (!has(hidden.dataset, 'helperAnswerDisplay')) hidden.dataset.helperAnswerDisplay = hidden.style.display;
        hidden.style.display = 'none';
    }

    function restoreReviewAnswer(hidden) {
        if (has(hidden.dataset, 'helperAnswerDisplay')) {
            hidden.style.display = hidden.dataset.helperAnswerDisplay;
            delete hidden.dataset.helperAnswerDisplay;
        }
    }

    // 回顾页限流：同时最多 REVIEW_MAX_CONCURRENT 道题在查询，其余排队
    function withReviewSlot(task) {
        return new Promise(function (resolve, reject) {
            function run() {
                reviewActiveLookups++;
                Promise.resolve().then(task).then(resolve, reject).finally(function () {
                    reviewActiveLookups--;
                    var next = reviewLookupQueue.shift();
                    if (next) next();
                });
            }
            if (reviewActiveLookups < REVIEW_MAX_CONCURRENT) run();
            else reviewLookupQueue.push(run);
        });
    }

    async function fillReviewAnswer(container, hidden, examId, box, snapshot) {
        box = box || ensureReviewBox(container);
        // 关键：await 之前必须先落 pending，否则本轮 MutationObserver 会反复重入、并发打接口
        box.dataset.helperState = 'pending';
        box.textContent = '排队等待查询…';

        snapshot = snapshot || readReviewSnapshot(container, examId, hidden);
        if (!snapshot) {
            // 不写终态：题干可能只是还没渲染完，1.5s 后允许再试一次，最多 3 次
            restoreReviewAnswer(hidden);
            var tries = Number(box.dataset.helperTries || 0) + 1;
            box.dataset.helperTries = String(tries);
            if (tries < 3) {
                box.textContent = '题干未渲染完成，稍后重试（' + tries + '/3）';
                setTimeout(function () {
                    if (box.isConnected && box.dataset.helperState === 'pending') {
                        delete box.dataset.helperState;
                        renderHiddenReviewAnswers();
                    }
                }, 1500);
            } else {
                box.textContent = '无法识别该题题干，已放弃';
                box.dataset.helperState = 'noop';
            }
            return;
        }
        hideReviewAnswer(hidden);
        var key = box.dataset.helperKey;
        try {
            var found = await withReviewSlot(function () {
                // 排队期间题目被移除或换成别的题，就不再发请求
                if (!box.isConnected || box.dataset.helperKey !== key) return null;
                box.textContent = '正在查询题库…';
                return lookupAnswer(snapshot);
            });
            if (!found || !box.isConnected || box.dataset.helperKey !== key) return;
            box.textContent = formatAnswerText(snapshot, found.answer);
            box.dataset.helperState = 'done';
        } catch (error) {
            if (!box.isConnected || box.dataset.helperKey !== key) return;
            box.textContent = '题库查询失败：' + error.message + '（点击重试）';
            box.dataset.helperState = 'error';
            box.title = '点击重试本题';
        }
    }

    function bindReviewBoxRetry(box) {
        if (box.dataset.retryBound) return;
        box.dataset.retryBound = '1';
        box.addEventListener('click', function () {
            if (box.dataset.helperState !== 'error' && box.dataset.helperState !== 'noop') return;
            delete box.dataset.helperState;
            delete box.dataset.helperTries;
            box.textContent = '正在重试…';
            renderHiddenReviewAnswers();
        });
    }

    function renderHiddenReviewAnswers() {
        var match = window.location.href.match(/group\/\d+\/exam\/(\d+)\/review\/\d+/);
        var hiddenItems = match ? Array.prototype.slice.call(document.querySelectorAll('main .hideanswer')) : [];
        var activeBoxes = new Set();
        hiddenItems.forEach(function (hidden) {
            var container = hidden.parentElement;
            if (!container) return;
            var box = ensureReviewBox(container);
            var snapshot = readReviewSnapshot(container, match[1], hidden);
            var key = snapshot ? snapshot.titleKey : '';

            if (box.dataset.helperKey !== undefined && box.dataset.helperKey !== key) {
                // 容器被复用渲染成了另一道题：状态作废重查
                delete box.dataset.helperState;
                delete box.dataset.helperTries;
                box.textContent = '';
            }
            box.dataset.helperKey = key;
            bindReviewBoxRetry(box);
            activeBoxes.add(box);
            // pending / done / error / noop 都跳过：await 期间不会重复发请求，error 与 noop 只能点击重试
            if (box.dataset.helperState) return;
            fillReviewAnswer(container, hidden, match[1], box, snapshot);
        });
        document.querySelectorAll('.exam-helper-review-answer').forEach(function (box) {
            if (!activeBoxes.has(box)) {
                // 删除前恢复被隐藏的原始答案块，避免整块永久不可见
                var container = box.parentElement;
                var hidden = container ? container.querySelector('.hideanswer') : null;
                if (hidden) restoreReviewAnswer(hidden);
                box.remove();
            }
        });
        if (!match) {
            document.querySelectorAll('[data-helper-answer-display]').forEach(restoreReviewAnswer);
        }
    }

    var HELPER_SELECTOR = '.exam-helper-review-answer, #helper-panel, #hp-log-mask, #hp-settings-mask';

    function isHelperNode(node) {
        var element = node && (node.nodeType === 1 ? node : node.parentElement);
        return Boolean(element && element.closest && element.closest(HELPER_SELECTOR));
    }

    function isHelperMutation(mutation) {
        if (isHelperNode(mutation.target)) return true;
        if (mutation.type !== 'childList') return false;
        var nodes = Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes));
        return nodes.length > 0 && nodes.every(function (node) {
            return node.nodeType === 1 && typeof node.matches === 'function' && node.matches(HELPER_SELECTOR);
        });
    }

    function startReviewAnswerDisplay() {
        if (reviewAnswerObserver) { renderHiddenReviewAnswers(); return; }
        reviewAnswerObserver = new MutationObserver(function (mutations) {
            // 脚本自己改答案框引起的变化不处理，避免自我触发反复全量扫描
            if (mutations.every(isHelperMutation)) return;
            clearTimeout(reviewRenderTimer);
            reviewRenderTimer = setTimeout(renderHiddenReviewAnswers, 120);
        });
        reviewAnswerObserver.observe(document.getElementById('root') || document.body, { childList: true, subtree: true, characterData: true });
        renderHiddenReviewAnswers();
    }

    function autoStartReviewDisplay() {
        if (!/group\/\d+\/exam\/\d+\/review\/\d+/.test(window.location.href)) return;
        console.log('[考试助手] 回顾页检测到，开始用自定义题库补全正确答案。');
        startReviewAnswerDisplay();
    }

    /* ================= 强制看题 ================= */

    function forcevieExam() {
        var url = window.location.href;

        var reviewMatch = url.match(/group\/(\d+)\/exam\/(\d+)\/review\/(\d+)/);
        if (reviewMatch) {
            startReviewAnswerDisplay();
            return;
        }

        var resultMatch = url.match(/group\/(\d+)\/exam\/(\d+)/);
        if (!resultMatch) {
            alert('请先打开一场考试的结果页或回顾页，再点击「强制看题」。');
            return;
        }
        var loginProblem = missingLoginInfo();
        if (loginProblem) { alert(loginProblem); return; }
        var groupId = resultMatch[1];
        var examId = resultMatch[2];
        console.log('[考试助手] 强制看题，考试ID:', examId);
        GM_xmlhttpRequest({
            method: 'GET',
            url: examApi('exam/result/get', { userId: userId, token: userToken, yibanId: yibanId, examId: examId }),
            timeout: EXAM_API_TIMEOUT_MS,
            onload: function (response) {
                if (response.status < 200 || response.status >= 300) {
                    alert('接口请求失败: ' + response.status);
                    return;
                }
                var responseData;
                try { responseData = JSON.parse(response.responseText); }
                catch (error) { alert('接口返回内容不是合法 JSON'); return; }
                var examuserId = responseData.data && responseData.data.examuserId;
                if (responseData.result && examuserId) {
                    location.href = 'https://exam.yooc.me/group/' + encodeURIComponent(groupId) + '/exam/' +
                        encodeURIComponent(examId) + '/review/' + encodeURIComponent(examuserId);
                } else {
                    alert('未能成功获取 examuserId，可能是还未参加过这场考试。');
                }
            },
            onerror: function (error) {
                console.error('[考试助手] 强制看题请求失败:', error);
                alert('强制看题失败：网络错误，请检查网络或确认已登录易班');
            },
            ontimeout: function () { alert('强制看题请求超时，请重试'); }
        });
    }

    /* ================= 控制面板 ================= */

    function createControlPanel() {
        GM_addStyle(`
            #helper-panel {
                position: fixed; top: 50%; left: 16px; transform: translateY(-50%);
                background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 10px;
                box-shadow: 0 8px 28px rgba(15,23,42,0.12); z-index: 9999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                box-sizing: border-box; width: 116px; max-width: calc(100vw - 32px);
                max-height: calc(100vh - 32px); overflow-y: auto; overflow-wrap: anywhere; color: #334155;
            }
            #helper-panel .hp-title { margin: 0; font-size: 15px; font-weight: 600; color: #1e293b; text-align: center; line-height: 1.4; }
            #helper-panel .hp-status { margin: 6px 0 10px; font-size: 11px; color: #059669; text-align: center; line-height: 1.5; }
            #helper-panel button {
                display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; margin: 0 0 6px;
                border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; color: #334155;
                font-size: 13px; cursor: pointer; text-align: center;
            }
            #helper-panel button:hover { background: #eef2ff; border-color: #c7d2fe; }
            #helper-panel button.hp-primary { background: #4338CA; border-color: #4338CA; color: #fff; font-weight: 600; }
            #helper-panel button.hp-primary:hover { background: #3730a3; }
            #helper-panel button:disabled { opacity: 0.5; cursor: default; }
            #helper-panel .hp-related-label {
                display: flex; align-items: center; gap: 6px; margin: 8px 0 4px;
                font-size: 12px; color: #475569; cursor: pointer;
            }
            #helper-panel .hp-related-hint { margin: 4px 0 0; font-size: 11px; color: #94a3b8; line-height: 1.5; }
        `);

        var panel = document.createElement('div');
        panel.id = 'helper-panel';
        panel.innerHTML = '<p class="hp-title">考试助手</p><p class="hp-status" id="hp-status">自定义题库版<br>每题实时查询</p>';

        var examButton = document.createElement('button');
        examButton.id = 'hp-exam-btn';
        examButton.textContent = '开始自动答题';   // 默认不点亮，需手动开始
        examButton.addEventListener('click', onExamButtonClick);

        var forceviewButton = document.createElement('button');
        forceviewButton.textContent = '强制看题';
        forceviewButton.addEventListener('click', forcevieExam);

        panel.appendChild(examButton);
        panel.appendChild(forceviewButton);

        var settingsButton = document.createElement('button');
        settingsButton.textContent = '题库设置';
        settingsButton.addEventListener('click', openSettings);
        panel.appendChild(settingsButton);

        var logButton = document.createElement('button');
        logButton.textContent = '答题日志';
        logButton.addEventListener('click', openAnswerLog);
        panel.appendChild(logButton);

        var randomLabel = document.createElement('label');
        randomLabel.className = 'hp-related-label';
        randomLabel.title = '题库未命中时，选择题随机作答';
        var randomSwitch = document.createElement('input');
        randomSwitch.type = 'checkbox';
        randomSwitch.checked = randomOnMissEnabled();
        randomSwitch.addEventListener('change', function () {
            GM_setValue(RANDOM_ON_MISS_KEY, randomSwitch.checked);
            console.log('[考试助手] 未命中随机作答已' + (randomSwitch.checked ? '开启' : '关闭'));
        });
        randomLabel.appendChild(randomSwitch);
        var randomText = document.createElement('span');
        randomText.textContent = '未命中随机作答';
        randomLabel.appendChild(randomText);
        panel.appendChild(randomLabel);

        var status = document.createElement('p');
        status.id = 'hp-ai-status';
        status.className = 'hp-related-hint';
        status.setAttribute('role', 'status');
        panel.appendChild(status);

        document.body.appendChild(panel);
        console.log('[考试助手] 操作面板已注入。');
    }

    /* ================= 设置面板：自定义题库 ================= */

    const BANK_EXAMPLE = [
        {
            name: 'AI智能题库',
            homepage: 'https://example.com/',
            url: 'https://example.com/api/search?api_key=YOUR_KEY',
            method: 'post',
            contentType: 'json',
            data: { title: '${title}', type: '${type}', options: '${options}' },
            handler: 'return (res)=> res.code === 1 && res.answer ? [res.question, res.answer] : undefined'
        }
    ];

    function handlersIn(raw) {
        try {
            var parsed = JSON.parse(String(raw || '').trim() || '[]');
            var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.banks) ? parsed.banks : []);
            return list.filter(function (bank) {
                return bank && typeof bank.handler === 'string' && bank.handler.trim() && bank.enabled !== false;
            }).map(function (bank) { return bank.handler.trim(); });
        } catch (error) {
            return [];
        }
    }

    // handler 会以脚本权限执行；新出现的 handler 需要用户确认来源可信
    function confirmNewHandlers(raw) {
        var trusted = new Set(handlersIn(GM_getValue(KEY_BANKS, '')));
        var fresh = handlersIn(raw).filter(function (code) { return !trusted.has(code) && !approvedHandlers.has(code); });
        if (!fresh.length) return true;
        var ok = confirm('配置里有 ' + fresh.length + ' 段新的 handler 代码。\n\n' +
            'handler 会以脚本权限运行，能读取你的易班登录信息并向外发送请求。\n' +
            '只有在你清楚它的来源、确认可信时才继续。\n\n确定继续吗？');
        if (ok) fresh.forEach(function (code) { approvedHandlers.add(code); });
        return ok;
    }

    function openSettings() {
        var old = document.getElementById('hp-settings-mask');
        if (old) old.remove();

        var banksRaw = String(GM_getValue(KEY_BANKS, '') || '');
        var mask = document.createElement('div');
        mask.id = 'hp-settings-mask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';

        var smallButton = 'padding:6px 12px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;font-size:12px;cursor:pointer;';
        mask.innerHTML =
            '<div style="background:#fff;border-radius:12px;width:720px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#334155;">' +
            '  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #e5e7eb;">' +
            '    <strong style="font-size:15px;">题库设置</strong>' +
            '    <button id="hp-set-close" style="border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#94a3b8;">&times;</button>' +
            '  </div>' +
            '  <div style="padding:14px 18px;overflow:auto;">' +
            '    <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:8px;">' +
            '      粘贴 JSON 数组，支持多个题库，按顺序尝试、命中即停。字段：<code>name</code> 名称、<code>url</code> 接口地址、<code>method</code> GET/POST、' +
            '      <code>contentType</code> json/form、<code>data</code> 请求体（可用 <code>${title}</code> <code>${type}</code> <code>${options}</code> 占位，url 里也能用）、' +
            '      <code>timeout</code> 超时毫秒（默认 ' + DEFAULT_BANK_TIMEOUT_MS + '）、<code>enabled</code> 设为 false 可临时停用、' +
            '      <code>handler</code> 解析函数源码（可选），例如 <code>return (res)=> res.code === 1 &amp;&amp; res.answer ? [res.question, res.answer] : undefined</code>，' +
            '      返回 <code>[题目, 答案]</code> 即命中，返回 undefined 视为未命中；不写 handler 时默认读取响应的 <code>code</code>（需为 1）与 <code>answer</code> 字段。' +
            '    </div>' +
            '    <div style="font-size:12px;line-height:1.6;margin-bottom:8px;padding:8px 10px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;">' +
            '      ⚠ <b>handler 是一段 JavaScript，会以脚本权限运行</b>，能读取你的易班登录信息并向外发送请求。只粘贴你信任来源的配置。<br>' +
            '      题干和选项会发送到你配置的题库地址（http 与 https 均可）。首次请求新域名时 Tampermonkey 可能弹窗询问，请选「总是允许」，否则会报“网络请求失败”。' +
            '    </div>' +
            '    <textarea id="hp-set-banks" spellcheck="false" style="width:100%;box-sizing:border-box;height:240px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;font-family:monospace;line-height:1.5;resize:vertical;"></textarea>' +
            '    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center;">' +
            '      <button id="hp-set-banks-example" style="' + smallButton + '">填入示例</button>' +
            '      <button id="hp-set-banks-clear" style="' + smallButton + '">清空</button>' +
            '      <button id="hp-set-banks-check" style="' + smallButton + '">校验 JSON</button>' +
            '      <button id="hp-set-banks-test" style="' + smallButton + 'border-color:#c7d2fe;background:#eef2ff;">测试题库</button>' +
            '      <span id="hp-set-banks-result" style="font-size:12px;color:#64748b;"></span>' +
            '    </div>' +
            '    <pre id="hp-set-test-output" style="display:none;margin:8px 0 0;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;"></pre>' +
            '  </div>' +
            '  <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #e5e7eb;">' +
            '    <button id="hp-set-save" style="padding:8px 18px;border:1px solid #4338CA;background:#4338CA;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">保存</button>' +
            '  </div>' +
            '</div>';

        document.body.appendChild(mask);

        var $ = function (id) { return document.getElementById(id); };
        $('hp-set-banks').value = banksRaw;

        function close() { mask.remove(); }
        $('hp-set-close').addEventListener('click', close);
        mask.addEventListener('click', function (event) { if (event.target === mask) close(); });

        function showResult(text, ok) {
            $('hp-set-banks-result').textContent = text;
            $('hp-set-banks-result').style.color = ok ? '#059669' : '#dc2626';
        }

        $('hp-set-banks-example').addEventListener('click', function () {
            $('hp-set-banks').value = JSON.stringify(BANK_EXAMPLE, null, 2);
        });
        $('hp-set-banks-clear').addEventListener('click', function () {
            $('hp-set-banks').value = '';
            $('hp-set-banks-result').textContent = '';
            $('hp-set-test-output').style.display = 'none';
        });
        $('hp-set-banks-check').addEventListener('click', function () {
            var result = validateBanksInput($('hp-set-banks').value);
            showResult(result.ok ? (result.count ? '校验通过，可用题库 ' + result.count + ' 个' : '内容为空') : result.message, result.ok);
        });

        $('hp-set-banks-test').addEventListener('click', async function () {
            var testButton = this;
            var raw = $('hp-set-banks').value;
            var check = validateBanksInput(raw);
            if (!check.ok) { showResult(check.message, false); return; }
            if (!check.count) { showResult('请先填写题库配置', false); return; }
            if (!confirmNewHandlers(raw)) return;
            var banks = normalizeBankList(JSON.parse(raw));
            var output = $('hp-set-test-output');
            var sample = SAMPLE_SNAPSHOT();
            output.style.display = 'block';
            output.textContent = '测试题目：' + sample.titleText + '（' + sample.optionTexts.join(' / ') + '）\n';
            testButton.disabled = true;
            showResult('测试中…', true);
            var hits = 0;
            for (var i = 0; i < banks.length; i++) {
                var line = '「' + banks[i].name + '」';
                try {
                    var answer = await queryCustomBank(banks[i], sample);
                    if (answer) { hits++; line += '可用，返回答案：' + answer; }
                    else line += '请求成功，但没有解析出答案（检查 handler 或返回格式）';
                } catch (error) {
                    line += '不可用：' + error.message;
                }
                output.textContent += line + '\n';
            }
            testButton.disabled = false;
            showResult('测试完成：' + hits + '/' + banks.length + ' 个返回了答案', hits > 0);
        });

        $('hp-set-save').addEventListener('click', function () {
            var raw = $('hp-set-banks').value.trim();
            var check = validateBanksInput(raw);
            if (!check.ok) { showResult(check.message, false); return; }
            if (!confirmNewHandlers(raw)) return;
            GM_setValue(KEY_BANKS, raw);
            answerCache.clear();
            answerSourceCache.clear();
            banksConfigErrorReportedFor = null;
            setStatus(check.count ? '设置已保存，可用题库 ' + check.count + ' 个' : '设置已保存，当前没有配置题库');
            close();
        });
    }

    function validateBanksInput(raw) {
        var text = String(raw || '').trim();
        if (!text) return { ok: true, count: 0 };

        var parsed;
        try { parsed = JSON.parse(text); }
        catch (error) { return { ok: false, count: 0, message: 'JSON 语法错误：' + error.message }; }

        var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.banks) ? parsed.banks : null);
        if (!list) return { ok: false, count: 0, message: '顶层必须是题库数组（[...]）或 {"banks":[...]}' };

        var missingUrl = 0;
        var disabled = 0;
        var badEnum = [];
        var badHandler = [];

        list.forEach(function (bank, index) {
            var label = '第 ' + (index + 1) + ' 项';
            if (!bank || typeof bank !== 'object') { missingUrl++; return; }
            if (!(typeof bank.url === 'string' && bank.url.trim())) missingUrl++;
            if (bank.enabled === false) disabled++;
            if (bank.method !== undefined && !/^(get|post)$/i.test(String(bank.method))) {
                badEnum.push(label + ' method=' + bank.method + '（只支持 get/post）');
            }
            if (bank.contentType !== undefined && !/^(json|form)/i.test(String(bank.contentType))) {
                badEnum.push(label + ' contentType=' + bank.contentType + '（只支持 json/form）');
            }
            if (typeof bank.handler === 'string' && bank.handler.trim()) {
                try { new Function(bank.handler); }
                catch (error) { badHandler.push(label + ' handler 语法错误：' + error.message); }
            }
        });

        if (badEnum.length) return { ok: false, count: 0, message: badEnum.join('；') };
        if (badHandler.length) return { ok: false, count: 0, message: badHandler.join('；') };

        var banks = normalizeBankList(list);
        if (!banks.length) {
            if (disabled === list.length && list.length) return { ok: false, count: 0, message: '所有题库都被 enabled:false 禁用（共 ' + disabled + ' 个）' };
            if (missingUrl) return { ok: false, count: 0, message: '有 ' + missingUrl + ' 个题库缺少 url 字段' };
            return { ok: false, count: 0, message: '没有解析到可用题库' };
        }
        return { ok: true, count: banks.length, disabled: disabled };
    }

    function SAMPLE_SNAPSHOT() {
        return {
            kind: 'choice',
            multiple: false,
            titleText: '中华人民共和国的首都是哪座城市',
            titleKey: '中华人民共和国的首都是哪座城市',
            optionTexts: ['上海', '北京', '广州', '南京'],
            optionRawTexts: ['上海', '北京', '广州', '南京'],
            blankCount: 0,
            inputs: [],
            optionItems: []
        };
    }
})();





