// Settings → Privacy: what leaves this PC and where it goes, and what stays. ORBIX has no account, no analytics and no
// crash reports, so this page has no switch of its own: each line links to the page that controls it.
import { h, icon } from './dom.js';
import { row } from './dialogs.js';
import { group } from './settings-controls.js';

export function tabPrivacy(el, show) {
  const go = (page, label) => h('button', { class: 'btn sm', type: 'button', onclick: () => show(page) }, label, icon('chevron-right', 12));
  el.append(
    h('p', { class: 'set-note pv-none' }, icon('shield-check', 16), 'ORBIX has no account, analytics or crash reports, and no server of its own.'),
    group('What leaves this PC', null,
      row('Messages, files and command output', go('engine', 'Providers'), 'Sent to the provider or agent of each conversation. Local models keep them here.'),
      row('Web pages the agent reads', go('network', 'Network access rules'), 'web_fetch reads only sites your rules allow.'),
      row('Update checks', go('application', 'About'), 'Asks GitHub for a new version at start and every 4 hours.'),
      row('MCP servers', go('tools', 'Tools & MCP'), 'Each server gets what the agent sends it.'),
      row('Feedback', go('feedback', 'Help & feedback'), 'Sent only when you submit the GitHub issue.')),
    group('What stays on this PC', null,
      row('Conversations, settings and projects', go('application', 'Data folder'), 'In the data folder.'),
      row('Provider keys and sign-ins', go('engine', 'Providers'), 'Encrypted by Windows for your account.'),
      row('Profile and analytics', go('profile', 'Profile'), 'Counted from conversations on this PC.')));
}
