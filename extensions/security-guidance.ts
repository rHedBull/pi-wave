import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// Security patterns — ported from Anthropic's official claude-plugins-official/security-guidance
interface SecurityPattern {
  ruleName: string;
  pathCheck?: (path: string) => boolean;
  substrings?: string[];
  reminder: string;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    ruleName: "github_actions_workflow",
    pathCheck: (p) => p.includes(".github/workflows/") && (p.endsWith(".yml") || p.endsWith(".yaml")),
    reminder: `⚠️ Security Warning: GitHub Actions workflow file.
1. **Command Injection**: Never use untrusted input (issue titles, PR descriptions, commit messages) directly in run: commands
2. **Use environment variables**: Instead of \${{ github.event.issue.title }}, use env: with proper quoting
3. **Review**: https://github.blog/security/vulnerability-research/how-to-catch-github-actions-workflow-injections-before-attackers-do/

UNSAFE: run: echo "\${{ github.event.issue.title }}"
SAFE:   env: TITLE: \${{ github.event.issue.title }}  →  run: echo "$TITLE"`,
  },
  {
    ruleName: "child_process_exec",
    substrings: ["child_process.exec", "exec(", "execSync("],
    reminder: `⚠️ Security Warning: child_process.exec() can lead to command injection.
Use execFile() or spawn() with argument arrays instead of exec() with string interpolation.
UNSAFE: exec(\`command \${userInput}\`)
SAFE:   execFile('command', [userInput])`,
  },
  {
    ruleName: "new_function_injection",
    substrings: ["new Function"],
    reminder: "⚠️ Security Warning: new Function() with dynamic strings can lead to code injection. Consider alternatives that don't evaluate arbitrary code.",
  },
  {
    ruleName: "eval_injection",
    substrings: ["eval("],
    reminder: "⚠️ Security Warning: eval() executes arbitrary code and is a major security risk. Use JSON.parse() for data parsing or alternative patterns that don't require code evaluation.",
  },
  {
    ruleName: "react_dangerously_set_html",
    substrings: ["dangerouslySetInnerHTML"],
    reminder: "⚠️ Security Warning: dangerouslySetInnerHTML can lead to XSS if used with untrusted content. Ensure content is sanitized with DOMPurify or use safe alternatives.",
  },
  {
    ruleName: "document_write_xss",
    substrings: ["document.write"],
    reminder: "⚠️ Security Warning: document.write() can be exploited for XSS and has performance issues. Use DOM methods like createElement() and appendChild() instead.",
  },
  {
    ruleName: "innerhtml_xss",
    substrings: [".innerHTML =", ".innerHTML="],
    reminder: "⚠️ Security Warning: Setting innerHTML with untrusted content can lead to XSS. Use textContent for plain text or sanitize HTML with DOMPurify.",
  },
  {
    ruleName: "pickle_deserialization",
    substrings: ["pickle"],
    reminder: "⚠️ Security Warning: pickle with untrusted content can lead to arbitrary code execution. Use JSON or other safe serialization formats instead.",
  },
  {
    ruleName: "os_system_injection",
    substrings: ["os.system", "from os import system"],
    reminder: "⚠️ Security Warning: os.system() should only be used with static arguments, never with user-controlled input. Use subprocess.run() with argument lists instead.",
  },
  {
    ruleName: "sql_injection",
    substrings: ["f\"SELECT", "f'SELECT", '+ "SELECT', "+ 'SELECT", "\" + query", "' + query", ".format(", "% ("],
    reminder: "⚠️ Security Warning: Possible SQL injection. Use parameterized queries or prepared statements instead of string interpolation/concatenation in SQL queries.",
  },
  {
    ruleName: "hardcoded_secrets",
    substrings: ["password =", "api_key =", "secret =", "token =", "PASSWORD =", "API_KEY =", "SECRET =", "TOKEN ="],
    reminder: "⚠️ Security Warning: Possible hardcoded secret/credential. Use environment variables or a secrets manager instead of hardcoding sensitive values.",
  },
  {
    ruleName: "insecure_http",
    substrings: ["http://"],
    pathCheck: (p) => !p.includes("test") && !p.includes("spec") && !p.includes("localhost"),
    reminder: "⚠️ Security Warning: Using HTTP instead of HTTPS. Use HTTPS for all external connections to prevent man-in-the-middle attacks.",
  },
];

function checkPatterns(filePath: string, content: string): { ruleName: string; reminder: string } | null {
  const normalized = filePath.replace(/^\/+/, "");

  for (const pattern of SECURITY_PATTERNS) {
    // Path-only patterns (like GitHub Actions)
    if (pattern.pathCheck && !pattern.substrings) {
      if (pattern.pathCheck(normalized)) {
        return { ruleName: pattern.ruleName, reminder: pattern.reminder };
      }
    }

    // Content-based patterns (optionally with path filter)
    if (pattern.substrings && content) {
      // If pattern has pathCheck, it acts as a filter (must also match path)
      if (pattern.pathCheck && !pattern.pathCheck(normalized)) continue;

      for (const sub of pattern.substrings) {
        if (content.includes(sub)) {
          return { ruleName: pattern.ruleName, reminder: pattern.reminder };
        }
      }
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // Track which warnings have been shown this session to avoid repetition
  const shownWarnings = new Set<string>();

  pi.on("session_start", async () => {
    shownWarnings.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    let filePath = "";
    let content = "";

    if (isToolCallEventType("write", event)) {
      filePath = event.input.path || "";
      content = event.input.content || "";
    } else if (isToolCallEventType("edit", event)) {
      filePath = event.input.path || "";
      content = event.input.newText || "";
    } else {
      return; // Not a file-writing tool
    }

    if (!filePath) return;

    const match = checkPatterns(filePath, content);
    if (!match) return;

    const warningKey = `${filePath}-${match.ruleName}`;
    if (shownWarnings.has(warningKey)) return; // Already warned about this

    shownWarnings.add(warningKey);

    // Show warning (non-blocking — doesn't interrupt session flow)
    ctx.ui.notify(match.reminder, "warning");
  });
}
