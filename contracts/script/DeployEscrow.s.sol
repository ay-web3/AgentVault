// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

contract DeployEscrow is Script {
    function run() external returns (TaskEscrow escrow) {
        address registry = vm.envAddress("REGISTRY");
        address treasury = vm.envAddress("TREASURY");
        uint256 feeBps = vm.envUint("PROTOCOL_FEE_BPS");

        vm.startBroadcast();
        escrow = new TaskEscrow(registry, treasury, feeBps);
        vm.stopBroadcast();
    }
}