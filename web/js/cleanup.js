// Deleting conversations: one at a time (sidebar) or in bulk (Manage conversations).
// Deletion is permanent, so every path goes through an explicit confirmation.
import { h, toast, timeAgo, baseName, clear } from './dom.js';
import { api } from './api.js';
import { S, loadSessions, closeTab, tabForSession } from './store.js';
import { modal, btn, confirmDialog } from './dialogs.js';

const DAY = 86400000;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/** Close open tabs for these conversations, then delete all their files. Returns how many files were removed. */
async function deleteConversations(list) {
  for (const s of list) {
    const t = tabForSession(s);
    if (t) await closeTab(t.id);
  }
  const paths = [...new Set(list.flatMap((s) => (s.chain?.length ? s.chain : [s.path])))];
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await api.post('/api/sessions/delete', { paths });
      await loadSessions();
      return r.removed;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409) break;
      await new Promise((r) => setTimeout(r, 400)); // the process is still shutting down
    }
  }
  await loadSessions();
  throw lastErr;
}

export async function confirmDeleteConversation(s) {
  const versions = s.chain?.length > 1 ? `\n\nAll ${s.chain.length} saved versions are deleted.` : '';
  const ok = await confirmDialog('Delete conversation', `Delete “${s.title}”? This cannot be undone.${versions}`, { ok: 'Delete', danger: true });
  if (!ok) return false;
  try {
    await deleteConversations([s]);
    toast('Conversation deleted', 'ok', 2200);
    return true;
  } catch (e) {
    toast(e.message, 'error', 7000);
    return false;
  }
}

/** Bulk manager: pick conversations (or everything older than N days) and delete them. */
export function openCleanup() {
  const items = [...S.sessions].sort((a, b) => a.mtime - b.mtime);
  const picked = new Set();
  const list = h('div', { class: 'cl-list' });
  const countEl = h('span', { class: 'muted small' });
  const del = btn('Delete selected', () => run(), 'danger-solid');

  const refresh = () => {
    del.disabled = picked.size === 0;
    del.textContent = picked.size ? `Delete ${picked.size} conversation${picked.size === 1 ? '' : 's'}` : 'Delete selected';
    const bytes = items.filter((s) => picked.has(s.id)).reduce((a, s) => a + (s.size || 0), 0);
    countEl.textContent = picked.size ? `${picked.size} selected · ${fmtSize(bytes)}` : `${items.length} conversation${items.length === 1 ? '' : 's'}`;
  };

  const draw = () => {
    clear(list);
    if (!items.length) return list.append(h('div', { class: 'empty' }, 'No conversations yet.'));
    for (const s of items) {
      const open = !!tabForSession(s);
      const cb = h('input', { type: 'checkbox', disabled: open || null, checked: picked.has(s.id) || null, onchange: () => {
        cb.checked ? picked.add(s.id) : picked.delete(s.id);
        refresh();
      } });
      list.append(h('label', { class: `cl-row${open ? ' off' : ''}`, title: open ? 'Open conversations cannot be deleted. Close them first.' : s.preview || s.title }, cb, h('span', { class: 'cl-t ell' }, s.title), h('span', { class: 'cl-p ell' }, baseName(s.cwdDisplay || s.cwd)), h('span', { class: 'cl-w num' }, open ? 'Open' : timeAgo(s.mtime)), h('span', { class: 'cl-s num' }, fmtSize(s.size || 0))));
    }
  };

  const pickOlder = (days) => {
    picked.clear();
    const cut = Date.now() - days * DAY;
    for (const s of items) if (!tabForSession(s) && (days === 0 || s.mtime < cut)) picked.add(s.id);
    draw();
    refresh();
  };

  async function run() {
    const chosen = items.filter((s) => picked.has(s.id));
    if (!chosen.length) return;
    const ok = await confirmDialog('Delete conversations', `Delete ${chosen.length} conversation${chosen.length === 1 ? '' : 's'}? This cannot be undone.`, { ok: 'Delete', danger: true });
    if (!ok) return;
    del.disabled = true;
    try {
      await deleteConversations(chosen);
      toast(`Deleted ${chosen.length} conversation${chosen.length === 1 ? '' : 's'}`, 'ok', 2600);
      m.close();
    } catch (e) {
      toast(e.message, 'error', 7000);
      del.disabled = false;
    }
  }

  const quick = h('div', { class: 'cl-quick' }, h('span', { class: 'muted small' }, 'Select'), ...[['Older than 7 days', 7], ['30 days', 30], ['90 days', 90], ['All', 0]].map(([l, d]) => h('button', { class: 'btn sm', type: 'button', onclick: () => pickOlder(d) }, l)), h('button', { class: 'btn sm', type: 'button', onclick: () => {
    picked.clear();
    draw();
    refresh();
  } }, 'None'), h('span', { class: 'grow' }), countEl);

  const m = modal({ title: 'Manage conversations', size: 'lg', body: h('div', { class: 'cl' }, quick, list, h('p', { class: 'set-note' }, 'Open conversations are skipped. Deleting cannot be undone.')), actions: [btn('Close', () => m.close()), del] });
  draw();
  refresh();
  return m;
}
