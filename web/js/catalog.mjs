// The Customizations marketplace: well-known MCP servers, each with the exact config ORBIX saves when you add it.
// Stdio servers run through npx in the shell you chose (Windows or WSL), so Node.js must be installed there; remote
// servers are reached over HTTPS. Fields are what you type in (a token, a folder); they fill `env`, `args` or headers.
// No server here needs a sign-in flow ORBIX lacks (OAuth): those are left out rather than half-working.

/** id, name, what it does, category, monogram and colour for its tile, the fields to ask for, and its config. */
export const CATALOG = [
  {
    id: 'playwright', name: 'Playwright', cat: 'Browser and web', mono: 'Pw', color: '#2EAD33',
    blurb: 'Let the agent drive a real browser: open pages, click, type, fill forms and take screenshots.',
    config: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }),
  },
  {
    id: 'chrome-devtools', name: 'Chrome DevTools', cat: 'Browser and web', mono: 'Cd', color: '#4285F4',
    blurb: 'Debug a live Chrome: console, network requests, performance traces and screenshots.',
    config: () => ({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }),
  },
  {
    id: 'firecrawl', name: 'Firecrawl', cat: 'Browser and web', mono: 'Fc', color: '#FF6A00',
    blurb: 'Crawl and scrape websites into clean Markdown, with search and structured extraction.',
    fields: [{ key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', secret: true }],
    config: (v) => ({ command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: v.FIRECRAWL_API_KEY } }),
  },
  {
    id: 'exa', name: 'Exa', cat: 'Browser and web', mono: 'Ex', color: '#1F40ED',
    blurb: 'Web search built for agents: fresh results, page contents and code examples.',
    fields: [{ key: 'EXA_API_KEY', label: 'Exa API key', secret: true }],
    config: (v) => ({ command: 'npx', args: ['-y', 'exa-mcp-server'], env: { EXA_API_KEY: v.EXA_API_KEY } }),
  },
  {
    id: 'context7', name: 'Context7', cat: 'Docs and thinking', mono: 'C7', color: '#10B981',
    blurb: 'Current documentation and code examples for the libraries you use, by version.',
    config: () => ({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] }),
  },
  {
    id: 'sequential-thinking', name: 'Sequential Thinking', cat: 'Docs and thinking', mono: 'St', color: '#8B5CF6',
    blurb: 'A scratchpad for step-by-step reasoning that the agent can revise and branch.',
    config: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }),
  },
  {
    id: 'memory', name: 'Memory', cat: 'Docs and thinking', mono: 'Me', color: '#F59E0B',
    blurb: 'A knowledge graph the agent keeps across conversations: people, projects, decisions.',
    config: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }),
  },
  {
    id: 'github', name: 'GitHub', cat: 'Code and data', mono: 'Gh', color: '#6E7681',
    blurb: 'Issues, pull requests, code search and Actions on GitHub, through GitHub’s own server.',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, hint: 'github.com → Settings → Developer settings → Personal access tokens' }],
    config: (v) => ({ url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${v.token}` } }),
  },
  {
    id: 'supabase', name: 'Supabase', cat: 'Code and data', mono: 'Sb', color: '#3ECF8E',
    blurb: 'Tables, SQL, migrations, logs and edge functions of your Supabase projects.',
    fields: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal access token', secret: true, hint: 'supabase.com → Account → Access tokens' }],
    config: (v) => ({ command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'], env: { SUPABASE_ACCESS_TOKEN: v.SUPABASE_ACCESS_TOKEN } }),
  },
  {
    id: 'filesystem', name: 'Filesystem', cat: 'Code and data', mono: 'Fs', color: '#64748B',
    blurb: 'Read and write files in one more folder you choose, outside the project.',
    fields: [{ key: 'folder', label: 'Folder', folder: true }],
    config: (v) => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', v.folder] }),
  },
  {
    id: 'figma', name: 'Figma', cat: 'Design and business', mono: 'Fi', color: '#A259FF',
    blurb: 'Design context from the Figma desktop app (turn on its Dev Mode MCP server first).',
    config: () => ({ url: 'http://127.0.0.1:3845/mcp' }),
  },
  {
    id: 'notion', name: 'Notion', cat: 'Design and business', mono: 'No', color: '#9B9A97',
    blurb: 'Search, read and update pages and databases in your Notion workspace.',
    fields: [{ key: 'NOTION_TOKEN', label: 'Integration token', secret: true, hint: 'notion.so/my-integrations' }],
    config: (v) => ({ command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: v.NOTION_TOKEN } }),
  },
  {
    id: 'stripe', name: 'Stripe', cat: 'Design and business', mono: 'S', color: '#635BFF',
    blurb: 'Customers, payments, products and docs in your Stripe account, through Stripe’s own server.',
    fields: [{ key: 'key', label: 'Agent API key', secret: true, hint: 'dashboard.stripe.com → Developers → API keys → Create agent key (start in a sandbox)' }],
    config: (v) => ({ url: 'https://mcp.stripe.com', headers: { Authorization: `Bearer ${v.key}` } }),
  },
];

export const CATEGORIES = ['Browser and web', 'Docs and thinking', 'Code and data', 'Design and business'];

/** The config to save for an entry, or throws with the field that is missing. */
export function configFor(entry, values = {}) {
  for (const f of entry.fields || []) if (!String(values[f.key] || '').trim()) throw new Error(`${f.label} is needed`);
  const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, String(x).trim()]));
  return entry.config(v);
}
