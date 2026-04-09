import { z } from "zod";
import {
  type StandardResponse,
  type ToolIssue,
  createMeta,
  generateRecommendations,
} from "../utils/response.js";
import { checkGtmSnippet } from "./check-gtm-snippet.js";
import { checkDatalayer } from "./check-datalayer.js";
import { interceptTrackingRequests } from "./intercept-tracking-requests.js";

export const auditTrackingSchema = {
  url: z.string().url().describe("The URL to run a full tracking audit on"),
};

export async function auditTracking({
  url,
}: {
  url: string;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  // Run all 3 tools in parallel
  const [gtmResult, datalayerResult, interceptResult] = await Promise.all([
    checkGtmSnippet({ url }),
    checkDatalayer({ url }),
    interceptTrackingRequests({ url }),
  ]);

  // Combine all issues
  const allIssues: ToolIssue[] = [
    ...gtmResult.issues,
    ...datalayerResult.issues,
    ...interceptResult.issues,
  ];

  // Severity summary
  const severitySummary = {
    critical: allIssues.filter((i) => i.severity === "error").length,
    warning: allIssues.filter((i) => i.severity === "warning").length,
    ok: allIssues.filter((i) => i.severity === "info").length,
  };

  // Weighted average score (GTM snippet: 30%, dataLayer: 30%, intercept: 40%)
  const gtmScore = gtmResult.score ?? 100;
  const dlScore = datalayerResult.score ?? 100;
  const intScore = interceptResult.score ?? 100;
  const globalScore = Math.round(
    gtmScore * 0.3 + dlScore * 0.3 + intScore * 0.4
  );

  // Generate diagnosis based on cross-tool analysis
  const diagnosis = generateDiagnosis(gtmResult, datalayerResult, interceptResult);

  return {
    url,
    finalUrl: gtmResult.finalUrl,
    status: 200,
    score: globalScore,
    summary: `Audit tracking complet de ${url}: score ${globalScore}/100, ${severitySummary.critical} erreur(s), ${severitySummary.warning} warning(s)`,
    issues: allIssues,
    recommendations: generateRecommendations(allIssues),
    meta: createMeta(startTime, "puppeteer", false, false),
    data: {
      gtm_snippet: gtmResult.data,
      datalayer: datalayerResult.data,
      tracking_requests: interceptResult.data,
      severity_summary: severitySummary,
      diagnosis,
    },
  };
}

function generateDiagnosis(
  gtm: StandardResponse,
  dl: StandardResponse,
  intercept: StandardResponse
): string {
  const gtmData = gtm.data as Record<string, unknown>;
  const dlData = dl.data as Record<string, unknown>;
  const interceptData = intercept.data as Record<string, unknown>;

  const gtmPresent = gtmData.gtm_present as boolean;
  const gtagPresent = gtmData.gtag_present as boolean;
  const datalayerExists = dlData.datalayer_exists as boolean;
  const gtmLoaded = dlData.gtm_loaded as boolean;
  const totalHits = interceptData.total_hits as number;
  const uaDetected = interceptData.ua_hits_detected as boolean;

  const parts: string[] = [];

  // No tracking at all
  if (!gtmPresent && !gtagPresent && totalHits === 0) {
    return "Aucun système de tracking détecté (pas de GTM, pas de gtag, aucun hit GA4). Le tracking n'est pas implémenté sur cette page.";
  }

  // GTM present but not loading
  if (gtmPresent && !gtmLoaded) {
    parts.push(
      "GTM snippet HTML présent mais le container ne charge pas en runtime (window.google_tag_manager absent) — vérifier que l'ID GTM est correct et qu'aucun bloqueur n'interfère"
    );
  }

  // GTM present but no hits
  if ((gtmPresent || gtagPresent) && totalHits === 0) {
    parts.push(
      "Snippet de tracking présent mais aucun hit GA4 envoyé — vérifier les triggers et la configuration des tags dans GTM"
    );
  }

  // No dataLayer
  if (!datalayerExists && gtmPresent) {
    parts.push(
      "GTM est chargé mais window.dataLayer n'existe pas — le snippet GTM devrait initialiser dataLayer automatiquement, possible conflit JavaScript"
    );
  }

  // UA detected
  if (uaDetected) {
    parts.push(
      "Des hits Universal Analytics obsolètes sont encore envoyés — migrer vers GA4 exclusivement"
    );
  }

  // Everything OK
  if (parts.length === 0) {
    const ids = [
      ...(gtmData.gtm_ids as string[]),
      ...(gtmData.ga4_ids as string[]),
    ].join(", ");
    return `Tracking opérationnel : ${ids}. ${totalHits} hit(s) GA4 capturés, dataLayer actif avec ${dlData.datalayer_length} event(s).`;
  }

  return parts.join(". ") + ".";
}
