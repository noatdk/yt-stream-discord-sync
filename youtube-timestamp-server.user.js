// ==UserScript==
// @name         YouTube Stream Timestamp Worker
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Sends YouTube stream GMT timestamp to local server and handles redirects
// @author       Noat DK
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const PORT = 8080; // Designated local port

    let currentTimestamp = null;
    let videoElement = null;
    let streamStartTime = null; // Cached stream start time from API
    let videoId = null; // Cached video ID

    // Function to extract video ID from URL
    function extractVideoId() {
        // Try ?v= or &v= format
        const urlMatch = location.href.match(/[?&]v=([^&]+)/);
        if (urlMatch) {
            return urlMatch[1];
        }

        // Try /watch/ format
        const watchMatch = location.href.match(/\/watch\/([^/?&]+)/);
        if (watchMatch) {
            return watchMatch[1];
        }

        // Try /live/ format (for live streams)
        const liveMatch = location.href.match(/\/live\/([^/?&]+)/);
        if (liveMatch) {
            return liveMatch[1];
        }

        // Try /shorts/ format
        const shortsMatch = location.href.match(/\/shorts\/([^/?&]+)/);
        if (shortsMatch) {
            return shortsMatch[1];
        }

        return null;
    }

    // Function to extract start timestamp from ytInitialPlayerResponse
    function extractStartTimestampFromPage() {
        // Try to get from window.ytInitialPlayerResponse
        if (window.ytInitialPlayerResponse) {
            const playerResponse = window.ytInitialPlayerResponse;

            // Check videoDetails.liveBroadcastDetails.startTimestamp
            if (playerResponse.videoDetails?.liveBroadcastDetails?.startTimestamp) {
                const startTimestamp = playerResponse.videoDetails.liveBroadcastDetails.startTimestamp;
                console.log('[YouTubeTimestampServer] Stream start time:', startTimestamp);
                return startTimestamp;
            }

            // Check microformat.liveBroadcastDetails.startTimestamp
            if (playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp) {
                const startTimestamp = playerResponse.microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp;
                console.log('[YouTubeTimestampServer] Stream start time:', startTimestamp);
                return startTimestamp;
            }

            // Check videoDetails.publishDate (for archived streams)
            if (playerResponse.videoDetails?.publishDate) {
                const publishDate = playerResponse.videoDetails.publishDate;
                console.log('[YouTubeTimestampServer] Stream start time:', publishDate);
                return publishDate;
            }

            // Check microformat
            if (playerResponse.microformat?.playerMicroformatRenderer?.publishDate) {
                const publishDate = playerResponse.microformat.playerMicroformatRenderer.publishDate;
                console.log('[YouTubeTimestampServer] Stream start time:', publishDate);
                return publishDate;
            }
        }

        // Also try to extract from script tag (in case it's not in window yet)
        const scriptTags = document.querySelectorAll('script');
        for (const script of scriptTags) {
            const text = script.textContent || '';
            if (text.includes('ytInitialPlayerResponse') && (text.includes('startTimestamp') || text.includes('liveBroadcastDetails'))) {
                try {
                    // Try multiple patterns to extract the JSON object
                    let match = text.match(/var ytInitialPlayerResponse = ({[\s\S]*?});/);
                    if (!match) {
                        match = text.match(/var ytInitialPlayerResponse = ({[\s\S]*?})\s*$/m);
                    }
                    if (!match) {
                        match = text.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
                    }

                    if (match) {
                        const playerResponse = JSON.parse(match[1]);

                        // Check all paths
                        if (playerResponse.videoDetails?.liveBroadcastDetails?.startTimestamp) {
                            const startTimestamp = playerResponse.videoDetails.liveBroadcastDetails.startTimestamp;
                            console.log('[YouTubeTimestampServer] Stream start time:', startTimestamp);
                            return startTimestamp;
                        }
                        if (playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp) {
                            const startTimestamp = playerResponse.microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp;
                            console.log('[YouTubeTimestampServer] Stream start time:', startTimestamp);
                            return startTimestamp;
                        }
                        if (playerResponse.videoDetails?.publishDate) {
                            const publishDate = playerResponse.videoDetails.publishDate;
                            console.log('[YouTubeTimestampServer] Stream start time:', publishDate);
                            return publishDate;
                        }
                        if (playerResponse.microformat?.playerMicroformatRenderer?.publishDate) {
                            const publishDate = playerResponse.microformat.playerMicroformatRenderer.publishDate;
                            console.log('[YouTubeTimestampServer] Stream start time:', publishDate);
                            return publishDate;
                        }
                    }
                } catch (e) {
                    console.warn('[YouTubeTimestampServer] Failed to parse ytInitialPlayerResponse from script tag:', e);
                }
            }
        }

        return null;
    }

    // Main function to get stream start time
    function fetchStreamMetadata(videoId) {
        // First, try to extract from page
        const pageStartTime = extractStartTimestampFromPage();
        if (pageStartTime) {
            return pageStartTime;
        }
        return null;
    }

    // Function to get GMT timestamp from YouTube video
    function getYouTubeTimestamp() {
        try {
            // Try to get video element
            const video = document.querySelector('video');
            if (!video) {
                console.log('[YouTubeTimestampServer] getYouTubeTimestamp: Video element not found');
                return {
                    gmt: new Date().toISOString(),
                    error: 'Video element not found',
                    currentTime: null,
                    isLive: false
                };
            }

            const currentTime = video.currentTime;

            // Use cached stream start time (fetched from API before monitoring loop)
            // Calculate GMT timestamp based on stream start time + current video time
            let gmtTimestamp;
            if (streamStartTime && !isNaN(new Date(streamStartTime).getTime())) {
                // Calculate: stream start time + current video playback time = actual stream timestamp
                const startDate = new Date(streamStartTime);
                const startTime = startDate.getTime();
                const videoTimeMs = currentTime * 1000;
                const streamTimestamp = new Date(startTime + videoTimeMs);
                gmtTimestamp = streamTimestamp.toISOString();
            } else {
                // Fallback: if we can't determine stream start, use current time
                console.warn('[YouTubeTimestampServer] Stream start time not available, using current time as fallback');
                gmtTimestamp = new Date().toISOString();
            }

            const result = {
                gmt: gmtTimestamp,
                currentTime: currentTime,
                streamStartTime: streamStartTime,
                isLive: false,
                videoId: videoId
            };

            return result;
        } catch (error) {
            console.error('[YouTubeTimestampServer] Error getting YouTube timestamp:', error);
            return {
                gmt: new Date().toISOString(),
                error: error.message,
                currentTime: null,
                isLive: false
            };
        }
    }

    // Function to update timestamp and send to server
    function updateTimestamp() {
        currentTimestamp = getYouTubeTimestamp();
        // Send to local HTTP server
        sendTimestampToServer();
    }

    // Function to find and monitor video element
    function findVideoElement() {
        const video = document.querySelector('video');
        if (video && video !== videoElement) {
            videoElement = video;
            // Update timestamp when video time changes (throttled to avoid too many updates)
            let lastUpdateTime = 0;
            video.addEventListener('timeupdate', () => {
                const now = Date.now();
                // Only update if at least 2 seconds have passed since last update
                if (now - lastUpdateTime >= 2000) {
                    lastUpdateTime = now;
                    updateTimestamp();
                }
            });
            video.addEventListener('play', () => {
                updateTimestamp();
            });
            video.addEventListener('pause', () => {
                updateTimestamp();
            });
            updateTimestamp();
        }
    }

    // Monitor for video element
    function startMonitoring() {
        // First, extract video ID and fetch stream metadata
        videoId = extractVideoId();
        if (videoId) {
            const apiStartTime = fetchStreamMetadata(videoId);
            if (apiStartTime) {
                streamStartTime = apiStartTime;
            } else {
                console.warn('[YouTubeTimestampServer] Failed to fetch stream start time');
            }
        }

        findVideoElement();

        // Use MutationObserver to detect when video element is added
        const observer = new MutationObserver(() => {
            findVideoElement();
        });

        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        // Also check periodically
        setInterval(() => {
            findVideoElement();
        }, 1000);

        // Update timestamp every 2 seconds
        setInterval(() => {
            if (videoElement) {
                updateTimestamp();
            }
        }, 2000);

        // Send initial timestamp
        setTimeout(() => {
            updateTimestamp();
        }, 1000);
    }


    // Handle redirect timestamp from server
    function handleRedirect(redirectTimestamp) {
        if (!redirectTimestamp || !videoElement) {
            console.warn('[YouTubeTimestampServer] Cannot handle redirect: missing timestamp or video element');
            return;
        }

        try {
            const redirectTime = new Date(redirectTimestamp);
            if (isNaN(redirectTime.getTime())) {
                console.error('[YouTubeTimestampServer] Invalid redirect timestamp:', redirectTimestamp);
                return;
            }

            // Use cached stream start time
            // If we have stream start time, calculate video time accurately
            if (streamStartTime && !isNaN(new Date(streamStartTime).getTime())) {
                const startTime = new Date(streamStartTime).getTime();
                // Calculate seconds since stream started
                const secondsSinceStart = (redirectTime.getTime() - startTime) / 1000;

                if (secondsSinceStart >= 0 && secondsSinceStart <= videoElement.duration) {
                    // Seek video to the calculated time
                    videoElement.currentTime = secondsSinceStart;
                    console.log(`[YouTubeTimestampServer] Redirected to video time: ${secondsSinceStart.toFixed(2)}s`);
                } else {
                    console.warn(`[YouTubeTimestampServer] Redirect timestamp results in invalid video time: ${secondsSinceStart.toFixed(2)}s`);
                    console.warn(`[YouTubeTimestampServer] Video duration: ${videoElement.duration}s`);
                }
            } else {
                // Fallback: estimate based on current video time and time difference
                // This assumes the video started at some point relative to now
                const currentVideoTime = videoElement.currentTime;
                const now = new Date();
                const timeDiff = (redirectTime.getTime() - now.getTime()) / 1000; // seconds

                // Estimate: if redirect is in the past, seek backward; if in future, seek forward
                const targetVideoTime = currentVideoTime + timeDiff;

                if (targetVideoTime >= 0 && targetVideoTime <= videoElement.duration) {
                    videoElement.currentTime = targetVideoTime;
                    console.log(`[YouTubeTimestampServer] Redirected to estimated video time: ${targetVideoTime.toFixed(2)}s`);
                    console.warn(`[YouTubeTimestampServer] Using fallback estimation (stream start time not available)`);
                } else {
                    console.warn(`[YouTubeTimestampServer] Cannot calculate valid video time for redirect`);
                    console.warn(`[YouTubeTimestampServer] Calculated time: ${targetVideoTime.toFixed(2)}s, Video duration: ${videoElement.duration}s`);
                }
            }
        } catch (error) {
            console.error('[YouTubeTimestampServer] Error handling redirect:', error);
        }
    }

    // Send timestamp to local HTTP server
    function sendTimestampToServer() {
        const timestamp = currentTimestamp || getYouTubeTimestamp();

        // Send to local server via HTTP POST
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `http://localhost:${PORT}/update`,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(timestamp),
                onload: function(response) {
                    // Check for redirect in response
                    try {
                        const responseData = JSON.parse(response.responseText);
                        if (responseData.redirect) {
                            console.log('[YouTubeTimestampServer] Redirect received:', responseData.redirect);
                            handleRedirect(responseData.redirect);
                        }
                    } catch (e) {
                        console.warn('[YouTubeTimestampServer] Failed to parse response:', e);
                    }
                },
                onerror: function(error) {
                    console.error('[YouTubeTimestampServer] Request error:', error);
                }
            });
        } else {
            // Fallback to fetch
            fetch(`http://localhost:${PORT}/update`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(timestamp)
            }).then(response => {
                if (response.ok) {
                    return response.json();
                }
                return null;
            }).then(responseData => {
                if (responseData?.redirect) {
                    console.log('[YouTubeTimestampServer] Redirect received:', responseData.redirect);
                    handleRedirect(responseData.redirect);
                }
            }).catch(err => {
                console.error('[YouTubeTimestampServer] Fetch error:', err);
            });
        }
    }

    // Initialize
    function init() {
        startMonitoring();
    }

    // Start when ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Also listen for navigation changes (YouTube SPA)
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;

            // Reset cached data
            streamStartTime = null;
            videoId = null;
            videoElement = null;

            // Re-fetch metadata for new video
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

})();
