// ==UserScript==
// @name         YouTube Split View (Player + Details & Side Comments/Recommended)
// @namespace    http://tampermonkey.net/
// @version      8.2
// @description  通常表示とスプリット表示の切り替えに心地よいスムーズアニメーション（スライド＆フェード）を追加。
// @author       Assistant
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY_POS = 'yt_sidepane_pos'; // 'right' or 'left'
    const STORAGE_KEY_TAB = 'yt_sidepane_tab'; // 'comments' or 'recommended'
    const STORAGE_KEY_WIDTH = 'yt_sidepane_width';
    const MOBILE_BREAKPOINT = 1000;
    const DRAG_THROTTLE_INTERVAL_MS = 130;

    let currentSide = localStorage.getItem(STORAGE_KEY_POS) || 'right';
    let currentTab = localStorage.getItem(STORAGE_KEY_TAB) || 'comments';
    let currentWidth = parseInt(localStorage.getItem(STORAGE_KEY_WIDTH) || '440', 10);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    let rAFId = null;
    let pendingWidth = null;
    let lastDragSyncTime = 0;

    let isWatchPage = false;
    let isActive = false;
    let currentVideoId = '';
    let isDispatchingResize = false;

    let resizeObserver = null;
    let continuationObserver = null;
    let mutObs = null;

    function getVideoId() {
        return new URLSearchParams(location.search).get('v') || '';
    }

    function isMobileView() {
        if (location.hostname.startsWith('m.')) return true;
        if (window.innerWidth < MOBILE_BREAKPOINT) return true;
        const app = document.querySelector('ytd-app');
        if (app && app.hasAttribute('is-mobile-device')) return true;
        return false;
    }

    // スタイル定義
    const style = document.createElement('style');
    style.id = 'yt-split-view-v8-style';
    style.textContent = `
        :root {
            --yt-sidepane-w: ${currentWidth}px;
            --yt-max-player-h: 46vh;
        }

        /* 祖先要素のcontain解除 */
        body.yt-sidepane-active ytd-watch-flexy,
        body.yt-sidepane-active #columns,
        body.yt-sidepane-active #primary,
        body.yt-sidepane-active #primary-inner {
            contain: none !important;
            transform: none !important;
            filter: none !important;
            perspective: none !important;
        }

        /* ================= アニメーション定義 ================= */
        ytd-watch-flexy:not([fullscreen]) #primary {
            transition: width 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        left 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        right 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        padding 0.28s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }

        ytd-watch-flexy:not([fullscreen]) #player,
        ytd-watch-flexy:not([fullscreen]) #below {
            transition: max-width 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        max-height 0.28s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }

        /* ★ドラッグリサイズ中はアニメーションを完全停止（超軽快な操作感を維持） */
        body.yt-resizing ytd-watch-flexy #primary,
        body.yt-resizing #yt-sidepane-tabs,
        body.yt-resizing ytd-watch-flexy #comments,
        body.yt-resizing ytd-watch-flexy #secondary,
        body.yt-resizing #player,
        body.yt-resizing #below {
            transition: none !important;
        }

        /* ================= メインペイン（動画・タイトル・概要） ================= */
        body.yt-sidepane-active ytd-watch-flexy:not([fullscreen]) #primary {
            position: fixed !important;
            top: 56px !important;
            bottom: 0 !important;
            width: calc(100vw - var(--yt-sidepane-w)) !important;
            max-width: none !important;
            overflow-y: auto !important;
            z-index: 2000 !important;
            padding: 12px 24px 48px 24px !important;
            box-sizing: border-box !important;
            background: var(--yt-spec-base-background, #0f0f0f) !important;
        }

        body.yt-sidepane-active.yt-sidepane-right ytd-watch-flexy:not([fullscreen]) #primary {
            left: 0 !important;
            right: auto !important;
        }
        body.yt-sidepane-active.yt-sidepane-left ytd-watch-flexy:not([fullscreen]) #primary {
            left: var(--yt-sidepane-w) !important;
            right: 0 !important;
        }

        /* 通常モード時のプレイヤー */
        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #player {
            width: 100% !important;
            max-height: var(--yt-max-player-h) !important;
            max-width: min(100%, calc(var(--yt-max-player-h) * 16 / 9)) !important;
            height: auto !important;
            aspect-ratio: 16 / 9 !important;
            margin: 0 auto 12px auto !important;
            position: relative !important;
        }

        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-outer,
        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-inner,
        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container,
        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #ytd-player,
        body.yt-sidepane-active ytd-watch-flexy:not([theater]):not([fullscreen]) #movie_player {
            width: 100% !important;
            height: 100% !important;
            max-height: var(--yt-max-player-h) !important;
        }

        /* シアターモード時のプレイヤー配置 */
        body.yt-sidepane-active ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
            position: fixed !important;
            top: 56px !important;
            width: calc(100vw - var(--yt-sidepane-w)) !important;
            max-width: calc(var(--yt-max-player-h) * 16 / 9) !important;
            height: auto !important;
            aspect-ratio: 16 / 9 !important;
            max-height: var(--yt-max-player-h) !important;
            min-height: 0 !important;
            z-index: 2005 !important;
            background: #000 !important;
            transition: width 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        left 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        right 0.28s cubic-bezier(0.16, 1, 0.3, 1) !important;
        }
        body.yt-sidepane-active.yt-sidepane-right ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
            left: 0 !important;
            right: auto !important;
        }
        body.yt-sidepane-active.yt-sidepane-left ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container {
            left: var(--yt-sidepane-w) !important;
            right: 0 !important;
        }
        body.yt-sidepane-active ytd-watch-flexy[theater]:not([fullscreen]) #primary {
            padding-top: calc(var(--yt-max-player-h) + 16px) !important;
        }

        /* タイトル・概要欄 */
        body.yt-sidepane-active ytd-watch-flexy:not([fullscreen]) #below {
            position: relative !important;
            display: block !important;
            width: 100% !important;
            max-width: min(100%, calc(var(--yt-max-player-h) * 16 / 9)) !important;
            margin: 0 auto !important;
        }

        /* ================= サイドペイン（タブバー ＆ コンテンツ） ================= */
        #yt-sidepane-tabs {
            position: fixed;
            top: 56px;
            height: 46px;
            width: var(--yt-sidepane-w);
            z-index: 2020;
            background: var(--yt-spec-base-background, #0f0f0f);
            border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            display: flex;
            align-items: center;
            padding: 0 12px;
            box-sizing: border-box;
            gap: 8px;
            opacity: 0;
            pointer-events: none;
            transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        opacity 0.25s ease !important;
        }

        /* タブバーのスライドイン */
        body.yt-sidepane-active #yt-sidepane-tabs {
            opacity: 1;
            pointer-events: auto;
            transform: translateX(0) !important;
        }
        body.yt-sidepane-right #yt-sidepane-tabs {
            right: 0;
            left: auto;
            border-left: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            transform: translateX(100%);
        }
        body.yt-sidepane-left #yt-sidepane-tabs {
            left: 0;
            right: auto;
            border-right: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            transform: translateX(-100%);
        }

        .yt-sp-tab-btn {
            background: transparent;
            color: var(--yt-spec-text-secondary, #aaa);
            border: none;
            padding: 6px 12px;
            font-size: 13px;
            font-weight: 500;
            border-radius: 16px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .yt-sp-tab-btn:hover {
            background: var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1));
            color: var(--yt-spec-text-primary, #fff);
        }
        .yt-sp-tab-btn.active {
            background: var(--yt-spec-text-primary, #fff);
            color: var(--yt-spec-base-background, #000);
            font-weight: bold;
        }

        .yt-sp-tool-btn {
            margin-left: auto;
            background: transparent;
            color: var(--yt-spec-text-primary, #fff);
            border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.2));
            border-radius: 14px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
        }

        /* サイドペイン（コメント / おすすめ）のスライドアニメーション */
        body.yt-sidepane-active ytd-watch-flexy:not([fullscreen]) #comments,
        body.yt-sidepane-active ytd-watch-flexy:not([fullscreen]) #secondary {
            position: fixed !important;
            top: 102px !important;
            bottom: 0 !important;
            width: var(--yt-sidepane-w) !important;
            max-width: 80vw !important;
            min-width: 300px !important;
            overflow-y: auto !important;
            background: var(--yt-spec-base-background, #0f0f0f) !important;
            box-sizing: border-box !important;
            display: block !important;
            padding: 12px 18px 24px 18px !important;
            transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
                        opacity 0.25s ease !important;
        }

        /* アクティブタブの可視化＆スライドイン完了 */
        body.yt-sidepane-active.yt-tab-comments ytd-watch-flexy:not([fullscreen]) #comments,
        body.yt-sidepane-active.yt-tab-recommended ytd-watch-flexy:not([fullscreen]) #secondary {
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
            z-index: 2005 !important;
            transform: translateX(0) !important;
        }

        /* 非アクティブタブの不可視化 */
        body.yt-sidepane-active.yt-tab-comments ytd-watch-flexy:not([fullscreen]) #secondary,
        body.yt-sidepane-active.yt-tab-recommended ytd-watch-flexy:not([fullscreen]) #comments {
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            z-index: 1000 !important;
        }

        /* 左右配置時のスライド開始位置（初期オフセット）とシャドウ */
        body.yt-sidepane-active.yt-sidepane-right ytd-watch-flexy:not([fullscreen]) #comments,
        body.yt-sidepane-active.yt-sidepane-right ytd-watch-flexy:not([fullscreen]) #secondary {
            right: 0 !important;
            left: auto !important;
            border-left: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            box-shadow: -4px 0 16px rgba(0, 0, 0, 0.5) !important;
            transform: translateX(100%);
        }
        body.yt-sidepane-active.yt-sidepane-left ytd-watch-flexy:not([fullscreen]) #comments,
        body.yt-sidepane-active.yt-sidepane-left ytd-watch-flexy:not([fullscreen]) #secondary {
            left: 0 !important;
            right: auto !important;
            border-right: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
            box-shadow: 4px 0 16px rgba(0, 0, 0, 0.5) !important;
            transform: translateX(-100%);
        }

        /* ================= リサイズバー ================= */
        #yt-sidepane-resizer {
            position: fixed;
            top: 56px;
            bottom: 0;
            width: 8px;
            z-index: 2025;
            cursor: col-resize;
            background: transparent;
            display: none;
            opacity: 0;
            transition: opacity 0.25s ease;
        }
        #yt-sidepane-resizer:hover, #yt-sidepane-resizer.resizing {
            background: var(--yt-spec-themed-blue, #3ea6ff);
        }
        body.yt-sidepane-active #yt-sidepane-resizer {
            display: block;
            opacity: 1;
        }
        body.yt-sidepane-right #yt-sidepane-resizer {
            right: var(--yt-sidepane-w);
            transform: translateX(50%);
        }
        body.yt-sidepane-left #yt-sidepane-resizer {
            left: var(--yt-sidepane-w);
            transform: translateX(-50%);
        }
    `;
    document.head.appendChild(style);

    // ================= UI要素生成 =================
    const tabBar = document.createElement('div');
    tabBar.id = 'yt-sidepane-tabs';

    const btnComments = document.createElement('button');
    btnComments.className = 'yt-sp-tab-btn';
    btnComments.textContent = '💬 コメント';

    const btnRecommended = document.createElement('button');
    btnRecommended.className = 'yt-sp-tab-btn';
    btnRecommended.textContent = '🎬 おすすめ';

    const btnToggleSide = document.createElement('button');
    btnToggleSide.className = 'yt-sp-tool-btn';
    btnToggleSide.textContent = '⇄ 左右切替';

    tabBar.appendChild(btnComments);
    tabBar.appendChild(btnRecommended);
    tabBar.appendChild(btnToggleSide);
    document.body.appendChild(tabBar);

    const resizer = document.createElement('div');
    resizer.id = 'yt-sidepane-resizer';
    resizer.title = 'ドラッグして幅を調整';
    document.body.appendChild(resizer);

    const heightPreserver = document.createElement('div');
    heightPreserver.id = 'yt-height-preserver';
    heightPreserver.style.display = 'none';
    heightPreserver.style.pointerEvents = 'none';
    document.body.appendChild(heightPreserver);

    function triggerResize() {
        if (!isWatchPage || isDispatchingResize) return;
        isDispatchingResize = true;
        requestAnimationFrame(() => {
            try {
                window.dispatchEvent(new Event('resize'));
            } finally {
                isDispatchingResize = false;
            }
        });
    }

    function updateDynamicPlayerHeight() {
        if (!isWatchPage) return;
        const below = document.querySelector('#below');
        let titleHeight = 240;
        if (below && below.offsetHeight > 80) {
            titleHeight = Math.min(below.offsetHeight, 300);
        }
        const availableHeight = Math.max(260, window.innerHeight - 56 - titleHeight - 32);
        document.documentElement.style.setProperty('--yt-max-player-h', `${availableHeight}px`);
    }

    // ================= タイムスタンプ直接シーク =================
    function parseTimeToSeconds(tStr) {
        if (!tStr) return null;
        const s = String(tStr).trim().toLowerCase();

        if (s.includes('h') || s.includes('m') || s.includes('s')) {
            let total = 0;
            const h = s.match(/(\d+)h/);
            const m = s.match(/(\d+)m/);
            const sec = s.match(/(\d+)s/);
            if (h) total += parseInt(h, 10) * 3600;
            if (m) total += parseInt(m, 10) * 60;
            if (sec) total += parseInt(sec, 10);
            return total;
        }

        if (s.includes(':')) {
            const parts = s.split(':').map(Number);
            if (parts.length === 2 && !parts.some(isNaN)) {
                return parts[0] * 60 + parts;
            } else if (parts.length === 3 && !parts.some(isNaN)) {
                return parts[0] * 3600 + parts * 60 + parts;
            }
        }

        const num = parseInt(s, 10);
        return isNaN(num) ? null : num;
    }

    function extractSecondsFromHrefOrText(href, text) {
        if (href) {
            try {
                const url = new URL(href, location.origin);
                const tParam = url.searchParams.get('t');
                if (tParam) {
                    const sec = parseTimeToSeconds(tParam);
                    if (sec !== null) return sec;
                }
            } catch (e) {
                const m = href.match(/[?&]t=([0-9hms]+)/i);
                if (m && m) {
                    const sec = parseTimeToSeconds(m);
                    if (sec !== null) return sec;
                }
            }
        }

        if (text) {
            const clean = text.trim();
            if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(clean)) {
                return parseTimeToSeconds(clean);
            }
        }
        return null;
    }

    function seekPlayerTo(seconds) {
        const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (moviePlayer && typeof moviePlayer.seekTo === 'function') {
            moviePlayer.seekTo(seconds, true);
            if (typeof moviePlayer.playVideo === 'function') {
                moviePlayer.playVideo();
            }
            return true;
        }

        const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (video) {
            video.currentTime = seconds;
            video.play();
            return true;
        }
        return false;
    }

    document.addEventListener('click', (e) => {
        if (!isWatchPage || isMobileView()) return;

        const link = e.target.closest('a');
        if (!link) return;

        const href = link.getAttribute('href') || '';
        const text = link.textContent.trim();
        const seconds = extractSecondsFromHrefOrText(href, text);

        if (seconds !== null) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            seekPlayerTo(seconds);
            return false;
        }
    }, true);

    // ================= ローディング・スクロール監視 =================
    function setupContinuationObserver() {
        if (!isWatchPage || isMobileView()) return;

        if (!continuationObserver) {
            continuationObserver = new IntersectionObserver((entries) => {
                if (!isWatchPage || isMobileView()) return;
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        window.dispatchEvent(new Event('scroll'));
                        triggerResize();

                        const btn = entry.target.querySelector('button, yt-button-shape button');
                        if (btn) btn.click();
                    }
                }
            }, {
                rootMargin: '250px 0px'
            });
        }

        const observeTargets = () => {
            if (!continuationObserver || !isWatchPage || isMobileView()) return;
            const items = document.querySelectorAll('ytd-comments ytd-continuation-item-renderer, #secondary ytd-continuation-item-renderer');
            items.forEach(el => continuationObserver.observe(el));
        };
        observeTargets();

        const commentsEl = document.querySelector('ytd-comments#comments');
        if (commentsEl && !mutObs) {
            mutObs = new MutationObserver(observeTargets);
            mutObs.observe(commentsEl, { childList: true, subtree: true });
        }
    }

    function setupScrollRelay() {
        const attachRelay = (el) => {
            if (!el || el.dataset.relayAttached) return;
            el.addEventListener('scroll', () => {
                if (!isActive || !isWatchPage || isMobileView()) return;
                window.dispatchEvent(new Event('scroll'));

                if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
                    triggerResize();
                }
            }, { passive: true });
            el.dataset.relayAttached = 'true';
        };

        attachRelay(document.querySelector('ytd-comments#comments'));
        attachRelay(document.querySelector('#secondary'));
    }

    function kickCommentsLoading() {
        if (!isWatchPage || isMobileView()) return;

        const comments = document.querySelector('ytd-comments#comments');
        if (comments) {
            comments.scrollTop += 1;
            comments.scrollTop -= 1;
        }

        window.dispatchEvent(new Event('scroll'));
        triggerResize();

        setTimeout(() => {
            if (!isWatchPage) return;
            window.dispatchEvent(new Event('scroll'));
            triggerResize();
        }, 150);

        setTimeout(() => {
            if (!isWatchPage) return;
            window.dispatchEvent(new Event('scroll'));
            triggerResize();
        }, 400);
    }

    function setupResizeSync() {
        const primary = document.querySelector('#primary');
        if (primary && !resizeObserver) {
            let timer = null;
            resizeObserver = new ResizeObserver(() => {
                if (isActive && !isResizing && isWatchPage && !isMobileView()) {
                    if (timer) cancelAnimationFrame(timer);
                    timer = requestAnimationFrame(() => {
                        updateDynamicPlayerHeight();
                        triggerResize();
                    });
                }
            });
            resizeObserver.observe(primary);
        }
    }

    function updateUIState() {
        if (!isWatchPage) return;

        document.body.classList.remove('yt-sidepane-left', 'yt-sidepane-right');
        document.body.classList.add(`yt-sidepane-${currentSide}`);

        document.body.classList.remove('yt-tab-comments', 'yt-tab-recommended');
        document.body.classList.add(currentTab === 'comments' ? 'yt-tab-comments' : 'yt-tab-recommended');

        btnComments.classList.toggle('active', currentTab === 'comments');
        btnRecommended.classList.toggle('active', currentTab === 'recommended');

        if (isActive) {
            updateDynamicPlayerHeight();
        }
        triggerResize();
    }
    updateUIState();

    btnComments.addEventListener('click', () => {
        currentTab = 'comments';
        localStorage.setItem(STORAGE_KEY_TAB, currentTab);
        updateUIState();
        kickCommentsLoading();
    });

    btnRecommended.addEventListener('click', () => {
        currentTab = 'recommended';
        localStorage.setItem(STORAGE_KEY_TAB, currentTab);
        updateUIState();
        window.dispatchEvent(new Event('scroll'));
        triggerResize();
    });

    btnToggleSide.addEventListener('click', () => {
        currentSide = currentSide === 'right' ? 'left' : 'right';
        localStorage.setItem(STORAGE_KEY_POS, currentSide);
        updateUIState();
    });

    // ================= スクロール監視とスムーズ遷移 =================
    const THRESHOLD_ENTER = 250;
    const THRESHOLD_LEAVE = 80;

    window.addEventListener('scroll', () => {
        if (!isWatchPage || isMobileView()) return;

        const scrollY = window.scrollY;

        if (!isActive && scrollY > THRESHOLD_ENTER) {
            activateMode();
        } else if (isActive && scrollY < THRESHOLD_LEAVE) {
            deactivateMode();
        }
    }, { passive: true });

    function activateMode() {
        if (isMobileView()) return;

        isActive = true;
        const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 2500);
        heightPreserver.style.height = `${docHeight}px`;
        heightPreserver.style.display = 'block';

        document.body.classList.add('yt-sidepane-active');
        updateDynamicPlayerHeight();
        updateUIState();

        setupScrollRelay();
        setupContinuationObserver();
        setupResizeSync();
        kickCommentsLoading();

        // アニメーション完了（約280ms）に合わせてプレイヤーサイズを再同期
        setTimeout(() => {
            if (isActive) triggerResize();
        }, 300);
    }

    function deactivateMode() {
        isActive = false;
        document.body.classList.remove('yt-sidepane-active');
        heightPreserver.style.display = 'none';
        heightPreserver.style.height = '0px';

        // アニメーション完了に合わせて通常サイズへ再同期
        setTimeout(() => {
            triggerResize();
        }, 300);
    }

    function destroyEverything() {
        deactivateMode();

        if (continuationObserver) {
            continuationObserver.disconnect();
            continuationObserver = null;
        }
        if (mutObs) {
            mutObs.disconnect();
            mutObs = null;
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }

        const commentsEl = document.querySelector('ytd-comments#comments');
        if (commentsEl) delete commentsEl.dataset.relayAttached;
        const secondaryEl = document.querySelector('#secondary');
        if (secondaryEl) delete secondaryEl.dataset.relayAttached;

        document.body.classList.remove(
            'yt-sidepane-active',
            'yt-sidepane-left',
            'yt-sidepane-right',
            'yt-tab-comments',
            'yt-tab-recommended'
        );
    }

    // ================= ドラッグリサイズ（アニメーション自動除外・高レスポンス） =================
    resizer.addEventListener('mousedown', (e) => {
        if (!isWatchPage || isMobileView()) return;
        isResizing = true;
        startX = e.clientX;
        startWidth = currentWidth;
        resizer.classList.add('resizing');
        document.body.classList.add('yt-resizing'); // ★ドラッグ中はtransitionを瞬時に解除
        document.body.style.userSelect = 'none';
        lastDragSyncTime = performance.now();

        updateDynamicPlayerHeight();

        const onMouseMove = (moveEvent) => {
            if (!isResizing) return;
            const delta = currentSide === 'right' ? (startX - moveEvent.clientX) : (moveEvent.clientX - startX);
            pendingWidth = Math.max(300, Math.min(window.innerWidth * 0.7, startWidth + delta));

            if (!rAFId) {
                rAFId = requestAnimationFrame(() => {
                    if (pendingWidth !== null) {
                        currentWidth = pendingWidth;
                        document.documentElement.style.setProperty('--yt-sidepane-w', `${pendingWidth}px`);
                    }

                    const now = performance.now();
                    if (now - lastDragSyncTime > DRAG_THROTTLE_INTERVAL_MS) {
                        lastDragSyncTime = now;
                        updateDynamicPlayerHeight();
                        triggerResize();
                    }

                    rAFId = null;
                });
            }
        };

        const onMouseUp = () => {
            if (isResizing) {
                isResizing = false;
                if (rAFId) {
                    cancelAnimationFrame(rAFId);
                    rAFId = null;
                }
                resizer.classList.remove('resizing');
                document.body.classList.remove('yt-resizing'); // ★ドラッグ終了でtransitionを再有効化
                document.body.style.userSelect = '';

                if (pendingWidth !== null) {
                    currentWidth = pendingWidth;
                    document.documentElement.style.setProperty('--yt-sidepane-w', `${currentWidth}px`);
                }
                localStorage.setItem(STORAGE_KEY_WIDTH, Math.round(currentWidth).toString());

                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);

                updateDynamicPlayerHeight();
                triggerResize();
            }
        };

        window.addEventListener('mousemove', onMouseMove, { passive: true });
        window.addEventListener('mouseup', onMouseUp);
    });

    window.addEventListener('resize', () => {
        if (!isWatchPage || isMobileView()) {
            if (isActive) deactivateMode();
            return;
        }
        if (isActive && !isResizing) {
            updateDynamicPlayerHeight();
        }
    });

    // ================= YouTube SPAルーティング =================
    function handleRouteChange() {
        const isWatch = location.pathname.startsWith('/watch');

        if (!isWatch) {
            isWatchPage = false;
            currentVideoId = '';
            destroyEverything();
            return;
        }

        const newV = getVideoId();
        if (isWatchPage && newV === currentVideoId) {
            return;
        }

        isWatchPage = true;
        currentVideoId = newV;
        destroyEverything();
        updateUIState();
    }

    window.addEventListener('yt-navigate-start', (e) => {
        const dest = e?.detail?.url || location.pathname;
        if (!dest.startsWith('/watch')) {
            isWatchPage = false;
            currentVideoId = '';
            destroyEverything();
        }
    });

    window.addEventListener('yt-navigate-finish', () => {
        handleRouteChange();
    });

    handleRouteChange();
})();
