import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// Never inlined, never logged. Supplied by the operator in .env, which is gitignored.
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";

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
      url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
      chainId: 8453,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
