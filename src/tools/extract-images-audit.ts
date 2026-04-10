import { z } from "zod";
import { withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
} from "../utils/response.js";

export const extractImagesAuditSchema = {
  url: z.string().url().describe("The URL of the page to audit"),
  device: z
    .enum(["mobile", "desktop"])
    .default("desktop")
    .describe("Viewport preset to render the page with"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(15000)
    .describe("Navigation timeout in milliseconds"),
};

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const MAX_IMAGES_IN_OUTPUT = 100;

// -------- types --------

export type ImageFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "avif"
  | "svg"
  | "gif"
  | "unknown";

export type AltQuality = "good" | "empty" | "missing" | "generic";

export interface RawImageData {
  src: string;
  type: "img" | "picture" | "css-background";
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  alt: string | null;
  loading: "lazy" | "eager" | null;
  fetchpriority: "high" | "low" | "auto" | null;
  hasSrcset: boolean;
  hasResponsive: boolean;
  isAboveFold: boolean;
  role: string | null;
  ariaHidden: boolean;
  fileSize: number | null;
}

export interface RawPageImageData {
  viewport: { width: number; height: number };
  images: RawImageData[];
  trackingPixelsCount: number;
  dataUriCount: number;
  finalUrl?: string;
}

export interface ProcessedImage extends RawImageData {
  format: ImageFormat;
  altQuality: AltQuality;
  isDecoration: boolean;
  isOversized: boolean;
  isLCP: boolean;
}

interface CategoryScore {
  score: number;
  max: number;
}

// -------- format/alt helpers --------

export function detectFormat(src: string): ImageFormat {
  const clean = src.split("?")[0].split("#")[0].toLowerCase();
  const m = clean.match(/\.(jpe?g|png|webp|avif|svg|gif)$/);
  if (!m) return "unknown";
  if (m[1] === "jpg") return "jpeg";
  return m[1] as ImageFormat;
}

const GENERIC_ALTS = new Set([
  "image",
  "photo",
  "img",
  "picture",
  "icon",
  "logo",
]);

export function assessAltQuality(
  alt: string | null,
  src: string
): AltQuality {
  if (alt === null) return "missing";
  const trimmed = alt.trim();
  if (trimmed.length === 0) return "empty";
  const lower = trimmed.toLowerCase();
  if (GENERIC_ALTS.has(lower)) return "generic";
  const filename =
    src.split("/").pop()?.split("?")[0].toLowerCase() || "";
  if (filename && lower === filename) return "generic";
  if (filename && lower === filename.replace(/\.[a-z]+$/, "")) return "generic";
  if (/^(img|image|photo|dsc|screenshot|untitled)[\-_\s]?\d*$/i.test(lower))
    return "generic";
  if (lower.length < 3) return "generic";
  return "good";
}

function isDecorative(img: RawImageData): boolean {
  if (img.type === "css-background") return true;
  if (img.alt === "") return true;
  if (img.role === "presentation" || img.role === "none") return true;
  if (img.ariaHidden) return true;
  return false;
}

function processImage(raw: RawImageData): ProcessedImage {
  const format = detectFormat(raw.src);
  const altQuality = raw.type === "img" || raw.type === "picture"
    ? assessAltQuality(raw.alt, raw.src)
    : "empty";
  const decoration = isDecorative(raw);
  const oversized =
    raw.naturalWidth > 0 &&
    raw.displayWidth > 0 &&
    raw.naturalWidth > raw.displayWidth * 2;
  return {
    ...raw,
    format,
    altQuality,
    isDecoration: decoration,
    isOversized: oversized,
    isLCP: false,
  };
}

// -------- scoring --------

function scoreModernFormat(images: ProcessedImage[]): CategoryScore {
  const eligible = images.filter((i) => {
    if (i.format === "svg" || i.format === "unknown") return false;
    if (i.fileSize !== null && i.fileSize < 5 * 1024) return false;
    return true;
  });
  if (eligible.length === 0) return { score: 20, max: 20 };
  const modern = eligible.filter(
    (i) => i.format === "webp" || i.format === "avif"
  ).length;
  return {
    score: Math.round((modern / eligible.length) * 20),
    max: 20,
  };
}

function scoreAlt(images: ProcessedImage[]): CategoryScore {
  const imgs = images.filter(
    (i) => i.type === "img" || i.type === "picture"
  );
  const nonDecorative = imgs.filter((i) => !i.isDecoration);
  if (nonDecorative.length === 0) return { score: 20, max: 20 };
  const good = nonDecorative.filter((i) => i.altQuality === "good").length;
  return {
    score: Math.round((good / nonDecorative.length) * 20),
    max: 20,
  };
}

function scoreResponsive(images: ProcessedImage[]): CategoryScore {
  const imgs = images.filter(
    (i) => i.type === "img" || i.type === "picture"
  );
  if (imgs.length === 0) return { score: 15, max: 15 };
  const responsive = imgs.filter((i) => i.hasResponsive).length;
  return {
    score: Math.round((responsive / imgs.length) * 15),
    max: 15,
  };
}

function scoreSizing(images: ProcessedImage[]): CategoryScore {
  const sized = images.filter(
    (i) => i.naturalWidth > 0 && i.displayWidth > 0
  );
  if (sized.length === 0) return { score: 15, max: 15 };
  const good = sized.filter((i) => !i.isOversized).length;
  return {
    score: Math.round((good / sized.length) * 15),
    max: 15,
  };
}

function scoreLazyLoading(images: ProcessedImage[]): CategoryScore {
  const imgs = images.filter(
    (i) => i.type === "img" || i.type === "picture"
  );
  if (imgs.length === 0) return { score: 15, max: 15 };
  let correct = 0;
  for (const img of imgs) {
    if (img.isAboveFold) {
      // Above the fold: must NOT be lazy
      if (img.loading !== "lazy") correct++;
    } else {
      // Below the fold: should be lazy
      if (img.loading === "lazy") correct++;
    }
  }
  return {
    score: Math.round((correct / imgs.length) * 15),
    max: 15,
  };
}

function scoreLcpOptimization(
  lcp: ProcessedImage | null
): CategoryScore {
  if (!lcp) return { score: 10, max: 10 };
  let s = 0;
  if (lcp.loading !== "lazy") s += 5;
  if (lcp.fetchpriority === "high") s += 5;
  return { score: s, max: 10 };
}

function scoreFileSize(images: ProcessedImage[]): CategoryScore {
  const large = images.filter(
    (i) =>
      i.format !== "svg" &&
      i.fileSize !== null &&
      i.fileSize > 500 * 1024
  );
  if (large.length === 0) return { score: 5, max: 5 };
  if (large.length === 1) return { score: 3, max: 5 };
  if (large.length === 2) return { score: 1, max: 5 };
  return { score: 0, max: 5 };
}

function findLcpCandidate(
  images: ProcessedImage[]
): ProcessedImage | null {
  const candidates = images.filter(
    (i) =>
      i.isAboveFold &&
      i.displayWidth > 0 &&
      i.displayHeight > 0 &&
      i.type !== "css-background"
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => {
    const curArea = cur.displayWidth * cur.displayHeight;
    const bestArea = best.displayWidth * best.displayHeight;
    return curArea > bestArea ? cur : best;
  });
}

// -------- analyzer --------

export interface ImageAuditResult {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: {
    totalImages: number;
    imgTags: number;
    pictureElements: number;
    cssBackgrounds: number;
    trackingPixels: number;
    dataUris: number;
    totalTransferSize: number;
    avgFileSize: number;
    largestImage: { src: string; fileSize: number } | null;
    formatBreakdown: Record<string, number>;
    aboveFold: number;
    belowFold: number;
    missingAlt: number;
    genericAlt: number;
    oversized: number;
    notLazyBelowFold: number;
    modernFormatPercent: number;
    responsivePercent: number;
    lcpCandidate: {
      src: string;
      hasLazyLoading: boolean;
      hasFetchPriority: boolean;
    } | null;
  };
  categoryScores: {
    modernFormat: CategoryScore;
    altText: CategoryScore;
    responsive: CategoryScore;
    sizing: CategoryScore;
    lazyLoading: CategoryScore;
    lcpOptimization: CategoryScore;
    fileSize: CategoryScore;
  };
  images: ProcessedImage[];
  truncated: boolean;
  issues: {
    severity: "high" | "medium" | "low" | "info";
    category: string;
    count: number;
    message: string;
  }[];
  recommendations: string[];
}

export function analyzeImages(
  data: RawPageImageData
): ImageAuditResult {
  const processed = data.images.map(processImage);

  // Mark LCP candidate
  const lcp = findLcpCandidate(processed);
  if (lcp) lcp.isLCP = true;

  // Scoring
  const modernFormat = scoreModernFormat(processed);
  const altText = scoreAlt(processed);
  const responsive = scoreResponsive(processed);
  const sizing = scoreSizing(processed);
  const lazyLoading = scoreLazyLoading(processed);
  const lcpOptimization = scoreLcpOptimization(lcp);
  const fileSize = scoreFileSize(processed);

  const categoryScores = {
    modernFormat,
    altText,
    responsive,
    sizing,
    lazyLoading,
    lcpOptimization,
    fileSize,
  };

  const rawSum = Object.values(categoryScores).reduce(
    (s, c) => s + c.score,
    0
  );

  const score = rawSum; // max = 100

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 90) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 50) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  // Aggregates
  const imgs = processed.filter(
    (i) => i.type === "img" || i.type === "picture"
  );
  const imgTags = processed.filter((i) => i.type === "img").length;
  const pictureElements = processed.filter(
    (i) => i.type === "picture"
  ).length;
  const cssBackgrounds = processed.filter(
    (i) => i.type === "css-background"
  ).length;

  const sizedImages = processed.filter((i) => i.fileSize !== null);
  const totalTransferSize = sizedImages.reduce(
    (s, i) => s + (i.fileSize ?? 0),
    0
  );
  const avgFileSize =
    sizedImages.length > 0
      ? Math.round(totalTransferSize / sizedImages.length)
      : 0;

  const largest = sizedImages.reduce<ProcessedImage | null>(
    (best, cur) =>
      cur.fileSize !== null &&
      (best === null || cur.fileSize > (best.fileSize ?? 0))
        ? cur
        : best,
    null
  );

  const formatBreakdown: Record<string, number> = {};
  for (const img of processed) {
    formatBreakdown[img.format] = (formatBreakdown[img.format] ?? 0) + 1;
  }

  const aboveFold = processed.filter((i) => i.isAboveFold).length;
  const belowFold = processed.length - aboveFold;

  const missingAlt = imgs.filter(
    (i) => !i.isDecoration && i.altQuality === "missing"
  ).length;
  const genericAlt = imgs.filter(
    (i) => !i.isDecoration && i.altQuality === "generic"
  ).length;
  const emptyAlt = imgs.filter(
    (i) => !i.isDecoration && i.altQuality === "empty"
  ).length;

  const oversized = processed.filter((i) => i.isOversized).length;
  const notLazyBelowFold = imgs.filter(
    (i) => !i.isAboveFold && i.loading !== "lazy"
  ).length;
  const lazyAboveFold = imgs.filter(
    (i) => i.isAboveFold && i.loading === "lazy"
  ).length;

  const eligibleForFormat = processed.filter(
    (i) =>
      i.format !== "svg" &&
      i.format !== "unknown" &&
      (i.fileSize === null || i.fileSize >= 5 * 1024)
  );
  const modernCount = eligibleForFormat.filter(
    (i) => i.format === "webp" || i.format === "avif"
  ).length;
  const modernFormatPercent =
    eligibleForFormat.length > 0
      ? Math.round((modernCount / eligibleForFormat.length) * 100)
      : 100;

  const responsivePercent =
    imgs.length > 0
      ? Math.round(
          (imgs.filter((i) => i.hasResponsive).length / imgs.length) * 100
        )
      : 100;

  // Issues
  const issues: ImageAuditResult["issues"] = [];
  const legacyCount = eligibleForFormat.filter(
    (i) => i.format === "jpeg" || i.format === "png" || i.format === "gif"
  ).length;
  if (legacyCount > 0) {
    issues.push({
      severity: legacyCount >= 5 ? "high" : "medium",
      category: "format",
      count: legacyCount,
      message: `${legacyCount} image(s) use legacy formats (JPEG/PNG/GIF) — convert to WebP or AVIF for 30-50% size savings`,
    });
  }
  if (oversized > 0) {
    issues.push({
      severity: oversized >= 5 ? "high" : "medium",
      category: "sizing",
      count: oversized,
      message: `${oversized} image(s) are oversized (served at 2x+ their display size) — resize or use srcset`,
    });
  }
  if (missingAlt > 0) {
    issues.push({
      severity: "high",
      category: "alt",
      count: missingAlt,
      message: `${missingAlt} image(s) are missing alt text`,
    });
  }
  if (genericAlt > 0) {
    issues.push({
      severity: "medium",
      category: "alt",
      count: genericAlt,
      message: `${genericAlt} image(s) have generic alt text (e.g. "image", filename)`,
    });
  }
  const nonResponsive = imgs.filter((i) => !i.hasResponsive).length;
  if (nonResponsive > 0 && imgs.length > 1) {
    issues.push({
      severity: nonResponsive >= 5 ? "medium" : "low",
      category: "responsive",
      count: nonResponsive,
      message: `${nonResponsive} image(s) lack srcset — they serve the same file to all screen sizes`,
    });
  }
  if (notLazyBelowFold > 0) {
    issues.push({
      severity: "medium",
      category: "lazyLoading",
      count: notLazyBelowFold,
      message: `${notLazyBelowFold} below-the-fold image(s) should use loading="lazy"`,
    });
  }
  if (lazyAboveFold > 0) {
    issues.push({
      severity: "high",
      category: "lazyLoading",
      count: lazyAboveFold,
      message: `${lazyAboveFold} above-the-fold image(s) use loading="lazy" — this delays LCP`,
    });
  }
  const largeImages = processed.filter(
    (i) =>
      i.format !== "svg" &&
      i.fileSize !== null &&
      i.fileSize > 500 * 1024
  );
  if (largeImages.length > 0) {
    issues.push({
      severity: "low",
      category: "fileSize",
      count: largeImages.length,
      message: `${largeImages.length} image(s) exceed 500KB — consider compression`,
    });
  }
  if (lcp) {
    if (lcp.loading === "lazy") {
      issues.push({
        severity: "high",
        category: "lcp",
        count: 1,
        message: `The LCP candidate image uses loading="lazy" — remove lazy loading from above-the-fold images`,
      });
    }
    if (lcp.fetchpriority !== "high") {
      issues.push({
        severity: "medium",
        category: "lcp",
        count: 1,
        message: `The LCP candidate image should have fetchpriority="high"`,
      });
    }
  }

  // Recommendations (human summaries)
  const recommendations: string[] = [];
  if (legacyCount > 0) {
    recommendations.push(
      `Convert ${legacyCount} JPEG/PNG image(s) to WebP or AVIF to save ~30-50% bandwidth`
    );
  }
  if (nonResponsive > 0 && imgs.length > 1) {
    recommendations.push(
      `Add srcset attributes to serve appropriately sized images per viewport`
    );
  }
  if (missingAlt > 0 || genericAlt > 0) {
    recommendations.push(
      `Add descriptive alt text to ${missingAlt + genericAlt} image(s) for accessibility and SEO`
    );
  }
  if (oversized > 0) {
    recommendations.push(
      `Resize ${oversized} oversized image(s) to match their display dimensions`
    );
  }
  if (notLazyBelowFold > 0) {
    recommendations.push(
      `Add loading="lazy" to ${notLazyBelowFold} below-the-fold image(s)`
    );
  }
  if (lcp && (lcp.loading === "lazy" || lcp.fetchpriority !== "high")) {
    recommendations.push(
      `Optimize the LCP candidate: remove loading="lazy" and add fetchpriority="high"`
    );
  }

  // Limit images output
  const truncated = processed.length > MAX_IMAGES_IN_OUTPUT;
  const imagesOut = truncated
    ? processed.slice(0, MAX_IMAGES_IN_OUTPUT)
    : processed;

  return {
    score,
    grade,
    summary: {
      totalImages: processed.length,
      imgTags,
      pictureElements,
      cssBackgrounds,
      trackingPixels: data.trackingPixelsCount,
      dataUris: data.dataUriCount,
      totalTransferSize,
      avgFileSize,
      largestImage: largest
        ? { src: largest.src, fileSize: largest.fileSize ?? 0 }
        : null,
      formatBreakdown,
      aboveFold,
      belowFold,
      missingAlt: missingAlt + emptyAlt,
      genericAlt,
      oversized,
      notLazy: notLazyBelowFold,
      modernFormatPercent,
      responsivePercent,
      lcpCandidate: lcp
        ? {
            src: lcp.src,
            hasLazyLoading: lcp.loading === "lazy",
            hasFetchPriority: lcp.fetchpriority === "high",
          }
        : null,
    } as ImageAuditResult["summary"] & { notLazy: number },
    categoryScores,
    images: imagesOut,
    truncated,
    issues,
    recommendations,
  };
}

