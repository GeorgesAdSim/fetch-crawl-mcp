import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  analyzeConsent,
  parseGcs,
  parseConsentCalls,
  matchVendor,
  checkConsentModeSchema,
  checkConsentMode,
  type RawConsentData,
} from "../src/tools/check-consent-mode.js";

// --- puppeteer mock for the error-path test ---
vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(async () => {
      throw new Error("Failed to launch browser: mock");
    }),
  },
}));

// --- helpers ---

function makeRaw(overrides: Partial<RawConsentData> = {}): RawConsentData {
  return {
    cmp: {
      detected: false,
      vendor: null,
      version: null,
      tcfApiPresent: false,
      scriptUrl: null,
    },
    consentDefault: {
      found: false,
      beforeGtm: false,
      parameters: {},
    },
    consentUpdate: {
      found: false,
      beforeGtm: false,
      parameters: {},
    },
    googleHits: [],
    cookies: [],
    pageDomain: "example.com",
    finalUrl: "https://example.com",
    status: 200,
    ...overrides,
  };
}

describe("parseGcs", () => {
  it("parses valid gcs values", () => {
    expect(parseGcs("G100")).toEqual({
      ad_storage: "denied",
      analytics_storage: "denied",
    });
    expect(parseGcs("G111")).toEqual({
      ad_storage: "granted",
      analytics_storage: "granted",
    });
    expect(parseGcs("G101")).toEqual({
      ad_storage: "denied",
      analytics_storage: "granted",
    });
    expect(parseGcs("G110")).toEqual({
      ad_storage: "granted",
      analytics_storage: "denied",
    });
  });
  it("rejects invalid gcs values", () => {
    expect(parseGcs("G1")).toBeNull();
    expect(parseGcs("X100")).toBeNull();
    expect(parseGcs("")).toBeNull();
  });
});

describe("matchVendor", () => {
  it("detects Cookiebot via global", () => {
    expect(matchVendor(["Cookiebot"], [])).toEqual({
      vendor: "cookiebot",
      scriptUrl: null,
    });
  });
  it("detects OneTrust via script URL", () => {
    expect(
      matchVendor([], [
        "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js",
      ])
    ).toEqual({
      vendor: "onetrust",
      scriptUrl: "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js",
    });
  });
  it("detects Didomi via global", () => {
    expect(matchVendor(["Didomi"], [])?.vendor).toBe("didomi");
  });
  it("returns null when nothing matches", () => {
    expect(matchVendor([], ["https://example.com/app.js"])).toBeNull();
  });
});

