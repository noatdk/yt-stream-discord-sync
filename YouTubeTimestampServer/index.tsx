import ErrorBoundary from "@components/ErrorBoundary";
import { definePluginSettings } from "@api/Settings";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageActions, MessageStore, SelectedChannelStore, useEffect, React, Menu } from "@webpack/common";
import { findComponentByCodeLazy } from "@webpack";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import styles from "./styles.css?managed";

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
        description: "Enable automatic scrolling to timestamp messages",
        default: false
    },
    checkInterval: {
        type: OptionType.NUMBER,
        description: "Check interval in seconds",
        default: 2
    },
    port: {
        type: OptionType.NUMBER,
        description: "Server port",
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

const Button = findComponentByCodeLazy(".NONE,disabled:", ".PANEL_BUTTON");

let checkInterval: NodeJS.Timeout | null = null;
let targetTimestamp: string | null = null; // The timestamp we're trying to scroll to
let lastFetchedTimestamp: string | null = null; // Last timestamp fetched from server
let lastScrolledMessageId: string | null = null; // Last message ID we scrolled to
let lastTargetTime: number | null = null; // Last target timestamp in milliseconds

async function fetchTimestamp(): Promise<{ gmt: string } | null> {
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

function findMessageByTimestamp(channelId: string, targetTimestamp: string): { id: string; diff: number; isClosest: boolean } | null {
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
    const messagesWithDiffs: Array<{ id: string; diff: number; index: number }> = [];

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

function attemptScrollToTarget(channelId: string) {
    if (!targetTimestamp) return;

    const result = findMessageByTimestamp(channelId, targetTimestamp);
    
    if (!result) return;

    // If we're already at the closest message, don't scroll again
    if (result.isClosest) return;

    // Only scroll if we're not already at this message or if it's a different (closer) message
    if (lastScrolledMessageId !== result.id) {
        lastScrolledMessageId = result.id;
        MessageActions.jumpToMessage({
            channelId,
            messageId: result.id,
            flash: true,
            jumpType: "SCROLL"
        });
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
    targetTimestamp = null;
    lastFetchedTimestamp = null;
    lastScrolledMessageId = null;
    lastTargetTime = null;
}

function TimestampIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
        </svg>
    );
}

function TimestampScrollButton(props: { nameplate?: any; }) {
    const { enabled } = settings.use(["enabled"]);

    useEffect(() => {
        if (enabled) {
            startPeriodicCheck();
        } else {
            stopPeriodicCheck();
        }
        return () => {
            if (!enabled) stopPeriodicCheck();
        };
    }, [enabled]);

    return (
        <Button
            tooltipText={enabled ? "Disable Timestamp Scrolling" : "Enable Timestamp Scrolling"}
            icon={TimestampIcon}
            role="switch"
            aria-checked={enabled}
            onClick={() => settings.store.enabled = !enabled}
            plated={props?.nameplate != null}
        />
    );
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
        const Native = getNative();
        if (Native) {
            Native.stopServerIPC().catch(error => {
                console.error("[YouTubeTimestampServer] Failed to stop server:", error);
            });
        }
    },

    patches: [
        {
            find: "#{intl::ACCOUNT_SPEAKING_WHILE_MUTED}",
            replacement: {
                match: /className:\i\.buttons,.{0,50}children:\[/,
                replace: "$&$self.TimestampScrollButton(arguments[0]),"
            }
        }
    ],

    TimestampScrollButton: ErrorBoundary.wrap(TimestampScrollButton, { noop: true }),

    contextMenus: {
        "message": ((children, props) => {
            const { message } = props;
            if (!message?.timestamp) return;

            const messageTimestamp = message.timestamp.toISOString();

            children.push(
                <Menu.MenuItem
                    id="set-redirect-timestamp"
                    label="Set as Redirect Timestamp"
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

