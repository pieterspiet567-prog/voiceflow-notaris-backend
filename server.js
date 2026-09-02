const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.use(express.json());

const URL =
  "https://calculator.notaris.be/nl/krediet?token=6ea42f0f-c4a7-5a6c-9307-60d23432dd5f";

const PORT = process.env.PORT || 3000;

async function calculateNotarisKosten(kredietbedrag) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

    console.log("Calculator openen...");

    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(3000);

    console.log("URL:", page.url());

    /*
     * Debug: toon alle inputs
     */
    const inputInfo = await page.locator("input").evaluateAll(inputs =>
      inputs.map((el, index) => ({
        index,
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        value: el.value
      }))
    );

    console.log("INPUTS:", inputInfo);

    /*
     * Zoek zichtbare tekst/number inputs.
     */
    const inputs = page.locator(
      'input[type="text"], input[type="number"], input:not([type])'
    );

    const count = await inputs.count();

    console.log("Aantal bedragvelden:", count);

    if (count === 0) {
      throw new Error("Geen invulvelden gevonden");
    }

    /*
     * Vul eerste bruikbare bedragveld.
     */
    let ingevuld = false;

    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);

      try {
        if (!(await input.isVisible())) continue;

        await input.click();

        await input.fill("");

        await input.fill(String(kredietbedrag));

        console.log("Bedrag ingevuld in input", i);

        ingevuld = true;
        break;

      } catch (err) {
        console.log(
          `Input ${i} kon niet ingevuld worden:`,
          err.message
        );
      }
    }

    if (!ingevuld) {
      throw new Error("Kredietbedrag kon niet ingevuld worden");
    }

    await page.waitForTimeout(1000);

    /*
     * Zoek alle radio-knoppen.
     */
    const radios = page.locator('input[type="radio"]');

    const radioCount = await radios.count();

    console.log("Aantal radio buttons:", radioCount);

    /*
     * Selecteer eerste optie per groep.
     *
     * Bij de oude calculator waren dit de Ja-keuzes.
     */
    const handledNames = new Set();

    for (let i = 0; i < radioCount; i++) {
      const radio = radios.nth(i);

      const name = await radio.getAttribute("name");

      if (!name || handledNames.has(name)) {
        continue;
      }

      handledNames.add(name);

      const group = page.locator(
        `input[type="radio"][name="${name}"]`
      );

      const groupCount = await group.count();

      console.log(
        `Radio groep "${name}" bevat ${groupCount} opties`
      );

      /*
       * Probeer eerst Ja.
       */
      let selected = false;

      for (let j = 0; j < groupCount; j++) {
        const option = group.nth(j);

        const value =
          ((await option.getAttribute("value")) || "")
            .toLowerCase();

        const id = await option.getAttribute("id");

        let label = "";

        if (id) {
          try {
            label = await page
              .locator(`label[for="${id}"]`)
              .innerText();
          } catch {}
        }

        console.log(
          "Radio:",
          name,
          value,
          label
        );

        if (
          label.toLowerCase().includes("ja") ||
          value === "ja" ||
          value === "yes" ||
          value === "true"
        ) {
          try {
            await option.check({
              force: true
            });

            selected = true;

            console.log(
              `Ja gekozen bij ${name}`
            );

            break;

          } catch {}
        }
      }

      /*
       * Geen Ja gevonden:
       * selecteer eerste optie.
       */
      if (!selected && groupCount > 0) {
        try {
          await group.first().check({
            force: true
          });

          console.log(
            `Eerste optie gekozen bij ${name}`
          );

        } catch {}
      }
    }

    await page.waitForTimeout(1000);

    /*
     * Zoek knop.
     */
    const buttons = page.locator("button");

    const buttonCount = await buttons.count();

    console.log("BUTTONS:", buttonCount);

    let berekend = false;

    for (let i = 0; i < buttonCount; i++) {
      const button = buttons.nth(i);

      try {
        if (!(await button.isVisible())) continue;

        const text =
          (await button.innerText())
            .trim()
            .toLowerCase();

        console.log(`Button ${i}: "${text}"`);

        if (
          text.includes("bereken") ||
          text.includes("volgende")
        ) {
          await button.click();

          console.log(
            "Knop geklikt:",
            text
          );

          berekend = true;

          break;
        }

      } catch {}
    }

    if (!berekend) {
      /*
       * Mogelijk is formulier automatisch.
       */
      console.log(
        "Geen Bereken-knop gevonden. Resultaat controleren..."
      );
    }

    await page.waitForTimeout(4000);

    /*
     * Complete tekst uitlezen.
     */
    const bodyText =
      await page.locator("body").innerText();

    console.log(
      "BODY RESULTAAT:"
    );

    console.log(bodyText);

    /*
     * Eurobedragen zoeken.
     */
    const euroBedragen =
      bodyText.match(
        /€\s?[\d.\s]+(?:,\d{1,2})?/g
      ) || [];

    const cleaned = euroBedragen.map(value =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );

    console.log(
      "GEVONDEN BEDRAGEN:",
      cleaned
    );

    if (cleaned.length === 0) {
      throw new Error(
        "Calculator geopend maar geen resultaten gevonden"
      );
    }

    return {
      success: true,
      kredietbedrag,
      bron: "notaris.be",
      resultaten: {
        totaal: cleaned[0] || null,
        registratiebelasting:
          cleaned[1] || null,
        forfait:
          cleaned[2] || null,
        hypotheekrecht:
          cleaned[3] || null,
        retributie:
          cleaned[4] || null,
        ereloon:
          cleaned[5] || null,
        administratieve_kosten:
          cleaned[6] || null,
        uitgaven_aan_derden:
          cleaned[7] || null,
        recht_op_geschriften:
          cleaned[8] || null,
        btw:
          cleaned[9] || null
      }
    };

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

app.post("/bereken", async (req, res) => {

  const kredietbedrag =
    String(req.body.bedrag || "")
      .replace(/[^\d]/g, "");

  if (!kredietbedrag) {
    return res.status(400).json({
      success: false,
      error: "Geen bedrag meegegeven"
    });
  }

  try {

    console.log(
      "START BEREKENING:",
      kredietbedrag
    );

    const result =
      await calculateNotarisKosten(
        kredietbedrag
      );

    return res.json(result);

  } catch (err) {

    console.error(
      "BEREKENING MISLUKT:",
      err
    );

    return res.status(500).json({
      success: false,
      error: "Berekening mislukt",
      details: err.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Notaris bot API werkt");
});

app.get("/status", (req, res) => {
  res.json({
    success: true,
    status: "online"
  });
});

app.listen(PORT, () => {
  console.log(
    `API draait op poort ${PORT}`
  );
});
