import { invoke } from "@tauri-apps/api/core";
import { Editor, Extension } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  linktextFor,
  noteTitle,
  pathForNewLink,
  resolveTarget,
  scanMarkdown,
} from "./links";

type Tab = {
  path: string;
  body: string;
  savedBody: string;
};

const DAILY_PREFIX = "Daily/";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const treeEl = must<HTMLElement>("tree");
const tabsEl = must<HTMLElement>("tabs");
const editorEl = must<HTMLElement>("editor");
const suggestEl = must<HTMLElement>("link-suggest");
const formatBar = must<HTMLElement>("format-bar");
const statusEl = must<HTMLElement>("status");
const vaultPathEl = must<HTMLElement>("vault-path");
const vaultToggle = must<HTMLButtonElement>("vault-toggle");
const vaultNameEl = must<HTMLElement>("vault-name");
const vaultMenu = must<HTMLElement>("vault-menu");
const vaultListEl = must<HTMLElement>("vault-list");
const vaultCreateForm = must<HTMLFormElement>("vault-create-form");
const vaultCreateName = must<HTMLInputElement>("vault-create-name");
const vaultNewBtn = must<HTMLButtonElement>("vault-new");
const vaultRenameBtn = must<HTMLButtonElement>("vault-rename");
const vaultDeleteBtn = must<HTMLButtonElement>("vault-delete");
const createForm = must<HTMLFormElement>("create-form");
const createPath = must<HTMLInputElement>("create-path");
const newFileBtn = must<HTMLButtonElement>("new-file");
const newFolderBtn = must<HTMLButtonElement>("new-folder");
const deleteBtn = must<HTMLButtonElement>("delete");
const pinBtn = must<HTMLButtonElement>("pin");
const deleteDialog = must<HTMLDialogElement>("delete-dialog");
const deleteTitle = must<HTMLElement>("delete-title");
const deleteMessage = must<HTMLElement>("delete-message");
const syncNowBtn = must<HTMLButtonElement>("sync-now");
const syncSettingsBtn = must<HTMLButtonElement>("sync-settings");
const syncDialog = must<HTMLDialogElement>("sync-dialog");
const syncForm = must<HTMLFormElement>("sync-form");
const syncUrl = must<HTMLInputElement>("sync-url");
const syncToken = must<HTMLInputElement>("sync-token");
const syncPassphrase = must<HTMLInputElement>("sync-passphrase");
const newTabBtn = must<HTMLButtonElement>("new-tab");

type VaultInfo = { id: string; name: string };
type VaultList = { active: string; vaults: VaultInfo[] };

type SyncConfig = {
  worker_url: string;
  token: string;
  passphrase: string;
};

type SyncReport = {
  pushed: number;
  pulled: number;
  deleted_remote: number;
  message: string;
};
const sidebarToggle = must<HTMLButtonElement>("sidebar-toggle");
const calendarToggle = must<HTMLButtonElement>("calendar-toggle");
const calMonthEl = must<HTMLElement>("cal-month");
const calYearEl = must<HTMLElement>("cal-year");
const calGridEl = must<HTMLElement>("cal-grid");
const calPrev = must<HTMLButtonElement>("cal-prev");
const calNext = must<HTMLButtonElement>("cal-next");
const calToday = must<HTMLButtonElement>("cal-today");

let notes: string[] = [];
let tabs: Tab[] = [];
let active = -1;
let saveTimer = 0;
let syncTimer = 0;
const SAVE_DEBOUNCE_MS = 2000;
const SYNC_DEBOUNCE_MS = 8000;
let createMode: "file" | "folder" | null = null;
let applying = false;
let pins: string[] = [];
let collapsedFolders = new Set<string>();
let vaults: VaultInfo[] = [];
let activeVaultId = "";
let vaultMenuMode: "create" | "rename" | null = null;
let pendingDelete: "note" | "vault" | null = null;
let sidebarOpen = localStorage.getItem("sidebarOpen") !== "0";
let calendarOpen = localStorage.getItem("calendarOpen") !== "0";
let drag: {
  path: string;
  name: string;
  row: HTMLElement;
  startX: number;
  startY: number;
  moved: boolean;
  ghost: HTMLElement | null;
  lastFolder: string | null;
} | null = null;
let suppressNoteClick = false;
const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();
let suggestIndex = 0;
let suggestQuery = "";
let suggestPaths: string[] = [];
let suggestCreate = false;

const WikiLinks = Extension.create({
  name: "wikiLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            return decorateWiki(state.doc);
          },
        },
      }),
    ];
  },
});

const editor = new Editor({
  element: editorEl,
  extensions: [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true },
    }),
    Placeholder.configure({ placeholder: "Start writing, or type [[ to link…" }),
    Markdown.configure({
      html: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    WikiLinks,
  ],
  editable: false,
  editorProps: {
    attributes: {
      class: "ProseMirror-note",
      spellcheck: "true",
    },
    handleKeyDown(_view, event) {
      return onSuggestKey(event);
    },
  },
  onUpdate: () => {
    if (applying) return;
    syncSuggest();
    const tab = activeTab();
    if (!tab) return;
    tab.body = getMarkdown();
    renderTabs();
    syncToolbar();
    setStatus(isDirty(tab) ? "Unsaved" : "Saved");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void flushActive();
    }, SAVE_DEBOUNCE_MS);
  },
  onSelectionUpdate: () => {
    syncToolbar();
    if (!applying) syncSuggest();
  },
});

editor.on("blur", () => {
  window.setTimeout(() => {
    if (!editor.isFocused) hideSuggest();
  }, 0);
});

editorEl.addEventListener("scroll", () => {
  if (!suggestEl.hidden) placeSuggest();
});

editorEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.shiftKey) return;
  const el = event.target instanceof Element ? event.target : null;
  const wiki = el?.closest(".wikilink");
  if (!(wiki instanceof HTMLElement) || !wiki.dataset.target) return;
  event.preventDefault();
  void followTarget(wiki.dataset.target);
});

editorEl.addEventListener("click", (event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  const anchor = el.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!href) return;
  event.preventDefault();
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    window.open(href, "_blank", "noopener");
    return;
  }
  void followTarget(decodeLink(href));
});

suggestEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
  const item = (event.target as HTMLElement).closest("button[data-index]");
  if (!(item instanceof HTMLButtonElement)) return;
  const index = Number(item.dataset.index);
  if (!Number.isNaN(index)) acceptSuggest(index);
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitCreate();
});

createPath.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideCreate();
  }
});

createPath.addEventListener("blur", () => {
  window.setTimeout(() => {
    if (createMode && document.activeElement !== createPath) hideCreate();
  }, 0);
});

newFileBtn.addEventListener("click", () => {
  startCreate("file");
});

newFolderBtn.addEventListener("click", () => {
  startCreate("folder");
});

newTabBtn.addEventListener("click", () => {
  startCreate("file");
});

sidebarToggle.addEventListener("click", () => {
  setSidebarOpen(!sidebarOpen);
});

calendarToggle.addEventListener("click", () => {
  setCalendarOpen(!calendarOpen);
});

calPrev.addEventListener("click", () => {
  viewMonth -= 1;
  if (viewMonth < 0) {
    viewMonth = 11;
    viewYear -= 1;
  }
  renderCalendar();
});

calNext.addEventListener("click", () => {
  viewMonth += 1;
  if (viewMonth > 11) {
    viewMonth = 0;
    viewYear += 1;
  }
  renderCalendar();
});

calToday.addEventListener("click", () => {
  const today = new Date();
  viewYear = today.getFullYear();
  viewMonth = today.getMonth();
  renderCalendar();
  void openDaily(isoDate(today));
});

calGridEl.addEventListener("click", (event) => {
  const day = (event.target as HTMLElement).closest("button[data-date]");
  if (!(day instanceof HTMLButtonElement) || !day.dataset.date) return;
  void openDaily(day.dataset.date);
});

formatBar.addEventListener("mousedown", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("#delete, #pin")) return;
  event.preventDefault();
});

formatBar.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button[data-cmd]");
  if (!(button instanceof HTMLButtonElement) || !button.dataset.cmd) return;
  if (!editor.isEditable) return;
  runFormat(button.dataset.cmd);
  editor.commands.focus();
  syncToolbar();
});

pinBtn.addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  togglePin(tab.path);
});

deleteBtn.addEventListener("click", () => {
  askDelete();
});

deleteDialog.addEventListener("close", () => {
  const kind = pendingDelete;
  pendingDelete = null;
  if (deleteDialog.returnValue !== "confirm" || !kind) return;
  if (kind === "note") void removeNote();
  else void confirmDeleteVault();
});

vaultToggle.addEventListener("click", () => {
  setVaultMenuOpen(Boolean(vaultMenu.hidden));
});

vaultNewBtn.addEventListener("click", () => {
  startVaultPrompt("create");
});

vaultRenameBtn.addEventListener("click", () => {
  startVaultPrompt("rename");
});

vaultDeleteBtn.addEventListener("click", () => {
  askDeleteVault();
});

vaultCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitVaultPrompt();
});

vaultCreateName.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideVaultPrompt();
  }
});

vaultListEl.addEventListener("click", (event) => {
  const btn = eventElement(event.target)?.closest("button.vault-option");
  if (!(btn instanceof HTMLButtonElement) || !btn.dataset.id) return;
  void selectVault(btn.dataset.id);
});

document.addEventListener("mousedown", (event) => {
  if (vaultMenu.hidden) return;
  const target = eventElement(event.target);
  if (!target) return;
  if (target.closest("#vault-menu") || target.closest("#vault-toggle")) return;
  setVaultMenuOpen(false);
});

syncSettingsBtn.addEventListener("click", () => {
  void openSyncSettings();
});

syncNowBtn.addEventListener("click", () => {
  window.clearTimeout(syncTimer);
  void syncVault({ quiet: false });
});

syncForm.addEventListener("submit", (event) => {
  const submitter = (event as SubmitEvent).submitter;
  if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "save") return;
  event.preventDefault();
  void saveSyncSettings();
});

treeEl.addEventListener("click", (event) => {
  const pin = eventElement(event.target)?.closest("button.pin-toggle");
  if (pin instanceof HTMLButtonElement && pin.dataset.path) {
    event.preventDefault();
    event.stopPropagation();
    togglePin(pin.dataset.path);
    return;
  }
  const folderToggle = eventElement(event.target)?.closest("button.folder-toggle");
  if (folderToggle instanceof HTMLButtonElement && folderToggle.dataset.folder != null) {
    event.preventDefault();
    toggleFolder(folderToggle.dataset.folder);
    return;
  }
  if (suppressNoteClick) {
    suppressNoteClick = false;
    return;
  }
  const open = eventElement(event.target)?.closest(".note-open");
  if (!(open instanceof HTMLElement) || !open.dataset.path) return;
  void openNote(open.dataset.path);
});

treeEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  const el = eventElement(event.target);
  if (!el || el.closest("button.pin-toggle")) return;
  const row = el.closest(".note-row");
  if (!(row instanceof HTMLElement) || !row.dataset.path) return;
  event.preventDefault();
  const name =
    row.querySelector(".note-open")?.textContent?.trim() ||
    row.dataset.path.split("/").pop()?.replace(/\.md$/i, "") ||
    "Note";
  drag = {
    path: row.dataset.path,
    name,
    row,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    ghost: null,
    lastFolder: null,
  };
  window.addEventListener("mousemove", onNoteDragMove);
  window.addEventListener("mouseup", onNoteDragUp);
  window.addEventListener("blur", onNoteDragCancel);
});

tabsEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const close = target.closest("button.close");
  if (close instanceof HTMLButtonElement) {
    event.stopPropagation();
    const index = Number(close.dataset.index);
    if (!Number.isNaN(index)) void closeTab(index);
    return;
  }
  const tabBtn = target.closest(".tab");
  if (tabBtn instanceof HTMLElement && tabBtn.dataset.index != null) {
    const index = Number(tabBtn.dataset.index);
    if (!Number.isNaN(index)) void activateTab(index);
  }
});

tabsEl.addEventListener("auxclick", (event) => {
  if (event.button !== 1) return;
  const tabBtn = (event.target as HTMLElement).closest(".tab");
  if (!(tabBtn instanceof HTMLElement) || tabBtn.dataset.index == null) return;
  event.preventDefault();
  const index = Number(tabBtn.dataset.index);
  if (!Number.isNaN(index)) void closeTab(index);
});

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "n") {
    event.preventDefault();
    startCreate("file");
  }
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    window.clearTimeout(saveTimer);
    void flushActive();
  }
  if (mod && event.key.toLowerCase() === "w") {
    event.preventDefault();
    if (active >= 0) void closeTab(active);
  }
  if (mod && event.key === "Tab") {
    if (tabs.length < 2) return;
    event.preventDefault();
    const next = event.shiftKey
      ? (active - 1 + tabs.length) % tabs.length
      : (active + 1) % tabs.length;
    void activateTab(next);
  }
});

setSidebarOpen(sidebarOpen);
setCalendarOpen(calendarOpen);
void boot();

async function boot() {
  try {
    await loadVaultState();
    await refresh();
    if (notes.length > 0) await openNote(notes[0]);
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function loadVaultState(list?: VaultList) {
  const data = list ?? (await invoke<VaultList>("list_vaults"));
  applyVaultList(data);
  pins = loadPins();
  collapsedFolders = loadCollapsedFolders();
  const path = await invoke<string>("vault_path");
  const current = vaults.find((vault) => vault.id === activeVaultId);
  vaultPathEl.textContent = current ? `${current.name}\n${path}` : path;
}

function applyVaultList(data: VaultList) {
  vaults = data.vaults;
  activeVaultId = data.active;
  const current = vaults.find((vault) => vault.id === activeVaultId);
  vaultNameEl.textContent = current?.name ?? "Vault";
  vaultDeleteBtn.disabled = vaults.length <= 1;
  document.body.dataset.vault = activeVaultId;
  renderVaultList();
}

function renderVaultList() {
  vaultListEl.replaceChildren();
  for (const vault of vaults) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = vault.id === activeVaultId ? "vault-option active" : "vault-option";
    btn.dataset.id = vault.id;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", vault.id === activeVaultId ? "true" : "false");
    const mark = document.createElement("span");
    mark.className = "vault-option-mark";
    mark.textContent = vault.id === activeVaultId ? "●" : "";
    mark.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = vault.name;
    btn.append(mark, label);
    vaultListEl.append(btn);
  }
}

function setVaultMenuOpen(open: boolean) {
  vaultMenu.hidden = !open;
  vaultToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) hideVaultPrompt();
  else renderVaultList();
}

function startVaultPrompt(mode: "create" | "rename") {
  vaultMenuMode = mode;
  vaultCreateForm.hidden = false;
  vaultCreateName.value = mode === "rename" ? vaultNameEl.textContent ?? "" : "";
  vaultCreateName.placeholder = mode === "rename" ? "Rename vault" : "Vault name";
  vaultCreateName.focus();
  vaultCreateName.select();
}

function hideVaultPrompt() {
  vaultMenuMode = null;
  vaultCreateForm.hidden = true;
  vaultCreateName.value = "";
}

