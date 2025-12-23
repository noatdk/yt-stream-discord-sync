import { definePluginSettings, SettingsStore } from "@api/Settings";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageActions, MessageStore, SelectedChannelStore, React, Menu, FluxDispatcher, i18n } from "@webpack/common";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import styles from "./styles.css?managed";

// i18n messages for English and Japanese
const Messages = {
    en: {
        SETTINGS_ENABLED: "Enable automatic scrolling to timestamp messages",
        SETTINGS_CHECK_INTERVAL: "Check interval in seconds",
        SETTINGS_PORT: "Server port",
        CONTEXT_MENU_ENABLE: "Enable Timestamp Autoscroll",
        CONTEXT_MENU_SET_REDIRECT: "Set as Redirect Timestamp"
    },
    ja: {
        SETTINGS_ENABLED: "タイムスタンプメッセージへの自動スクロールを有効にする",
        SETTINGS_CHECK_INTERVAL: "チェック間隔（秒）",
        SETTINGS_PORT: "サーバーポート",
        CONTEXT_MENU_ENABLE: "タイムスタンプ自動スクロールを有効にする",
        CONTEXT_MENU_SET_REDIRECT: "リダイレクトタイムスタンプとして設定"
    }
};

// Get current language (defaults to English)
function getLanguage(): "en" | "ja" {
    try {
        // Try to get locale from i18n.intl or check Discord's locale
        const locale = (i18n?.intl?.locale || navigator.language || "en").toLowerCase();
        if (locale.startsWith("ja")) return "ja";
        return "en";
    } catch {
        return "en";
    }
}

// Get translated message
function t(key: keyof typeof Messages.en): string {
    const lang = getLanguage();
    return Messages[lang][key] || Messages.en[key];
}

function getNative() {
    try {
        return VencordNative?.pluginHelpers?.YouTubeTimestampServer as PluginNative<typeof import("./native")> | undefined;
    } catch {
        return undefined;
    }
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: t("SETTINGS_ENABLED"),
        default: false
    },
    checkInterval: {
        type: OptionType.NUMBER,
        description: t("SETTINGS_CHECK_INTERVAL"),
        default: 2
    },
    port: {
        type: OptionType.NUMBER,
        description: t("SETTINGS_PORT"),
        default: 8080,
        onChange(newValue) {
            // Restart server with new port
            const Native = getNative();
            if (Native) {
                Native.stopServerIPC().then(() => {
                    Native.startServerIPC(newValue).catch(error => {
                        console.error("[YouTubeTimestampServer] Failed to restart server with new port:", error);
                    });
                }).catch(() => {
                    // If stop fails, try to start anyway
                    Native.startServerIPC(newValue).catch(error => {
                        console.error("[YouTubeTimestampServer] Failed to start server with new port:", error);
                    });
                });
            }
        }
    }
});

let checkInterval: NodeJS.Timeout | null = null;
let targetTimestamp: string | null = null; // The timestamp we're trying to scroll to
let lastFetchedTimestamp: string | null = null; // Last timestamp fetched from server
let lastScrolledMessageId: string | null = null; // Last message ID we scrolled to
let lastTargetTime: number | null = null; // Last target timestamp in milliseconds
let isContextMenuOpen = false; // Track if context menu is open
let contextMenuListener: ((event: any) => void) | null = null;
let channelChangeListener: ((event: any) => void) | null = null;
let currentChannelId: string | null = null;

