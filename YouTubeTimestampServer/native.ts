import type { IpcMainInvokeEvent } from "electron";
import { createServer, Server } from "http";

const DEFAULT_PORT = 8080;
const ENDPOINT = "/ping";

let currentPort = DEFAULT_PORT;

// In-memory storage for timestamp data
let timestampData: any = null;
let lastUpdate: number | null = null;
let redirectTimestamp: string | null = null; // Redirect timestamp set via context menu

let server: Server | null = null;

function isValidTimestamp(timestamp: any): boolean {
    if (typeof timestamp !== "string") {
        return false;
    }
    const date = new Date(timestamp);
    return !isNaN(date.getTime()) && timestamp.includes("T") && timestamp.includes("Z");
}

function startServer(port: number = DEFAULT_PORT): Server {
    // If server is running on a different port, stop it first
    if (server && currentPort !== port) {
        stopServer();
    }
    
    if (server) {
        console.warn("[YouTubeTimestampServer] Server already running");
        return server;
    }
    
    currentPort = port;

    server = createServer((req, res) => {
        const url = req.url || "";
        const method = req.method || "";

        // Handle CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (method === "OPTIONS") {
            res.writeHead(200);
            res.end();
            return;
        }

        // Handle /ping endpoint (GET request)
        if (url === ENDPOINT || url === ENDPOINT + "/") {
            if (method === "GET") {
                try {
                    if (!timestampData) {
                        console.log(`[YouTubeTimestampServer] GET /ping -> 404 (no data)`);
                        res.writeHead(404, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "No timestamp data found" }));
                        return;
                    }

                    let responseData = { ...timestampData };

                    // Check if data is recent
                    if (lastUpdate) {
                        const age = (Date.now() - lastUpdate) / 1000;
                        if (age > 10) {
                            responseData = {
                                ...responseData,
                                warning: `Data may be stale (${Math.round(age)} seconds old)`
                            };
                        }
                    }

                    console.log(`[YouTubeTimestampServer] GET /ping -> 200 (${responseData.gmt})`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(responseData, null, 2));
                } catch (error: any) {
                    console.error(`[YouTubeTimestampServer] GET /ping -> 500: ${error.message}`);
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: error.message }));
                }
                return;
            }
        }

        // Handle /update endpoint (POST request from userscript)
        if (url === "/update" && method === "POST") {
            let body = "";

            req.on("data", chunk => {
                body += chunk.toString();
            });

            req.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    
                    // Validate timestamp
                    if (!data.gmt || !isValidTimestamp(data.gmt)) {
                        console.warn(`[YouTubeTimestampServer] POST /update -> 400 (invalid timestamp)`);
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Invalid or missing gmt timestamp. Expected ISO 8601 format (e.g., 2025-11-28T21:00:00.000Z)" }));
                        return;
                    }
                    
                    timestampData = data;
                    lastUpdate = Date.now();

                    const response: any = { success: true, received: timestampData.gmt };
                    
                    // Include redirect timestamp if it exists, then clear it
                    if (redirectTimestamp) {
                        response.redirect = redirectTimestamp;
                        console.log(`[YouTubeTimestampServer] POST /update -> 200 (${data.gmt}, redirect: ${redirectTimestamp})`);
                        redirectTimestamp = null; // Clear after returning
                    } else {
                        console.log(`[YouTubeTimestampServer] POST /update -> 200 (${data.gmt})`);
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(response));
                } catch (error: any) {
                    console.error(`[YouTubeTimestampServer] POST /update -> 400: ${error.message}`);
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON data" }));
                }
            });
            return;
        }

        // Handle /redirect endpoint (POST request from context menu)
        if (url === "/redirect" && method === "POST") {
            let body = "";

            req.on("data", chunk => {
                body += chunk.toString();
            });

            req.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.timestamp) {
                        console.warn(`[YouTubeTimestampServer] POST /redirect -> 400 (missing timestamp)`);
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Missing timestamp field" }));
                        return;
                    }
                    
                    // Validate timestamp
                    if (!isValidTimestamp(data.timestamp)) {
                        console.warn(`[YouTubeTimestampServer] POST /redirect -> 400 (invalid timestamp)`);
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Invalid timestamp format. Expected ISO 8601 format (e.g., 2025-11-28T21:00:00.000Z)" }));
                        return;
                    }
                    
                    redirectTimestamp = data.timestamp;
                    console.log(`[YouTubeTimestampServer] POST /redirect -> 200 (${data.timestamp})`);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true, redirect: redirectTimestamp }));
                } catch (error: any) {
                    console.error(`[YouTubeTimestampServer] POST /redirect -> 400: ${error.message}`);
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON data" }));
                }
            });
            return;
        }

        // 404 for other paths
        console.log(`[YouTubeTimestampServer] ${method} ${url} -> 404`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });

    try {
        server.listen(currentPort, () => {
            console.log(`[YouTubeTimestampServer] Server running on http://localhost:${currentPort}`);
        });

        server.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRINUSE") {
                console.error(`[YouTubeTimestampServer] Port ${currentPort} is already in use. Server not started.`);
                server = null;
            } else {
                console.error("[YouTubeTimestampServer] Server error:", error);
                server = null;
            }
        });
    } catch (error: any) {
        console.error("[YouTubeTimestampServer] Failed to start server:", error);
        server = null;
        throw error;
    }

    return server;
}

function stopServer() {
    if (server) {
        server.close(() => {
            console.log("[YouTubeTimestampServer] Server closed");
        });
        server = null;
        timestampData = null;
        lastUpdate = null;
        redirectTimestamp = null;
    }
}

// IPC functions - these are called from the renderer process
export function startServerIPC(_event: IpcMainInvokeEvent, port: number = DEFAULT_PORT) {
    try {
        startServer(port);
        return { success: true, port: currentPort };
    } catch (error: any) {
        console.error("[YouTubeTimestampServer] Failed to start server via IPC:", error);
        return { success: false, error: error.message, port: currentPort };
    }
}

export function stopServerIPC(_event: IpcMainInvokeEvent) {
    stopServer();
    return { success: true };
}

// Auto-start server when module loads (runs in main process)
try {
    startServer(DEFAULT_PORT);
} catch (error: any) {
    console.error("[YouTubeTimestampServer] Failed to auto-start server:", error);
}


