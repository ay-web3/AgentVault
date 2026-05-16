// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";
import "../src/TaskEscrow.sol";

contract HappyPathAuction is Script {
    function run() external {
        address REGISTRY_ADDR = vm.envAddress("REGISTRY");
        address ESCROW_ADDR   = vm.envAddress("ESCROW");

        uint256 buyerPk     = vm.envUint("BUYER_PK");
        uint256 seller1Pk   = vm.envUint("SELLER1_PK");
        uint256 seller2Pk   = vm.envUint("SELLER2_PK");
        uint256 verifier1Pk = vm.envUint("VERIFIER1_PK");
        uint256 verifier2Pk = vm.envUint("VERIFIER2_PK");

        address buyer     = vm.addr(buyerPk);
        address seller1   = vm.addr(seller1Pk);
        address seller2   = vm.addr(seller2Pk);
        address verifier1 = vm.addr(verifier1Pk);
        address verifier2 = vm.addr(verifier2Pk);

        uint256 sellerStake   = vm.envOr("SELLER_STAKE", uint256(10 ether));
        uint256 verifierStake = vm.envOr("VERIFIER_STAKE", uint256(20 ether));

        uint256 totalEscrow   = vm.envOr("TASK_TOTAL", uint256(60 ether));
        uint64  bidWindow     = uint64(vm.envOr("BID_WINDOW_SECS", uint256(120)));
        uint64  jobWindow     = uint64(vm.envOr("JOB_WINDOW_SECS", uint256(1800)));
        uint8   quorumM       = uint8(vm.envOr("QUORUM_M", uint256(2)));

        uint256 bid1 = vm.envOr("BID1", uint256(30 ether));
        uint256 bid2 = vm.envOr("BID2", uint256(25 ether));

        AgentRegistry registry = AgentRegistry(REGISTRY_ADDR);
        TaskEscrow escrow      = TaskEscrow(ESCROW_ADDR);

        console2.log("Buyer:", buyer);
        console2.log("Seller1:", seller1);
        console2.log("Seller2:", seller2);
        console2.log("Verifier1:", verifier1);
        console2.log("Verifier2:", verifier2);

        // ---------- Register sellers ----------
        vm.startBroadcast(seller1Pk);
        registry.register{value: sellerStake}(
            true,
            false,
            keccak256("SELLER1"),
            bytes32(uint256(uint160(seller1)))
        );
        vm.stopBroadcast();

        vm.startBroadcast(seller2Pk);
        registry.register{value: sellerStake}(
            true,
            false,
            keccak256("SELLER2"),
            bytes32(uint256(uint160(seller2)))
        );
        vm.stopBroadcast();

        // ---------- Register verifiers ----------
        vm.startBroadcast(verifier1Pk);
        registry.register{value: verifierStake}(
            false,
            true,
            keccak256("VERIFIER1"),
            bytes32(uint256(uint160(verifier1)))
        );
        vm.stopBroadcast();

        vm.startBroadcast(verifier2Pk);
        registry.register{value: verifierStake}(
            false,
            true,
            keccak256("VERIFIER2"),
            bytes32(uint256(uint160(verifier2)))
        );
        vm.stopBroadcast();

        // ---------- Prepare verifiers array ----------
        address;
        vs[0] = verifier1;
        vs[1] = verifier2;

        // ---------- Create open task ----------
        uint64 bidDeadline = uint64(block.timestamp) + bidWindow;
        uint64 jobDeadline = uint64(block.timestamp) + jobWindow;
        bytes32 taskHash = keccak256("TASK:demo");

        uint256 taskId;

        vm.startBroadcast(buyerPk);
        taskId = escrow.createOpenTask{value: totalEscrow}(
            jobDeadline,
            bidDeadline,
            taskHash,
            vs,
            quorumM
        );
        vm.stopBroadcast();

        console2.log("TaskId:", taskId);

        // ---------- Sellers bid ----------
        vm.startBroadcast(seller1Pk);
        escrow.placeBid(taskId, bid1, 300, keccak256("META1"));
        vm.stopBroadcast();

        vm.startBroadcast(seller2Pk);
        escrow.placeBid(taskId, bid2, 240, keccak256("META2"));
        vm.stopBroadcast();

        // ---------- Finalize auction ----------
        vm.warp(bidDeadline + 1);

        vm.startBroadcast(buyerPk);
        escrow.finalizeAuction(taskId);
        vm.stopBroadcast();

        address winningSeller = (bid2 < bid1) ? seller2 : seller1;
        console2.log("Winner:", winningSeller);

        // ---------- Submit result ----------
        bytes32 resultHash = keccak256("RESULT_OK");

        if (winningSeller == seller1) {
            vm.startBroadcast(seller1Pk);
            escrow.submitResult(taskId, resultHash, "ipfs://seller1");
            vm.stopBroadcast();
        } else {
            vm.startBroadcast(seller2Pk);
            escrow.submitResult(taskId, resultHash, "ipfs://seller2");
            vm.stopBroadcast();
        }

        // ---------- Verifier approvals ----------
        vm.startBroadcast(verifier1Pk);
        escrow.approve(taskId);
        vm.stopBroadcast();

        vm.startBroadcast(verifier2Pk);
        escrow.approve(taskId);
        vm.stopBroadcast();

        // ---------- Finalize payouts ----------
        vm.startBroadcast(buyerPk);
        escrow.finalize(taskId);
        vm.stopBroadcast();

        console2.log("DONE");
    }
}