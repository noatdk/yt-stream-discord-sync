(function() {
    "use strict";

    const {
        ENABLED_KEY,
        JUMP_OFFSET_KEY,
        DEFAULT_JUMP_OFFSET_SECONDS
    } = globalThis.YT_DISCORD_SYNC_CONSTANTS || {
        ENABLED_KEY: "discordEnabled",
        JUMP_OFFSET_KEY: "jumpOffsetSeconds",
        DEFAULT_JUMP_OFFSET_SECONDS: 25
    };
    const button = document.getElementById("toggle");
    const jumpOffsetInput = document.getElementById("jumpOffset");

    function render(enabled) {
        button.textContent = enabled ? "Discord enabled" : "Discord disabled";
        button.classList.toggle("off", !enabled);
    }

    function renderJumpOffset(value) {
        jumpOffsetInput.value = String(Number.isFinite(value) ? value : DEFAULT_JUMP_OFFSET_SECONDS);
    }

    function loadState() {
        chrome.storage.local.get({ [ENABLED_KEY]: true, [JUMP_OFFSET_KEY]: DEFAULT_JUMP_OFFSET_SECONDS }, result => {
            render(Boolean(result[ENABLED_KEY]));
            renderJumpOffset(Number(result[JUMP_OFFSET_KEY]));
        });
    }

    button.addEventListener("click", () => {
        chrome.storage.local.get({ [ENABLED_KEY]: true }, result => {
            const nextEnabled = !Boolean(result[ENABLED_KEY]);
            chrome.storage.local.set({ [ENABLED_KEY]: nextEnabled }, () => {
                render(nextEnabled);
            });
        });
    });

    jumpOffsetInput.addEventListener("change", () => {
        const nextValue = Math.max(0, Math.round(Number(jumpOffsetInput.value || 0)));
        chrome.storage.local.set({ [JUMP_OFFSET_KEY]: nextValue }, () => {
            renderJumpOffset(nextValue);
        });
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[ENABLED_KEY]) {
            if (areaName === "local" && changes[JUMP_OFFSET_KEY]) {
                renderJumpOffset(Number(changes[JUMP_OFFSET_KEY].newValue));
            }
            return;
        }

        render(Boolean(changes[ENABLED_KEY].newValue));
        if (changes[JUMP_OFFSET_KEY]) {
            renderJumpOffset(Number(changes[JUMP_OFFSET_KEY].newValue));
        }
    });

    loadState();
})();
