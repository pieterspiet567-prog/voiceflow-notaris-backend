const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const CALCULATOR_URL =
  "https://www.notaris.be/rekenmodules/wonen/aankoopkosten-van-een-woning-en/bouwgrond-berekenen";

/*
|--------------------------------------------------------------------------
| INSTELLINGEN
|--------------------------------------------------------------------------
*/

const CACHE_TTL = 5 * 60 * 1000; // 5 minuten
const MAX_CONCURRENT = 1;

let browser = null;
let activeRequests = 0;

const waitingQueue = [];
const cache = new Map();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function normalizeSpaces(text = "") {
  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();

    if (
      ["true", "ja", "yes", "1"].includes(v)
    ) {
      return true;
    }

    if (
      ["false", "nee", "no", "0"].includes(v)
    ) {
      return false;
    }
  }

  return null;
}

function normalizePrice(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  let cleaned = String(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const number = Number(cleaned);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return null;
  }

  return String(Math.round(number));
}

function mapRegion(region) {
  const r = String(region || "")
    .trim()
    .toLowerCase();

  if (
    [
      "vlaanderen",
      "vlaams gewest",
      "vlaams-brabant",
      "antwerpen",
      "limburg",
      "oost-vlaanderen",
      "west-vlaanderen",
      "flanders",
      "vl"
    ].includes(r)
  ) {
    return "Vlaanderen";
  }

  if (
    [
      "brussel",
      "brussels",
      "bruxelles",
      "brussels hoofdstedelijk gewest",
      "br"
    ].includes(r)
  ) {
    return "Brussel";
  }

  if (
    [
      "wallonië",
      "wallonie",
      "wallonia",
      "waals gewest",
      "henegouwen",
      "luik",
      "luxemburg",
      "namen",
      "waals-brabant",
      "wal"
    ].includes(r)
  ) {
    return "Wallonië";
  }

  return null;
}

function mapPropertyType(propertyType) {
  if (!propertyType) {
    return null;
  }

  const p = String(propertyType)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (
    [
      "woning / appartement",
      "woning/appartement",
      "woning appartement",
      "woning",
      "appartement"
    ].includes(p)
  ) {
    return "Woning / appartement";
  }

  if (
    [
      "bouwgrond",
      "grond"
    ].includes(p)
  ) {
    return "Bouwgrond";
  }

  return null;
}

