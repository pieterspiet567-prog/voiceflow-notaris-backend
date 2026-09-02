const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const NOTARIS_PAGE =
  "https://www.notaris.be/rekenmodules/wonen/kosten-berekenen-voor-een-standaardkrediet";

const PORT = process.env.PORT || 3000;

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });
  }

  return browser;
}

function cleanAmount(value) {
  if (!value) return null;

  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function acceptCookies(page) {
  const possibleButtons = [
    /alle cookies toestaan/i,
    /accepteer alle cookies/i,
    /alles accepteren/i,
    /accept all/i
  ];

  for (const text of possibleButtons) {
    try {
      const button = page.getByRole("button", { name: text }).first();

      if (await button.isVisible({ timeout: 1000 })) {
        await button.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch {}
  }
}

async function getCalculatorUrl(page) {
  await page.goto(NOTARIS_PAGE, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await acceptCookies(page);

  const calculatorLink = page.locator(
    'a[href*="calculator.notaris.be"]'
  ).first();

  await calculatorLink.waitFor({
    state: "attached",
    timeout: 15000
  });

  const href = await calculatorLink.getAttribute("href");

  if (!href) {
    throw new Error("Calculator-link niet gevonden op notaris.be");
  }

  return href;
}

async function fillAmount(page, kredietbedrag) {
  /*
   * Eerst proberen we het veld op basis van labels / aria-labels /
   * placeholders te vinden.
   */
  const selectors = [
    'input[name*="krediet" i]',
    'input[id*="krediet" i]',
    'input[placeholder*="krediet" i]',
    'input[aria-label*="krediet" i]',
    'input[name*="bedrag" i]',
    'input[id*="bedrag" i]',
    'input[placeholder*="bedrag" i]',
    'input[aria-label*="bedrag" i]',
    'input[type="number"]'
  ];

  for (const selector of selectors) {
    try {
      const fields = page.locator(selector);
      const count = await fields.count();

      for (let i = 0; i < count; i++) {
        const field = fields.nth(i);

        if (await field.isVisible()) {
          await field.fill(String(kredietbedrag));
          console.log(`Bedrag ingevuld via ${selector}`);
          return true;
        }
      }
    } catch {}
  }

  /*
   * Fallback:
   * zoek alle zichtbare inputs en kies het eerste veld dat
   * geen checkbox/radio/search/etc. is.
   */
  const inputs = page.locator("input");
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);

    try {
      if (!(await input.isVisible())) continue;

      const type = (await input.getAttribute("type")) || "text";

      if (
        [
          "hidden",
          "checkbox",
          "radio",
          "submit",
          "button",
          "search"
        ].includes(type.toLowerCase())
      ) {
        continue;
      }

      await input.fill(String(kredietbedrag));

      console.log(`Bedrag ingevuld in input ${i}`);
      return true;
    } catch {}
  }

  return false;
}

async function answerQuestions(page) {
  /*
   * De kredietcalculator kan bijkomende Ja/Nee-vragen tonen.
   * We proberen hier "Ja" te selecteren wanneer vereist.
   */

  const radioGroups = page.locator('input[type="radio"]');
  const radioCount = await radioGroups.count();

  if (radioCount > 0) {
    const handledNames = new Set();

    for (let i = 0; i < radioCount; i++) {
      const radio = radioGroups.nth(i);

      const name = await radio.getAttribute("name");

      if (!name || handledNames.has(name)) continue;

      handledNames.add(name);

      /*
       * Zoek binnen deze groep naar een optie die Ja / yes voorstelt.
       */
      const group = page.locator(`input[type="radio"][name="${name}"]`);
      const groupCount = await group.count();

      let clicked = false;

      for (let j = 0; j < groupCount; j++) {
        const item = group.nth(j);

        const value =
          ((await item.getAttribute("value")) || "").toLowerCase();

        const id = await item.getAttribute("id");

        let labelText = "";

        if (id) {
          try {
            labelText = await page
              .locator(`label[for="${id}"]`)
              .innerText();
          } catch {}
        }

        const combined = `${value} ${labelText}`.toLowerCase();

        if (
          combined.includes("ja") ||
          combined.includes("yes") ||
          value === "true"
        ) {
          try {
            await item.check({ force: true });
            clicked = true;
            break;
          } catch {}
        }
      }

      /*
       * Indien we geen Ja vinden, selecteren we eerste mogelijkheid.
       */
      if (!clicked && groupCount > 0) {
        try {
          await group.first().check({ force: true });
        } catch {}
      }
    }
  }
}

async function clickCalculate(page) {
  const possibleButtons = [
    /bereken/i,
    /berekenen/i,
    /volgende/i,
    /bereken kosten/i
  ];

  for (const name of possibleButtons) {
    try {
      const button = page
        .getByRole("button", { name })
        .filter({ visible: true })
        .first();

      if (await button.isVisible({ timeout: 1000 })) {
        await button.click();

        console.log(`Knop geklikt: ${name}`);

        return true;
      }
    } catch {}
  }

  /*
   * Fallback voor submit-inputs.
   */
  try {
    const submit = page
      .locator('button[type="submit"], input[type="submit"]')
      .first();

    if (await submit.isVisible()) {
      await submit.click();
      return true;
    }
  } catch {}

  return false;
}

function extractEuroAmounts(text) {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/\n+/g, "\n");

  const regex =
    /€\s*[0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{1,2})?|€\s*[0-9]+(?:,[0-9]{1,2})?/g;

  const matches = normalized.match(regex) || [];

  return matches.map(cleanAmount);
}

async function calculateNotarisKosten(kredietbedrag) {
  const browserInstance = await getBrowser();

  const context = await browserInstance.newContext({
    viewport: {
      width: 1600,
      height: 1000
    },
    locale: "nl-BE"
  });

  const page = await context.newPage();

  try {
    console.log("Notaris-pagina openen...");

    const calculatorUrl = await getCalculatorUrl(page);

    console.log("Calculator gevonden:", calculatorUrl);

    await page.goto(calculatorUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(1500);

    await acceptCookies(page);

    console.log("Calculator geopend:", page.url());

    /*
     * Bedrag invullen
     */
    const amountFilled = await fillAmount(
      page,
      kredietbedrag
    );

    if (!amountFilled) {
      throw new Error(
        "Geen veld voor het kredietbedrag gevonden"
      );
    }

    await page.waitForTimeout(500);

    /*
     * Eventuele bijkomende vragen beantwoorden.
     */
    await answerQuestions(page);

    await page.waitForTimeout(500);

    /*
     * Berekenen
     */
    const clicked = await clickCalculate(page);

    if (!clicked) {
      throw new Error(
        "Bereken-knop niet gevonden op de calculator"
      );
    }

    /*
     * Wachten tot resultaat geladen is.
     */
    await page.waitForTimeout(3000);

    /*
     * Sommige calculators laden resultaten dynamisch.
     */
    try {
      await page.waitForLoadState("networkidle", {
        timeout: 5000
      });
    } catch {}

    const bodyText = await page.locator("body").innerText();

    console.log(
      "Resultaattekst:",
      bodyText.substring(0, 3000)
    );

    const euroBedragen = extractEuroAmounts(bodyText);

    console.log("Eurobedragen:", euroBedragen);

    if (euroBedragen.length === 0) {
      throw new Error(
        "Geen bedragen gevonden in resultaat van Notaris.be"
      );
    }

    /*
     * We proberen de resultaten ook op hun naam te herkennen.
     */
    function findAmountAfter(label) {
      const escaped = label.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const regex = new RegExp(
        `${escaped}[\\s\\S]{0,100}?(€\\s*[\\d.\\s]+(?:,\\d{1,2})?)`,
        "i"
      );

      const match = bodyText.match(regex);

      return match ? cleanAmount(match[1]) : null;
    }

    const resultaten = {
      totaal:
        findAmountAfter("Totaal") ||
        euroBedragen[0] ||
        null,

      registratiebelasting:
        findAmountAfter("Registratiebelasting") ||
        findAmountAfter("Registratierecht") ||
        euroBedragen[1] ||
        null,

      forfait:
        findAmountAfter("Forfait") ||
        euroBedragen[2] ||
        null,

      hypotheekrecht:
        findAmountAfter("Hypotheekrecht") ||
        euroBedragen[3] ||
        null,

      retributie:
        findAmountAfter("Retributie") ||
        euroBedragen[4] ||
        null,

      ereloon:
        findAmountAfter("Ereloon") ||
        euroBedragen[5] ||
        null,

      administratieve_kosten:
        findAmountAfter("Administratieve kosten") ||
        euroBedragen[6] ||
        null,

      uitgaven_aan_derden:
        findAmountAfter("Uitgaven aan derden") ||
        euroBedragen[7] ||
        null,

      recht_op_geschriften:
        findAmountAfter("Recht op geschriften") ||
        euroBedragen[8] ||
        null,

      btw:
        findAmountAfter("BTW") ||
        euroBedragen[9] ||
        null
    };

    return {
      success: true,
      kredietbedrag,
      bron: "notaris.be",
      calculatorUrl: page.url(),
      resultaten
    };
  } finally {
    await context.close();
  }
}

/*
 * API
 */

app.post("/bereken", async (req, res) => {
  const kredietbedrag = String(
    req.body.bedrag || ""
  ).replace(/[^\d]/g, "");

  if (!kredietbedrag) {
    return res.status(400).json({
      success: false,
      error: "Geen bedrag meegegeven"
    });
  }

  try {
    console.log(
      `Berekening gestart voor €${kredietbedrag}`
    );

    const result = await calculateNotarisKosten(
      kredietbedrag
    );

    console.log("Berekening gelukt");

    return res.json(result);
  } catch (err) {
    console.error("BEREKENING MISLUKT:", err);

    return res.status(500).json({
      success: false,
      error: "Berekening mislukt",
      details: err.message
    });
  }
});

/*
 * Health check
 */

app.get("/", (req, res) => {
  res.send("Notaris bot API werkt");
});

app.get("/status", (req, res) => {
  res.json({
    success: true,
    status: "online",
    browserConnected:
      browser?.isConnected() || false
  });
});

const server = app.listen(PORT, () => {
  console.log(`API draait op poort ${PORT}`);
});

/*
 * Browser netjes sluiten
 */

async function shutdown() {
  console.log("Server afsluiten...");

  server.close();

  if (browser) {
    await browser.close();
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