async function submitVaultPrompt() {
  const name = vaultCreateName.value.trim();
  if (!name || !vaultMenuMode) return;
  try {
    if (vaultMenuMode === "create") {
      const list = await invoke<VaultList>("create_vault", { name });
      hideVaultPrompt();
      setVaultMenuOpen(false);
      await enterVault(list, true);
      setStatus(`Created vault “${name}”`);
      return;
    }
    const list = await invoke<VaultList>("rename_vault", {
      id: activeVaultId,
      name,
    });
    applyVaultList(list);
    hideVaultPrompt();
    setStatus(`Renamed vault to “${name}”`);
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function selectVault(id: string) {
  if (id === activeVaultId) {
    setVaultMenuOpen(false);
    return;
  }
  try {
    const list = await invoke<VaultList>("switch_vault", { id });
    setVaultMenuOpen(false);
    await enterVault(list, true);
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function enterVault(list: VaultList, openFirst: boolean) {
  window.clearTimeout(saveTimer);
  for (const tab of tabs) {
    if (!(await flushTab(tab))) return;
  }
  endNoteDrag();
  hideCreate();
  hideSuggest();
  tabs = [];
  active = -1;
  notes = [];
  await loadVaultState(list);
  showEmpty();
  await refresh();
  if (openFirst && notes.length > 0) await openNote(notes[0]);
  const current = vaults.find((vault) => vault.id === activeVaultId);
  setStatus(current ? `Vault: ${current.name}` : "Vault switched");
}

function askDeleteVault() {
  if (vaults.length <= 1) {
    setStatus("Keep at least one vault", true);
    return;
  }
  const current = vaults.find((vault) => vault.id === activeVaultId);
  pendingDelete = "vault";
  deleteTitle.textContent = "Delete vault?";
  deleteMessage.textContent = `Delete “${current?.name ?? "vault"}” and all of its notes? This cannot be undone.`;
  deleteDialog.returnValue = "";
  deleteDialog.showModal();
}

async function confirmDeleteVault() {
  try {
    const list = await invoke<VaultList>("delete_vault", { id: activeVaultId });
    setVaultMenuOpen(false);
    await enterVault(list, true);
    setStatus("Vault deleted");
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function openSyncSettings() {
  try {
    const config = await invoke<SyncConfig | null>("get_sync_config");
    syncUrl.value = config?.worker_url ?? "";
    syncToken.value = config?.token ?? "";
    syncPassphrase.value = config?.passphrase ?? "";
    syncDialog.returnValue = "";
    syncDialog.showModal();
    syncUrl.focus();
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function saveSyncSettings() {
  const config: SyncConfig = {
    worker_url: syncUrl.value.trim(),
    token: syncToken.value.trim(),
    passphrase: syncPassphrase.value,
  };
  try {
    await invoke("save_sync_config", { config });
    syncDialog.close("save");
    setStatus("Sync settings saved");
  } catch (error) {
    setStatus(message(error), true);
  }
}

function scheduleSync() {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    void syncVault({ quiet: true });
  }, SYNC_DEBOUNCE_MS);
}

async function syncVault(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? false;
  if (syncNowBtn.disabled) return;
  syncNowBtn.disabled = true;
  if (!quiet) setStatus("Syncing…");
  try {
    await flushActive();
    const report = await invoke<SyncReport>("sync_vault");
    await refresh();
    const activePath = activeTab()?.path;
    if (activePath && notes.includes(activePath)) {
      const body = await invoke<string>("read_note", { path: activePath });
      const tab = activeTab();
      if (tab) {
        tab.body = body;
        tab.savedBody = body;
        setMarkdown(body, true);
      }
    }
    setStatus(report.message);
  } catch (error) {
    const text = message(error);
    if (text.includes("not configured")) {
      if (!quiet) {
        setStatus("Configure sync first", true);
        void openSyncSettings();
      }
    } else {
      setStatus(text, true);
    }
  } finally {
    syncNowBtn.disabled = false;
  }
}

async function refresh() {
  notes = await invoke<string[]>("list_notes");
  renderTree();
  renderCalendar();
  pokeDecorations();
}

function setSidebarOpen(open: boolean) {
  sidebarOpen = open;
  document.body.classList.toggle("sidebar-closed", !open);
  sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  localStorage.setItem("sidebarOpen", open ? "1" : "0");
}

function setCalendarOpen(open: boolean) {
  calendarOpen = open;
  document.body.classList.toggle("calendar-closed", !open);
  calendarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  localStorage.setItem("calendarOpen", open ? "1" : "0");
}

function activeTab(): Tab | null {
  return active >= 0 ? tabs[active] ?? null : null;
}

function isDirty(tab: Tab): boolean {
  return tab.body !== tab.savedBody;
}

function getMarkdown(): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();
}

function setMarkdown(markdown: string, editable: boolean) {
  applying = true;
  editor.setEditable(editable, false);
  editor.commands.setContent(markdown, { emitUpdate: false });
  applying = false;
}

function stashActive() {
  const tab = activeTab();
  if (!tab || !editor.isEditable) return;
  tab.body = getMarkdown();
}

async function openNote(path: string) {
  const existing = tabs.findIndex((tab) => tab.path === path);
  if (existing >= 0) {
    await activateTab(existing);
    return;
  }
  stashActive();
  try {
    let text = await invoke<string>("read_note", { path });
    if (!text.trim()) {
      text = titleBody(path);
      await invoke("write_note", { path, body: text });
    }
    tabs.push({ path, body: text, savedBody: text });
    active = tabs.length - 1;
    showActive();
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function openDaily(date: string) {
  const path = dailyPath(date);
  if (notes.includes(path)) {
    await openNote(path);
    return;
  }
  try {
    if (!(await flushActive())) return;
    const created = await invoke<string>("create_note", { path });
    const body = `# ${formatDailyTitle(date)}\n\n`;
    await invoke("write_note", { path: created, body });
    await refresh();
    stashActive();
    tabs.push({ path: created, body, savedBody: body });
    active = tabs.length - 1;
    showActive();
    editor.commands.focus("end");
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function activateTab(index: number) {
  if (index < 0 || index >= tabs.length || index === active) return;
  stashActive();
  active = index;
  showActive();
}

async function closeTab(index: number) {
  if (index < 0 || index >= tabs.length) return;
  if (index === active) stashActive();
  const tab = tabs[index];
  if (isDirty(tab) && !(await flushTab(tab))) return;

  tabs.splice(index, 1);
  if (tabs.length === 0) {
    active = -1;
    showEmpty();
    return;
  }
  if (active > index) active -= 1;
  else if (active === index) active = Math.min(index, tabs.length - 1);
  showActive();
}

function startCreate(mode: "file" | "folder") {
  createMode = mode;
  createForm.hidden = false;
  createPath.value = "";
  createPath.placeholder = mode === "folder" ? "folder" : "note";
  createPath.focus();
}

function hideCreate() {
  createMode = null;
  createPath.value = "";
  createForm.hidden = true;
}

async function submitCreate() {
  if (!createMode) return;
  const raw = createPath.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw) {
    hideCreate();
    return;
  }
  const path =
    createMode === "folder"
      ? withMarkdownExt(`${raw}/Untitled`)
      : withMarkdownExt(raw);
  hideCreate();
  try {
    if (!(await flushActive())) return;
    const created = await invoke<string>("create_note", { path });
    const body = titleBody(created);
    await invoke("write_note", { path: created, body });
    await refresh();
    stashActive();
    tabs.push({ path: created, body, savedBody: body });
    active = tabs.length - 1;
    showActive();
    editor.commands.focus("end");
  } catch (error) {
    setStatus(message(error), true);
  }
}

async function flushActive(): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return true;
  stashActive();
  return flushTab(tab);
}

async function flushTab(tab: Tab): Promise<boolean> {
  if (!isDirty(tab)) return true;
  setStatus("Saving");
  try {
    await invoke("write_note", { path: tab.path, body: tab.body });
    tab.savedBody = tab.body;
    if (activeTab() === tab) setStatus("Saved");
    renderTabs();
    scheduleSync();
    return true;
  } catch (error) {
    setStatus(message(error), true);
    return false;
  }
}

function askDelete() {
  const tab = activeTab();
  if (!tab) return;
  pendingDelete = "note";
  deleteTitle.textContent = "Delete note?";
  deleteMessage.textContent = `Delete “${tabTitle(tab.path)}”? This cannot be undone.`;
  deleteDialog.returnValue = "";
  deleteDialog.showModal();
}

async function removeNote() {
  const tab = activeTab();
  if (!tab) return;
  const path = tab.path;
  window.clearTimeout(saveTimer);
  try {
    await invoke("delete_note", { path });
    unpin(path);
    tabs = tabs.filter((open) => open.path !== path);
    if (tabs.length === 0) {
      active = -1;
      showEmpty();
    } else {
      active = Math.min(active, tabs.length - 1);
      showActive();
    }
    await refresh();
    setStatus(notes.length === 0 ? "Vault is empty" : "Deleted");
  } catch (error) {
    setStatus(message(error), true);
  }
}

function showActive() {
  const tab = activeTab();
  if (!tab) {
    showEmpty();
    return;
  }
  pinBtn.disabled = false;
  deleteBtn.disabled = false;
  // TipTap's setEditable emits "update" by default, which would overwrite
  // this tab's body with the previous note before setContent runs.
  setMarkdown(tab.body, true);
  renderTabs();
  renderTree();
  renderCalendar();
  syncToolbar();
  syncPinButton();
  setStatus(isDirty(tab) ? "Unsaved" : "Saved");
}

function showEmpty() {
  pinBtn.disabled = true;
  deleteBtn.disabled = true;
  pinBtn.classList.remove("active");
  setMarkdown("", false);
  renderTabs();
  renderTree();
  renderCalendar();
  syncToolbar();
  setStatus(notes.length === 0 ? "Vault is empty" : "No open notes");
}

function vaultStorageKey(suffix: string): string {
  return activeVaultId ? `vault:${activeVaultId}:${suffix}` : suffix;
}

function loadPins(): string[] {
  try {
    const scoped = localStorage.getItem(vaultStorageKey("pinnedNotes"));
    const raw =
      scoped ??
      (activeVaultId === "default" ? localStorage.getItem("pinnedNotes") : null);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const pinsList = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    if (!scoped && pinsList.length > 0 && activeVaultId === "default") {
      localStorage.setItem(vaultStorageKey("pinnedNotes"), JSON.stringify(pinsList));
    }
    return pinsList;
  } catch {
    return [];
  }
}

function savePins() {
  localStorage.setItem(vaultStorageKey("pinnedNotes"), JSON.stringify(pins));
}

function loadCollapsedFolders(): Set<string> {
  try {
    const scoped = localStorage.getItem(vaultStorageKey("collapsedFolders"));
    const raw =
      scoped ??
      (activeVaultId === "default" ? localStorage.getItem("collapsedFolders") : null);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const folders = Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is string => typeof item === "string"))
      : new Set<string>();
    if (!scoped && folders.size > 0 && activeVaultId === "default") {
      localStorage.setItem(
        vaultStorageKey("collapsedFolders"),
        JSON.stringify([...folders]),
      );
    }
    return folders;
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders() {
  localStorage.setItem(
    vaultStorageKey("collapsedFolders"),
    JSON.stringify([...collapsedFolders]),
  );
}

function isFolderCollapsed(path: string): boolean {
  return collapsedFolders.has(path);
}

function toggleFolder(path: string) {
  if (collapsedFolders.has(path)) collapsedFolders.delete(path);
  else collapsedFolders.add(path);
  saveCollapsedFolders();
  renderTree();
}

function isPinned(path: string): boolean {
  return pins.includes(path);
}

function togglePin(path: string) {
  if (isPinned(path)) unpin(path);
  else {
    pins = [...pins, path];
    savePins();
  }
  renderTree();
  syncPinButton();
}

function unpin(path: string) {
  if (!isPinned(path)) return;
  pins = pins.filter((item) => item !== path);
  savePins();
}

function syncPinButton() {
  const tab = activeTab();
  const pinned = !!tab && isPinned(tab.path);
  pinBtn.classList.toggle("active", pinned);
  pinBtn.title = pinned ? "Unpin note" : "Pin note";
  pinBtn.setAttribute("aria-label", pinned ? "Unpin note" : "Pin note");
  pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
}

function runFormat(cmd: string) {
  const chain = editor.chain().focus();
  switch (cmd) {
    case "h1":
      chain.toggleHeading({ level: 1 }).run();
      break;
    case "h2":
      chain.toggleHeading({ level: 2 }).run();
      break;
    case "h3":
      chain.toggleHeading({ level: 3 }).run();
      break;
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "strike":
      chain.toggleStrike().run();
      break;
    case "code":
      chain.toggleCode().run();
      break;
    case "bullet":
      chain.toggleBulletList().run();
      break;
    case "ordered":
      chain.toggleOrderedList().run();
      break;
    case "quote":
      chain.toggleBlockquote().run();
      break;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      break;
  }
}

function syncToolbar() {
  for (const button of formatBar.querySelectorAll<HTMLButtonElement>("button[data-cmd]")) {
    const cmd = button.dataset.cmd!;
    let activeFmt = false;
    switch (cmd) {
      case "h1":
        activeFmt = editor.isActive("heading", { level: 1 });
        break;
      case "h2":
        activeFmt = editor.isActive("heading", { level: 2 });
        break;
      case "h3":
        activeFmt = editor.isActive("heading", { level: 3 });
        break;
      case "bold":
        activeFmt = editor.isActive("bold");
        break;
      case "italic":
        activeFmt = editor.isActive("italic");
        break;
      case "strike":
        activeFmt = editor.isActive("strike");
        break;
      case "code":
        activeFmt = editor.isActive("code");
        break;
      case "bullet":
        activeFmt = editor.isActive("bulletList");
        break;
      case "ordered":
        activeFmt = editor.isActive("orderedList");
        break;
      case "quote":
        activeFmt = editor.isActive("blockquote");
        break;
      case "codeBlock":
        activeFmt = editor.isActive("codeBlock");
        break;
    }
    button.classList.toggle("active", activeFmt);
    button.disabled = !editor.isEditable;
  }
}

function renderTabs() {
  tabsEl.replaceChildren();
  tabs.forEach((tab, index) => {
    const button = document.createElement("div");
    button.className = "tab";
    button.role = "tab";
    button.tabIndex = 0;
    button.dataset.index = String(index);
    button.setAttribute("aria-selected", index === active ? "true" : "false");
    if (index === active) button.classList.add("active");

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabTitle(tab.path);
    if (isDirty(tab)) label.classList.add("dirty");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.dataset.index = String(index);
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${tabTitle(tab.path)}`);
    close.textContent = "×";

    button.append(label, close);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void activateTab(index);
      }
    });
    tabsEl.append(button);
  });
}

function renderTree() {
  treeEl.replaceChildren();
  treeEl.dataset.folder = "";
  if (notes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No notes yet";
    treeEl.append(empty);
    return;
  }

  // Drop pins for notes that no longer exist.
  const noteSet = new Set(notes);
  const nextPins = pins.filter((path) => noteSet.has(path));
  if (nextPins.length !== pins.length) {
    pins = nextPins;
    savePins();
  }

  const pinnedNotes = notes
    .filter((path) => isPinned(path))
    .sort((a, b) => tabTitle(a).localeCompare(tabTitle(b)));
  if (pinnedNotes.length > 0) {
    const section = document.createElement("div");
    section.className = "pinned-section";
    const heading = document.createElement("div");
    heading.className = "folder-name";
    heading.textContent = "Pinned";
    section.append(heading);
    for (const path of pinnedNotes) {
      section.append(renderNoteRow(path, tabTitle(path), 0));
    }
    treeEl.append(section);
  }

  const unpinned = notes.filter((path) => !isPinned(path));
  if (unpinned.length > 0) {
    treeEl.append(renderFolder(buildTree(unpinned), 0, ""));
  }
}

function renderCalendar() {
  calMonthEl.textContent = MONTHS[viewMonth];
  calYearEl.textContent = String(viewYear);

  const first = new Date(viewYear, viewMonth, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(viewYear, viewMonth, 1 - startOffset);
  const today = isoDate(new Date());
  const selected = dailyDateFromPath(activeTab()?.path ?? "");
  const dailyNotes = new Set(
    notes
      .filter((path) => path.startsWith(DAILY_PREFIX) && /Daily\/\d{4}-\d{2}-\d{2}\.md$/i.test(path))
      .map((path) => path.slice(DAILY_PREFIX.length, -3)),
  );

  calGridEl.replaceChildren();
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const iso = isoDate(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cal-day";
    button.dataset.date = iso;
    button.setAttribute("aria-label", iso);

    if (date.getMonth() !== viewMonth) button.classList.add("outside");
    if (iso === today) button.classList.add("today");
    if (iso === selected) button.classList.add("selected");
    if (dailyNotes.has(iso)) button.classList.add("has-note");

    const num = document.createElement("span");
    num.className = "cal-num";
    num.textContent = String(date.getDate());
    button.append(num);
    calGridEl.append(button);
  }
}

type Folder = {
  dirs: Map<string, Folder>;
  files: { path: string; name: string }[];
};

function buildTree(paths: string[]): Folder {
  const root: Folder = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (const segment of parts.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    const file = parts[parts.length - 1];
    node.files.push({ path, name: file.replace(/\.md$/i, "") });
  }
  return root;
}

function renderFolder(
  folder: Folder,
  depth: number,
  pathPrefix: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const dirNames = [...folder.dirs.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of dirNames) {
    const folderPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    const collapsed = isFolderCollapsed(folderPath);
    const block = document.createElement("div");
    block.className = collapsed ? "folder collapsed" : "folder";
    block.dataset.folder = folderPath;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    toggle.dataset.folder = folderPath;
    toggle.style.paddingLeft = `${8 + depth * 14}px`;
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.title = collapsed ? `Expand ${name}` : `Collapse ${name}`;

    const chevron = document.createElement("span");
    chevron.className = "folder-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.2 3.2a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06L9.19 8 5.2 4.26a.75.75 0 0 1 0-1.06z"/></svg>';

    const label = document.createElement("span");
    label.className = "folder-label";
    label.textContent = name;
    toggle.append(chevron, label);

    const children = document.createElement("div");
    children.className = "folder-children";
    children.append(renderFolder(folder.dirs.get(name)!, depth + 1, folderPath));

    block.append(toggle, children);
    fragment.append(block);
  }
  const files = [...folder.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    fragment.append(renderNoteRow(file.path, file.name, depth));
  }
  return fragment;
}

function onNoteDragMove(event: MouseEvent) {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved) {
    if (dx * dx + dy * dy < 36) return;
    drag.moved = true;
    drag.row.classList.add("dragging");
    document.body.classList.add("is-dragging-note");
    ensureRootDropHint();
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML =
      '<span class="drag-ghost-name"></span><span class="drag-ghost-dest"></span>';
    document.body.append(ghost);
    drag.ghost = ghost;
  }
  event.preventDefault();
  const folder = dropFolder(document.elementFromPoint(event.clientX, event.clientY));
  if (folder == null) clearDropTarget();
  else setDropTarget(folder);
  drag.lastFolder = folder;
  updateDragGhost(event.clientX, event.clientY, folder);
}

function onNoteDragUp(event: MouseEvent) {
  if (!drag) {
    endNoteDrag();
    return;
  }
  const state = drag;
  const folder = state.moved
    ? dropFolder(document.elementFromPoint(event.clientX, event.clientY))
    : null;
  endNoteDrag();
  if (!state.moved) return;
  suppressNoteClick = true;
  if (folder == null) return;
  void moveNote(state.path, folder);
}

function onNoteDragCancel() {
  endNoteDrag();
}

function endNoteDrag() {
  window.removeEventListener("mousemove", onNoteDragMove);
  window.removeEventListener("mouseup", onNoteDragUp);
  window.removeEventListener("blur", onNoteDragCancel);
  if (!drag) {
    document.body.classList.remove("is-dragging-note");
    clearDropTarget();
    return;
  }
  drag.ghost?.remove();
  drag.row.classList.remove("dragging");
  drag = null;
  document.body.classList.remove("is-dragging-note");
  clearDropTarget();
}

function updateDragGhost(x: number, y: number, folder: string | null) {
  if (!drag?.ghost) return;
  const nameEl = drag.ghost.querySelector(".drag-ghost-name");
  const destEl = drag.ghost.querySelector(".drag-ghost-dest");
  if (nameEl) nameEl.textContent = drag.name;
  const inFolder = folder != null && folder !== "";
  const root = folder === "";
  if (destEl) {
    destEl.textContent =
      folder == null ? "Release to cancel" : inFolder ? `Into ${folder.split("/").pop()}` : "Vault root";
  }
  drag.ghost.classList.toggle("invalid", folder == null);
  drag.ghost.classList.toggle("in-folder", inFolder);
  drag.ghost.classList.toggle("root", root);
  drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
}

function ensureRootDropHint() {
  if (treeEl.querySelector(".drop-root-hint")) return;
  const hint = document.createElement("div");
  hint.className = "drop-root-hint";
  hint.textContent = "Vault root";
  hint.dataset.folder = "";
  treeEl.prepend(hint);
}

function renderNoteRow(path: string, name: string, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "note-row";
  row.dataset.path = path;
  // Align under folder labels (past the chevron).
  row.style.paddingLeft = `${24 + depth * 14}px`;

  const open = document.createElement("span");
  open.className = "note-open";
  open.dataset.path = path;
  open.textContent = name;

  const currentPath = activeTab()?.path ?? null;
  const openPaths = new Set(tabs.map((tab) => tab.path));
  if (path === currentPath) open.classList.add("active");
  else if (openPaths.has(path)) open.classList.add("open");
  open.setAttribute("aria-current", path === currentPath ? "page" : "false");

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "pin-toggle";
  pin.draggable = false;
  pin.dataset.path = path;
  pin.title = isPinned(path) ? "Unpin" : "Pin";
  pin.setAttribute("aria-label", isPinned(path) ? `Unpin ${name}` : `Pin ${name}`);
  pin.setAttribute("aria-pressed", isPinned(path) ? "true" : "false");
  if (isPinned(path)) pin.classList.add("active");
  pin.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="10.3" cy="4.7" r="3.35" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" d="M8.15 7.45 3.1 13.6"/></svg>';

  row.append(open, pin);
  return row;
}

async function moveNote(from: string, folder: string) {
  const name = from.split("/").pop();
  if (!name) return;
  const to = folder ? `${folder}/${name}` : name;
  if (to === from) return;

  const open = tabs.find((tab) => tab.path === from);
  if (open) {
    if (activeTab()?.path === from) stashActive();
    if (!(await flushTab(open))) return;
  } else if (!(await flushActive())) {
    return;
  }

  try {
    const renamed = await invoke<string>("rename_note", { from, to });
    for (const tab of tabs) {
      if (tab.path === from) tab.path = renamed;
    }
    if (isPinned(from)) {
      pins = pins.map((path) => (path === from ? renamed : path));
      savePins();
    }
    await refresh();
    renderTabs();
    syncPinButton();
    setStatus("Moved");
  } catch (error) {
    setStatus(message(error), true);
  }
}

function dropFolder(target: EventTarget | null): string | null {
  const el = eventElement(target);
  if (!el || !treeEl.contains(el)) return null;
  const folder = el.closest<HTMLElement>(".folder[data-folder]");
  if (folder && folder.dataset.folder != null) return folder.dataset.folder;
  if (el.closest(".pinned-section")) return null;
  return "";
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

function setDropTarget(folder: string) {
  clearDropTarget();
  if (folder === "") {
    treeEl.classList.add("drop-root");
    treeEl.querySelector(".drop-root-hint")?.classList.add("active");
    return;
  }
  treeEl
    .querySelector<HTMLElement>(`.folder[data-folder="${cssEscape(folder)}"]`)
    ?.classList.add("drop-target");
}

function clearDropTarget() {
  treeEl.classList.remove("drop-root");
  treeEl.querySelector(".drop-root-hint")?.classList.remove("active");
  treeEl.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function dailyPath(date: string): string {
  return `${DAILY_PREFIX}${date}.md`;
}

function dailyDateFromPath(path: string): string | null {
  const match = path.match(/^Daily\/(\d{4}-\d{2}-\d{2})\.md$/i);
  return match ? match[1] : null;
}

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDailyTitle(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function tabTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "") || path;
}

function titleBody(path: string): string {
  return `# ${tabTitle(path)}\n\n`;
}

function withMarkdownExt(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return "";
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function pokeDecorations() {
  editor.view.dispatch(editor.state.tr.setMeta("wiki-refresh", true));
}

function decorateWiki(doc: ProseNode): DecorationSet {
  const source = activeTab()?.path ?? "";
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || !node.text || node.marks.some((mark) => mark.type.name === "code")) return;
    for (const link of scanMarkdown(node.text).links) {
      if (link.kind !== "wiki") continue;
      const raw = node.text.slice(link.start + 2, link.end - 2);
      const pipe = raw.indexOf("|");
      const labelFrom = pipe >= 0 ? link.start + 2 + pipe + 1 : link.start + 2;
      const labelTo = link.end - 2;
      if (labelFrom >= labelTo) continue;
      const resolved = resolveTarget(link.target, source, notes);
      const hide = (from: number, to: number) => {
        if (from < to) decorations.push(Decoration.inline(pos + from, pos + to, { class: "wiki-syntax" }));
      };
      hide(link.start, labelFrom);
      decorations.push(
        Decoration.inline(pos + labelFrom, pos + labelTo, {
          class: resolved ? "wikilink" : "wikilink unresolved",
          "data-target": link.target,
        }),
      );
      hide(labelTo, link.end);
    }
  });
  return DecorationSet.create(doc, decorations);
}

async function followTarget(raw: string) {
  const source = activeTab()?.path ?? "";
  const existing = resolveTarget(raw, source, notes);
  if (existing) {
    await openNote(existing);
    return;
  }
  const path = pathForNewLink(raw);
  if (!path) {
    setStatus("That link can't be a note", true);
    return;
  }
  try {
    if (!(await flushActive())) return;
    const created = await invoke<string>("create_note", { path });
    const body = titleBody(created);
    await invoke("write_note", { path: created, body });
    await refresh();
    stashActive();
    tabs.push({ path: created, body, savedBody: body });
    active = tabs.length - 1;
    showActive();
    editor.commands.focus("end");
  } catch (error) {
    await refresh();
    const again = resolveTarget(raw, source, notes);
    if (again) {
      await openNote(again);
      return;
    }
    setStatus(message(error), true);
  }
}

function decodeLink(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function syncSuggest() {
  if (applying || !editor.isEditable || !editor.isFocused) {
    hideSuggest();
    return;
  }
  const query = wikiQuery();
  if (!query || /[|#]/.test(query.query)) {
    hideSuggest();
    return;
  }
  const paths = notes
    .filter((path) => {
      const text = linktextFor(path, notes);
      if (/[\[\]|#]/.test(text)) return false;
      const q = query.query.trim().toLowerCase();
      return !q || noteTitle(path).toLowerCase().includes(q) || path.toLowerCase().includes(q);
    })
    .sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)))
    .slice(0, 8);
  const trimmed = query.query.trim();
  const create =
    trimmed.length > 0 &&
    pathForNewLink(trimmed) != null &&
    !notes.some((path) => noteTitle(path).toLowerCase() === trimmed.toLowerCase());
  if (paths.length === 0 && !create) {
    hideSuggest();
    return;
  }
  if (query.query !== suggestQuery) suggestIndex = 0;
  suggestQuery = query.query;
  suggestPaths = paths;
  suggestCreate = create;
  const total = paths.length + (create ? 1 : 0);
  if (suggestIndex >= total) suggestIndex = 0;
  suggestEl.replaceChildren();
  const add = (index: number, title: string, folder = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    if (index === suggestIndex) button.classList.add("active");
    button.append(title);
    if (folder) {
      const sub = document.createElement("span");
      sub.className = "suggest-path";
      sub.textContent = folder;
      button.append(sub);
    }
    suggestEl.append(button);
  };
  paths.forEach((path, index) => {
    add(index, noteTitle(path), path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  });
  if (create) add(paths.length, `Create “${trimmed}”`);
  placeSuggest();
}

function wikiQuery(): { from: number; query: string } | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name === "codeBlock") return null;
  if ($from.marks().some((mark) => mark.type.name === "code")) return null;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 200), $from.parentOffset, "\n", "\n");
  const match = before.match(/\[\[([^\[\]\n]*)$/);
  if (!match) return null;
  return { from: $from.pos - match[0].length, query: match[1] };
}

function placeSuggest() {
  const coords = editor.view.coordsAtPos(editor.state.selection.from);
  suggestEl.hidden = false;
  suggestEl.style.left = `${coords.left}px`;
  suggestEl.style.top = `${coords.bottom + 6}px`;
  const rect = suggestEl.getBoundingClientRect();
  let left = coords.left;
  let top = coords.bottom + 6;
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = coords.top - rect.height - 6;
  suggestEl.style.left = `${Math.max(8, left)}px`;
  suggestEl.style.top = `${Math.max(8, top)}px`;
}

function hideSuggest() {
  suggestEl.hidden = true;
  suggestEl.replaceChildren();
  suggestPaths = [];
  suggestCreate = false;
  suggestQuery = "";
}

function onSuggestKey(event: KeyboardEvent): boolean {
  if (suggestEl.hidden) return false;
  const total = suggestPaths.length + (suggestCreate ? 1 : 0);
  if (total === 0) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : total - 1;
    suggestIndex = (suggestIndex + step) % total;
    syncSuggest();
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    acceptSuggest(suggestIndex);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideSuggest();
    return true;
  }
  return false;
}

function acceptSuggest(index: number) {
  const query = wikiQuery();
  if (!query) return;
  const target =
    index < suggestPaths.length ? linktextFor(suggestPaths[index] ?? "", notes) : query.query.trim();
  if (!target || (index === suggestPaths.length && !pathForNewLink(target))) return;
  const to = editor.state.selection.from;
  hideSuggest();
  editor.chain().focus().command(({ tr }) => {
    tr.insertText(`[[${target}]]`, query.from, to);
    return true;
  }).run();
}

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) throw new Error(`missing #${id}`);
  return node as T;
}
