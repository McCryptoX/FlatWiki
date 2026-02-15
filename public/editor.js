"use strict";

const onReady = (callback) => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
};

const appendMarkdown = (textarea, markdownBlock) => {
  if (!markdownBlock) return;
  const value = textarea.value;
  const separator = value.trim().length === 0 ? "" : "\n\n";
  textarea.value = `${value}${separator}${markdownBlock}`.trimStart();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

onReady(() => {
  const editorShell = document.querySelector(".editor-shell");
  if (!editorShell) return;

  const contentTextarea = editorShell.querySelector('textarea[name="content"]');
  const uploadForm = editorShell.querySelector(".image-upload-form");
  const output = editorShell.querySelector(".upload-markdown-output");

  if (!(contentTextarea instanceof HTMLTextAreaElement)) return;
  if (!(uploadForm instanceof HTMLFormElement)) return;
  if (!(output instanceof HTMLTextAreaElement)) return;

  const uploadEndpoint = uploadForm.dataset.uploadEndpoint || "/api/uploads";
  const csrfToken = uploadForm.dataset.csrf || "";

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fileInput = uploadForm.querySelector('input[type="file"][name="images"]');
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files || fileInput.files.length === 0) {
      output.value = "Bitte mindestens ein Bild auswählen.";
      return;
    }

    const formData = new FormData();
    for (const file of fileInput.files) {
      formData.append("images", file, file.name);
    }

    output.value = "Upload läuft...";

    try {
      const response = await fetch(uploadEndpoint, {
        method: "POST",
        headers: {
          "x-csrf-token": csrfToken
        },
        credentials: "same-origin",
        body: formData
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        output.value = data.error || "Upload fehlgeschlagen.";
        return;
      }

      const markdown = String(data.markdown || "").trim();
      appendMarkdown(contentTextarea, markdown);
      output.value = markdown || "Upload abgeschlossen.";
      fileInput.value = "";
    } catch (_error) {
      output.value = "Upload fehlgeschlagen. Bitte erneut versuchen.";
    }
  });
});
