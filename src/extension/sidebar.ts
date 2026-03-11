/**
 * Sidebar webview provider for Claude Stats.
 *
 * Displays the "Open Dashboard" button plus dynamic contextual help
 * that updates based on the currently active dashboard tab.
 */
import * as vscode from "vscode";
import { getNonce, escapeHtml } from "./utils.js";

/** Tab-specific help content displayed in the sidebar. */
const TAB_HELP: Record<string, { title: string; sections: Array<{ heading: string; body: string }> }> = {
  overview: {
    title: "Overview",
    sections: [
      {
        heading: "What you're seeing",
        body: "High-level usage stats for the selected period: sessions, prompts, tokens, cache efficiency, and estimated API cost.",
      },
      {
        heading: "Daily / Hourly Token Usage",
        body: "Stacked bar chart showing output tokens, non-cached input, cache reads, and cache creation over time. When period is \"Day\", shows hourly breakdown.",
      },
      {
        heading: "Token Breakdown",
        body: "Doughnut chart of total token distribution across the four categories: output, input, cache read, and cache creation.",
      },
      {
        heading: "Cache Usage",
        body: "Shows how effectively prompt caching is working. Higher cache read % means less redundant token processing and lower cost.",
      },
      {
        heading: "Cumulative API Value vs Plan Fee",
        body: "Tracks how much API value you've consumed over time against your monthly plan fee. If the line exceeds the dashed plan fee line, you're getting more than 1\u00d7 value from your subscription.",
      },
    ],
  },
  models: {
    title: "Models",
    sections: [
      {
        heading: "Tokens by Model",
        body: "Stacked bar showing input and output token consumption per model. Helps you see which models you use most heavily.",
      },
      {
        heading: "Stop Reasons",
        body: "How often each stop reason occurs. \"end_turn\" means the model finished naturally, \"tool_use\" means it called a tool, \"max_tokens\" means it hit the output limit.",
      },
    ],
  },
  projects: {
    title: "Projects",
    sections: [
      {
        heading: "Top Projects",
        body: "Horizontal bar chart of your most token-intensive projects. Useful for understanding where your usage is concentrated.",
      },
      {
        heading: "Sessions by Entrypoint",
        body: "Pie chart showing how sessions are distributed across entrypoints (CLI, VS Code extension, API, etc.).",
      },
    ],
  },
  sessions: {
    title: "Sessions",
    sections: [
      {
        heading: "5-Hour Usage Windows",
        body: "Claude tracks usage in rolling 5-hour windows. Each bar shows the API value consumed in that window. Red bars indicate windows where throttling occurred.",
      },
      {
        heading: "Top Conversations by API Cost",
        body: "Your most expensive individual conversations. Hover for details including prompt count, dominant model, and percentage of plan fee.",
      },
    ],
  },
  plan: {
    title: "Plan",
    sections: [
      {
        heading: "What this tab measures",
        body: "Compares the API-equivalent value of your Claude usage against your subscription plan cost. Helps answer: \u201cShould I upgrade or downgrade?\u201d",
      },
      {
        heading: "Plan Verdict",
        body: "\u201cGood Value\u201d means your API-equivalent usage exceeds your plan fee (you\u2019re getting more than you pay). \u201cUnderusing\u201d means you\u2019re paying more than the equivalent API cost.",
      },
      {
        heading: "Suggested Plan",
        body: "Based on your average weekly API-equivalent cost, extrapolated to monthly. Compares against Pro ($20), Team Standard ($25), Max 5x ($100), Team Premium ($125), and Max 20x ($200) tiers.",
      },
      {
        heading: "Weekly Activity",
        body: "Bar chart showing sessions and prompts per week. Helps you see your usage patterns and whether your activity level justifies your current plan.",
      },
      {
        heading: "Window Limit Usage %",
        body: "Shows what percentage of your per-window usage limit was consumed in each 5-hour window. Derived from throttled windows (if any) or estimated from your plan fee. Red bars indicate throttled windows, orange means approaching the limit (>=80%).",
      },
      {
        heading: "Windows Per Week",
        body: "Stacked bar showing normal vs throttled windows per week. More throttled windows suggests you may benefit from a higher-tier plan.",
      },
      {
        heading: "Multi-Account Support",
        body: "If you use multiple Claude accounts (e.g. work team + personal), each account is detected separately with its own plan verdict and cost breakdown.",
      },
    ],
  },
  context: {
    title: "Context",
    sections: [
      {
        heading: "What this tab measures",
        body: "Analyzes your context management habits: conversation length, context window growth, compaction usage, and cache efficiency. Helps you answer: \"Am I managing my context optimally?\"",
      },
      {
        heading: "Conversation Length Distribution",
        body: "Histogram of how many prompts your sessions contain. Very long sessions (15+ prompts) without compaction can lead to higher costs and slower responses as the context window fills up.",
      },
      {
        heading: "Context Growth Curve",
        body: "Shows how input tokens grow with each successive prompt in a conversation. A steep curve means context is accumulating fast \u2014 consider using /compact or starting new conversations for unrelated tasks.",
      },
      {
        heading: "Cache Efficiency by Length",
        body: "Compares cache hit rates across short vs long conversations. If cache efficiency drops in longer sessions, it may indicate the context is being rebuilt too often or /compact is discarding useful cached context.",
      },
      {
        heading: "Compaction Events",
        body: "Detected instances where input tokens dropped significantly between messages (>40% reduction), indicating /compact was used. Shows the before/after token counts to visualize how much context was reclaimed.",
      },
      {
        heading: "Long Sessions Table",
        body: "Sessions with 15+ prompts, sorted by peak input tokens. The \u201cCompacted?\u201d column shows whether compaction was detected. Sessions marked \u201cNo\u201d may have benefited from running /compact to reduce context size and cost.",
      },
    ],
  },
  efficiency: {
    title: "Efficiency",
    sections: [
      {
        heading: "What this tab measures",
        body: "Analyzes whether you're sending prompts to a more expensive model than necessary. Each user prompt (\"turn\") is scored for complexity, then classified into a recommended tier: Haiku, Sonnet, or Opus.",
      },
      {
        heading: "Potential Savings",
        body: "Dollar amount you could save if every turn had been routed to the cheapest model capable of handling it. Only counts cases where you used a more expensive model than the classified tier.",
      },
      {
        heading: "Overuse Rate",
        body: "Percentage of classified turns where the actual model was more expensive than the recommended tier. A high overuse rate suggests opportunities to use cheaper models for simple tasks.",
      },
      {
        heading: "Model Usage by Complexity Tier",
        body: "Stacked bar per model, colored by classified tier (green=Haiku, blue=Sonnet, red=Opus). If Opus has a large green or blue segment, those turns could have used a cheaper model.",
      },
      {
        heading: "Opus Complexity Score Distribution",
        body: "Histogram of complexity scores (0\u2013100) for turns that were sent to Opus. Scores are computed from four signals:\n\n\u2022 Output tokens (0\u201325 pts) \u2014 longer responses indicate harder tasks\n\u2022 Thinking blocks (0\u201330 pts) \u2014 extended thinking is the strongest complexity signal\n\u2022 Tool complexity (0\u201325 pts) \u2014 Agent, Write, NotebookEdit score highest\n\u2022 Prompt text analysis (0\u201320 pts) \u2014 keywords like \"refactor\" or \"architect\" add points; \"fix typo\" or \"rename\" subtract\n\nBars are colored by tier: green (0\u201320, Haiku-level), blue (20\u201340, Sonnet-level), red (40+, Opus-level). Green and blue bars represent Opus turns that may not have needed Opus.",
      },
      {
        heading: "Top Overuse",
        body: "The specific turns with the highest potential savings \u2014 cases where an expensive model was used for a task classified as simpler. Shows a preview of the prompt text and the dollar savings if the tier-appropriate model had been used.",
      },
    ],
  },
  settings: {
    title: "Settings",
    sections: [
      {
        heading: "What you can configure",
        body: "Plan type (Pro, Max, Team, Custom) and monthly fee. These are used for plan utilization calculations on the Plan tab. If not set, the tool auto-detects from telemetry.",
      },
      {
        heading: "Cost Alert Thresholds",
        body: "Set daily, weekly, and monthly cost thresholds. When estimated API cost exceeds a threshold, alerts are shown after collection.",
      },
      {
        heading: "Where settings are stored",
        body: "All settings are saved to ~/.claude-stats/config.json. You can also edit this file directly.",
      },
    ],
  },
};

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-stats.dashboardView";

  private view?: vscode.WebviewView;
  private currentTab = "overview";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === "openDashboard") {
        void vscode.commands.executeCommand("claude-stats.openDashboard");
      }
    });

    this.render();
  }

  /** Called by the extension when the dashboard tab changes. */
  setActiveTab(tabId: string): void {
    if (this.currentTab === tabId) return;
    this.currentTab = tabId;
    this.render();
  }

  private render(): void {
    if (!this.view) return;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- overview always exists
    const help = TAB_HELP[this.currentTab] ?? TAB_HELP["overview"]!;
    const nonce = getNonce();

    const sectionsHtml = help.sections
      .map(
        (s) =>
          `<div class="section">
            <h3>${escapeHtml(s.heading)}</h3>
            <p>${escapeHtml(s.body)}</p>
          </div>`,
      )
      .join("\n");

    // Build tab indicator pills
    const tabPills = Object.entries(TAB_HELP)
      .map(
        ([id, entry]) =>
          `<span class="pill${id === this.currentTab ? " active" : ""}">${escapeHtml(entry.title)}</span>`,
      )
      .join("");

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0 12px 12px 12px;
      line-height: 1.5;
    }
    .btn-open {
      display: block;
      width: 100%;
      padding: 8px 12px;
      margin: 12px 0;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      text-align: center;
    }
    .btn-open:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
      margin: 12px 0;
    }
    .tab-indicator {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 10px;
    }
    .pill {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 9px;
      background: var(--vscode-badge-background, #333);
      color: var(--vscode-badge-foreground, #ccc);
      opacity: 0.5;
    }
    .pill.active {
      opacity: 1;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .tab-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: var(--vscode-foreground);
    }
    .section {
      margin-bottom: 12px;
    }
    .section h3 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 4px 0;
    }
    .section p {
      font-size: 12px;
      margin: 0;
      color: var(--vscode-foreground);
      white-space: pre-line;
    }
  </style>
</head>
<body>
  <button class="btn-open" id="open-btn">Open Dashboard</button>

  <hr class="divider">

  <div class="tab-indicator">${tabPills}</div>
  <div class="tab-title">${escapeHtml(help.title)} Tab</div>

  ${sectionsHtml}

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      document.getElementById('open-btn').addEventListener('click', function() {
        vscode.postMessage({ command: 'openDashboard' });
      });
    })();
  </script>
</body>
</html>`;
  }
}