function mapPurchaseMode(purchaseMode) {
  const p = String(purchaseMode || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (
    [
      "registratierechten",
      "aankoop met registratierechten",
      "registratiebelasting"
    ].includes(p)
  ) {
    return "Aankoop met registratierechten";
  }

  if (
    [
      "btw",
      "aankoop met btw"
    ].includes(p)
  ) {
    return "Aankoop met BTW";
  }

  if (
    [
      "grond_registratierechten_gebouw_btw",
      "aankoop grond met registratierechten + gebouw btw",
      "grond+gebouw",
      "combi"
    ].includes(p)
  ) {
    return "Aankoop grond met registratierechten + gebouw BTW";
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| CACHE
|--------------------------------------------------------------------------
*/

function getCacheKey(data) {
  return JSON.stringify(data);
}

function getCached(data) {
  const key = getCacheKey(data);

  const cached = cache.get(key);

  if (!cached) {
    return null;
  }

  if (
    Date.now() - cached.timestamp >
    CACHE_TTL
  ) {
    cache.delete(key);
    return null;
  }

  console.log("⚡ Cache hit");

  return cached.result;
}

function setCached(data, result) {
  cache.set(
    getCacheKey(data),
    {
      timestamp: Date.now(),
      result
    }
  );
}

/*
|--------------------------------------------------------------------------
| REQUEST QUEUE
|--------------------------------------------------------------------------
*/

async function waitForSlot() {
  if (
    activeRequests <
    MAX_CONCURRENT
  ) {
    activeRequests++;
    return;
  }

  await new Promise(resolve => {
    waitingQueue.push(resolve);
  });

  activeRequests++;
}

function releaseSlot() {
  activeRequests = Math.max(
    0,
    activeRequests - 1
  );

  if (
    waitingQueue.length > 0 &&
    activeRequests <
      MAX_CONCURRENT
  ) {
    const next =
      waitingQueue.shift();

    next();
  }
}

/*
|--------------------------------------------------------------------------
| BROWSER
|--------------------------------------------------------------------------
*/

async function getBrowser() {
  if (
    !browser ||
    !browser.isConnected()
  ) {
    console.log(
      "🚀 Chromium starten..."
    );

    browser =
      await chromium.launch({
        headless: true,

        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu"
        ]
      });

    console.log(
      "✅ Chromium gestart"
    );
  }

  return browser;
}

/*
|--------------------------------------------------------------------------
| COOKIES
|--------------------------------------------------------------------------
*/

async function acceptCookies(page) {
  const candidates = [
    page
      .getByRole(
        "button",
        {
          name:
            /alle cookies toestaan/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /accepteren/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /accept/i
        }
      )
      .first(),

    page
      .getByText(
        /alle cookies toestaan/i
      )
      .first()
  ];

  for (
    const candidate
    of candidates
  ) {
    try {
      if (
        await candidate
          .isVisible({
            timeout: 500
          })
          .catch(
            () => false
          )
      ) {
        await candidate.click({
          force: true,
          timeout: 1500
        });

        console.log(
          "🍪 Cookies geaccepteerd"
        );

        return true;
      }
    } catch {}
  }

  return false;
}

/*
|--------------------------------------------------------------------------
| CALCULATOR FRAME
|--------------------------------------------------------------------------
*/

async function getCalculatorFrame(
  page
) {
  const existing =
    page
      .frames()
      .find(frame =>
        frame
          .url()
          .includes(
            "calculator.notaris.be"
          )
      );

  if (existing) {
    return existing;
  }

  console.log(
    "⏳ Wachten op calculator..."
  );

  try {
    await page.waitForSelector(
      'iframe[src*="calculator.notaris.be"]',
      {
        timeout: 8000
      }
    );
  } catch {}

  const frames =
    page.frames();

  const frame =
    frames.find(f =>
      f
        .url()
        .includes(
          "calculator.notaris.be"
        )
    );

  return frame || null;
}

/*
|--------------------------------------------------------------------------
| REGIO SELECTEREN
|--------------------------------------------------------------------------
*/

async function selectRegion(
  frame,
  region
) {
  console.log(
    "Regio:",
    region
  );

  /*
   * Native select
   */

  const selects =
    frame.locator(
      "select"
    );

  const count =
    await selects.count();

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const select =
      selects.nth(i);

    try {
      await select.selectOption({
        label: region
      });

      console.log(
        "✅ Regio geselecteerd"
      );

      return true;
    } catch {}
  }

  /*
   * Combobox fallback
   */

  try {
    const combo =
      frame
        .getByRole(
          "combobox"
        )
        .first();

    if (
      await combo
        .isVisible({
          timeout: 500
        })
        .catch(
          () => false
        )
    ) {
      await combo.selectOption({
        label: region
      });

      return true;
    }
  } catch {}

  return false;
}

/*
|--------------------------------------------------------------------------
| RADIO BUTTONS
|--------------------------------------------------------------------------
*/

async function clickRadioByLabel(
  frame,
  labelText
) {
  console.log(
    "Optie kiezen:",
    labelText
  );

  /*
   * Eerst label
   */

  try {
    const label =
      frame
        .locator("label")
        .filter({
          hasText:
            labelText
        })
        .first();

    if (
      await label.count()
    ) {
      await label.click({
        force: true,
        timeout: 2000
      });

      return true;
    }
  } catch {}

  /*
   * Tekst fallback
   */

  try {
    const option =
      frame
        .getByText(
          labelText,
          {
            exact: true
          }
        )
        .first();

    if (
      await option.count()
    ) {
      await option.click({
        force: true,
        timeout: 2000
      });

      return true;
    }
  } catch {}

  return false;
}

/*
|--------------------------------------------------------------------------
| RADIO BIJ SPECIFIEKE VRAAG
|--------------------------------------------------------------------------
*/

async function clickRadioNearQuestion(
  frame,
  question,
  answer
) {
  console.log(
    `${question}: ${answer}`
  );

  try {
    const questionLocator =
      frame
        .getByText(
          new RegExp(
            question,
            "i"
          )
        )
        .first();

    if (
      await questionLocator.count()
    ) {
      const container =
        questionLocator.locator(
          "xpath=ancestor::*[self::div or self::fieldset][1]"
        );

      const answerLabel =
        container
          .locator("label")
          .filter({
            hasText:
              answer
          })
          .first();

      if (
        await answerLabel.count()
      ) {
        await answerLabel.click({
          force: true,
          timeout: 2000
        });

        return true;
      }
    }
  } catch {}

  /*
   * Fallback naar oude methode
   */

  try {
    const xpath =
      `xpath=//*[contains(normalize-space(.),"${question}")]/following::label[normalize-space(.)="${answer}"][1]`;

    const locator =
      frame
        .locator(xpath)
        .first();

    if (
      await locator.count()
    ) {
      await locator.click({
        force: true,
        timeout: 2000
      });

      return true;
    }
  } catch {}

  return clickRadioByLabel(
    frame,
    answer
  );
}

/*
|--------------------------------------------------------------------------
| INPUT INVULLEN
|--------------------------------------------------------------------------
*/

async function fillInputNearLabel(
  frame,
  labels,
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return false;
  }

  const stringValue =
    String(value);

  for (
    const labelText
    of labels
  ) {
    /*
     * Label -> input
     */

    try {
      const label =
        frame
          .locator("label")
          .filter({
            hasText:
              labelText
          })
          .first();

      if (
        await label.count()
      ) {
        const forId =
          await label.getAttribute(
            "for"
          );

        if (forId) {
          const input =
            frame.locator(
              `#${CSS.escape(
                forId
              )}`
            );

          if (
            await input.count()
          ) {
            await input.fill(
              stringValue
            );

            console.log(
              "✅ Input:",
              labelText
            );

            return true;
          }
        }
      }
    } catch {}

    /*
     * XPath fallback
     */

    try {
      const xpath =
        `xpath=//*[contains(normalize-space(.),"${labelText}")]/following::input[1]`;

      const input =
        frame
          .locator(xpath)
          .first();

      if (
        await input.count()
      ) {
        await input.fill(
          stringValue
        );

        console.log(
          "✅ Input:",
          labelText
        );

        return true;
      }
    } catch {}
  }

  return false;
}

