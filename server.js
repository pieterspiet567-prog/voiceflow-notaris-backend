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

  if (
    [
      'vlaanderen',
      'vlaams gewest',
      'vlaams-brabant',
      'antwerpen',
      'limburg',
      'oost-vlaanderen',
      'west-vlaanderen',
      'flanders',
      'vl'
    ].includes(r)
  ) {
    return 'Vlaanderen';
  }

  if (
    [
      'brussel',
      'brussels',
      'bruxelles',
      'brussels hoofdstedelijk gewest',
      'br'
    ].includes(r)
  ) {
    return 'Brussel';
  }

  if (
    [
      'wallonië',
      'wallonie',
      'wallonia',
      'waals gewest',
      'henegouwen',
      'luik',
      'luxemburg',
      'namen',
      'waals-brabant',
      'wal'
    ].includes(r)
  ) {
    return 'Wallonië';
  }

  return null;
}

function getRegionOptions(mappedRegion) {
  if (mappedRegion === 'Vlaanderen') {
    return ['Vlaanderen', 'Vlaams Gewest'];
  }
  if (mappedRegion === 'Brussel') {
    return ['Brussel', 'Brussels Hoofdstedelijk Gewest'];
  }
  if (mappedRegion === 'Wallonië') {
    return ['Wallonië', 'Waals Gewest'];
  }
  return [mappedRegion];
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
        console.log('Cookie button found, clicking...');
        await candidate.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }

  console.log('No cookie banner handled');
  return false;
}

async function getCalculatorFrame(page) {
  for (let i = 0; i < 20; i++) {
    const frames = page.frames();

    console.log(`🔎 Poll ${i + 1} - aantal frames: ${frames.length}`);
    frames.forEach((f, idx) => {
      console.log(`Frame[${idx}] URL: ${f.url()}`);
    });

    const frame = frames.find((f) => f.url().includes('calculator.notaris.be'));

    if (frame) {
      console.log('✅ Calculator frame gevonden:', frame.url());

      try {
        const bodyText = await frame.locator('body').textContent({ timeout: 5000 }).catch(() => '');
        console.log('FRAME BODY PREVIEW:', String(bodyText || '').slice(0, 1500));
      } catch (e) {
        console.log('Kon frame body niet lezen:', e.message);
      }

      return frame;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    }).catch(() => {});

    await page.waitForTimeout(1000);
  }

  return null;
}

async function dumpFrameDebug(frame) {
  try {
    console.log('Frame URL:', frame.url());

    const bodyText = await frame.locator('body').textContent().catch(() => '');
    console.log('FRAME PREVIEW:', (bodyText || '').slice(0, 2000));

    const labels = await frame.locator('label').allTextContents().catch(() => []);
    console.log(
      'FRAME LABELS:',
      labels.map((x) => normalizeSpaces(x)).filter(Boolean).slice(0, 100)
    );

    const legends = await frame.locator('legend').allTextContents().catch(() => []);
    console.log(
      'FRAME LEGENDS:',
      legends.map((x) => normalizeSpaces(x)).filter(Boolean).slice(0, 50)
    );

    const radioCount = await frame.locator('input[type="radio"]').count().catch(() => 0);
    console.log('FRAME RADIO COUNT:', radioCount);

    const selectCount = await frame.locator('select').count().catch(() => 0);
    console.log('FRAME SELECT COUNT:', selectCount);

    const comboCount = await frame.getByRole('combobox').count().catch(() => 0);
    console.log('FRAME COMBOBOX COUNT:', comboCount);
  } catch (e) {
    console.log('DEBUG DUMP FAILED:', e.message);
  }
}

