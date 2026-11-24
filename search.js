const { writeFile } = require("node:fs/promises");
const { GoogleAuth } = require("google-auth-library");

const SEARCHES = [
  {
    id: "hk-domains",
    query: "interior Design Company site:.hk",
    hkOnly: true,
  },
  {
    id: "hong-kong-query",
    query: "interior Design Company Hong Kong",
    hkOnly: false,
  },
];
const COUNTRY = "HK";
const SEARCH_LANG = "en";
const TARGET = 30;
const PAGE_SIZE = 20;
const MAX_OFFSET = 9;
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

async function searchPage(apiKey, query, offset) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("search_lang", SEARCH_LANG);
  url.searchParams.set("count", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("result_filter", "web");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Brave Search returned ${response.status} ${response.statusText}: ${body}`,
    );
  }

  return response.json();
}

function isHkHost(url) {
  try {
    return new URL(url).hostname.endsWith(".hk");
  } catch {
    return false;
  }
}

function collectResults(pages, hkOnly) {
  const seen = new Set();
  const results = [];

  for (const page of pages) {
    for (const item of page.web?.results ?? []) {
      if (!item.url || seen.has(item.url)) continue;
      if (hkOnly && !isHkHost(item.url)) continue;
      seen.add(item.url);
      results.push({
        rank: results.length + 1,
        title: item.title ?? "",
        url: item.url,
        description: item.description ?? "",
      });
      if (results.length === TARGET) return results;
    }
  }

  return results;
}

function logResults(query, results) {
  console.log(
    `Brave web results for "${query}" (country=${COUNTRY}, search_lang=${SEARCH_LANG})`,
  );
  console.log(`${results.length} unique result(s)\n`);

  for (const result of results) {
    console.log(`${result.rank}. ${result.title}`);
    console.log(`   ${result.url}`);
    if (result.description) console.log(`   ${result.description}`);
    console.log("");
  }
}

async function runSearch(apiKey, search) {
  const pages = [];
  let offset = 0;

  while (collectResults(pages, search.hkOnly).length < TARGET && offset <= MAX_OFFSET) {
    const page = await searchPage(apiKey, search.query, offset);
    pages.push(page);

    const more = page.query?.more_results_available === true;
    if (!more) break;
    offset += 1;
  }

  return collectResults(pages, search.hkOnly);
}

async function saveToSpreadsheet(searches) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!spreadsheetId || !keyFile) {
    throw new Error(
      "Missing GOOGLE_SPREADSHEET_ID or GOOGLE_APPLICATION_CREDENTIALS. Add both to .env, share the spreadsheet with the service account email, then rerun.",
    );
  }

  const auth = new GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Google auth did not return an access token.");

  const values = [
    [
      "search_id",
      "query",
      "rank",
      "title",
      "url",
      "description",
      "company_name",
      "contact_email",
    ],
  ];
  for (const search of searches) {
    for (const result of search.results) {
      values.push([
        search.id,
        search.query,
        result.rank,
        result.title,
        result.url,
        result.description,
        "",
        "",
      ]);
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values`;

  const clear = await fetch(`${base}/A:H:clear`, { method: "POST", headers });
  if (!clear.ok) {
    throw new Error(
      `Google Sheets clear failed ${clear.status}: ${await clear.text()}`,
    );
  }

  const update = await fetch(`${base}/A1?valueInputOption=RAW`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ values }),
  });
  if (!update.ok) {
    throw new Error(
      `Google Sheets update failed ${update.status}: ${await update.text()}`,
    );
  }

  console.log(
    `Wrote ${values.length - 1} row(s) to spreadsheet ${spreadsheetId}`,
  );
}

async function main() {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing BRAVE_API_KEY. Copy .env.example to .env, add your token, then run: node --env-file=.env search.js",
    );
    process.exit(1);
  }

  const searches = [];
  for (const search of SEARCHES) {
    const results = await runSearch(apiKey, search);
    logResults(search.query, results);
    searches.push({
      id: search.id,
      query: search.query,
      country: COUNTRY,
      searchLang: SEARCH_LANG,
      count: results.length,
      results,
    });
  }

  await writeFile(
    "results.json",
    JSON.stringify({ country: COUNTRY, searchLang: SEARCH_LANG, searches }, null, 2) +
      "\n",
  );
  console.log("Wrote results.json");
  await saveToSpreadsheet(searches);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
