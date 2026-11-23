// Shared by the sidebar, View menu and command palette; all open the same pages.
export const HUB_LINKS = [
  { view: 'customizations', label: 'Plugins', icon: 'puzzle', hint: 'Browse and manage MCP servers' },
  { view: 'skills', label: 'Skills', icon: 'bolt', hint: 'Manage reusable instructions for the agent' },
  { view: 'automations', label: 'Loops', icon: 'infinity', hint: 'Schedule prompts', key: 'automations' },
  { view: 'runs', label: 'Runs', icon: 'activity', hint: 'Track work across projects', key: 'runs' },
  { view: 'review', label: 'Review', icon: 'shield', hint: 'Decisions and approvals waiting for you', key: 'review' },
];

/** The four pages behind the sidebar's one "Customize" item, in tab order. */
export const CUSTOMIZE = ['customizations', 'skills', 'automations', 'review'];
export const isCustomize = (view) => CUSTOMIZE.includes(view);
/** The tab Customize opens on: the last one you used. */
export const lastCustomize = { view: 'customizations' };
