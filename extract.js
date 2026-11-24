const { GoogleAuth } = require("google-auth-library");
const { Firecrawl } = require("firecrawl");

const PROMPT = "Extract the contact email and company name";
const SCHEMA = {
  type: "object",
  properties: {
    contactEmail: { type: "string" },
    companyName: { type: "string" },
  },
  required: ["contactEmail", "companyName"],
};

async function sheetsToken() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!process.env.GOOGLE_SPREADSHEET_ID || !keyFile) {
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
  return token;
}

async function readRows(token, spreadsheetId) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:F`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Google Sheets read failed ${response.status}: ${await response.text()}`,
    );
  }

  const body = await response.json();
  const values = body.values ?? [];
  const header = values[0] ?? [];
  const urlIndex = header.indexOf("url");
  if (urlIndex === -1) {
    throw new Error(
      'Spreadsheet is missing a "url" column. Run search.js first.',
    );
  }

  return values.slice(1).map((row) => ({
    url: String(row[urlIndex] ?? "").trim(),
  }));
}

function urlKeys(url) {
  const keys = new Set();
  if (!url) return keys;
  keys.add(url);
  keys.add(url.replace(/\/$/, ""));
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const href = parsed.href.replace(/\/$/, "");
    keys.add(href);
    keys.add(`${parsed.origin}${parsed.pathname}`.replace(/\/$/, ""));
  } catch {
    // Keep the raw string when the cell is not a valid URL.
  }
  return keys;
}

function contactFromDoc(doc) {
  const json = doc.json ?? {};
  return {
    companyName: String(json.companyName ?? "").trim(),
    contactEmail: String(json.contactEmail ?? "").trim(),
  };
}

async function extractContacts(apiKey, urls) {
  const firecrawl = new Firecrawl({ apiKey });
  const job = await firecrawl.batchScrape(urls, {
    options: {
      formats: [{ type: "json", prompt: PROMPT, schema: SCHEMA }],
      onlyMainContent: false,
    },
    ignoreInvalidURLs: true,
    pollInterval: 5,
    timeout: 1800,
  });

  if (job.status === "failed" || job.status === "cancelled") {
    throw new Error(`Firecrawl batch scrape ${job.status}`);
  }

  const byUrl = new Map();
  for (const doc of job.data ?? []) {
    const contact = contactFromDoc(doc);
    for (const key of [
      ...urlKeys(doc.metadata?.sourceURL),
      ...urlKeys(doc.metadata?.url),
    ]) {
      byUrl.set(key, contact);
    }
    const label = doc.metadata?.sourceURL || doc.metadata?.url || "(unknown url)";
    if (doc.metadata?.error) {
      console.log(`${label}`);
      console.log(`  error: ${doc.metadata.error}`);
      continue;
    }
    console.log(label);
    console.log(`  company: ${contact.companyName || "(none)"}`);
    console.log(`  email: ${contact.contactEmail || "(none)"}`);
  }

  console.log(
    `Firecrawl finished ${job.completed ?? job.data?.length ?? 0}/${job.total ?? urls.length} page(s), credits used: ${job.creditsUsed ?? "unknown"}`,
  );
  return byUrl;
}

function lookup(byUrl, url) {
  for (const key of urlKeys(url)) {
    const contact = byUrl.get(key);
    if (contact) return contact;
  }
  return { companyName: "", contactEmail: "" };
}

async function writeContacts(token, spreadsheetId, rows, byUrl) {
  const values = [["company_name", "contact_email"]];
  for (const row of rows) {
    const contact = row.url
      ? lookup(byUrl, row.url)
      : { companyName: "", contactEmail: "" };
    values.push([contact.companyName, contact.contactEmail]);
  }

  const range = `G1:H${values.length}`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Google Sheets update failed ${response.status}: ${await response.text()}`,
    );
  }

  const filled = values.slice(1).filter((row) => row[0] || row[1]).length;
  console.log(
    `Wrote company_name and contact_email for ${values.length - 1} row(s) (${filled} with a value) to spreadsheet ${spreadsheetId}`,
  );
}

async function main() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing FIRECRAWL_API_KEY. Add it to .env, then run: node --env-file=.env extract.js",
    );
    process.exit(1);
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const token = await sheetsToken();
  const rows = await readRows(token, spreadsheetId);
  const urls = [...new Set(rows.map((row) => row.url).filter(Boolean))];
  if (urls.length === 0) {
    throw new Error("The spreadsheet has no website URLs. Run search.js first.");
  }

  console.log(`Extracting contacts for ${urls.length} unique website(s)\n`);
  const byUrl = await extractContacts(apiKey, urls);
  await writeContacts(token, spreadsheetId, rows, byUrl);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
