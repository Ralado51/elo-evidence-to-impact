/**
 * Real-browser accessibility checks for Elo v3 pages.
 *
 * Uses Playwright (playwright-core) + Chromium CDP Accessibility.getFullAXTree.
 * Covers ACCEPTANCE rows 4-10:
 *   4. accessibility_tree
 *   5. keyboard
 *   6. target_size
 *   7. contrast
 *   8. reflow_and_zoom
 *   9. reduced_motion
 *  10. live_region
 */

const NAMED_INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
]);

function getPropMap(axNode) {
  const map = new Map();
  if (Array.isArray(axNode.properties)) {
    for (const prop of axNode.properties) {
      map.set(prop.name, prop.value ? prop.value.value : undefined);
    }
  }
  return map;
}

/**
 * Row 4: Accessibility tree checks via CDP Accessibility.getFullAXTree.
 */
export async function checkAccessibilityTree(context, page) {
  const cdp = await context.newCDPSession(page);
  let nodes;
  try {
    const res = await cdp.send("Accessibility.getFullAXTree");
    nodes = res.nodes || [];
  } finally {
    await cdp.detach();
  }

  const activeNodes = nodes.filter((n) => !n.ignored);
  const failures = [];

  const mainNodes = [];
  const bannerNodes = [];
  const navNodes = [];
  const h1Nodes = [];
  const liveRegions = [];
  const interactiveChecks = [];

  for (const node of activeNodes) {
    const role = node.role?.value || "";
    const name = String(node.name?.value ?? "").trim();
    const props = getPropMap(node);

    if (role === "main") {
      mainNodes.push({ role, name });
    }
    if (role === "banner") {
      bannerNodes.push({ role, name });
    }
    if (role === "navigation") {
      navNodes.push({ role, name });
    }
    if (role === "heading" && props.get("level") === 1) {
      h1Nodes.push({ role, name, level: 1 });
    }

    const liveProp = props.get("live");
    if (
      (liveProp === "polite" || liveProp === "assertive") &&
      role !== "StaticText" &&
      role !== "InlineTextBox"
    ) {
      liveRegions.push({ role, name, live: liveProp });
    }

    if (NAMED_INTERACTIVE_ROLES.has(role)) {
      interactiveChecks.push({ role, name });
      if (!name) {
        failures.push(`Interactive AX node with role "${role}" has an empty accessible name`);
      }
    }
  }

  if (mainNodes.length !== 1) {
    failures.push(`Expected exactly 1 "main" landmark, found ${mainNodes.length}`);
  }
  if (bannerNodes.length !== 1) {
    failures.push(`Expected exactly 1 "banner" landmark, found ${bannerNodes.length}`);
  }
  if (navNodes.length !== 1) {
    failures.push(`Expected exactly 1 "navigation" landmark, found ${navNodes.length}`);
  } else if (!navNodes[0].name) {
    failures.push(`The "navigation" landmark must have a non-empty accessible name`);
  }
  if (h1Nodes.length !== 1) {
    failures.push(`Expected exactly 1 level-1 heading, found ${h1Nodes.length}`);
  } else if (!h1Nodes[0].name) {
    failures.push(`The level-1 heading must have a non-empty accessible name`);
  }
  if (liveRegions.length !== 1) {
    failures.push(`Expected exactly 1 live region, found ${liveRegions.length}`);
  }

  return {
    passed: failures.length === 0,
    counts: {
      main: mainNodes.length,
      banner: bannerNodes.length,
      navigation: navNodes.length,
      h1: h1Nodes.length,
      live_regions: liveRegions.length,
      interactive_named: interactiveChecks.filter((n) => n.name.length > 0).length,
      interactive_total: interactiveChecks.length,
    },
    failures,
  };
}

/**
 * Row 5: Keyboard navigation, skip link activation, focus ring >= 3px, no trap.
 */