async function clickRadioByText(frame, textCandidates) {
  console.log('Trying to click radio with candidates:', textCandidates);

  for (const rawText of textCandidates) {
    if (!rawText) continue;

    const text = String(rawText).trim();
    console.log(`-- Candidate: "${text}"`);

    const candidates = [
      frame.getByText(text, { exact: true }).first(),
      frame.getByText(new RegExp(`^${text}$`, 'i')).first(),
      frame.getByText(new RegExp(text, 'i')).first(),
      frame.locator(`label:has-text("${text}")`).first(),
      frame.locator(`text=${text}`).first()
    ];

    for (let i = 0; i < candidates.length; i++) {
      const locator = candidates[i];
      try {
        const count = await locator.count().catch(() => 0);
        const visible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
        console.log(`Locator ${i}: count=${count}, visible=${visible}`);

        if (visible) {
          const txt = await locator.textContent().catch(() => '');
          console.log(`Clicking locator ${i} with text:`, txt);

          await locator.click({ force: true, timeout: 5000 }).catch((e) => {
            console.log(`Click failed on locator ${i}:`, e.message);
          });

          await frame.waitForTimeout(500);
          return true;
        }
      } catch (e) {
        console.log(`Locator ${i} error:`, e.message);
      }
    }

    try {
      const label = frame.locator(`label:has-text("${text}")`).first();
      const visible = await label.isVisible({ timeout: 1500 }).catch(() => false);
      console.log(`Fallback label visible=${visible} for "${text}"`);

      if (visible) {
        const forAttr = await label.getAttribute('for').catch(() => null);
        console.log(`Fallback label for="${forAttr}"`);

        if (forAttr) {
          const input = frame.locator(`#${forAttr}`).first();
          await input.check({ force: true }).catch(async () => {
            await input.click({ force: true, timeout: 5000 });
          });
          await frame.waitForTimeout(500);
          return true;
        }
      }
    } catch (e) {
      console.log('Fallback label error:', e.message);
    }
  }

  console.log('No radio clicked for candidates:', textCandidates);
  return false;
}

async function clickRadioInFieldsetByIndex(frame, fieldsetIndex, optionIndex) {
  const radios = frame.locator('fieldset').nth(fieldsetIndex).locator('input[type="radio"]');
  const count = await radios.count().catch(() => 0);

  console.log(
    `clickRadioInFieldsetByIndex => fieldsetIndex=${fieldsetIndex}, optionIndex=${optionIndex}, radioCount=${count}`
  );

  if (count === 0 || optionIndex >= count) return false;

  try {
    const radio = radios.nth(optionIndex);
    await radio.check({ force: true }).catch(async () => {
      await radio.click({ force: true, timeout: 5000 });
    });
    await frame.waitForTimeout(500);
    return true;
  } catch (e) {
    console.log('clickRadioInFieldsetByIndex failed:', e.message);
    return false;
  }
}

async function fillInputNearLabel(frame, labelCandidates, value) {
  if (value === undefined || value === null || value === '') return false;

  const stringValue = String(value);
  console.log('Trying to fill input for labels:', labelCandidates);
  console.log('Value:', stringValue);

  for (const label of labelCandidates) {
    const xpath = `xpath=//*[contains(normalize-space(text()),"${label}")]/following::input[1]`;
    const locator = frame.locator(xpath).first();

    try {
      const visible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await locator.fill('');
        await locator.type(stringValue, { delay: 50 });
        await frame.waitForTimeout(300);
        console.log('Input filled near label:', label);
        return true;
      }
    } catch (e) {
      console.log(`Could not fill near label "${label}":`, e.message);
    }
  }

  const inputs = frame.locator('input');
  const count = await inputs.count().catch(() => 0);
  console.log('Fallback input scan count:', count);

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);

    try {
      const visible = await input.isVisible({ timeout: 500 }).catch(() => false);
      const enabled = await input.isEnabled({ timeout: 500 }).catch(() => false);
      const type = await input.getAttribute('type').catch(() => '');
      const lowerType = String(type || '').toLowerCase();

      if (
        visible &&
        enabled &&
        !['radio', 'checkbox', 'hidden', 'submit', 'button'].includes(lowerType)
      ) {
        await input.fill('');
        await input.type(stringValue, { delay: 50 });
        await frame.waitForTimeout(300);
        console.log(`Fallback input filled at index ${i}`);
        return true;
      }
    } catch (e) {
      console.log(`Fallback input ${i} failed:`, e.message);
    }
  }

  return false;
}

async function clickCalculate(frame) {
  const candidates = [
    frame.getByText(/^Bereken$/i).first(),
    frame.getByRole('button', { name: /bereken/i }).first(),
    frame.locator('text=Bereken').first()
  ];

  for (let i = 0; i < candidates.length; i++) {
    const locator = candidates[i];
    try {
      const visible = await locator.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`Calculate locator ${i} visible=${visible}`);
      if (visible) {
        await locator.click({ force: true, timeout: 5000 });
        console.log('Bereken button clicked');
        return true;
      }
    } catch (e) {
      console.log(`Calculate locator ${i} failed:`, e.message);
    }
  }

  return false;
}

