(function (root) {
  "use strict";
  const OCR_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const NAME_MAP = Object.freeze({
    SKHY: "SK海力士", MU: "美光", MRVL: "邁威爾", COHR: "科赫特",
    TSM: "台積電ADR", AAPL: "蘋果", NVDA: "輝達", TSLA: "特斯拉",
    AMD: "超微", AVGO: "博通", AMZN: "亞馬遜", META: "Meta",
    MSFT: "微軟", GOOGL: "Alphabet", GOOG: "Alphabet", NFLX: "Netflix",
    ARM: "安謀", QCOM: "高通", INTC: "英特爾", SMCI: "美超微",
    ORCL: "甲骨文", PLTR: "Palantir", CRWD: "CrowdStrike"
  });
  function normalizeText(value) {
    return String(value || "").normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/[|｜]/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  function cleanNumber(value, fallback = "—") {
    const number = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(number) ? String(number) : fallback;
  }
  function sameLinePercent(lines, labels) {
    for (const line of lines) {
      for (const label of labels) {
        const labelMatch = line.match(label);
        if (!labelMatch) continue;
        const hit = line.slice(labelMatch.index + labelMatch[0].length).match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (hit) return cleanNumber(hit[1]);
      }
    }
    return null;
  }
  function allPercents(text) {
    return Array.from(text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g), (match) => cleanNumber(match[1]));
  }
  function allNumbers(text) {
    return Array.from(String(text || "").matchAll(/(?:^|\s)(\d{1,3}(?:[.,]\d{1,3})?)(?=\s|$|%|\()/g), (match) => cleanNumber(match[1].replace(",", ".")));
  }
  function markedTableRow(text, rowNumber) {
    const marker = `[[FCN_TABLE_ROW_${rowNumber}]]`;
    const start = text.indexOf(marker);
    if (start < 0) return "";
    const body = text.slice(start + marker.length);
    const next = body.search(/\[\[FCN_TABLE_ROW_\d+\]\]/);
    return (next >= 0 ? body.slice(0, next) : body).trim();
  }
  function percentFromRow(row, index, fallbackNumberIndex = index) {
    const percents = allPercents(row);
    if (percents[index] != null) return percents[index];
    const numbers = allNumbers(row);
    return numbers[fallbackNumberIndex] ?? null;
  }
  function tickerRows(text) {
    const rows = [], seen = new Set(), marketSuffixes = [];
    const aliases = { AAPI: "AAPL", APPL: "AAPL", NVOA: "NVDA", NV0A: "NVDA", T5LA: "TSLA", TSIA: "TSLA", T5M: "TSM" };
    const paired = /\b([A-Z][A-Z0-9.-]{1,8}?)[ .-]?(UN|UW|US|UQ|JT|JP|AT|HK)\b/gi;
    for (const match of text.matchAll(paired)) {
      const rawSymbol = match[1].toUpperCase().replace(/[^A-Z0-9.]/g, "");
      const symbol = aliases[rawSymbol] || rawSymbol;
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol); marketSuffixes.push(match[2].toUpperCase());
      rows.push({ symbol, name: NAME_MAP[symbol] || "" });
    }
    for (const [symbol, name] of Object.entries(NAME_MAP)) {
      if (seen.has(symbol) || !new RegExp(`\\b${symbol}\\b`, "i").test(text)) continue;
      seen.add(symbol); rows.push({ symbol, name });
    }
    return { rows: rows.slice(0, 8), marketSuffixes };
  }
  function parseProductOcrText(rawText) {
    const text = normalizeText(rawText), lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const flat = text.replace(/\n/g, " ");
    const taggedRow1 = markedTableRow(text, 1), taggedRow2 = markedTableRow(text, 2), taggedRow3 = markedTableRow(text, 3);
    const row1 = taggedRow1 || lines.find((line) => /\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\b/i.test(line) && tickerRows(line).rows.length >= 1) || "";
    const row2 = taggedRow2 || lines.find((line) => /\b(?:DAILY|MEMORY|PERIOD|EKI|AKI|NONE)\b/i.test(line) && /\d/.test(line)) || "";
    const row3 = taggedRow3 || lines.find((line) => /20\d{2}\s*SN\s*\d+/i.test(line)) || "";
    const codeMatch = `${row3} ${flat}`.match(/\b(?:MA\s*)?20\d{2}\s*SN\s*\d{2,6}\b/i);
    const code = codeMatch ? codeMatch[0].replace(/\s+/g, "").toUpperCase() : "";
    const structureSource = `${row1} ${flat}`;
    const structure = /STEP\s*DOWN\s*FCN|STEPDOWNFCN/i.test(structureSource) ? "Stepdown FCN" : /EXPRESS\s*FCN/i.test(structureSource) ? "Express FCN" : /\bDAC\b/i.test(structureSource) ? "DAC" : "FCN";
    const currencyMatch = `${row1} ${flat}`.match(/\b(USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\b/i);
    const currency = currencyMatch?.[1]?.toUpperCase() || "USD";
    const typeMatch = `${row2} ${flat}`.match(/\b(EKI|AKI|NONE)\b/i);
    const kiType = typeMatch ? typeMatch[1].toUpperCase().replace("NONE", "None") : "待確認";
    const row1Percents = allPercents(row1), row1Numbers = allNumbers(row1);
    const row1Financials = row1Percents.length >= 2 ? row1Percents : row1Numbers.slice(-3);
    const row2Numbers = allNumbers(row2);
    const row2KiMatch = row2.match(/\b(?:EKI|AKI)\b\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*%?/i);
    const strike = (taggedRow1 ? row1Financials[0] : null) || sameLinePercent(lines, [/執行價/, /Strike/i]) || row1Financials[0] || "—";
    const coupon = (taggedRow1 ? row1Financials[1] : null) || sameLinePercent(lines, [/年化配息/, /Coupon/i]) || row1Financials[1] || "—";
    const autocall = (taggedRow2 ? row2Numbers[0] : null) || sameLinePercent(lines, [/提前出場條件/, /提前出場/, /Auto.?call/i]) || percentFromRow(row2, 0, 0) || "—";
    const ki = kiType === "None" ? "0" : ((taggedRow2 ? (row2KiMatch ? cleanNumber(row2KiMatch[1]) : row2Numbers[2]) : null) || sameLinePercent(lines, [/觸及價格/, /觸發價格/, /\bKI\b/i]) || percentFromRow(row2, 1, 2) || "—");
    const tenorMatch = (taggedRow2 ? row2.match(/(?:^|\s)(\d{1,2})\s*\(?月\)?/i) : null)
      || flat.match(/產品天期[\s\S]{0,180}?(\d{1,2})\s*\/?\s*\(?月\)?/i)
      || flat.match(/(?:Tenor|期間)[^\d]{0,30}(\d{1,2})\s*(?:M|個?月)/i)
      || row2.match(/(?:^|\s)(\d{1,2})\s*\(?月\)?/i);
    const tenor = tenorMatch ? cleanNumber(tenorMatch[1]) : "—";
    const guaranteedMatch = row1.match(/\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\s+(\d{1,2})\b/i)
      || flat.match(/保證領息(?:期間)?\s*(?:\(月\))?\s*[:：]?\s*(\d{1,2})(?:\s*(?:個?月|\(月\)))?/i)
      || flat.match(/\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\s+(\d{1,2})\b/i);
    const guaranteed = guaranteedMatch ? cleanNumber(guaranteedMatch[1]) : "—";
    const pricingSource = `${row3} ${flat}`;
    const pricing = /開盤價/.test(pricingSource) ? "開盤價" : /收盤價/.test(pricingSource) ? "收盤價" : "待確認";
    const tickers = tickerRows(`${row1}\n${flat}`);
    const markets = new Set(tickers.marketSuffixes.map((suffix) => ["JT", "JP"].includes(suffix) ? "日股" : suffix === "AT" ? "澳股" : "美股"));
    const market = markets.size === 1 ? [...markets][0] : markets.size > 1 ? "跨市場" : "美股";
    const currencyNames = { USD: "美金", JPY: "日圓", AUD: "澳幣", TWD: "台幣", HKD: "港幣", EUR: "歐元", GBP: "英鎊", CHF: "瑞郎", CNH: "人民幣", CNY: "人民幣" };
    const missing = [];
    if (!code) missing.push("商品代號");
    if (!tickers.rows.length) missing.push("連結標的");
    if (strike === "—") missing.push("執行價");
    if (autocall === "—") missing.push("提前出場");
    if (tenor === "—") missing.push("期間");
    if (guaranteed === "—") missing.push("保證領息");
    if (coupon === "—") missing.push("年化配息率");
    if (kiType === "待確認") missing.push("觸及類型");
    if (pricing === "待確認") missing.push("期初定價");
    return { structure, currency, currencyName: currencyNames[currency] || currency, market, code, pricing, underlyings: tickers.rows, strike, ki, kiType, autocall, tenor, guaranteed, coupon, missing, rawText: text };
  }
  function formatProductOcrResult(parsed) {
    const underlyings = parsed.underlyings.length ? parsed.underlyings.map((item) => `${item.symbol}${item.name ? `  ${item.name}` : ""}`).join("\n") : "（請手動輸入）";
    const suffix = (value, unit) => value === "—" ? "—" : `${value}${unit}`;
    return `${parsed.structure} 條件(${parsed.currencyName}/${parsed.market})\n${parsed.code || "商品代號待補"}(${parsed.pricing})\n\n🔶連結標的：\n\n${underlyings}\n\n🔸執行價：${suffix(parsed.strike, "%")}\n🔸下限價：${suffix(parsed.ki, "%")}\n🔸觸及類型：${parsed.kiType}\n🔸提前出場：${suffix(parsed.autocall, "%")}\n🔸期間：${suffix(parsed.tenor, "個月")}\n🔸保證領息：${suffix(parsed.guaranteed, "個月")}\n🔸年化配息率：${suffix(parsed.coupon, "%")}`;
  }
  function loadOcrLibrary() {
    if (root.Tesseract?.createWorker) return Promise.resolve(root.Tesseract);
    if (root.__fcnOcrLibraryPromise) return root.__fcnOcrLibraryPromise;
    root.__fcnOcrLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = OCR_SCRIPT; script.async = true; script.crossOrigin = "anonymous";
      script.onload = () => root.Tesseract?.createWorker ? resolve(root.Tesseract) : reject(new Error("OCR library unavailable"));
      script.onerror = () => reject(new Error("OCR library failed to load"));
      document.head.appendChild(script);
    }).catch((error) => { delete root.__fcnOcrLibraryPromise; throw error; });
    return root.__fcnOcrLibraryPromise;
  }
  async function imageSource(file) {
    if (typeof createImageBitmap === "function") return createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image unreadable")); };
      image.src = url;
    });
  }
  async function prepareImage(file) {
    const source = await imageSource(file);
    const naturalWidth = source.width || source.naturalWidth, naturalHeight = source.height || source.naturalHeight;
    const scale = Math.min(1.8, 2400 / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale)); canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height); source.close?.();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height), data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114;
      const value = Math.max(0, Math.min(255, (gray - 128) * 1.22 + 128));
      data[index] = data[index + 1] = data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }
  function binarizeCanvas(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height), histogram = new Array(256).fill(0);
    for (let index = 0; index < pixels.data.length; index += 4) histogram[pixels.data[index]] += 1;
    const total = canvas.width * canvas.height;
    let sum = 0, backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, threshold = 185;
    for (let level = 0; level < 256; level += 1) sum += level * histogram[level];
    for (let level = 0; level < 256; level += 1) {
      backgroundWeight += histogram[level];
      if (!backgroundWeight) continue;
      const foregroundWeight = total - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += level * histogram[level];
      const meanBackground = backgroundSum / backgroundWeight;
      const meanForeground = (sum - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) { bestVariance = variance; threshold = level; }
    }
    threshold = Math.max(145, Math.min(215, threshold + 12));
    for (let index = 0; index < pixels.data.length; index += 4) {
      const value = pixels.data[index] < threshold ? 0 : 255;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }
  function extractTableRows(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas, pixels = context.getImageData(0, 0, width, height).data;
    const left = Math.floor(width * .055), right = Math.ceil(width * .945), startY = Math.floor(height * .16), endY = Math.floor(height * .88);
    const bands = [];
    let bandStart = -1, lastDark = -1;
    const finishBand = () => {
      if (bandStart >= 0 && lastDark - bandStart + 1 >= height * .025) bands.push({ start: bandStart, end: lastDark });
      bandStart = -1; lastDark = -1;
    };
    for (let y = startY; y < endY; y += 1) {
      let dark = 0, sampled = 0;
      for (let x = left; x < right; x += 4) { sampled += 1; if (pixels[(y * width + x) * 4] < 92) dark += 1; }
      if (dark / sampled > .42) {
        if (bandStart < 0) bandStart = y;
        lastDark = y;
      } else if (bandStart >= 0 && y - lastDark > Math.max(3, Math.round(height * .004))) finishBand();
    }
    finishBand();
    if (bands.length < 3) return [];
    const headers = bands.slice(0, 3);
    const lightGaps = [headers[1].start - headers[0].end, headers[2].start - headers[1].end].filter((gap) => gap > 0);
    const lastRowHeight = Math.round((lightGaps.reduce((sumValue, gap) => sumValue + gap, 0) / Math.max(1, lightGaps.length)) * .9);
    return headers.map((header, index) => {
      const cropTop = Math.min(height - 1, header.end + 2);
      const cropBottom = index < headers.length - 1 ? headers[index + 1].start - 2 : Math.min(Math.floor(height * .92), cropTop + lastRowHeight);
      const cropWidth = right - left, cropHeight = Math.max(1, cropBottom - cropTop);
      const scale = Math.min(1.65, 3000 / cropWidth);
      const rowCanvas = document.createElement("canvas");
      rowCanvas.width = Math.max(1, Math.round(cropWidth * scale)); rowCanvas.height = Math.max(1, Math.round(cropHeight * scale));
      const rowContext = rowCanvas.getContext("2d", { willReadFrequently: true });
      rowContext.fillStyle = "#fff"; rowContext.fillRect(0, 0, rowCanvas.width, rowCanvas.height);
      rowContext.drawImage(canvas, left, cropTop, cropWidth, cropHeight, 0, 0, rowCanvas.width, rowCanvas.height);
      return binarizeCanvas(rowCanvas);
    });
  }
  async function recognizeProductImage(file, onProgress = () => {}, signal) {
    if (!file || !/^image\//.test(file.type || "")) throw new Error("請選擇圖片檔");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress({ label: "整理圖片", percent: 0.03 });
    const image = await prepareImage(file), tableRows = extractTableRows(image), passCount = 1 + tableRows.length;
    const Tesseract = await loadOcrLibrary();
    let worker;
    let passIndex = 0;
    const abort = () => { worker?.terminate().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      worker = await Tesseract.createWorker(["eng", "chi_tra"], 1, { logger(message) {
        const percent = Number.isFinite(message.progress) ? message.progress : 0;
        const label = message.status === "recognizing text" ? "辨識文字" : message.status?.includes("loading") ? "載入辨識工具" : "準備辨識";
        onProgress({ label, percent: message.status === "recognizing text" ? (passIndex + percent) / passCount : Math.min(.08, percent * .08) });
      } });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await worker.recognize(image);
      let combinedText = result?.data?.text || "";
      for (let index = 0; index < tableRows.length; index += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        passIndex = index + 1;
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        const rowResult = await worker.recognize(tableRows[index]);
        combinedText += `\n[[FCN_TABLE_ROW_${index + 1}]]\n${rowResult?.data?.text || ""}`;
      }
      const parsed = parseProductOcrText(combinedText);
      return { parsed, formatted: formatProductOcrResult(parsed) };
    } finally { signal?.removeEventListener("abort", abort); if (worker) await worker.terminate().catch(() => {}); }
  }
  root.FcnProductOcr = { normalizeText, parseProductOcrText, formatProductOcrResult, recognizeProductImage };
})(globalThis);
