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
  if (mappedRegion === 'Vlaanderen') return ['Vlaanderen'];
  if (mappedRegion === 'Brussel') return ['Brussel'];
  if (mappedRegion === 'Wallonië') return ['Wallonië'];
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

async function selectRegion(frame, regionText) {
  console.log('Trying to select region:', regionText);

  // Probeer via native select element
  try {
    const select = frame.locator('select').first();
    const count = await select.count().catch(() => 0);
    if (count > 0) {
      await select.selectOption({ label: regionText });
      await frame.waitForTimeout(300);
      console.log('Region selected via select:', regionText);
      return true;
    }
  } catch (e) {
    console.log('Select failed:', e.message);
  }

  // Probeer via combobox
  try {
    const combobox = frame.getByRole('combobox').first();
    const visible = await combobox.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) {
      await combobox.selectOption({ label: regionText });
      await frame.waitForTimeout(300);
      console.log('Region selected via combobox:', regionText);
      return true;
    }
  } catch (e) {
    console.log('Combobox failed:', e.message);
  }

  console.log('Region not found:', regionText);
  return false;
}

async function clickRadioByLabel(frame, labelText) {
  console.log('Clicking radio by label:', labelText);
  try {
    const label = frame.locator('label').filter({ hasText: labelText }).first();
    const count = await label.count().catch(() => 0);
    if (count > 0) {
      await label.click({ force: true, timeout: 3000 });
      await frame.waitForTimeout(300);
      console.log('Radio clicked via label:', labelText);
      return true;
    }
  } catch (e) {
    console.log('clickRadioByLabel failed:', e.message);
  }

  // Fallback: zoek via tekst
  try {
    const locator = frame.getByText(labelText, { exact: true }).first();
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      await locator.click({ force: true, timeout: 3000 });
      await frame.waitForTimeout(300);
      console.log('Radio clicked via text:', labelText);
      return true;
    }
  } catch (e) {
    console.log('clickRadioByLabel text fallback failed:', e.message);
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
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
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
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    await page.route('**/{analytics,gtm,hotjar,doubleclick,facebook,google-analytics}**', route => route.abort());
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}', route => route.abort());

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(15000);

    console.log('Goto calculator...');
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForTimeout(800);
    await acceptCookies(page);

    console.log('Zoek frame...');
    const frame = await getCalculatorFrame(page);
    if (!frame) throw new Error('Calculator iframe niet gevonden');

    await page.waitForTimeout(2000);
    console.log('Frame geladen');

    // 6. Select region
    let regionClicked = false;
    for (const option of regionOptions) {
      regionClicked = await selectRegion(frame, option);
      if (regionClicked) break;
    }
    if (!regionClicked) throw new Error(`Kon regio niet selecteren: ${mappedRegion}`);

    // 7. Select property type
    const propertyClicked = await clickRadioByLabel(frame, mappedPropertyType);
    if (!propertyClicked) throw new Error(`Kon propertyType niet selecteren: ${mappedPropertyType}`);

    // 8. Select own and only home
    const ownHomeClicked = await clickRadioByLabel(frame, parsedOwnAndOnlyHome ? 'Ja' : 'Nee');
    if (!ownHomeClicked) throw new Error('Kon ownAndOnlyHome niet selecteren');

    // 9. Fill price
    const priceFilled = await fillInputNearLabel(frame, ['Aankoopbedrag'], normalizedPrice);
    if (!priceFilled) throw new Error('Kon aankoopbedrag niet invullen');

    // 10. Select purchase mode
    const purchaseModeClicked = await clickRadioByLabel(frame, mappedPurchaseMode);
    if (!purchaseModeClicked) throw new Error(`Kon purchaseMode niet selecteren: ${mappedPurchaseMode}`);

    // 11. Select kernstad
    if (mappedPurchaseMode === 'Aankoop met registratierechten') {
      const kernstadClicked = await clickRadioByLabel(frame, parsedKernstad ? 'Ja' : 'Nee / weet het niet');
      if (!kernstadClicked) throw new Error('Kon kernstad niet selecteren');
    }

    // 12. Click calculate
    const calculateClicked = await clickCalculate(frame);
    if (!calculateClicked) throw new Error('Bereken-knop niet gevonden');

    // 13. Wacht op resultaat
    console.log('Wacht op resultaat...');
    await page.waitForTimeout(3000);

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
