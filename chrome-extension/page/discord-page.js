(function() {
    "use strict";

    const STORAGE_KEY = "yt-discord-sync-enabled";
    const BRIDGE_SOURCE = "yt-discord-sync-bridge";
    const PAGE_SOURCE = "yt-discord-sync-page";

    let memoryEnabled = true;
    let enabled = getEnabledState();
    let lastFetchedTimestamp = null;
    let targetTimestamp = null;
    let lastScrolledMessageId = null;
    let lastTargetTime = null;
    let isScrolling = false;
    let scrollAnimationFrame = null;
    let cachedWebpackRequire = null;
    let cachedModules = null;
    let currentPointerMarker = null;
    let currentPointerButton = null;
    let currentPointerContainer = null;
    let currentPointerMessageId = null;
    let currentPointerTimestamp = null;
    let timestampActionObserver = null;

    function getEnabledState() {
        try {
            return window.localStorage.getItem(STORAGE_KEY) !== "false";
        } catch {
            return memoryEnabled;
        }
    }

    function setEnabledState(value) {
        memoryEnabled = value;
        try {
            window.localStorage.setItem(STORAGE_KEY, String(value));
        } catch {
            // Ignore storage access failures.
        }
    }

    function applyEnabledState(nextEnabled) {
        enabled = Boolean(nextEnabled);
        setEnabledState(enabled);

        if (enabled) {
            notifyBridgeReady();
            attemptScrollToTarget(getCurrentChannelId() || getChannelIdFromLocation());
        } else {
            stopStream(true);
        }
    }

    function getWebpackRequire() {
        if (cachedWebpackRequire) {
            return cachedWebpackRequire;
        }

        const chunk = window.webpackChunkdiscord_app;
        if (!chunk || typeof chunk.push !== "function") {
            return null;
        }

        try {
            chunk.push([[Symbol("yt-discord-sync")], {}, req => {
                cachedWebpackRequire = req;
            }]);
        } catch (error) {
            console.warn("[YT Discord Sync] Failed to capture webpack require:", error);
            return null;
        }

        return cachedWebpackRequire;
    }

    function unwrapExports(exports) {
        const candidates = [exports, exports?.default, exports?.Z, exports?.ZP, exports?.N];
        return candidates.filter(Boolean);
    }

    function findModule(filter) {
        const req = getWebpackRequire();
        if (!req?.c) return null;

        for (const id in req.c) {
            const mod = req.c[id];
            if (!mod?.exports) continue;

            for (const candidate of unwrapExports(mod.exports)) {
                try {
                    if (filter(candidate)) {
                        return candidate;
                    }
                } catch {
                    // Ignore module probe failures.
                }
            }
        }

        return null;
    }

    function getDiscordModules() {
        if (cachedModules) return cachedModules;

        const messageStore = findModule(module => typeof module?.getMessages === "function");
        const selectedChannelStore = findModule(module => typeof module?.getChannelId === "function" && typeof module?.getVoiceChannelId === "function");
        const messageActions = findModule(module => typeof module?.jumpToMessage === "function");

        cachedModules = {
            messageStore,
            selectedChannelStore,
            messageActions
        };

        return cachedModules;
    }

    function getCurrentChannelId() {
        const modules = getDiscordModules();
        return modules.selectedChannelStore?.getChannelId?.() || null;
    }

    function getChannelIdFromLocation() {
        const match = location.pathname.match(/\/channels\/[^/]+\/([^/]+)/);
        return match ? match[1] : null;
    }

    function findMessageElement(messageId) {
        return document.getElementById(`message-content-${messageId}`) ||
            document.querySelector(`[id*="message-content-${messageId}"]`) ||
            document.querySelector(`[data-message-id="${messageId}"]`) ||
            document.querySelector(`[class*="message"][class*="${messageId}"]`);
    }

    function findScrollContainer(element) {
        let scrollContainer = element.parentElement;
        while (scrollContainer && scrollContainer !== document.body) {
            const classes = scrollContainer.className?.toString() || "";
            if ((classes.includes("scroller") || classes.includes("messages") || classes.includes("chatContent")) &&
                scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                return scrollContainer;
            }
            scrollContainer = scrollContainer.parentElement;
        }
        return null;
    }

    function getBottomInset(viewportHeight) {
        return Math.max(40, Math.min(96, Math.round(viewportHeight * 0.085)));
    }

    function getComposerInset(scrollContainer) {
        if (!scrollContainer) {
            return 0;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], form'));
        let bestTop = null;

        for (const element of candidates) {
            if (!element?.getBoundingClientRect) continue;

            const rect = element.getBoundingClientRect();
            if (!rect || rect.height <= 0 || rect.width <= 0) continue;

            if (rect.bottom < containerRect.top + (containerRect.height * 0.4)) continue;
            if (rect.left > containerRect.right || rect.right < containerRect.left) continue;

            if (bestTop === null || rect.top < bestTop) {
                bestTop = rect.top;
            }
        }

        if (bestTop === null) {
            return 0;
        }

        return Math.max(0, Math.round(containerRect.bottom - bestTop));
    }

    function smoothScrollTo(scrollContainer, targetScrollTop, duration = 350) {
        const startScrollTop = scrollContainer.scrollTop;
        const distance = targetScrollTop - startScrollTop;
        const startTime = performance.now();

        if (Math.abs(distance) < 5) {
            isScrolling = false;
            return;
        }

        const animate = currentTime => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 3);

            scrollContainer.scrollTop = startScrollTop + (distance * easeOut);

            if (progress < 1) {
                scrollAnimationFrame = requestAnimationFrame(animate);
            } else {
                isScrolling = false;
                scrollAnimationFrame = null;
            }
        };

        scrollAnimationFrame = requestAnimationFrame(animate);
    }

    function scrollMessageIntoView(messageElement, scrollContainer) {
        if (isScrolling && scrollAnimationFrame !== null) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }

        isScrolling = true;

        if (scrollContainer) {
            requestAnimationFrame(() => {
                const rect = messageElement.getBoundingClientRect();
                const containerRect = scrollContainer.getBoundingClientRect();
                const messageTop = rect.top - containerRect.top;
                const messageHeight = rect.height;
                const viewportHeight = containerRect.height;
                const currentScrollTop = scrollContainer.scrollTop;
                const composerInset = getComposerInset(scrollContainer);
                const bottomPadding = Math.max(getBottomInset(viewportHeight), Math.min(composerInset + 16, getBottomInset(viewportHeight) + 16));
                const targetScrollTop = currentScrollTop + messageTop - viewportHeight + messageHeight + bottomPadding;
                smoothScrollTo(scrollContainer, targetScrollTop, 350);
            });
        } else {
            requestAnimationFrame(() => {
                messageElement.scrollIntoView({
                    behavior: "smooth",
                    block: "end",
                    inline: "nearest"
                });

                setTimeout(() => {
                    isScrolling = false;
                }, 600);
            });
        }
    }

    function clearPointerMarker() {
        currentPointerMarker = null;
        currentPointerButton = null;
        currentPointerContainer = null;
        currentPointerMessageId = null;
        currentPointerTimestamp = null;
    }

    function clearTimestampActions() {
        const actions = Array.from(document.querySelectorAll('[data-yt-discord-sync-action="true"]'));
        for (const action of actions) {
            action.remove();
        }
    }

    function createJumpButton(timestampValue) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "↗";
        button.title = "Jump to this timestamp on YouTube";
        button.setAttribute("aria-label", "Jump to this timestamp on YouTube");
        button.style.cssText = [
            "appearance:none",
            "border:1px solid rgba(94,234,212,0.9)",
            "background:rgba(15,118,110,0.14)",
            "color:#d1fae5",
            "border-radius:999px",
            "min-width:18px",
            "height:18px",
            "padding:0 5px",
            "display:inline-flex",
            "align-items:center",
            "justify-content:center",
            "font-size:10px",
            "line-height:1",
            "font-weight:800",
            "cursor:pointer",
            "flex:0 0 auto",
            "margin-left:2px",
            "position:relative",
            "top:-1px",
            "white-space:nowrap"
        ].join(";");

        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            postRedirectTimestamp(timestampValue);
        });

        return button;
    }

    function isCurrentSyncedTimestamp(timestampValue) {
        return Boolean(timestampValue && currentPointerTimestamp && timestampValue === currentPointerTimestamp);
    }

    function ensureTimestampAction(messageElement) {
        if (!messageElement) return;

        const timestampNode = findTimestampNode(messageElement);
        if (!timestampNode) return;

        const timestampValue = timestampNode.getAttribute("datetime") || timestampNode.dateTime || null;
        if (!timestampValue) return;

        const existingAction = timestampNode.nextElementSibling?.matches?.('[data-yt-discord-sync-action="true"]')
            ? timestampNode.nextElementSibling
            : null;

        if (existingAction) {
            const button = existingAction.querySelector("button");
            if (button) {
                applyTimestampButtonStyle(button, isCurrentSyncedTimestamp(timestampValue));
            }
            return;
        }

        const parent = timestampNode.parentElement;
        if (!parent) return;

        const action = document.createElement("span");
        action.setAttribute("data-yt-discord-sync-action", "true");
        action.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "gap:2px",
            "margin-left:2px",
            "vertical-align:middle",
            "white-space:nowrap",
            "flex:0 0 auto"
        ].join(";");

        const button = createJumpButton(timestampValue);
        applyTimestampButtonStyle(button, isCurrentSyncedTimestamp(timestampValue));
        action.appendChild(button);
        parent.insertBefore(action, timestampNode.nextSibling);
    }

    function applyTimestampButtonStyle(button, isActive) {
        if (!button) return;

        button.style.cssText = [
            "appearance:none",
            "border:1px solid " + (isActive ? "rgba(34,197,94,1)" : "rgba(94,234,212,0.9)"),
            "background:" + (isActive ? "rgba(34,197,94,0.28)" : "rgba(15,118,110,0.14)"),
            "color:" + (isActive ? "#ecfdf5" : "#d1fae5"),
            "border-radius:999px",
            "min-width:18px",
            "height:18px",
            "padding:0 5px",
            "display:inline-flex",
            "align-items:center",
            "justify-content:center",
            "font-size:10px",
            "line-height:1",
            "font-weight:800",
            "cursor:pointer",
            "flex:0 0 auto",
            "margin-left:2px",
            "position:relative",
            "top:-1px",
            "white-space:nowrap",
            isActive ? "box-shadow:0 0 0 1px rgba(34,197,94,0.35)" : ""
        ].filter(Boolean).join(";");
    }

    function findTimestampNode(messageElement) {
        if (messageElement?.matches?.("time[datetime]")) {
            return messageElement;
        }

        return messageElement.querySelector("time[datetime]") ||
            messageElement.querySelector('a[role="link"] time[datetime]') ||
            messageElement.querySelector("time") ||
            null;
    }

    function postRedirectTimestamp(timestamp) {
        if (!timestamp) return;

        console.log("[YT Discord Sync][Discord] redirect timestamp", {
            timestamp,
            activeTimestamp: currentPointerTimestamp || null,
            source: "discord-button"
        });

        window.postMessage({
            source: PAGE_SOURCE,
            type: "redirect",
            timestamp
        }, "*");
    }

    function markPointerOnMessage(messageId, messageElement = null) {
        const hostElement = messageElement || (messageId ? findMessageElement(messageId) : null);
        if (!hostElement) return;

        const timestampNode = findTimestampNode(hostElement);
        if (!timestampNode) return;

        const timestampValue = timestampNode.getAttribute("datetime") || timestampNode.dateTime || null;
        if (!timestampValue || currentPointerTimestamp === timestampValue) {
            return;
        }

        currentPointerMessageId = messageId;
        currentPointerTimestamp = timestampValue;
        decorateVisibleTimestampActions();
    }

    function findMessageByTimestamp(channelId, targetTimestamp) {
        const modules = getDiscordModules();
        const messageStore = modules.messageStore;
        if (!messageStore || !channelId) return null;

        const messages = messageStore.getMessages?.(channelId);
        if (!messages) return null;

        const targetTime = new Date(targetTimestamp).getTime();
        const messageArray = messages._array || [];

        let startIndex = 0;
        if (lastTargetTime !== null && targetTime > lastTargetTime && lastScrolledMessageId) {
            const lastIndex = messageArray.findIndex(m => m.id === lastScrolledMessageId);
            if (lastIndex !== -1) {
                startIndex = lastIndex;
            }
        }

        const candidates = [];
        for (let i = startIndex; i < messageArray.length; i++) {
            const message = messageArray[i];
            if (!message?.timestamp) continue;
            const messageTime = message.timestamp.valueOf();

            let diff;
            if (lastTargetTime !== null && targetTime > lastTargetTime) {
                diff = messageTime >= targetTime ? (messageTime - targetTime) : (targetTime - messageTime + 1000000);
            } else {
                diff = Math.abs(messageTime - targetTime);
            }

            candidates.push({ id: message.id, diff, index: i });
        }

        if (candidates.length === 0) return null;

        const closest = candidates.reduce((prev, curr) => curr.diff < prev.diff ? curr : prev);
        let isClosest = true;

        const prevMessage = closest.index > 0 ? messageArray[closest.index - 1] : null;
        const nextMessage = closest.index < messageArray.length - 1 ? messageArray[closest.index + 1] : null;

        function diffFor(messageTime) {
            if (lastTargetTime !== null && targetTime > lastTargetTime) {
                return messageTime >= targetTime ? (messageTime - targetTime) : (targetTime - messageTime + 1000000);
            }
            return Math.abs(messageTime - targetTime);
        }

        if (prevMessage?.timestamp && diffFor(prevMessage.timestamp.valueOf()) < closest.diff) {
            isClosest = false;
        }

        if (nextMessage?.timestamp && diffFor(nextMessage.timestamp.valueOf()) < closest.diff) {
            isClosest = false;
        }

        return { id: closest.id, diff: closest.diff, isClosest };
    }

    function findRenderedClosestMessage(targetTimestamp) {
        const targetTime = new Date(targetTimestamp).getTime();
        const candidates = Array.from(document.querySelectorAll("time[datetime]"));
        let best = null;

        for (const timeNode of candidates) {
            const datetime = timeNode.getAttribute("datetime");
            if (!datetime) continue;

            const messageTime = new Date(datetime).getTime();
            if (Number.isNaN(messageTime)) continue;

            const diff = Math.abs(messageTime - targetTime);
            const messageContainer = timeNode.closest('[id^="chat-messages-"], [data-list-item-id^="chat-messages-"], [id*="message"]');
            if (!messageContainer) continue;

            if (!best || diff < best.diff) {
                best = {
                    id: messageContainer.id || messageContainer.getAttribute("data-message-id") || null,
                    diff,
                    element: messageContainer,
                    timestampNode: timeNode
                };
            }
        }

        return best;
    }

    function decorateVisibleTimestampActions() {
        const timestampNodes = Array.from(document.querySelectorAll("time[datetime]"));
        for (const timestampNode of timestampNodes) {
            const host = timestampNode.closest('[id^="chat-messages-"], [data-list-item-id^="chat-messages-"], [id*="message"]') || timestampNode.parentElement;
            ensureTimestampAction(host || timestampNode);
        }
    }

    function attemptScrollToTarget(channelId) {
        if (!targetTimestamp || !enabled) return;

        const modules = getDiscordModules();
        const result = channelId && modules.messageStore ? findMessageByTimestamp(channelId, targetTimestamp) : null;

        const renderedTarget = findRenderedClosestMessage(targetTimestamp);

        if (result?.id || renderedTarget?.element) {
            const messageElement = result?.id ? findMessageElement(result.id) : null;
            const fallbackElement = renderedTarget?.element || renderedTarget?.timestampNode || null;
            const elementToDecorate = messageElement || fallbackElement;
            const pointerMessageId = result?.id || renderedTarget?.id || null;

            markPointerOnMessage(pointerMessageId, elementToDecorate);

            if (messageElement) {
                if (lastScrolledMessageId !== result.id || !result.isClosest) {
                    lastScrolledMessageId = result.id;
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            const scrollContainer = findScrollContainer(messageElement);
                            scrollMessageIntoView(messageElement, scrollContainer);
                        });
                    });
                }
                decorateVisibleTimestampActions();
                return;
            }

            if (result?.id && modules.messageActions?.jumpToMessage && lastScrolledMessageId !== result.id) {
                lastScrolledMessageId = result.id;
                modules.messageActions.jumpToMessage({
                    channelId,
                    messageId: result.id,
                    flash: false,
                    jumpType: "ANIMATED"
                });

                const attemptScroll = (attempt = 0) => {
                    if (attempt > 5) return;
                    const element = findMessageElement(result.id);
                    if (element) {
                        markPointerOnMessage(result.id);
                        const scrollContainer = findScrollContainer(element);
                        scrollMessageIntoView(element, scrollContainer);
                    } else {
                        setTimeout(() => attemptScroll(attempt + 1), 100 * (attempt + 1));
                    }
                };

                setTimeout(() => attemptScroll(), 200);
                decorateVisibleTimestampActions();
                return;
            }

            const activeId = pointerMessageId || lastScrolledMessageId;
            if (activeId && lastScrolledMessageId === activeId) {
                const scrollContainer = findScrollContainer(elementToDecorate);
                scrollMessageIntoView(elementToDecorate, scrollContainer);
                return;
            }

            if (pointerMessageId) {
                lastScrolledMessageId = pointerMessageId;
            }

            const scrollContainer = findScrollContainer(elementToDecorate);
            scrollMessageIntoView(elementToDecorate, scrollContainer);
            decorateVisibleTimestampActions();
            return;
        }

        if (!renderedTarget?.element) return;

        if (renderedTarget.id) {
            markPointerOnMessage(renderedTarget.id, renderedTarget.element || renderedTarget.timestampNode || null);
            if (lastScrolledMessageId === renderedTarget.id) return;
            lastScrolledMessageId = renderedTarget.id;
        } else {
            markPointerOnMessage(null, renderedTarget.element || renderedTarget.timestampNode || null);
        }

        const scrollTarget = renderedTarget.element || renderedTarget.timestampNode;
        const scrollContainer = findScrollContainer(renderedTarget.element || renderedTarget.timestampNode);
        scrollMessageIntoView(scrollTarget, scrollContainer);
        decorateVisibleTimestampActions();
    }

    function handleIncomingTimestamp(gmt) {
        const channelId = getCurrentChannelId() || getChannelIdFromLocation();

        if (lastFetchedTimestamp !== gmt) {
            lastFetchedTimestamp = gmt;
            const newTargetTime = new Date(gmt).getTime();

            if (lastTargetTime === null || newTargetTime > lastTargetTime + 1000) {
                lastScrolledMessageId = null;
            }

            targetTimestamp = gmt;
            lastTargetTime = newTargetTime;
        }

        if (targetTimestamp) {
            attemptScrollToTarget(channelId);
        }
    }

    function notifyBridgeReady() {
        window.postMessage({
            source: PAGE_SOURCE,
            type: "ready"
        }, "*");
    }

    function stopStream(resetState) {
        if (scrollAnimationFrame !== null) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }

        isScrolling = false;
        clearPointerMarker();
        clearTimestampActions();

        if (resetState) {
            targetTimestamp = null;
            lastFetchedTimestamp = null;
            lastScrolledMessageId = null;
            lastTargetTime = null;
        }
    }

    function startMarkerObserver() {
        if (!document.body) return;
    }

    function startTimestampActionObserver() {
        if (timestampActionObserver || !document.body) return;

        timestampActionObserver = new MutationObserver(() => {
            if (!enabled) {
                clearTimestampActions();
                return;
            }
            decorateVisibleTimestampActions();
        });

        timestampActionObserver.observe(document.body, { childList: true, subtree: true });
        decorateVisibleTimestampActions();
    }

    function start() {
        startMarkerObserver();
        startTimestampActionObserver();

        if (enabled) {
            notifyBridgeReady();
        }
    }

    window.addEventListener("message", event => {
        if (event.source !== window || !event.data || event.data.source !== BRIDGE_SOURCE) {
            return;
        }

        if (event.data.type === "timestamp" && event.data.payload?.gmt) {
            handleIncomingTimestamp(event.data.payload.gmt);
            return;
        }

        if (event.data.type === "settings" && typeof event.data.enabled === "boolean") {
            applyEnabledState(event.data.enabled);
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