/*
|--------------------------------------------------------------------------
| BEREKEN
|--------------------------------------------------------------------------
*/

async function clickCalculate(
  frame
) {
  const candidates = [
    frame
      .getByRole(
        "button",
        {
          name: /^bereken$/i
        }
      )
      .first(),

    frame
      .getByRole(
        "button",
        {
          name: /bereken/i
        }
      )
      .first(),

    frame
      .getByText(
        /^Bereken$/i
      )
      .first()
  ];

  for (
    const button
    of candidates
  ) {
    try {
      if (
        await button
          .isVisible({
            timeout: 500
          })
          .catch(
            () => false
          )
      ) {
        await button.click({
          force: true,
          timeout: 2000
        });

        console.log(
          "🧮 Bereken geklikt"
        );

        return true;
      }
    } catch {}
  }

  return false;
}

/*
|--------------------------------------------------------------------------
| RESULTAAT WACHTEN
|--------------------------------------------------------------------------
*/

async function waitForResult(
  frame
) {
  const candidates = [
    /Het totaal van de kosten/i,
    /Totale kosten/i,
    /Registratiebelasting/i,
    /Ereloon/i
  ];

  for (
    const pattern
    of candidates
  ) {
    try {
      await frame
        .getByText(pattern)
        .last()
        .waitFor({
          state: "visible",
          timeout: 5000
        });

      return true;
    } catch {}
  }

  /*
   * Korte fallback.
   */
  await frame.waitForTimeout(
    500
  );

  return true;
}

