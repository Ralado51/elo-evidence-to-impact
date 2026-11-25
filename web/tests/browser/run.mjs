/**
 * Elo v3 real-browser accessibility harness entrypoint.
 *
 * Usage:
 *   node web/tests/browser/run.mjs [--pages <path>] [--web-root <path>]
 *
 * Environment:
 *   ELO_PLAYWRIGHT_DIR  Directory containing PO-installed playwright-core@1.65.1
 *                       (default: ~/hackathons/elo-platform/workspace/tools/playwright)
 *
 * Zero dependencies in the product repository; headless Chromium only; loopback-only server.
 * Prints a deterministic JSON report to stdout and exits 0 iff every check passes.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startLocalWebServer, probeServerIsolation } from "./server.mjs";
import {
  checkAccessibilityTree,
  checkKeyboard,
  checkTargetSize,
  checkContrast,
  checkReflowAndZoom,
  checkReducedMotion,
  checkLiveRegion,
} from "./checks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PLAYWRIGHT_DIR = path.join(
  os.homedir(),
  "hackathons",
  "elo-platform",
  "workspace",
  "tools",
  "playwright"
);

function parseArgs(argv) {
  let pagesFile = path.join(__dirname, "pages.json");
  let webRoot = path.resolve(__dirname, "..", "..");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pages" && argv[i + 1]) {
      pagesFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--web-root" && argv[i + 1]) {
      webRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node web/tests/browser/run.mjs [--pages <pages.json>] [--web-root <web/>]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return { pagesFile, webRoot };
}

function normalizePageUrlPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("Each page entry in pages.json must define a non-empty 'path'");
  }
  let p = rawPath.trim().replace(/\\/g, "/");
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  if (p.startsWith("web/")) {
    p = p.slice(3);
  }
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  return p;
}

async function loadPlaywrightCore() {
  const pwDir = process.env.ELO_PLAYWRIGHT_DIR
    ? path.resolve(process.env.ELO_PLAYWRIGHT_DIR)
    : DEFAULT_PLAYWRIGHT_DIR;

  const entryPath = path.join(pwDir, "node_modules", "playwright-core", "index.mjs");
  try {
    await fs.access(entryPath);
  } catch {
    throw new Error(
      `playwright-core entry not found at ${entryPath}. Set ELO_PLAYWRIGHT_DIR to the PO-installed Playwright directory.`
    );
  }

  const pw = await import(pathToFileURL(entryPath).href);
  if (!pw.chromium) {
    throw new Error(`Loaded playwright-core from ${entryPath} without chromium export.`);
  }
  return { chromium: pw.chromium, pwDir };
}

function sortUniqueRequests(records) {
  const map = new Map();
  for (const r of records) {
    const key = `${r.origin_class}|${r.method}|${r.path}|${r.allowed}`;
    if (!map.has(key)) {
      map.set(key, {
        method: r.method,
        origin_class: r.origin_class,
        path: r.path,
        allowed: r.allowed,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.origin_class !== b.origin_class) return a.origin_class.localeCompare(b.origin_class);
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return Number(a.allowed) - Number(b.allowed);
  });
}

async function main() {
  const totalStart = performance.now();
  const { pagesFile, webRoot } = parseArgs(process.argv.slice(2));

  const pagesConfigRaw = await fs.readFile(pagesFile, "utf8");
  const pagesConfig = JSON.parse(pagesConfigRaw);
  if (!pagesConfig || !Array.isArray(pagesConfig.pages) || pagesConfig.pages.length === 0) {
    throw new Error(`pages.json must contain a non-empty "pages" array: ${pagesFile}`);
  }

  const { chromium } = await loadPlaywrightCore();
  const server = await startLocalWebServer(webRoot);
  let browser = null;

  try {
    const serverIsolation = await probeServerIsolation(server.host, server.port);
    browser = await chromium.launch({ headless: true });

    const pageReports = [];
    const pageTimings = {};
    const failedChecksSummary = [];

    if (!serverIsolation.passed) {
      failedChecksSummary.push("server_isolation");
    }

    for (const entry of pagesConfig.pages) {
      const pageStart = performance.now();
      const urlPath = normalizePageUrlPath(entry.path);
      const pageId =
        typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : urlPath;
      const liveRegionModule =
        typeof entry.liveRegionModule === "string" && entry.liveRegionModule.trim()
          ? entry.liveRegionModule.trim()
          : "/v3/a11y.mjs";
      const inlineLinkExceptions = Array.isArray(entry.inlineLinkExceptions)
        ? entry.inlineLinkExceptions
        : [];

      const pageUrl = `${server.origin}${urlPath}`;
      const recordedRequests = [];
      const blockedOutbound = [];

      async function attachNetworkGuard(context) {
        await context.route("**/*", async (route) => {
          const req = route.request();
          const method = req.method();
          let parsed;
          try {
            parsed = new URL(req.url());
          } catch {
            blockedOutbound.push({ method, url: req.url() });
            recordedRequests.push({
              method,
              origin_class: "external",
              path: req.url(),
              allowed: false,
            });
            await route.abort("blockedbyclient");
            return;
          }

          const isLocalServer =
            parsed.protocol === "http:" &&
            parsed.hostname === "127.0.0.1" &&
            parsed.port === String(server.port);

          if (isLocalServer) {
            recordedRequests.push({
              method,
              origin_class: "loopback",
              path: parsed.pathname,
              allowed: true,
            });
            await route.continue();
          } else {
            blockedOutbound.push({ method, url: req.url() });
            recordedRequests.push({
              method,
              origin_class: "external",
              path: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
              allowed: false,
            });
            await route.abort("blockedbyclient");
          }
        });
      }

      const mainContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });
      await attachNetworkGuard(mainContext);

      let checks;
      try {
        const page = await mainContext.newPage();
        const response = await page.goto(pageUrl, { waitUntil: "load" });
        const httpStatus = response ? response.status() : 0;

        if (httpStatus !== 200) {
          checks = {
            page_load: {
              passed: false,
              status: httpStatus,
              failures: [`Failed to load ${urlPath} from local server (HTTP ${httpStatus})`],
            },
          };
        } else {
          const accessibility_tree = await checkAccessibilityTree(mainContext, page);
          const target_size = await checkTargetSize(page, inlineLinkExceptions);
          const contrast = await checkContrast(page);
          await page.close();

          const keyboard = await checkKeyboard(mainContext, pageUrl);
          const live_region = await checkLiveRegion(mainContext, pageUrl, liveRegionModule);
          const reflow_and_zoom = await checkReflowAndZoom(
            browser,
            pageUrl,
            attachNetworkGuard
          );
          const reduced_motion = await checkReducedMotion(
            browser,
            pageUrl,
            attachNetworkGuard
          );

          const network_isolation = {
            passed: blockedOutbound.length === 0,
            outbound_blocked_count: blockedOutbound.length,
            requests: sortUniqueRequests(recordedRequests),
            failures: blockedOutbound.map(
              (b) => `Blocked non-loopback request: ${b.method} ${b.url}`
            ),
          };

          checks = {
            accessibility_tree,
            keyboard,
            target_size,
            contrast,
            reflow_and_zoom,
            reduced_motion,
            live_region,
            network_isolation,
          };
        }
      } finally {
        await mainContext.close();
      }

      const failedCheckNames = Object.entries(checks)
        .filter(([, result]) => !result.passed)
        .map(([name]) => name);

      for (const name of failedCheckNames) {
        failedChecksSummary.push(`${pageId}:${name}`);
      }

      pageReports.push({
        id: pageId,
        path: urlPath,
        passed: failedCheckNames.length === 0,
        failed_checks: failedCheckNames,
        checks,
      });

      pageTimings[pageId] = Math.round((performance.now() - pageStart) * 100) / 100;
    }

    const allPassed =
      serverIsolation.passed && pageReports.every((p) => p.passed);

    const report = {
      harness: "elo-v3-browser-a11y",
      headless: true,
      passed: allPassed,
      failed_checks: failedChecksSummary,
      server_isolation: serverIsolation,
      pages: pageReports,
      timings_ms: {
        total_ms: Math.round((performance.now() - totalStart) * 100) / 100,
        pages: pageTimings,
      },
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    await server.close();
  }
}

main().catch((err) => {
  const errReport = {
    harness: "elo-v3-browser-a11y",
    headless: true,
    passed: false,
    error: err instanceof Error ? err.message : String(err),
  };
  process.stdout.write(`${JSON.stringify(errReport, null, 2)}\n`);
  process.exitCode = 1;
});