async function fetchTimestamp(): Promise<{ gmt: string; } | null> {
    try {
        const port = settings.store.port;
        const response = await fetch(`http://localhost:${port}/ping`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.gmt ? { gmt: data.gmt } : null;
    } catch (error) {
        console.error("[YouTubeTimestampServer] Ping error:", error);
        return null;
    }
}

function findMessageByTimestamp(channelId: string, targetTimestamp: string): { id: string; diff: number; isClosest: boolean; } | null {
    const messages = MessageStore.getMessages(channelId);
    if (!messages) return null;

    const targetTime = new Date(targetTimestamp).getTime();
    const messageArray = messages._array || [];

    // If we have a previous target time and the new target is later, only look at messages after the last scrolled message
    // This prevents scrolling backward when timestamp moves forward
    let startIndex = 0;
    if (lastTargetTime !== null && targetTime > lastTargetTime && lastScrolledMessageId) {
        // Find the index of the last scrolled message
        const lastIndex = messageArray.findIndex(m => m.id === lastScrolledMessageId);
        if (lastIndex !== -1) {
            // Only search messages after the last scrolled one when moving forward
            startIndex = lastIndex;
        }
    }

    // Find all messages with timestamps and their differences
    const messagesWithDiffs: Array<{ id: string; diff: number; index: number; }> = [];

    for (let i = startIndex; i < messageArray.length; i++) {
        const message = messageArray[i];
        if (!message.timestamp) continue;
        const messageTime = message.timestamp.valueOf();

        // When moving forward, prefer messages that are at or after the target time
        // When moving backward or first time, use absolute difference
        let diff: number;
        if (lastTargetTime !== null && targetTime > lastTargetTime) {
            // Moving forward: prefer messages at or after target, but allow slightly before
            if (messageTime >= targetTime) {
                diff = messageTime - targetTime; // Prefer messages right at or after target
            } else {
                diff = targetTime - messageTime + 1000000; // Penalize messages before target
            }
        } else {
            // First time or moving backward: use absolute difference
            diff = Math.abs(messageTime - targetTime);
        }

        messagesWithDiffs.push({ id: message.id, diff, index: i });
    }

    if (messagesWithDiffs.length === 0) return null;

    // Find the closest message
    const closestMessage = messagesWithDiffs.reduce((prev, curr) =>
        curr.diff < prev.diff ? curr : prev
    );

    // Check if we're already at the closest message
    const isAlreadyAtClosest = lastScrolledMessageId === closestMessage.id;

    // Verify it's truly the closest by checking adjacent messages
    let isClosest = true;
    const closestIndex = closestMessage.index;
    const prevMessage = closestIndex > 0 ? messageArray[closestIndex - 1] : null;
    const nextMessage = closestIndex < messageArray.length - 1 ? messageArray[closestIndex + 1] : null;

    if (prevMessage?.timestamp) {
        const prevTime = prevMessage.timestamp.valueOf();
        let prevDiff: number;
        if (lastTargetTime !== null && targetTime > lastTargetTime) {
            if (prevTime >= targetTime) {
                prevDiff = prevTime - targetTime;
            } else {
                prevDiff = targetTime - prevTime + 1000000;
            }
        } else {
            prevDiff = Math.abs(prevTime - targetTime);
        }
        if (prevDiff < closestMessage.diff) {
            isClosest = false;
        }
    }

    if (nextMessage?.timestamp) {
        const nextTime = nextMessage.timestamp.valueOf();
        let nextDiff: number;
        if (lastTargetTime !== null && targetTime > lastTargetTime) {
            if (nextTime >= targetTime) {
                nextDiff = nextTime - targetTime;
            } else {
                nextDiff = targetTime - nextTime + 1000000;
            }
        } else {
            nextDiff = Math.abs(nextTime - targetTime);
        }
        if (nextDiff < closestMessage.diff) {
            isClosest = false;
        }
    }

    return {
        id: closestMessage.id,
        diff: closestMessage.diff,
        isClosest: isAlreadyAtClosest && isClosest
    };
}

function scrollToTimestamp() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    // First, check for a new timestamp from the server
    fetchTimestamp().then(data => {
        if (!data || !data.gmt) {
            // Continue trying with existing target if we have one
            if (targetTimestamp) {
                attemptScrollToTarget(channelId);
            }
            return;
        }

        // If we got a new timestamp from server, update our target
        if (lastFetchedTimestamp !== data.gmt) {
            lastFetchedTimestamp = data.gmt;
            const newTargetTime = new Date(data.gmt).getTime();

            // Only reset scroll tracking if timestamp moved forward significantly
            // If moving backward or small forward change, keep trying to reach the target
            if (lastTargetTime === null || newTargetTime > lastTargetTime + 1000) {
                lastScrolledMessageId = null; // Reset so we'll try to scroll to the new target
            }

            targetTimestamp = data.gmt;
            lastTargetTime = newTargetTime;
        }

        // Always try to scroll to the current target
        if (targetTimestamp) {
            attemptScrollToTarget(channelId);
        }
    });
}

function findMessageElement(messageId: string): Element | null {
    return document.getElementById(`message-content-${messageId}`) ||
        document.querySelector(`[id*="message-content-${messageId}"]`) ||
        document.querySelector(`[data-message-id="${messageId}"]`) ||
        document.querySelector(`[class*="message"][class*="${messageId}"]`);
}

function findScrollContainer(element: Element): Element | null {
    let scrollContainer: Element | null = element.parentElement;
    while (scrollContainer && scrollContainer !== document.body) {
        const classes = scrollContainer.className?.toString() || "";
        if ((classes.includes("scroller") || classes.includes("messages") ||
            classes.includes("chatContent")) &&
            scrollContainer.scrollHeight > scrollContainer.clientHeight) {
            return scrollContainer;
        }
        scrollContainer = scrollContainer.parentElement;
    }
    return null;
}

