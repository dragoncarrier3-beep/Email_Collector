# Realman Bot — opt-in email collection via GitHub OAuth

Collects community members' emails **with their consent**. A member clicks
"Sign in with GitHub", GitHub asks them to approve sharing their email, and only
then is it saved to your list. This is the compliant way to build an email list
from GitHub — no scraping, no ToS violations.

## Setup

1. **Register an OAuth app** at https://github.com/settings/developers → *New OAuth App*
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/github/callback`
2. Copy `.env.example` to `.env` and fill in the Client ID, Client Secret, and secrets.
3. Install and run:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000 and sign in.

## Viewing / exporting your list

- JSON: `http://localhost:3000/admin/members?token=YOUR_ADMIN_TOKEN`
- CSV:  `http://localhost:3000/admin/members.csv?token=YOUR_ADMIN_TOKEN`

## What it stores

GitHub username, name, avatar, and the email the user consented to share —
in a local `data.json` file. Members can self-delete via the link shown after sign-in.

Members can also add a LinkedIn profile link and a phone number on their own
profile page. Both are optional and only ever typed in by the member. The
LinkedIn link is shown to signed-in members; the phone number appears only in
the admin export.

## What it deliberately does NOT do

It does not scrape profiles, commits, or org member lists to extract emails.
That violates GitHub's Acceptable Use Policies and privacy law. Only
user-consented emails (via OAuth) are collected.
