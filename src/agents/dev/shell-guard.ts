/**
 * Guard for the dev agent's shell. It blocks commands that could rewrite
 * history, escape the workspace, push to a protected branch, or exfiltrate
 * secrets — before they run. This is a denylist of clearly-destructive
 * patterns, not a sandbox: the disposable container (see sandbox.ts) is the
 * real boundary. The two are defence in depth.
 */

export interface GuardVerdict {
  readonly blocked: boolean;
  readonly reason: string | null;
}

interface Rule {
  readonly pattern: RegExp;
  readonly reason: string;
}

const RULES: readonly Rule[] = [
  {
    pattern: /git\s+push\s+.*(--force\b|-f\b|--force-with-lease\b|\s\+)/,
    reason: 'force-push is forbidden',
  },
  {
    pattern: /git\s+push\s+\S+\s+(?:HEAD:)?(?:main|master)\b/,
    reason: 'pushing to a protected branch (main/master) is forbidden',
  },
  {
    pattern: /git\s+(?:rebase|filter-branch|reflog\s+expire)\b/,
    reason: 'history rewriting is forbidden',
  },
  {
    pattern: /git\s+reset\s+--hard\b/,
    reason: 'hard reset can destroy work and is forbidden',
  },
  {
    pattern: /git\s+push\s+.*--mirror\b/,
    reason: 'mirror push is forbidden',
  },
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\/|~|\.\.\/)/,
    reason: 'deleting outside the workspace is forbidden',
  },
  {
    pattern: /:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/,
    reason: 'fork-bomb pattern is forbidden',
  },
  {
    // env/secret material piped to the network = exfiltration.
    pattern:
      /(?:env|printenv|cat\s+[^|]*(?:\.env|secret|credential|id_rsa)[^|]*)\s*(?:\|\s*)?(?:curl|wget|nc|ncat)\b/i,
    reason: 'piping secrets to the network is forbidden',
  },
  {
    pattern:
      /\b(?:curl|wget)\b[^\n]*(?:--data|--upload-file|-d\s|-T\s|-F\s)[^\n]*(?:\.env|secret|credential|token|id_rsa)/i,
    reason: 'uploading secret material is forbidden',
  },
];

export function inspectCommand(command: string): GuardVerdict {
  const normalized = command.replace(/\s+/g, ' ').trim();
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false, reason: null };
}

/**
 * Lint / format / type-check / test-runner / build-tool CONFIG files. The dev
 * agent must implement the ticket, not change how the gates run: rewriting these
 * (e.g. adding an `eslint.config.js` that flips ESLint into flat-config mode, or
 * loosening tsconfig) is how a confused agent makes a failing gate "pass" without
 * fixing its own code. package.json is deliberately NOT here so legitimate
 * dependency additions still work. A failing gate that needs a tooling change is
 * a blocker to report, not a thing to silently patch.
 */
const PROTECTED_CONFIG: readonly RegExp[] = [
  /^\.eslintrc(\..+)?$/i,
  /^eslint\.config\.(js|cjs|mjs|ts)$/i,
  /^\.prettierrc(\..+)?$/i,
  /^prettier\.config\.(js|cjs|mjs)$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^vitest\.config\.(js|ts|mjs|cjs)$/i,
  /^jest\.config\.(js|ts|cjs|mjs|json)$/i,
  /^build\.gradle(\.kts)?$/i,
  /^pom\.xml$/i,
];

/** Blocks writes that would mutate the gate tooling itself. */
export function inspectFileWrite(filePath: string): GuardVerdict {
  const base = filePath.split('/').pop() ?? filePath;
  if (PROTECTED_CONFIG.some((pattern) => pattern.test(base))) {
    return {
      blocked: true,
      reason: `editing build/lint/test config (${base}) is forbidden — report it as a blocker instead of changing the tooling`,
    };
  }
  return { blocked: false, reason: null };
}