// -------- browser orchestration --------

async function collectPageImageData(
  url: string,
  device: "mobile" | "desktop",
  timeout: number
): Promise<RawPageImageData & { finalUrl: string; status: number }> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();
    const viewport =
      device === "mobile"
        ? { width: 375, height: 812 }
        : { width: 1280, height: 800 };
    await page.setViewport(viewport);
    if (device === "mobile") {
      await page.setUserAgent(MOBILE_UA);
    }

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });
    const status = response?.status() ?? 0;

    // Progressive scroll to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = 500;
        const maxIterations = 40;
        let iterations = 0;
        const timer = setInterval(() => {
          window.scrollTo(0, y);
          y += step;
          iterations++;
          if (
            y >= document.body.scrollHeight ||
            iterations >= maxIterations
          ) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, 200);
      });
    });

    // Collect images from the page
    const rawData = await page.evaluate((viewportHeight: number) => {
      const images: Array<Record<string, unknown>> = [];
      let trackingPixelsCount = 0;
      let dataUriCount = 0;

      const isTrackingPixel = (w: number, h: number) =>
        (w === 1 && h === 1) || (w === 0 && h === 0);

      const perfEntries: Record<string, number> = {};
      for (const entry of performance.getEntriesByType("resource")) {
        const resEntry = entry as PerformanceResourceTiming;
        if (
          resEntry.initiatorType === "img" ||
          resEntry.initiatorType === "css" ||
          resEntry.initiatorType === "link"
        ) {
          perfEntries[resEntry.name] =
            resEntry.transferSize ||
            resEntry.encodedBodySize ||
            0;
        }
      }

      const seen = new Set<string>();

      // <img>
      document.querySelectorAll("img").forEach((img) => {
        const src = img.currentSrc || img.src;
        if (!src) return;
        if (src.startsWith("data:")) {
          if (src.length < 2048) {
            dataUriCount++;
            return;
          }
        }
        if (isTrackingPixel(img.naturalWidth, img.naturalHeight)) {
          trackingPixelsCount++;
          return;
        }

        const rect = img.getBoundingClientRect();
        const isPicture =
          img.parentElement?.tagName?.toLowerCase() === "picture";
        const hasPictureSource =
          isPicture &&
          !!img.parentElement?.querySelector("source");

        seen.add(src);

        images.push({
          src,
          type: isPicture ? "picture" : "img",
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          displayWidth: Math.round(rect.width),
          displayHeight: Math.round(rect.height),
          alt: img.getAttribute("alt"),
          loading: img.getAttribute("loading"),
          fetchpriority: img.getAttribute("fetchpriority"),
          hasSrcset:
            img.hasAttribute("srcset") && img.getAttribute("srcset") !== "",
          hasResponsive:
            (img.hasAttribute("srcset") &&
              img.getAttribute("srcset") !== "") ||
            hasPictureSource,
          isAboveFold:
            rect.top < viewportHeight && rect.top + rect.height > 0,
          role: img.getAttribute("role"),
          ariaHidden: img.getAttribute("aria-hidden") === "true",
          fileSize: perfEntries[src] ?? null,
        });
      });

      // CSS background-image (only visible elements)
      document.querySelectorAll("*").forEach((el) => {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (!bg || bg === "none") return;
        const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (!urlMatch) return;
        let src = urlMatch[1];
        if (src.startsWith("data:")) {
          if (src.length < 2048) {
            dataUriCount++;
            return;
          }
        }
        try {
          src = new URL(src, document.baseURI).href;
        } catch {
          /* ignore */
        }
        if (seen.has(src)) return;
        seen.add(src);

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        images.push({
          src,
          type: "css-background",
          naturalWidth: 0,
          naturalHeight: 0,
          displayWidth: Math.round(rect.width),
          displayHeight: Math.round(rect.height),
          alt: null,
          loading: null,
          fetchpriority: null,
          hasSrcset: false,
          hasResponsive: false,
          isAboveFold:
            rect.top < viewportHeight && rect.top + rect.height > 0,
          role: null,
          ariaHidden: false,
          fileSize: perfEntries[src] ?? null,
        });
      });

      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        images,
        trackingPixelsCount,
        dataUriCount,
      };
    }, viewport.height);

    return {
      viewport: rawData.viewport,
      images: rawData.images as unknown as RawImageData[],
      trackingPixelsCount: rawData.trackingPixelsCount,
      dataUriCount: rawData.dataUriCount,
      finalUrl: page.url(),
      status,
    };
  } finally {
    await browser.close();
  }
}

