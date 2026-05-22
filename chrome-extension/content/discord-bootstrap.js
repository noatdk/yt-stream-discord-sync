(function() {
    "use strict";

    const {
        ENABLED_KEY
    } = globalThis.YT_DISCORD_SYNC_CONSTANTS || {
        ENABLED_KEY: "discordEnabled"
    };

    if (window.__ytDiscordTimestampSyncBootstrapInjected) {
        return;
    }
    window.__ytDiscordTimestampSyncBootstrapInjected = true;

    const BRIDGE_SOURCE = "yt-discord-sync-bridge";
    const PAGE_SOURCE = "yt-discord-sync-page";
    const PORT_NAME = "discord";
    let brokerPort = null;
    let reconnectTimeout = null;

    function postToPage(message) {
        window.postMessage({
            source: BRIDGE_SOURCE,
            ...message
        }, "*");
    }

    function postSettingsToPage(enabled) {
        postToPage({
            type: "settings",
            enabled: Boolean(enabled)
        });
    }

    function syncEnabledState() {
        try {
            chrome.storage.local.get({ [ENABLED_KEY]: true }, result => {
                postSettingsToPage(result[ENABLED_KEY]);
            });
        } catch {
            postSettingsToPage(true);
        }
    }

    function connectBroker() {
        if (brokerPort) {
            return;
        }

        if (typeof chrome === "undefined" || !chrome.runtime?.connect) {
            return;
        }

        try {
            brokerPort = chrome.runtime.connect({ name: PORT_NAME });
        } catch (error) {
            console.warn("[YT Discord Sync] Failed to connect broker:", error);
            scheduleReconnect();
            return;
        }

        brokerPort.onMessage.addListener(message => {
            if (message?.type === "timestamp" || message?.type === "snapshot") {
                postToPage({ type: "timestamp", payload: message.payload });
                postToPage({ type: "status", state: "connected" });
                return;
            }

            if (message?.type === "status") {
                postToPage(message);
            }
        });

        brokerPort.onDisconnect.addListener(() => {
            brokerPort = null;
            postToPage({ type: "status", state: "disconnected" });
            scheduleReconnect();
        });

        postToPage({ type: "status", state: "connected" });
        syncEnabledState();
    }

    function scheduleReconnect() {
        if (reconnectTimeout !== null) {
            return;
        }

        reconnectTimeout = window.setTimeout(() => {
            reconnectTimeout = null;
            connectBroker();
        }, 1000);
    }

    function relayPageMessage(event) {
        if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
            return;
        }

        if (event.data.type === "ready") {
            connectBroker();
            return;
        }

        if (event.data.type === "redirect" && event.data.timestamp && brokerPort) {
            console.log("[YT Discord Sync][Discord bootstrap] forwarding redirect", {
                timestamp: event.data.timestamp,
                brokerConnected: Boolean(brokerPort)
            });
            brokerPort.postMessage({
                type: "redirect",
                timestamp: event.data.timestamp
            });
        }
    }

    window.addEventListener("message", relayPageMessage);

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local" || !changes[ENABLED_KEY]) {
                return;
            }

            postSettingsToPage(changes[ENABLED_KEY].newValue);
        });
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page/discord-page.js");
    script.async = false;
    script.defer = false;
    script.onload = () => {
        script.remove();
    };

    (document.head || document.documentElement).appendChild(script);

    connectBroker();
})();
