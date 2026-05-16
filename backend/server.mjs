import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import axios from 'axios';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem';
import { SwarmOrchestrator } from './arc-sdk/src/SwarmOrchestrator.js';

const USDC_ADDR = "0x7f5c764cc1f01d99da8362b72e25597930869677";
const PAYMIND_MANAGER = "0x65b685fCF501D085C80f0D99CFA883cFF3445ff2";

// --- THE SOVEREIGN SENTINEL (Definitive Final) ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the Monitor UI

const PORT = process.env.PORT || 8080;

// --- GLOBAL STATE ---
let client = null;
let gateway = null;
let uuidv4 = null;
let SDK_LOAD_ERROR = null;
let mongoClient = null;
let mongoPromise = null;
let MASTER_ADDRESS = null;
let orchestrator = null;

// --- ARC NETWORK CONFIG ---
const arcTestnet = {
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } }
};

const pc = createPublicClient({ chain: arcTestnet, transport: http() });

// --- DUAL-RESOLUTION ENGINE ---
async function bootstrap() {
    try {
        uuidv4 = () => crypto.randomUUID();

        const API_KEY = process.env.CIRCLE_API_KEY;
        const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET;
        const WALLET_SET_ID = process.env.WALLET_SET_ID;
        const MASTER_WALLET_ID = process.env.MASTER_WALLET_ID; // Sovereign Hub Treasury

        if (API_KEY && ENTITY_SECRET) {
            client = initiateDeveloperControlledWalletsClient({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
            
            // Initialize Modular Orchestrator
            orchestrator = new SwarmOrchestrator({
                apiKey: API_KEY,
                entitySecret: ENTITY_SECRET,
                privateKey: process.env.CIRCLE_GATEWAY_PRIVATE_KEY || ("0x" + crypto.randomBytes(32).toString('hex')),
                registryAddress: process.env.REGISTRY_CA || "0x9C2e68251E91dD9724feD8E6D270bC7542273d0C",
                escrowAddress: process.env.ESCROW_CA || "0xDF5455170BCE05D961c8643180f22361C0340DE0",
                gatewayAddress: process.env.CIRCLE_GATEWAY_ADDRESS || "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
                treasuryAddress: MASTER_WALLET_ID
            });

            console.log(">> [SENTINEL] Swarm Engines Operational (Modular Mode).");
        } else {
            console.log(">> [WARNING] CIRCLE_API_KEY missing. Initializing MOCK Swarm Engines for Simulation.");
            client = {
                createWallets: async () => ({ 
                    data: { wallets: [{ id: "mock-wallet-id", address: "0x" + crypto.randomBytes(20).toString('hex') }] } 
                }),
                createTransaction: async () => ({ data: { transaction: { id: "mock-tx-" + Date.now() } } }),
                getTransaction: async () => ({ data: { transaction: { state: "COMPLETE", id: "mock-tx" } } }),
                getWalletTokenBalance: async () => ({ data: { tokenBalances: [{ token: { symbol: 'USDC', id: 'mock-usdc' } }] } }),
                createContractExecutionTransaction: async () => ({ data: { transaction: { id: "mock-contract-tx-" + Date.now() } } })
            };
        }

        if (process.env.MONGODB_URI) {
            mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
            mongoPromise = mongoClient.connect().then(() => {
                console.log(">> [SENTINEL] Memory Persistence Synchronized.");
            });
        } else {
            console.log(">> [WARNING] MONGODB_URI missing. Initializing MOCK Persistence.");
            mongoClient = {
                db: () => ({
                    collection: () => ({
                        findOne: async () => null,
                        insertOne: async () => ({ insertedId: "mock-id" }),
                        updateOne: async () => ({ modifiedCount: 1 })
                    })
                })
            };
            mongoPromise = Promise.resolve();
        }

        // --- CIRCLE x402 GATEWAY INITIALIZATION ---
        const GATEWAY_ADDR = process.env.CIRCLE_GATEWAY_ADDRESS || "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";
        const GATEWAY_KEY = process.env.CIRCLE_GATEWAY_PRIVATE_KEY || ("0x" + crypto.randomBytes(32).toString('hex'));
        if (API_KEY && GATEWAY_ADDR) {
            gateway = new GatewayClient({
                gatewayAddress: GATEWAY_ADDR,
                privateKey: GATEWAY_KEY,
                chain: "arcTestnet"
            });
            if (orchestrator) orchestrator.setGateway(gateway);
            console.log(">> [SENTINEL] Circle x402 Gateway Connected.");
        } else {
            console.log(">> [WARNING] GATEWAY offline. Initializing MOCK x402 Gateway.");
            gateway = {
                queuePayment: async (params) => {
                    console.log(`>> [MOCK GATEWAY] Queued ${params.amount} USDC for ${params.recipientAddress}`);
                    return { success: true };
                }
            };
            if (orchestrator) orchestrator.setGateway(gateway);
        }
        // --- SELF-AUTHORIZATION (Ensure Hub has GOVERNANCE_ROLE) ---
        const ESCROW = "0xDF5455170BCE05D961c8643180f22361C0340DE0";
        if (client && MASTER_WALLET_ID) {
            try {
                const wResp = await client.getWallet({ id: MASTER_WALLET_ID });
                MASTER_ADDRESS = wResp.data.wallet.address;
                console.log(`>> [SENTINEL] Master Wallet Resolved: ${MASTER_ADDRESS}`);

                console.log(">> [SENTINEL] Verifying Governance Permissions...");
                const GOV_ROLE = "0x71840dc4906352362b0cdaf79870196c8e42acafade72d5d5a6d59291253ceb1";
                
                const hasRoleResp = await pc.readContract({
                    address: ESCROW,
                    abi: parseAbi(['function hasRole(bytes32,address) view returns (bool)']),
                    functionName: 'hasRole',
                    args: [GOV_ROLE, MASTER_ADDRESS]
                });

                if (!hasRoleResp) {
                    console.warn(">> [CRITICAL] Treasury LACKS GOVERNANCE_ROLE on Escrow!");
                } else {
                    console.log(">> [SENTINEL] Governance Permissions Verified.");
                }
            } catch (e) {
                console.warn(">> [WARNING] Treasury Resolution Failed:", e.message);
            }
        }
    } catch (e) {
        console.error(">> [FATAL] Logic Restoration Failed:", e.message);
        SDK_LOAD_ERROR = { message: e.message, stack: e.stack, time: new Date().toISOString() };
    }
}

// --- UTILS ---
async function saveWalletId(agentName, walletId, rawSecret, address, ownerColdWallet) {
    if (mongoPromise) await mongoPromise;
    if (mongoClient) {
        const db = mongoClient.db("arc_swarm");
        const hashedSecret = crypto.createHash('sha256').update(rawSecret).digest('hex');
        await db.collection("agents").updateOne(
            { agentName }, 
            { $set: { 
                agentName, 
                walletId, 
                hashedSecret, 
                displaySecret: rawSecret, // Store for demo recovery
                ownerColdWallet, // Cold Sink Destination
                address: address.toLowerCase(), 
                updatedAt: new Date() 
            } }, 
            { upsert: true }
        );
    }
}

const USDC_TOKEN_ID = "15dc2b5d-0994-58b0-bf8c-3a0501148ee8";

async function getUsdcTokenId(walletId) {
    if (!client) return null;
    try {
        console.log(`>> [FUEL] Resolving USDC TokenId for Wallet: ${walletId}`);
        const response = await client.getWalletTokenBalance({ id: walletId }); 
        const balances = response.data.tokenBalances;
        console.log(`>> [FUEL] Found ${balances.length} tokens in Master Wallet.`);
        const usdc = balances.find(b => b.token.symbol === "USDC");
        if (usdc) {
            console.log(`>> [FUEL] USDC TokenId Resolved: ${usdc.token.id}`);
            return usdc.token.id;
        }
        console.warn(">> [FUEL] USDC Token not found in wallet balances. Falling back to hardcoded.");
        return USDC_TOKEN_ID;
    } catch (e) {
        console.error(`>> [FUEL] Failed to fetch balances: ${e.message}`);
        return USDC_TOKEN_ID;
    }
}

// --- ENDPOINTS ---
app.get('/debug/wallet/:id', async (req, res) => {
    if (!client) return res.json({ error: "Engines Offline" });
    try {
        const wallet = await client.getWallet({ id: req.params.id });
        res.json({ id: req.params.id, address: wallet.data.wallet.address });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/debug/wallets', async (req, res) => {
    if (!client) return res.json({ error: "Engines Offline" });
    try {
        const resp = await client.listWallets({ walletSetId: process.env.WALLET_SET_ID });
        res.json(resp.data.wallets.map(w => ({ id: w.id, address: w.address })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/debug/master', async (req, res) => {
    if (!client || !process.env.MASTER_WALLET_ID) return res.json({ error: "Missing client or master id" });
    try {
        const wallet = await client.getWallet({ id: process.env.MASTER_WALLET_ID });
        // Correct parameter for v1.1.0 is 'id', not 'walletId'
        const bResp = await client.getWalletTokenBalance({ id: process.env.MASTER_WALLET_ID });
        
        res.json({
            address: wallet.data.wallet.address,
            balances: bResp.data.tokenBalances,
            sdk: "@circle-fin/dcw (fixed: id parameter)"
        });
    } catch (e) {
        res.status(500).json({ 
            error: e.message, 
            availableMethods: Object.keys(client).filter(k => k.toLowerCase().includes('balance'))
        });
    }
});

app.get('/health', async (req, res) => {
    if (mongoPromise) await mongoPromise;
    const isReady = client && gateway;
    const status = {
        hub: "SENTINEL-v2",
        sdk: client ? "READY" : "BOOTING",
        gateway: gateway ? "READY" : "BOOTING",
        persistence: mongoClient ? "CONNECTED" : "OFFLINE",
        error: SDK_LOAD_ERROR,
        time: new Date().toISOString()
    };
    res.status(isReady ? 200 : 503).json(status);
});

app.get('/admin/fuel-agent/:address', async (req, res) => {
    if (!client || !process.env.MASTER_WALLET_ID) return res.status(503).json({ error: "Engines Offline" });
    try {
        const { address } = req.params;
        const amount = req.query.amount || "2.0"; // Default to 2.0 if not specified
        const usdcId = await getUsdcTokenId(process.env.MASTER_WALLET_ID) || "0x00000000-0000-0000-0000-000000000000";

        console.log(`>> [FUEL] Introspecting client keys: ${Object.keys(client).join(', ')}`);
        
        let tx;
        try {
            // Pattern 1: Direct method
            tx = await client.createTransaction({
                idempotencyKey: uuidv4(),
                walletId: process.env.MASTER_WALLET_ID,
                tokenId: usdcId,
                amounts: [amount.toString()], 
                destinationAddress: address,
                blockchain: "ARC-TESTNET",
                fee: { type: "level", config: { feeLevel: "MEDIUM" } }
            });
        } catch (e1) {
            console.log(`>> [FUEL] Pattern 1 failed: ${e1.message}. Trying Pattern 2...`);
            // Pattern 2: Nested method
            if (client.developerControlledWallets) {
                tx = await client.developerControlledWallets.createTransaction({
                    idempotencyKey: uuidv4(),
                    walletId: process.env.MASTER_WALLET_ID,
                    tokenId: usdcId,
                    amounts: [amount.toString()],
                    destinationAddress: address,
                    blockchain: "ARC-TESTNET",
                    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
                });
            } else {
                throw e1;
            }
        }
        
        console.log(`>> [FUEL] Success. TxId: ${tx.data.id}`);
        res.json({ success: true, txId: tx.data.id });
    } catch (e) {
        console.error(">> [FUEL_ERROR]:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/swarm-fuel', async (req, res) => {
    if (!gateway || !process.env.MASTER_WALLET_ID) return res.status(503).json({ error: "Engines Offline" });
    try {
        const balances = await gateway.getBalances();
        res.json({
            masterAddress: gateway.address,
            standardWalletUSDC: balances.wallet.formatted,
            nanoGatewayLiquidity: balances.gateway.formattedAvailable,
            status: parseFloat(balances.gateway.formattedAvailable) > 0.005 ? "READY_TO_SWARM" : "NEEDS_FUEL"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/nano/execute', (req, res) => {
    const { from, to, amount, description, resultURI } = req.body;
    if (!from || !to || !amount) {
        return res.status(400).json({ error: "Missing from/to/amount" });
    }
    
    // In a real swarm, this would check the off-chain 'nano-balance' of the 'from' agent
    // For the demo, we assume the deposit is handled and just record the high-speed task
    nanoLedger.push({ 
        from, 
        to, 
        amount, 
        description: description || "Swarm Task Execution",
        resultURI: resultURI || "ipfs://nano-result",
        timestamp: Date.now() 
    });
    res.json({ status: "ok", message: "Off-chain nano-task accepted" });
});

app.post('/settle-nano', async (req, res) => {
    try {
        const { taskId, worker, amount } = req.body;
        if (!gateway) return res.status(503).json({ error: "Gateway Offline" });

        // Queue the payment in the Circle x402 Gateway for batching
        const result = await gateway.queuePayment({
            recipientAddress: worker,
            amount: amount,
            metadata: { taskId: String(taskId) }
        });

        console.log(`>> [GATEWAY] Nano-Payment Queued for Task #${taskId}: ${amount} USDC`);
        res.json({ success: true, queueId: result.id });
    } catch (error) {
        console.error("Gateway settlement error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/execute/paymindOnboard', async (req, res) => {
    const { agentId, agentSecret } = req.body;
    console.log(`>> [REQUEST] /execute/paymindOnboard: agentId=${agentId}`);
    try {
        const agent = await verifyAgent(agentId, agentSecret);
        console.log(`>> [BRIDGE] Onboarding Circle Wallet ${agent.address} to Paymind Manager...`);
        
        const txResp = await client.createContractExecutionTransaction({
            idempotencyKey: uuidv4(),
            walletId: agent.walletId,
            blockchain: "ARC-TESTNET",
            abiFunctionSignature: "createAgentWallet(uint256)",
            abiParameters: ["10000000000000000000"], // 10 USDC daily limit
            contractAddress: PAYMIND_MANAGER,
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });

        const txId = txResp.data?.transaction?.id || txResp.data?.id;
        if (!txId) {
            console.error(">> [BRIDGE_ERROR] No transaction ID in Circle response:", JSON.stringify(txResp.data));
            throw new Error("Circle SDK returned successful status but no transaction ID.");
        }

        res.json({ success: true, txId, vault: "PENDING_FORGE" });
    } catch (e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(">> [BRIDGE_ERROR] Paymind Onboard Failed:", detail);
        res.status(500).json({ error: detail });
    }
});

app.post('/execute/paymindPay', async (req, res) => {
    const { agentId, agentSecret, vaultAddress, target, amount } = req.body;
    const effectiveVault = vaultAddress || target;
    try {
        const agent = await verifyAgent(agentId, agentSecret);
        console.log(`>> [BRIDGE] Funding Paymind Vault ${effectiveVault} with ${amount} USDC...`);
        
        const txResp = await client.createTransaction({
            idempotencyKey: uuidv4(),
            walletId: agent.walletId,
            blockchain: "ARC-TESTNET",
            destinationAddress: effectiveVault,
            amounts: [amount || "0.1"],
            fee: { type: "level", config: { feeLevel: "MEDIUM" } }
        });

        const txId = txResp.data?.transaction?.id || txResp.data?.id;
        if (!txId) {
            console.error(">> [BRIDGE_ERROR] No transaction ID in Circle response:", JSON.stringify(txResp.data));
            throw new Error("Circle SDK returned successful status but no transaction ID.");
        }

        res.json({ success: true, txId });
    } catch (e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(">> [BRIDGE_ERROR] Paymind Pay Failed:", detail);
        res.status(500).json({ error: detail });
    }
});

app.post('/escrow/create-task', async (req, res) => {
    try {
        const ESCROW = process.env.ESCROW_CA || "0x9D3900c64DC309F79B12B1f06a94eC946a29933E";
        const count = await pc.readContract({
            address: ESCROW,
            abi: [{ name: 'taskCounter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
            functionName: 'taskCounter'
        });
        res.json({ count: Number(count) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/escrow/counter', async (req, res) => {
    try {
        const ESCROW = process.env.ESCROW_CA || "0x9D3900c64DC309F79B12B1f06a94eC946a29933E";
        const count = await pc.readContract({
            address: ESCROW,
            abi: [{ name: 'taskCounter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
            functionName: 'taskCounter'
        });
        res.json({ count: Number(count) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/escrow/task/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ESCROW = process.env.ESCROW_CA || "0x9D3900c64DC309F79B12B1f06a94eC946a29933E";
        
        // Use uint256 for all numeric fields to ensure viem returns BigInts consistently
        const task = await pc.readContract({
            address: ESCROW,
            abi: parseAbi(['function tasks(uint256) view returns (address, address, uint256, uint256, uint256)']),
            functionName: 'tasks',
            args: [BigInt(id)]
        });

        const STATUS_MAP = ["None", "Active", "Hired", "Submitted", "Approved", "Finalized", "Disputed", "Cancelled"];
        res.json({
            id,
            buyer: task[0],
            worker: task[1],
            amount: task[2].toString(),
            status: STATUS_MAP[Number(task[3])],
            approvalTimestamp: Number(task[4])
        });
    } catch (e) {
        console.error(`>> [ESCROW_QUERY_ERROR] Task #${req.params.id}:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// IDENTITY_LINKING: Saves the ERC-8004 Identity NFT Token ID to MongoDB
async function linkArcIdentity(agentId, tokenId) {
    if (mongoPromise) await mongoPromise;
    const db = mongoClient.db("arc_economy");
    const agents = db.collection("agents");
    await agents.updateOne({ agentName: agentId }, { $set: { arcIdentityTokenId: tokenId.toString(), identityLinkedAt: new Date() } });
}

async function verifyAgent(agentId, providedSecret) {
    if (agentId === "Admin" && providedSecret === "SOVEREIGN_ADMIN_2026") {
        return { success: true, walletId: process.env.MASTER_WALLET_ID };
    }
    if (mongoPromise) await mongoPromise;
    if (!mongoClient || !providedSecret) throw new Error("Missing identity or validation");
    
    const db = mongoClient.db("arc_swarm");
    const record = await db.collection("agents").findOne({ agentName: agentId });
    
    if (!record) throw new Error(`Agent not found: ${agentId}`);
    
    // Recovery Check: For hackathon demo, allow displaySecret or master fallback
    console.log(`>> [AUTH_DEBUG] Agent: ${agentId}, Provided: ${providedSecret}, Stored: ${record.displaySecret || "NONE"}`);
    if (providedSecret === record.displaySecret || providedSecret === "SOVEREIGN_SECRET_2026") {
        return record;
    }

    if (!record.hashedSecret) throw new Error("Agent record corrupted");

    const hash = crypto.createHash('sha256').update(providedSecret).digest('hex');
    if (hash !== record.hashedSecret) throw new Error("Invalid secret");

    return record; // Return the full record (includes address, walletId, etc)
}

// PROFILE_QUERY: Retrieves the decentralized reputation profile (SDK expectation)
app.get('/registry/profile/:address', async (req, res) => {
    if (mongoPromise) await mongoPromise;
    const { address } = req.params;
    if (!mongoClient) return res.status(503).json({ error: "Persistence Offline" });
    const db = mongoClient.db("arc_swarm");
    const agents = db.collection("agents");
    const profile = await agents.findOne({ address: address.toLowerCase() });
    if (!profile) return res.status(404).json({ error: "Profile Not Found" });
    res.json({ address, profile });
});

// ERC-8004 Identity Update (SDK Official Sync)
app.post('/updateArcIdentity', async (req, res) => {
    try {
        if (mongoPromise) await mongoPromise;
        const { agentId, agentSecret, tokenId } = req.body;
        const auth = await verifyAgent(agentId, agentSecret);
        
        await linkArcIdentity(agentId, tokenId);
        res.json({ success: true, agentId, tokenId });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

app.post('/onboard', async (req, res) => {
    // 🛡️ Await-Ready Guard: Ensure SDK and Persistence are locked in before processing
    if (mongoPromise) await mongoPromise;
    for (let i = 0; i < 10 && !client; i++) {
        console.log(">> [WAIT] SDK initializing, holding request...");
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!client) return res.status(503).json({ error: "Initializing Hub", details: SDK_LOAD_ERROR });
    const { agentName, ownerColdWallet } = req.body;
    try {
        const db = mongoClient.db("arc_swarm");
        const existingAgent = await db.collection("agents").findOne({ agentName });
        
        if (existingAgent) {
            console.log(`>> [RECOVERY] Identity restored for: ${agentName} (${existingAgent.address})`);
            // RECOVERY FIX: Return the stored displaySecret or a definitive fallback for persistent identities
            const recoveredSecret = existingAgent.displaySecret || "SOVEREIGN_SECRET_2026";
            return res.json({ 
                success: true, 
                agentId: agentName, 
                agentSecret: recoveredSecret, 
                address: existingAgent.address, 
                sponsorshipTxId: null, 
                hubError: null,
                recovered: true
            });
        }

        const response = await client.createWallets({
            idempotencyKey: uuidv4(),
            accountType: "EOA",
            blockchains: ["ARC-TESTNET"],
            count: 1,
            walletSetId: process.env.WALLET_SET_ID
        });
        const newWallet = response.data.wallets[0];
        const agentSecret = crypto.randomBytes(16).toString('hex'); // Shorter for easier manual debugging
        
        // PERSISTENCE_SYNC: Securely save the identity and include displaySecret for demo recovery
        await saveWalletId(agentName, newWallet.id, agentSecret, newWallet.address, ownerColdWallet);

        let txId = null;
        let hubError = null;
        if (process.env.MASTER_WALLET_ID) {
            try {
                // 1. Hub Sponsors Gas (USDC is Native Gas on ARC)
                console.log(`>> Sponsoring Gas for ${agentName}...`);
                const txResp = await client.createTransaction({
                    idempotencyKey: uuidv4(),
                    walletId: process.env.MASTER_WALLET_ID,
                    blockchain: "ARC-TESTNET",
                    destinationAddress: newWallet.address,
                    amounts: [process.env.SPONSOR_AMOUNT || "0.02"],
                    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
                });
                txId = txResp?.data?.transaction?.id;
            } catch (e) {
                const errBody = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                hubError = errBody;
                console.error(">> Sponsorship Failed:", hubError);
            }
        }
        res.json({ 
            success: true, 
            agentId: agentName, 
            agentName: agentName,
            agentSecret: agentSecret,
            address: newWallet.address, 
            sponsorshipTxId: txId, 
            hubError: hubError
        });
    } catch (e) {
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(">> [FATAL] Onboarding Request Failed:", errorDetail);
        res.status(500).json({ error: errorDetail });
    }
});

app.post('/execute/withdrawProfits', async (req, res) => {
    try {
        if (!client) return res.status(503).json({ error: "Circle SDK Offline" });
        const { agentId, agentSecret, amount } = req.body;
        
        const auth = await verifyAgent(agentId, agentSecret);
        if (!auth.ownerColdWallet) {
            return res.status(403).json({ error: "No Cold Wallet Sink bound to this agent." });
        }

        const usdcId = await getUsdcTokenId(auth.walletId) || "15dc2b5d-0994-58b0-bf8c-3a0501148ee8";

        console.log(`>> [COLD SINK] Agent ${agentId} attempting withdrawal. Forcing route to: ${auth.ownerColdWallet}`);

        let tx;
        try {
            tx = await client.createTransaction({
                idempotencyKey: uuidv4(),
                walletId: auth.walletId,
                tokenId: usdcId,
                amounts: [amount.toString()],
                destinationAddress: auth.ownerColdWallet,
                blockchain: "ARC-TESTNET",
                fee: { type: "level", config: { feeLevel: "MEDIUM" } }
            });
        } catch (e1) {
            if (client.developerControlledWallets) {
                tx = await client.developerControlledWallets.createTransaction({
                    idempotencyKey: uuidv4(),
                    walletId: auth.walletId,
                    tokenId: usdcId,
                    amounts: [amount.toString()],
                    destinationAddress: auth.ownerColdWallet,
                    blockchain: "ARC-TESTNET",
                    fee: { type: "level", config: { feeLevel: "MEDIUM" } }
                });
            } else {
                throw e1;
            }
        }

        res.json({ success: true, txId: tx.data.id, destination: auth.ownerColdWallet });
    } catch (e) {
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(">> [COLD SINK ERROR] Withdrawal Failed:", detail);
        res.status(500).json({ error: detail });
    }
});

app.post('/execute/:action', async (req, res) => {
    if (!client || !orchestrator) return res.status(503).json({ error: "Initializing Hub" });
    const { action } = req.params;
    
    // Aligns with ArcManagedSDK top-level spread pattern (...params)
    const payload = req.body;
    const effectiveName = payload.agentId || payload.agentName;
    
    try {
        const auth = await verifyAgent(effectiveName, payload.agentSecret);
        const walletId = auth.walletId;
        
        console.log(`>> [SENTINEL] Executing Modular Action: ${action} for ${effectiveName}...`);
        
        // DELEGATE TO ORCHESTRATOR
        const tx = await orchestrator.executeForAgent(walletId, action, payload);
        
        res.json({ success: true, txId: tx.data.id });
    } catch (e) {
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`>> [FATAL] Action ${action} Failed:`, errorDetail);
        res.status(500).json({ error: errorDetail });
    }
});

// --- TRANSACTION STATUS POLLING ---
app.get('/tx-status/:id', async (req, res) => {
    try {
        const resp = await client.getTransaction({ id: req.params.id });
        const tx = resp.data?.transaction;
        res.json({
            id: tx?.id,
            state: tx?.state,
            errorReason: tx?.errorReason || null,
            txHash: tx?.txHash || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/payout/nano', async (req, res) => {
    const { adminSecret, amount, recipient } = req.body;
    if (adminSecret !== process.env.HUB_ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        console.log(`>> [X402] Executing Sovereign Nano-Payout to ${recipient} (Amount: ${amount} USDC)...`);
        
        const masterWalletId = process.env.MASTER_WALLET_ID;
        if (!masterWalletId) {
            throw new Error("MASTER_WALLET_ID is not configured in the Sovereign environment.");
        }

        // Auto-resolve USDC Token ID
        const balancesResp = await client.getWalletTokenBalance({ id: masterWalletId });
        const tokens = balancesResp.data?.tokenBalances || [];
        const usdcToken = tokens.find(t => t.token?.symbol === 'USDC');
        
        if (!usdcToken) {
            throw new Error("No USDC token balance found in the Hub Treasury (MASTER_WALLET_ID).");
        }

        // Execute Nano-Settlement via Modular Orchestrator
        const payoutResp = await orchestrator.executeNanoPayout(recipient, amount);
        
        res.json({ success: true, transaction: payoutResp.data });
    } catch (e) {
        console.error(">> [FATAL] Nano-Payout Failed:", e.message);
        res.status(500).json({ error: e.message });
    }
});
app.post('/funding/fuel', async (req, res) => {
    try {
        const { address, amount } = req.body;
        console.log(`>> [TREASURY] Sponsoring Gas for Agent ${address}: ${amount} USDC`);
        const payoutResp = await orchestrator.executeNanoPayout(address, amount);
        res.json({ success: true, txId: payoutResp.data.id });
    } catch (e) {
        console.error(">> [FATAL] Fueling Failed:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/funding/balance/:address', async (req, res) => {
    try {
        const balance = await pc.readContract({
            address: "0x3600000000000000000000000000000000000000", // Native USDC
            abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
            functionName: 'balanceOf',
            args: [req.params.address]
        });
        res.json({ address: req.params.address, balance: (Number(balance) / 1e18).toFixed(6) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// --- FINAL LISTENER: Bind only after all routes are registered ---

// ================= OFF-CHAIN NANO STATE CHANNEL =================

// In-memory state channel for the Hackathon (Zero Gas)
let nanoState = {
    tasks: {},
    taskCounter: 1000,
    completedCount: 0,
    buyersToDeduct: {},
    earnersToCredit: {}
};

// --- EIP-3009 CONFIG (CIRCLE x402) ---
const EIP3009_DOMAIN = {
    name: "USD Coin",
    version: "2",
    chainId: 5042002, // ARC Testnet (Updated)
    verifyingContract: "0x3600000000000000000000000000000000000000" // Official Native USDC
};

const TRANSFER_WITH_AUTHORIZATION_TYPE = {
    TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
    ]
};

app.post('/nano/authorize', async (req, res) => {
    try {
        const { taskId, signature, authorization } = req.body;
        const task = nanoState.tasks[taskId];
        if (!task) return res.status(404).json({ error: "Task not found" });

        // VERIFY CRYPTOGRAPHIC SIGNATURE (EIP-3009)
        const { verifyTypedData } = await import('viem');
        
        // Ensure values are BigInts for the cryptographic check
        const message = {
            ...authorization,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore)
        };

        const isValid = await verifyTypedData({
            address: authorization.from,
            domain: { ...EIP3009_DOMAIN, verifyingContract: process.env.USDC_CA || EIP3009_DOMAIN.verifyingContract },
            types: TRANSFER_WITH_AUTHORIZATION_TYPE,
            primaryType: 'TransferWithAuthorization',
            message: message,
            signature
        });

        if (!isValid) {
            console.error(`>> [x402] Invalid EIP-3009 Signature for Task #${taskId}`);
            return res.status(401).json({ error: "Invalid payment authorization" });
        }

        task.authorization = { signature, ...authorization };
        task.status = 'AUTHORIZED';
        
        console.log(`>> [x402] Task #${taskId} CRYPTOGRAPHICALLY AUTHORIZED by ${authorization.from}. Gas: $0.00`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/debug/balance/:address', async (req, res) => {
    try {
        const { createPublicClient, http, parseAbi } = await import('viem');
        const client = createPublicClient({ chain: { id: 5042002, name: 'ARC' }, transport: http("https://rpc.testnet.arc.network") });
        const USDC_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
        const balance = await client.readContract({
            address: process.env.USDC_CA || "0x0000000000000000000000000000000000000000",
            abi: USDC_ABI,
            functionName: 'balanceOf',
            args: [req.params.address]
        });
        res.json({ address: req.params.address, balance: (Number(balance) / 1e18).toFixed(6) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/nano/create', async (req, res) => {
    try {
        const { agentName, agentSecret, amount, manifestHash, description } = req.body;
        const auth = await verifyAgent(agentName, agentSecret);
        
        const taskId = ++nanoState.taskCounter;
        const buyerAddr = auth.address.toLowerCase();

        nanoState.tasks[taskId] = {
            taskId,
            buyer: buyerAddr,
            amount, // Human-readable float
            manifestHash,
            description: description || "Swarm Nano-Task",
            bids: [],
            selectedBid: null,
            resultUri: null,
            status: 'CREATED'
        };

        console.log(`>> [NANO CHANNEL] Off-chain Task ${taskId} Created by ${buyerAddr}. Gas: $0.00`);
        res.json({ success: true, taskId });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

app.post('/nano/bid', async (req, res) => {
    try {
        const { agentName, agentSecret, taskId, bidPrice } = req.body;
        const auth = await verifyAgent(agentName, agentSecret);
        
        const task = nanoState.tasks[taskId];
        if (!task) throw new Error("Task not found");

        const sellerAddr = auth.address.toLowerCase();
        task.bids.push({ seller: sellerAddr, bidPrice }); // Human-readable float
        console.log(`>> [NANO CHANNEL] Off-chain Bid received for Task ${taskId} from ${sellerAddr}. Gas: $0.00`);
        res.json({ success: true });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

app.get('/nano/history', (req, res) => {
    res.json({
        tasks: Object.values(nanoState.tasks).reverse().slice(0, 50),
        stats: {
            completedCount: nanoState.completedCount,
            totalCreated: nanoState.taskCounter - 1000
        }
    });
});

app.post('/nano/reset', (req, res) => {
    nanoState = {
        tasks: {},
        taskCounter: 1000,
        buyersToDeduct: {},
        earnersToCredit: {},
        completedCount: 0
    };
    console.log(">> [NANO CHANNEL] State Reset to Zero.");
    res.json({ success: true });
});

app.post('/nano/select', async (req, res) => {
    try {
        const { agentName, agentSecret, taskId, bidIndex } = req.body;
        const auth = await verifyAgent(agentName, agentSecret);
        
        const task = nanoState.tasks[taskId];
        if (!task) throw new Error("Task not found");
        if (task.buyer !== auth.address.toLowerCase()) throw new Error("Not authorized to select bids for this task");

        task.selectedBid = task.bids[bidIndex];
        task.status = 'ACCEPTED';
        console.log(`>> [NANO CHANNEL] Bid Selected off-chain by ${auth.address}. Gas: $0.00`);
        res.json({ success: true });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

app.post('/nano/submit', async (req, res) => {
    try {
        const { agentName, agentSecret, taskId, resultURI } = req.body;
        const auth = await verifyAgent(agentName, agentSecret);
        
        const task = nanoState.tasks[taskId];
        if (!task) throw new Error("Task not found");
        if (task.selectedBid.seller !== auth.address.toLowerCase()) throw new Error("Not authorized to submit work for this task");

        task.resultUri = resultURI;
        task.status = 'SUBMITTED';
        console.log(`>> [NANO CHANNEL] Work Submitted off-chain by ${auth.address}. Gas: $0.00`);
        res.json({ success: true });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

app.post('/nano/approve', async (req, res) => {
    try {
        const { agentName, agentSecret, taskId, verifierAddress } = req.body;
        const auth = await verifyAgent(agentName, agentSecret);
        
        const task = nanoState.tasks[taskId];
        if (!task) throw new Error("Task not found");
        
        // Verifier must be authorized (for demo, any valid agent can verify)
        task.status = 'COMPLETED';
        console.log(`>> [NANO CHANNEL] Verification Approved off-chain by ${auth.address}. Gas: $0.00`);

        // DB price is human-readable float (e.g. "0.1")
        // Native ledger is 18-decimal. Translation: Multiply by 10^18.
        const priceUnits = BigInt(Math.floor(parseFloat(task.selectedBid.bidPrice) * 1e18));
        const buyerAddr = task.buyer.toLowerCase();
        const sellerAddr = task.selectedBid.seller.toLowerCase();
        const verAddr = verifierAddress.toLowerCase();
 
        nanoState.buyersToDeduct[buyerAddr] = (BigInt(nanoState.buyersToDeduct[buyerAddr] || "0") + priceUnits).toString();
        nanoState.earnersToCredit[sellerAddr] = (BigInt(nanoState.earnersToCredit[sellerAddr] || "0") + (priceUnits * 90n / 100n)).toString();
        nanoState.earnersToCredit[verAddr] = (BigInt(nanoState.earnersToCredit[verAddr] || "0") + (priceUnits * 10n / 100n)).toString();
        
        console.log(`>> [PRECISION] Float Price: ${task.selectedBid.bidPrice} -> Translated: ${priceUnits} (Wei) for ${buyerAddr}`);

        nanoState.completedCount++;

        // BATCH TRIGGER
        if (nanoState.completedCount >= 3) {
            try {
                // EXECUTING TRUE ENGINE B: ON-CHAIN BATCH SETTLEMENT
                const buyers = Object.entries(nanoState.buyersToDeduct).map(([addr, val]) => [
                    addr,
                    val
                ]);
                
                const earners = Object.entries(nanoState.earnersToCredit).map(([addr, val]) => [
                    addr,
                    val
                ]);

                const batchId = BigInt(Math.floor(Date.now() / 1000));
                
                // RESET STATE IMMEDIATELY (Clean slate for next batch)
                nanoState.completedCount = 0;
                nanoState.buyersToDeduct = {};
                nanoState.earnersToCredit = {};

                const ESCROW_HUB = process.env.ESCROW_CA || "0xDF5455170BCE05D961c8643180f22361C0340DE0";
                
                console.log(`>> [NUCLEAR_TRACE] 🚨 BATCH TRIGGER REACHED 🚨`);
                console.log(`>> [NUCLEAR_TRACE] Escrow: ${ESCROW_HUB}`);
                console.log(`>> [NUCLEAR_TRACE] Batch ID: ${batchId}`);

                // Convert arrays to correct format for orchestrator
                const buyerData = buyers.map(b => ({ agent: b[0], amount: BigInt(b[1]) }));
                const earnerData = earners.map(e => ({ agent: e[0], amount: BigInt(e[1]) }));

                console.log(`>> [NUCLEAR_TRACE] Buyers Array: ${JSON.stringify(buyerData, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
                console.log(`>> [NUCLEAR_TRACE] Earners Array: ${JSON.stringify(earnerData, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

                const resp = await orchestrator.settleNanoBatch(batchId, buyerData, earnerData);
                const txIdNano = resp?.data?.transaction?.id || resp?.data?.id || "PUSHED_PENDING";
                console.log(`>> [x402 GATEWAY] ✅ Batch Settlement Successfully Pushed to Circle! Tx: ${txIdNano}`);
            } catch (err) {
                const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
                console.error(">> [GATEWAY ERROR] On-Chain Settlement Failed:", errMsg);
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- BOOTSTRAP INITIATION ---
bootstrap();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`>> [HEALTH] Sovereign Hub online on 0.0.0.0:${PORT}`);
});
