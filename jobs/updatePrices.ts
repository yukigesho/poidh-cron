import dotenv from "dotenv";
import fs from "fs";
import { Client, type QueryResult } from "pg";
import { formatEther } from "viem";

fs.existsSync(".env")
  ? dotenv.config({ path: ".env" })
  : dotenv.config({ path: ".env.local" });

const DATABASE_URL = process.env.DATABASE_URL;
const DEPLOYMENT_ID_URL = "https://indexer.poidh.xyz/deployment_id";

type PriceRow = {
  eth_usd: string;
  degen_usd: string;
};

type BountyRow = {
  id: number;
  amount: string;
  chain_id: number;
};

type Currency = "eth" | "degen";

type LatestPrice = {
  ethUsd: number;
  degenUsd: number;
};

type UpdatedPrice = {
  prices: LatestPrice;
  didUpdate: boolean;
};

async function tryCatch<T>(
  promise: Promise<T>,
): Promise<[Error | null, T | null]> {
  try {
    const result = await promise;
    return [null, result];
  } catch (error) {
    return [error as Error, null];
  }
}

function percentChange({
  current,
  previous,
}: {
  current: number;
  previous: number;
}): number {
  if (previous === 0) {
    throw new Error("Previous price === 0");
  }
  return Math.abs(((current - previous) / previous) * 100);
}

async function fetchPrice({ currency }: { currency: Currency }) {
  let retries = 5;
  while (true) {
    try {
      const response = await fetch(
        `https://api.coinbase.com/v2/exchange-rates?currency=${currency}`,
      );
      const body = await response.json();
      const price = (body as { data?: { rates?: { USD?: string } } })?.data
        ?.rates?.USD;
      if (!price) {
        throw new Error(`USD price not found… attempts left: ${retries}`);
      }
      return Number(price);
    } catch (error) {
      if (--retries === 0) {
        throw new Error("Can not fetch price");
      }
      console.error(error);
    }
  }
}

type DeploymentResponse = {
  deploymentId: string;
};

async function fetchDeploymentId(): Promise<string> {
  const response = await fetch(DEPLOYMENT_ID_URL);
  if (!response.ok) {
    throw new Error(`Deployment ID fetch failed: ${response.status}`);
  }
  const body = (await response.json()) as DeploymentResponse;
  if (!body?.deploymentId) {
    throw new Error("Deployment ID missing from response");
  }
  return body.deploymentId;
}

async function updateLatestPrice(client: Client): Promise<UpdatedPrice> {
  const [latestError, latestResult] = await tryCatch<QueryResult<PriceRow>>(
    client.query<PriceRow>(
      'SELECT eth_usd, degen_usd FROM public."Price" ORDER BY id DESC LIMIT 1',
    ),
  );
  if (latestError) {
    throw latestError;
  }

  const latestPrice = latestResult?.rows[0];
  const [currentPriceEth, currentPriceDegen] = await Promise.all([
    fetchPrice({ currency: "eth" }),
    fetchPrice({ currency: "degen" }),
  ]);

  const shouldUpdatePrice =
    !latestPrice ||
    percentChange({
      current: currentPriceEth,
      previous: Number(latestPrice.eth_usd),
    }) > 10 ||
    percentChange({
      current: currentPriceDegen,
      previous: Number(latestPrice.degen_usd),
    }) > 10;

  if (!shouldUpdatePrice) {
    return {
      prices: {
        ethUsd: Number(latestPrice.eth_usd),
        degenUsd: Number(latestPrice.degen_usd),
      },
      didUpdate: false,
    };
  }

  const [insertError] = await tryCatch(
    client.query(
      'INSERT INTO public."Price" (eth_usd, degen_usd) VALUES ($1, $2)',
      [currentPriceEth.toString(), currentPriceDegen.toString()],
    ),
  );
  if (insertError) {
    throw insertError;
  }

  return {
    prices: {
      ethUsd: currentPriceEth,
      degenUsd: currentPriceDegen,
    },
    didUpdate: true,
  };
}

async function ensureLiveQueryTables(
  client: Client,
  schemaName: string,
): Promise<void> {
  const safeSchema = schemaName.replace(/"/g, '""');
  const tableName = `"${safeSchema}"."live_query_tables"`;

  const [createError] = await tryCatch(
    client.query(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
        table_name text PRIMARY KEY
      )`,
    ),
  );
  if (createError) {
    throw createError;
  }
}

async function updateBountyAmounts(
  client: Client,
  prices: LatestPrice,
  schemaName: string,
): Promise<number> {
  const safeSchema = schemaName.replace(/"/g, '""');
  const bountiesTable = `"${safeSchema}"."Bounties"`;

  const [bountyError, bountyResult] = await tryCatch<QueryResult<BountyRow>>(
    client.query<BountyRow>(
      `SELECT id, amount, chain_id FROM ${bountiesTable}`,
    ),
  );
  if (bountyError) {
    throw bountyError;
  }

  if (!bountyResult?.rows) {
    throw new Error(
      "Something went wrong with bountyResult.rows. It`s undefined!",
    );
  }

  for (const bounty of bountyResult.rows) {
    const amountValue = Number(formatEther(BigInt(bounty.amount)));
    const price =
      bounty.chain_id === 666666666 ? prices.degenUsd : prices.ethUsd;
    const amountSort = amountValue * price;

    const [updateError] = await tryCatch(
      client.query(
        `UPDATE ${bountiesTable} SET amount_sort = $1 WHERE id = $2`,
        [amountSort.toFixed(5), bounty.id],
      ),
    );
    if (updateError) {
      throw updateError;
    }
  }

  return bountyResult.rowCount ?? 0;
}

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const schemaName = await fetchDeploymentId();

  const client = new Client({ connectionString: DATABASE_URL });
  const [connectError] = await tryCatch(client.connect());
  if (connectError) {
    throw connectError;
  }

  let transactionStarted = false;
  try {
    const [beginError] = await tryCatch(client.query("BEGIN"));
    if (beginError) {
      throw beginError;
    }
    transactionStarted = true;

    const { prices, didUpdate } = await updateLatestPrice(client);
    if (!didUpdate) {
      const [rollbackError] = await tryCatch(client.query("ROLLBACK"));
      if (rollbackError) {
        throw rollbackError;
      }
      transactionStarted = false;
      console.log("price change below 10%, skipping bounty updates");
      return 0;
    }

    await ensureLiveQueryTables(client, schemaName);
    const updatedCount = await updateBountyAmounts(client, prices, schemaName);

    const [commitError] = await tryCatch(client.query("COMMIT"));
    if (commitError) {
      throw commitError;
    }
    transactionStarted = false;

    console.log(`updated amount_sort for ${updatedCount} bounties`);
    return 0;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    await client.end();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => {
      console.log("finished with code 0");
      process.exit(0);
    })
    .catch((e) => {
      console.error("Something went wrong!", e);
      process.exit(1);
    });
}
