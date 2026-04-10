import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  analyzeImages,
  detectFormat,
  assessAltQuality,
  extractImagesAuditSchema,
  extractImagesAudit,
  type RawImageData,
  type RawPageImageData,
} from "../src/tools/extract-images-audit.js";

// --- puppeteer mock for the error-path test ---
vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(async () => {
      throw new Error("Failed to launch browser: mock");
    }),
  },
}));

// --- helpers ---

function makeImg(overrides: Partial<RawImageData> = {}): RawImageData {
  return {
    src: "https://example.com/img.webp",
    type: "img",
    naturalWidth: 800,
    naturalHeight: 600,
    displayWidth: 800,
    displayHeight: 600,
    alt: "A descriptive alt text for this image",
    loading: null,
    fetchpriority: null,
    hasSrcset: true,
    hasResponsive: true,
    isAboveFold: true,
    role: null,
    ariaHidden: false,
    fileSize: 80 * 1024,
    ...overrides,
  };
}

function makePageData(
  images: RawImageData[],
  extras: Partial<RawPageImageData> = {}
): RawPageImageData {
  return {
    viewport: { width: 1280, height: 800 },
    images,
    trackingPixelsCount: 0,
    dataUriCount: 0,
    ...extras,
  };
}

describe("detectFormat", () => {
  it("recognizes common image formats from URL", () => {
    expect(detectFormat("https://x.com/a.webp")).toBe("webp");
    expect(detectFormat("https://x.com/a.AVIF")).toBe("avif");
    expect(detectFormat("https://x.com/a.jpg?v=1")).toBe("jpeg");
    expect(detectFormat("https://x.com/a.jpeg#frag")).toBe("jpeg");
    expect(detectFormat("https://x.com/a.png")).toBe("png");
    expect(detectFormat("https://x.com/a.svg")).toBe("svg");
    expect(detectFormat("https://x.com/a.gif")).toBe("gif");
    expect(detectFormat("https://x.com/something")).toBe("unknown");
  });
});

describe("assessAltQuality", () => {
  it("classifies alt text correctly", () => {
    expect(assessAltQuality(null, "/a.jpg")).toBe("missing");
    expect(assessAltQuality("", "/a.jpg")).toBe("empty");
    expect(assessAltQuality("image", "/a.jpg")).toBe("generic");
    expect(assessAltQuality("photo", "/a.jpg")).toBe("generic");
    expect(assessAltQuality("hero.jpg", "/hero.jpg")).toBe("generic");
    expect(assessAltQuality("IMG_1234", "/IMG_1234.jpg")).toBe("generic");
    expect(
      assessAltQuality("Team of engineers reviewing reports", "/hero.jpg")
    ).toBe("good");
  });
});

