// ==UserScript==
// @name         Discord Timestamp Sync Client
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Subscribes to the local YouTube timestamp broker and autoscrolls Discord web to matching messages
// @author       Noat DK
// @match        https://discord.com/*
// @match        https://*.discord.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    "use strict";

    const PORT = 8080;
    const STORAGE_KEY = "yt-discord-sync-enabled";
    const BUTTON_ID = "yt-discord-sync-toggle";
    const STATUS_ID = "yt-discord-sync-status";

    let enabled = localStorage.getItem(STORAGE_KEY) !== "false";
    let source = null;
    let reconnectTimeout = null;
    let lastFetchedTimestamp = null;
    let targetTimestamp = null;
    let lastScrolledMessageId = null;
    let lastTargetTime = null;
    let isScrolling = false;
    let scrollAnimationFrame = null;
    let cachedWebpackRequire = null;
    let cachedModules = null;
    let statusButton = null;
    let statusLabel = null;

    function setEnabled(nextEnabled) {
        enabled = nextEnabled;
        localStorage.setItem(STORAGE_KEY, String(enabled));
        updateStatusUi();

        if (enabled) {
            connectStream();
        } else {
            stopStream(true);
        }
    }

    function toggleEnabled() {
        setEnabled(!enabled);
    }

    function ensureStatusUi() {
        if (document.getElementById(BUTTON_ID)) {
            statusButton = document.getElementById(BUTTON_ID);
            statusLabel = document.getElementById(STATUS_ID);
            updateStatusUi();
            return;
        }

        const button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.style.cssText = [
            "position:fixed",
            "right:16px",
            "bottom:16px",
            "z-index:999999",
            "border:1px solid rgba(255,255,255,0.18)",
            "border-radius:999px",
            "padding:10px 12px",
            "background:rgba(17,24,39,0.92)",
            "color:#fff",
            "font:600 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
            "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
            "cursor:pointer",
            "backdrop-filter:blur(12px)"
        ].join(";");

        const label = document.createElement("span");
        label.id = STATUS_ID;
        button.appendChild(label);
        button.addEventListener("click", toggleEnabled);
        document.body.appendChild(button);

        statusButton = button;
        statusLabel = label;
        updateStatusUi();
    }

    function updateStatusUi() {
        if (!statusLabel) return;

        const state = enabled ? (source ? "connected" : "connecting") : "paused";
        statusLabel.textContent = `YT Sync: ${state}`;

        if (statusButton) {
            statusButton.style.opacity = enabled ? "1" : "0.75";
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
        const fluxDispatcher = findModule(module => typeof module?.subscribe === "function" && typeof module?.dispatch === "function");

        cachedModules = {
            messageStore,
            selectedChannelStore,
            messageActions,
            fluxDispatcher
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

    function smoothScrollTo(scrollContainer, targetScrollTop, duration = 450) {
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

    function scrollMessageToBottom(messageElement, scrollContainer) {
        if (isScrolling && scrollAnimationFrame !== null) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }

        isScrolling = true;

        if (scrollContainer) {
            requestAnimationFrame(() => {
                const rect = messageElement.getBoundingClientRect();
                const containerRect = scrollContainer.getBoundingClientRect();
                const viewportHeight = containerRect.height;
                const messageTop = rect.top - containerRect.top;
                const messageHeight = rect.height;
                const currentScrollTop = scrollContainer.scrollTop;
                const targetScrollTop = currentScrollTop + messageTop - viewportHeight + messageHeight + 20;
                smoothScrollTo(scrollContainer, targetScrollTop, 400);
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

    function findMessageByTimestamp(channelId, targetTimestamp) {
        const modules = getDiscordModules();
        const messageStore = modules.messageStore;
        if (!messageStore) return null;

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

        const messagesWithDiffs = [];

        for (let i = startIndex; i < messageArray.length; i++) {
            const message = messageArray[i];
            if (!message?.timestamp) continue;
            const messageTime = message.timestamp.valueOf();

            let diff;
            if (lastTargetTime !== null && targetTime > lastTargetTime) {
                if (messageTime >= targetTime) {
                    diff = messageTime - targetTime;
                } else {
                    diff = targetTime - messageTime + 1000000;
                }
            } else {
                diff = Math.abs(messageTime - targetTime);
            }

            messagesWithDiffs.push({ id: message.id, diff, index: i, timestamp: messageTime });
        }

        if (messagesWithDiffs.length === 0) return null;

        const closestMessage = messagesWithDiffs.reduce((prev, curr) => curr.diff < prev.diff ? curr : prev);
        const isAlreadyAtClosest = lastScrolledMessageId === closestMessage.id;

        let isClosest = true;
        const closestIndex = closestMessage.index;
        const prevMessage = closestIndex > 0 ? messageArray[closestIndex - 1] : null;
        const nextMessage = closestIndex < messageArray.length - 1 ? messageArray[closestIndex + 1] : null;

        function diffFor(messageTime) {
            if (lastTargetTime !== null && targetTime > lastTargetTime) {
                if (messageTime >= targetTime) {
                    return messageTime - targetTime;
                }
                return targetTime - messageTime + 1000000;
            }
            return Math.abs(messageTime - targetTime);
        }

        if (prevMessage?.timestamp && diffFor(prevMessage.timestamp.valueOf()) < closestMessage.diff) {
            isClosest = false;
        }

        if (nextMessage?.timestamp && diffFor(nextMessage.timestamp.valueOf()) < closestMessage.diff) {
            isClosest = false;
        }

        return {
            id: closestMessage.id,
            diff: closestMessage.diff,
            isClosest: isAlreadyAtClosest && isClosest
        };
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
                    element: messageContainer
                };
            }
        }

        return best;
    }

    function attemptScrollToTarget(channelId) {
        if (!targetTimestamp || !enabled) return;

        const modules = getDiscordModules();
        const result = channelId && modules.messageStore ? findMessageByTimestamp(channelId, targetTimestamp) : null;

        if (result) {
            if (result.isClosest) return;

            if (lastScrolledMessageId !== result.id) {
                lastScrolledMessageId = result.id;

                const messageElement = findMessageElement(result.id);
                if (messageElement) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            const scrollContainer = findScrollContainer(messageElement);
                            scrollMessageToBottom(messageElement, scrollContainer);
                        });
                    });
                    return;
                }

                if (modules.messageActions?.jumpToMessage) {
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
                            const scrollContainer = findScrollContainer(element);
                            scrollMessageToBottom(element, scrollContainer);
                        } else if (attempt < 5) {
                            setTimeout(() => attemptScroll(attempt + 1), 100 * (attempt + 1));
                        }
                    };

                    setTimeout(() => attemptScroll(), 200);
                    return;
                }
            }
        }

        const domFallback = findRenderedClosestMessage(targetTimestamp);
        if (!domFallback?.element) return;

        const fallbackId = domFallback.id || domFallback.element.id || null;
        if (fallbackId && lastScrolledMessageId === fallbackId) return;
        if (fallbackId) lastScrolledMessageId = fallbackId;

        const scrollContainer = findScrollContainer(domFallback.element);
        scrollMessageToBottom(domFallback.element, scrollContainer);
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

    function scheduleReconnect() {
        if (reconnectTimeout !== null || !enabled) return;

        reconnectTimeout = window.setTimeout(() => {
            reconnectTimeout = null;
            if (enabled) {
                connectStream();
            }
        }, 3000);
    }

    function stopStream(resetState) {
        if (source) {
            source.close();
            source = null;
        }

        if (reconnectTimeout !== null) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        if (scrollAnimationFrame !== null) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }
        isScrolling = false;

        if (resetState) {
            targetTimestamp = null;
            lastFetchedTimestamp = null;
            lastScrolledMessageId = null;
            lastTargetTime = null;
        }

        updateStatusUi();
    }

    function connectStream() {
        if (source || !enabled) return;

        if (reconnectTimeout !== null) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        if (typeof EventSource === "undefined") {
            console.warn("[YT Discord Sync] EventSource is unavailable in this browser");
            return;
        }

        try {
            source = new EventSource(`http://localhost:${PORT}/events`);
        } catch (error) {
            console.warn("[YT Discord Sync] Failed to open timestamp stream:", error);
            scheduleReconnect();
            return;
        }

        source.onmessage = event => {
            try {
                const data = JSON.parse(event.data);
                if (data?.gmt) {
                    handleIncomingTimestamp(data.gmt);
                }
            } catch (error) {
                console.warn("[YT Discord Sync] Failed to parse timestamp payload:", error);
            }
        };

        source.onerror = () => {
            stopStream(false);
            if (enabled) {
                scheduleReconnect();
            }
        };

        updateStatusUi();
    }

    function waitForDiscordAndStart() {
        ensureStatusUi();

        if (enabled) {
            connectStream();
        }
    }

    const existingObserver = new MutationObserver(() => {
        if (!document.getElementById(BUTTON_ID)) {
            ensureStatusUi();
        }
    });

    if (document.body) {
        existingObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", waitForDiscordAndStart);
    } else {
        waitForDiscordAndStart();
    }
})();
