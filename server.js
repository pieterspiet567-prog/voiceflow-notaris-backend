const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const URL =
  "https://www.notaris.be/rekenmodules/wonen/berekening-van-de-kosten-voor-standaardkrediet";

function cleanAmount(value) {
  if (!value) return null;
  return value.replace(/\s+/g, " ").trim();
}

app.post("/bereken", async (req, res) => {
  const kredietbedrag = String(req.body.bedrag || "").replace(/[^\d]/g, "");

  if (!kredietbedrag) {
    return res.status(400).json({
      error: "Geen bedrag meegegeven"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage({
      viewport: { width: 1650, height: 1000 }
    });

    await page.goto(URL, {
      waitUntil: "networkidle",
      timeout: 60000
    });

    try {
      await page
        .getByText("ALLE COOKIES TOESTAAN", { exact: false })
        .click({ timeout: 3000 });
    } catch {}

    await page.waitForTimeout(1000);

    const inputs = await page.locator("input").all();

    if (inputs.length < 2) {
      throw new Error("Niet genoeg inputvelden gevonden op notaris.be");
    }

    await inputs[0].fill(kredietbedrag);
    await inputs[1].fill(kredietbedrag);

    if (inputs[2]) {
      const aanhorigheden = Math.round(Number(kredietbedrag) * 0.1);
      await inputs[2].fill(String(aanhorigheden));
    }

    await page.getByText("Bereken", { exact: false }).click();

    await page.waitForTimeout(4000);

    const bodyText = await page.locator("body").innerText();

    const euroBedragen = bodyText.match(/€\s?[\d.,]+/g) || [];

    if (euroBedragen.length < 10) {
      throw new Error("Niet alle bedragen gevonden. Gevonden: " + euroBedragen.join(", "));
    }

    return res.json({
      kredietbedrag,
      bron: "notaris.be",
      resultaten: {
        totaal: cleanAmount(euroBedragen[0]),
        registratiebelasting: cleanAmount(euroBedragen[1]),
        forfait: cleanAmount(euroBedragen[2]),
        hypotheekrecht: cleanAmount(euroBedragen[3]),
        retributie: cleanAmount(euroBedragen[4]),
        ereloon: cleanAmount(euroBedragen[5]),
        administratieve_kosten: cleanAmount(euroBedragen[6]),
        uitgaven_aan_derden: cleanAmount(euroBedragen[7]),
        recht_op_geschriften: cleanAmount(euroBedragen[8]),
        btw: cleanAmount(euroBedragen[9])
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: "Berekening mislukt",
      details: err.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get("/", (req, res) => {
  res.send("Notaris bot API werkt");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API draait op poort ${PORT}`);
});

