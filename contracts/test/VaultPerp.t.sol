// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console2} from "forge-std/Test.sol";
import {VaultPerp} from "../src/VaultPerp.sol";
import {MockERC20} from "./MockERC20.sol";

contract VaultPerpTest is Test {
    VaultPerp public vault;
    MockERC20 public usdc;

    address public oracleUpdater = address(1);
    address public agentRole = address(2);
    address public trader = address(3);
    address public follower = address(4);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC");
        vault = new VaultPerp(address(usdc), oracleUpdater, agentRole);

        usdc.mint(trader, 10000 ether);
        usdc.mint(follower, 10000 ether);

        vm.prank(trader);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(follower);
        usdc.approve(address(vault), type(uint256).max);

        // Pre-mint vault liquidity for payouts
        usdc.mint(address(vault), 100000 ether);

        // Set initial price
        vm.prank(oracleUpdater);
        vault.setPrice("ETH", 3000 ether);
    }

    function testOpenPosition() public {
        vm.prank(trader);
        uint256 posId = vault.openPosition("ETH", true, 100 ether, 5); // 5x leverage, 500 size

        assertEq(posId, 1);
        (address owner, bytes32 asset, bool isLong, uint256 collateral, uint256 leverage, uint256 size, uint256 entryPrice, , bool isOpen) = vault.positions(posId);
        
        assertEq(owner, trader);
        assertEq(asset, bytes32("ETH"));
        assertTrue(isLong);
        assertEq(collateral, 100 ether);
        assertEq(leverage, 5);
        assertEq(size, 500 ether);
        assertEq(entryPrice, 3000 ether);
        assertTrue(isOpen);
    }

    function testClosePositionProfit() public {
        vm.prank(trader);
        uint256 posId = vault.openPosition("ETH", true, 100 ether, 5);

        // ETH goes up 10%
        vm.prank(oracleUpdater);
        vault.setPrice("ETH", 3300 ether);

        uint256 balanceBefore = usdc.balanceOf(trader);
        
        vm.prank(trader);
        vault.closePosition(posId);

        // PnL = size * priceDiff / entryPrice = 500 * 300 / 3000 = 50
        // Expected payout = 100 + 50 = 150
        uint256 balanceAfter = usdc.balanceOf(trader);
        assertEq(balanceAfter - balanceBefore, 150 ether);
    }

    function testLeaderBondAndSlash() public {
        vm.prank(trader);
        vault.registerLeader(1000 ether, 2000); // 20% fee

        (uint256 bondAmount, , , , bool isActive) = vault.leaders(trader);
        assertEq(bondAmount, 1000 ether);
        assertTrue(isActive);

        // Slash 10%
        vm.prank(agentRole);
        vault.slash(trader, 1000); // 1000 bps = 10%

        (uint256 newBondAmount, , , , ) = vault.leaders(trader);
        assertEq(newBondAmount, 900 ether);
    }
}
