import {
  linktextFor,
  pathForNewLink,
  resolveTarget,
  scanMarkdown,
} from "./links.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const notes = [
  "Isaac Newton.md",
  "Physics/Three laws of motion.md",
  "Physics/Todo.md",
  "Todo.md",
];

const laws = [
  "See [[Isaac Newton]] and [[Isaac Newton#Life|the man]].",
  "Also [Newton](Isaac%20Newton.md).",
  "```",
  "[[Isaac Newton]]",
  "```",
  "`[[Isaac Newton]]` stays code.",
].join("\n");

const scanned = scanMarkdown(laws);
assert(scanned.links.length === 3, `expected 3 links, got ${scanned.links.length}`);

assert(resolveTarget("Todo", "Physics/Three laws of motion.md", notes) === "Physics/Todo.md", "sibling");
assert(resolveTarget("Todo", "Isaac Newton.md", notes) === "Todo.md", "shortest");
assert(resolveTarget("Physics/Todo", "Isaac Newton.md", notes) === "Physics/Todo.md", "path");
assert(resolveTarget("todo.md", "Isaac Newton.md", notes) === "Todo.md", "case");
assert(resolveTarget("missing", "Isaac Newton.md", notes) === null, "missing");
assert(resolveTarget("#Heading", "Isaac Newton.md", notes) === null, "same-note heading");

assert(linktextFor("Isaac Newton.md", notes) === "Isaac Newton", "unique linktext");
assert(linktextFor("Physics/Todo.md", notes) === "Physics/Todo", "ambiguous linktext");
assert(pathForNewLink("Work/New note") === "Work/New note.md", "new path");
assert(pathForNewLink("../secret") === null, "reject escape");

console.log("links ok");
