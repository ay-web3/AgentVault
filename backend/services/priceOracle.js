import { getMultiCoinPricesLarge } from "./coingecko.js";

// Map of CoinGecko IDs to our internal asset symbols
const ASSET_MAP = {
    "ethereum": "ETH",
    "bitcoin": "BTC",
    "solana": "SOL"
};

export class PriceOracleService {
    constructor(circleClient, masterWalletId, contractAddress) {
        this.client = circleClient;
        this.masterWalletId = masterWalletId;
        this.contractAddress = contractAddress;
        this.isRunning = false;
    }

    start(intervalMs = 30000) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`>> [ORACLE] Starting price feed every ${intervalMs}ms...`);
        this.interval = setInterval(() => this.updatePrices(), intervalMs);
        this.updatePrices(); // Initial run
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.interval);
    }

    async updatePrices() {
        try {
            const coinIds = Object.keys(ASSET_MAP);
            const prices = await getMultiCoinPricesLarge(coinIds);

            console.log(`>> [ORACLE] Fetched prices:`, prices);

            if (!this.client || !this.contractAddress) {
                console.log(">> [ORACLE] Skipping on-chain update (Circle client/contract missing)");
                return;
            }

            for (const [id, data] of Object.entries(prices)) {
                if (!data.usd) continue;
                
                const assetSymbol = ASSET_MAP[id];
                // Convert to 1e18 format (viem handles string conversions easily, but we'll send it as raw string to Circle)
                const priceIn1e18 = BigInt(Math.floor(data.usd * 10**6)) * BigInt(10**12);

                // Call setPrice(bytes32 asset, uint256 price)
                // Note: In a production app you'd batch these into one transaction to save gas, 
                // but ARC is super cheap so individual calls are fine for prototype.
                
                // Convert "ETH" to bytes32 (padded)
                const assetBytes32 = "0x" + Buffer.from(assetSymbol).toString("hex").padEnd(64, "0");

                const txResp = await this.client.createContractExecutionTransaction({
                    idempotencyKey: crypto.randomUUID(),
                    walletId: this.masterWalletId,
                    blockchain: "ARC-TESTNET",
                    abiFunctionSignature: "setPrice(bytes32,uint256)",
                    abiParameters: [assetBytes32, priceIn1e18.toString()],
                    contractAddress: this.contractAddress,
                    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
                });

                console.log(`>> [ORACLE] Updated ${assetSymbol} on-chain. Tx: ${txResp.data?.id}`);
            }

        } catch (e) {
            console.error(`>> [ORACLE] Error updating prices:`, e.message);
        }
    }
}