export async function checkKeyboard(context, pageUrl) {
  const failures = [];

  // Pass A: First Tab stop is skip link, Enter moves focus into <main>, focus ring >= 3px
  const pageA = await context.newPage();
  let skipLinkDetails = null;
  try {
    await pageA.goto(pageUrl, { waitUntil: "load" });
    await pageA.keyboard.press("Tab");

    skipLinkDetails = await pageA.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { focused: false };
      }
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const href = el.getAttribute("href") || "";
      const outlineWidthPx = Number.parseFloat(cs.outlineWidth) || 0;
      return {
        focused: true,
        tag,
        href,
        text: (el.textContent || "").trim(),
        outlineStyle: cs.outlineStyle,
        outlineWidthPx,
      };
    });

    if (!skipLinkDetails.focused) {
      failures.push("First Tab press did not focus any element");
    } else {
      if (skipLinkDetails.tag !== "a" || !skipLinkDetails.href.startsWith("#")) {
        failures.push(
          `First Tab stop must be a skip link (<a href="#...">), got <${skipLinkDetails.tag} href="${skipLinkDetails.href}">`
        );
      }
      if (
        skipLinkDetails.outlineStyle === "none" ||
        skipLinkDetails.outlineStyle === "hidden" ||
        skipLinkDetails.outlineWidthPx < 3
      ) {
        failures.push(
          `Skip link focus ring invalid: style="${skipLinkDetails.outlineStyle}", width=${skipLinkDetails.outlineWidthPx}px (expected >= 3px and not none)`
        );
      }

      await pageA.keyboard.press("Enter");

      const afterEnter = await pageA.evaluate(() => {
        const main = document.querySelector("main, [role='main']");
        const active = document.activeElement;
        const inMain = Boolean(
          main &&
            active &&
            active !== document.body &&
            active !== document.documentElement &&
            (active === main || main.contains(active))
        );
        return {
          hasMain: Boolean(main),
          inMain,
          activeTag: active ? active.tagName.toLowerCase() : null,
          activeId: active ? active.id || null : null,
        };
      });

      if (!afterEnter.hasMain) {
        failures.push("Page has no <main> landmark for skip link target");
      } else if (!afterEnter.inMain) {
        failures.push(
          `Pressing Enter on skip link (${skipLinkDetails.href}) did not move focus into <main> (activeElement=<${afterEnter.activeTag}#${afterEnter.activeId || ""}>)`
        );
      }
    }
  } finally {
    await pageA.close();
  }

  // Pass B: Real Tab loop visits every expected tab stop in document order,
  // verifies focus ring >= 3px on every stop, checks radio-group Arrow reachability,
  // and verifies wrap-around back to first stop without a focus trap.
  const pageB = await context.newPage();
  let tabSummary = null;
  try {
    await pageB.goto(pageUrl, { waitUntil: "load" });

    const expectedInfo = await pageB.evaluate(() => {
      const selector = [
        "a[href]",
        "button:not([disabled])",
        'input:not([type="hidden"]):not([disabled])',
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
        '[role="button"]:not([disabled])',
        '[role="link"]',
      ].join(", ");

      function isVisibleForFocus(el) {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (cur.hasAttribute("hidden") || cur.hasAttribute("inert")) {
            return false;
          }
          const cs = getComputedStyle(cur);
          if (cs.display === "none" || cs.visibility === "hidden") {
            return false;
          }
          cur = cur.parentElement;
        }
        return true;
      }

      function describe(el, idx) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const type = el.getAttribute("type") ? `[type=${el.getAttribute("type")}]` : "";
        const name = el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : "";
        return `${tag}${id}${type}${name}@${idx}`;
      }

      const raw = Array.from(document.querySelectorAll(selector)).filter((el) => {
        if (!isVisibleForFocus(el)) return false;
        const ti = el.getAttribute("tabindex");
        if (ti !== null && Number.parseInt(ti, 10) < 0) return false;
        return true;
      });

      const radioGroups = new Map();
      for (const el of raw) {
        if (el.tagName === "INPUT" && el.type === "radio" && el.name) {
          if (!radioGroups.has(el.name)) {
            radioGroups.set(el.name, []);
          }
          radioGroups.get(el.name).push(el);
        }
      }

      const activeRadioPerGroup = new Map();
      for (const [groupName, radios] of radioGroups.entries()) {
        const checked = radios.find((r) => r.checked) || radios[0];
        activeRadioPerGroup.set(groupName, checked);
      }

      const expectedTabStops = [];
      let idx = 0;
      for (const el of raw) {
        el.dataset.eloKbdIdx = String(idx);
        const desc = describe(el, idx);
        idx += 1;
        if (el.tagName === "INPUT" && el.type === "radio" && el.name) {
          if (activeRadioPerGroup.get(el.name) === el) {
            expectedTabStops.push({ kbdIdx: el.dataset.eloKbdIdx, desc, radioGroup: el.name });
          }
        } else {
          expectedTabStops.push({ kbdIdx: el.dataset.eloKbdIdx, desc, radioGroup: null });
        }
      }

      const radioGroupSummary = [];
      for (const [groupName, radios] of radioGroups.entries()) {
        if (radios.length > 1) {
          radioGroupSummary.push({
            name: groupName,
            members: radios.map((r) => ({
              kbdIdx: r.dataset.eloKbdIdx,
              desc: describe(r, Number(r.dataset.eloKbdIdx)),
            })),
          });
        }
      }

      return {
        totalInteractive: raw.length,
        expectedTabStops,
        radioGroupSummary,
      };
    });

    const visited = [];
    const seenIdx = new Set();
    let wrappedBackToStart = false;
    const maxPresses = expectedInfo.expectedTabStops.length + 6;

    for (let step = 0; step < maxPresses; step += 1) {
      await pageB.keyboard.press("Tab");
      const current = await pageB.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) {
          return { isDocument: true };
        }
        const cs = getComputedStyle(el);
        return {
          isDocument: false,
          kbdIdx: el.dataset.eloKbdIdx ?? null,
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          outlineStyle: cs.outlineStyle,
          outlineWidthPx: Number.parseFloat(cs.outlineWidth) || 0,
        };
      });

      if (current.isDocument) {
        continue;
      }

      if (
        visited.length > 0 &&
        current.kbdIdx !== null &&
        current.kbdIdx === visited[0].kbdIdx
      ) {
        if (visited.length >= expectedInfo.expectedTabStops.length) {
          wrappedBackToStart = true;
          break;
        }
        failures.push(
          `Focus wrapped prematurely to first stop after ${visited.length}/${expectedInfo.expectedTabStops.length} stops`
        );
        break;
      }

      if (current.kbdIdx !== null && seenIdx.has(current.kbdIdx)) {
        failures.push(
          `Keyboard focus trap detected: element idx=${current.kbdIdx} (<${current.tag}#${current.id}>) repeated before completing Tab cycle`
        );
        break;
      }

      if (
        current.outlineStyle === "none" ||
        current.outlineStyle === "hidden" ||
        current.outlineWidthPx < 3
      ) {
        failures.push(
          `Focused element <${current.tag}#${current.id}> (stop ${visited.length}) has invalid focus ring: style="${current.outlineStyle}", width=${current.outlineWidthPx}px (expected >= 3px and not none)`
        );
      }

      if (current.kbdIdx !== null) {
        seenIdx.add(current.kbdIdx);
      }
      visited.push(current);
    }

    const expectedOrder = expectedInfo.expectedTabStops.map((s) => s.kbdIdx);
    const actualOrder = visited.map((v) => v.kbdIdx);

    if (actualOrder.length !== expectedOrder.length) {
      failures.push(
        `Tab order visited ${actualOrder.length} stops, expected ${expectedOrder.length}`
      );
    } else {
      for (let i = 0; i < expectedOrder.length; i += 1) {
        if (actualOrder[i] !== expectedOrder[i]) {
          failures.push(
            `Tab order mismatch at position ${i}: visited idx=${actualOrder[i]}, expected idx=${expectedOrder[i]} (${expectedInfo.expectedTabStops[i].desc})`
          );
          break;
        }
      }
    }

    if (!wrappedBackToStart) {
      failures.push(
        "Tab cycle did not return to the first focusable element without a trap"
      );
    }

    // Verify multi-radio groups are fully reachable via ArrowDown with valid focus rings.
    for (const group of expectedInfo.radioGroupSummary) {
      const groupFirstIdx = group.members[0].kbdIdx;
      const groupMemberSet = new Set(group.members.map((m) => m.kbdIdx));
      let landed = false;
      for (let step = 0; step < expectedInfo.expectedTabStops.length + 4; step += 1) {
        const curIdx = await pageB.evaluate(
          () => document.activeElement?.dataset?.eloKbdIdx ?? null
        );
        if (curIdx && groupMemberSet.has(curIdx)) {
          landed = true;
          break;
        }
        await pageB.keyboard.press("Tab");
      }
      if (!landed) {
        failures.push(`Could not reach radio group "${group.name}" via Tab`);
        continue;
      }

      const visitedRadios = new Set();
      for (let i = 0; i < group.members.length; i += 1) {
        const cur = await pageB.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            kbdIdx: el.dataset.eloKbdIdx ?? null,
            outlineStyle: cs.outlineStyle,
            outlineWidthPx: Number.parseFloat(cs.outlineWidth) || 0,
          };
        });
        if (cur && cur.kbdIdx && groupMemberSet.has(cur.kbdIdx)) {
          visitedRadios.add(cur.kbdIdx);
          if (
            cur.outlineStyle === "none" ||
            cur.outlineStyle === "hidden" ||
            cur.outlineWidthPx < 3
          ) {
            failures.push(
              `Radio group "${group.name}" member idx=${cur.kbdIdx} has invalid focus ring: style="${cur.outlineStyle}", width=${cur.outlineWidthPx}px`
            );
          }
        }
        await pageB.keyboard.press("ArrowDown");
      }

      if (visitedRadios.size !== group.members.length) {
        failures.push(
          `Radio group "${group.name}" only reached ${visitedRadios.size}/${group.members.length} members via Arrow keys (first=${groupFirstIdx})`
        );
      }
    }

    tabSummary = {
      expected_tab_stops: expectedOrder.length,
      visited_tab_stops: actualOrder.length,
      total_interactive_elements: expectedInfo.totalInteractive,
      wrapped_to_start: wrappedBackToStart,
      radio_groups_checked: expectedInfo.radioGroupSummary.length,
    };
  } finally {
    await pageB.close();
  }

  return {
    passed: failures.length === 0,
    skip_link: skipLinkDetails
      ? {
          tag: skipLinkDetails.tag,
          href: skipLinkDetails.href,
          outline_style: skipLinkDetails.outlineStyle,
          outline_width_px: skipLinkDetails.outlineWidthPx,
        }
      : null,
    tab_cycle: tabSummary,
    failures,
  };
}

