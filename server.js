const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const CALCULATOR_URL =
  'https://www.notaris.be/rekenmodules/wonen/aankoopkosten-van-een-woning-en/bouwgrond-berekenen';

function normalizeSpaces(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

function cleanValue(value) {
  if (value === '' || value === 'null' || value === 'undefined') return null;
  return value;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();

    if (['true', 'ja', 'yes', '1'].includes(v)) return true;
    if (['false', 'nee', 'no', '0'].includes(v)) return false;
  }

  return null;
}

function mapRegion(region) {
  const r = String(region || '').trim().toLowerCase();

  if (['vlaanderen', 'flanders', 'vl'].includes(r)) return 'Vlaanderen';
  if (['brussel', 'brussels', 'bruxelles', 'br'].includes(r)) return 'Brussel';
  if (['wallonië', 'wallonie', 'wallonia', 'wal'].includes(r)) return 'Wallonië';

  return null;
}

function mapPropertyType(propertyType) {
  if (!propertyType) return null;

  const p = String(propertyType)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (
    p === 'woning / appartement' ||
    p === 'woning/appartement' ||
    p === 'woning appartement' ||
    p === 'woning' ||
    p === 'appartement'
  ) {
    return 'Woning / appartement';
  }

  if (p === 'bouwgrond' || p === 'grond') {
    return 'Bouwgrond';
  }

  return null;
}

function mapPurchaseMode(purchaseMode) {
  const p = String(purchaseMode || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

  if (
    [
      'registratierechten',
      'aankoop met registratierechten',
      'registratiebelasting'
    ].includes(p)
  ) {
    return 'Aankoop met registratierechten';
  }

  if (['btw', 'aankoop met btw'].includes(p)) {
    return 'Aankoop met BTW';
  }

  if (
    [
      'grond_registratierechten_gebouw_btw',
      'aankoop grond met registratierechten + gebouw btw',
      'grond+gebouw',
      'combi'
    ].includes(p)
  ) {
    return 'Aankoop grond met registratierechten + gebouw BTW';
  }

  return null;
}

function extractMoney(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*€\\s*([\\d.]+,\\d{2})`, 'i');
  const match = text.match(regex);
  return match ? `€ ${match[1]}` : null;
}

function extractTotal(text) {
  const patterns = [
    /Het totaal van de kosten.*?geraamd op\s*€\s*([\d.]+,\d{2})/i,
    /totaal van de kosten.*?€\s*([\d.]+,\d{2})/i,
    /Totale kosten.*?€\s*([\d.]+,\d{2})/i
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) return `€ ${match[1]}`;
  }

  return null;
}

async function acceptCookies(page) {
  const candidates = [
    page.getByRole('button', { name: /alle cookies toestaan/i }).first(),
    page.getByRole('button', { name: /accepteren/i }).first(),
    page.getByText(/alle cookies toestaan/i).first()
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 2000 }).catch(() => false)) {
        await candidate.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function getCalculatorFrame(page) {
  await page.waitForTimeout(2500);

  for (let i = 0; i < 10; i++) {
    const frames = page.frames();
    const frame = frames.find((f) => f.url().includes('calculator.notaris.be'));

    if (frame) return frame;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    }).catch(() => {});

    await page.waitForTimeout(1000);
  }

  return null;
}

async function clickRadioByText(frame, textCandidates) {
  for (const text of textCandidates) {
    const locator = frame.locator(`text=${text}`).first();
    try {
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await locator.click({ force: true });
        await frame.waitForTimeout(400);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function fillInputNearLabel(frame, labelCandidates, value) {
  if (value === undefined || value === null || value === '') return false;

  const stringValue = String(value);

  for (const label of labelCandidates) {
    const input = frame.locator(`xpath=//*[contains(text(),"${label}")]/following::input[1]`).first();

    try {
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await input.fill('');
        await input.type(stringValue);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function clickCalculate(frame) {
  const locator = frame.locator('text=Bereken').first();

  try {
    if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await locator.click({ force: true });
      return true;
    }
  } catch (_) {}

  return false;
}

app.get('/', (req, res) => {
  res.send('Backend werkt!');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/calculate', async (req, res) => {

  console.log("🔥 API CALLED");
  console.log("BODY:", req.body);

  const {
    region,
    propertyType,
    ownAndOnlyHome,
    price,
    purchaseMode,
    kernstad
  } = req.body;

  const mappedRegion = mapRegion(region);
  const mappedPropertyType = mapPropertyType(propertyType);
  const mappedPurchaseMode = mapPurchaseMode(purchaseMode);
  const parsedOwnAndOnlyHome = parseBoolean(ownAndOnlyHome);
  const parsedKernstad = parseBoolean(kernstad);

  let browser;

  try {

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    });

    const page = await browser.newPage();

    await page.goto(CALCULATOR_URL, {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForTimeout(3000);
    await acceptCookies(page);

    const frame = await getCalculatorFrame(page);

    if (!frame) {
      return res.status(500).json({
        success: false,
        error: "Calculator iframe niet gevonden"
      });
    }

    await clickRadioByText(frame, [mappedRegion]);
    await clickRadioByText(frame, [mappedPropertyType]);
    await clickRadioByText(frame, [parsedOwnAndOnlyHome ? 'Ja' : 'Nee']);

    await fillInputNearLabel(frame, ['Aankoopbedrag'], price);

    await clickRadioByText(frame, [mappedPurchaseMode]);

    if (mappedPurchaseMode === 'Aankoop met registratierechten') {
      await clickRadioByText(frame, [parsedKernstad ? 'Ja' : 'Nee']);
    }

    await clickCalculate(frame);

    await page.waitForTimeout(5000);

    const frameText = await frame.locator('body').textContent();

    const totalCost = extractTotal(frameText);
    const registrationTax = extractMoney(frameText,'Registratiebelasting/registratierechten');
    const notaryFee = extractMoney(frameText,'Ereloon');
    const vat = extractMoney(frameText,'BTW');

    res.json({
      success: true,
      results: {
        totalCost,
        registrationTax,
        notaryFee,
        vat
      }
    });

  } catch (error) {

    console.error("ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  } finally {
    if (browser) await browser.close();
  }

});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Server draait op ${HOST}:${PORT}`);
});