/*
|--------------------------------------------------------------------------
| RESULTATEN UITLEZEN
|--------------------------------------------------------------------------
*/

function extractMoney(
  text,
  label
) {
  const source =
    normalizeSpaces(text);

  const escaped =
    label.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const regex =
    new RegExp(
      `${escaped}[\\s:]*€\\s*([\\d.]+,\\d{2})`,
      "i"
    );

  const match =
    source.match(regex);

  return match
    ? `€ ${match[1]}`
    : null;
}

function extractMoneyMultipleLabels(
  text,
  labels
) {
  for (
    const label
    of labels
  ) {
    const result =
      extractMoney(
        text,
        label
      );

    if (result) {
      return result;
    }
  }

  return null;
}

function extractTotal(text) {
  const source =
    normalizeSpaces(text);

  const patterns = [
    /Het totaal van de kosten.*?geraamd op\s*€\s*([\d.]+,\d{2})/i,

    /totaal van de kosten.*?€\s*([\d.]+,\d{2})/i,

    /Totale kosten.*?€\s*([\d.]+,\d{2})/i,

    /Totaal.*?€\s*([\d.]+,\d{2})/i
  ];

  for (
    const regex
    of patterns
  ) {
    const match =
      source.match(regex);

    if (match) {
      return `€ ${match[1]}`;
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| ACTUELE BEREKENING
|--------------------------------------------------------------------------
*/

async function calculateCosts(
  data
) {
  const {
    mappedRegion,
    mappedPropertyType,
    parsedOwnAndOnlyHome,
    mappedPurchaseMode,
    parsedKernstad,
    normalizedPrice,
    normalizedGroundPrice,
    normalizedBuildingPrice
  } = data;

  const browserInstance =
    await getBrowser();

  let context = null;

  try {
    context =
      await browserInstance
        .newContext({
          viewport: {
            width: 1280,
            height: 800
          },

          locale: "nl-BE"
        });

    const page =
      await context.newPage();

    /*
     * Alleen tracking blokkeren.
     *
     * Geen fonts/SVG/etc meer blokkeren,
     * want dat kan de calculator breken.
     */

    await page.route(
      "**/*",
      async route => {
        const url =
          route
            .request()
            .url()
            .toLowerCase();

        if (
          url.includes(
            "google-analytics"
          ) ||
          url.includes(
            "googletagmanager"
          ) ||
          url.includes(
            "doubleclick"
          ) ||
          url.includes(
            "hotjar"
          ) ||
          url.includes(
            "facebook.net"
          )
        ) {
          return route.abort();
        }

        return route.continue();
      }
    );

    page.setDefaultTimeout(
      5000
    );

    page.setDefaultNavigationTimeout(
      15000
    );

    console.log(
      "🌐 Notaris openen"
    );

    await page.goto(
      CALCULATOR_URL,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 15000
      }
    );

    /*
     * Cookies en frame tegelijk proberen.
     */

    await acceptCookies(page);

    const frame =
      await getCalculatorFrame(
        page
      );

    if (!frame) {
      throw new Error(
        "Calculator iframe niet gevonden"
      );
    }

    console.log(
      "✅ Calculator geladen"
    );

    /*
     * REGIO
     */

    const regionSelected =
      await selectRegion(
        frame,
        mappedRegion
      );

    if (!regionSelected) {
      throw new Error(
        `Kon regio niet selecteren: ${mappedRegion}`
      );
    }

    /*
     * TYPE EIGENDOM
     */

    const propertySelected =
      await clickRadioByLabel(
        frame,
        mappedPropertyType
      );

    if (!propertySelected) {
      throw new Error(
        `Kon propertyType niet selecteren: ${mappedPropertyType}`
      );
    }

    /*
     * ENIGE EN EIGEN WONING
     */

    const ownHomeSelected =
      await clickRadioNearQuestion(
        frame,
        "Eigen en enige woning",
        parsedOwnAndOnlyHome
          ? "Ja"
          : "Nee"
      );

    if (!ownHomeSelected) {
      throw new Error(
        "Kon ownAndOnlyHome niet selecteren"
      );
    }

    /*
     * KERNSTAD
     */

    if (
      parsedOwnAndOnlyHome &&
      mappedPurchaseMode ===
        "Aankoop met registratierechten"
    ) {
      const kernstadSelected =
        await clickRadioNearQuestion(
          frame,
          "kernstad",
          parsedKernstad
            ? "Ja"
            : "Nee / weet het niet"
        );

      if (!kernstadSelected) {
        console.log(
          "⚠️ Kernstad niet gevonden"
        );
      }
    }

    /*
     * PRIJS
     */

    const priceFilled =
      await fillInputNearLabel(
        frame,
        [
          "Aankoopbedrag",
          "Aankoopprijs"
        ],
        normalizedPrice
      );

    if (!priceFilled) {
      throw new Error(
        "Kon aankoopbedrag niet invullen"
      );
    }

    /*
     * AANKOOPWIJZE
     */

    const modeSelected =
      await clickRadioByLabel(
        frame,
        mappedPurchaseMode
      );

    if (!modeSelected) {
      throw new Error(
        `Kon purchaseMode niet selecteren: ${mappedPurchaseMode}`
      );
    }

    /*
     * COMBINATIE:
     * grond registratierechten +
     * gebouw BTW
     */

    if (
      mappedPurchaseMode ===
      "Aankoop grond met registratierechten + gebouw BTW"
    ) {
      if (
        normalizedGroundPrice
      ) {
        await fillInputNearLabel(
          frame,
          [
            "Grondprijs",
            "Prijs grond",
            "Aankoopbedrag grond"
          ],
          normalizedGroundPrice
        );
      }

      if (
        normalizedBuildingPrice
      ) {
        await fillInputNearLabel(
          frame,
          [
            "Gebouwprijs",
            "Prijs gebouw",
            "Aankoopbedrag gebouw"
          ],
          normalizedBuildingPrice
        );
      }
    }

    /*
     * BEREKEN
     */

    const clicked =
      await clickCalculate(
        frame
      );

    if (!clicked) {
      throw new Error(
        "Bereken-knop niet gevonden"
      );
    }

    /*
     * Geen vaste 3 seconden meer.
     */

    await waitForResult(
      frame
    );

    /*
     * RESULTAAT
     */

    const resultText =
      await frame
        .locator("body")
        .innerText();

    const totalCost =
      extractTotal(
        resultText
      );

    const registrationTax =
      extractMoneyMultipleLabels(
        resultText,
        [
          "Registratiebelasting/registratierechten",
          "Registratiebelasting",
          "Registratierechten"
        ]
      );

    const annexRights =
      extractMoneyMultipleLabels(
        resultText,
        [
          "Registratierecht op bijlagen",
          "Forfait registratie bijlage(n)"
        ]
      );

    const notaryFee =
      extractMoney(
        resultText,
        "Ereloon"
      );

    const adminCosts =
      extractMoney(
        resultText,
        "Administratieve kosten"
      );

    const thirdPartyCosts =
      extractMoney(
        resultText,
        "Uitgaven aan derden"
      );

    const transcriptionCosts =
      extractMoneyMultipleLabels(
        resultText,
        [
          "Kosten overschrijving",
          "Overschrijvingskosten"
        ]
      );

    const documentRights =
      extractMoney(
        resultText,
        "Recht op geschriften"
      );

    const vat =
      extractMoneyMultipleLabels(
        resultText,
        [
          "BTW",
          "Btw"
        ]
      );

    console.log(
      "✅ Resultaat:",
      {
        totalCost,
        registrationTax,
        notaryFee,
        vat
      }
    );

    return {
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

      disclaimer:
        "Alle berekeningen zijn indicatief en onder voorbehoud via notaris.be."
    };

  } finally {
    /*
     * BELANGRIJK:
     *
     * Alleen context sluiten.
     * Chromium blijft draaien.
     */

    if (context) {
      await context
        .close()
        .catch(() => {});
    }
  }
}

/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {
    res.send(
      "Backend werkt!"
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      browserConnected:
        browser
          ? browser.isConnected()
          : false,
      cacheSize:
        cache.size,
      activeRequests
    });
  }
);