/**
 * Row 6: Rendered bounding box >= 48x48 CSS px for every interactive element.
 */
export async function checkTargetSize(page, inlineLinkExceptions = []) {
  const validExceptions = [];
  const failures = [];

  for (const exc of inlineLinkExceptions) {
    if (
      !exc ||
      typeof exc.selector !== "string" ||
      !exc.selector.trim() ||
      typeof exc.reason !== "string" ||
      !exc.reason.trim()
    ) {
      failures.push(
        "Invalid inlineLinkExceptions entry in pages.json: both non-empty selector and reason are required"
      );
    } else {
      validExceptions.push({
        selector: exc.selector.trim(),
        reason: exc.reason.trim(),
      });
    }
  }

  const result = await page.evaluate((exceptions) => {
    const selector = [
      "a[href]",
      "button",
      'input:not([type="hidden"])',
      "select",
      "textarea",
      '[role="button"]',
      '[role="link"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ");

    function isVisible(el) {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        if (cur.hasAttribute("hidden")) return false;
        const cs = getComputedStyle(cur);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        cur = cur.parentElement;
      }
      return true;
    }

    function describe(el, idx) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).join(".")}`
          : "";
      return `${tag}${id}${cls}[${idx}]`;
    }

    const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
      if (!isVisible(el)) return false;
      const ti = el.getAttribute("tabindex");
      if (ti !== null && Number.parseInt(ti, 10) < 0) return false;
      return true;
    });

    const measurements = [];
    const small = [];
    let exceptedCount = 0;

    elements.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width * 100) / 100;
      const height = Math.round(rect.height * 100) / 100;
      const desc = describe(el, idx);

      if (el.tagName === "A") {
        const matched = exceptions.find((ex) => {
          try {
            return el.matches(ex.selector);
          } catch {
            return false;
          }
        });
        if (matched) {
          exceptedCount += 1;
          measurements.push({
            element: desc,
            width_px: width,
            height_px: height,
            excepted: true,
          });
          return;
        }
      }

      measurements.push({
        element: desc,
        width_px: width,
        height_px: height,
        excepted: false,
      });

      if (rect.width < 48 || rect.height < 48) {
        small.push({
          element: desc,
          width_px: width,
          height_px: height,
        });
      }
    });

    const nonExcepted = measurements.filter((m) => !m.excepted);
    return {
      checked_count: elements.length,
      excepted_count: exceptedCount,
      min_width_px:
        nonExcepted.length > 0 ? Math.min(...nonExcepted.map((m) => m.width_px)) : 0,
      min_height_px:
        nonExcepted.length > 0 ? Math.min(...nonExcepted.map((m) => m.height_px)) : 0,
      small,
    };
  }, validExceptions);

  for (const item of result.small) {
    failures.push(
      `Interactive element ${item.element} rendered at ${item.width_px}x${item.height_px}px (< 48x48px)`
    );
  }

  return {
    passed: failures.length === 0,
    checked_count: result.checked_count,
    excepted_count: result.excepted_count,
    min_width_px: result.min_width_px,
    min_height_px: result.min_height_px,
    failures,
  };
}

/**
 * Row 7: Computed foreground vs nearest opaque background contrast for every visible text node.
 */
export async function checkContrast(page) {
  const result = await page.evaluate(() => {
    function parseColor(str) {
      if (!str || str === "transparent") {
        return { r: 0, g: 0, b: 0, a: 0 };
      }
      const rgbMatch = str.match(
        /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i
      );
      if (rgbMatch) {
        return {
          r: Number(rgbMatch[1]),
          g: Number(rgbMatch[2]),
          b: Number(rgbMatch[3]),
          a: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]),
        };
      }
      const srgbMatch = str.match(
        /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i
      );
      if (srgbMatch) {
        return {
          r: Number(srgbMatch[1]) * 255,
          g: Number(srgbMatch[2]) * 255,
          b: Number(srgbMatch[3]) * 255,
          a: srgbMatch[4] === undefined ? 1 : Number(srgbMatch[4]),
        };
      }
      return null;
    }

    function composite(fg, bg) {
      const a = fg.a + bg.a * (1 - fg.a);
      if (a === 0) return { r: 255, g: 255, b: 255, a: 1 };
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
      };
    }

    function channelLuminance(c) {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(rgb) {
      return (
        0.2126 * channelLuminance(rgb.r) +
        0.7152 * channelLuminance(rgb.g) +
        0.0722 * channelLuminance(rgb.b)
      );
    }

    function contrastRatio(c1, c2) {
      const l1 = relativeLuminance(c1);
      const l2 = relativeLuminance(c2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function effectiveBackground(el) {
      const layers = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const bg = parseColor(getComputedStyle(cur).backgroundColor);
        if (bg && bg.a > 0) {
          layers.push(bg);
          if (bg.a >= 1) {
            break;
          }
        }
        cur = cur.parentElement;
      }
      let acc = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        acc = composite(layers[i], acc);
      }
      return acc;
    }

    function isElementVisible(el) {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        if (cur.hasAttribute("hidden")) return false;
        const cs = getComputedStyle(cur);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          Number.parseFloat(cs.opacity) === 0
        ) {
          return false;
        }
        cur = cur.parentElement;
      }
      return true;
    }

    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "OPTGROUP"]);

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const failures = [];
    let checkedNodes = 0;
    let minRatio = Infinity;

    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || "").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName)) continue;
      if (!isElementVisible(el)) continue;

      const cs = getComputedStyle(el);
      const rawFg = parseColor(cs.color);
      if (!rawFg) {
        failures.push(`Unparseable foreground color "${cs.color}" on <${el.tagName.toLowerCase()}>`);
        continue;
      }
      const bg = effectiveBackground(el);
      const fg = rawFg.a < 1 ? composite(rawFg, bg) : rawFg;

      const fontSizePx = Number.parseFloat(cs.fontSize) || 16;
      const parsedWeight = Number.parseInt(cs.fontWeight, 10);
      const fontWeight = Number.isNaN(parsedWeight)
        ? cs.fontWeight === "bold"
          ? 700
          : 400
        : parsedWeight;
      const isLarge = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
      const required = isLarge ? 3.0 : 4.5;
      const ratio = contrastRatio(fg, bg);

      checkedNodes += 1;
      if (ratio < minRatio) {
        minRatio = ratio;
      }

      if (ratio < required) {
        const sample = text.length > 40 ? `${text.slice(0, 40)}...` : text;
        failures.push(
          `Low contrast ${ratio.toFixed(2)}:1 (required >= ${required}:1) on <${el.tagName.toLowerCase()}> "${sample}" (font ${fontSizePx}px weight ${fontWeight})`
        );
      }
    }

    for (const sel of document.querySelectorAll("select")) {
      if (!isElementVisible(sel)) continue;
      const cs = getComputedStyle(sel);
      const rawFg = parseColor(cs.color);
      if (!rawFg) continue;
      const bg = effectiveBackground(sel);
      const fg = rawFg.a < 1 ? composite(rawFg, bg) : rawFg;
      const fontSizePx = Number.parseFloat(cs.fontSize) || 16;
      const fontWeight = Number.parseInt(cs.fontWeight, 10) || 400;
      const isLarge = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
      const required = isLarge ? 3.0 : 4.5;
      const ratio = contrastRatio(fg, bg);
      checkedNodes += 1;
      if (ratio < minRatio) {
        minRatio = ratio;
      }
      if (ratio < required) {
        failures.push(
          `Low contrast ${ratio.toFixed(2)}:1 (required >= ${required}:1) on <select#${sel.id || ""}>`
        );
      }
    }

    return {
      checked_text_nodes: checkedNodes,
      min_ratio: Number.isFinite(minRatio) ? Math.round(minRatio * 100) / 100 : 0,
      failures,
    };
  });

  return {
    passed: result.failures.length === 0,
    checked_text_nodes: result.checked_text_nodes,
    min_ratio: result.min_ratio,
    failures: result.failures,
  };
}

