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
  if (['vlaanderen','vlaams gewest','vlaams-brabant','antwerpen','limburg','oost-vlaanderen','west-vlaanderen','flanders','vl'].includes(r)) return 'Vlaanderen';
  if (['brussel','brussels','bruxelles','brussels hoofdstedelijk gewest','br'].includes(r)) return 'Brussel';
  if (['wallonië','wallonie','wallonia','waals gewest','henegouwen','luik','luxemburg','namen','waals-brabant','wal'].includes(r)) return 'Wallonië';
  return null;
}

function getRegionOptions(mappedRegion) {
  if (mappedRegion === 'Vlaanderen') return ['Vlaanderen', 'Vlaams Gewest'];
  if (mappedRegion === 'Brussel') return ['Brussel', 'Brussels Hoofdstedelijk Gewest'];
  if (mappedRegion === 'Wallonië') return ['Wallonië', 'Waals Gewest'];
  return [mappedRegion];
}

function mapPropertyType(propertyType) {
  if (!propertyType) return null;
  const p = String(propertyType).toLowerCase().replace(/\s+/g, ' ').trim();
  if (['woning / appartement','woning/appartement','woning appartement','woning','appartement'].includes(p)) return 'Woning / appartement';
  if (['bouwgrond', 'grond'].includes(p)) return 'Bouwgrond';
  return null;
}

function mapPurchaseMode(purchaseMode) {
  const p = String(purchaseMode || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (['registratierechten','aankoop met registratierechten','registratiebelasting'].includes(p)) return 'Aankoop met registratierechten';
  if (['btw', 'aankoop met btw'].includes(p)) return 'Aankoop met BTW';
  if (['grond_registratierechten_gebouw_btw','aankoop grond met registratierechten + gebouw btw','grond+gebouw','combi'].includes(p)) return 'Aankoop grond met registratierechten + gebouw BTW';
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
  const source = normalizeSpaces(text).replace(/Menu/g, '');
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
      const visible = await candidate.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        console.log('Cookie button found, clicking...');
        await candidate.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      }
    } catch (_) {}
  }
  console.log('No cookie banner handled');
  return false;
}

async function getCalculatorFrame(page) {
  for (let i = 0; i < 10; i++) {
    const frames = page.frames();
    const frame = frames.find((f) => f.url().includes('calculator.notaris.be'));
    if (frame) {
      console.log('✅ Calculator frame gevonden:', frame.url());
      return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickRadioInFieldsetByIndex(frame, fieldsetIndex, optionIndex) {
  const radios = frame.locator('fieldset').nth(fieldsetIndex).locator('input[type="radio"]');
  const count = await radios.count().catch(() => 0);
  if (count === 0 || optionIndex >= count) return false;
  try {
    const radio = radios.nth(optionIndex);
    await radio.check({ force: true }).catch(async () => {
      await radio.click({ force: true, timeout: 3000 });
    });
    await frame.waitForTimeout(300);
    return true;
  } catch (e) {
    console.log('clickRadioInFieldsetByIndex failed:', e.message);
    return false;
  }
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
        await locator.type(stringValue, { delay: 30 });
        await frame.waitForTimeout(200);
        console.log('Input filled near label:', label);
        return true;
      }
    } catch (e) {
      console.log(`Could not fill near label "${label}":`, e.message);
    }
  }
  return false;
}

async function clickCalculate(frame) {
  const candidates = [
    frame.getByRole('button', { name: /bereken/i }).first(),
    frame.getByText(/^Bereken$/i).first(),
    frame.locator('text=Bereken').first()
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const visible = await candidates[i].isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await candidates[i].click({ force: true, timeout: 3000 });
        console.log('Bereken button clicked');
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function selectRegion(frame, regionText) {
  console.log('Trying to select region:', regionText);
  const triggers = [
    frame.getByRole('combobox').first(),
    frame.locator('label:has-text("Bereken voor")').locator('xpath=following::*[@role="combobox" or self::div or self::button][1]').first(),
  ];
  let opened = false;
  for (let i = 0; i < triggers.length; i++) {
    try {
      const visible = await triggers[i].isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await triggers[i].click({ force: true, timeout: 3000 }).catch(() => {});
        await frame.waitForTimeout(500);
        opened = true;
        break;
      }
    } catch (e) {}
  }
  if (!opened) return false;

  const optionLocators = [
    frame.locator(`[role="option"]:has-text("${regionText}")`).first(),
    frame.locator(`li:has-text("${regionText}")`).first(),
    frame.getByText(new RegExp(`^${regionText}$`, 'i')).first(),
  ];
  for (const option of optionLocators) {
    try {
      const visible = await option.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await option.click({ force: true, timeout: 3000 });
        await frame.waitForTimeout(500);
        console.log('Region selected successfully');
        return true;
      }
    } catch (e) {}
  }
  return false;
}