/*
|--------------------------------------------------------------------------
| CALCULATE
|--------------------------------------------------------------------------
*/

app.post(
  "/calculate",
  async (req, res) => {
    console.log(
      "🔥 /calculate",
      new Date().toISOString()
    );

    console.log(
      "Body:",
      JSON.stringify(
        req.body
      )
    );

    const {
      region,
      propertyType,
      ownAndOnlyHome,
      price,
      purchaseMode,
      kernstad,
      groundPrice,
      buildingPrice
    } = req.body;

    /*
     * NORMALISEREN
     */

    const mappedRegion =
      mapRegion(region);

    const mappedPropertyType =
      mapPropertyType(
        propertyType
      );

    const mappedPurchaseMode =
      mapPurchaseMode(
        purchaseMode
      );

    const parsedOwnAndOnlyHome =
      parseBoolean(
        ownAndOnlyHome
      );

    const parsedKernstad =
      parseBoolean(
        kernstad
      );

    const normalizedPrice =
      normalizePrice(
        price
      );

    const normalizedGroundPrice =
      normalizePrice(
        groundPrice
      );

    const normalizedBuildingPrice =
      normalizePrice(
        buildingPrice
      );

    /*
     * VALIDATIE
     */

    if (!mappedRegion) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldige region"
        });
    }

    if (
      !mappedPropertyType
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldig propertyType"
        });
    }

    if (
      parsedOwnAndOnlyHome ===
      null
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldige ownAndOnlyHome"
        });
    }

    if (
      !mappedPurchaseMode
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldige purchaseMode"
        });
    }

    if (!normalizedPrice) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldige prijs"
        });
    }

    if (
      mappedPurchaseMode ===
        "Aankoop met registratierechten" &&
      parsedOwnAndOnlyHome ===
        true &&
      parsedKernstad === null
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Ongeldige kernstad"
        });
    }

    /*
     * DATA VOOR CACHE
     */

    const calculationData = {
      mappedRegion,
      mappedPropertyType,
      parsedOwnAndOnlyHome,
      mappedPurchaseMode,
      parsedKernstad,
      normalizedPrice,
      normalizedGroundPrice,
      normalizedBuildingPrice
    };

    /*
     * CACHE
     */

    const cached =
      getCached(
        calculationData
      );

    if (cached) {
      return res.json({
        ...cached,
        cached: true
      });
    }

    /*
     * MAX 1 PLAYWRIGHT
     * BEREKENING TEGELIJK.
     */

    await waitForSlot();

    try {
      const result =
        await calculateCosts(
          calculationData
        );

      setCached(
        calculationData,
        result
      );

      return res.json({
        ...result,
        cached: false
      });

    } catch (error) {
      console.error(
        "❌ ERROR:",
        error.message
      );

      /*
       * Indien browser gecrasht is:
       * volgende request start
       * automatisch een nieuwe.
       */

      if (
        browser &&
        !browser.isConnected()
      ) {
        browser = null;
      }

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });

    } finally {
      releaseSlot();
    }
  }
);

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `✅ Server draait op poort ${PORT}`
      );
    }
  );

/*
|--------------------------------------------------------------------------
| AFSLUITEN
|--------------------------------------------------------------------------
*/

async function shutdown() {
  console.log(
    "Server afsluiten..."
  );

  server.close();

  if (browser) {
    await browser
      .close()
      .catch(() => {});
  }

  process.exit(0);
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