describe("analyzeImages", () => {
  it("scores a well-optimized image set highly", () => {
    const data = makePageData([
      // Hero / LCP: above fold, webp, fetchpriority=high, no lazy
      makeImg({
        src: "https://x.com/hero.webp",
        displayWidth: 1280,
        displayHeight: 600,
        naturalWidth: 1280,
        naturalHeight: 600,
        fetchpriority: "high",
        isAboveFold: true,
        fileSize: 150 * 1024,
      }),
      // Second above-fold image
      makeImg({
        src: "https://x.com/card1.webp",
        displayWidth: 400,
        displayHeight: 300,
        naturalWidth: 800,
        naturalHeight: 600,
        isAboveFold: true,
        fileSize: 60 * 1024,
      }),
      // Below-fold, correctly lazy
      makeImg({
        src: "https://x.com/below1.webp",
        displayWidth: 400,
        displayHeight: 300,
        naturalWidth: 400,
        naturalHeight: 300,
        loading: "lazy",
        isAboveFold: false,
        fileSize: 50 * 1024,
      }),
      makeImg({
        src: "https://x.com/below2.webp",
        displayWidth: 400,
        displayHeight: 300,
        naturalWidth: 400,
        naturalHeight: 300,
        loading: "lazy",
        isAboveFold: false,
        fileSize: 55 * 1024,
      }),
    ]);

    const result = analyzeImages(data);
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(["A", "B"]).toContain(result.grade);
    expect(result.categoryScores.modernFormat.score).toBe(20);
    expect(result.categoryScores.altText.score).toBe(20);
    expect(result.categoryScores.responsive.score).toBe(15);
    expect(result.categoryScores.lcpOptimization.score).toBe(10);
    expect(result.summary.lcpCandidate?.src).toBe("https://x.com/hero.webp");
    expect(result.summary.lcpCandidate?.hasFetchPriority).toBe(true);
    expect(result.summary.lcpCandidate?.hasLazyLoading).toBe(false);
  });

  it("scores a legacy-image page poorly", () => {
    const data = makePageData([
      makeImg({
        src: "https://x.com/hero.jpg",
        alt: null,
        hasSrcset: false,
        hasResponsive: false,
        fileSize: 600 * 1024,
        naturalWidth: 2000,
        displayWidth: 400,
      }),
      makeImg({
        src: "https://x.com/a.png",
        alt: "image",
        hasSrcset: false,
        hasResponsive: false,
        fileSize: 400 * 1024,
      }),
      makeImg({
        src: "https://x.com/b.jpg",
        alt: null,
        hasSrcset: false,
        hasResponsive: false,
        fileSize: 300 * 1024,
      }),
    ]);

    const result = analyzeImages(data);
    expect(result.score).toBeLessThan(50);
    expect(result.categoryScores.modernFormat.score).toBe(0);
    expect(result.categoryScores.responsive.score).toBe(0);
    expect(
      result.issues.some(
        (i) =>
          i.category === "format" &&
          (i.severity === "high" || i.severity === "medium")
      )
    ).toBe(true);
    expect(
      result.issues.some((i) => i.category === "alt" && i.count >= 2)
    ).toBe(true);
    expect(result.summary.missingAlt).toBe(2);
    expect(result.summary.genericAlt).toBe(1);
  });

  it("flags oversized images (natural >> display)", () => {
    const data = makePageData([
      makeImg({
        src: "https://x.com/huge.webp",
        naturalWidth: 2000,
        naturalHeight: 1500,
        displayWidth: 200,
        displayHeight: 150,
        fileSize: 200 * 1024,
      }),
    ]);

    const result = analyzeImages(data);
    expect(result.summary.oversized).toBe(1);
    expect(result.categoryScores.sizing.score).toBe(0);
    expect(
      result.issues.some((i) => i.category === "sizing")
    ).toBe(true);
  });

  it("penalizes LCP candidate with loading=lazy", () => {
    const data = makePageData([
      makeImg({
        src: "https://x.com/hero.webp",
        displayWidth: 1280,
        displayHeight: 600,
        naturalWidth: 1280,
        naturalHeight: 600,
        loading: "lazy",
        fetchpriority: null,
        isAboveFold: true,
      }),
      makeImg({
        src: "https://x.com/small.webp",
        displayWidth: 100,
        displayHeight: 80,
        naturalWidth: 100,
        naturalHeight: 80,
        isAboveFold: true,
      }),
    ]);

    const result = analyzeImages(data);
    expect(result.categoryScores.lcpOptimization.score).toBe(0);
    expect(
      result.issues.some(
        (i) => i.category === "lcp" && i.message.includes("lazy")
      )
    ).toBe(true);
    expect(
      result.issues.some(
        (i) =>
          i.category === "lazyLoading" &&
          i.message.includes("above-the-fold") &&
          i.severity === "high"
      )
    ).toBe(true);
    expect(result.summary.lcpCandidate?.hasLazyLoading).toBe(true);
  });

  it("does not penalize above-fold images without lazy loading", () => {
    const data = makePageData([
      makeImg({
        src: "https://x.com/a.webp",
        loading: null,
        isAboveFold: true,
      }),
      makeImg({
        src: "https://x.com/b.webp",
        loading: null,
        isAboveFold: true,
      }),
    ]);

    const result = analyzeImages(data);
    // All above-fold without lazy = 100% correct lazy-loading behavior
    expect(result.categoryScores.lazyLoading.score).toBe(15);
    expect(
      result.issues.some((i) => i.category === "lazyLoading")
    ).toBe(false);
  });

  it("does not count tracking pixels or data URIs in scoring", () => {
    const data = makePageData(
      [
        makeImg({
          src: "https://x.com/hero.webp",
          displayWidth: 1280,
          displayHeight: 600,
          naturalWidth: 1280,
          naturalHeight: 600,
          fetchpriority: "high",
        }),
      ],
      { trackingPixelsCount: 3, dataUriCount: 4 }
    );

    const result = analyzeImages(data);
    expect(result.summary.totalImages).toBe(1);
    expect(result.summary.trackingPixels).toBe(3);
    expect(result.summary.dataUris).toBe(4);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("flags below-fold images missing loading=lazy", () => {
    const data = makePageData([
      makeImg({
        src: "https://x.com/hero.webp",
        fetchpriority: "high",
        isAboveFold: true,
      }),
      makeImg({
        src: "https://x.com/below.webp",
        isAboveFold: false,
        loading: null,
      }),
      makeImg({
        src: "https://x.com/below2.webp",
        isAboveFold: false,
        loading: null,
      }),
    ]);

    const result = analyzeImages(data);
    expect(result.summary).toMatchObject({ notLazy: 2 });
    expect(
      result.issues.some(
        (i) =>
          i.category === "lazyLoading" &&
          i.message.includes("below-the-fold")
      )
    ).toBe(true);
    expect(result.categoryScores.lazyLoading.score).toBeLessThan(15);
  });

  it("truncates the images array to 100", () => {
    const many = Array.from({ length: 120 }, (_, idx) =>
      makeImg({ src: `https://x.com/img${idx}.webp` })
    );
    const data = makePageData(many);
    const result = analyzeImages(data);
    expect(result.truncated).toBe(true);
    expect(result.images.length).toBe(100);
    expect(result.summary.totalImages).toBe(120);
  });

  it("handles a page with zero images gracefully", () => {
    const data = makePageData([]);
    const result = analyzeImages(data);
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.summary.totalImages).toBe(0);
    expect(result.issues.length).toBe(0);
  });
});

describe("extractImagesAudit (orchestration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles browser launch failures gracefully", async () => {
    const result = await extractImagesAudit({
      url: "https://example.com",
      device: "desktop",
      timeout: 5000,
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

describe("extractImagesAuditSchema (zod)", () => {
  it("validates input", () => {
    const schema = z.object(extractImagesAuditSchema);
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(
      true
    );
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(
      schema.safeParse({
        url: "https://e.com",
        device: "tablet",
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        url: "https://e.com",
        timeout: 500,
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        url: "https://e.com",
        timeout: 50000,
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        url: "https://e.com",
        device: "mobile",
        timeout: 12000,
      }).success
    ).toBe(true);
  });
});
