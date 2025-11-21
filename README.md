# poidh-cron

A tiny Bun/TypeScript job that signs and sends a POST to your POIDH server's `/updatePrice` endpoint. Requests are HMAC-SHA256 signed with your API secret and include `X-API-Key`, `X-Signature`, and `X-Timestamp` headers.

## Prerequisites
- Bun v1.2+ (recommended) or Node 18+ with `npx tsx`
- Access to your POIDH server base URL and API credentials

## Setup
1) Install dependencies:
   ```bash
   bun install
   ```
2) Provide environment variables in `.env` (preferred) or `.env.local` (used when `.env` is missing):
   ```env
   SERVER_URL=https://your-server.example.com
   SERVER_API_KEY=pk_live_...
   SERVER_SECRET=sk_live_...
   ```

## Running the job
- One-off run (prints response payload on success):
  ```bash
  bun run updatePrice
  ```
- Equivalent without Bun:
  ```bash
  npx tsx ./jobs/updatePrices.ts
  ```

## How signing works
- Timestamp: current Unix time (seconds) sent as `X-Timestamp`.
- Canonical string: `POST|/updatePrice|<timestamp>|{}` (empty JSON body).
- Signature: HMAC-SHA256 of the canonical string using `SERVER_SECRET`, hex encoded, sent as `X-Signature`.
- API key: `SERVER_API_KEY` sent as `X-API-Key`.

## Scheduling
Add your preferred scheduler once you've verified it runs locally, e.g. with cron:
```cron
*/15 * * * * cd /path/to/poidh-cron && PATH="$HOME/.bun/bin:$PATH" bun run updatePrice >> /var/log/poidh-cron.log 2>&1
```
Adjust the cadence, working directory, and log location for your environment.

## Development notes
- Source: `jobs/updatePrices.ts`
- Axios handles the POST; the script exits with code 0 on success and 1 on failure while logging the server response.
