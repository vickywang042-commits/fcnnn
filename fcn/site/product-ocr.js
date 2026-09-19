(function (root) {
  "use strict";
  const OCR_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const NAME_MAP = Object.freeze({
    SKHY: "SK海力士", MU: "美光", MRVL: "邁威爾", COHR: "科赫特",
    TSM: "台積電", AAPL: "蘋果", NVDA: "輝達", TSLA: "特斯拉",
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
  function tickerRows(text) {
    const rows = [], seen = new Set(), marketSuffixes = [];
    const paired = /\b([A-Z][A-Z0-9.-]{1,8}?)[ .-]?(UN|UW|US|UQ|JT|JP|AT|HK)\b/gi;
    for (const match of text.matchAll(paired)) {
      const symbol = match[1].toUpperCase().replace(/[^A-Z0-9.]/g, "");
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
    const codeMatch = flat.match(/\b(?:MA\s*)?20\d{2}\s*SN\s*\d{2,6}\b/i);
    const code = codeMatch ? codeMatch[0].replace(/\s+/g, "").toUpperCase() : "";
    const structure = /STEP\s*DOWN\s*FCN|STEPDOWNFCN/i.test(flat) ? "Stepdown FCN" : /EXPRESS\s*FCN/i.test(flat) ? "Express FCN" : /\bDAC\b/i.test(flat) ? "DAC" : "FCN";
    const currencyMatch = flat.match(/\b(USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\b/i);
    const currency = currencyMatch?.[1]?.toUpperCase() || "USD";
    const typeMatch = flat.match(/\b(EKI|AKI|NONE)\b/i);
    const kiType = typeMatch ? typeMatch[1].toUpperCase().replace("NONE", "None") : "None";
    const pct = allPercents(text);
    const strike = sameLinePercent(lines, [/執行價/, /Strike/i]) || pct[0] || "—";
    const coupon = sameLinePercent(lines, [/年化配息/, /Coupon/i]) || pct[1] || "—";
    const autocall = sameLinePercent(lines, [/提前出場條件/, /提前出場/, /Auto.?call/i]) || pct[3] || pct.at(-1) || "—";
    const ki = kiType === "None" ? "0" : (sameLinePercent(lines, [/觸及價格/, /觸發價格/, /\bKI\b/i]) || pct[4] || pct.at(-1) || "—");
    const tenorMatch = flat.match(/產品天期[\s\S]{0,180}?(\d{1,2})\s*\/?\s*\(?月\)?/i)
      || flat.match(/(?:Tenor|期間)[^\d]{0,30}(\d{1,2})\s*(?:M|個?月)/i);
    const tenor = tenorMatch ? cleanNumber(tenorMatch[1]) : "—";
    const guaranteedMatch = flat.match(/\b(?:USD|JPY|AUD|TWD|HKD|EUR|GBP|CHF|CNH|CNY)\s+(\d{1,2})\b/i)
      || flat.match(/保證領息(?:期間)?\s*(?:\(月\))?\s*[:：]?\s*(\d{1,2})(?:\s*(?:個?月|\(月\)))?/i);
    const guaranteed = guaranteedMatch ? cleanNumber(guaranteedMatch[1]) : "—";
    const pricing = /開盤價/.test(flat) ? "開盤價" : /收盤價/.test(flat) ? "收盤價" : "收盤價";
    const tickers = tickerRows(flat);
    const markets = new Set(tickers.marketSuffixes.map((suffix) => ["JT", "JP"].includes(suffix) ? "日股" : suffix === "AT" ? "澳股" : "美股"));
    const market = markets.size === 1 ? [...markets][0] : markets.size > 1 ? "跨市場" : "美股";
    const currencyNames = { USD: "美金", JPY: "日圓", AUD: "澳幣", TWD: "台幣", HKD: "港幣", EUR: "歐元", GBP: "英鎊", CHF: "瑞郎", CNH: "人民幣", CNY: "人民幣" };
    const missing = [];
    if (!code) missing.push("商品代號");
    if (!tickers.rows.length) missing.push("連結標的");
    if (strike === "—") missing.push("執行價");
    if (autocall === "—") missing.push("提前出場");
    if (tenor === "—") missing.push("期間");
    if (coupon === "—") missing.push("年化配息率");
    return { structure, currency, currencyName: currencyNames[currency] || currency, market, code, pricing, underlyings: tickers.rows, strike, ki, kiType, autocall, tenor, guaranteed, coupon, missing, rawText: text };
  }
  function formatProductOcrResult(parsed) {
    const underlyings = parsed.underlyings.length ? parsed.underlyings.map((item) => `${item.symbol}${item.name ? `  ${item.name}` : ""}`).join("\n") : "（請手動輸入）";
    return `${parsed.structure} 條件(${parsed.currencyName}/${parsed.market})\n${parsed.code || "商品代號待補"}(${parsed.pricing})\n\n🔶連結標的：\n\n${underlyings}\n\n🔸執行價：${parsed.strike}%\n🔸下限價：${parsed.ki}%\n🔸觸及類型：${parsed.kiType}\n🔸提前出場：${parsed.autocall}%\n🔸期間：${parsed.tenor}個月\n🔸保證領息：${parsed.guaranteed}個月\n🔸年化配息率：${parsed.coupon}%`;
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
  async function recognizeProductImage(file, onProgress = () => {}, signal) {
    if (!file || !/^image\//.test(file.type || "")) throw new Error("請選擇圖片檔");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress({ label: "整理圖片", percent: 0.03 });
    const image = await prepareImage(file), Tesseract = await loadOcrLibrary();
    let worker;
    const abort = () => { worker?.terminate().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      worker = await Tesseract.createWorker(["eng", "chi_tra"], 1, { logger(message) {
        const percent = Number.isFinite(message.progress) ? message.progress : 0;
        const label = message.status === "recognizing text" ? "辨識文字" : message.status?.includes("loading") ? "載入辨識工具" : "準備辨識";
        onProgress({ label, percent });
      } });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await worker.recognize(image);
      const parsed = parseProductOcrText(result?.data?.text || "");
      return { parsed, formatted: formatProductOcrResult(parsed) };
    } finally { signal?.removeEventListener("abort", abort); if (worker) await worker.terminate().catch(() => {}); }
  }
  root.FcnProductOcr = { normalizeText, parseProductOcrText, formatProductOcrResult, recognizeProductImage };
})(globalThis);
