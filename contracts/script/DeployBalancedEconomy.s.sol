// SPDX-License-Identifier: MIT
// script/DeployBalancedEconomy.s.sol
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";
import "../src/TaskEscrow.sol";

contract DeployBalancedEconomy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("Deploying from:", deployer);

        vm.startBroadcast(pk);

        // 1. Deploy AgentRegistry
        AgentRegistry registry = new AgentRegistry(
            deployer,
            0.1 ether, // Min Seller Stake: 0.1 USDC
            0.1 ether, // Min Verifier Stake: 0.1 USDC
            3600       // Withdraw Cooldown: 1 Hour
        );

        // 2. Deploy TaskEscrow
        TaskEscrow escrow = new TaskEscrow(
            address(registry),
            deployer, // Treasury
            200       // Protocol Fee: 2% (200 BPS)
        );

        // 3. Setup Roles
        registry.grantRole(registry.SLASHER_ROLE(), address(escrow));

        // 4. Optimization: Lower the verifier fee floor to allow flexible standard tasks.
        escrow.setMinVerifierFee(0.01 ether); 

        vm.stopBroadcast();

        console2.log("=== DEPLOYMENT SUCCESSFUL ===");
        console2.log("AgentRegistry :", address(registry));
        console2.log("TaskEscrow    :", address(escrow));
        console2.log("Admin/Treasury:", deployer);
        console2.log("--- Hybrid Economy Config ---");
        console2.log("Engine A (Standard)   : Full On-Chain Escrow");
        console2.log("Engine B (Nano/x402)  : On-Chain Ledger + Batch Settlement");
    }
}