app.get('/', (req, res) => res.send('Backend werkt!'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/calculate', async (req, res) => {
  console.log('🔥 /calculate aangeroepen', new Date().toISOString());
  console.log('Body:', JSON.stringify(req.body, null, 2));

  const { region, propertyType, ownAndOnlyHome, price, purchaseMode, kernstad } = req.body;

  const mappedRegion = mapRegion(region);
  const regionOptions = getRegionOptions(mappedRegion);
  const mappedPropertyType = mapPropertyType(propertyType);
  const mappedPurchaseMode = mapPurchaseMode(purchaseMode);
  const parsedOwnAndOnlyHome = parseBoolean(ownAndOnlyHome);
  const parsedKernstad = parseBoolean(kernstad);
  const normalizedPrice = normalizePrice(price);

  if (!mappedRegion) return res.status(400).json({ success: false, error: 'Ongeldige region' });
  if (!mappedPropertyType) return res.status(400).json({ success: false, error: 'Ongeldig propertyType' });
  if (parsedOwnAndOnlyHome === null) return res.status(400).json({ success: false, error: 'Ongeldige ownAndOnlyHome' });
  if (!mappedPurchaseMode) return res.status(400).json({ success: false, error: 'Ongeldige purchaseMode' });
  if (!normalizedPrice) return res.status(400).json({ success: false, error: 'Ongeldige prijs' });
  if (mappedPurchaseMode === 'Aankoop met registratierechten' && parsedKernstad === null) {
    return res.status(400).json({ success: false, error: 'Ongeldige kernstad' });
  }

  let browser;
  try {
    // 1. Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // Blokkeer onnodige requests om sneller te laden
    await page.route('**/{analytics,gtm,hotjar,doubleclick,facebook,google-analytics}**', route => route.abort());
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}', route => route.abort());

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(15000);

    // 2. Goto calculator
    console.log('Goto calculator...');
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });

    // 3. Accept cookies
    await page.waitForTimeout(800);
    await acceptCookies(page);

    // 4. Find calculator frame
    console.log('Zoek frame...');
    const frame = await getCalculatorFrame(page);
    if (!frame) throw new Error('Calculator iframe niet gevonden');

    // 5. Wacht tot frame geladen is
    await frame.waitForSelector('input[type="radio"]', { timeout: 8000 });
    console.log('Frame geladen');

    // 6. Select region
    let regionClicked = false;
    for (const option of regionOptions) {
      regionClicked = await selectRegion(frame, option);
      if (regionClicked) break;
    }
    if (!regionClicked) throw new Error(`Kon regio niet selecteren: ${mappedRegion}`);

    // 7. Select property type
    const propertyIndex = mappedPropertyType === 'Woning / appartement' ? 0 : 1;
    const propertyClicked = await clickRadioInFieldsetByIndex(frame, 1, propertyIndex);
    if (!propertyClicked) throw new Error(`Kon propertyType niet selecteren: ${mappedPropertyType}`);

    // 8. Select own and only home
    const ownHomeClicked = await clickRadioInFieldsetByIndex(frame, 2, parsedOwnAndOnlyHome ? 0 : 1);
    if (!ownHomeClicked) throw new Error('Kon ownAndOnlyHome niet selecteren');

    // 9. Fill price
    const priceFilled = await fillInputNearLabel(frame, ['Aankoopbedrag'], normalizedPrice);
    if (!priceFilled) throw new Error('Kon aankoopbedrag niet invullen');

    // 10. Select purchase mode
    const purchaseIndex =
      mappedPurchaseMode === 'Aankoop met registratierechten' ? 0 :
      mappedPurchaseMode === 'Aankoop met BTW' ? 1 : 2;
    const purchaseModeClicked = await clickRadioInFieldsetByIndex(frame, 3, purchaseIndex);
    if (!purchaseModeClicked) throw new Error(`Kon purchaseMode niet selecteren: ${mappedPurchaseMode}`);

    // 11. Select kernstad
    if (mappedPurchaseMode === 'Aankoop met registratierechten') {
      const kernstadClicked = await clickRadioInFieldsetByIndex(frame, 4, parsedKernstad ? 0 : 1);
      if (!kernstadClicked) throw new Error('Kon kernstad niet selecteren');
    }

    // 12. Click calculate
    const calculateClicked = await clickCalculate(frame);
    if (!calculateClicked) throw new Error('Bereken-knop niet gevonden');

    // 13. Wacht op resultaat
    console.log('Wacht op resultaat...');
    await frame.waitForSelector('text=Het totaal van de kosten', { timeout: 12000 });

    // 14. Read result
    const frameText = await frame.locator('body').textContent();
    const resultText = frameText || '';

    const totalCost = extractTotal(resultText);
    const registrationTax = extractMoney(resultText, 'Registratiebelasting/registratierechten');
    const annexRights = extractMoney(resultText, 'Registratierecht op bijlagen');
    const notaryFee = extractMoney(resultText, 'Ereloon');
    const adminCosts = extractMoney(resultText, 'Administratieve kosten');
    const thirdPartyCosts = extractMoney(resultText, 'Uitgaven aan derden');
    const transcriptionCosts = extractMoney(resultText, 'Kosten overschrijving');
    const documentRights = extractMoney(resultText, 'Recht op geschriften');
    const vat = extractMoney(resultText, 'BTW');

    console.log('Resultaat:', { totalCost, registrationTax, notaryFee, vat });

    return res.json({
      success: true,
      results: {
        totalCost,
        registrationTax,
        annexRights,
        notaryFee,
        adminCosts,
        thirdPartyCosts,
        transcriptionCosts,
        documentRights,
        vat
      },
      disclaimer: 'Alle berekeningen zijn indicatief en onder voorbehoud via notaris.be.'
    });

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log('Browser closed'); 
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server draait op poort ${PORT}`);
});
