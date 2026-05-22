(function() {
    "use strict";

    let currentTimestamp = null;
    let videoElement = null;
    let streamStartTime = null;
    let videoId = null;
    let pendingUpdateTimeout = null;
    let lastSentGmt = null;
    let brokerUnavailableUntil = 0;
    let brokerRetryTimeout = null;

    function extractVideoId() {
        const urlMatch = location.href.match(/[?&]v=([^&]+)/);
        if (urlMatch) {
            return urlMatch[1];
        }

        const watchMatch = location.href.match(/\/watch\/([^/?&]+)/);
        if (watchMatch) {
            return watchMatch[1];
        }

        const liveMatch = location.href.match(/\/live\/([^/?&]+)/);
        if (liveMatch) {
            return liveMatch[1];
        }

        const shortsMatch = location.href.match(/\/shorts\/([^/?&]+)/);
        if (shortsMatch) {
            return shortsMatch[1];
        }

        return null;
    }

    function extractStartTimestampFromPage() {
        const scriptTags = document.querySelectorAll("script");
        for (const script of scriptTags) {
            const text = script.textContent || "";
            if (!text.includes("ytInitialPlayerResponse")) continue;

            try {
                let match = text.match(/var ytInitialPlayerResponse = ({[\s\S]*?});/);
                if (!match) {
                    match = text.match(/var ytInitialPlayerResponse = ({[\s\S]*?})\s*$/m);
                }
                if (!match) {
                    match = text.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
                }

                if (!match) continue;

                const playerResponse = JSON.parse(match[1]);
                const startTimestamp =
                    playerResponse.videoDetails?.liveBroadcastDetails?.startTimestamp ||
                    playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp ||
                    playerResponse.videoDetails?.publishDate ||
                    playerResponse.microformat?.playerMicroformatRenderer?.publishDate ||
                    null;

                if (startTimestamp) {
                    return startTimestamp;
                }
            } catch (error) {
                console.warn("[YouTubeTimestampServer] Failed to parse ytInitialPlayerResponse:", error);
            }
        }

        return null;
    }

    function fetchStreamMetadata() {
        return extractStartTimestampFromPage();
    }

    function getYouTubeTimestamp() {
        try {
            const video = document.querySelector("video");
            if (!video) {
                return {
                    gmt: new Date().toISOString(),
                    error: "Video element not found",
                    currentTime: null,
                    isLive: false
                };
            }

            const currentTime = video.currentTime;
            let gmtTimestamp;

            if (streamStartTime && !isNaN(new Date(streamStartTime).getTime())) {
                const startTime = new Date(streamStartTime).getTime();
                gmtTimestamp = new Date(startTime + (currentTime * 1000)).toISOString();
            } else {
                gmtTimestamp = new Date().toISOString();
            }

            return {
                gmt: gmtTimestamp,
                currentTime,
                streamStartTime,
                isLive: false,
                videoId
            };
        } catch (error) {
            console.error("[YouTubeTimestampServer] Error getting YouTube timestamp:", error);
            return {
                gmt: new Date().toISOString(),
                error: error.message,
                currentTime: null,
                isLive: false
            };
        }
    }

    function handleRedirect(redirectTimestamp) {
        if (!redirectTimestamp) {
            return;
        }

        const redirectTime = new Date(redirectTimestamp);
        if (Number.isNaN(redirectTime.getTime())) {
            return;
        }

        const video = document.querySelector("video");
        if (!video) {
            return;
        }

        const hasStreamStartTime = Boolean(streamStartTime && !Number.isNaN(new Date(streamStartTime).getTime()));
        const currentVideoTime = video.currentTime || 0;
        const now = Date.now();
        const offsetSeconds = hasStreamStartTime
            ? (redirectTime.getTime() - new Date(streamStartTime).getTime()) / 1000
            : (redirectTime.getTime() - now) / 1000;

        console.log("[YT Discord Sync][YouTube] redirect received", {
            redirectTimestamp,
            streamStartTime: streamStartTime || null,
            hasStreamStartTime,
            currentVideoTime,
            offsetSeconds
        });

        try {
            if (hasStreamStartTime) {
                const startTime = new Date(streamStartTime).getTime();
                const secondsSinceStart = offsetSeconds;

                if (secondsSinceStart >= 0 && Number.isFinite(video.duration) && secondsSinceStart <= video.duration) {
                    video.currentTime = secondsSinceStart;
                }
            } else {
                const targetVideoTime = currentVideoTime + offsetSeconds;

                if (targetVideoTime >= 0 && Number.isFinite(video.duration) && targetVideoTime <= video.duration) {
                    video.currentTime = targetVideoTime;
                }
            }

            video.focus?.();
            video.dispatchEvent(new Event("seeked", { bubbles: true }));
            updateTimestamp();
        } catch (error) {
            console.warn("[YouTubeTimestampServer] Failed to handle redirect:", error);
        }
    }

    function updateTimestamp() {
        currentTimestamp = getYouTubeTimestamp();
        if (currentTimestamp?.gmt === lastSentGmt) {
            return;
        }

        lastSentGmt = currentTimestamp?.gmt || null;
        sendTimestampToBroker();
    }

    function scheduleTimestampUpdate(delay = 150) {
        if (pendingUpdateTimeout !== null) {
            clearTimeout(pendingUpdateTimeout);
        }

        pendingUpdateTimeout = window.setTimeout(() => {
            pendingUpdateTimeout = null;
            updateTimestamp();
        }, delay);
    }

    function attachVideoListeners(video) {
        if (!video || video.__ytDiscordSyncBound) {
            return;
        }

        video.__ytDiscordSyncBound = true;

        const onChange = () => scheduleTimestampUpdate();
        video.addEventListener("timeupdate", onChange);
        video.addEventListener("seeked", onChange);
        video.addEventListener("play", onChange);
        video.addEventListener("pause", onChange);
        video.addEventListener("ratechange", onChange);
        video.addEventListener("loadedmetadata", onChange);
        video.addEventListener("durationchange", onChange);
        video.addEventListener("waiting", onChange);
        video.addEventListener("playing", onChange);

        scheduleTimestampUpdate(1000);
    }

    function findVideoElement() {
        const video = document.querySelector("video");
        if (video && video !== videoElement) {
            videoElement = video;
            attachVideoListeners(videoElement);
            updateTimestamp();
        }
    }

    function startMonitoring() {
        videoId = extractVideoId();
        if (videoId) {
            const apiStartTime = fetchStreamMetadata(videoId);
            if (apiStartTime) {
                streamStartTime = apiStartTime;
            }
        }

        findVideoElement();

        const observer = new MutationObserver(() => {
            findVideoElement();
        });

        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        setInterval(() => {
            findVideoElement();
        }, 1500);

        scheduleTimestampUpdate(1000);
    }

    function sendTimestampToBroker() {
        const timestamp = currentTimestamp || getYouTubeTimestamp();
        const now = Date.now();

        if (now < brokerUnavailableUntil) {
            return;
        }

        if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
            console.warn("[YouTubeTimestampServer] Chrome extension runtime is unavailable");
            return;
        }

        try {
            chrome.runtime.sendMessage({ type: "timestamp", payload: timestamp }, () => {
                const runtimeError = chrome.runtime.lastError;
                if (!runtimeError) {
                    return;
                }

                const message = runtimeError.message || "";
                if (message.includes("Extension context invalidated")) {
                    brokerUnavailableUntil = Date.now() + 5000;
                    if (brokerRetryTimeout === null) {
                        brokerRetryTimeout = window.setTimeout(() => {
                            brokerRetryTimeout = null;
                            brokerUnavailableUntil = 0;
                            if (currentTimestamp) {
                                sendTimestampToBroker();
                            }
                        }, 5000);
                    }
                    return;
                }

                console.warn("[YouTubeTimestampServer] Failed to publish timestamp:", runtimeError);
            });
        } catch (error) {
            const message = error?.message || "";
            if (message.includes("Extension context invalidated")) {
                brokerUnavailableUntil = Date.now() + 5000;
                if (brokerRetryTimeout === null) {
                    brokerRetryTimeout = window.setTimeout(() => {
                        brokerRetryTimeout = null;
                        brokerUnavailableUntil = 0;
                        if (currentTimestamp) {
                            sendTimestampToBroker();
                        }
                    }, 5000);
                }
                return;
            }

            console.warn("[YouTubeTimestampServer] Failed to publish timestamp:", error);
        }
    }

    function init() {
        startMonitoring();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            streamStartTime = null;
            videoId = null;
            videoElement = null;
            lastSentGmt = null;

            if (pendingUpdateTimeout !== null) {
                clearTimeout(pendingUpdateTimeout);
                pendingUpdateTimeout = null;
            }

            if (brokerRetryTimeout !== null) {
                clearTimeout(brokerRetryTimeout);
                brokerRetryTimeout = null;
            }
            brokerUnavailableUntil = 0;

            setTimeout(() => {
                videoId = extractVideoId();
                if (videoId) {
                    const apiStartTime = fetchStreamMetadata(videoId);
                    if (apiStartTime) {
                        streamStartTime = apiStartTime;
                    }
                }
                findVideoElement();
                updateTimestamp();
            }, 1000);
        }
    }).observe(document, { subtree: true, childList: true });

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
            if (message?.type === "redirect" && message.timestamp) {
                handleRedirect(message.timestamp);
            }
        });
    }
})();
