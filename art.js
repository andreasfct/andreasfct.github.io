(() => {
  "use strict";

  const canvas = document.querySelector("#pixel-field");
  const textCanvas = document.querySelector("#text-field");
  const context = canvas?.getContext("2d", { alpha: false, desynchronized: true });
  const textContext = textCanvas?.getContext("2d", { alpha: true, desynchronized: true });

  if (!context) return;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const fract = value => value - Math.floor(value);
  const lerp = (a, b, amount) => a + (b - a) * amount;
  const smoothstep = (edgeA, edgeB, value) => {
    const amount = clamp((value - edgeA) / (edgeB - edgeA));
    return amount * amount * (3 - 2 * amount);
  };
  const linger = (value, power = 2) => {
    const amount = clamp(value);
    return amount < .5
      ? .5 * Math.pow(amount * 2, power)
      : 1 - .5 * Math.pow((1 - amount) * 2, power);
  };
  const rgba = (red, green, blue) => (
    (255 << 24) | (blue << 16) | (green << 8) | red
  ) >>> 0;

  const CHARCOAL = rgba(24, 19, 21);
  const MAROON = rgba(47, 13, 26);
  const BONE = rgba(246, 238, 232);
  const COBALT = rgba(168, 184, 248);
  const ULTRAVIOLET = rgba(199, 175, 242);
  const MAGENTA = rgba(239, 175, 196);
  const VERMILION = rgba(242, 170, 157);
  const CITRON = rgba(238, 219, 166);
  const CYAN = rgba(169, 221, 206);
  const DIM_COBALT = rgba(71, 60, 84);
  const DIM_MAGENTA = rgba(112, 64, 79);
  const MASK_ON = 0xffffffff;

  const CAPILLARY_COLORS = [COBALT, COBALT, ULTRAVIOLET, MAGENTA];
  const INVERSION_COLORS = [VERMILION, MAGENTA, CITRON, VERMILION];
  const COUNTERBLOOM_COLORS = [COBALT, ULTRAVIOLET, CYAN, CITRON];

  const DIRECTIONS = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2]
  ];

  let width = 0;
  let height = 0;
  let count = 0;
  let image;
  let pixels;
  let permeability;
  let rank;
  let tone;
  let capillaryMap;
  let inversionMap;
  let counterbloomMap;
  let progress = 0;
  let scrollVelocity = 0;
  let previousScrollY = scrollY;
  let previousFrame = 0;
  let animationFrame = 0;
  let idleTimer = 0;
  let resizeTimer;
  let dirty = true;
  let textScale = 1;
  let textCssWidth = 0;
  let textCssHeight = 0;
  let fontsReady = false;
  let textPagesReady = false;
  let textDirty = true;
  const pageCanvases = Array.from({ length: 3 }, () => document.createElement("canvas"));
  const pageContexts = pageCanvases.map(page => page.getContext("2d"));
  const maskCanvases = Array.from({ length: 3 }, () => document.createElement("canvas"));
  const maskContexts = maskCanvases.map(mask => mask.getContext("2d"));
  const maskImages = new Array(3);
  const maskPixels = new Array(3);
  const maskedPage = document.createElement("canvas");
  const maskedPageContext = maskedPage.getContext("2d");

  function hash01(x, y, seed = 0) {
    let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(y + seed, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function noise2(x, y, seed) {
    const integerX = Math.floor(x);
    const integerY = Math.floor(y);
    const fractionX = x - integerX;
    const fractionY = y - integerY;
    const easedX = fractionX * fractionX * (3 - 2 * fractionX);
    const easedY = fractionY * fractionY * (3 - 2 * fractionY);
    const top = lerp(
      hash01(integerX, integerY, seed),
      hash01(integerX + 1, integerY, seed),
      easedX
    );
    const bottom = lerp(
      hash01(integerX, integerY + 1, seed),
      hash01(integerX + 1, integerY + 1, seed),
      easedX
    );
    return lerp(top, bottom, easedY);
  }

  function fbm(x, y, seed) {
    let value = 0;
    let amplitude = .55;
    let frequency = 1;
    let normalizer = 0;

    for (let octave = 0; octave < 4; octave += 1) {
      value += noise2(x * frequency, y * frequency, seed + octave * 101) * amplitude;
      normalizer += amplitude;
      frequency *= 2.03;
      amplitude *= .49;
    }

    return value / normalizer;
  }

  function setTextStyle(target, source, color) {
    const style = getComputedStyle(source);
    target.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    target.fillStyle = color;
    target.textAlign = "left";
    target.textBaseline = "top";
    target.direction = style.direction;
    if ("letterSpacing" in target) {
      target.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    }
    return style;
  }

  function wrapText(target, text, maximumWidth, forceWordBreaks = false) {
    const words = text.trim().split(/\s+/);
    if (forceWordBreaks) return words;
    const lines = [];
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && target.measureText(candidate).width > maximumWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }

    if (line) lines.push(line);
    return lines;
  }

  function drawTextElement(target, element, color) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    target.save();
    const style = setTextStyle(target, element, color);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const forceWordBreaks = element.tagName === "H1" && rect.height > lineHeight * 1.5;
    const lines = wrapText(target, element.textContent, rect.width + .5, forceWordBreaks);
    let y = rect.top;

    for (const line of lines) {
      target.fillText(line, rect.left, y);
      y += lineHeight;
    }
    target.restore();
  }

  function applyComputedTextStyle(target, style, color, fontSize = style.fontSize) {
    const size = typeof fontSize === "number" ? `${fontSize}px` : fontSize;
    target.font = `${style.fontStyle} ${style.fontWeight} ${size} ${style.fontFamily}`;
    target.fillStyle = color;
    target.textAlign = "left";
    target.direction = style.direction;
    if ("letterSpacing" in target) {
      target.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    }
  }

  function drawSecondPage(target) {
    const titleElement = document.querySelector(".effect-copy__side-title");
    const bodyElement = document.querySelector(".effect-copy__side-body");
    if (!titleElement || !bodyElement) return;

    const titleText = titleElement.textContent.trim();
    const bodyText = bodyElement.textContent.trim();
    const titleStyle = getComputedStyle(titleElement);
    const bodyStyle = getComputedStyle(bodyElement);
    const metric = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const compact = textCssWidth < 480;
    const columnHeight = Math.min(textCssHeight * (compact ? .56 : .58), 650);
    const top = (textCssHeight - columnHeight) * .5;
    const edge = Math.max(16, Math.min(58, textCssWidth * .038));
    const right = textCssWidth - edge;

    target.save();

    // Size the visible letterforms—not their line box—to the exact column height.
    let titleSize = 100;
    applyComputedTextStyle(target, titleStyle, "#f6eee8", titleSize);
    let titleMetrics = target.measureText(titleText);
    let titleSpan = titleMetrics.actualBoundingBoxLeft + titleMetrics.actualBoundingBoxRight;
    if (!titleSpan) titleSpan = titleMetrics.width;
    titleSize *= columnHeight / titleSpan;

    applyComputedTextStyle(target, titleStyle, "#f6eee8", titleSize);
    titleMetrics = target.measureText(titleText);
    titleSpan = titleMetrics.actualBoundingBoxLeft + titleMetrics.actualBoundingBoxRight;
    if (titleSpan) {
      titleSize *= columnHeight / titleSpan;
      applyComputedTextStyle(target, titleStyle, "#f6eee8", titleSize);
      titleMetrics = target.measureText(titleText);
    }

    const titleAscent = metric(titleMetrics.actualBoundingBoxAscent, titleSize * .72);
    const titleDescent = metric(titleMetrics.actualBoundingBoxDescent, titleSize * .18);
    const titleLeft = right - titleAscent - titleDescent;
    const titleAnchorX = right - titleAscent;
    const titleAnchorY = top + metric(titleMetrics.actualBoundingBoxLeft, 0);

    target.save();
    target.translate(titleAnchorX, titleAnchorY);
    target.rotate(Math.PI * .5);
    target.textBaseline = "alphabetic";
    target.fillText(titleText, 0, 0);
    target.restore();

    // Find a paragraph width whose natural leading almost exactly fills the title.
    applyComputedTextStyle(target, bodyStyle, "#f6eee8");
    target.textBaseline = "alphabetic";
    const bodyFontSize = parseFloat(bodyStyle.fontSize);
    const naturalLineHeight = parseFloat(bodyStyle.lineHeight) || bodyFontSize * 1.55;
    const gap = Math.max(2, Math.min(5, textCssWidth * .003));
    const bodyRight = titleLeft - gap;
    const leftEdge = Math.max(16, textCssWidth * .025);
    const availableWidth = Math.max(48, bodyRight - leftEdge);
    const minimumWidth = Math.min(availableWidth, compact ? 112 : 150);
    const maximumWidth = Math.max(
      minimumWidth,
      Math.min(availableWidth, compact ? 200 : Math.min(340, textCssWidth * .25))
    );
    let bestWidth = minimumWidth;
    let bestLines = wrapText(target, bodyText, minimumWidth);
    let bestScore = Infinity;

    for (let width = minimumWidth; width <= maximumWidth; width += 1) {
      const lines = wrapText(target, bodyText, width);
      if (lines.length < 2) continue;
      const firstMetrics = target.measureText(lines[0]);
      const lastMetrics = target.measureText(lines[lines.length - 1]);
      const firstAscent = metric(firstMetrics.actualBoundingBoxAscent, bodyFontSize * .75);
      const lastDescent = metric(lastMetrics.actualBoundingBoxDescent, bodyFontSize * .2);
      const lineStep = (columnHeight - firstAscent - lastDescent) / (lines.length - 1);
      const compressedPenalty = Math.max(0, naturalLineHeight * .9 - lineStep) * 5;
      const score = Math.abs(lineStep - naturalLineHeight) + compressedPenalty;

      if (score < bestScore || (Math.abs(score - bestScore) < .001 && width > bestWidth)) {
        bestScore = score;
        bestWidth = width;
        bestLines = lines;
      }
    }

    const firstMetrics = target.measureText(bestLines[0]);
    const lastMetrics = target.measureText(bestLines[bestLines.length - 1]);
    const firstAscent = metric(firstMetrics.actualBoundingBoxAscent, bodyFontSize * .75);
    const lastDescent = metric(lastMetrics.actualBoundingBoxDescent, bodyFontSize * .2);
    const lineStep = bestLines.length > 1
      ? (columnHeight - firstAscent - lastDescent) / (bestLines.length - 1)
      : 0;
    const bodyLeft = bodyRight - bestWidth;
    let baseline = top + firstAscent;

    for (const line of bestLines) {
      target.fillText(line, bodyLeft, baseline);
      baseline += lineStep;
    }

    target.restore();
  }

  function rebuildTextPages() {
    if (!textContext || !fontsReady || !textCssWidth || !textCssHeight) return;

    for (const pageContext of pageContexts) {
      pageContext.setTransform(textScale, 0, 0, textScale, 0, 0);
      pageContext.clearRect(0, 0, textCssWidth, textCssHeight);
    }

    drawTextElement(pageContexts[0], document.querySelector(".hero__content h1"), "#f6eee8");
    for (const paragraph of document.querySelectorAll(".hero__copy p")) {
      drawTextElement(pageContexts[0], paragraph, "#f6eee8");
    }

    drawSecondPage(pageContexts[1]);

    for (const paragraph of document.querySelectorAll(".effect-copy--third p")) {
      drawTextElement(pageContexts[2], paragraph, "#2f0d1a");
    }

    textPagesReady = true;
    textDirty = true;
    dirty = true;
    requestRender();
  }

  function setupTextSystem(cssWidth, cssHeight) {
    if (
      !textContext ||
      pageContexts.some(target => !target) ||
      maskContexts.some(target => !target) ||
      !maskedPageContext
    ) return;
    textCssWidth = cssWidth;
    textCssHeight = cssHeight;
    textScale = Math.min(Math.max(devicePixelRatio || 1, 1), 1.5);
    const pixelWidth = Math.round(cssWidth * textScale);
    const pixelHeight = Math.round(cssHeight * textScale);

    textCanvas.width = pixelWidth;
    textCanvas.height = pixelHeight;
    maskedPage.width = pixelWidth;
    maskedPage.height = pixelHeight;

    for (let page = 0; page < 3; page += 1) {
      pageCanvases[page].width = pixelWidth;
      pageCanvases[page].height = pixelHeight;
      maskCanvases[page].width = width;
      maskCanvases[page].height = height;
      maskImages[page] = maskContexts[page].createImageData(width, height);
      maskPixels[page] = new Uint32Array(maskImages[page].data.buffer);
    }

    textPagesReady = false;
    if (fontsReady) rebuildTextPages();
  }

  function compositeTextPages() {
    if (!textPagesReady || !textContext) return;

    for (let page = 0; page < 3; page += 1) {
      maskContexts[page].putImageData(maskImages[page], 0, 0);
    }

    textContext.setTransform(1, 0, 0, 1, 0, 0);
    textContext.clearRect(0, 0, textCanvas.width, textCanvas.height);

    for (let page = 0; page < 3; page += 1) {
      maskedPageContext.setTransform(1, 0, 0, 1, 0, 0);
      maskedPageContext.globalCompositeOperation = "source-over";
      maskedPageContext.clearRect(0, 0, maskedPage.width, maskedPage.height);
      maskedPageContext.drawImage(pageCanvases[page], 0, 0);
      maskedPageContext.globalCompositeOperation = "destination-in";
      maskedPageContext.imageSmoothingEnabled = false;
      maskedPageContext.drawImage(
        maskCanvases[page],
        0,
        0,
        width,
        height,
        0,
        0,
        maskedPage.width,
        maskedPage.height
      );
      maskedPageContext.globalCompositeOperation = "source-over";
      textContext.drawImage(maskedPage, 0, 0);
    }
  }

  class MinHeap {
    constructor() {
      this.nodes = [];
      this.costs = [];
      this.lastCost = 0;
    }

    get size() {
      return this.nodes.length;
    }

    push(node, cost) {
      let index = this.nodes.length;
      this.nodes.push(node);
      this.costs.push(cost);

      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (this.costs[parent] <= cost) break;
        this.nodes[index] = this.nodes[parent];
        this.costs[index] = this.costs[parent];
        index = parent;
      }

      this.nodes[index] = node;
      this.costs[index] = cost;
    }

    pop() {
      const node = this.nodes[0];
      this.lastCost = this.costs[0];
      const tailNode = this.nodes.pop();
      const tailCost = this.costs.pop();

      if (this.nodes.length > 0) {
        let index = 0;
        const length = this.nodes.length;

        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          if (left >= length) break;
          const child = right < length && this.costs[right] < this.costs[left] ? right : left;
          if (this.costs[child] >= tailCost) break;
          this.nodes[index] = this.nodes[child];
          this.costs[index] = this.costs[child];
          index = child;
        }

        this.nodes[index] = tailNode;
        this.costs[index] = tailCost;
      }

      return node;
    }
  }

  function buildArrival(seeds, biasX = 0, biasY = 0, tailCeiling = 1) {
    const distance = new Float64Array(count);
    distance.fill(Infinity);
    const heap = new MinHeap();

    for (const seed of seeds) {
      if (distance[seed] === 0) continue;
      distance[seed] = 0;
      heap.push(seed, 0);
    }

    while (heap.size) {
      const index = heap.pop();
      const currentDistance = heap.lastCost;
      if (currentDistance !== distance[index]) continue;
      const x = index % width;
      const y = (index / width) | 0;

      for (const [offsetX, offsetY, step] of DIRECTIONS) {
        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const nextIndex = nextY * width + nextX;
        const resistance = 1 - (permeability[index] + permeability[nextIndex]) * .5;
        const materialCost = .32 + 6.2 * resistance * resistance * resistance;
        const directionalCost = clamp(1 + offsetX * biasX + offsetY * biasY, .52, 1.5);
        const nextDistance = currentDistance + materialCost * step * directionalCost;

        if (nextDistance >= distance[nextIndex]) continue;
        distance[nextIndex] = nextDistance;
        heap.push(nextIndex, nextDistance);
      }
    }

    const orderedDistances = distance.slice();
    orderedDistances.sort();
    const scale = Math.max(1, orderedDistances[Math.floor((count - 1) * .985)]);
    const maximumNormalized = orderedDistances[count - 1] / scale;
    const arrival = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const normalized = distance[index] / scale;
      if (normalized <= 1) {
        arrival[index] = normalized * .985;
      } else if (tailCeiling > 1 && maximumNormalized > 1) {
        const tailProgress = (normalized - 1) / (maximumNormalized - 1);
        arrival[index] = .985 + (tailCeiling - .985) * tailProgress;
      } else {
        arrival[index] = .985 + .015 * (1 - Math.exp(-(normalized - 1) * 3));
      }
    }
    return arrival;
  }

  function createSeeds() {
    const capillary = [];
    const inversion = [];
    const counterbloom = [];
    const verticalStep = Math.max(4, Math.floor(height / 25));
    const horizontalStep = Math.max(4, Math.floor(width / 28));

    for (let y = 1; y < height; y += verticalStep) {
      if (hash01(width, y, 411) > .18) capillary.push(y * width + width - 1);
    }
    for (let x = Math.floor(width * .38); x < width; x += horizontalStep) {
      if (hash01(x, height, 419) > .2) capillary.push((height - 1) * width + x);
    }
    capillary.push(((height * .72) | 0) * width + width - 1);

    for (let y = 0; y < height; y += 2) {
      const normalizedY = y / Math.max(1, height - 1);
      const faultNoise = noise2(y * .061, 9.7, 733) - .5;
      const x = clamp(
        Math.round(width * (.92 - normalizedY * .76 + faultNoise * .11)),
        0,
        width - 1
      );
      inversion.push(y * width + x);
    }

    const nucleusX = clamp(Math.round(width * .54), 0, width - 1);
    const nucleusY = clamp(Math.round(height * .53), 0, height - 1);
    counterbloom.push(nucleusY * width + nucleusX);

    return { capillary, inversion, counterbloom };
  }

  function rebuild() {
    const cssWidth = Math.max(1, canvas.clientWidth || innerWidth);
    const cssHeight = Math.max(1, canvas.clientHeight || innerHeight);
    const baseCellSize = cssWidth < 600 ? 3 : 4;
    const cellSize = Math.max(baseCellSize, cssWidth / 480, cssHeight / 300);
    width = Math.ceil(cssWidth / cellSize);
    height = Math.ceil(cssHeight / cellSize);
    count = width * height;
    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#181315";
    context.fillRect(0, 0, width, height);

    image = context.createImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
    permeability = new Float32Array(count);
    rank = new Float32Array(count);
    tone = new Uint8Array(count);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const broad = fbm(x * .036, y * .036, 61);
        const fibers = fbm(x * .106, y * .047, 173);
        const ridge = 1 - Math.abs(fibers * 2 - 1);
        permeability[index] = clamp(.06 + broad * .7 + ridge * .27);
        rank[index] = fract(
          (x + .5) * .754877666 + (y + .5) * .569840296 + hash01(x, y, 271) * .19
        );
        tone[index] = Math.floor(hash01(x, y, 929) * 255);
      }
    }

    const seeds = createSeeds();
    capillaryMap = buildArrival(seeds.capillary, .18, .04, 1.16);
    inversionMap = buildArrival(seeds.inversion);
    counterbloomMap = buildArrival(seeds.counterbloom, .025, -.015);
    setupTextSystem(cssWidth, cssHeight);
    dirty = true;
  }

  function capillaryColor(index, local, wobble, motion) {
    const age = .012 + local * 1.18 + wobble - capillaryMap[index];
    const frontier = .018 + (1 - local) * .023 + motion * .05;

    if (Math.abs(age) < frontier && rank[index] > .1) {
      return CAPILLARY_COLORS[(tone[index] >> 6) & 3];
    }
    if (
      age > frontier &&
      age < frontier + .075 &&
      permeability[index] > .7 &&
      rank[index] > .955 - local * .025
    ) {
      return tone[index] & 1 ? DIM_COBALT : DIM_MAGENTA;
    }
    if (age < -frontier && permeability[index] > .84 && rank[index] > .994) {
      return tone[index] & 1 ? COBALT : ULTRAVIOLET;
    }
    return age > frontier ? MAROON : CHARCOAL;
  }

  function inversionColor(index, local, wobble, motion, bloomPosition, bloomActive) {
    const outerAge = -.05 + local * 1.12 + wobble - inversionMap[index];
    const innerAge = bloomPosition + wobble * .7 - counterbloomMap[index];
    const outerFlip = smoothstep(-.026, .026, outerAge);
    const innerFlip = bloomActive ? smoothstep(-.026, .026, innerAge) : 0;
    let monochrome = rank[index] < outerFlip ? BONE : MAROON;
    const frontier = .025 + motion * .07;

    if (rank[index] < innerFlip) monochrome = MAROON;
    if (bloomActive && Math.abs(innerAge) < frontier * .9 && rank[index] > .08) {
      return COUNTERBLOOM_COLORS[(tone[index] >> 6) & 3];
    }
    if (Math.abs(outerAge) < frontier && rank[index] > .08) {
      return INVERSION_COLORS[(tone[index] >> 6) & 3];
    }
    return monochrome;
  }

  function counterbloomColor(index, bloomPosition, wobble, motion) {
    const age = bloomPosition + wobble * .8 - counterbloomMap[index];
    const flip = smoothstep(-.026, .026, age);
    const monochrome = rank[index] < flip ? MAROON : BONE;
    const frontier = .027 + motion * .065;

    if (Math.abs(age) < frontier && rank[index] > .08) {
      return COUNTERBLOOM_COLORS[(tone[index] >> 6) & 3];
    }
    if (
      age > frontier &&
      age < frontier + .065 &&
      permeability[index] > .68 &&
      rank[index] > .965
    ) {
      return tone[index] & 1 ? DIM_COBALT : DIM_MAGENTA;
    }
    return monochrome;
  }

  function sceneFor(value) {
    if (value < .2) return [0, 0, 0];
    if (value < .44) return [0, 1, linger(smoothstep(.2, .44, value), 1.75)];
    if (value < .52) return [1, 1, 0];
    if (value < .7) return [1, 2, linger(smoothstep(.52, .7, value), 1.75)];
    return [2, 2, 0];
  }

  function colorFor(mode, index, locals, wobble, motion, bloomPosition, bloomActive) {
    if (mode === 0) return capillaryColor(index, locals[0], wobble, motion);
    if (mode === 1) {
      return inversionColor(
        index,
        locals[1],
        wobble,
        motion,
        bloomPosition,
        bloomActive
      );
    }
    return counterbloomColor(index, bloomPosition, wobble, motion);
  }

  function render(time) {
    if (!pixels || !capillaryMap) return;
    const scene = sceneFor(progress);
    const locals = [
      linger(progress / .4, 2.1),
      linger((progress - .2) / .5, 2)
    ];
    const bloomProgress = linger((progress - .37) / .63, 2);
    const bloomActive = progress > .37;
    const bloomPosition = .02 + bloomProgress * 1.03;
    const motion = Math.min(.12, Math.abs(scrollVelocity));
    const wobble = reducedMotion.matches ? 0 : Math.sin(time * .00019) * .004;
    const capillaryPosition = .012 + locals[0] * 1.18;
    const inversionPosition = -.05 + locals[1] * 1.12;
    const shouldRenderText = textPagesReady && (dirty || textDirty);
    const transitionThreshold = lerp(-.08, 1.08, scene[2]);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const transitionRank = (1 - permeability[index]) * .72 + rank[index] * .28;
        const mode = scene[0] !== scene[1] && transitionRank < transitionThreshold
          ? scene[1]
          : scene[0];
        let color = colorFor(
          mode,
          index,
          locals,
          wobble,
          motion,
          bloomPosition,
          bloomActive
        );
        if (scene[0] === 0 && scene[1] === 1) {
          const capillary = capillaryColor(index, locals[0], wobble, motion);
          if (capillary !== CHARCOAL && capillary !== MAROON) color = capillary;
        }
        pixels[index] = color;

        if (shouldRenderText) {
          const capillaryCoverage = smoothstep(
            -.026,
            .026,
            capillaryPosition - capillaryMap[index]
          );
          const capillaryCovered = rank[index] < capillaryCoverage;
          const inversionCoverage = smoothstep(
            -.026,
            .026,
            inversionPosition - inversionMap[index]
          );
          const inversionCovered = capillaryCovered && rank[index] < inversionCoverage;
          const bloomCoverage = bloomActive
            ? smoothstep(-.026, .026, bloomPosition - counterbloomMap[index])
            : 0;
          const bloomCovered = inversionCovered && rank[index] < bloomCoverage;

          maskPixels[0][index] = capillaryCovered ? 0 : MASK_ON;
          maskPixels[1][index] = capillaryCovered && !inversionCovered ? MASK_ON : 0;
          maskPixels[2][index] = inversionCovered && !bloomCovered ? MASK_ON : 0;
        }
      }
    }

    context.putImageData(image, 0, 0);
    if (shouldRenderText) {
      compositeTextPages();
      textDirty = false;
    }
    dirty = false;
  }

  function updateScroll() {
    const y = scrollY;
    const maximum = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const delta = (y - previousScrollY) / Math.max(1, innerHeight);
    scrollVelocity = clamp(scrollVelocity * .48 + delta * .52, -.12, .12);
    previousScrollY = y;
    progress = clamp(y / maximum);
    dirty = true;
    requestRender();
  }

  function requestRender() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(frame);
  }

  function frame(time) {
    animationFrame = 0;
    clearTimeout(idleTimer);
    idleTimer = 0;
    const elapsed = previousFrame ? Math.min(250, time - previousFrame) : 16;
    scrollVelocity *= Math.exp(-elapsed / 180);
    previousFrame = time;

    if (document.hidden) return;
    if (dirty || !reducedMotion.matches) {
      render(time);
    }

    if (reducedMotion.matches) return;
    if (Math.abs(scrollVelocity) > .0005) {
      animationFrame = requestAnimationFrame(frame);
    } else {
      idleTimer = setTimeout(requestRender, 110);
    }
  }

  addEventListener("scroll", updateScroll, { passive: true });
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      rebuild();
      updateScroll();
    }, 140);
  }, { passive: true });
  reducedMotion.addEventListener?.("change", () => {
    dirty = true;
    requestRender();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestRender();
  });

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      fontsReady = true;
      rebuildTextPages();
    });
  } else {
    fontsReady = true;
  }

  setTimeout(() => {
    rebuild();
    updateScroll();
  }, 32);
})();