describe("parseConsentCalls", () => {
  it("parses gtag consent default and update calls with v2 params", () => {
    const script = `
      window.dataLayer = window.dataLayer || [];
      function gtag(){ dataLayer.push(arguments); }
      gtag('consent', 'default', {
        'ad_storage': 'denied',
        'analytics_storage': 'denied',
        'ad_user_data': 'denied',
        'ad_personalization': 'denied',
        'wait_for_update': 500
      });
      gtag('consent', 'update', {
        ad_storage: 'granted',
        analytics_storage: 'granted'
      });
    `;
    const calls = parseConsentCalls([{ content: script, index: 0 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].type).toBe("default");
    expect(calls[0].parameters.ad_storage).toBe("denied");
    expect(calls[0].parameters.ad_user_data).toBe("denied");
    expect(calls[0].parameters.ad_personalization).toBe("denied");
    expect(calls[0].parameters.wait_for_update).toBe(500);
    expect(calls[1].type).toBe("update");
    expect(calls[1].parameters.ad_storage).toBe("granted");
  });
});

describe("analyzeConsent", () => {
  it("gives a high score to a site with full CMP + Consent Mode v2", () => {
    const raw = makeRaw({
      cmp: {
        detected: true,
        vendor: "cookiebot",
        version: "4.x",
        tcfApiPresent: true,
        scriptUrl: "https://consent.cookiebot.com/uc.js",
      },
      consentDefault: {
        found: true,
        beforeGtm: true,
        parameters: {
          ad_storage: "denied",
          analytics_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          wait_for_update: 500,
        },
      },
      googleHits: [
        {
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-XXX&gcs=G100&gcd=11t1t1t1t5",
          gcs: "G100",
          gcd: "11t1t1t1t5",
        },
      ],
      cookies: [],
    });
    const result = analyzeConsent(raw);
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(["A", "B"]).toContain(result.grade);
    expect(result.consentMode.version).toBe("v2");
    expect(result.categoryScores.cmpPresent.score).toBe(15);
    expect(result.categoryScores.tcfApi.score).toBe(10);
    expect(result.categoryScores.consentDefault.score).toBe(20);
    expect(result.categoryScores.consentV2Complete.score).toBe(15);
    expect(result.categoryScores.waitForUpdate.score).toBe(5);
    expect(result.categoryScores.consentInHits.score).toBe(15);
  });

  it("scores a site without any CMP poorly and flags it as high severity", () => {
    const raw = makeRaw();
    const result = analyzeConsent(raw);
    expect(result.score).toBeLessThan(50);
    expect(
      result.issues.some(
        (i) => i.category === "cmp" && i.severity === "high"
      )
    ).toBe(true);
    expect(
      result.issues.some(
        (i) => i.category === "consentMode" && i.severity === "high"
      )
    ).toBe(true);
    expect(result.consentMode.version).toBeNull();
  });

  it("flags Consent Mode v1 (missing ad_user_data / ad_personalization)", () => {
    const raw = makeRaw({
      cmp: {
        detected: true,
        vendor: "onetrust",
        version: null,
        tcfApiPresent: false,
        scriptUrl: null,
      },
      consentDefault: {
        found: true,
        beforeGtm: true,
        parameters: {
          ad_storage: "denied",
          analytics_storage: "denied",
          wait_for_update: 500,
        },
      },
    });
    const result = analyzeConsent(raw);
    expect(result.consentMode.version).toBe("v1");
    expect(
      result.issues.some(
        (i) =>
          i.category === "consentMode" &&
          i.message.includes("v2 is incomplete") &&
          i.message.includes("ad_user_data") &&
          i.message.includes("ad_personalization")
      )
    ).toBe(true);
    expect(result.categoryScores.consentV2Complete.score).toBe(7);
  });

  it("flags consent default that runs AFTER GTM/gtag loads", () => {
    const raw = makeRaw({
      cmp: {
        detected: true,
        vendor: "cookiebot",
        version: null,
        tcfApiPresent: true,
        scriptUrl: null,
      },
      consentDefault: {
        found: true,
        beforeGtm: false,
        parameters: {
          ad_storage: "denied",
          analytics_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          wait_for_update: 500,
        },
      },
    });
    const result = analyzeConsent(raw);
    expect(
      result.issues.some(
        (i) =>
          i.category === "consentMode" &&
          i.message.includes("AFTER") &&
          i.severity === "high"
      )
    ).toBe(true);
    expect(result.categoryScores.consentDefault.score).toBe(10);
  });

  it("flags GA cookies set before user consent as GDPR violation", () => {
    const raw = makeRaw({
      cmp: {
        detected: true,
        vendor: "cookiebot",
        version: null,
        tcfApiPresent: false,
        scriptUrl: null,
      },
      cookies: [
        { name: "_ga", domain: "example.com", firstParty: true },
        { name: "_ga_ABC123", domain: "example.com", firstParty: true },
      ],
    });
    const result = analyzeConsent(raw);
    expect(result.cookies.analyticsCookiesBeforeConsent).toBe(true);
    expect(result.cookies.analyticsCookies).toContain("_ga");
    expect(result.cookies.analyticsCookies).toContain("_ga_ABC123");
    expect(result.categoryScores.noCookiesAnalytics.score).toBe(0);
    expect(
      result.issues.some(
        (i) =>
          i.category === "cookies" &&
          i.message.includes("_ga") &&
          i.severity === "high"
      )
    ).toBe(true);
  });

  it("flags ad cookies set before user consent", () => {
    const raw = makeRaw({
      cookies: [
        { name: "_fbp", domain: "example.com", firstParty: true },
        { name: "IDE", domain: "doubleclick.net", firstParty: false },
      ],
    });
    const result = analyzeConsent(raw);
    expect(result.cookies.adCookiesBeforeConsent).toBe(true);
    expect(result.categoryScores.noCookiesAds.score).toBe(0);
    expect(
      result.issues.some(
        (i) =>
          i.category === "cookies" &&
          i.severity === "high" &&
          i.message.includes("Advertising")
      )
    ).toBe(true);
  });

  it("awards TCF API points when __tcfapi is detected", () => {
    const raw = makeRaw({
      cmp: {
        detected: true,
        vendor: null,
        version: null,
        tcfApiPresent: true,
        scriptUrl: null,
      },
    });
    const result = analyzeConsent(raw);
    expect(result.categoryScores.tcfApi.score).toBe(10);
  });

  it("flags Google hits without consent signals", () => {
    const raw = makeRaw({
      googleHits: [
        {
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-XXX",
          gcs: null,
          gcd: null,
        },
        {
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-XXX&gcs=G100",
          gcs: "G100",
          gcd: null,
        },
      ],
    });
    const result = analyzeConsent(raw);
    expect(result.networkAnalysis.googleHitsDetected).toBe(2);
    expect(result.networkAnalysis.hitsWithConsentSignal).toBe(1);
    expect(result.networkAnalysis.gcsValues).toEqual(["G100"]);
    expect(result.categoryScores.consentInHits.score).toBeLessThan(15);
    expect(
      result.issues.some(
        (i) => i.category === "networkAnalysis"
      )
    ).toBe(true);
  });
});

describe("checkConsentMode (orchestration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles puppeteer launch failures gracefully", async () => {
    const result = await checkConsentMode({
      url: "https://example.com",
      wait_ms: 1000,
    });
    expect(result.status).toBe(0);
    expect(result.score).toBe(0);
    expect(
      result.issues.some((i) => i.element === "browser-error")
    ).toBe(true);
    expect((result.data as any).error).toMatch(/mock|launch/i);
    expect(result.meta.fetchedWith).toBe("puppeteer");
  });
});

describe("checkConsentModeSchema (zod)", () => {
  it("validates input", () => {
    const schema = z.object(checkConsentModeSchema);
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(
      true
    );
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", wait_ms: -1 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", wait_ms: 20000 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", wait_ms: 3000 }).success
    ).toBe(true);
  });
});
