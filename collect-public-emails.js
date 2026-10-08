/**
 * collect-public-emails.js
 *
 * Fetches public emails from GitHub org members (or a list of usernames)
 * using the official GitHub API. Only collects emails that users have
 * explicitly made public on their profile.
 *
 * Usage:
 *   node collect-public-emails.js --org vercel
 *   node collect-public-emails.js --users alice,bob,charlie
 *   node collect-public-emails.js --org vercel --out emails.csv
 *
 * Requires: GITHUB_TOKEN in .env (a Personal Access Token with read:org scope
 * if reading org members, or no special scope for public user lookups)
 */

import "dotenv/config";
import fs from "node:fs";

const { GITHUB_TOKEN } = process.env;
if (!GITHUB_TOKEN) {
  console.error(
    "Missing GITHUB_TOKEN in .env.\n" +
    "Create one at https://github.com/settings/tokens (no special scopes needed for public data;\n" +
    "add read:org scope if the org has private member lists)."
  );
  process.exit(1);
}

// --- Parse CLI args --------------------------------------------------------
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const org = get("--org");
const userList = get("--users");
const outFile = get("--out") || "public-emails.csv";

if (!org && !userList) {
  console.error("Provide --org <orgname> or --users <user1,user2,...>");
  process.exit(1);
}

// --- GitHub API helper -----------------------------------------------------
async function gh(path) {
  const res = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "realman-bot-public-email-collector",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  // Respect rate limits
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? 1);
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
  if (remaining === 0) {
    const wait = Math.max(reset * 1000 - Date.now(), 1000);
    console.log(`Rate limit hit — waiting ${Math.ceil(wait / 1000)}s...`);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

// --- Paginate org members --------------------------------------------------
async function getOrgMembers(orgName) {
  const members = [];
  let page = 1;
  while (true) {
    const batch = await gh(`/orgs/${orgName}/members?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    members.push(...batch.map((m) => m.login));
    console.log(`  fetched page ${page} — ${members.length} members so far`);
    page++;
    if (batch.length < 100) break;
  }
  return members;
}

// --- Fetch one user's public profile ---------------------------------------
async function getUserPublicEmail(login) {
  try {
    const user = await gh(`/users/${login}`);
    return {
      login: user.login,
      name: user.name || "",
      email: user.email || "",        // empty string if not public
      company: user.company || "",
      location: user.location || "",
      profile: `https://github.com/${user.login}`,
    };
  } catch (err) {
    console.warn(`  skipping ${login}: ${err.message}`);
    return null;
  }
}

// --- Main ------------------------------------------------------------------
(async () => {
  let logins = [];

  if (org) {
    console.log(`Fetching members of org: ${org}`);
    logins = await getOrgMembers(org);
    console.log(`Found ${logins.length} members.`);
  } else {
    logins = userList.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`Processing ${logins.length} usernames.`);
  }

  const results = [];
  let withEmail = 0;

  for (let i = 0; i < logins.length; i++) {
    const login = logins[i];
    process.stdout.write(`  [${i + 1}/${logins.length}] @${login} ... `);
    const user = await getUserPublicEmail(login);
    if (!user) { process.stdout.write("error\n"); continue; }

    results.push(user);
    if (user.email) {
      withEmail++;
      process.stdout.write(`✓ ${user.email}\n`);
    } else {
      process.stdout.write("no public email\n");
    }

    // Small delay between requests to be a good API citizen
    await new Promise((r) => setTimeout(r, 200));
  }

  // --- Save CSV (all users) ------------------------------------------------
  const header = "login,name,email,company,location,profile";
  const csv = [
    header,
    ...results.map((r) =>
      ["login", "name", "email", "company", "location", "profile"]
        .map((k) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`)
        .join(",")
    ),
  ].join("\n");

  fs.writeFileSync(outFile, csv);

  // --- Summary -------------------------------------------------------------
  console.log("\n=== Done ===");
  console.log(`Total users checked : ${results.length}`);
  console.log(`With public email   : ${withEmail}`);
  console.log(`Without public email: ${results.length - withEmail}`);
  console.log(`Saved to            : ${outFile}`);

  // Also print just the emails to console
  const emails = results.filter((r) => r.email);
  if (emails.length) {
    console.log("\nPublic emails found:");
    emails.forEach((r) => console.log(`  @${r.login.padEnd(30)} ${r.email}`));
  } else {
    console.log("\nNo public emails found.");
  }
})();
