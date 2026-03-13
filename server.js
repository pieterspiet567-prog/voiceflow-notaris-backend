const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const CALCULATOR_URL =
  'https://www.notaris.be/rekenmodules/wonen/aankoopkosten-van-een-woning-en/bouwgrond-berekenen';

function normalizeSpaces(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
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

function normalizePrice(value) {
  if (value === null || value === undefined || value === '') return null;

  const cleaned = String(value)
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;

  return String(Math.round(num));
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

  const p = String(propertyType).toLowerCase().replace(/\s+/g, ' ').trim();

  if (
    [
      'woning / appartement',
      'woning/appartement',
      'woning appartement',
      'woning',
      'appartement'
    ].includes(p)
  ) {
    return 'Woning / appartement';
  }

  if (['bouwgrond', 'grond'].includes(p)) {
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
  const source = normalizeSpaces(text);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*€\\s*([\\d.]+,\\d{2})`, 'i');
  const match = source.match(regex);
  return match ? `€ ${match[1]}` : null;
}

function extractTotal(text) {
  const source = normalizeSpaces(text);

  const patterns = [
    /Het totaal van de kosten.*?geraamd op\s*€\s*([\d.]+,\d{2})/i,
    /totaal van de kosten.*?€\s*([\d.]+,\d{2})/i,
    /Totale kosten.*?€\s*([\d.]+,\d{2})/i
  ];

  for (const regex of patterns) {
    const match = source.match(regex);
    if (match) return `€ ${match[1]}`;
  }

  return null;
}

async function acceptCookies(page) {
  const candidates = [
    page.getByRole('button', { name: /alle cookies toestaan/i }).first(),
    page.getByRole('button', { name: /accepteren/i }).first(),
    page.getByRole('button', { name: /accept/i }).first(),
    page.getByText(/alle cookies toestaan/i).first()
  ];

  for (const candidate of candidates) {
    try {
      const visible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await candidate.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function getCalculatorFrame(page) {
  for (let i = 0; i < 15; i++) {
    const frames = page.frames();
    const frame = frames.find((f) => f.url().includes('calculator.notaris.be'));

    if (frame) {
      return frame;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    }).catch(() => {});

    await page.waitForTimeout(1000);
  }

  return null;
}

async function clickRadioByText(frame, textCandidates) {
  for (const rawText of textCandidates) {
    if (!rawText) continue;

    const text = String(rawText).trim();

    const candidates = [
      frame.getByText(new RegExp(`^${text}$`, 'i')).first(),
      frame.getByText(text, { exact: true }).first(),
      frame.locator(`text=${text}`).first()
    ];

    for (const locator of candidates) {
      try {
        const visible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await locator.click({ force: true, timeout: 5000 });
          await frame.waitForTimeout(500);
          return true;
        }
      } catch (_) {}
    }
  }

  return false;
}

async function fillInputNearLabel(frame, labelCandidates, value) {
  if (value === undefined || value === null || value === '') return false;

  const stringValue = String(value);

  for (const label of labelCandidates) {
    const xpath = `xpath=//*[contains(normalize-space(text()),"${label}")]/following::input[1]`;
    const locator = frame.locator(xpath).first();

    try {
      const visible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await locator.fill('');
        await locator.type(stringValue, { delay: 50 });
        await frame.waitForTimeout(300);
        return true;
      }
    } catch (_) {}
  }

  const fallbackInputs = frame.locator('input');
  const count = await fallbackInputs.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const input = fallbackInputs.nth(i);

    try {
      const visible = await input.isVisible({ timeout: 500 }).catch(() => false);
      const enabled = await input.isEnabled({ timeout: 500 }).catch(() => false);

      if (visible && enabled) {
        await input.fill('');
        await input.type(stringValue, { delay: 50 });
        await frame.waitForTimeout(300);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function clickCalculate(frame) {
  const candidates = [
    frame.getByText(/^Bereken$/i).first(),
    frame.getByRole('button', { name: /bereken/i }).first(),
    frame.locator('text=Bereken').first()
  ];

  for (const locator of candidates) {
    try {
      const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await locator.click({ force: true, timeout: 5000 });
        return true;
      }
    } catch (_) {}
  }

  return false;
}

app.get('/', (req, res) => {
  res.send('Backend werkt!');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/calculate', async (req, res) => {
  console.log('🔥 API CALLED');
  console.log('BODY:', JSON.stringify(req.body, null, 2));

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
  const normalizedPrice = normalizePrice(price);

  if (!mappedRegion) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige region'
    });
  }

  if (!mappedPropertyType) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldig propertyType'
    });
  }

  if (parsedOwnAndOnlyHome === null) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige ownAndOnlyHome'
    });
  }

  if (!mappedPurchaseMode) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige purchaseMode'
    });
  }

  if (!normalizedPrice) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige prijs'
    });
  }

  if (
    mappedPurchaseMode === 'Aankoop met registratierechten' &&
    parsedKernstad === null
  ) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige kernstad'
    });
  }

  let browser;

  try {
    console.log('1. Launch browser');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    console.log('2. New page');
    const page = await browser.newPage();

    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);

    console.log('3. Goto calculator');
    await page.goto(CALCULATOR_URL, {
      waitUntil: 'domcontentloaded'
    });

    console.log('4. Accept cookies');
    await page.waitForTimeout(3000);
    await acceptCookies(page);

    console.log('5. Find calculator frame');
    const frame = await getCalculatorFrame(page);

    if (!frame) {
      throw new Error('Calculator iframe niet gevonden');
    }

    console.log('6. Select region:', mappedRegion);
    const regionClicked = await clickRadioByText(frame, [mappedRegion]);
    console.log('regionClicked =', regionClicked);
    if (!regionClicked) {
      throw new Error(`Kon regio niet selecteren: ${mappedRegion}`);
    }

    console.log('7. Select property type:', mappedPropertyType);
    const propertyClicked = await clickRadioByText(frame, [mappedPropertyType]);
    console.log('propertyClicked =', propertyClicked);
    if (!propertyClicked) {
      throw new Error(`Kon propertyType niet selecteren: ${mappedPropertyType}`);
    }

    console.log('8. Select own and only home:', parsedOwnAndOnlyHome);
    const ownHomeClicked = await clickRadioByText(
      frame,
      [parsedOwnAndOnlyHome ? 'Ja' : 'Nee']
    );
    console.log('ownHomeClicked =', ownHomeClicked);
    if (!ownHomeClicked) {
      throw new Error('Kon ownAndOnlyHome niet selecteren');
    }

    console.log('9. Fill price:', normalizedPrice);
    const priceFilled = await fillInputNearLabel(frame, ['Aankoopbedrag'], normalizedPrice);
    console.log('priceFilled =', priceFilled);
    if (!priceFilled) {
      throw new Error('Kon aankoopbedrag niet invullen');
    }

    console.log('10. Select purchase mode:', mappedPurchaseMode);
    const purchaseModeClicked = await clickRadioByText(frame, [mappedPurchaseMode]);
    console.log('purchaseModeClicked =', purchaseModeClicked);
    if (!purchaseModeClicked) {
      throw new Error(`Kon purchaseMode niet selecteren: ${mappedPurchaseMode}`);
    }

    if (mappedPurchaseMode === 'Aankoop met registratierechten') {
      console.log('11. Select kernstad:', parsedKernstad);
      const kernstadClicked = await clickRadioByText(
        frame,
        [parsedKernstad ? 'Ja' : 'Nee']
      );
      console.log('kernstadClicked =', kernstadClicked);
      if (!kernstadClicked) {
        throw new Error('Kon kernstad niet selecteren');
      }
    }

    console.log('12. Click calculate');
    const calculateClicked = await clickCalculate(frame);
    console.log('calculateClicked =', calculateClicked);
    if (!calculateClicked) {
      throw new Error('Bereken-knop niet gevonden');
    }

    console.log('13. Wait for result');
    await page.waitForTimeout(5000);

    console.log('14. Read result text');
    const frameText = await frame.locator('body').textContent();
    console.log('Result text length:', frameText?.length || 0);

    const resultText = frameText || '';
    const totalCost = extractTotal(resultText);
    const registrationTax = extractMoney(
      resultText,
      'Registratiebelasting/registratierechten'
    );
    const notaryFee = extractMoney(resultText, 'Ereloon');
    const vat = extractMoney(resultText, 'BTW');

    console.log('15. Parsed result', {
      totalCost,
      registrationTax,
      notaryFee,
      vat
    });

    return res.json({
      success: true,
      results: {
        totalCost,
        registrationTax,
        notaryFee,
        vat
      }
    });
  } catch (error) {
    console.error('ERROR:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server draait op ${HOST}:${PORT}`);
});