let isScrolling = false;
let scrollAnimationFrame: number | null = null;

function smoothScrollTo(scrollContainer: Element, targetScrollTop: number, duration: number = 500) {
    const startScrollTop = scrollContainer.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    const startTime = performance.now();

    if (Math.abs(distance) < 5) {
        isScrolling = false;
        return;
    }

    const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function (ease-out)
        const easeOut = 1 - Math.pow(1 - progress, 3);

        const currentScrollTop = startScrollTop + (distance * easeOut);
        scrollContainer.scrollTop = currentScrollTop;

        if (progress < 1) {
            scrollAnimationFrame = requestAnimationFrame(animate);
        } else {
            isScrolling = false;
            scrollAnimationFrame = null;
        }
    };

    scrollAnimationFrame = requestAnimationFrame(animate);
}

function scrollMessageToBottom(messageElement: Element, scrollContainer: Element | null) {
    if (isScrolling) {
        // Cancel previous animation if still running
        if (scrollAnimationFrame !== null) {
            cancelAnimationFrame(scrollAnimationFrame);
            scrollAnimationFrame = null;
        }
    }

    isScrolling = true;

    if (scrollContainer) {
        requestAnimationFrame(() => {
            const rect = messageElement.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            const viewportHeight = containerRect.height;
            const messageTop = rect.top - containerRect.top;
            const messageHeight = rect.height;

            // Calculate scroll position to put message at bottom (with padding)
            const currentScrollTop = scrollContainer.scrollTop;
            const targetScrollTop = currentScrollTop + messageTop - viewportHeight + messageHeight + 20;

            // Use custom smooth scroll animation
            smoothScrollTo(scrollContainer, targetScrollTop, 400);
        });
    } else {
        // Fallback: use scrollIntoView
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

function attemptScrollToTarget(channelId: string) {
    if (!targetTimestamp) return;

    // Don't scroll if context menu is open
    if (isContextMenuOpen) return;

    const result = findMessageByTimestamp(channelId, targetTimestamp);

    if (!result) return;

    // If we're already at the closest message, don't scroll again
    if (result.isClosest) return;

    // Only scroll if we're not already at this message or if it's a different (closer) message
    if (lastScrolledMessageId !== result.id) {
        lastScrolledMessageId = result.id;

        // Check if message is already rendered in the DOM
        const messageElement = findMessageElement(result.id);

        if (messageElement) {
            // Message is already rendered, use smooth manual scrolling
            // Small delay to ensure DOM is stable and prevent janky scrolling
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const scrollContainer = findScrollContainer(messageElement);
                    scrollMessageToBottom(messageElement, scrollContainer);
                });
            });
        } else {
            // Message is not rendered (far away), use jumpToMessage
            MessageActions.jumpToMessage({
                channelId,
                messageId: result.id,
                flash: false,
                jumpType: "ANIMATED"
            });

            // After jumping, scroll the message to the bottom of the viewport
            // Use multiple attempts with increasing delays to handle Discord's rendering
            const attemptScroll = (attempt: number = 0) => {
                if (attempt > 5) return; // Max 5 attempts

                const element = findMessageElement(result.id);
                if (element) {
                    const scrollContainer = findScrollContainer(element);
                    scrollMessageToBottom(element, scrollContainer);
                } else if (attempt < 5) {
                    // Retry if element not found yet
                    setTimeout(() => attemptScroll(attempt + 1), 100 * (attempt + 1));
                }
            };

            // Start attempting after a short delay to allow Discord to render
            setTimeout(() => attemptScroll(), 200);
        }
    }
}

function startPeriodicCheck() {
    if (checkInterval) return;
    const interval = settings.store.checkInterval * 1000;
    checkInterval = setInterval(scrollToTimestamp, interval);
    scrollToTimestamp();
}

function stopPeriodicCheck() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }

    // Cancel any ongoing scroll animation
    if (scrollAnimationFrame !== null) {
        cancelAnimationFrame(scrollAnimationFrame);
        scrollAnimationFrame = null;
    }
    isScrolling = false;

    targetTimestamp = null;
    lastFetchedTimestamp = null;
    lastScrolledMessageId = null;
    lastTargetTime = null;
}

function updateEnabledState(enabled: boolean) {
    // Toggle body class for CSS to hide prompts
    if (enabled) {
        document.body.classList.add("vc-youtube-timestamp-autoscroll-enabled");
        startPeriodicCheck();
    } else {
        document.body.classList.remove("vc-youtube-timestamp-autoscroll-enabled");
        stopPeriodicCheck();
    }
}

