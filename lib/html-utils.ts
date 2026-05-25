function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function regenerateHtmlFromPlainText(text: string): string {
  if (!text) {
    return "";
  }

  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (const line of lines) {
    if (line === "") {
      paragraphs.push(currentParagraph.join("\n"));
      currentParagraph = [];
      continue;
    }
    currentParagraph.push(line);
  }

  paragraphs.push(currentParagraph.join("\n"));

  return paragraphs.map((paragraph) => {
    if (!paragraph) {
      return "<p><br /></p>";
    }
    return `<p>${escapeHtmlText(paragraph).replaceAll("\n", "<br />")}</p>`;
  }).join("");
}
