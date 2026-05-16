import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, http, parseAbi } from 'viem';
import { PriceOracleService } from './services/priceOracle.js';

// --- AGENTVAULT BACKEND ---
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// --- GLOBAL STATE ---
let client = null;
let mongoClient = null;
let mongoPromise = null;
let MASTER_ADDRESS = null;
let oracleService = null;

// --- ARC NETWORK CONFIG ---
const arcTestnet = {
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } }
};
const pc = createPublicClient({ chain: arcTestnet, transport: http() });

const VAULT_PERP_ADDRESS = process.env.VAULT_PERP_ADDRESS || "0x0000000000000000000000000000000000000000";

async function bootstrap() {
    try {
        const API_KEY = process.env.CIRCLE_API_KEY;
        const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
        const MASTER_WALLET_ID = process.env.MASTER_WALLET_ID;

        if (API_KEY && ENTITY_SECRET) {
            client = initiateDeveloperControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
            console.log(">> [AGENTVAULT] Circle Client Operational.");
            
            // Start Price Oracle
            oracleService = new PriceOracleService(client, MASTER_WALLET_ID, VAULT_PERP_ADDRESS);
            oracleService.start(60000); // every 60s
        } else {
            console.log(">> [WARNING] CIRCLE_API_KEY missing. Running in Mock Mode.");
            client = {
                createWallets: async () => ({ data: { wallets: [{ id: "mock-id", address: "0xMockAddress" }] } }),
                createTransaction: async () => ({ data: { transaction: { id: "mock-tx" } } }),
                createContractExecutionTransaction: async () => ({ data: { id: "mock-contract-tx" } })
            };
        }

        if (process.env.MONGODB_URI) {
            mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
            mongoPromise = mongoClient.connect().then(() => {
                console.log(">> [AGENTVAULT] Database Synchronized.");
            });
        }
    } catch (e) {
        console.error(">> [FATAL] Bootstrap Failed:", e.message);
    }
}

// --- UTILS ---
async function saveWalletId(agentName, walletId, rawSecret, address) {
    if (mongoPromise) await mongoPromise;
    if (mongoClient) {
        const db = mongoClient.db("agentvault");
        const hashedSecret = crypto.createHash('sha256').update(rawSecret).digest('hex');
        await db.collection("users").updateOne(
            { agentName }, 
            { $set: { agentName, walletId, hashedSecret, address: address.toLowerCase(), updatedAt: new Date() } }, 
            { upsert: true }
        );
    }
}

async function verifyAgent(agentId, providedSecret) {
    if (mongoPromise) await mongoPromise;
    if (!mongoClient || !providedSecret) throw new Error("Missing credentials");
    const db = mongoClient.db("agentvault");
    const record = await db.collection("users").findOne({ agentName: agentId });
    if (!record) throw new Error(`User not found: ${agentId}`);
    
    const hash = crypto.createHash('sha256').update(providedSecret).digest('hex');
    if (hash !== record.hashedSecret) throw new Error("Invalid secret");
    return record;
}

// --- CORE ROUTES ---

app.get('/health', (req, res) => {
    res.json({ status: "ok", circle: !!client, mongo: !!mongoClient });
});

app.post('/onboard', async (req, res) => {
    if (!client) return res.status(503).json({ error: "Initializing Hub" });
    const { agentName } = req.body;
    try {
        const db = mongoClient.db("agentvault");
        const existing = await db.collection("users").findOne({ agentName });
        if (existing) return res.json({ success: true, agentId: agentName, address: existing.address, recovered: true });

        const response = await client.createWallets({
            idempotencyKey: crypto.randomUUID(),
            accountType: "EOA",
            blockchains: ["ARC-TESTNET"],
            count: 1,
            walletSetId: process.env.WALLET_SET_ID
        });
        const newWallet = response.data.wallets[0];
        const agentSecret = crypto.randomBytes(16).toString('hex'); 
        
        await saveWalletId(agentName, newWallet.id, agentSecret, newWallet.address);
        
        res.json({ success: true, agentId: agentName, agentSecret, address: newWallet.address });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- LEADER ROUTES ---

app.post('/api/leaders/register', async (req, res) => {
    const { agentId, agentSecret, bondAmount, feeBps } = req.body;
    try {
        const auth = await verifyAgent(agentId, agentSecret);
        
        const txResp = await client.createContractExecutionTransaction({
            idempotencyKey: crypto.randomUUID(),
            walletId: auth.walletId,
            blockchain: "ARC-TESTNET",
            abiFunctionSignature: "registerLeader(uint256,uint256)",
            abiParameters: [bondAmount.toString(), feeBps.toString()],
            contractAddress: VAULT_PERP_ADDRESS,
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });
        
        res.json({ success: true, txId: txResp.data?.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- TRADE ROUTES ---

app.post('/api/trade/open', async (req, res) => {
    const { agentId, agentSecret, asset, isLong, collateral, leverage } = req.body;
    try {
        const auth = await verifyAgent(agentId, agentSecret);
        
        const assetBytes32 = "0x" + Buffer.from(asset).toString("hex").padEnd(64, "0");

        const txResp = await client.createContractExecutionTransaction({
            idempotencyKey: crypto.randomUUID(),
            walletId: auth.walletId,
            blockchain: "ARC-TESTNET",
            abiFunctionSignature: "openPosition(bytes32,bool,uint256,uint256)",
            abiParameters: [assetBytes32, isLong.toString(), collateral.toString(), leverage.toString()],
            contractAddress: VAULT_PERP_ADDRESS,
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });

        // Trigger Copy Trade Relay here in the future
        
        res.json({ success: true, txId: txResp.data?.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trade/close/:positionId', async (req, res) => {
    const { agentId, agentSecret } = req.body;
    const { positionId } = req.params;
    try {
        const auth = await verifyAgent(agentId, agentSecret);
        
        const txResp = await client.createContractExecutionTransaction({
            idempotencyKey: crypto.randomUUID(),
            walletId: auth.walletId,
            blockchain: "ARC-TESTNET",
            abiFunctionSignature: "closePosition(uint256)",
            abiParameters: [positionId],
            contractAddress: VAULT_PERP_ADDRESS,
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });
        
        res.json({ success: true, txId: txResp.data?.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


bootstrap().then(() => {
    app.listen(PORT, () => console.log(`>> AgentVault Backend listening on port ${PORT}`));
});
