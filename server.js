const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const URL =
  "https://www.notaris.be/rekenmodules/wonen/berekening-van-de-kosten-voor-standaardkrediet";
const MAX_CONCURRENT_BROWSER_REQUESTS = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;

let browser;
let activeBrowserRequests = 0;
const resultCache = new Map();

function cleanAmount(value) {
  if (!value) return null;
  return value.replace(/\s+/g, " ").trim();
}

async function waitForBrowserSlot() {
  while (activeBrowserRequests >= MAX_CONCURRENT_BROWSER_REQUESTS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  activeBrowserRequests += 1;
}

function getCacheKey(kredietbedrag) {
  return `krediet:${kredietbedrag}`;
}

function getCachedResult(kredietbedrag) {
  const key = getCacheKey(kredietbedrag);
  const cached = resultCache.get(key);

  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }

  return cached.data;
}

function setCachedResult(kredietbedrag, data) {
  resultCache.set(getCacheKey(kredietbedrag), {
    timestamp: Date.now(),
    data
  });
}

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
  }

  return browser;
}

async function calculateNotarisKosten(kredietbedrag) {
  let page;

  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage({
      viewport: { width: 1650, height: 1000 }
    });

    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    try {
      await page
        .getByText("ALLE COOKIES TOESTAAN", { exact: false })
        .click({ timeout: 2000 });
    } catch {}

    const inputs = page.locator("input");
    await inputs.first().waitFor({ state: "visible", timeout: 15000 });

    const inputList = await inputs.all();

    if (inputList.length < 2) {
      throw new Error("Niet genoeg inputvelden gevonden op notaris.be");
    }

    await inputList[0].fill(kredietbedrag);
    await inputList[1].fill(kredietbedrag);

    if (inputList[2]) {
      const aanhorigheden = Math.round(Number(kredietbedrag) * 0.1);
      await inputList[2].fill(String(aanhorigheden));
    }

    await page.getByText("Bereken", { exact: false }).click();

    await page.locator("body").waitFor({ state: "visible", timeout: 15000 });

    const bodyText = await page.locator("body").innerText();
    const euroBedragen = bodyText.match(/€\s?[\d.,]+/g) || [];

    if (euroBedragen.length < 10) {
      throw new Error("Niet alle bedragen gevonden. Gevonden: " + euroBedragen.join(", "));
    }

    return {
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
    };
  } finally {
    if (page) {
      await page.close();
    }
  }
}

app.post("/bereken", async (req, res) => {
  const kredietbedrag = String(req.body.bedrag || "").replace(/[^\d]/g, "");

  if (!kredietbedrag) {
    return res.status(400).json({
      error: "Geen bedrag meegegeven"
    });
  }

  const cached = getCachedResult(kredietbedrag);
  if (cached) {
    return res.json(cached);
  }

  try {
    await waitForBrowserSlot();

    const result = await calculateNotarisKosten(kredietbedrag);
    setCachedResult(kredietbedrag, result);

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: "Berekening mislukt",
      details: err.message
    });
  } finally {
    activeBrowserRequests = Math.max(0, activeBrowserRequests - 1);
  }
});

app.get("/", (req, res) => {
  res.send("Notaris bot API werkt");
});

app.get("/status", (req, res) => {
  res.json({
    activeBrowserRequests,
    cacheSize: resultCache.size,
    maxConcurrentBrowserRequests: MAX_CONCURRENT_BROWSER_REQUESTS
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`API draait op poort ${PORT}`);
});

process.on("SIGINT", async () => {
  server.close();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
