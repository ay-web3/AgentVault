// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script} from "forge-std/Script.sol";
import {VaultPerp} from "../src/VaultPerp.sol";

contract DeployVaultPerp is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        address usdcAddress = 0x3600000000000000000000000000000000000000;
        address oracleAddress = vm.envAddress("ORACLE_ADDRESS");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        VaultPerp vault = new VaultPerp(usdcAddress, oracleAddress, agentAddress);

        vm.stopBroadcast();
    }
}
