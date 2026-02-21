(() => {
  "use strict";

  const { onReady } = window.FW;

  const MENTION_PATTERN = /(?:^|\s)@([a-z0-9._-]{1,32})$/i;

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  onReady(() => {
    const forms = document.querySelectorAll("form.comment-form");
    if (forms.length < 1) return;

    for (const form of forms) {
      const textarea = form.querySelector("textarea.comment-textarea");
      const panel = form.querySelector(".comment-mention-suggest");
      if (!(textarea instanceof HTMLTextAreaElement) || !(panel instanceof HTMLDivElement)) continue;

      let debounceTimer = null;
      let abortController = null;
      let requestId = 0;
      let currentItems = [];
      let activeIndex = -1;
      let currentMatch = null;

      const closePanel = () => {
        panel.hidden = true;
        panel.innerHTML = "";
        currentItems = [];
        activeIndex = -1;
      };

      const appendReplyMention = (username) => {
        const safeUsername = String(username || "").trim().toLowerCase();
        if (!safeUsername) return;
        const token = `@${safeUsername}`;
        const value = textarea.value;
        const separator = value.trim().length < 1 || /\s$/.test(value) ? "" : "\n";
        textarea.value = `${value}${separator}${token} `;
        const cursor = textarea.value.length;
        textarea.setSelectionRange(cursor, cursor);
        textarea.focus();
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      };

      const setActive = (index) => {
        const options = panel.querySelectorAll("button[data-mention-option]");
        options.forEach((button, buttonIndex) => {
          if (!(button instanceof HTMLButtonElement)) return;
          button.classList.toggle("is-active", buttonIndex === index);
        });
        activeIndex = index;
      };

      const replaceMention = (username) => {
        if (!currentMatch) return;
        const value = textarea.value;
        const before = value.slice(0, currentMatch.start);
        const after = value.slice(currentMatch.end);
        const nextValue = `${before}@${username} ${after}`;
        textarea.value = nextValue;
        const nextCursor = before.length + username.length + 2;
        textarea.setSelectionRange(nextCursor, nextCursor);
        closePanel();
        textarea.focus();
      };

      const renderItems = (items) => {
        if (!Array.isArray(items) || items.length < 1) {
          closePanel();
          return;
        }
        currentItems = items;
        panel.hidden = false;
        panel.innerHTML = items
          .map(
            (item, index) => `
              <button type="button" data-mention-option data-index="${index}" data-username="${escapeHtml(item.username)}">
                <span class="mention-user">@${escapeHtml(item.username)}</span>
                <span class="mention-name">${escapeHtml(item.displayName)}</span>
              </button>
            `
          )
          .join("");

        panel.querySelectorAll("button[data-mention-option]").forEach((button) => {
          button.addEventListener("click", () => {
            const username = button.getAttribute("data-username") || "";
            if (username) replaceMention(username);
          });
        });

        setActive(0);
      };

      const parseCurrentMention = () => {
        const cursor = textarea.selectionStart;
        const beforeCursor = textarea.value.slice(0, cursor);
        const match = beforeCursor.match(MENTION_PATTERN);
        if (!match) return null;
        const needle = String(match[1] || "").trim();
        if (needle.length < 2) return null;
        const token = `@${needle}`;
        const tokenIndex = beforeCursor.lastIndexOf(token);
        if (tokenIndex < 0) return null;
        return {
          query: needle,
          start: tokenIndex,
          end: cursor
        };
      };

      const fetchSuggestions = async (query) => {
        if (abortController) abortController.abort();
        abortController = new AbortController();
        const token = ++requestId;

        try {
          const response = await fetch(`/api/users/suggest?q=${encodeURIComponent(query)}&limit=6`, {
            credentials: "same-origin",
            signal: abortController.signal,
            headers: {
              accept: "application/json"
            }
          });
          if (!response.ok) {
            closePanel();
            return;
          }
          const data = await response.json();
          if (token !== requestId) return;
          renderItems(Array.isArray(data.users) ? data.users : []);
        } catch (error) {
          if (error.name !== "AbortError") {
            console.warn("Mention suggest failed:", error);
          }
          closePanel();
        } finally {
          abortController = null;
        }
      };

      const scheduleFetch = () => {
        const match = parseCurrentMention();
        currentMatch = match;
        if (!match) {
          closePanel();
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void fetchSuggestions(match.query);
        }, 120);
      };

      textarea.addEventListener("input", scheduleFetch);
      textarea.addEventListener("click", scheduleFetch);
      textarea.addEventListener("focus", scheduleFetch);
      textarea.addEventListener("keydown", (event) => {
        if (panel.hidden || currentItems.length < 1) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((activeIndex + 1) % currentItems.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((activeIndex - 1 + currentItems.length) % currentItems.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const target = currentItems[Math.max(activeIndex, 0)];
          if (target?.username) {
            replaceMention(target.username);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closePanel();
        }
      });

      textarea.addEventListener("blur", () => {
        setTimeout(closePanel, 120);
      });

      document.querySelectorAll("[data-comment-reply-mention]").forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        element.addEventListener("click", (event) => {
          event.preventDefault();
          const username = element.getAttribute("data-comment-reply-mention") || "";
          appendReplyMention(username);
        });
      });

      form.closest(".wiki-comments")?.querySelectorAll(".comment-body a[href^=\"#reply-username-\"]").forEach((link) => {
        if (!(link instanceof HTMLAnchorElement)) return;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          const href = link.getAttribute("href") || "";
          const username = href.replace(/^#reply-username-/, "").trim().toLowerCase();
          appendReplyMention(username);
        });
      });
    }
  });
})();
