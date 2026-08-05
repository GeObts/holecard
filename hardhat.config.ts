import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// Never inlined, never logged. Supplied by the operator in .env, which is gitignored.
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";

// No trailing fallback to https://mainnet.base.org on purpose. It throttles
// silently and caches failures for 24 hours, which is worse than a clean error.
// Fail loudly instead, so a missing key can never degrade into a poisoned cache.
const BASE_RPC_URL = process.env.BASE_RPC_URL;
if (!BASE_RPC_URL) {
  throw new Error(
    "BASE_RPC_URL is not set. Put the dedicated Alchemy Base URL in .env. " +
      "There is deliberately no public-endpoint fallback."
  );
}

const config: HardhatUserConfig = {
  solidity: {
    // @inco/lightning/src/IncoLightning.sol requires ^0.8.29
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Inco's access control list uses tstore/tload. Base supports Cancun.
      evmVersion: "cancun",
    },
  },
  networks: {
    // Base mainnet. Megapot V2 and Inco Lightning both live here.
    base: {
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