async function selectRegion(frame, regionText) {
  console.log('Trying to select region:', regionText);

  const triggers = [
    frame.locator('label:has-text("Bereken voor")').locator('xpath=following::*[@role="combobox" or self::div or self::button][1]').first(),
    frame.getByRole('combobox').first(),
    frame.locator('text=Bereken voor').first(),
    frame.locator('label:has-text("Bereken voor")').first()
  ];

  let opened = false;

  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    try {
      const visible = await trigger.isVisible({ timeout: 1500 }).catch(() => false);
      console.log(`Region trigger ${i} visible=${visible}`);

      if (visible) {
        await trigger.click({ force: true, timeout: 5000 }).catch((e) => {
          console.log(`Region trigger ${i} click failed:`, e.message);
        });

        await frame.waitForTimeout(800);
        opened = true;
        console.log(`Region dropdown opened via trigger ${i}`);
        break;
      }
    } catch (e) {
      console.log(`Region trigger ${i} error:`, e.message);
    }
  }

  if (!opened) {
    console.log('Could not open region dropdown');
    return false;
  }

  const optionLocators = [
    frame.getByText(new RegExp(`^${regionText}$`, 'i')).first(),
    frame.locator(`text=${regionText}`).first(),
    frame.locator(`[role="option"]:has-text("${regionText}")`).first(),
    frame.locator(`li:has-text("${regionText}")`).first(),
    frame.locator(`div:has-text("${regionText}")`).first()
  ];

  for (let i = 0; i < optionLocators.length; i++) {
    const option = optionLocators[i];
    try {
      const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`Region option ${i} visible=${visible}`);

      if (visible) {
        const txt = await option.textContent().catch(() => '');
        console.log(`Clicking region option ${i}:`, txt);

        await option.click({ force: true, timeout: 5000 });
        await frame.waitForTimeout(800);
        console.log('Region selected successfully');
        return true;
      }
    } catch (e) {
      console.log(`Region option ${i} error:`, e.message);
    }
  }

  console.log('Region option not found:', regionText);
  return false;
}

