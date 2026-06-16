import { config } from '../../shared/config.js';
import type { McpServerConfig } from '../../shared/claude.js';

/**
 * Atlassian Rovo MCP server config, handed to agents that reason over Jira
 * (the BA agent, and the reviewer action in CI). Deterministic writes still go
 * through the REST client; this is for agentic reading and exploration.
 *
 * Headless auth uses an HTTP Basic header built from the Jira email + API
 * token. If your Atlassian org mandates OAuth on the remote MCP, swap this for
 * the stdio `mcp-atlassian` server configured with the same token.
 */
export function atlassianMcpServer(): McpServerConfig {
  const basic = Buffer.from(
    `${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`,
  ).toString('base64');
  return {
    type: 'http',
    url: config.ATLASSIAN_MCP_URL,
    headers: { Authorization: `Basic ${basic}` },
  };
}
