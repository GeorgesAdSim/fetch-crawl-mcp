export interface ToolMeta {
  fetchedWith: "fetch" | "puppeteer";
  fallbackUsed: boolean;
  partial: boolean;
  durationMs: number;
  timestamp: string;
}

export interface ToolIssue {
  severity: "error" | "warning" | "info";
  element: string;
  message: string;
  evidence?: string;
}

export interface StandardResponse {
  url: string;
  finalUrl: string;
  status: number;
  score?: number;
  summary: string;
  issues: ToolIssue[];
  recommendations: string[];
  meta: ToolMeta;
  data: Record<string, unknown>;
}

export function createMeta(
  startTime: number,
  fetchedWith: "fetch" | "puppeteer",
  fallbackUsed: boolean,
  partial: boolean
): ToolMeta {
  return {
    fetchedWith,
    fallbackUsed,
    partial,
    durationMs: Math.round(performance.now() - startTime),
    timestamp: new Date().toISOString(),
  };
}

export function createIssue(
  severity: "error" | "warning" | "info",
  element: string,
  message: string,
  evidence?: string
): ToolIssue {
  const issue: ToolIssue = { severity, element, message };
  if (evidence !== undefined) {
    issue.evidence = evidence;
  }
  return issue;
}

export function calculateScore(issues: ToolIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "error") score -= 15;
    else if (issue.severity === "warning") score -= 5;
  }
  return Math.max(0, score);
}

export function generateRecommendations(issues: ToolIssue[]): string[] {
  const recommendations: string[] = [];
  for (const issue of issues) {
    if (issue.severity === "error" || issue.severity === "warning") {
      recommendations.push(`[${issue.element}] ${issue.message}`);
    }
  }
  return recommendations;
}