app.get('/', (req, res) => {
  res.send('Backend werkt!');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/calculate', async (req, res) => {
  console.log('====================================');
  console.log('🔥 /calculate endpoint aangeroepen');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('====================================');

  const {
    region,
    propertyType,
    ownAndOnlyHome,
    price,
    purchaseMode,
    kernstad
  } = req.body;

  const mappedRegion = mapRegion(region);
  const regionOptions = getRegionOptions(mappedRegion);
  const mappedPropertyType = mapPropertyType(propertyType);
  const mappedPurchaseMode = mapPurchaseMode(purchaseMode);
  const parsedOwnAndOnlyHome = parseBoolean(ownAndOnlyHome);
  const parsedKernstad = parseBoolean(kernstad);
  const normalizedPrice = normalizePrice(price);

  if (!mappedRegion) {
    return res.status(400).json({ success: false, error: 'Ongeldige region' });
  }
  if (!mappedPropertyType) {
    return res.status(400).json({ success: false, error: 'Ongeldig propertyType' });
  }
  if (parsedOwnAndOnlyHome === null) {
    return res.status(400).json({ success: false, error: 'Ongeldige ownAndOnlyHome' });
  }
  if (!mappedPurchaseMode) {
    return res.status(400).json({ success: false, error: 'Ongeldige purchaseMode' });
  }
  if (!normalizedPrice) {
    return res.status(400).json({ success: false, error: 'Ongeldige prijs' });
  }
  if (
    mappedPurchaseMode === 'Aankoop met registratierechten' &&
    parsedKernstad === null
  ) {
    return res.status(400).json({ success: false, error: 'Ongeldige kernstad' });
  }

  let browser;

  try {
    console.log('1. Launch browser');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    browser.on('disconnected', () => {
      console.log('⚠️ Browser disconnected');
    });

    console.log('Browser version:', await browser.version());

    console.log('2. New page');
    const page = await browser.newPage();

    page.on('console', msg => {
      console.log('PAGE LOG:', msg.text());
    });

    page.on('pageerror', err => {
      console.log('PAGE ERROR:', err.message);
    });

    page.on('requestfailed', request => {
      console.log('REQUEST FAILED:', request.url(), request.failure()?.errorText);
    });

    page.on('response', response => {
      if (response.status() >= 400) {
        console.log('BAD RESPONSE:', response.status(), response.url());
      }
    });

    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);

    console.log('3. Goto calculator');
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });

    console.log('4. Accept cookies');
    await page.waitForTimeout(3000);
    await acceptCookies(page);

    console.log('5. Find calculator frame');
    const frame = await getCalculatorFrame(page);
    if (!frame) {
      throw new Error('Calculator iframe niet gevonden');
    }

    console.log('5b. Waiting for calculator content...');
    await page.waitForTimeout(8000);

    const frameBody = await frame.locator('body').textContent().catch(() => '');
    console.log('FRAME BODY AFTER WAIT:', String(frameBody || '').slice(0, 2000));

    const allLabels = await frame.locator('label').allTextContents().catch(() => []);
    console.log(
      'ALL LABELS:',
      allLabels.map(t => normalizeSpaces(t)).filter(Boolean)
    );

    const radioCount = await frame.locator('input[type="radio"]').count().catch(() => 0);
    console.log('RADIO COUNT:', radioCount);

    await dumpFrameDebug(frame);

    console.log('6. Select region:', mappedRegion);
    console.log('regionOptions =', regionOptions);

    let regionClicked = false;
    for (const option of regionOptions) {
      regionClicked = await selectRegion(frame, option);
      if (regionClicked) break;
    }

    console.log('regionClicked =', regionClicked);
    if (!regionClicked) {
      throw new Error(`Kon regio niet selecteren: ${mappedRegion}`);
    }

    console.log('7. Select property type:', mappedPropertyType);
    let propertyClicked = await clickRadioByText(frame, [mappedPropertyType]);

    if (!propertyClicked) {
      console.log('7b. Property fallback by fieldset index');
      const propertyIndex = mappedPropertyType === 'Woning / appartement' ? 0 : 1;
      propertyClicked = await clickRadioInFieldsetByIndex(frame, 1, propertyIndex);
    }

    console.log('propertyClicked =', propertyClicked);
    if (!propertyClicked) {
      throw new Error(`Kon propertyType niet selecteren: ${mappedPropertyType}`);
    }

    console.log('8. Select own and only home:', parsedOwnAndOnlyHome);
    let ownHomeClicked = await clickRadioByText(frame, [parsedOwnAndOnlyHome ? 'Ja' : 'Nee']);

    if (!ownHomeClicked) {
      console.log('8b. Own home fallback by fieldset index');
      ownHomeClicked = await clickRadioInFieldsetByIndex(
        frame,
        2,
        parsedOwnAndOnlyHome ? 0 : 1
      );
    }

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
    let purchaseModeClicked = await clickRadioByText(frame, [mappedPurchaseMode]);

    if (!purchaseModeClicked) {
      console.log('10b. Purchase mode fallback by fieldset index');
      const purchaseIndex =
        mappedPurchaseMode === 'Aankoop met registratierechten' ? 0 :
        mappedPurchaseMode === 'Aankoop met BTW' ? 1 : 2;

      purchaseModeClicked = await clickRadioInFieldsetByIndex(frame, 3, purchaseIndex);
    }

    console.log('purchaseModeClicked =', purchaseModeClicked);
    if (!purchaseModeClicked) {
      throw new Error(`Kon purchaseMode niet selecteren: ${mappedPurchaseMode}`);
    }

    if (mappedPurchaseMode === 'Aankoop met registratierechten') {
      console.log('11. Select kernstad:', parsedKernstad);
      let kernstadClicked = await clickRadioByText(frame, [parsedKernstad ? 'Ja' : 'Nee']);

      if (!kernstadClicked) {
        console.log('11b. Kernstad fallback by fieldset index');
        kernstadClicked = await clickRadioInFieldsetByIndex(
          frame,
          4,
          parsedKernstad ? 0 : 1
        );
      }

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

    console.log('====================================');
    console.log('FULL RESULT TEXT START');
    console.log(frameText);
    console.log('FULL RESULT TEXT END');
    console.log('====================================');

    const resultText = frameText || '';
    const totalCost = extractTotal(resultText);
    const registrationTax = extractMoney(
      resultText,
      'Registratiebelasting/registratierechten'
    );
    const notaryFee = extractMoney(resultText, 'Ereloon');
    const vat = extractMoney(resultText, 'BTW');

    console.log('15. Parsed result values:');
    console.log('totalCost:', totalCost);
    console.log('registrationTax:', registrationTax);
    console.log('notaryFee:', notaryFee);
    console.log('vat:', vat);

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
    console.error('❌ ERROR OCCURRED');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(() => {});
      console.log('Browser closed');
    }
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server draait op ${HOST}:${PORT}`);
});