/**
 * Row 8: Reflow at 320x640 (dpr 1) and 200% zoom (640x800, dpr 2).
 */
export async function checkReflowAndZoom(browser, pageUrl, attachNetworkGuard) {
  const viewports = [
    { name: "320x640@1x", viewport: { width: 320, height: 640 }, deviceScaleFactor: 1 },
    { name: "640x800@2x", viewport: { width: 640, height: 800 }, deviceScaleFactor: 2 },
  ];

  const failures = [];
  const results = [];

  for (const cfg of viewports) {
    const context = await browser.newContext({
      viewport: cfg.viewport,
      deviceScaleFactor: cfg.deviceScaleFactor,
    });
    await attachNetworkGuard(context);
    const page = await context.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: "load" });
      const metrics = await page.evaluate(() => {
        const docEl = document.documentElement;
        const scrollWidth = docEl.scrollWidth;
        const clientWidth = docEl.clientWidth;

        const clipped = [];
        for (const el of document.body.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const text = (el.textContent || "").trim();
          if (!text) continue;
          if (cs.overflowX === "hidden" || cs.overflow === "hidden") {
            const rect = el.getBoundingClientRect();
            const isVisuallyHiddenSrOnly =
              cs.position === "absolute" && rect.width <= 1 && rect.height <= 1;
            if (!isVisuallyHiddenSrOnly && el.scrollWidth > el.clientWidth) {
              clipped.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || "",
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
              });
            }
          }
        }

        return {
          scrollWidth,
          clientWidth,
          horizontalOverflow: scrollWidth > clientWidth,
          clipped,
        };
      });

      results.push({
        viewport: cfg.name,
        scroll_width: metrics.scrollWidth,
        client_width: metrics.clientWidth,
        horizontal_overflow: metrics.horizontalOverflow,
        clipped_count: metrics.clipped.length,
      });

      if (metrics.horizontalOverflow) {
        failures.push(
          `Horizontal overflow at ${cfg.name}: documentElement.scrollWidth (${metrics.scrollWidth}) > clientWidth (${metrics.clientWidth})`
        );
      }
      for (const item of metrics.clipped) {
        failures.push(
          `Clipped text at ${cfg.name} on <${item.tag}#${item.id}>: scrollWidth (${item.scrollWidth}) > clientWidth (${item.clientWidth}) with overflow: hidden`
        );
      }
    } finally {
      await context.close();
    }
  }

  return {
    passed: failures.length === 0,
    viewports: results,
    failures,
  };
}

