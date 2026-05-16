import fetch from "node-fetch";

const CG_BASE = "https://api.coingecko.com/api/v3";

function cgFetch(url) {
  return fetch(url, {
    headers: {
      "x-cg-demo-api-key": process.env.COINGECKO_API_KEY
    }
  });
}

/* ============================
   Single coin price
============================ */

export async function getCoinPrice(coinId) {
  const url = `${CG_BASE}/simple/price?ids=${coinId}&vs_currencies=usd`;

  const res = await cgFetch(url);
  if (!res.ok) throw new Error("CoinGecko request failed");

  const data = await res.json();

  if (!data[coinId]) {
    throw new Error("Coin not found");
  }

  return data[coinId].usd;
}

/* ============================
   Search coins
============================ */

export async function searchCoin(query) {
  const res = await cgFetch(`${CG_BASE}/search?query=${query}`);
  if (!res.ok) throw new Error("Search failed");

  const data = await res.json();
  return data.coins.slice(0, 5);
}

/* ============================
   Multi-coin price fetcher (large batches)
============================ */

export async function getMultiCoinPricesLarge(coinIds) {
  const chunks = [];

  for (let i = 0; i < coinIds.length; i += 200) {
    chunks.push(coinIds.slice(i, i + 200));
  }

  let result = {};

  for (const chunk of chunks) {
    const ids = chunk.join(",");

    const url = `${CG_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

    const res = await cgFetch(url);
    if (!res.ok) throw new Error("Failed to fetch prices");

    const data = await res.json();
    result = { ...result, ...data };
  }

  return result;
}
