if (typeof importScripts === "function") {
    importScripts("constants.js");
}

const {
    DEFAULT_JUMP_OFFSET_SECONDS,
    JUMP_OFFSET_KEY
} = globalThis.YT_DISCORD_SYNC_CONSTANTS || {
    DEFAULT_JUMP_OFFSET_SECONDS: 25,
    JUMP_OFFSET_KEY: "jumpOffsetSeconds"
};

let latestTimestamp = null;
let discordPorts = new Set();
let statePromise = null;
let jumpOffsetSeconds = DEFAULT_JUMP_OFFSET_SECONDS;

function loadState() {
    if (!statePromise) {
        statePromise = new Promise(resolve => {
            chrome.storage.local.get({ latestTimestamp: null, [JUMP_OFFSET_KEY]: DEFAULT_JUMP_OFFSET_SECONDS }, result => {
                latestTimestamp = result.latestTimestamp || null;
                jumpOffsetSeconds = Number.isFinite(Number(result[JUMP_OFFSET_KEY]))
                    ? Math.max(0, Number(result[JUMP_OFFSET_KEY]))
                    : DEFAULT_JUMP_OFFSET_SECONDS;
                resolve();
            });
        });
    }

    return statePromise;
}

function saveState() {
    chrome.storage.local.set({ latestTimestamp, [JUMP_OFFSET_KEY]: jumpOffsetSeconds });
}

function normalizeOffsetSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_JUMP_OFFSET_SECONDS;
    return Math.max(0, Math.round(parsed));
}

function applyJumpOffset(timestamp, offsetSeconds) {
    const redirectTime = new Date(timestamp);
    if (Number.isNaN(redirectTime.getTime())) {
        return null;
    }

    const adjusted = new Date(redirectTime.getTime() - (offsetSeconds * 1000));
    return adjusted.toISOString();
}

function resolveAndBroadcastRedirect(rawTimestamp, sourceLabel) {
    chrome.storage.local.get({ [JUMP_OFFSET_KEY]: jumpOffsetSeconds }, result => {
        jumpOffsetSeconds = normalizeOffsetSeconds(result[JUMP_OFFSET_KEY]);
        const adjustedTimestamp = applyJumpOffset(rawTimestamp, jumpOffsetSeconds);

        if (!adjustedTimestamp) {
            console.warn("[YT Discord Sync][Background] invalid redirect timestamp", {
                rawTimestamp,
                sourceLabel
            });
            return;
        }

        console.log("[YT Discord Sync][Background] redirect adjustment", {
            rawTimestamp,
            jumpOffsetSeconds,
            adjustedTimestamp,
            sourceLabel
        });

        broadcastRedirect(adjustedTimestamp);
    });
}

function postToPort(port, message) {
    try {
        port.postMessage(message);
    } catch {
        // Ignore ports that are already closing.
    }
}

function broadcastTimestamp(timestamp) {
    for (const port of [...discordPorts]) {
        postToPort(port, { type: "timestamp", payload: timestamp });
    }
}

function broadcastRedirect(timestamp) {
    chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://youtube.com/*"] }, tabs => {
        for (const tab of tabs || []) {
            if (typeof tab.id !== "number") continue;
            chrome.tabs.sendMessage(tab.id, { type: "redirect", timestamp }, () => {
                void chrome.runtime.lastError;
            });
        }
    });
}

function registerPort(port, registry) {
    registry.add(port);

    port.onDisconnect.addListener(() => {
        registry.delete(port);
    });
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name === "discord") {
        registerPort(port, discordPorts);

        loadState().then(() => {
            if (latestTimestamp) {
                postToPort(port, { type: "timestamp", payload: latestTimestamp });
            }
        });

        port.onMessage.addListener(message => {
            if (message?.type === "redirect" && message.timestamp) {
                resolveAndBroadcastRedirect(message.timestamp, "discord-port");
            }
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "timestamp" && message.payload?.gmt) {
        latestTimestamp = message.payload;
        saveState();
        broadcastTimestamp(latestTimestamp);
        sendResponse?.({ success: true });
        return true;
    }

    if (message?.type === "redirect" && message.timestamp) {
        resolveAndBroadcastRedirect(message.timestamp, "runtime-message");
        sendResponse?.({ success: true });
        return true;
    }

    return false;
});