/**
 * Row 9: prefers-reduced-motion: reduce -> animation-duration and transition-duration <= 0.01 ms.
 */
export async function checkReducedMotion(browser, pageUrl, attachNetworkGuard) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await attachNetworkGuard(context);
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: "load" });
    await page.emulateMedia({ reducedMotion: "reduce" });

    const result = await page.evaluate(() => {
      function parseDurationsMs(value) {
        if (!value) return [0];
        return value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            if (part.endsWith("ms")) {
              return Number.parseFloat(part.slice(0, -2)) || 0;
            }
            if (part.endsWith("s")) {
              return (Number.parseFloat(part.slice(0, -1)) || 0) * 1000;
            }
            return Number.parseFloat(part) || 0;
          });
      }

      const LIMIT_MS = 0.01 + 1e-6;
      const elements = document.querySelectorAll("*");
      const failures = [];
      let maxDurationMs = 0;

      for (const el of elements) {
        const cs = getComputedStyle(el);
        const animDurations = parseDurationsMs(cs.animationDuration);
        const transDurations = parseDurationsMs(cs.transitionDuration);
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";

        for (const ms of animDurations) {
          if (ms > maxDurationMs) maxDurationMs = ms;
          if (ms > LIMIT_MS) {
            failures.push(
              `Element <${tag}${id}> has animation-duration ${ms}ms (> 0.01ms) under prefers-reduced-motion: reduce`
            );
          }
        }
        for (const ms of transDurations) {
          if (ms > maxDurationMs) maxDurationMs = ms;
          if (ms > LIMIT_MS) {
            failures.push(
              `Element <${tag}${id}> has transition-duration ${ms}ms (> 0.01ms) under prefers-reduced-motion: reduce`
            );
          }
        }
      }

      return {
        checked_elements: elements.length,
        max_duration_ms: Math.round(maxDurationMs * 10000) / 10000,
        failures,
      };
    });

    return {
      passed: result.failures.length === 0,
      checked_elements: result.checked_elements,
      max_duration_ms: result.max_duration_ms,
      failures: result.failures,
    };
  } finally {
    await context.close();
  }
}

