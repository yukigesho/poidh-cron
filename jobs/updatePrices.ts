import dotenv from "dotenv";
import fs from "fs";
import { Client, type QueryResult } from "pg";
import { formatEther } from "viem";

fs.existsSync(".env")
  ? dotenv.config({ path: ".env" })
  : dotenv.config({ path: ".env.local" });

const DATABASE_URL = process.env.DATABASE_URL;

type PriceRow = {
  eth_usd: string;
  degen_usd: string;
};

type BountyRow = {
  bounty_id: number;
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
    }) > 5 ||
    percentChange({
      current: currentPriceDegen,
      previous: Number(latestPrice.degen_usd),
    }) > 5;

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

async function updateBountyAmounts(
  client: Client,
  prices: LatestPrice,
): Promise<number> {
  const bountiesTable = 'public."BountiesExtra"';

  const [bountyError, bountyResult] = await tryCatch<QueryResult<BountyRow>>(
    client.query<BountyRow>(
      `SELECT extra.bounty_id, extra.chain_id, bounties.amount
       FROM ${bountiesTable} extra
       JOIN public."Bounties" bounties
         ON bounties.id = extra.bounty_id
        AND bounties.chain_id = extra.chain_id`,
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
        `UPDATE ${bountiesTable} SET amount_sort = $1 WHERE bounty_id = $2 AND chain_id = $3`,
        [amountSort.toFixed(5), bounty.bounty_id, bounty.chain_id],
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

    const updatedCount = await updateBountyAmounts(client, prices);

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
