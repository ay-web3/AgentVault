// script/DeployRegistry.s.sol
// Deploys AgentRegistry using your EOA as admin.

pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";

contract DeployRegistry is Script {
    function run() external returns (AgentRegistry registry) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // Config (all optional, with sensible defaults)
        uint256 minSellerStake   = vm.envOr("MIN_SELLER_STAKE", uint256(10 ether));
        uint256 minVerifierStake = vm.envOr("MIN_VERIFIER_STAKE", uint256(20 ether));
        uint64  withdrawCooldown = uint64(vm.envOr("WITHDRAW_COOLDOWN", uint256(3600)));

        address admin = vm.addr(pk);

        vm.startBroadcast(pk);

        registry = new AgentRegistry(
            admin,
            minSellerStake,
            minVerifierStake,
            withdrawCooldown
        );

        vm.stopBroadcast();

        console2.log("AgentRegistry:", address(registry));
        console2.log("Admin:", admin);
        console2.log("minSellerStake:", minSellerStake);
        console2.log("minVerifierStake:", minVerifierStake);
        console2.log("withdrawCooldown:", withdrawCooldown);
    }
}