/**
 * Row 10: Calling announce() from web/v3/a11y.mjs in the real DOM writes exclusively
 * to the single live region and nowhere else.
 */
export async function checkLiveRegion(context, pageUrl, liveRegionModulePath) {
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "load" });

    const result = await page.evaluate(async (modulePath) => {
      const failures = [];
      let mod;
      try {
        mod = await import(modulePath);
      } catch (err) {
        return {
          passed: false,
          failures: [`Failed to import live region module "${modulePath}": ${err.message}`],
        };
      }

      if (typeof mod.announce !== "function") {
        return {
          passed: false,
          failures: [`Module "${modulePath}" does not export announce()`],
        };
      }

      const liveId = mod.LIVE_REGION_ID || "elo-live-region";
      const liveEl = document.getElementById(liveId);
      if (!liveEl) {
        return {
          passed: false,
          failures: [`Live region element #${liveId} not found in DOM`],
        };
      }

      const allLiveEls = document.querySelectorAll(
        '[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]'
      );
      if (allLiveEls.length !== 1 || allLiveEls[0] !== liveEl) {
        failures.push(
          `Expected exactly 1 live region element (#${liveId}), found ${allLiveEls.length}`
        );
      }

      const outsideMutations = [];
      let liveRegionMutations = 0;

      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          const target = rec.target;
          const insideLive = target === liveEl || liveEl.contains(target);
          if (insideLive) {
            liveRegionMutations += 1;
          } else {
            outsideMutations.push({
              type: rec.type,
              targetTag:
                target.nodeType === 1 ? target.tagName.toLowerCase() : `#node(${target.nodeType})`,
              targetId: target.nodeType === 1 ? target.id || "" : "",
            });
          }
        }
      });

      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });

      const cases = [
        { message: "Anuncio sintetico educado 01.", politeness: "polite" },
        { message: "Anuncio sintetico assertivo 02.", politeness: "assertive" },
        { message: "Anuncio sintetico assertivo 02.", politeness: "assertive" },
      ];

      for (const tc of cases) {
        mod.announce(tc.message, { politeness: tc.politeness });
        await Promise.resolve();

        if (liveEl.textContent !== tc.message) {
          failures.push(
            `Live region textContent mismatch after announce("${tc.message}"): got "${liveEl.textContent}"`
          );
        }
        if (liveEl.getAttribute("aria-live") !== tc.politeness) {
          failures.push(
            `Live region aria-live mismatch: expected "${tc.politeness}", got "${liveEl.getAttribute("aria-live")}"`
          );
        }
        if (liveEl.getAttribute("aria-atomic") !== "true") {
          failures.push(
            `Live region aria-atomic mismatch: expected "true", got "${liveEl.getAttribute("aria-atomic")}"`
          );
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let tn;
        while ((tn = walker.nextNode())) {
          if (liveEl.contains(tn)) continue;
          if ((tn.nodeValue || "").includes(tc.message)) {
            failures.push(
              `Announced text "${tc.message}" leaked outside #${liveId}`
            );
          }
        }
      }

      const pending = observer.takeRecords();
      observer.disconnect();
      for (const rec of pending) {
        const target = rec.target;
        const insideLive = target === liveEl || liveEl.contains(target);
        if (insideLive) {
          liveRegionMutations += 1;
        } else {
          outsideMutations.push({
            type: rec.type,
            targetTag:
              target.nodeType === 1 ? target.tagName.toLowerCase() : `#node(${target.nodeType})`,
            targetId: target.nodeType === 1 ? target.id || "" : "",
          });
        }
      }

      if (outsideMutations.length > 0) {
        failures.push(
          `announce() mutated ${outsideMutations.length} DOM node(s) outside #${liveId}`
        );
      }
      if (liveRegionMutations === 0) {
        failures.push(`announce() produced zero mutations on #${liveId}`);
      }

      return {
        passed: failures.length === 0,
        live_region_id: liveId,
        announcements_tested: cases.length,
        outside_mutations: outsideMutations.length,
        failures,
      };
    }, liveRegionModulePath);

    return result;
  } finally {
    await page.close();
  }
}
