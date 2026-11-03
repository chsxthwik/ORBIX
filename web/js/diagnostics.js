// Diagnostics: a measured health report of the whole stack, with a one-click "copy report" for bug reports.
import { h, icon, copyText, replace, skeleton } from './dom.js';
import { api } from './api.js';
import { modal, btn } from './dialogs.js';
import { ompInstalled, engineReady } from './store.js';

/** Without the optional OMP CLI, its checks are noise: drop them and judge the agent's setup instead. */
function forThisSetup(report) {
  if (ompInstalled()) {
    return { ...report, checks: report.checks.map((c) => (c.id === 'engine' ? { ...c, label: 'ORBIX agent' } : c)) };
  }
  const checks = report.checks.filter((c) => c.id !== 'omp' && c.id !== 'sessions').map((c) => (c.id === 'engine' ? { ...c, label: 'AI provider set up', ok: engineReady(), fix: engineReady() ? '' : 'Add an API key in Settings → AI providers.' } : c));
  const info = Object.fromEntries(Object.entries(report.info).filter(([k]) => !/omp/i.test(k)));
  return { checks, info };
}

function reportToText(report) {
  const lines = ['ORBIX diagnostics', ''];
  for (const c of report.checks) lines.push(`[${c.ok ? 'OK' : 'FAIL'}] ${c.label}${c.detail ? ' — ' + c.detail : ''}${c.fix ? '\n       fix: ' + c.fix : ''}`);
  lines.push('');
  for (const [k, v] of Object.entries(report.info)) lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

export function openDiagnostics() {
  const body = h('div', { class: 'diag' }, skeleton(5, 'pad'));
  let report = null;
  const copy = btn('Copy report', () => report && copyText(reportToText(report)));
  copy.disabled = true;
  const rerun = btn('Run again', () => run());
  const m = modal({ title: 'Diagnostics', size: 'lg', body, actions: [rerun, copy, btn('Close', () => m.close(), 'primary')] });

  async function run() {
    replace(body, skeleton(5, 'pad'));
    copy.disabled = true;
    try {
      report = forThisSetup((await api.get('/api/diagnostics')).report);
    } catch (e) {
      return replace(body, h('div', { class: 'callout bad' }, e.message));
    }
    copy.disabled = false;
    const failed = report.checks.filter((c) => !c.ok);
    replace(
      body,
      h('div', { class: `callout ${failed.length ? 'bad' : 'ok'}` }, icon(failed.length ? 'alert' : 'check', 14), h('span', null, failed.length ? `${failed.length} ${failed.length === 1 ? 'check needs' : 'checks need'} attention` : 'All checks passed')),
      h('div', { class: 'diag-list' }, report.checks.map((c) => h('div', { class: `diag-row ${c.ok ? 'ok' : 'bad'}` }, icon(c.ok ? 'check' : 'x', 14, 'diag-ico'), h('div', { class: 'diag-main' }, h('div', { class: 'diag-t' }, c.label), c.detail ? h('div', { class: 'diag-d mono' }, c.detail) : null, c.fix ? h('div', { class: 'diag-fix' }, c.fix) : null)))),
      h('dl', { class: 'diag-info' }, Object.entries(report.info).map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono ell', title: v }, v)])),
    );
  }
  run();
  return m;
}
