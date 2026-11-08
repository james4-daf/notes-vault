// Wiki links are just [[Note]] / [[Note|label]] text. Resolve by filename,
// or by path when the link contains a slash.
// ponytail: fenced and inline code are skipped; indented code blocks are not.
// ponytail: two notes with the same name resolve to a sibling first, otherwise the shortest path.

export type FoundLink = {
  start: number;
  end: number;
  target: string;
  kind: "wiki" | "md";
};

type Range = { start: number; end: number };

export function noteTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

export function linktextFor(path: string, notes: string[]): string {
  const base = noteTitle(path);
  const same = notes.filter((item) => noteTitle(item).toLowerCase() === base.toLowerCase());
  if (same.length <= 1) return base;
  return path.replace(/\.md$/i, "");
}

export function pathForNewLink(target: string): string | null {
  let text = target.split("#")[0]?.trim() ?? "";
  text = text.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const pipe = text.indexOf("|");
  if (pipe >= 0) text = text.slice(0, pipe).trim();
  if (!text || text.includes("..") || /[\[\]|#]/.test(text)) return null;
  if (!text.toLowerCase().endsWith(".md")) text += ".md";
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part.startsWith("."))) return null;
  return parts.join("/");
}

export function resolveTarget(
  raw: string,
  sourcePath: string,
  notes: string[],
): string | null {
  let target = raw.trim();
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  target = target.trim().replace(/^\.\//, "");
  if (!target || target.startsWith("/") || target.includes("..")) return null;
  const file = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
  if (file.includes("/")) {
    return notes.find((note) => note.toLowerCase() === file.toLowerCase()) ?? null;
  }
  const hits = notes.filter(
    (note) => (note.split("/").pop() ?? note).toLowerCase() === file.toLowerCase(),
  );
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const sibling = hits.find((note) => {
    const parent = note.includes("/") ? note.slice(0, note.lastIndexOf("/")) : "";
    return parent === dir;
  });
  if (sibling) return sibling;
  return hits
    .slice()
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
}

export function scanMarkdown(markdown: string): { links: FoundLink[]; blocked: Range[] } {
  const links: FoundLink[] = [];
  const blocked: Range[] = [];
  let i = 0;
  while (i < markdown.length) {
    if (markdown.startsWith("```", i)) {
      const close = markdown.indexOf("```", i + 3);
      const end = close === -1 ? markdown.length : close + 3;
      blocked.push({ start: i, end });
      i = end;
      continue;
    }
    if (markdown[i] === "`") {
      const lineEnd = markdown.indexOf("\n", i);
      const limit = lineEnd === -1 ? markdown.length : lineEnd;
      const close = markdown.indexOf("`", i + 1);
      if (close === -1 || close > limit) {
        i += 1;
        continue;
      }
      blocked.push({ start: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (markdown.startsWith("[[", i)) {
      const close = markdown.indexOf("]]", i + 2);
      const inner = close === -1 ? "" : markdown.slice(i + 2, close);
      if (close === -1 || inner.includes("\n")) {
        i += 2;
        continue;
      }
      blocked.push({ start: i, end: close + 2 });
      const target = wikiTarget(inner);
      if (target) links.push({ start: i, end: close + 2, target, kind: "wiki" });
      i = close + 2;
      continue;
    }
    if (markdown[i] === "[") {
      const parsed = parseMdLinkAt(markdown, i);
      if (parsed) {
        const image = i > 0 && markdown[i - 1] === "!";
        blocked.push({ start: image ? i - 1 : i, end: parsed.end });
        if (!image && parsed.target) {
          links.push({ start: i, end: parsed.end, target: parsed.target, kind: "md" });
        }
        i = parsed.end;
        continue;
      }
    }
    i += 1;
  }
  return { links, blocked };
}

function wikiTarget(inner: string): string | null {
  const pipe = inner.indexOf("|");
  const body = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (!body || body.startsWith("#")) return null;
  return body;
}

function parseMdLinkAt(
  text: string,
  index: number,
): { end: number; target: string | null } | null {
  const labelEnd = text.indexOf("]", index + 1);
  if (labelEnd === -1 || labelEnd > index + 500 || text[labelEnd + 1] !== "(") return null;
  const destEnd = text.indexOf(")", labelEnd + 2);
  if (destEnd === -1 || destEnd > labelEnd + 2000) return null;
  return { end: destEnd + 1, target: internalTarget(text.slice(labelEnd + 2, destEnd)) };
}

function internalTarget(dest: string): string | null {
  let target = dest.trim();
  const space = target.search(/\s/);
  if (space >= 0) target = target.slice(0, space);
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep destinations that aren't valid percent-encoding.
  }
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  target = target.replace(/^\.\//, "");
  if (!target || target.startsWith("/")) return null;
  return target;
}
