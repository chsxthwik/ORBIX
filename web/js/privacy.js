// Settings → Privacy: what leaves this PC and where it goes, and what stays. ORBIX has no account, no analytics and no
// crash reports, so this page has no switch of its own: each line links to the page that controls it.
import { h, icon } from './dom.js';
import { row } from './dialogs.js';
import { group } from './settings-controls.js';

export function tabPrivacy(el, show) {
  const go = (page, label) => h('button', { class: 'btn sm', type: 'button', onclick: () => show(page) }, label, icon('chevron-right', 12));
  el.append(
    h('p', { class: 'set-note pv-none' }, icon('shield-check', 16), 'ORBIX sends nothing to us. There is no account, no analytics and no crash report, and no server of ours to send them to.'),
    group('What leaves this PC', null,
      row('Your messages, and the files and command output the agent reads', go('engine', 'Providers'), 'Go to the provider or agent you chose for that conversation, under its own terms. A model that runs on this PC keeps them here.'),
      row('Web pages the agent reads', go('network', 'Network access rules'), 'web_fetch reads only the sites your rules allow.'),
      row('Update checks', go('application', 'About'), 'ORBIX asks GitHub for a newer version when it opens and every 4 hours. You can turn this off.'),
      row('MCP servers', go('tools', 'Tools & MCP'), 'A server you add gets what the agent sends it, and runs with your account’s access.'),
      row('Feedback', go('feedback', 'Help & feedback'), 'Nothing is sent until you submit the GitHub issue in your browser.')),
    group('What stays on this PC', null,
      row('Conversations, settings and projects', go('application', 'Data folder'), 'In ORBIX’s data folder.'),
      row('Provider keys and sign-ins', go('engine', 'Providers'), 'Stored encrypted by Windows for your user account.'),
      row('Profile and analytics', go('profile', 'Profile'), 'Counted from the conversations saved here, on this PC.')));
}