export default definePlugin({
    name: "YouTubeTimestampServer",
    description: "HTTP server for YouTube stream GMT timestamp (updated by userscript)",
    authors: [
        {
            id: 0n,
            name: "You"
        }
    ],
    settings,
    managedStyle: styles,

    start() {
        // Set initial body class state
        updateEnabledState(settings.store.enabled);

        // Listen for settings changes
        const listener = () => {
            updateEnabledState(settings.store.enabled);
        };
        SettingsStore.addChangeListener(`plugins.${this.name}.enabled`, listener);

        // Store listener for cleanup
        (this as any)._removeSettingsListener = () => {
            SettingsStore.removeChangeListener(`plugins.${this.name}.enabled`, listener);
        };

        // Listen for context menu open/close events to pause scrolling
        contextMenuListener = (event: any) => {
            if (event.type === "CONTEXT_MENU_OPEN") {
                isContextMenuOpen = true;
            } else if (event.type === "CONTEXT_MENU_CLOSE") {
                isContextMenuOpen = false;
            }
        };
        FluxDispatcher.subscribe("CONTEXT_MENU_OPEN", contextMenuListener);
        FluxDispatcher.subscribe("CONTEXT_MENU_CLOSE", contextMenuListener);

        // Listen for channel/server changes to disable autoscrolling
        currentChannelId = SelectedChannelStore.getChannelId();
        channelChangeListener = (event: any) => {
            const newChannelId = event.channelId ?? SelectedChannelStore.getChannelId();
            if (newChannelId && newChannelId !== currentChannelId) {
                currentChannelId = newChannelId;
                // Disable autoscrolling when switching channels/servers
                if (settings.store.enabled) {
                    settings.store.enabled = false;
                }
            }
        };
        FluxDispatcher.subscribe("CHANNEL_SELECT", channelChangeListener);

        const Native = getNative();
        if (Native) {
            const port = settings.store.port;
            Native.startServerIPC(port).then(result => {
                if (result.success) {
                    console.log(`[YouTubeTimestampServer] Server started on port ${result.port}`);
                } else {
                    console.error(`[YouTubeTimestampServer] Server start failed: ${result.error}`);
                }
            }).catch(error => {
                console.error("[YouTubeTimestampServer] Failed to start server:", error);
            });
        } else {
            console.error("[YouTubeTimestampServer] Native helper not available");
        }
    },

    stop() {
        stopPeriodicCheck();
        // Remove body class when plugin stops
        document.body.classList.remove("vc-youtube-timestamp-autoscroll-enabled");

        // Remove settings listener
        if ((this as any)._removeSettingsListener) {
            (this as any)._removeSettingsListener();
        }

        // Remove context menu listeners
        if (contextMenuListener) {
            FluxDispatcher.unsubscribe("CONTEXT_MENU_OPEN", contextMenuListener);
            FluxDispatcher.unsubscribe("CONTEXT_MENU_CLOSE", contextMenuListener);
            contextMenuListener = null;
        }
        isContextMenuOpen = false;

        // Remove channel change listeners
        if (channelChangeListener) {
            FluxDispatcher.unsubscribe("CHANNEL_SELECT", channelChangeListener);
            channelChangeListener = null;
        }
        currentChannelId = null;

        const Native = getNative();
        if (Native) {
            Native.stopServerIPC().catch(error => {
                console.error("[YouTubeTimestampServer] Failed to stop server:", error);
            });
        }
    },

    patches: [],

    contextMenus: {
        "channel-context": ((children, props) => {
            const enabled = settings.store.enabled;

            children.push(
                <Menu.MenuCheckboxItem
                    id="toggle-timestamp-autoscroll"
                    label={t("CONTEXT_MENU_ENABLE")}
                    checked={enabled}
                    action={() => {
                        settings.store.enabled = !enabled;
                    }}
                />
            );
        }) as NavContextMenuPatchCallback,
        "message": ((children, props) => {
            const { message } = props;
            if (!message?.timestamp) return;

            const messageTimestamp = message.timestamp.toISOString();

            children.push(
                <Menu.MenuItem
                    id="set-redirect-timestamp"
                    label={t("CONTEXT_MENU_SET_REDIRECT")}
                    action={async () => {
                        try {
                            const port = settings.store.port;
                            const response = await fetch(`http://localhost:${port}/redirect`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ timestamp: messageTimestamp })
                            });
                            const data = await response.json();
                            if (!data.success) {
                                console.error("[YouTubeTimestampServer] Failed to set redirect:", data.error);
                            }
                        } catch (error) {
                            console.error("[YouTubeTimestampServer] Error setting redirect:", error);
                        }
                    }}
                />
            );
        }) as NavContextMenuPatchCallback
    },
});