// -------- main handler --------

export async function extractImagesAudit({
  url,
  device,
  timeout,
}: {
  url: string;
  device: "mobile" | "desktop";
  timeout: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  try {
    const raw = await withPuppeteerTimeout(
      () => collectPageImageData(url, device, timeout),
      timeout + 10000
    );

    const analysis = analyzeImages(raw);
    const stdIssues = analysis.issues.map((i) =>
      createIssue(
        i.severity === "high"
          ? "error"
          : i.severity === "medium"
            ? "warning"
            : "info",
        `${i.category}`,
        i.message
      )
    );

    return {
      url,
      finalUrl: raw.finalUrl,
      status: raw.status,
      score: analysis.score,
      summary: `Audit des images de ${url}: score ${analysis.score}/100 (grade ${analysis.grade}, ${analysis.summary.totalImages} images)`,
      issues: stdIssues,
      recommendations: analysis.recommendations,
      meta: createMeta(startTime, "puppeteer", false, analysis.truncated),
      data: {
        device,
        grade: analysis.grade,
        summary: analysis.summary,
        categoryScores: analysis.categoryScores,
        images: analysis.images,
        truncated: analysis.truncated,
        a11yIssues: analysis.issues,
      },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown browser error";
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Impossible d'auditer ${url}: ${message}`,
      issues: [createIssue("error", "browser-error", message)],
      recommendations: [`[browser-error] ${message}`],
      meta: createMeta(startTime, "puppeteer", false, true),
      data: { error: message, device },
    };
  }
}
